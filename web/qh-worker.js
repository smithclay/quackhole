// Stands in for duckdb-wasm's own worker script. Installs the transport shim
// into the worker global *before* duckdb loads, then loads duckdb unmodified.
//
// This works because the duckdb-wasm worker bundle is a plain classic script
// (an IIFE, not an ES module), so importScripts can stack things ahead of it,
// and because its HTTP glue resolves `new XMLHttpRequest` off the global at
// call time rather than capturing it at load time.
const params = new URLSearchParams(self.location.search);
const target = params.get('target');
if (!target) throw new Error('qh-worker.js needs ?target=<duckdb worker url>');

importScripts('/protocol.js');
importScripts('/shim.js');
importScripts(target);
