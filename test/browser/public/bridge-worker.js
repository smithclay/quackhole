// The async far end of the blocking bridge.
//
// Step 2 deliberately does NOT involve iroh: it forwards over ordinary fetch, so
// a failure here is a failure of the sync/async bridge itself and nothing else.
// Step 3 replaces `perform` with an iroh round trip; the SAB protocol above it
// does not change.
const CTL_BYTES = 32;
const MORE = 1;
const META = 2;

let ctl = null;
let data = null;

/// Hands one chunk to the blocked thread and waits for it to be consumed.
function writeChunk(bytes, flags, state = 1) {
  // The shim sets state back to 0 once it has copied the chunk out, so this
  // waits for the buffer to be free before overwriting it.
  while (Atomics.load(ctl, 0) !== 0) {
    Atomics.wait(ctl, 0, Atomics.load(ctl, 0), 1000);
  }
  data.set(bytes, 0);
  Atomics.store(ctl, 1, bytes.length);
  Atomics.store(ctl, 3, flags);
  Atomics.store(ctl, 0, state);
  Atomics.notify(ctl, 0);
}

function fail(message) {
  writeChunk(new TextEncoder().encode(message), 0, 2);
}

// Headers the Fetch spec forbids setting from script. duckdb-wasm has already
// renamed Host to X-Host-Override, but Content-Length is still in the list and
// would make the whole request throw.
const FORBIDDEN = new Set(['content-length', 'connection', 'host', 'origin']);

async function perform(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (!FORBIDDEN.has(k.toLowerCase())) headers[k] = v;
  }

  const res = await fetch(req.url, {
    method: req.method,
    headers,
    body: req.body && req.body.length ? req.body : undefined,
  });

  const buf = new Uint8Array(await res.arrayBuffer());
  const out = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return { status: res.status, headers: out, body: buf };
}

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg && msg.__qh === 'init') {
    ctl = new Int32Array(msg.sab, 0, 8);
    data = new Uint8Array(msg.sab, CTL_BYTES);
    Atomics.store(ctl, 4, 1);
    Atomics.notify(ctl, 4);
    return;
  }

  try {
    const res = await perform(msg);
    writeChunk(
      new TextEncoder().encode(JSON.stringify({ status: res.status, headers: res.headers })),
      META,
    );

    // A response larger than the data region is split; the shim reassembles.
    const limit = data.length;
    if (res.body.length === 0) {
      writeChunk(res.body, 0);
      return;
    }
    for (let at = 0; at < res.body.length; at += limit) {
      const end = Math.min(at + limit, res.body.length);
      writeChunk(res.body.subarray(at, end), end < res.body.length ? MORE : 0);
    }
  } catch (err) {
    fail(String(err && err.message ? err.message : err));
  }
};
