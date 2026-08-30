// Replaces the DuckDB worker's XMLHttpRequest for hosts we own.
//
// The problem this solves: duckdb-wasm's glue calls `open(method, url, false)`
// -- a *synchronous* request -- but every transport we want to put underneath it
// (iroh, or plain fetch) is async. JavaScript cannot await inside a sync call, so
// the request is handed to a second worker over postMessage and this thread
// blocks on Atomics.wait until that worker writes the response into a
// SharedArrayBuffer. That is the only way to bridge sync to async on a thread,
// and it is why the page needs cross-origin isolation.
(function () {
  'use strict';

  const NativeXHR = self.XMLHttpRequest;
  const params = new URLSearchParams(self.location.search);

  // Layout and constants live in protocol.js, loaded by both sides. Declared
  // up here because TIMEOUT_MS below falls back to it: when a caller omits
  // `timeout` -- which web/README.md documents as optional -- reading it from
  // further down the IIFE is a temporal-dead-zone error, and the whole worker
  // dies before duckdb ever loads.
  const P = globalThis.QH_PROTO;

  // Hosts to intercept. `.iroh` is the real target; the extra pattern lets the
  // bridge be tested against an ordinary HTTP server, with no iroh involved.
  const EXTRA = params.get('intercept') || '';
  // Per-request tracing. Off by default; the harness only needs the intercept
  // announcements below, and the rest is noise until something is wrong.
  const DEBUG = params.get('debug') === '1';
  // Bounding this is not a nicety: this thread blocks in Atomics.wait, so an
  // unbounded request does not fail slowly, it wedges the DuckDB worker
  // forever with nothing logged anywhere.
  const TIMEOUT_MS = Number(params.get('timeout')) || P.DEFAULT_TIMEOUT_MS;
  function shouldIntercept(url) {
    try {
      const u = new URL(url, self.location.href);
      if (u.hostname.endsWith('.iroh')) return true;
      return EXTRA !== '' && u.host === EXTRA;
    } catch {
      return false;
    }
  }

  // --- shared state -------------------------------------------------------
  // Deliberately overridable: the harness shrinks this so that ordinary
  // responses span several chunks and the reassembly path is actually run.
  const DATA_BYTES = Number(params.get('chunk')) || 8 * 1024 * 1024;

  const sab = new SharedArrayBuffer(P.CTL_BYTES + DATA_BYTES);
  const ctl = new Int32Array(sab, 0, 8);
  const data = new Uint8Array(sab, P.CTL_BYTES);

  // Nested worker: the shim owns the bridge, so the page does not have to know
  // it exists and there is no handshake to race against duckdb's own onmessage.
  // A module worker, because the wasm glue is an ES module.
  const bridge = new Worker(params.get('bridge') || './bridge-worker.js', { type: 'module' });
  bridge.postMessage({
    __qh: 'init',
    sab,
    mode: params.get('mode') || 'fetch',
    relay: params.get('relay') || null,
    // Test-only: makes the bridge stop answering, so the deadline above can
    // be shown to fire rather than merely existing.
    fault: params.get('fault') || null,
  });

  function waitForBridge() {
    const deadline = Date.now() + 30000;
    while (Atomics.load(ctl, P.READY) === P.NOT_READY) {
      if (Date.now() > deadline) throw new Error('quackhole bridge never became ready');
      Atomics.wait(ctl, P.READY, P.NOT_READY, 1000);
    }
    // Distinguishing "started and failed" from "still starting" matters: one is
    // a broken environment, the other is a slow one.
    if (Atomics.load(ctl, P.READY) === P.READY_FAILED) {
      throw new Error('quackhole bridge failed to initialise');
    }
  }

  /// Blocks until the bridge has delivered every chunk of the response.
  function roundTrip(request) {
    waitForBridge();
    Atomics.store(ctl, P.STATE, P.IDLE);
    bridge.postMessage({ ...request, timeoutMs: TIMEOUT_MS });

    const deadline = Date.now() + TIMEOUT_MS + P.GRACE_MS;
    let meta = null;
    const chunks = [];
    for (;;) {
      while (Atomics.load(ctl, P.STATE) === P.IDLE) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`quackhole bridge did not respond within ${TIMEOUT_MS + P.GRACE_MS}ms`);
        }
        // Capped so the deadline is re-checked even if no notify ever arrives,
        // which is the case that matters: a bridge that died notifies nothing.
        Atomics.wait(ctl, P.STATE, P.IDLE, Math.min(remaining, 1000));
      }

      const state = Atomics.load(ctl, P.STATE);
      const flags = Atomics.load(ctl, P.FLAGS);
      const payload = data.slice(0, Atomics.load(ctl, P.LEN));

      // Release the buffer before acting on the chunk, so the bridge can start
      // filling the next one while we copy this one out.
      Atomics.store(ctl, P.STATE, P.IDLE);
      Atomics.notify(ctl, P.STATE);

      if (state === P.ERROR) {
        throw new Error(new TextDecoder().decode(payload) || 'bridge error');
      }
      if (flags & P.META) {
        meta = JSON.parse(new TextDecoder().decode(payload));
        continue;
      }
      chunks.push(payload);
      if (!(flags & P.MORE)) break;
    }

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const body = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.length;
    }
    // Falling back to status 0 here would hand the glue exactly the value it
    // treats as an unexplained failure, turning a protocol bug into the least
    // informative error we can produce.
    if (!meta) throw new Error('bridge sent a response with no metadata chunk');
    return { status: meta.status, headers: meta.headers, body };
  }

  // --- the XHR replacement ------------------------------------------------
  // Subclassing rather than reimplementing: anything we do not intercept keeps
  // the native behaviour exactly, including events and every property the rest
  // of duckdb-wasm might use on requests that are none of our business.
  class QuackholeXHR extends NativeXHR {
    open(method, url, isAsync) {
      this.__qh = shouldIntercept(url) ? { method, url, headers: {}, done: false } : null;
      if (DEBUG) console.log(`[qh-shim] open ${method} ${url} intercept=${!!this.__qh}`);
      if (!this.__qh) return super.open(method, url, isAsync);
    }

    setRequestHeader(name, value) {
      if (!this.__qh) return super.setRequestHeader(name, value);
      this.__qh.headers[name] = value;
    }

    send(body) {
      if (!this.__qh) return super.send(body);
      // Announced so the harness can prove the shim was actually on the path:
      // without it a mis-scoped predicate would fall through to the native
      // transport and the tests would pass while measuring nothing. Gated, so
      // real use does not log a line per request.
      if (DEBUG) console.log(`[qh-shim] intercept ${this.__qh.method} ${this.__qh.url}`);
      try {
        const res = roundTrip({
          method: this.__qh.method,
          url: this.__qh.url,
          headers: this.__qh.headers,
          body: body ? new Uint8Array(body) : null,
        });
        Object.assign(this.__qh, { done: true, ...res });
        if (DEBUG) console.log(`[qh-shim] done status=${res.status} bytes=${res.body.length}`);
      } catch (err) {
        console.error(`[qh-shim] failed ${err && err.message ? err.message : err}`);
        // 502 rather than 0, because the glue bails out early on 0 and discards
        // the response entirely. It does not buy a better message: quack renders
        // whatever `HTTPResponse::GetError` returns (quack_client.cpp:63), which
        // is duckdb-wasm's text, not this body. The real cause is on the console
        // above, which is why that log is not gated.
        Object.assign(this.__qh, {
          done: true,
          status: 502,
          headers: {},
          body: new TextEncoder().encode(String(err && err.message ? err.message : err)),
        });
      }
    }

    get status() {
      return this.__qh && this.__qh.done ? this.__qh.status : super.status;
    }

    get response() {
      if (!(this.__qh && this.__qh.done)) return super.response;
      const b = this.__qh.body;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }

    getAllResponseHeaders() {
      if (!(this.__qh && this.__qh.done)) return super.getAllResponseHeaders();
      return Object.entries(this.__qh.headers)
        .map(([k, v]) => `${k.toLowerCase()}: ${v}\r\n`)
        .join('');
    }
  }

  self.XMLHttpRequest = QuackholeXHR;
  self.__quackholeShim = { sab, intercept: EXTRA };
})();
