// Stands in for duckdb-wasm's own worker script. Installs the transport shim
// into the worker global *before* duckdb loads, then loads duckdb unmodified.
//
// This works because the duckdb-wasm worker bundle is a plain classic script
// (an IIFE, not an ES module), so importScripts can stack things ahead of it,
// and because its HTTP glue resolves `new XMLHttpRequest` off the global at
// call time rather than capturing it at load time. It is why this file must
// stay a classic script: importScripts throws in a module worker, and stacking
// duckdb's classic bundle behind the shim is the entire job.
//
// Two ways in, and what differs is where this file was fetched from. Served
// from the page's own origin it reads `?target=` off its URL and reaches its
// siblings relatively. From a CDN it cannot be a worker at all --
// `new Worker(<cross-origin URL>)` throws SecurityError -- so a loader on the
// page importScripts it from inside a same-origin blob, and a blob URL has
// neither a query string to read nor a path for `./protocol.js` to resolve
// against. Hence QH_CONFIG: the same settings injected rather than parsed,
// with `base` saying where the siblings actually are.
const config = self.QH_CONFIG ?? Object.fromEntries(new URLSearchParams(self.location.search));
config.base ??= self.location.href;
if (!config.target) {
  throw new Error('qh-worker.js needs a target: ?target=<duckdb worker url>, or QH_CONFIG.target');
}

// Published for shim.js, which wants the same settings. One reader rather than
// two: parsing the query string in both places is what would make the vendored
// path and the CDN path two things to keep agreeing.
globalThis.QH_CONFIG = config;

const sibling = (name) => new URL(name, config.base).href;

importScripts(sibling('protocol.js'));
importScripts(sibling('shim.js'));
importScripts(config.target);
