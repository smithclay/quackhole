// A page that has never seen this repo, booting duckdb-wasm and attaching to a
// live server.
//
//   node build.mjs
//   QH_TICKET=qh1_... node test/scratch.mjs
//
// Two origins, because that is the whole point of the packaging work: the page
// is on :8801 and the package on :8802, so every cross-origin restriction the
// loader exists to get around is actually in force -- `new Worker` refusing a
// cross-origin URL, a blob worker with no query string and no path to resolve
// siblings against, `importScripts` reaching back across origins.
//
// :8802 answers from a tarball this script builds with `npm pack`, not from
// npm/dist/ directly. What is served is therefore exactly what publishing would
// serve, including anything `files` in package.json forgot, and it can be run
// before anything is published.
//
// The page's module is the README's quickstart block, read out of README.md and
// run verbatim -- with the jsDelivr origin rewritten to :8802, and an epilogue
// appended to publish what it computed. That is the claim the demo makes one
// level up, made here: what a reader is told to paste is what a test runs.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const TICKET = process.env.QH_TICKET;
const PAGE_PORT = Number(process.env.QH_PAGE_PORT ?? 8801);
const CDN_PORT = Number(process.env.QH_CDN_PORT ?? 8802);

// The URL the README tells people to use. Rewritten to the local CDN below;
// nothing else about the block changes.
const PUBLISHED = 'https://cdn.jsdelivr.net/npm/quackhole@0/dist/quackhole.js';

if (!TICKET) {
  console.error('Set QH_TICKET to the ticket printed by `npx quackhole`.');
  process.exit(2);
}

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited ${code}`))));
  });

// --- the snippet under test --------------------------------------------------

/// The first fenced block after the `<!-- tested: -->` marker in README.md.
///
/// Anchored on the marker rather than on "the first js block", so moving prose
/// around cannot quietly point this at a different snippet.
async function quickstart() {
  const readme = await readFile(join(PKG, 'README.md'), 'utf8');
  const block = readme.match(/<!--\s*tested:[^>]*-->\s*```js\n([\s\S]*?)```/);
  if (!block) throw new Error('no block marked `<!-- tested: -->` in README.md');
  if (!block[1].includes(PUBLISHED)) {
    throw new Error(`the tested block does not import ${PUBLISHED} -- has the CDN URL changed?`);
  }
  return block[1];
}

// --- servers -----------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.ts': 'text/plain; charset=utf-8',
};

/// Serve a directory the way jsDelivr does.
///
/// The headers are copied from a real jsDelivr response, CORP included. Fact
/// nine of the packaging brief says CORP made no difference to any probe, but
/// serving what the CDN serves is the only way this run says anything about the
/// CDN.
function startCdn(root, port) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).slice(1);
    // On the 404 as well as the 200: without them a missing file is reported to
    // the page as a CORS failure, which sends you looking for a header problem
    // when what is wrong is that the tarball does not contain the file.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (path.startsWith('..')) return void res.writeHead(403).end('forbidden');
    try {
      const body = await readFile(join(root, path));
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

/// Serve the scratch page, and the same page without isolation at `/bare`.
///
/// Two, because the README's first screen is about the one requirement that
/// cannot be shipped in a script tag, and a claim that `check()` names the
/// problem is worth as much as any other untested claim.
///
/// The import map is the harness's business, not the snippet's: a bare
/// specifier is resolved by the environment either way, and duckdb-wasm's ESM
/// entry imports apache-arrow by bare specifier, so a page with no bundler
/// needs jsDelivr's `+esm` for *that* package. The warning in the README is
/// about quackhole, which must stay unbundled -- it fetches its own siblings.
function startPage(html, port) {
  const server = createServer((req, res) => {
    const isolated = !new URL(req.url, 'http://x').pathname.startsWith('/bare');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      ...(isolated
        ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
        : {}),
    });
    res.end(html);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

// --- the run -----------------------------------------------------------------

const work = await mkdtemp(join(tmpdir(), 'quackhole-scratch-'));
let cdn = null;
let page = null;
let browser = null;
let failed = null;

try {
  const tarball = await run('npm', ['pack', '--pack-destination', work, '--silent'], { cwd: PKG });
  await run('tar', ['-xzf', join(work, tarball.split('\n').pop()), '-C', work]);
  const root = join(work, 'package');
  console.log(`\n  packed    ${tarball.split('\n').pop()}`);
  console.log(`  contents  ${(await readdir(join(root, 'dist', 'web'))).join(', ')}`);

  const snippet = (await quickstart()).replaceAll(PUBLISHED, `http://127.0.0.1:${CDN_PORT}/dist/quackhole.js`);
  const duckdbVersion = JSON.parse(await readFile(join(PKG, '..', 'site', 'package.json'), 'utf8')).dependencies[
    '@duckdb/duckdb-wasm'
  ];

  const html = `<!doctype html>
<meta charset="utf-8">
<title>quackhole scratch page</title>
<script type="importmap">
{"imports": {"@duckdb/duckdb-wasm": "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${duckdbVersion.replace(/^\^/, '')}/+esm"}}
</script>
<pre id="log"></pre>
<script type="module">
${snippet}
// --- appended by npm/test/scratch.mjs; everything above is the README's ---
globalThis.__result = { name: remote.name, attachMs: remote.attachMs, tables: [...tables] };
globalThis.__done = true;
</script>
`;

  cdn = await startCdn(root, CDN_PORT);
  page = await startPage(html, PAGE_PORT);
  console.log(`  page      http://127.0.0.1:${PAGE_PORT}  (isolated)`);
  console.log(`  package   http://127.0.0.1:${CDN_PORT}   (cors, like jsdelivr)\n`);

  browser = await chromium.launch();
  const tab = await browser.newPage();
  tab.on('console', (m) => {
    if (m.type() === 'error' || /qh-shim|qh-bridge|attach/.test(m.text())) console.log(`  console  ${m.text()}`);
  });
  // A module that throws never sets __done, so this is the only place the
  // failure shows up -- and it is the failure this whole exercise is about.
  tab.on('pageerror', (e) => {
    console.log(`  pageerror  ${e.message}`);
    failed ??= e.message;
  });

  await tab.goto(`http://127.0.0.1:${PAGE_PORT}/#${TICKET}`);
  await tab.waitForFunction('window.__done === true || window.__qhFailed', null, { timeout: 120_000 });
  const result = await tab.evaluate('window.__result');

  console.log(`\n  attached  ${result.name} in ${Math.round(result.attachMs)}ms`);
  for (const [name, tables] of result.tables) console.log(`  tables    ${name}: ${tables.join(', ') || '(none)'}`);

  const remote = result.tables.find(([name]) => name === result.name)?.[1] ?? [];
  if (remote.length === 0) failed ??= `${result.name} listed no tables -- the catalog is attached but empty`;

  // The same page without the isolation headers. It must fail saying so: the
  // alternative is a worker that is fetched, is 200, and dies with an error
  // event carrying no message, which is the failure the README leads with.
  const bare = await browser.newPage();
  // Both, because the snippet's failure is a rejected top-level await: some
  // builds surface that as an uncaught exception and some only as a console
  // error, and which one it is here is not the thing under test.
  let refusal = '';
  bare.on('pageerror', (e) => (refusal ||= e.message));
  bare.on('console', (m) => void (m.type() === 'error' && (refusal ||= m.text())));
  await bare.goto(`http://127.0.0.1:${PAGE_PORT}/bare#${TICKET}`);
  for (const deadline = Date.now() + 30_000; !refusal && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`\n  no isolation  ${refusal.split('\n')[0] || '(no error at all)'}`);
  if (!/crossOriginIsolated/.test(refusal)) {
    failed ??= `without isolation the page said "${refusal}", which does not name the problem`;
  }
} catch (err) {
  failed ??= err.message;
} finally {
  await browser?.close();
  cdn?.close();
  page?.close();
  await rm(work, { recursive: true, force: true });
}

console.log(failed ? `\n  FAILED: ${failed}\n` : '\n  PASS\n');
process.exit(failed ? 1 : 0);
