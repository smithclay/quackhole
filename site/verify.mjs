// Drives the built workbench against a real laptop, headless.
//
// The page has one job -- take a ticket and end up querying the machine that
// minted it -- and that job crosses duckdb-wasm, the XHR shim, a
// SharedArrayBuffer, an iroh relay and a native DuckDB. Every one of those can
// break without the page looking broken, so asserting on the page's own end
// state is the only check worth having.
//
//   node build.mjs
//   QH_TICKET=qh1_... node verify.mjs
//
// Serves with the isolation headers set directly rather than through
// coi-serviceworker: this proves the transport, not the Pages workaround. Pass
// --sw to exercise the service worker path instead, which is what a visitor to
// github.io actually gets.
//
// QH_URL points it at a deployed site instead of the local dist/, which is the
// only way to check that what is live on Pages still works -- a local dist/ can
// pass while the deployment is stale or broken.
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'dist');
const TICKET = process.env.QH_TICKET;
// A second laptop, optional. Attaching two proves the part one cannot: that the
// bridge routes each peer over its own relay and the two catalogs stay apart.
// It needs a second server, so it is opt-in rather than the default.
const TICKET2 = process.env.QH_TICKET2;
const REMOTE = process.env.QH_URL;
const VIA_SW = process.argv.includes('--sw');

if (!TICKET) {
  console.error('Set QH_TICKET to the ticket printed by scripts/quackhole-demo.sh');
  process.exit(2);
}
if (TICKET2 === TICKET) {
  console.error('QH_TICKET2 is the same ticket -- the page refuses to attach one laptop twice, on purpose.');
  process.exit(2);
}

// A remote target serves itself; only the local run needs a server started here.
let server = null;
let base;
if (REMOTE) {
  base = REMOTE.endsWith('/') ? REMOTE : `${REMOTE}/`;
  console.log(`\n  ${base}  (isolation via whatever the deployment does)\n`);
} else {
  const started = await startStaticServer(OUT, { isolate: !VIA_SW });
  server = started.server;
  base = `http://127.0.0.1:${started.port}/`;
  console.log(`\n  serving ${OUT}\n  ${base}  (isolation via ${VIA_SW ? 'service worker' : 'headers'})\n`);
}

// Wait for the rail to list a catalog's tables.
async function waitForTables(page, prefix) {
  await page.waitForFunction(
    (p) => [...document.querySelectorAll('.schema-item')].some((e) => e.textContent.startsWith(p)),
    prefix,
    { timeout: 60_000 },
  );
}

// Wait until at least `want` non-blank cells exist and none is still running.
async function settledCells(page, want) {
  await page.waitForFunction(
    (n) => {
      const cells = [...document.querySelectorAll('.cell')].filter((c) => c.querySelector('.cell-sql').value.trim());
      return cells.length >= n && cells.every((c) => c.dataset.state !== 'running');
    },
    want,
    { timeout: 90_000 },
  );
}

// Type into the trailing blank cell and run it, the way a visitor would.
async function runOwnCell(page, sql) {
  // Wait for the blank one rather than taking whatever is last: attaching a
  // remote appends its seeded cells and only then a fresh blank, so the last
  // cell is briefly a running query nobody typed.
  await page.waitForFunction(
    () => {
      const cells = [...document.querySelectorAll('.cell')];
      return cells.length > 0 && !cells[cells.length - 1].querySelector('.cell-sql').value.trim();
    },
    null,
    { timeout: 60_000 },
  );
  return runInLastCell(page, sql);
}

async function runInLastCell(page, sql) {
  const last = page.locator('.cell').last();
  await last.locator('.cell-sql').fill(sql);
  await last.locator('.cell-run').click();
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.cell:last-child');
      return c && c.dataset.state !== 'running' && c.dataset.state !== 'idle';
    },
    null,
    { timeout: 60_000 },
  );
  return {
    state: await last.getAttribute('data-state'),
    meta: (await last.locator('.result-meta, .result-error').first().textContent()).trim(),
    rows: await last
      .locator('.result table tr')
      .evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent.trim()).join(' | '))),
  };
}

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
  console.log(`  ${(await page.textContent('#paste-note')).trim()}`);

  // The relay legend lives in a sibling of the SVG mount, so it is easy to
  // query from the wrong root -- which fails silently and leaves the
  // placeholder in place. Assert it actually shows the ticket's relay.
  const shownRelay = (await page.textContent('.wire-relay-host')).trim();
  const wantRelay = new URL(JSON.parse(Buffer.from(TICKET.slice(4), 'base64url')).r).host;
  if (shownRelay !== wantRelay) {
    failed = `relay legend shows "${shownRelay}", expected "${wantRelay}"`;
  }
  console.log(`  relay legend  ${shownRelay}`);

  // The remote is attached, so the rail must list it and the schema must show
  // its tables. A workbench that connects but shows nothing to query looks the
  // same as one that did not connect.
  const conns = await page.$$eval('.conn .conn-name', (els) => els.map((e) => e.textContent.trim()));
  console.log(`  connections   ${conns.join(', ')}`);
  if (!conns.includes('laptop')) failed = `rail does not list the remote: ${conns.join(', ')}`;

  // The rail's table list is a round trip too, and the page runs it first --
  // what it finds is what decides which cells get seeded. A workbench that
  // connects but never shows anything to query looks the same as one that did
  // not connect.
  await waitForTables(page, 'laptop.');

  // Every seeded cell must land, not just the first: stopping at the first
  // failure would make "some cells ran" indistinguishable from success. Three,
  // because the demo laptop has laptop_info and events and the local hello cell
  // ran on arrival -- waiting for "any settled cell" would be satisfied by the
  // hello cell alone, before the seeded ones exist.
  await settledCells(page, 3);

  const cells = await page.$$eval('.cell', (els) =>
    els
      .filter((el) => el.querySelector('.cell-sql').value.trim())
      .map((el) => ({
        state: el.dataset.state,
        sql: el.querySelector('.cell-sql').value.trim(),
        ms: el.querySelector('.cell-ms').textContent,
        out: (el.querySelector('.result-meta') ?? el.querySelector('.result-error'))?.textContent ?? '',
      })),
  );

  console.log('');
  for (const c of cells) {
    console.log(`  ${c.state === 'ok' ? 'ok  ' : 'FAIL'}  ${c.ms.padStart(7)}  ${c.out}`);
    console.log(`          ${c.sql.replace(/\s+/g, ' ')}`);
  }

  // Least specific first, so the more useful message wins.
  const bad = cells.filter((c) => c.state !== 'ok');
  if (cells.length < 2) failed = `expected the seeded cells, saw ${cells.length}`;
  if (bad.length) failed = `${bad.length} of ${cells.length} cell(s) failed: ${bad[0].out}`;

  const tables = await page.$$eval('.schema-item', (els) => els.map((e) => e.textContent.trim()));
  console.log(`  tables    ${tables.join(', ') || '(none)'}`);

  // The empty cell at the end is the half a visitor drives themselves, and it
  // is a different code path from the seeded ones, so exercise it too.
  const own = await runOwnCell(page, 'SELECT count(*) AS n, max(ts) AS newest FROM laptop.events');
  console.log(`\n  own cell  ${own.state}  ${own.meta}`);
  if (own.state !== 'ok') failed = `the hand-typed cell failed: ${own.meta}`;

  // --- the second laptop, if one was offered -------------------------------
  if (TICKET2) {
    await page.click('#add-remote');
    await page.fill('#ticket', TICKET2);
    await page.click('#paste-go');

    await page.waitForFunction(
      () => [...document.querySelectorAll('.conn .conn-name')].some((e) => e.textContent.trim() === 'laptop2'),
      null,
      { timeout: 90_000 },
    );
    console.log(`\n  ${(await page.textContent('#paste-note')).trim()}`);
    await waitForTables(page, 'laptop2.');

    // Each remote draws its own route, because each is reached over its own
    // relay. One diagram for two peers would have to name one of them.
    const routes = await page.$$eval('.wire-frame .wire-relay-host', (els) => els.map((e) => e.textContent.trim()));
    console.log(`  routes    ${routes.join(', ')}`);
    if (routes.length !== 2) failed = `expected two routes drawn, saw ${routes.length}`;

    const status = (await page.textContent('#status-text')).trim();
    console.log(`  status    ${status}`);
    if (!status.startsWith('2 remotes')) failed = `status reads "${status}", expected 2 remotes`;

    // One statement across both catalogs. sqlite_master rather than a table
    // name, because the second laptop is allowed to be any DuckDB -- and this
    // is the assertion that says the two secrets and the two relays did not get
    // crossed, since a mix-up authenticates as the wrong peer or dials the
    // wrong one.
    const cross = await runOwnCell(
      page,
      "SELECT 'laptop' AS remote, string_agg(name, ', ' ORDER BY name) AS tables FROM laptop.sqlite_master" +
        " UNION ALL SELECT 'laptop2', string_agg(name, ', ' ORDER BY name) FROM laptop2.sqlite_master",
    );
    console.log(`  both      ${cross.state}  ${cross.meta}`);
    for (const r of cross.rows) console.log(`            ${r}`);
    if (cross.state !== 'ok') failed = `querying both remotes at once failed: ${cross.meta}`;
  }

  // Taken here rather than at the end: this is the workbench with everything
  // attached, and the checks below deliberately take it apart again.
  // Viewport, not fullPage: the bar is fixed and the rail is sticky, and a
  // full-page capture renders both at the scroll offset, which looks like a
  // layout bug that is not there.
  await page.screenshot({ path: join(OUT, 'verify.png') });
  console.log(`  screenshot -> site/dist/verify.png`);

  // Attaching the same laptop twice is refused by name, and the refusal has to
  // land in the dialog rather than anywhere else -- an error thrown past the
  // form leaves a modal open over a page that looks like it worked.
  await page.click('#add-remote');
  await page.fill('#ticket', TICKET);
  await page.click('#paste-go');
  await page.waitForSelector('#paste-error:not([hidden])', { timeout: 30_000 });
  const dupe = (await page.textContent('#paste-error')).trim();
  console.log(`\n  duplicate  ${dupe}`);
  if (!/already attached/i.test(dupe)) failed = `a duplicate ticket said "${dupe}"`;
  await page.click('#onboard .dialog-x button');

  // Detaching gives the name and the route back. Without it a laptop that has
  // gone away stays in the rail forever and its name stays taken.
  if (TICKET2) {
    await page.click('.conn:has(.conn-name:text-is("laptop2")) .conn-x');
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.conn .conn-name')].some((e) => e.textContent.trim() === 'laptop2') &&
        ![...document.querySelectorAll('.schema-item')].some((e) => e.textContent.startsWith('laptop2.')),
      null,
      { timeout: 30_000 },
    );
    const after = (await page.textContent('#status-text')).trim();
    const routesAfter = await page.$$eval('.wire-frame', (els) => els.length);
    console.log(`  detached   ${after}, ${routesAfter} route`);
    if (!after.startsWith('1 remote')) failed = `after detaching, status reads "${after}"`;
    if (routesAfter !== 1) failed = `after detaching, ${routesAfter} routes are still drawn`;
  }

  // The other way to detach: typing it. The rail has to notice, or it goes on
  // listing a connection the session no longer has -- which is the one thing a
  // list of connections must never do.
  await runInLastCell(page, 'DETACH laptop');
  await page.waitForFunction(
    () => {
      const names = [...document.querySelectorAll('.conn .conn-name')].map((e) => e.textContent.trim());
      return names.length === 1 && names[0] === 'memory' && document.querySelector('#wire-panel').hidden;
    },
    null,
    { timeout: 30_000 },
  );
  const bare = (await page.textContent('#status-text')).trim();
  console.log(`  hand DETACH  rail back to memory only, status "${bare}"`);
  if (bare !== 'local only') failed = `after a hand-typed DETACH, status reads "${bare}"`;

} catch (err) {
  failed = err.message;
} finally {
  await browser.close();
  server?.close();
}

console.log(failed ? `\n  FAILED: ${failed}\n` : '\n  PASS\n');
process.exit(failed ? 1 : 0);
