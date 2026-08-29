// The SharedArrayBuffer protocol between the XHR shim and the bridge worker.
//
// One definition, loaded by both sides: the shim via importScripts (it is a
// classic script) and the bridge via a side-effect import (it is a module).
// Assigning to globalThis rather than exporting is what lets one file serve
// both. Defining these twice would let a one-sided edit corrupt shared memory
// silently instead of failing loudly.
globalThis.QH_PROTO = {
  // Control block: Int32Array indices.
  STATE: 0,
  LEN: 1,
  FLAGS: 2,
  READY: 3,
  CTL_BYTES: 32,

  // STATE. Only the shim writes IDLE; only the bridge writes the others.
  IDLE: 0,
  CHUNK: 1,
  ERROR: 2,

  // READY. The shim blocks on this before its first request, so it has to
  // distinguish "still starting" from "started and failed" -- otherwise a
  // bridge that could not bind an endpoint looks identical to a slow one.
  NOT_READY: 0,
  READY_OK: 1,
  READY_FAILED: 2,

  // FLAGS, bitwise.
  MORE: 1,
  META: 2,

  // Matches DuckDB's own default HTTP timeout.
  DEFAULT_TIMEOUT_MS: 30000,
  // How much longer the shim waits than the budget it gave the bridge, so
  // the bridge's error -- which names the actual cause -- arrives first.
  GRACE_MS: 5000,
};
