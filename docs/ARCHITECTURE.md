# Architecture

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
n0 public relays + address lookup — we run none of it (quackhole_relays swaps in your own)
```

## Where the seam is

`QuackholeHTTPUtil` wraps whatever `HTTPUtil` is registered on the `DBConfig` and intercepts
in `InitializeClient` on a trailing `.iroh` label; everything else delegates to httpfs. It
re-arms through `ExtensionCallback::OnExtensionLoaded`, because httpfs unconditionally calls
`SetHTTPUtil` when it loads, and without that a later `LOAD httpfs` would silently take the
slot back.

Interception happens before a socket exists, which is why nothing ever resolves
`<endpoint-id>.iroh`.

## HTTP framing lives in the core

Framing is in `crates/quackhole-core/src/http.rs`, not in either client. It has to be: the
native extension drives it from C++ and the browser from JavaScript, and neither can share the
other's code. Two implementations would have to agree about things that are not obvious — the
`Connection: close` rule below, chunk extensions, which caller headers get dropped — and would
drift the moment one was edited alone.

C++ marshals to and from DuckDB's types; it does not parse. The C ABI is correspondingly a
little wider than opaque bytes would be, which is the price of one parser instead of three.

Connection reuse lives in the core for a related reason: DuckDB constructs a fresh
`HTTPClient` for every request and closes it afterwards, so there is no C++ object with a long
enough life to hold a QUIC connection.

## Responses are compressed, requests are not

Quack answers in `application/vnd.duckdb`, which is not compressed. Measured against a live
`quack_serve` by splicing a proxy between the bridge and Quack: 51 MB of real responses gzip to
18 MB at level 1, per response, which is what ships — 2.79x off every byte that crosses a relay
somebody else runs.

The compression is quackhole's own, not HTTP's. `Content-Encoding` belongs to the origin
server, and the origin server here is cpp-httplib, which does not compress; asking for it with
`Accept-Encoding` would be asking a question nothing answers, and would be actively unsafe the
day something did, because `parse_response` decodes no content coding and would hand Quack a
gzip stream as a result set.

So the client advertises `X-Quackhole-Accept-Encoding: gzip` — added by the core, so neither
client has to remember it — and the bridge reads the request head far enough to see it. If it
is there, the whole response *stream* is gzipped and prefixed with a magic beginning `\0`,
which no HTTP response can start with. That is the entire negotiation, and it degrades in both
directions: an old server forwards the header to Quack, which ignores what it does not know,
and answers plainly; an old client never sends it, so a new server never compresses at it. A
client that asked and got a plain answer cannot tell and does not need to.

Only the response is compressed. That is where the bytes are — a request is a query, a response
is the rows — and one-directional means one side advertises and the other decides, with no
state and no extra round trip. Compressing the whole stream rather than the body keeps the
bridge from parsing responses at all: it stays a byte pipe, with one question asked of the
request head on the way past.

Level 1 rather than 6. On the same capture level 6 gets 2.96x against level 1's 2.79x, and the
serving side is somebody's laptop answering queries with the same cores.

`MAX_RESPONSE_BYTES` bounds a response in both forms, which is why it sits in `lib.rs` rather
than beside either reader. Deflate expands by up to 1032:1, so capping only what arrives would
let a peer answer with 512 MiB of compressed zeros and ask the client for half a terabyte of
`Vec` — and one of the two clients is a browser tab.

## Never half-close the request stream

Quackhole always sends `Connection: close` and never half-closes.

Half-closing after writing the request is the obvious design — it tells the peer the request
is complete. But Quack's server is cpp-httplib, and cpp-httplib answers a half-closed
connection with *nothing at all*, even when a complete `Content-Length`-framed request is
already buffered. Measured against a live `quack_serve`: an identical request returns 244
bytes without `shutdown(SHUT_WR)` and 0 bytes with it.

So the response is framed by the server closing the socket after it replies, which the serving
side turns into a stream FIN. `Content-Length` and chunked responses are still parsed when
present.

## At-most-once, not at-least-once

A cached QUIC connection can be dead — the peer restarted, or an idle timeout fired — so a
failure on a reused connection is redialled once. Only when the request cannot have reached
the peer. Quack carries INSERTs and DDL, so replaying a request that may already have been
applied would apply it twice. See `may_retry` in `dial.rs`.

## Browsers are not an extension

DuckDB-Wasm loads extensions as raw side modules with no accompanying JS glue, so a wasm build
of this extension could never reach JavaScript — which is where an iroh endpoint has to live
in a browser. It does not need to be one: duckdb-wasm's HTTP transport is
`new XMLHttpRequest` resolved off the worker global *at call time*, so replacing
`globalThis.XMLHttpRequest` inside the DuckDB worker replaces the transport, and the server
stays an unmodified `quackhole_serve`.

The hard part is not iroh. duckdb-wasm's glue calls `open(method, url, false)` — synchronous —
and nothing async can be awaited there, so the request goes to a second worker over
`postMessage` and the DuckDB thread blocks on `Atomics.wait` until the response lands in a
`SharedArrayBuffer`. That is why the browser client needs cross-origin isolation.

Two consequences. A browser can only ever be a *client*: `quack_serve` itself throws
`NotImplementedException` on wasm. And a browser can only ever *relay*: iroh compiles its IP
transport out entirely under `cfg(wasm_browser)` because a browser cannot open a UDP socket,
so there is no hole punching and no direct path. Traffic stays end-to-end encrypted; the relay
forwards ciphertext it cannot read.

Cross-origin isolation is the one requirement that cannot be shipped in a script tag: a
service worker can only be registered from the origin that served it, so a page reaching for
the client on a CDN still has to earn isolation on its own. Everything else about being
loaded from another origin is handled — `new Worker` refuses a cross-origin URL, so
`npm/src/quackhole.js` starts it from a same-origin blob and injects the settings and the
base that a blob URL cannot supply.

See [`web/README.md`](../web/README.md) for the client and [`npm/`](../npm) for it packaged.

## Two TLS layers, one of them certificate-free

The peer-to-peer connection is TLS 1.3 with **raw public keys** (RFC 7250) — each side
presents its ed25519 key directly, and that key *is* the endpoint id. No CA, nothing to issue
or expire. That is the layer carrying your data.

The client-to-relay leg is an ordinary WebSocket over TLS, validated against a compiled-in
copy of Mozilla's roots. The relay terminates its own TLS and then forwards bytes still
wrapped in the peer-to-peer session it holds no key for.

## Scope

Quackhole carries *Quack* traffic. It does not make arbitrary httpfs reads work over `.iroh`:
`read_csv('https://<id>.iroh:9494/x.csv')` reaches httpfs, not Quackhole, because httpfs builds
its own `HTTPParams` bound to the httpfs util and never consults the one installed on
`DBConfig`. Reach remote files through `ATTACH` and SQL instead.

Deferred work, and why, is in [DEFERRED.md](DEFERRED.md).
