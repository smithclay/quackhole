# Packaging: one npm package, two front doors

A brief for a fresh session. Everything needed to start is here; read
[`CLAUDE.md`](../CLAUDE.md) first for the conventions and the hazards,
[`web/README.md`](../web/README.md) for what the browser client is, and
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the layer diagram.

**Do not start until the in-flight change to `web/protocol.js` and
`web/shim.js` has landed.** That work folds the page's `BroadcastChannel` into
the shim's own message port, which removes `channel` from the browser client's
public surface — the surface this brief packages. Check `git status` is clean
and that `web/README.md` documents `worker.postMessage({__qh: 'peer', ...})`
with no acknowledgement to wait for.

## How to work this

Five moves, in order. **Move 1 before everything** — it is the only one that
touches the transport, and every later move depends on `web/` being loadable
from an arbitrary origin. Move 4 rewrites `site/app.js`, so it goes last.

Each move has a **Done when** line. Meet it before starting the next one; they
are written to be runnable, not aspirational. If a move's gate cannot be met,
stop and say which fact turned out to be wrong rather than working around it —
the facts below cost a browser harness and live relay time to establish, and a
brief built on one that has rotted is worth less than the correction.

Two standing constraints for the whole job:

- **Do not change the wire.** No move here touches HTTP framing, the ticket
  format, or the shared-memory protocol. If a change seems to need that, it is
  the wrong change.
- **Snippets in the README are tested, not illustrative.** Every code block a
  reader is told to paste must be the block a test actually runs. The demo's
  whole claim is that what it proves is what a vendoring user gets.

---

## The thesis

**Quackhole has two front doors and both are hand-rolled.**

| | today | cost to the person on the other side |
|---|---|---|
| browser | five loose files to vendor, serve, and keep in sync | must copy `web/` into their own tree and never diverge |
| laptop | a 373-line POSIX shell script piped into `sh` | must trust a pipe, and have `curl`, `unzip`, and 35 MB of patience |

One npm package named `quackhole` replaces both. `npx quackhole` is the
quickstart; `cdn.jsdelivr.net/npm/quackhole` is the browser client. One name,
one version, one thing to publish.

The demo already proves the browser half works — `site/` copies `web/` in
verbatim, which is exactly what a vendoring user does by hand. The packaging
work is not new transport code. It is removing the three reasons those files
cannot be loaded from an origin they do not live on.

---

## Established facts

Measured, not recalled. The browser rows come from a two-origin Playwright run
in real Chromium (page on `:8801`, CDN on `:8802` with CORS); the npx rows from
`@duckdb/node-api` against `build/release/extension/quackhole/quackhole.duckdb_extension`
and a live n0 relay. Re-deriving them costs a browser harness and a network
round trip, so take them as given.

### What a browser permits

1. **`new Worker(<cross-origin URL>)` throws `SecurityError`** — for classic
   *and* `{type: 'module'}` workers. `qh-worker.js` can never be fetched
   straight from a CDN. Every path below routes through a same-origin blob.
2. **A blob worker's relative `importScripts` fails.** The trampoline
   `importScripts('https://cdn/qh-worker.js')` loads and runs, but that file's
   own `importScripts('./protocol.js')` throws
   `SyntaxError: The URL './protocol.js' is invalid` — a blob URL has an opaque
   path, so nothing resolves against it. This is `web/qh-worker.js:12-13` and
   `web/shim.js:55`.
3. **`self.location.search` is the empty string in a blob worker.** The
   `?target=` config channel that `web/qh-worker.js:8` and `web/shim.js:14`
   both read is simply gone.
4. **`importScripts()` throws in a module worker** —
   `TypeError: Module scripts don't support importScripts()`. Note that
   `typeof importScripts === 'function'` in a module worker, so a `typeof`
   guard proves nothing; the restriction is enforced at call time. **This is
   why `qh-worker.js` must stay a classic script**: its entire job is to stack
   duckdb-wasm's classic IIFE bundle behind the shim.
5. **A blob trampoline that `import`s an ES module works**, and
   `import.meta.url` inside it is the *CDN* URL. So relative imports resolve
   correctly, and so does `new URL('quackhole_bg.wasm', import.meta.url)` at
   `web/wasm/quackhole.js:1351` — the wasm-bindgen glue needs no help.
6. **A nested blob module worker, spawned from inside a blob worker, works.**
   `Blob` and `URL.createObjectURL` are available in workers, and the nested
   worker inherits the document's origin. The bridge survives the move.
7. **The injected-config shape works cross-origin.** Verified end to end: the
   trampoline assigns `self.QH_CONFIG` and then `importScripts` the absolute
   CDN entry; the entry reads its config off the global and reaches siblings
   through `new URL(name, base).href`. Config arrives intact, siblings load.
8. **A service worker cannot be registered from a CDN origin** —
   `SecurityError: The origin of the provided scriptURL does not match`. Nor
   from a blob. **Cross-origin isolation must come from the host page**, and
   there is no way to ship it in a script tag.
9. **COEP mode does not matter here.** `require-corp` and `credentialless`,
   with and without `Cross-Origin-Resource-Policy` on the CDN, produced
   identical results across every probe. Do not spend time on CORP headers.

Fact 8 is the load-bearing one and it is not fixable. `web/shim.js:3-9`
explains why: duckdb-wasm's HTTP glue issues a *synchronous* XHR, so the DuckDB
thread blocks in `Atomics.wait`, which needs a `SharedArrayBuffer`, which needs
COOP/COEP. There is no async escape hatch short of patching duckdb-wasm. **The
README must say this in the first screen rather than bury it**, because the
failure mode is the one `CLAUDE.md` already records: the worker is fetched, is
200, and dies with an error event carrying no message.

### What `@duckdb/node-api` permits

10. **`@duckdb/node-api@1.5.5-r.4` reports `version()` = `v1.5.5`** — exactly
    the `duckdb_version` pinned in `.github/workflows/release.yml`,
    `MainDistributionPipeline.yml` and `description.yml`. The ABI match that
    `scripts/quackhole-demo.sh` spends ~60 lines detecting and repairing is
    true by construction if the dependency is pinned.
11. **It loads the unsigned extension.**
    `DuckDBInstance.create(':memory:', { allow_unsigned_extensions: 'true' })`,
    then `INSTALL quack` / `LOAD quack` / `LOAD '<path>'` all succeed. All five
    `quackhole_*` settings and all four `quackhole_*` functions are present.
12. **`quackhole_serve` works through the bindings.** Returned in 3.06s over a
    live relay with `endpoint_id`, `relay_url`, `ticket` and `url` all
    populated. **No FIFO is needed** — the shell script's `mkfifo` exists only
    because the DuckDB CLI exits when stdin closes, and a Node process holding
    a connection does not.
13. **`quackhole` is unclaimed on npm** (404), as are `@quackhole/web` and
    `duckdb-quackhole`.

### Sizes, for deciding what ships

| | raw | gzipped |
|---|---|---|
| `web/wasm/quackhole_bg.wasm` | 3.4 MB | 1.4 MB |
| `web/wasm/quackhole.js` (glue) | 52 KB | 10 KB |
| the five loose `web/*.js` | 21 KB | 9.4 KB |
| duckdb-wasm `duckdb-eh.wasm` | 34 MB | — |

`npx quackhole` pays for the wasm it never runs, because npm ships one tarball.
That is ~1.5 MB against an extension download, and it buys a single name and a
single version. **Never bundle duckdb-wasm** — hook into whatever the host page
already loads.

---

## Move 1 — make `web/` loadable from an origin it does not live on

Facts 2, 3 and 4 are one defect with one fix: configuration and sibling
resolution both assume the worker's own URL, and in a blob worker there isn't
one. Replace both with a config object the loader injects.

- **`web/qh-worker.js`** reads
  `self.QH_CONFIG ?? Object.fromEntries(new URLSearchParams(self.location.search))`,
  publishes the result on `globalThis` for the shim, and reaches `protocol.js`
  and `shim.js` through `new URL(name, config.base).href`.
- **`web/shim.js:14`** reads that published config instead of parsing
  `self.location.search` itself. This collapses two readers of the same
  settings into one, which is the same trade `protocol.js` already makes for
  the shared-memory layout.
- **`web/shim.js:55`** resolves `bridge-worker.js` against `config.base`, and
  wraps it in a blob module trampoline when that base is cross-origin (fact 6).
- **`config.base` is derived from the loader's own URL** — `import.meta.url`
  for the ESM entry, `document.currentScript.src` for a classic tag. For a
  vendored same-origin copy that resolves relative, so **the relative-path rule
  in `CLAUDE.md` still holds**: `site/` is served under `/quackhole/` and a
  leading `/` would resolve to github.io itself.

Keeping the query-param path as the fallback is deliberate: `test/browser` and
`site/` keep working untouched, so the harness that proves the transport is not
being changed in the same move that changes the transport's plumbing.

**Done when** `node run.mjs` in `test/browser` passes all four modes
(`direct`, `bridge`, `iroh`, `timeout`) and `node verify.mjs` in `site` passes,
both with no edits to `test/browser` or `site/`.

---

## Move 2 — the package

One package, `quackhole`, published to npm and therefore served by jsDelivr.

```
bin/quackhole.js        the CLI (move 3)
dist/quackhole.js       ESM entry: createWorker, parseTicket
dist/web/               the five files + wasm/, verbatim
```

`dist/web/` is the same list as `VERBATIM` in `site/vite.config.js:100-112`,
minus the duckdb bundles and `start.sh`. **Copied, never bundled** — the
reasons in `CLAUDE.md` apply unchanged: `qh-worker.js` reaches its siblings at
runtime, and no content hash survives that.

The public API is one function, and its name is the point:

```js
import * as duckdb from '@duckdb/duckdb-wasm';
import * as quackhole from 'https://cdn.jsdelivr.net/npm/quackhole@0/dist/quackhole.js';

const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
const worker = await quackhole.createWorker(bundle.mainWorker);
const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
```

duckdb-wasm exports its own `createWorker` (confirmed in
`dist/duckdb-browser.cjs`), so the integration reads as a one-identifier swap
rather than as a new framework. Everything after it is unchanged — `ATTACH
'quack:<id>.iroh:9494'` and the `postMessage` peer registration both work as
`web/README.md` already documents them.

**Do not document the `/+esm` URL.** jsDelivr's `+esm` transform bundles a
package into a single module, which is precisely what `dist/web/` must not be:
`quackhole.js` derives its base from `import.meta.url` and then fetches
`web/qh-worker.js` as a real sibling over the network. Under `+esm` there is no
sibling to fetch and no meaningful `import.meta.url`, and the failure arrives
as a 404 inside a worker. Pin the file path, and make the README snippet the
one the test actually runs.

Two things the README owes the reader, in this order:

1. **The isolation requirement, before any snippet.** Two response headers, or
   `coi-serviceworker.js` copied to their own origin — it cannot come from the
   CDN (fact 8). `site/public/coi-serviceworker.js` is the file to point at,
   with the `document.currentScript.src` scoping trap from `CLAUDE.md` spelled
   out.
2. **A `check()` that names the problem.** When `crossOriginIsolated` is false,
   say so with the fix, rather than letting it surface as a worker that 200s
   and dies silently.

**Done when** a scratch page that has never seen this repo boots duckdb-wasm
through jsDelivr and attaches to a live `quackhole_serve`. Do that against a
local `npm pack` tarball before publishing anything.

---

## Move 3 — `npx quackhole`

Port the shell script's *behaviour*, not its mechanism. Facts 10–12 delete most
of the mechanism outright.

**Keeps:** platform detection for the extension asset name; the
`127.0.0.1:9494` occupancy check and the explanation attached to it
(`quackhole_serve` reuses a listening Quack, so the token would not match — a
failure that surfaces as an authentication error naming nothing); the sample
database; `quackhole_ephemeral`; `quackhole_workbench_url`; the banner and the
warning that the link carries a token; teardown on `SIGINT`.

**Drops:** the DuckDB CLI download, its ~35 MB confirm prompt, and the
`/dev/tty` dance that exists only because the script is piped into `sh`
(`scripts/quackhole-demo.sh:56-80`, and the confirm at `:165`); the FIFO;
polling `server.log` for `QH_URL`; the `QH_CAP` probe, which detected an
extension too old to know about `quackhole_workbench_url` — with a pinned
dependency and a version-matched
release that is a package-version problem instead, so keep a check but let it
say the new thing.

Two details worth getting right rather than porting:

- **Pin the extension download to this package's own version**, not
  `releases/latest/download/...` (`scripts/quackhole-demo.sh:214`). Once npm and
  GitHub releases are two publishing surfaces, `latest` is a race: `quackhole@0.0.2`
  on npm against a `v0.0.1` GitHub release downloads a binary the CLI was not
  written for. Resolve the tag from `package.json`.
- **Cache the downloaded extension** under a per-user cache dir keyed by
  version and platform. `npx` is a repeatable command in a way `curl | sh`
  never was, and re-downloading per invocation is the difference between a
  3-second start and a 20-second one.

Keep `QH_EXT` as the local-build override — the brief in
`scripts/quackhole-demo.sh:30-34` explains why it exists, and it is what lets
this be exercised before a release is published.

**Done when** `npx .` from a clean checkout prints a workbench link that
attaches from the deployed site, with no DuckDB on `PATH`.

---

## Move 4 — delete the shell path

Decided: `npx` is the only quickstart. Four places:

- `scripts/quackhole-demo.sh` — the script.
- `site/vite.config.js:125` — the `start.sh` entry in `VERBATIM`, and the
  comment above it about serving it from the same origin as the instructions.
- `site/app.js:63-85` — `renderLaptopCommand()` builds both `curl | sh` blocks
  and the download-and-run variant.
- `site/index.html` — `#cmd-serve`, `#cmd-serve-2`, `#cmd-os` and their copy
  buttons.

`#cmd-manual` stays: the by-hand SQL path is not the shell path, and it is what
someone with DuckDB already open uses. `detectPlatform()` (`site/app.js:56-61`)
is still worth keeping if the page says anything platform-specific about Node;
delete it if not.

This move rewrites `site/app.js`, so it goes last — same reasoning as move 4 in
[`RESHAPE.md`](RESHAPE.md).

---

## Move 5 — publishing

`npm publish` on the same tag that `release.yml` builds, and **after** it, not
alongside. The CLI downloads the extension binary from the release assets, so a
package published before its assets exist is a package that fails on first run
for as long as the matrix takes.

This adds a fourth place a version lives. Today it is `description.yml` and
`crates/Cargo.toml`, with `web/wasm/package.json` and the C++ version derived.
The npm version must track the extension version, because the CLI resolves its
download tag from it — **so derive it rather than maintaining it**, and update
[`UPDATING.md`](UPDATING.md) to say where it comes from.

---

## What must keep working

Nothing in this brief changes the wire, so every existing gate applies
unchanged:

```
prek run --all-files
make test
make rust-check
cd test/browser && node run.mjs direct && node run.mjs bridge \
                && node run.mjs iroh   && node run.mjs timeout
cd site && node verify.mjs && node verify.mjs --sw
```

`test/browser` is the one that matters most here, because it is the only thing
that exercises the transport without a live peer, and because it takes the
query-param path that move 1 must not break. Note the trap `CLAUDE.md` already
records: `test/browser` always passes `timeout`, and `site/` does not — which is
how a temporal-dead-zone bug in `shim.js` survived. Any new optional config
needs a caller that omits it.

---

## Non-goals

- **Bundling duckdb-wasm.** 34 MB for the eh bundle alone. Hook into the host's.
- **A no-isolation fallback.** Fact 8 plus `web/shim.js:3-9`. There isn't one.
- **Making the browser a server.** `quack_serve` throws
  `NotImplementedException` on wasm, and iroh compiles its IP transport out
  under `cfg(wasm_browser)`.
- **Rewriting `web/` as a bundled module.** The copy-verbatim rule in
  `CLAUDE.md` is what makes the demo evidence about what a vendoring user gets.
  Packaging should preserve that property, not trade it away.
