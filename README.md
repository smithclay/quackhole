# Quackhole

Quackhole lets one DuckDB reach another DuckDB behind NAT — a laptop on cafe Wi-Fi — from
anywhere, using only [iroh](https://www.iroh.computer/) and n0's public relays. No port
forwarding, no VPN, no certificates, no relay infrastructure of your own, no sidecar.

It is a **transport bridge and nothing else**.
[Quack](https://duckdb.org/docs/stable/core_extensions/quack) remains the database protocol.
Quack is HTTP; Quackhole carries Quack's HTTP bytes over iroh QUIC streams. iroh supplies
identity, NAT traversal, relay fallback, and end-to-end encryption.

```
SQL
 │
DuckDB
 │
Quack — HTTP/1.1, POST /quack
 │
quackhole — HTTPUtil out, iroh acceptor in; one bi-stream per request
 │
iroh — QUIC, endpoint id = address, hole-punching, relay fallback, E2E encryption
 │
n0 public relays + address lookup — we run none of it
```

## The address is a public key

A DuckDB's address is the iroh endpoint id of the Quackhole serving it:

```
quack:<endpoint-id>.iroh:9494
```

`<endpoint-id>` is a 32-byte ed25519 public key in z-base-32 (52 characters, so it fits a DNS
label). Nothing ever resolves this name — Quackhole intercepts before a socket exists — but
keeping it well-formed means it survives every URL parser it passes through.

## Use it

On the laptop, behind NAT:

```sql
INSTALL quack; LOAD quack;
LOAD quackhole;

CALL quackhole_serve(token := 'your-shared-token');
FROM quackhole_status();
```

`quackhole_serve` starts Quack on loopback if nothing is listening there, binds an iroh
endpoint, and prints a paste-ready `attach_sql`.

Anywhere else:

```sql
INSTALL quack; LOAD quack;
LOAD quackhole;

CREATE SECRET (TYPE quack, TOKEN 'your-shared-token');
ATTACH 'quack:<endpoint-id>.iroh:9494' AS laptop;

FROM laptop.logs WHERE ts > now() - INTERVAL '1 hour';
```

No new syntax — that is an ordinary Quack `ATTACH`. Roles are per call, not per machine: a
DuckDB can serve and attach to others at the same time.

**Scope:** Quackhole carries *Quack* traffic. It does not make arbitrary httpfs reads work
over `.iroh` — `read_csv('https://<id>.iroh:9494/x.csv')` reaches httpfs, not Quackhole,
because httpfs builds its own `HTTPParams` bound to the httpfs util and never consults the
one installed on `DBConfig`. Reach remote files through `ATTACH` and SQL instead.

## SQL surface

| Function | What it does |
|---|---|
| `quackhole_serve([token], [target], [allow], [ephemeral], [auto_serve])` | Start Quack on `target` (default `127.0.0.1:9494`) if needed, bind an iroh endpoint, accept streams into it |
| `quackhole_stop()` | Stop the accept loop. Cached outbound connections stay usable |
| `quackhole_status()` | Endpoint id, relay URL, whether serving, and one row per known peer with its path (`direct` or `relay`) |

`allow := ['<endpoint-id>', ...]` rejects any peer not on the list at accept time, before a
single byte of Quack traffic. `ephemeral := true` uses a throwaway key instead of the
persisted one — for CI runners and short-lived VMs.

## Identity

The endpoint key lives at `~/.quackhole/key`, mode `0600`. **The key is the address**, so
persisting it is what lets an address survive a restart. Losing it means a new address, not a
disclosure of data at rest.

| Setting | Effect |
|---|---|
| `quackhole_key_path` | Where the endpoint key lives (default `~/.quackhole/key`) |
| `quackhole_ephemeral` | Use a throwaway key instead of the persisted one |

Both are read at the moment the endpoint binds, which can happen implicitly on the first
`ATTACH` to a `.iroh` host. Set them **globally**, since that path reads database-level
settings:

```sql
SET GLOBAL quackhole_ephemeral = true;
```

You need this to run a client and a server **on the same machine**: they would otherwise load
the same key, share one endpoint id, and iroh would refuse the dial with *"connecting to
ourself is not supported"*. Across machines it is unnecessary.

## What enforces what

| Property | Enforced by |
|---|---|
| The server is who the address says | iroh — the endpoint id *is* the TLS identity |
| The relay cannot read or forge traffic | iroh — QUIC/TLS 1.3, end-to-end |
| Only intended clients connect | quackhole — the optional `allow` list |
| Only authorized SQL runs | Quack — its token and auth callbacks |
| Only the Quack port is reachable | quackhole — a fixed `target`, Quack on loopback |

Relays see endpoint ids, timing and byte counts. They do not see SQL, results, tokens, or
which database is attached.

On networks that block UDP — cafe captive portals — iroh's relay connection runs over
HTTPS/443, so relay-only is the expected path there, not a failure.

## Build

Needs a Rust toolchain: the iroh transport is a static library linked into an ordinary C++
DuckDB extension.

```sh
git clone --recurse-submodules <this repo>
make release
```

Then `./build/release/duckdb`, or `LOAD` the loadable extension from
`build/release/extension/quackhole/quackhole.duckdb_extension`.

## Test

```sh
make test                                  # sqllogictests
scripts/demo_two_process.sh                # end-to-end, two processes, real relays
QUACKHOLE_LOADABLE=1 scripts/demo_two_process.sh   # same, via the loadable extension

cd crates/quackhole-core && cargo test     # transport unit tests
QUACKHOLE_NET_TESTS=1 cargo test           # ... including the live-network round trip

test/docker/run.sh                         # two DuckDBs on networks that cannot reach each other
```

Tests that need the network are gated on `QUACKHOLE_NET_TESTS=1` so the default suite stays
hermetic.

CI also runs two quality gates, which are worth reproducing before pushing because the
formatter is pinned to a version nothing installs by default:

```sh
pip install "black>=24" cmake-format "clang_format==11.0.1"   # exactly 11.0.1; newer disagrees
make format-check
TIDY_BINARY=$(brew --prefix llvm)/bin/clang-tidy make tidy-check
```

`format.py` rewrites a sqllogictest's `# group:` to match its directory, so a hand-written
group is a CI failure rather than a preference.

`test/docker/run.sh` is the one that tests the actual claim. Both peers run in containers on
separate Docker networks with no route between them, and the client refuses to proceed until
it has confirmed it cannot reach the server by ICMP or TCP. A second scenario drops outbound
UDP at both ends, so iroh has to tunnel QUIC over the relay's HTTPS connection -- the
captive-portal case -- and the run fails unless `peer_path` comes back `relay`. It also prints
per-query latency. See [test/docker/README.md](test/docker/README.md), which is explicit about
what this does *not* prove: Docker's NAT is friendly, so it says nothing about hole-punching
through CGNAT or a symmetric NAT.

## Layout

```
src/                        C++ extension
  quackhole_extension.cpp     entry point, table functions, load-order re-arm
  quackhole_http.cpp          QuackholeHTTPUtil / QuackholeHTTPClient
  quackhole_state.cpp         per-DatabaseInstance state; shuts the core down on close
crates/quackhole-core/      Rust static library (iroh + tokio)
  include/quackhole_core.h    hand-written C ABI
cmake/FindQuackholeCore.cmake
test/docker/                two peers on unroutable networks; the cross-network test
```

The Rust core moves opaque bytes and knows nothing about HTTP; the C++ side builds request
bytes and parses response bytes. One HTTP implementation, one small FFI surface.

### One constraint worth knowing

Quackhole never half-closes the request stream, and always sends `Connection: close`.

Half-closing after writing the request is the obvious design — it tells the peer the request
is complete. But Quack's server is cpp-httplib, and cpp-httplib answers a half-closed
connection with *nothing at all*, even when a complete `Content-Length`-framed request is
already buffered. Measured against a live `quack_serve`: an identical request returns 244
bytes without `shutdown(SHUT_WR)` and 0 bytes with it.

So the response is framed by the server closing the socket after it replies, which the
serving side turns into a stream FIN. `Content-Length` and chunked responses are still parsed
when present.

## Platforms

Native macOS, Linux and Windows. Not WebAssembly: iroh needs UDP sockets and a real async
reactor. A browser client is possible today with an XHR shim plus an iroh worker (iroh in the
browser is relay-only but still end-to-end encrypted); that is not part of this extension yet.

## License

MIT
