// Drives the built site against a real laptop, headless.
//
// The page has one job -- take a ticket and end up querying the machine that
// minted it -- and that job crosses duckdb-wasm, the XHR shim, a
// SharedArrayBuffer, an iroh relay and a native DuckDB. Every one of those can
// break without the page looking broken, so asserting on the page's own
// end state is the only check worth having.
//
//   node build.mjs
//   QH_TICKET=qh1_... node verify.mjs
//
// Serves with the isolation headers set directly rather than through
// coi-serviceworker: this proves the transport, not the Pages workaround. Pass
// --sw to exercise the service worker path instead, which is what a visitor to
// github.io actually gets.
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'dist');
const TICKET = process.env.QH_TICKET;
const VIA_SW = process.argv.includes('--sw');

if (!TICKET) {
  console.error('Set QH_TICKET to the ticket printed by scripts/quackhole-demo.sh');
  process.exit(2);
}

const { server, port } = await startStaticServer(OUT, { isolate: !VIA_SW });
const base = `http://127.0.0.1:${port}/`;
console.log(`\n  serving ${OUT}\n  ${base}  (isolation via ${VIA_SW ? 'service worker' : 'headers'})\n`);

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /qh-shim|qh-bridge|coi/.test(t)) console.log(`  console  ${t}`);
});
page.on('pageerror', (e) => console.log(`  pageerror  ${e.message}`));

let failed = null;
try {
  await page.goto(`${base}#${TICKET}`, { waitUntil: 'domcontentloaded' });

  // coi-serviceworker reloads once on first visit; the fragment survives it.
  await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 20_000 });
  console.log('  cross-origin isolated');

  await page.waitForSelector('#status[data-state="live"]', { timeout: 90_000 });
  console.log(`  ${await page.textContent('#paste-note')}`);

  // Every probe must land, not just the first: the tour stops at the first
  // failure, so "some probes ran" is indistinguishable from success otherwise.
  await page.waitForFunction(
    () => {
      const probes = document.querySelectorAll('#probes .probe');
      return probes.length > 0 && [...probes].every((p) => p.dataset.state !== 'pending');
    },
    null,
    { timeout: 90_000 },
  );

  const probes = await page.$$eval('#probes .probe', (els) =>
    els.map((el) => ({
      state: el.dataset.state,
      sql: el.querySelector('.probe-sql').textContent,
      ms: el.querySelector('.probe-ms').textContent,
      out: el.querySelector('.probe-out').textContent,
    })),
  );

  console.log('');
  for (const p of probes) {
    console.log(`  ${p.state === 'ok' ? 'ok  ' : 'FAIL'}  ${p.ms.padStart(7)}  ${p.out}`);
    console.log(`          ${p.sql}`);
  }

  const bad = probes.filter((p) => p.state !== 'ok');
  if (bad.length) failed = `${bad.length} probe(s) failed`;
  if (probes.length !== 4) failed = `expected 4 probes, saw ${probes.length}`;

  // The console is the half a visitor drives themselves, and it is a different
  // code path from the tour, so exercise it too.
  await page.fill('#sql', 'SELECT count(*) AS n, max(ts) AS newest FROM laptop.events');
  await page.click('#run');
  await page.waitForSelector('.result table', { timeout: 60_000 });
  console.log(`\n  console  ${(await page.textContent('.result-meta')).trim()}`);

  await page.screenshot({ path: join(HERE, 'dist', 'verify.png'), fullPage: true });
  console.log(`  screenshot -> site/dist/verify.png`);
} catch (err) {
  failed = err.message;
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? `\n  FAILED: ${failed}\n` : '\n  PASS\n');
process.exit(failed ? 1 : 0);
