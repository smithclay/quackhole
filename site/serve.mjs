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

/**
 * @param root      directory to serve
 * @param isolate   send COOP/COEP directly. False leaves the page to
 *                  coi-serviceworker, which is what a Pages visitor gets.
 * @param port      0 lets the OS pick, which is what avoids colliding with
 *                  whatever else is already listening.
 */
export function startStaticServer(root, { isolate = true, port = 0 } = {}) {
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

    try {
      const body = await readFile(join(root, rel));
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
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
