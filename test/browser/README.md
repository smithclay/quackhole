# Browser tests (Phase 2)

Phase 2 is the browser client. The key insight is that **quackhole is not a DuckDB
extension in the browser**: DuckDB-Wasm loads extensions as raw side modules with no
JS glue, so a wasm extension cannot reach JavaScript — but it does not need to.
Its HTTP transport is `new XMLHttpRequest` read off the *worker global at call time*,
so replacing `globalThis.XMLHttpRequest` inside the DuckDB worker replaces the
transport, and the native `quackhole_serve` works unmodified on the other end.

    npm install
    npm test

## Steps

Each step can only fail for one reason, which is the point of splitting them.

| Step | What it proves | Status |
|---|---|---|
| 1. plain HTTP | wasm quack's client path works at all | **PASS** |
| 2. blocking bridge | `Atomics.wait` can serve a synchronous XHR | pending |
| 3. iroh | the bridge's far end can be an iroh endpoint | pending |

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
