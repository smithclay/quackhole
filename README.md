# Quackhole

[![Build](https://github.com/smithclay/quackhole/actions/workflows/MainDistributionPipeline.yml/badge.svg)](https://github.com/smithclay/quackhole/actions/workflows/MainDistributionPipeline.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DuckDB](https://img.shields.io/badge/DuckDB-%E2%89%A5%201.5.5-FFF000?logo=duckdb&logoColor=black)](https://duckdb.org)

Query a DuckDB that lives somewhere you cannot reach — a laptop on cafe Wi-Fi, a machine
behind a corporate NAT, a home server with no public IP — from anywhere, over an encrypted
peer-to-peer connection.

No port forwarding, no VPN, no reverse tunnel, no certificates to manage, and no relay
infrastructure of your own. You need a shared token and a 52-character address.

**Try it without installing anything first:**
[smithclay.github.io/quackhole](https://smithclay.github.io/quackhole/) runs DuckDB-Wasm in
your browser and walks you through connecting it to a DuckDB on your own laptop. The one
command it asks for there is `npx quackhole`, which fetches the extension, seeds a sample
database and prints a link back. See [`site/`](site) and [`npm/`](npm).

Quackhole is a **transport bridge and nothing else**.
[Quack](https://duckdb.org/docs/stable/core_extensions/quack) stays the database protocol; we
carry its bytes over [iroh](https://www.iroh.computer/) QUIC streams, which supply identity,
NAT traversal, relay fallback, and end-to-end encryption.

## Quickstart

On the machine you want to reach, behind NAT:

```sql
INSTALL quack; LOAD quack;
LOAD quackhole;

SELECT ticket FROM quackhole_serve(token := 'your-shared-token');
```

`quackhole_serve` starts Quack on loopback if nothing is listening there, binds an iroh
endpoint, waits for it to learn a home relay, and prints a **ticket** — one word carrying the
endpoint id, the relay and the token. It also prints a `url`: the same ticket in a link that
opens the browser workbench already connecting.

From anywhere else — a different network, a different continent:

```sql
INSTALL quack; LOAD quack;
LOAD quackhole;

CALL quackhole_attach('qh1_…', name := 'laptop');

FROM laptop.logs WHERE ts > now() - INTERVAL '1 hour';
```

`quackhole_attach` creates the secret, scopes it to the peer, registers the relay the ticket
carries, and runs the `ATTACH` — one call, so there is nothing to keep in agreement by hand.
Everything after it is ordinary Quack. Roles are per call, not per machine: a DuckDB can serve
and attach to others at the same time, and `name :=` is what lets it hold several remotes at
once.

Registering the relay is not a nicety. Without it iroh has to resolve the peer through pkarr
— a round trip to a third party that must also have seen the peer publish, which a server
that started seconds ago routinely has not.

If you only have an endpoint id and no ticket, the long form still works. Name and scope the
secret to its peer: an unnamed one is really `__default_quack`, so a second `CREATE SECRET`
fails on the name whatever its scope says.

```sql
CREATE SECRET qh_<endpoint-id> (TYPE quack, TOKEN 'your-shared-token',
                                SCOPE 'quack:<endpoint-id>.iroh:9494');
ATTACH 'quack:<endpoint-id>.iroh:9494' AS laptop;
```

## The address is a public key

```
quack:<endpoint-id>.iroh:9494
```

`<endpoint-id>` is a 32-byte ed25519 public key in z-base-32 — 52 characters, so it fits a DNS
label. There is no DNS record and nothing ever resolves it; Quackhole intercepts before a
socket exists.

This is what removes the certificate problem. The address *is* the identity, so connecting to
the right address and authenticating the server are the same operation, and there is nothing
to issue, renew, or trust.

## What you can do

- Query a DuckDB behind NAT from anywhere, with no inbound port open on either side.
- Attach several remote DuckDBs at once and join across them, since roles are per call.
- Restrict who may connect with an `allow` list of endpoint ids, checked before any Quack
  traffic.
- Reach a laptop from a **browser** — DuckDB-Wasm can attach to an unmodified
  `quackhole_serve`. See [`web/`](web) for the client, [`npm/`](npm) for it packaged as
  `cdn.jsdelivr.net/npm/quackhole`, or [the demo](https://smithclay.github.io/quackhole/)
  to watch it happen.
- Keep working on networks that block UDP: iroh's relay connection runs over HTTPS/443, so a
  captive portal is a slower path, not a failure.

## API at a glance

| Function | What it does |
|---|---|
| `quackhole_serve([token], [target], [allow], [ephemeral], [auto_serve])` | Start Quack on `target` (default `127.0.0.1:9494`) if needed, bind an iroh endpoint, accept streams into it. Returns the ticket and a workbench link |
| `quackhole_attach(ticket, [name])` | Secret, scope, relay and `ATTACH`, for the peer a ticket names. `name` is the catalog it lands under (default `remote`) |
| `quackhole_stop()` | Stop the accept loop. Cached outbound connections stay usable |
| `quackhole_status()` | Endpoint id, relay URL, whether serving, and one row per known peer with its path (`direct` or `relay`) |

| Setting | Effect |
|---|---|
| `quackhole_key_path` | Where the endpoint key lives (default `~/.quackhole/key`) |
| `quackhole_ephemeral` | Use a throwaway key instead of the persisted one |
| `quackhole_relay_url` | Fallback relay for peers with none registered. A ticket's relay wins over it |

Settings are read when the endpoint binds, which can happen implicitly on the first `ATTACH`
to a `.iroh` host, so set them **globally**:

```sql
SET GLOBAL quackhole_ephemeral = true;
```

You need that to run a client and a server **on the same machine**: they would otherwise load
the same key, share an endpoint id, and iroh would refuse the dial with *"connecting to
ourself is not supported"*. Across machines it is unnecessary.

## Security

The endpoint key at `~/.quackhole/key` (mode `0600`) **is** the address. Persisting it is what
lets an address survive a restart; losing it means a new address, not a disclosure of data at
rest.

| Property | Enforced by |
|---|---|
| The server is who the address says | iroh — the endpoint id *is* the TLS identity |
| The relay cannot read or forge traffic | iroh — QUIC/TLS 1.3, end-to-end |
| Only intended clients connect | quackhole — the optional `allow` list |
| Only authorized SQL runs | Quack — its token and auth callbacks |
| Only the Quack port is reachable | quackhole — a fixed `target`, Quack on loopback |

Relays see endpoint ids, timing, and byte counts. They do not see SQL, results, tokens, or
which database is attached.

## Limits

Early-stage. Measured over a public relay across networks with no route between them: `ATTACH`
about a second, warm queries 0.14–0.21s, a 200k-row scan under 2.5s.

- **Hole punching is unverified.** Every measurement so far is relayed. The test harness
  firewalls the only direct-address candidates, and browsers have no direct path at all, so
  nothing here says how often iroh gets a direct connection through real CGNAT or a symmetric
  NAT. Expect relay latency until you have measured otherwise.
- **Quackhole carries Quack traffic only.** `read_csv('https://<id>.iroh:9494/x.csv')` reaches
  httpfs, not Quackhole; use `ATTACH` and SQL instead.
- **Browsers are client-only and relay-only**, and need cross-origin isolation (COOP/COEP).
- **An idle `ATTACH` holds a relay path open** at roughly one packet every five seconds, and
  cached connections are never evicted.
- **Native only**: macOS, Linux, Windows. Not a wasm extension —
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains why, and what the browser client
  does instead.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — where the seam is, and the constraints that shaped it
- [Contributing](CONTRIBUTING.md) — build, test, formatting
- [Browser client](web/README.md) — the shim, the bridge, and why it cannot be an extension
- [Demo site](site/README.md) — the guided page, and cross-origin isolation on GitHub Pages
- [Cross-network test](test/docker/README.md)
- [Deferred work](docs/DEFERRED.md)

## License

MIT. See [LICENSE](LICENSE).
