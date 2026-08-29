// The async far end of the blocking bridge.
//
// Two modes, so the two hard things can fail independently:
//   fetch -- forwards over ordinary HTTP. Exercises the bridge with no iroh.
//   iroh  -- forwards over an iroh relay connection, which is the real thing.
//
// A module worker rather than a classic one, because the wasm glue is an ES
// module. The DuckDB worker above it stays classic, since it needs importScripts.
const CTL_BYTES = 32;
const MORE = 1;
const META = 2;

let ctl = null;
let data = null;
let mode = 'fetch';
let client = null;
let relay = null;

/// Hands one chunk to the blocked thread and waits for it to be consumed.
function writeChunk(bytes, flags, state = 1) {
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

// --- HTTP over an iroh stream ----------------------------------------------
// The native extension builds and parses these bytes in C++; in the browser it
// has to happen here. The wire format is identical either way, which is what
// lets an unmodified quackhole_serve answer both.

function buildRequest(method, url, headers, body) {
  const u = new URL(url);
  const lines = [`${method} ${u.pathname}${u.search} HTTP/1.1`];

  // duckdb-wasm's glue renames Host to X-Host-Override because a browser is not
  // allowed to set Host on an XHR. Put it back: the server sees a normal request.
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k.toLowerCase() === 'x-host-override' ? 'Host' : k] = v;
  }
  if (!out.Host) out.Host = u.host;
  out['Content-Length'] = String(body ? body.length : 0);

  // Not optional. quack's server is cpp-httplib, which will not answer a
  // half-closed stream, so the serving side never sees the request end. What
  // actually ends the exchange is the server closing the socket after replying,
  // which it only does when asked. Without this the read hangs until timeout.
  out.Connection = 'close';

  for (const [k, v] of Object.entries(out)) lines.push(`${k}: ${v}`);
  const head = new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n');
  if (!body || body.length === 0) return head;

  const req = new Uint8Array(head.length + body.length);
  req.set(head, 0);
  req.set(body, head.length);
  return req;
}

function indexOfHeaderEnd(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function parseResponse(bytes) {
  const split = indexOfHeaderEnd(bytes);
  if (split < 0) throw new Error('malformed response: no header terminator');

  const text = new TextDecoder().decode(bytes.subarray(0, split));
  const [statusLine, ...headerLines] = text.split('\r\n');
  const status = Number(statusLine.split(' ')[1]);
  if (!Number.isFinite(status)) throw new Error(`malformed status line: ${statusLine}`);

  const headers = {};
  for (const line of headerLines) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }

  const rest = bytes.subarray(split + 4);
  if (headers['transfer-encoding'] === 'chunked') return { status, headers, body: dechunk(rest) };

  // Content-Length when framed, otherwise everything up to stream end -- which
  // is well defined here because we always send Connection: close.
  const len = headers['content-length'];
  const body = len === undefined ? rest : rest.subarray(0, Number(len));
  return { status, headers, body };
}

function dechunk(bytes) {
  const parts = [];
  let at = 0;
  for (;;) {
    let eol = at;
    while (eol + 1 < bytes.length && !(bytes[eol] === 13 && bytes[eol + 1] === 10)) eol++;
    const size = parseInt(new TextDecoder().decode(bytes.subarray(at, eol)).trim(), 16);
    if (!Number.isFinite(size)) throw new Error('malformed chunk size');
    if (size === 0) break;
    const start = eol + 2;
    parts.push(bytes.subarray(start, start + size));
    at = start + size + 2;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }
  return body;
}

async function performIroh(req) {
  const host = new URL(req.url).hostname;
  if (!host.endsWith('.iroh')) throw new Error(`not an iroh host: ${host}`);
  const peer = host.slice(0, -'.iroh'.length);

  const raw = buildRequest(req.method, req.url, req.headers, req.body);
  const bytes = new Uint8Array(await client.request(peer, relay, raw));
  return parseResponse(bytes);
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
    mode = msg.mode || 'fetch';
    relay = msg.relay || null;
    try {
      if (mode === 'iroh') {
        const wasm = await import('/wasm/quackhole.js');
        await wasm.default();
        client = await wasm.connect();
        console.log(`[qh-bridge] iroh endpoint ${client.endpointId()}`);
      }
      // Only now is the bridge usable. The shim blocks on this flag, so setting
      // it before the endpoint exists would let the first request race the bind.
      Atomics.store(ctl, 4, 1);
      Atomics.notify(ctl, 4);
    } catch (err) {
      console.error(`[qh-bridge] init failed: ${err}`);
      Atomics.store(ctl, 4, 2);
      Atomics.notify(ctl, 4);
    }
    return;
  }

  try {
    const res = mode === 'iroh' ? await performIroh(msg) : await performFetch(msg);
    writeChunk(
      new TextEncoder().encode(JSON.stringify({ status: res.status, headers: res.headers })),
      META,
    );

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
