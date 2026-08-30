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
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'dist');
const WEB = join(ROOT, 'web');
const DUCKDB = join(HERE, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');

const exists = async (p) => access(p).then(() => true, () => false);
const say = (msg) => console.log(`  ${msg}`);

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

async function fetchFonts() {
  try {
    // Without a browser UA, Google serves ttf instead of woff2.
    const res = await fetch(FONT_CSS, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const css = await res.text();

    await mkdir(join(OUT, 'fonts'), { recursive: true });
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
    const files = new Map(faces.map((face) => [face.url, basename(new URL(face.url).pathname)]));
    await Promise.all(
      [...files].map(async ([url, file]) => {
        const font = await fetch(url);
        if (!font.ok) throw new Error(`HTTP ${font.status} for ${file}`);
        await writeFile(join(OUT, 'fonts', file), Buffer.from(await font.arrayBuffer()));
      }),
    );

    const out = faces.map((face) => face.block.replace(face.url, `./fonts/${files.get(face.url)}`));

    await writeFile(join(OUT, 'fonts.css'), `/* Fetched at build time. See build.mjs. */\n${out.join('\n')}\n`);
    say(`fonts: ${out.length} faces from ${files.size} files`);
  } catch (err) {
    await writeFile(
      join(OUT, 'fonts.css'),
      `/* Font fetch failed at build time (${err.message}).\n   styles.css falls back to system faces. */\n`,
    );
    console.warn(`  fonts: SKIPPED (${err.message}) -- falling back to system faces`);
  }
}

// --- build ------------------------------------------------------------------

async function buildSite() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // duckdb-wasm's ESM entry imports apache-arrow by bare specifier, which no
  // browser resolves, so the driver has to be bundled. The worker scripts and
  // .wasm files below are served verbatim -- they are already built.
  await build({
    entryPoints: [join(HERE, 'app.js')],
    outfile: join(OUT, 'app.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    sourcemap: true,
    logLevel: 'warning',
  });
  say('app.js bundled');

  for (const f of ['index.html', 'styles.css', 'coi-serviceworker.js']) {
    await cp(join(HERE, f), join(OUT, f));
  }

  // The browser client, verbatim. These four are what web/README.md documents.
  for (const f of ['protocol.js', 'shim.js', 'qh-worker.js', 'bridge-worker.js']) {
    await cp(join(WEB, f), join(OUT, f));
  }
  say('browser client copied from web/');

  if (!(await exists(join(WEB, 'wasm', 'quackhole.js')))) {
    throw new Error(
      'web/wasm is missing or empty. Build the transport first:\n' +
      '    web/build-wasm.sh\n' +
      '  It is gitignored, so a fresh checkout never has it.',
    );
  }
  await cp(join(WEB, 'wasm'), join(OUT, 'wasm'), { recursive: true });
  say('iroh transport copied from web/wasm/');

  if (!(await exists(DUCKDB))) {
    throw new Error(`duckdb-wasm not installed. Run 'npm install' in ${HERE}.`);
  }
  await mkdir(join(OUT, 'duckdb'), { recursive: true });
  for (const f of [
    'duckdb-mvp.wasm',
    'duckdb-browser-mvp.worker.js',
    'duckdb-eh.wasm',
    'duckdb-browser-eh.worker.js',
  ]) {
    await cp(join(DUCKDB, f), join(OUT, 'duckdb', f));
  }
  say('duckdb-wasm bundles copied');

  // The page tells people to download this and read it. Serving it from the
  // same origin as the instructions is the only way that claim holds.
  await cp(join(ROOT, 'scripts', 'quackhole-demo.sh'), join(OUT, 'start.sh'));

  await fetchFonts();

  // Without this, Pages runs Jekyll over the output and drops anything whose
  // name starts with an underscore.
  await writeFile(join(OUT, '.nojekyll'), '');

  say(`done -> ${OUT}`);
}

// --- local preview ----------------------------------------------------------

// Serves dist/ with the isolation headers set directly. Locally that makes the
// service worker a no-op, so `npm run dev` exercises the transport without
// also depending on the Pages workaround -- when something breaks, that
// separation is what tells you which of the two it was.
async function serve() {
  await buildSite();
  const { port } = await startStaticServer(OUT, { isolate: true, port: 8099 });
  console.log(`\n  http://127.0.0.1:${port}\n`);
}

if (process.argv.includes('--serve')) await serve();
else await buildSite();
