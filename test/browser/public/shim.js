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

  // Hosts to intercept. `.iroh` is the real target; the extra pattern lets the
  // bridge be tested against an ordinary HTTP server, with no iroh involved.
  const EXTRA = params.get('intercept') || '';
  // Per-request tracing. Off by default; the harness only needs the intercept
  // announcements below, and the rest is noise until something is wrong.
  const DEBUG = params.get('debug') === '1';
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
  // ctl[0] state: 0 = shim owns the buffer, 1 = chunk ready, 2 = error
  // ctl[1] byte length of the current chunk
  // ctl[2] HTTP status
  // ctl[3] flags: bit 0 = more chunks follow, bit 1 = this chunk is metadata
  // ctl[4] set to 1 by the bridge once it is ready to serve
  const CTL_BYTES = 32;
  // Deliberately overridable: the harness shrinks this so that ordinary
  // responses span several chunks and the reassembly path is actually run.
  const DATA_BYTES = Number(params.get('chunk')) || 8 * 1024 * 1024;
  const MORE = 1;
  const META = 2;

  const sab = new SharedArrayBuffer(CTL_BYTES + DATA_BYTES);
  const ctl = new Int32Array(sab, 0, 8);
  const data = new Uint8Array(sab, CTL_BYTES);

  // Nested worker: the shim owns the bridge, so the page does not have to know
  // it exists and there is no handshake to race against duckdb's own onmessage.
  // A module worker, because the wasm glue is an ES module.
  const bridge = new Worker(params.get('bridge') || '/bridge-worker.js', { type: 'module' });
  bridge.postMessage({
    __qh: 'init',
    sab,
    mode: params.get('mode') || 'fetch',
    relay: params.get('relay') || null,
  });

  function waitForBridge() {
    const deadline = Date.now() + 30000;
    while (Atomics.load(ctl, 4) === 0) {
      if (Date.now() > deadline) throw new Error('quackhole bridge never became ready');
      Atomics.wait(ctl, 4, 0, 1000);
    }
    // 2 means the bridge failed to start -- binding an iroh endpoint, most
    // likely. Distinguishing that from a timeout matters: one is a broken
    // environment, the other is a slow one.
    if (Atomics.load(ctl, 4) === 2) throw new Error('quackhole bridge failed to initialise');
  }

  /// Blocks until the bridge has delivered every chunk of the response.
  function roundTrip(request) {
    waitForBridge();
    Atomics.store(ctl, 0, 0);
    bridge.postMessage(request);

    let meta = null;
    const chunks = [];
    for (;;) {
      while (Atomics.load(ctl, 0) === 0) {
        Atomics.wait(ctl, 0, 0, 60000);
      }

      const state = Atomics.load(ctl, 0);
      const len = Atomics.load(ctl, 1);
      const flags = Atomics.load(ctl, 3);
      const payload = data.slice(0, len);

      // Release the buffer before acting on the chunk, so the bridge can start
      // filling the next one while we copy this one out.
      Atomics.store(ctl, 0, 0);
      Atomics.notify(ctl, 0);

      if (state === 2) {
        throw new Error(new TextDecoder().decode(payload) || 'bridge error');
      }
      if (flags & META) {
        meta = JSON.parse(new TextDecoder().decode(payload));
        continue;
      }
      chunks.push(payload);
      if (!(flags & MORE)) break;
    }

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const body = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.length;
    }
    return { status: meta ? meta.status : 0, headers: meta ? meta.headers : {}, body };
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
      // Announced so the harness can prove the shim was actually on the path.
      // Without this a mis-scoped predicate would fall through to the native
      // transport and the test would pass while measuring nothing.
      console.log(`[qh-shim] intercept ${this.__qh.method} ${this.__qh.url}`);
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
        console.log(`[qh-shim] failed ${err && err.message ? err.message : err}`);
        // The glue treats status 0 as an unexplained failure, so surface a real
        // HTTP status instead: DuckDB then reports something a user can act on.
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
