// The browser client, as one import.
//
// Everything under `web/` beside this file is the shipped client, copied in
// verbatim -- the same files `site/` copies, which is what makes the demo
// evidence about what a vendoring user gets rather than a lookalike. This file
// is the loader they would otherwise have to write, and it exists because
// three things stop those files being loaded from an origin the page is not on:
//
//   * `new Worker(<cross-origin URL>)` throws SecurityError, module or classic.
//     So the worker is a same-origin blob that importScripts the real entry.
//   * A blob URL has an opaque path, so `./protocol.js` inside that entry does
//     not resolve. So `base` is injected and the entry resolves against it.
//   * A blob worker's `self.location.search` is the empty string, so `?target=`
//     is gone. So the settings are injected too.
//
// `qh-worker.js` still reads its own URL when it has one, which is what keeps a
// vendored same-origin copy working with no loader at all.
//
// What is deliberately not here: booting DuckDB-Wasm. Which bundle, which
// logger and where the .wasm files come from are the page's business, and a
// loader that chose them would be harder to vendor, not easier.

export { parseTicket, transport } from './web/peer.js';
export { QuackholeSession } from './web/session.js';

// Where the client's files are. `import.meta.url` is this module's real URL --
// the CDN's, when that is where it came from -- so the same expression serves a
// vendored copy and a cross-origin one.
const WEB = new URL('web/', import.meta.url).href;

/// Whether this page can run the transport at all, and what to do if not.
///
/// DuckDB-Wasm's Quack client issues a *synchronous* XHR, so the DuckDB thread
/// blocks in `Atomics.wait`, which needs a `SharedArrayBuffer`, which needs
/// cross-origin isolation. There is no async escape hatch short of patching
/// duckdb-wasm, and no fallback to degrade to.
///
/// Worth asking before starting anything, because the failure it prevents is
/// the least legible one there is: the worker is fetched, is 200, and dies with
/// an error event carrying no message.
export function check() {
  if (typeof SharedArrayBuffer === 'undefined' || globalThis.crossOriginIsolated !== true) {
    return {
      ok: false,
      reason:
        'quackhole needs cross-origin isolation (crossOriginIsolated === false).\n' +
        'Serve this page with:\n' +
        '  Cross-Origin-Opener-Policy: same-origin\n' +
        '  Cross-Origin-Embedder-Policy: require-corp\n' +
        'On a host that will not set headers (GitHub Pages), copy coi-serviceworker.js\n' +
        'to your own origin -- it cannot be loaded from a CDN, because a service worker\n' +
        'can only be registered from the origin it is served by.',
    };
  }
  return { ok: true, reason: '' };
}

/// A DuckDB-Wasm worker with the quackhole transport already installed.
///
/// `target` is the bundle's own worker -- `bundle.mainWorker` -- which is
/// loaded unmodified, behind the shim. Pass the result to `AsyncDuckDB` in
/// place of what `duckdb.createWorker` would have given you; the name is the
/// same on purpose, because that is the whole of the integration.
///
/// Async only to match duckdb-wasm's own `createWorker`, which fetches. Nothing
/// here awaits.
///
/// Options are the settings `web/README.md` documents -- `mode`, `relay`,
/// `relays`, `timeout`, `chunk`, `intercept`, `debug`. `relay` is the fallback
/// for peers with none registered; with more than one remote, register each
/// instead (`QuackholeSession` does it for you). `relays` is a different axis:
/// which relays this page's own endpoint homes on, for a deployment that wants
/// none of its traffic on n0's.
export async function createWorker(target, options = {}) {
  const { ok, reason } = check();
  if (!ok) throw new Error(reason);

  const config = {
    mode: 'iroh',
    ...options,
    // Absolute, because the blob below has no base to resolve it against
    // either -- the same defect that `base` exists for, one level up.
    target: new URL(target, self.location.href).href,
    base: WEB,
  };

  // Classic, not a module: `importScripts` throws in a module worker
  // (`typeof importScripts === 'function'` there, so a guard would prove
  // nothing), and stacking duckdb-wasm's classic IIFE bundle behind the shim is
  // what qh-worker.js is for.
  const src =
    `self.QH_CONFIG = ${JSON.stringify(config)};\n` +
    `importScripts(${JSON.stringify(new URL('qh-worker.js', WEB).href)});\n`;

  // Not revoked, exactly as duckdb-wasm's own createWorker does not: nothing
  // promises the blob has been fetched by the time this returns, and one object
  // URL per session is not a leak worth racing.
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
}
