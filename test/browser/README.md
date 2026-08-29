# Browser tests (Phase 2)

Tests for the browser client, which lives in [`web/`](../../web) — this directory
is only the harness that drives it.

    npm install
    ../../web/build-wasm.sh     # only needed for iroh mode
    node run.mjs direct         # step 1
    node run.mjs bridge         # step 2
    node run.mjs iroh           # step 3
    node run.mjs timeout        # fault injection

## Steps

Each step can only fail for one reason, which is the point of splitting them.

| Step | What it proves | Status |
|---|---|---|
| 1. plain HTTP | wasm quack's client path works at all | **PASS** |
| 2. blocking bridge | `Atomics.wait` can serve a synchronous XHR | **PASS** |
| 3. iroh | the bridge's far end can be an iroh endpoint | **PASS** |
| timeout | a bridge that stops answering fails instead of wedging | **PASS** |

### Step 1 — `npm test`

Starts a native DuckDB serving quack on `127.0.0.1:9494`, serves the page, and drives
headless Chromium at it. No shim, no iroh. `quack:localhost:9494` hits
`QuackUri::IsLocal()` (`quack_uri.hpp:36` — literally `localhost`/`127.0.0.1`/`::1`),
so `enable_ssl` is false and the request goes out as ordinary plain HTTP.

Measured (loopback, so this is the transport-free baseline): attach 38ms, `count(*)`
6ms, point lookup 5ms. Compare against `test/docker`'s relay numbers to separate
transport cost from everything else.

Two things this depends on that are easy to miss:

- quack's server already sends CORS headers, deliberately for browsers —
  `Options("/quack")` with `Access-Control-Allow-Origin: *`
  (`quack_http_server.cpp:77-80`). Without that the cross-origin XHR would be blocked.
- `extensions.duckdb.org` also sends `Access-Control-Allow-Origin: *`, so
  `INSTALL quack` works from a page.

### Step 2 — `node run.mjs bridge`

Same SQL, same server, still plain HTTP — but every request now goes through
`shim.js` and the `Atomics.wait` bridge instead of the native XHR. No iroh, so a
failure here is a failure of the sync/async bridge and nothing else.

The shim is installed by `web/qh-worker.js`, which `importScripts` it ahead of the
stock duckdb worker bundle. That works because the bundle is a classic script and
its glue resolves `new XMLHttpRequest` off the global at call time. The shim then
spawns the bridge worker itself, so the page never needs to know it exists and
there is no handshake racing duckdb's own `onmessage`.

Two things the harness checks that are easy to get wrong:

- **That the shim was actually used.** The correctness assertions pass identically
  whether or not it ran, so bridge mode requires a non-zero intercept count and
  direct mode requires zero. Without that a mis-scoped predicate would fall
  through to the native transport and the test would prove nothing.
- **That reassembly runs.** The data region is shrunk to 64 KiB (`QH_CHUNK`) so
  the 200k-row scan spans many chunks. At the default 8 MiB nothing would ever
  chunk and that code would be dead.

### Step 3 — `node run.mjs iroh`

The real thing. The server is an unmodified `quackhole_serve` — the same one the
native cross-network test uses — and the browser reaches it over an iroh relay.

The wasm client is `crates/quackhole-web`, a thin wasm-bindgen wrapper. The
connection cache, the redial-once policy, and the HTTP framing itself all come
from `quackhole-core`, so the bytes on the wire are the ones the native
extension sends and the server cannot tell the two clients apart.

Measured over a live n0 relay:

| | direct (loopback) | iroh (relay) |
|---|---|---|
| ATTACH (3 POSTs) | 22ms | ~570ms |
| `count(*)` | 7ms | ~110ms |
| point lookup | 5ms | ~180ms |
| 200k-row scan (10 fetches) | 23ms | ~2.5s |

Comparable to the native relay numbers in `test/docker`, which is the expected
result: the transport is the same, only the client language differs.

**Browsers can only ever relay.** iroh compiles its entire IP transport out under
`cfg(wasm_browser)` (`socket/transports.rs:31`) because a browser cannot open a
UDP socket. Traffic stays end-to-end encrypted — the relay forwards ciphertext it
cannot read — but there is no hole punching and no direct path, ever. The harness
asserts `peer_path = relay` from the *server's* `quackhole_status()` rather than
inferring it from the cfg.

**The relay URL is passed explicitly**, alongside the endpoint id. Without it iroh
must resolve the peer through pkarr over HTTPS, which is a round trip to a third
party that also has to have seen the peer publish — a server that started seconds
ago routinely has not propagated yet, and the first attempt fails with "All
address lookup services failed". Since the relay URL travels with the endpoint id
in the connection string a user pastes, the browser already has it. This is what
iroh tickets do.

### `node run.mjs timeout` — fault injection

The bridge is told to drop every request. Nothing else about the run changes.

This exists because the request deadline is otherwise unexercised code: every
healthy path answers in milliseconds, so the guard could be broken for months
without a test noticing. The failure it guards against is the worst one this
design has — the DuckDB thread is blocked in `Atomics.wait`, so a request that
never resolves does not fail, it freezes the page with nothing logged.

It also documents something worth knowing: **our error message never reaches
DuckDB.** The run reports

    shim     [qh-shim] failed quackhole bridge did not respond within 7000ms
    duckdb   IO Error: Failed to send message: Please consult the browser console…

because quack renders `HTTPResponse::GetError` (`quack_client.cpp:63`), which is
duckdb-wasm's generic text, not our response body. So the assertion is made
against the shim's own console output — that is what distinguishes "our deadline
fired" from "something else failed within the budget". It is also why the shim
logs failures with `console.error` even when tracing is off.

## Notes

- The page is bundled with esbuild because duckdb-wasm's ESM entry point imports
  `apache-arrow` by bare specifier, which no browser can resolve. The worker scripts
  and `.wasm` files are served verbatim from `node_modules`.
- The static server binds to port 0 (OS-assigned). A fixed 8080 collides with
  whatever else happens to be running.
- Cross-origin isolation is opt-in (`QH_COI=1`). Step 1 does not need it; enabling it
  unconditionally would risk failing the test for an unrelated reason. Step 2 needs it
  for `SharedArrayBuffer`.
- `quack_serve` throws `NotImplementedException` on wasm
  (`quack_start_stop.cpp:19`), so a browser can only ever be a client. That matches
  the topology we want anyway.
- `build-wasm.sh` needs Homebrew LLVM: Apple clang cannot target
  `wasm32-unknown-unknown` and `ring` needs a C compiler that can.
- The bridge worker is a module worker (the wasm glue is an ES module); the DuckDB
  worker above it stays classic, because it needs `importScripts`. `protocol.js`
  assigns to `globalThis` so one file can be loaded either way — including by
  `run.mjs`, which reads the same budget constants rather than restating them.
- Every request is bounded (`QH_TIMEOUT_MS`, default 30s, matching DuckDB's own
  default). This is not a nicety: the DuckDB thread blocks in `Atomics.wait`, so an
  unbounded request would wedge the worker permanently instead of failing. The
  bridge gets the shorter budget so its error, which names the actual cause,
  arrives before the shim's blunter one.
- `intercept=<host>` is a test hook: it is what lets step 2 exercise the bridge
  against plain HTTP. Real use matches on the trailing `.iroh` label alone.
