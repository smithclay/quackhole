# Cross-network verification

Two DuckDBs on Docker networks that cannot reach each other, both NAT'd to the
internet. The client attaches the server's database and queries it. The only
path between them is the thing under test.

```sh
test/docker/run.sh                 # both scenarios
test/docker/run.sh open            # normal egress
test/docker/run.sh relay-only      # UDP blocked at both ends
test/docker/run.sh idle            # attach, sit idle 15 min, then write
test/docker/run.sh --no-build open
```

The first run compiles DuckDB and the Rust core inside the image, which takes a
while. Everything after that hits the layer cache.

## What it proves

- **The two peers really are separated.** Each container installs an iptables
  DROP for the other's subnet, and then the client *verifies* the split before
  attaching: the server must answer neither ICMP nor TCP on a listener bound to
  `0.0.0.0`. If either succeeds the run aborts — otherwise a passing test could
  just mean iroh found a direct LAN route, which proves nothing.

  The firewall rule is not belt-and-braces. Docker's documented inter-network
  isolation **does not hold under OrbStack**, which routes between bridge
  networks by design; the first run of this test reached the "isolated" peer in
  0.065 ms. Enforcing the split ourselves makes the result the same on any
  runtime, and the preflight is what turns that from an assumption into a check.
- **Address lookup works between separated peers.** The client is given only a
  52-character endpoint id, through a shared volume standing in for the
  out-of-band channel a real user has. No address, no port, no DNS name.
- **Relay fallback works.** The `relay-only` scenario drops outbound UDP at both
  ends, so QUIC datagrams cannot leave the container and iroh has to tunnel them
  over the relay's websocket connection on 443 (`iroh-relay/src/client.rs:283` —
  the relay transport is TLS/TCP, so blocking UDP disables the direct path
  without disabling the relay). That is the captive-portal and hotel-wifi case.
  The scenario fails unless `peer_path` comes back `relay`.

  The UDP block has to allow loopback unconditionally, not just `--dport 53`.
  Docker's embedded resolver at `127.0.0.11` is reached through a DNAT that
  rewrites the port *before* the filter chain sees the packet, so a port-53 rule
  never matches it and every name lookup fails. That failure looks exactly like
  "the relay is unreachable" and is worth recognising quickly.
- **An idle session survives.** The `idle` scenario attaches, holds the session
  open and untouched for 15 minutes (`QH_IDLE_SECONDS`), then queries again.
  Quack has no client heartbeat and no server-side session reaper, so this was
  an open question; iroh's own 5-second QUIC keep-alive against a 15-second path
  idle timeout is what keeps it alive.

  The post-idle probe is a **write** (`CREATE TABLE remote.idle_probe`), not a
  read, and that distinction is the whole point: a repeated `count(*)` comes
  back from quack's local cache in ~70ms without touching the network, so a
  read-only probe would pass against a session that was completely dead.

- **Query latency over a real relay.** Attach, cold query, warm queries, a point
  lookup and a 200k-row scan are each timed and printed. `QH_BUDGET_MS`
  (default 1000) is compared against the warm query; set `QH_ENFORCE_BUDGET=1`
  to make exceeding it a failure rather than a note.

## What it does not prove

Docker's bridge NAT is friendly — full-cone, predictable ports, no rate
limiting. A direct path established here would say **nothing** about whether
hole punching would succeed through carrier-grade NAT, a symmetric NAT, or a
corporate firewall. Both containers also sit behind the same host NAT, so a
"direct" result may be the host hairpinning rather than a real internet path.

In practice neither scenario has produced a direct path: `open` reports
`peer_path=relay` too, because the containers' only candidate direct addresses
are the RFC-1918 ones we just firewalled off. So this exercises the relay path
in both scenarios; `relay-only` is what makes that a guarantee rather than an
observation.

So this verifies **relay-path correctness and gives real latency numbers**. It
is not a substitute for running the extension from actual cafe wi-fi to an
actual second network, which is still the only way to learn the hole-punch
success rate.

## Measured

One run of each scenario, 2026-08-29, macOS/arm64 host, home NAT, relay
`usw1-1.relay.n0.iroh.link`. Seconds, from the DuckDB CLI timer.

| | open | relay-only |
|---|---|---|
| `ATTACH` (3 POSTs) | 0.96 | 0.85 |
| `count(*)`, cold | 0.22 | 0.14 |
| `count(*)`, warm | 0.23 | 0.21 |
| point lookup | 0.24 | 0.39 |
| 200k-row scan (~9 fetch round trips) | 1.79 | 1.40 |
| `peer_path` | relay | relay |

The `idle` scenario, 900s: after idle, a `count(*)` returned in 0.20s and a
`CREATE TABLE` through the tunnel in 0.67s. No reconnect, no error.

Interactive queries land around 200-400 ms, inside the one-second budget, and
blocking UDP costs nothing measurable — both scenarios were relaying anyway.
Re-run rather than trusting these: they depend on the relay you get and the
network you are on.

## Layout

| File | Role |
|---|---|
| `Dockerfile` | Builds DuckDB + the extension for Linux, then a slim runtime image. One image, two roles |
| `docker-compose.yml` | `server` on the `cafe` network, `client` on `office`, a shared volume for the endpoint id |
| `server.sh` | Builds a sample database, runs `quackhole_serve`, publishes its endpoint id |
| `client.sh` | Preflight isolation checks, then attach, verify and time |
| `lib.sh` | Shared helpers, including the UDP block |
| `run.sh` | Host-side driver: build, run each scenario on a clean volume, summarise |

## Notes

- Both containers get `NET_ADMIN` so `relay-only` can install its iptables rule.
  `open` does not use it.
- The extension is compiled inside the image rather than copied from the host,
  because the host is macOS and the containers are Linux.
- `run.sh` tears down the `handoff` volume between scenarios. Without that a
  client could read the previous run's endpoint id and pass against a server
  that no longer exists.
