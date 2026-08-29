# quackhole browser client

Lets DuckDB-Wasm in a browser attach to a DuckDB behind NAT, through an
unmodified `quackhole_serve`.

**This is not a DuckDB extension, and it cannot be one.** DuckDB-Wasm loads
extensions as raw side modules with no accompanying JS glue, so a wasm build
could never reach JavaScript — which is where an iroh endpoint has to live. It
does not need to be one: duckdb-wasm's HTTP transport is `new XMLHttpRequest`
resolved off the worker global *at call time*, so replacing
`globalThis.XMLHttpRequest` inside the DuckDB worker replaces the transport.

    ./build-wasm.sh          # produces wasm/, needs Homebrew LLVM

## Files

| | |
|---|---|
| `qh-worker.js` | Worker bootstrap. `importScripts` the shim ahead of the stock duckdb worker. |
| `shim.js` | The `XMLHttpRequest` replacement, and the blocking half of the bridge. |
| `bridge-worker.js` | The async half: owns the iroh endpoint, answers over shared memory. |
| `protocol.js` | The shared-memory layout and budgets. Loaded by both halves. |
| `wasm/` | Built from `crates/quackhole-web` — iroh, plus the framing from the core. |

## Using it

Point the DuckDB worker at `qh-worker.js` instead of the bundle's own worker:

```js
const worker = new Worker(
  `/qh-worker.js?target=${encodeURIComponent(bundle.mainWorker)}` +
  `&mode=iroh&relay=${encodeURIComponent(relayUrl)}`,
);
```

then attach as usual — `ATTACH 'quack:<endpoint-id>.iroh:9494' AS remote`.

Query parameters: `target` (required, the real duckdb worker), `mode`
(`iroh`|`fetch`), `relay`, `timeout` (ms), `chunk` (shared buffer bytes),
`intercept` (extra host to capture, for testing), `debug`.

## Constraints

- **Requires cross-origin isolation** (COOP/COEP). The DuckDB thread blocks in
  `Atomics.wait`, which needs a `SharedArrayBuffer`.
- **A browser can only be a client.** `quack_serve` throws
  `NotImplementedException` on wasm.
- **A browser can only relay.** iroh compiles its IP transport out entirely
  under `cfg(wasm_browser)` because a browser cannot open a UDP socket, so there
  is no hole punching and no direct path. Traffic stays end-to-end encrypted —
  the relay forwards ciphertext it cannot read.
- **Pass the relay URL.** Without it iroh must resolve the peer through pkarr
  over HTTPS, a round trip to a third party that must also have seen the peer
  publish; a server that started seconds ago routinely has not.

## Why there is no HTTP code here

Request building and response parsing live in `quackhole-core`, shared with the
native extension, so the bytes on the wire are identical and the server cannot
tell the two clients apart. Two implementations would have to agree about things
that are not obvious — `Connection: close` framing, chunk extensions, which
caller headers get dropped — and would drift the moment one was edited alone.

Tests live in `test/browser/`.
