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
| `peer.js` | Ticket, address and secret name, from the core. Loads `wasm/` on demand. |
| `wasm/` | Built from `crates/quackhole-web` — iroh, plus the framing and peer identity from the core. |

`peer.js` exists for the same reason `protocol.js` does, one level up. A ticket,
the `quack:<id>.iroh:9494` address and the name of the secret that authenticates
against it are all derived from one endpoint id, and none of those shapes is
obvious — which fields a ticket may omit, what a missing relay means, that
`ATTACH` and the secret's `SCOPE` have to be character-for-character the same
string. They were written out here as well as in the extension's C++, so this
now asks the core, which is also what mints them.

`crates/` is a Cargo workspace, so the browser and native builds resolve their
dependencies together. That is the point of it: independent lockfiles would let
`cargo update` in one directory leave the two clients on different iroh versions,
disagreeing about the wire — which is what sharing the transport code exists to
prevent.

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

### More than one remote

`?relay=` is one relay for the whole worker, which is all a caller with a single
remote needs. A relay actually belongs to a peer, so for several, register each
one instead — the shim picks these off the worker's message port and forwards
them to the bridge:

```js
worker.postMessage({ __qh: 'peer', endpointId, relay: relayUrl });
await conn.query(`ATTACH 'quack:${endpointId}.iroh:9494' AS laptop`);
```

No acknowledgement to wait for. The frame and the `ATTACH` travel the same two
ports in that order, and postMessage preserves it, so the dial cannot be made
before the bridge knows where to make it.

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

## Who drives this

Two callers, and they are the reason the paths here are relative rather than
rooted at `/`: [`site/`](../site) is served from a project Pages site under
`/quackhole/`, where a leading slash resolves to github.io itself.

| | |
|---|---|
| [`test/browser/`](../test/browser) | The harness. Proves each layer independently |
| [`site/`](../site) | The public demo, which copies these files in verbatim |

Neither reimplements anything here. That is the point: what the demo proves is
what someone vendoring these files into their own page gets.
