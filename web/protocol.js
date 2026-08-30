// The protocol between the XHR shim and the bridge worker.
//
// One definition, loaded by both sides: the shim via importScripts (it is a
// classic script) and the bridge via a side-effect import (it is a module).
// Assigning to globalThis rather than exporting is what lets one file serve
// both. Defining these twice would let a one-sided edit corrupt shared memory
// silently instead of failing loudly.
globalThis.QH_PROTO = {
  // Control frames, on the same shim -> bridge channel every request travels.
  //
  // `peer` is why they are here rather than on a channel of the page's own.
  // Telling the bridge which relay reaches a peer, and then ATTACHing that
  // peer, used to be two different paths -- so the dial could overtake the
  // registration and be made on whatever relay the bridge had before, and an
  // acknowledgement had to be waited for to stop it. On one path the ordering
  // problem cannot occur: postMessage preserves order, so a frame sent before
  // a request arrives before it.
  // TAG, rather than CTL, to keep it apart from CTL_BYTES below -- that one
  // sizes the shared-memory control block and has nothing to do with these.
  TAG: '__qh',
  INIT: 'init',
  PEER: 'peer',

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
