# quackhole

Query a DuckDB that has no address — a laptop on cafe Wi-Fi, a machine behind a
corporate NAT, a home server with no public IP — from a browser or from another
DuckDB. No port forward, no VPN, no certificates.

Two front doors, one package:

    npx quackhole          on the machine you want to reach; prints a link

```js
import * as quackhole from 'https://cdn.jsdelivr.net/npm/quackhole@0/dist/quackhole.js';
```

The address is a 32-byte ed25519 public key, so connecting to the right machine
and authenticating it are the same operation. [Quack][quack] stays the database
protocol; quackhole carries its HTTP over [iroh][iroh] QUIC streams.

[quack]: https://duckdb.org/docs/stable/core_extensions/quack
[iroh]: https://www.iroh.computer/

---

## Read this before the browser half

**The page must be cross-origin isolated, and that can only come from the page's
own origin.** DuckDB-Wasm's Quack client issues a *synchronous* XHR, so the
DuckDB thread blocks in `Atomics.wait`, which needs a `SharedArrayBuffer`, which
needs COOP/COEP. There is no async fallback short of patching duckdb-wasm.

Serve your page with:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

On a host that will not set headers — GitHub Pages, most static CDNs — copy
[`coi-serviceworker.js`][coi] **to your own origin** and load it before anything
else. It cannot come from a CDN: a service worker can only be registered from
the origin that served it, and it registers itself by
`document.currentScript.src`, so a copy under `assets/` scopes the worker to
`assets/` and silently stops it controlling the page. Put it at your root.

[coi]: https://github.com/gzuidhof/coi-serviceworker

Get this wrong and the failure is the least legible one there is: the worker is
fetched, is 200, and dies with an error event carrying no message. So ask first:

```js
const { ok, reason } = quackhole.check();
if (!ok) console.error(reason);   // names the problem and the fix
```

`createWorker` throws the same message rather than starting a worker that cannot
work.

## The browser client

`createWorker` is the whole integration. duckdb-wasm exports a `createWorker` of
its own, so this reads as a one-identifier swap; everything after it is
unmodified duckdb-wasm.

<!-- tested: npm/test/scratch.mjs runs this block verbatim. Keep it runnable. -->

```js
import * as duckdb from '@duckdb/duckdb-wasm';
import * as quackhole from 'https://cdn.jsdelivr.net/npm/quackhole@0/dist/quackhole.js';

// The ticket `npx quackhole` printed, carried in the link's fragment -- which
// never leaves the browser.
const ticket = decodeURIComponent(location.hash.slice(1));

const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
const worker = await quackhole.createWorker(bundle.mainWorker);
const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

const conn = await db.connect();
await conn.query('INSTALL quack');
await conn.query('LOAD quack');

// One ticket in, one catalog out: the named secret, its scope, the peer's relay
// and the ATTACH. Holding several remotes at once is what the session is for.
const session = new quackhole.QuackholeSession({ conn, worker });
const laptop = await session.attach(ticket);

// A Quack catalog enumerates nothing -- duckdb_tables() and information_schema
// are both empty for it -- so this is the one listing it pushes to the remote.
const tables = await session.tables();
console.log(`${laptop.name} in ${Math.round(laptop.attachMs)}ms:`, tables.get(laptop.name));
```

Then it is ordinary SQL: `SELECT * FROM laptop.events`, joins against local
tables, whatever DuckDB does.

**Pin the file path, and do not use jsDelivr's `/+esm`.** That transform bundles
a package into a single module, and this one must not be: `quackhole.js` derives
its base from `import.meta.url` and then fetches `web/qh-worker.js` as a real
sibling over the network. Under `+esm` there is no sibling to fetch, and the
failure arrives as a 404 inside a worker.

### What it exports

| | |
|---|---|
| `createWorker(mainWorker, options?)` | A DuckDB-Wasm worker with the transport installed. Pass it to `AsyncDuckDB` |
| `QuackholeSession({ conn, worker })` | Attach, detach, list connections, keep the list honest against DuckDB |
| `parseTicket(ticket)` | Endpoint id, relay, token, address and secret name, read by the same Rust that mints them |
| `check()` | `{ ok, reason }` — whether this page can run the transport |

`options` are the settings [`web/README.md`][web] documents: `mode`, `relay`,
`timeout`, `chunk`, `intercept`, `debug`. You need none of them for one remote.

[web]: https://github.com/smithclay/quackhole/blob/main/web/README.md

### Vendoring it instead

The client is six files and a `wasm/` directory under `dist/web/`, copied here
verbatim and never bundled. Serve them from your own origin and point a worker
at `dist/web/qh-worker.js?target=<duckdb worker url>&mode=iroh` — no loader
needed, because it reads its settings off its own URL when it has one.

## `npx quackhole`

On the machine you want to reach:

    npx quackhole

It downloads the extension for your platform (cached after the first run),
builds a small sample database in a temp directory, starts serving over iroh,
and prints a link that opens the browser workbench already connecting. Nothing
is installed, no key is persisted, and nothing is left running after Ctrl-C.

| | |
|---|---|
| `--token <t>` | Use a token of your own rather than a fresh random one |
| `--port <n>` | Quack's local port, if `9494` is taken |
| `--page <url>` | Aim the printed link at another workbench |
| `QH_EXT=<path>` | Use a locally built extension, for developing on the repo |

The link carries the token. Treat it like one: anyone holding it can query that
database until you stop.

## What this cannot do

- **A browser can only be a client.** `quack_serve` throws
  `NotImplementedException` on wasm.
- **A browser can only relay.** iroh compiles its IP transport out under
  `cfg(wasm_browser)`, because a browser cannot open a UDP socket. There is no
  hole punching and no direct path from a tab, ever. Traffic stays end-to-end
  encrypted — the relay forwards ciphertext it cannot read.
- **No isolation, no transport.** See the first section. There is no fallback.

## Source

[github.com/smithclay/quackhole](https://github.com/smithclay/quackhole) — the
DuckDB extension, the shared Rust core both clients link, and the test harness.

MIT.
