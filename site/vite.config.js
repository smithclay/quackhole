// Builds the GitHub Pages site into site/dist/.
//
// The page is assembled from three places that stay separate on purpose:
//
//   site/       this experience -- markup, styles, the driver
//   web/        the shipped browser client, copied in verbatim
//   crates/     the iroh transport, via web/build-wasm.sh
//
// Nothing here reimplements the client. If the demo works, the thing a user
// would vendor into their own page works, because they are the same files.
//
// Vite owns index.html, styles.css and app.js -- the parts that are ours to
// bundle. The two plugins below own the parts that are not: files that must
// arrive byte-identical, and fonts that have to be fetched rather than found.
import { defineConfig } from 'vite';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WEB = join(ROOT, 'web');
const DUCKDB = join(HERE, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');

// Cross-origin isolation, which the SharedArrayBuffer bridge cannot run
// without. Sent directly here, so the dev server and `vite preview` exercise
// the transport without also depending on the service worker a Pages visitor
// falls back to -- when something breaks, that separation is what tells you
// which of the two it was.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Only for the files the plugins below serve themselves. Everything in the
// module graph, and everything in public/, goes through Vite.
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.sh': 'text/plain; charset=utf-8',
};

/// Serve files the build will produce, from the dev server, at the URLs the
/// build will put them at.
///
/// `body` takes a dist-relative path and returns the bytes to send, or null to
/// fall through to Vite. Having one of these means `npm run dev` and `npm run
/// build` cannot disagree about where something lives, which is the failure the
/// old builder's two copy paths kept inviting.
function serveGenerated(server, body) {
  server.middlewares.use(async (req, res, next) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
    } catch {
      // decodeURIComponent throws on a truncated escape (`GET /%`). This
      // handler is async, so letting anything propagate out of it is an
      // unhandled rejection -- which under Node's default takes the dev server
      // down rather than failing the one request.
      return void res.writeHead(400).end('bad request');
    }
    if (path.includes('..')) return next();

    let bytes;
    try {
      bytes = await body(path);
    } catch (err) {
      return void next(err);
    }
    if (bytes == null) return next();

    res.setHeader('Content-Type', MIME[extname(path)] ?? 'application/octet-stream');
    // Sent here rather than left to `server.headers`, which is applied by a
    // middleware this one runs ahead of and short-circuits. It is not a
    // nicety: a dedicated worker started from a cross-origin-isolated page
    // inherits COEP, and the browser rejects a worker script whose own
    // response is less strict than its owner. Without this qh-worker.js is
    // fetched, is 200, and still fails to start -- with an error event
    // carrying no message.
    for (const [k, v] of Object.entries(ISOLATION)) res.setHeader(k, v);
    res.end(bytes);
  });
}

// --- the files that ship verbatim -------------------------------------------

// Where a file lands in dist/ -> where it comes from. A value naming a
// directory brings everything under it.
//
// These are deliberately outside the module graph. Bundling them would break
// the demo's whole claim -- that it runs the same files a person would vendor
// -- and would break them outright besides: qh-worker.js reaches its two
// siblings through `importScripts('./protocol.js')` at runtime, which no
// content hash survives, and coi-serviceworker.js registers itself by
// `document.currentScript.src`, so a move into assets/ would scope the worker
// to assets/ and silently stop it controlling the page. That one lives in
// public/ for the same reason.
const VERBATIM = {
  // The browser client. These four are what web/README.md documents.
  'protocol.js': join(WEB, 'protocol.js'),
  'shim.js': join(WEB, 'shim.js'),
  'qh-worker.js': join(WEB, 'qh-worker.js'),
  'bridge-worker.js': join(WEB, 'bridge-worker.js'),

  // The iroh transport, from web/build-wasm.sh. Gitignored, so a fresh
  // checkout never has it.
  wasm: join(WEB, 'wasm'),

  // duckdb-wasm's prebuilt worker bundles, named one by one: the package's
  // dist/ is 143 MB and these four are 75 MB of it.
  'duckdb/duckdb-mvp.wasm': join(DUCKDB, 'duckdb-mvp.wasm'),
  'duckdb/duckdb-browser-mvp.worker.js': join(DUCKDB, 'duckdb-browser-mvp.worker.js'),
  'duckdb/duckdb-eh.wasm': join(DUCKDB, 'duckdb-eh.wasm'),
  'duckdb/duckdb-browser-eh.worker.js': join(DUCKDB, 'duckdb-browser-eh.worker.js'),

  // The page tells people to download this and read it. Serving it from the
  // same origin as the instructions is the only way that claim holds.
  'start.sh': join(ROOT, 'scripts', 'quackhole-demo.sh'),
};

function verbatim() {
  // A dist-relative request -> the file on disk backing it, or null. Directory
  // entries match by prefix so web/wasm/ resolves without being enumerated.
  const locate = (path) => {
    if (VERBATIM[path]) return VERBATIM[path];
    for (const [at, from] of Object.entries(VERBATIM)) {
      if (path.startsWith(`${at}/`)) return join(from, path.slice(at.length + 1));
    }
    return null;
  };

  return {
    name: 'quackhole:verbatim',

    // Read live off disk rather than copied into place: in dev there is no
    // staging step to go stale, and editing web/ is editing what is served.
    configureServer(server) {
      serveGenerated(server, async (path) => {
        const file = locate(path);
        if (!file) return null;
        return readFile(file).catch(() => null);
      });

      // Outside the module graph and outside the project root, so Vite does
      // not watch them itself -- but saving one should still reload the page.
      // web/wasm/ and the duckdb bundles are left out: both are build
      // artefacts that arrive by the megabyte, and a watcher on them would
      // fire mid-write.
      const watched = Object.values(VERBATIM).filter((from) => from !== join(WEB, 'wasm') && !from.startsWith(DUCKDB));
      server.watcher.add(watched);
      server.watcher.on('change', (file) => {
        if (watched.includes(file)) server.hot.send({ type: 'full-reload' });
      });
    },

    // Neither is committed, so a fresh checkout has neither. Saying so here is
    // the difference between one sentence and a page that boots, looks fine,
    // and 404s for its transport.
    async buildStart() {
      const has = (p) => stat(p).then(() => true, () => false);
      if (!(await has(join(WEB, 'wasm', 'quackhole.js')))) {
        this.error(
          'web/wasm is missing or empty. Build the transport first:\n' +
            '    web/build-wasm.sh\n' +
            '  It is gitignored, so a fresh checkout never has it.',
        );
      }
      if (!(await has(DUCKDB))) this.error(`duckdb-wasm not installed. Run 'npm install' in ${HERE}.`);
    },

    // cp rather than emitFile: these are 75 MB of prebuilt wasm, and there is
    // nothing for the bundler to do to them but hold them in memory.
    async writeBundle({ dir }) {
      await Promise.all(
        Object.entries(VERBATIM).map(async ([at, from]) => {
          await mkdir(dirname(join(dir, at)), { recursive: true });
          await cp(from, join(dir, at), { recursive: true });
        }),
      );
      // Without this, Pages runs Jekyll over the output and drops anything
      // whose name starts with an underscore.
      await writeFile(join(dir, '.nojekyll'), '');
    },
  };
}

// --- fonts ------------------------------------------------------------------

// Self-hosted, because the page runs under COEP: require-corp. A cross-origin
// <link rel=stylesheet> is fetched in no-cors mode, which require-corp blocks
// unless the far end sends CORP -- and fonts.googleapis.com does not promise
// to. Rather than gamble the page's typography on that, fetch once at build
// time and serve same-origin.
//
// A failure here is cosmetic: styles.css falls back to system faces. So it
// warns and continues rather than failing the build, which would take a
// working demo down over a font.
const FONT_CSS =
  'https://fonts.googleapis.com/css2' +
  '?family=Martian+Mono:wght@600;700' +
  '&family=IBM+Plex+Mono:wght@400;500' +
  '&family=IBM+Plex+Sans:wght@400;500;600' +
  '&display=swap';

async function fetchFonts(warn) {
  const files = new Map([['fonts.css', null]]);
  try {
    // Without a browser UA, Google serves ttf instead of woff2.
    const res = await fetch(FONT_CSS, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const css = await res.text();

    const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)];
    // Latin only. The other subsets triple the download and this page has no
    // copy that needs them.
    const wanted = blocks.filter(([, subset]) => subset === 'latin' || subset === 'latin-ext');
    if (wanted.length === 0) throw new Error('no latin @font-face blocks in the response');

    const faces = wanted
      .map(([, , block]) => ({ block, url: block.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1] }))
      .filter((face) => face.url);

    // Google collapses several of the requested weights onto one physical
    // file -- IBM Plex Sans 400/500/600 resolve to a single woff2 per subset --
    // so these 14 @font-face blocks name only 8 distinct URLs. Keying by URL
    // drops six redundant downloads, about 168 KB of the 311 KB a naive pass
    // would pull. They are independent, so fetch them together rather than
    // serially: this is otherwise a second of pure latency on every deploy.
    const names = new Map(faces.map((face) => [face.url, basename(new URL(face.url).pathname)]));
    await Promise.all(
      [...names].map(async ([url, name]) => {
        const font = await fetch(url);
        if (!font.ok) throw new Error(`HTTP ${font.status} for ${name}`);
        files.set(`fonts/${name}`, new Uint8Array(await font.arrayBuffer()));
      }),
    );

    const out = faces.map((face) => face.block.replace(face.url, `./fonts/${names.get(face.url)}`));
    files.set('fonts.css', `/* Fetched at build time. See vite.config.js. */\n${out.join('\n')}\n`);
    console.log(`  fonts: ${out.length} faces from ${names.size} files`);
  } catch (err) {
    warn(`fonts: SKIPPED (${err.message}) -- falling back to system faces`);
    files.set(
      'fonts.css',
      `/* Font fetch failed at build time (${err.message}).\n   styles.css falls back to system faces. */\n`,
    );
  }
  return files;
}

function fonts() {
  // Started at buildStart and awaited at the point of use, so the dev server
  // comes up now rather than a network round trip from now.
  let pending = null;

  return {
    name: 'quackhole:fonts',

    // fonts.css is fetched rather than committed, so index.html has nothing on
    // disk for Vite to resolve a <link href="fonts.css"> against. Vite warns
    // and leaves such a link alone, which does work -- but a warning on every
    // build is a warning nobody reads. Injecting after Vite's own HTML pass
    // sidesteps the resolution instead. Appended rather than prepended so
    // <meta charset> stays first; the file is nothing but @font-face rules, so
    // where it lands in the cascade does not matter.
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'link', attrs: { rel: 'stylesheet', href: 'fonts.css' }, injectTo: 'head' }],
    },

    buildStart() {
      pending = fetchFonts((msg) => this.warn(msg));
    },

    configureServer(server) {
      serveGenerated(server, async (path) => (await pending)?.get(path) ?? null);
    },

    async writeBundle({ dir }) {
      await mkdir(join(dir, 'fonts'), { recursive: true });
      for (const [at, body] of await pending) await writeFile(join(dir, at), body);
    },
  };
}

// --- config -----------------------------------------------------------------

export default defineConfig({
  // Relative, because this is a project Pages site served under /quackhole/
  // where a leading slash resolves to github.io itself.
  base: './',
  plugins: [verbatim(), fonts()],
  build: {
    // The bundle carries duckdb-wasm and apache-arrow; a map is what makes a
    // stack trace off the deployed page mean anything.
    sourcemap: true,
  },
  // 127.0.0.1 rather than Vite's default `localhost`, which on macOS resolves
  // to ::1 first: verify.mjs and site/README.md both name the v4 address, and a
  // server listening only on ::1 refuses them.
  server: { host: '127.0.0.1', port: 8099, headers: ISOLATION },
  preview: { host: '127.0.0.1', port: 8099, headers: ISOLATION },
});
