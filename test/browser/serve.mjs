// Static server for the browser test. Serves the page from public/ and the
// stock duckdb-wasm bundles from node_modules under /duckdb/.
//
// Cross-origin isolation is opt-in (QH_COI=1). Step 1 does not need it, and
// turning it on unconditionally would risk failing this test for a reason that
// has nothing to do with what it measures. Step 2 needs it for SharedArrayBuffer.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
// The browser client is not part of this harness -- it is the shipped thing.
const WEB = join(HERE, '..', '..', 'web');
const DIST = join(HERE, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

export function startServer(port, { coi = false } = {}) {
  const server = createServer(async (req, res) => {
    // Strip the query string: duckdb-wasm appends cache-busting params.
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    // duckdb's bundles, then the client, then the harness page. Ordered rather
    // than merged so a name collision resolves predictably.
    const [roots, rel] = path.startsWith('/duckdb/')
      ? [[DIST], path.slice('/duckdb/'.length)]
      : [[WEB, PUBLIC], path === '/' ? 'index.html' : path.slice(1)];

    // normalize() has already collapsed '..', so a leading '..' is the only
    // way out of the root and rejecting it is enough.
    if (rel.startsWith('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }

    try {
      let body;
      for (const root of roots) {
        try {
          body = await readFile(join(root, rel));
          break;
        } catch {
          // try the next root
        }
      }
      if (body === undefined) throw new Error('not found');
      const headers = { 'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream' };
      if (coi) {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      }
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  // Port 0 lets the OS pick a free one. The default used to be 8080, which
  // collides with anything else the developer happens to be running.
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })),
  );
}
