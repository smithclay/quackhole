// The async far end of the blocking bridge.
//
// Two modes, so the two hard things can fail independently:
//   fetch -- forwards over ordinary HTTP. Exercises the bridge with no iroh.
//   iroh  -- forwards over an iroh relay connection, which is the real thing.
//
// A module worker rather than a classic one, because the wasm glue is an ES
// module. The DuckDB worker above it stays classic, since it needs importScripts.
// Side-effect import: protocol.js assigns to globalThis, so one file serves
// both this module and the shim's classic script.
import '/protocol.js';

const P = globalThis.QH_PROTO;

let ctl = null;
let data = null;
let mode = 'fetch';
let client = null;
let relay = null;
let fault = null;

/// Hands one chunk to the blocked thread and waits for it to be consumed.
///
/// Blocking here is safe and blocking in the shim is not: this worker exists so
/// the DuckDB thread has something to wait on.
function writeChunk(bytes, flags, state = P.CHUNK) {
  // Only the shim writes IDLE, so this waits for it to finish copying the
  // previous chunk out before the buffer is reused.
  let seen;
  while ((seen = Atomics.load(ctl, P.STATE)) !== P.IDLE) {
    Atomics.wait(ctl, P.STATE, seen, 1000);
  }
  data.set(bytes, 0);
  Atomics.store(ctl, P.LEN, bytes.length);
  Atomics.store(ctl, P.FLAGS, flags);
  // Written last: the shim reads LEN and FLAGS only after seeing STATE change,
  // and Atomics are sequentially consistent, so this publishes the whole chunk.
  Atomics.store(ctl, P.STATE, state);
  Atomics.notify(ctl, P.STATE);
}

function fail(message) {
  writeChunk(new TextEncoder().encode(message), 0, P.ERROR);
}

// --- HTTP over an iroh stream ----------------------------------------------

async function performIroh(req) {
  const u = new URL(req.url);
  if (!u.hostname.endsWith('.iroh')) throw new Error(`not an iroh host: ${u.hostname}`);
  const peer = u.hostname.slice(0, -'.iroh'.length);

  // duckdb-wasm renames Host to X-Host-Override, because a browser may not set
  // Host on an XHR. Drop it rather than translating it back: the core builds the
  // Host header from the arguments below, and every other framing header is
  // likewise its business, not ours.
  const headers = {};
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (name.toLowerCase() !== 'x-host-override') headers[name] = value;
  }

  // Request building and response parsing live in quackhole-core, so these are
  // byte-for-byte the frames the native extension sends. That is what lets an
  // unmodified quackhole_serve answer a browser -- and it is why there is no
  // HTTP code in this file to drift away from the C++ side.
  return client.request(
    peer,
    relay,
    req.method,
    u.pathname + u.search,
    u.hostname,
    u.port || '9494',
    headers,
    req.body ?? undefined,
    '',
    req.timeoutMs,
  );
}

// --- plain HTTP, for testing the bridge without iroh ------------------------

// Headers the Fetch spec forbids setting from script.
const FORBIDDEN = new Set(['content-length', 'connection', 'host', 'origin']);

async function performFetch(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (!FORBIDDEN.has(k.toLowerCase())) headers[k] = v;
  }
  const res = await fetch(req.url, {
    method: req.method,
    headers,
    body: req.body && req.body.length ? req.body : undefined,
    signal: AbortSignal.timeout(req.timeoutMs),
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
    data = new Uint8Array(msg.sab, P.CTL_BYTES);
    mode = msg.mode || 'fetch';
    relay = msg.relay || null;
    fault = msg.fault || null;
    try {
      if (mode === 'iroh') {
        const wasm = await import('/wasm/quackhole.js');
        await wasm.default();
        client = await wasm.connect();
        console.log(`[qh-bridge] iroh endpoint ${client.endpointId()}`);
      }
      // Only now is the bridge usable. The shim blocks on this flag, so setting
      // it before the endpoint exists would let the first request race the bind.
      Atomics.store(ctl, P.READY, P.READY_OK);
      Atomics.notify(ctl, P.READY);
    } catch (err) {
      console.error(`[qh-bridge] init failed: ${err}`);
      Atomics.store(ctl, P.READY, P.READY_FAILED);
      Atomics.notify(ctl, P.READY);
    }
    return;
  }

  // A bridge that has died notifies nothing, which is precisely the case the
  // shim's deadline exists for. Simulating it is the only way to know the
  // deadline works, since every healthy path answers long before it.
  if (fault === 'blackhole') return;

  try {
    const res = mode === 'iroh' ? await performIroh(msg) : await performFetch(msg);
    writeChunk(
      new TextEncoder().encode(JSON.stringify({ status: res.status, headers: res.headers })),
      P.META,
    );

    const limit = data.length;
    if (res.body.length === 0) {
      writeChunk(res.body, 0);
      return;
    }
    for (let at = 0; at < res.body.length; at += limit) {
      const end = Math.min(at + limit, res.body.length);
      writeChunk(res.body.subarray(at, end), end < res.body.length ? P.MORE : 0);
    }
  } catch (err) {
    fail(String(err && err.message ? err.message : err));
  }
};
