// One static server, for the two callers that need one.
//
// `build.mjs --serve` previews the built site and `verify.mjs` drives a browser
// at it. Both were growing their own copy of the same path-normalise,
// reject-`..`, look-up-a-content-type, read-and-404 handler, and the two copies
// had already disagreed about which extensions they knew: a `.sh` added on one
// side was missing on the other, so the demo script would have been served as
// application/octet-stream by one server and text/plain by the other.
//
// Deliberately not shared with test/browser/serve.mjs, which does the same job
// against different roots. That one belongs to the harness; importing it here
// would point the shipped demo's build at the test suite.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.sh': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

// Appended to every HTML response under `reload`, rather than written into
// index.html: dist/ is what gets deployed, and the file that ships must not
// carry a dev-server script. The URL is relative because everything here is --
// see the note about project Pages sites in build.mjs.
const RELOAD_SNIPPET =
  '\n<script>new EventSource("__reload").onmessage = () => location.reload();</script>\n';

/**
 * @param root      directory to serve
 * @param isolate   send COOP/COEP directly. False leaves the page to
 *                  coi-serviceworker, which is what a Pages visitor gets.
 * @param port      0 lets the OS pick, which is what avoids colliding with
 *                  whatever else is already listening.
 * @param reload    serve the live-reload channel and inject its client. Only
 *                  `build.mjs --watch` wants this; verify.mjs must not have it,
 *                  since a reload mid-run would restart the page under it.
 *
 * Resolves with a `reload()` that tells every open page to refresh. It is a
 * no-op unless `reload` is set, so a caller can call it unconditionally.
 */
export function startStaticServer(root, { isolate = true, port = 0, reload = false } = {}) {
  const clients = new Set();

  const server = createServer(async (req, res) => {
    let rel;
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      rel = path === '/' ? 'index.html' : path.slice(1);
    } catch {
      // decodeURIComponent throws on a truncated escape (`GET /%`). This
      // handler is async, so letting it propagate is an unhandled rejection --
      // which by default terminates the process and takes the dev server, or a
      // verify run in progress, down with it.
      return void res.writeHead(400).end('bad request');
    }
    // normalize() has already collapsed '..', so a leading '..' is the only
    // way out of the root and rejecting it is enough.
    if (rel.startsWith('..')) return void res.writeHead(403).end('forbidden');

    // The one thing a static file server has to say. Held open, so a rebuild
    // can push rather than the page having to ask.
    if (reload && rel === '__reload') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      // A comment line, to flush the head: without it EventSource sits in
      // CONNECTING until the first real event, and the first save after a
      // page load would be missed.
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    try {
      let body = await readFile(join(root, rel));
      if (reload && extname(rel) === '.html') {
        body = Buffer.concat([body, Buffer.from(RELOAD_SNIPPET)]);
      }
      const headers = {
        'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      };
      if (isolate) {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      }
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  return new Promise((resolve, reject) => {
    // Without this, a busy port emits 'error' with nobody listening: Node
    // rethrows it as an uncaught exception and this promise never settles, so
    // the caller hangs after a full build instead of being told what is wrong.
    server.once('error', (err) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`port ${port} is already in use; stop what is on it, or pass port: 0`)
          : err,
      ),
    );
    server.listen(port, '127.0.0.1', () =>
      resolve({
        server,
        port: server.address().port,
        reload: () => {
          for (const c of clients) c.write('data: reload\n\n');
        },
      }),
    );
  });
}
