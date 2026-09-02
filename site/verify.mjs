// Drives the built workbench against a real server, headless.
//
// The page has one job -- take a ticket and end up querying the machine that
// minted it -- and that job crosses duckdb-wasm, the XHR shim, a
// SharedArrayBuffer, an iroh relay and a native DuckDB. Every one of those can
// break without the page looking broken, so asserting on the page's own end
// state is the only check worth having.
//
//   npm run build
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
import { preview } from 'vite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'dist');
const TICKET = process.env.QH_TICKET;
// A second server, optional. Attaching two proves the part one cannot: that the
// bridge routes each peer over its own relay and the two catalogs stay apart.
// It needs a second server, so it is opt-in rather than the default.
const TICKET2 = process.env.QH_TICKET2;
const REMOTE = process.env.QH_URL;
const VIA_SW = process.argv.includes('--sw');

if (!TICKET) {
  console.error('Set QH_TICKET to the ticket printed by `npx quackhole`');
  process.exit(2);
}
if (TICKET2 === TICKET) {
  console.error('QH_TICKET2 is the same ticket -- the page refuses to attach one peer twice, on purpose.');
  process.exit(2);
}

// A remote target serves itself; only the local run needs a server started here.
// `vite preview` rather than a server of our own, so what this drives is what
// `npm run preview` shows you -- one fewer thing that can be the difference
// between a passing run and a broken page.
let server = null;
let base;
if (REMOTE) {
  base = REMOTE.endsWith('/') ? REMOTE : `${REMOTE}/`;
  console.log(`\n  ${base}  (isolation via whatever the deployment does)\n`);
} else {
  server = await preview({
    // 0 lets the OS pick, which avoids colliding with a dev server already on
    // 8099.
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'warn',
    // Under --sw the page has to earn cross-origin isolation the way a
    // github.io visitor does, so the headers vite.config.js sets come off.
    // Passing `preview: { headers: {} }` above would not do it: inline config
    // is deep-merged into the file's, so an empty object leaves both headers
    // in place and the run quietly proves nothing. Mutating in `config` is
    // after the file is loaded and before anything reads it.
    plugins: VIA_SW ? [{ name: 'qh:no-isolation', config: (c) => void ((c.preview ??= {}).headers = {}) }] : [],
  });
  base = server.resolvedUrls.local[0].replace(/\/?$/, '/');
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

// Everything on the shell's screen, as text.
//
// xterm renders to a canvas when WebGL is there and to the DOM when it is not,
// and only the DOM path leaves anything to read -- which is what the WebGL
// denial below the browser launch is for. `.xterm-rows` is the DOM renderer's
// own element, one child per visible row.
const terminal = (page) => page.$eval('.xterm-rows', (e) => e.innerText);

// The screen holding nothing but a prompt with nothing typed at it. Written
// against the trailing whitespace on purpose: while `.clear` is being typed the
// only line is `duckdb> .clear`, which starts with a prompt and would satisfy
// anything looser -- so the wait would pass before the clear had happened.
const IDLE = () => {
  const lines = document.querySelector('.xterm-rows').innerText.split('\n').filter((l) => l.trim());
  return lines.length === 1 && /^duckdb>\s*$/.test(lines[0]);
};

/// Type a statement at the prompt and wait for the shell to come back.
///
/// The way a visitor runs one, because it is the only way there is: the shell
/// owns its terminal and publishes no way to put text on it, which is the same
/// fact that made the page stop seeding queries. Clicking the terminal first
/// throws if a dialog is over it, which is the failure worth having.
///
/// The screen is cleared first, so what is left afterwards is this statement
/// and its result and nothing before it. Without that the assertions would have
/// to find where the previous statement's output ended, and the terminal
/// scrolls -- earlier rows leave `.xterm-rows` entirely once the screen fills.
///
/// The whole screen comes back rather than the result alone. A statement longer
/// than the terminal is wrapped across rows, so the echo is not reliably one
/// line and there is no honest place to cut; callers look for what they expect
/// instead.
async function run(page, sql) {
  await page.click('#shell');
  await page.keyboard.type('.clear');
  await page.keyboard.press('Enter');
  await page.waitForFunction(IDLE, null, { timeout: 30_000 });

  await page.keyboard.type(sql);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => {
      const lines = document.querySelector('.xterm-rows').innerText.split('\n').filter((l) => l.trim());
      return lines.length > 1 && /^duckdb>\s*$/.test(lines[lines.length - 1]);
    },
    null,
    { timeout: 90_000 },
  );

  const text = await terminal(page);
  // The shell prints an error where it would have printed a table, so whether a
  // statement worked is a question about the text. Anchored to the start of a
  // line and to DuckDB's own `<Kind> Error:` shape: a bare /error/ would fail
  // the demo server's own `SELECT level, count(*) ... FROM events`, whose
  // result has a row called `error` in it.
  return { text, ok: !/^[A-Z][A-Za-z ]*Error[:!]/m.test(text) };
}

/// Wait for the shell to finish announcing a freshly attached remote.
///
/// The page types a statement over the new catalog once the attach lands, and
/// that is a round trip through the relay. Waiting for it is not politeness: it
/// is the terminal this script also types into, and `run` below would otherwise
/// be able to clear the screen halfway through a statement the page was still
/// putting on it. Doubles as the assertion that the announcement happens.
async function announced(page, name) {
  await page.waitForFunction(
    (n) => new RegExp(`${n} is attached: run one of these`).test(document.querySelector('.xterm-rows')?.innerText ?? ''),
    name,
    { timeout: 60_000 },
  );
}

// The last thing the shell printed before the trailing prompt, for the log.
const tail = (text, n = 6) =>
  text
    .split('\n')
    .filter((l) => l.trim() && !/^duckdb>\s*$/.test(l))
    .slice(-n)
    .join('\n            ');

const browser = await chromium.launch();
const page = await browser.newPage();

// Deny WebGL, so xterm falls back to its DOM renderer and the terminal's text
// is in the page rather than painted onto a canvas. Nothing else here needs it,
// and a canvas would leave this script with a shell it can drive and cannot
// read. The shell picks its renderer once, at embed, from these three.
await page.addInitScript(() => {
  const no = () => false;
  for (const m of ['probablySupportsContext', 'supportsContext']) {
    if (m in HTMLCanvasElement.prototype) HTMLCanvasElement.prototype[m] = no;
  }
  delete window.WebGL2RenderingContext;
});

page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /qh-shim|qh-bridge|coi/.test(t)) console.log(`  console  ${t}`);
});
page.on('pageerror', (e) => console.log(`  pageerror  ${e.message}`));

// The service worker's own console, which is not the page's. In --sw mode it
// synthesises every response the page sees, so a throw inside its fetch handler
// fails that request -- and lands nowhere a run would otherwise look. That is
// how `new Response(body, {status: 304})` sat there: a TypeError per revalidated
// subresource, in a console nobody opens.
const swErrors = [];
page.context().on('serviceworker', (worker) => {
  worker.on('console', (m) => {
    if (m.type() !== 'error') return;
    swErrors.push(m.text());
    console.log(`  sw error  ${m.text()}`);
  });
});

let failed = null;
try {
  await page.goto(`${base}#${TICKET}`, { waitUntil: 'domcontentloaded' });

  // coi-serviceworker reloads once on first visit; the fragment survives it.
  await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 20_000 });
  console.log('  cross-origin isolated');

  // The link's ticket is offered, not acted on -- attaching grants query access
  // to somebody's machine, so the page names the peer and waits for a click.
  // Asserting the endpoint is on screen is what proves the offer describes the
  // ticket it will dial, rather than being a confirm step over a blank.
  await page.waitForSelector('#connect[open]', { timeout: 30_000 });
  const offered = (await page.textContent('#connect-id')).trim();
  const wantId = JSON.parse(Buffer.from(TICKET.slice(4), 'base64url')).e;
  if (offered !== wantId) failed = `the offer names "${offered}", expected "${wantId}"`;
  console.log(`  offered   ${offered}`);
  await page.click('#connect-go');

  await page.waitForSelector('#status[data-state="live"]', { timeout: 90_000 });

  // The shell greets over the database it was handed, so its banner is the
  // first evidence that resolveDatabase gave it a live one rather than a
  // half-built one -- and that the page's own INSTALL/LOAD did not race it.
  await page.waitForFunction(
    () => /DuckDB Web Shell/.test(document.querySelector('.xterm-rows')?.innerText ?? ''),
    null,
    { timeout: 90_000 },
  );
  console.log(`  shell     ${(await terminal(page)).split('\n').find((l) => l.includes('Database:'))?.trim()}`);

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
  if (!conns.includes('remote')) failed = `rail does not list the remote: ${conns.join(', ')}`;

  // The rail's table list is a round trip too, and the page runs it first --
  // what it finds is what decides which cells get seeded. A workbench that
  // connects but never shows anything to query looks the same as one that did
  // not connect.
  await waitForTables(page, 'remote.');
  await announced(page, 'remote');
  console.log('  announced  the shell listed the remote\'s tables as runnable statements');

  const tables = await page.$$eval('.schema-item', (els) => els.map((e) => e.textContent.trim()));
  console.log(`  tables    ${tables.join(', ') || '(none)'}`);

  // What the notebook used to seed and run for a freshly attached remote. The
  // shell takes nothing from the page, so these are typed now -- by a visitor,
  // and here by this. Run in full rather than stopping at the first failure:
  // "some of them worked" and "all of them worked" have to look different.
  //
  // Both spellings of the info table are accepted for the same reason the page
  // used to accept both: this site ships on a push to main and the CLI on a
  // release tag, so a visitor can arrive against either one.
  const info = ['remote.host_info', 'remote.laptop_info'].find((t) => tables.includes(t));
  const first = [
    info && `SELECT host, os, duckdb_version FROM ${info};`,
    tables.includes('remote.events') &&
      'SELECT level, count(*) AS n FROM remote.events GROUP BY level ORDER BY n DESC;',
  ].filter(Boolean);
  if (first.length < 2) {
    failed = `expected host_info and events on the demo server, saw ${tables.join(', ') || '(none)'}`;
  }

  console.log('');
  for (const sql of first) {
    const r = await run(page, sql);
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${sql}`);
    console.log(`            ${tail(r.text)}`);
    if (!r.ok) failed = `${sql} failed`;
  }

  // A statement of the visitor's own, over the remote, through the terminal --
  // the half of the workbench nothing above drives.
  const own = await run(page, 'SELECT count(*) AS n, max(ts) AS newest FROM remote.events;');
  console.log(`\n  own query  ${own.ok ? 'ok' : 'FAIL'}\n            ${tail(own.text)}`);
  if (!own.ok) failed = `the hand-typed query failed:\n${own.text}`;

  // --- the second server, if one was offered -------------------------------
  if (TICKET2) {
    await page.click('#add-remote');
    await page.fill('#ticket', TICKET2);
    await page.click('#paste-go');

    await page.waitForFunction(
      () => [...document.querySelectorAll('.conn .conn-name')].some((e) => e.textContent.trim() === 'remote2'),
      null,
      { timeout: 90_000 },
    );
    console.log(`\n  ${(await page.textContent('#paste-note')).trim()}`);
    await waitForTables(page, 'remote2.');
    await announced(page, 'remote2');

    // Each remote draws its own route, because each is reached over its own
    // relay. One diagram for two peers would have to name one of them.
    const routes = await page.$$eval('.wire-frame .wire-relay-host', (els) => els.map((e) => e.textContent.trim()));
    console.log(`  routes    ${routes.join(', ')}`);
    if (routes.length !== 2) failed = `expected two routes drawn, saw ${routes.length}`;

    const status = (await page.textContent('#status-text')).trim();
    console.log(`  status    ${status}`);
    if (!status.startsWith('2 remotes')) failed = `status reads "${status}", expected 2 remotes`;

    // One statement across both catalogs. sqlite_master rather than a table
    // name, because the second server is allowed to be any DuckDB -- and this
    // is the assertion that says the two secrets and the two relays did not get
    // crossed, since a mix-up authenticates as the wrong peer or dials the
    // wrong one.
    const cross = await run(
      page,
      "SELECT 'remote' AS peer, count(*) AS tables FROM remote.sqlite_master" +
        " UNION ALL SELECT 'remote2', count(*) FROM remote2.sqlite_master;",
    );
    console.log(`  both      ${cross.ok ? 'ok' : 'FAIL'}\n            ${tail(cross.text)}`);
    if (!cross.ok) failed = `querying both remotes at once failed:\n${cross.text}`;
  }

  // Taken here rather than at the end: this is the workbench with everything
  // attached, and the checks below deliberately take it apart again.
  // Viewport, not fullPage: the bar is fixed and the rail is sticky, and a
  // full-page capture renders both at the scroll offset, which looks like a
  // layout bug that is not there.
  await page.screenshot({ path: join(OUT, 'verify.png') });
  console.log(`  screenshot -> site/dist/verify.png`);

  // Attaching the same peer twice is refused by name, and the refusal has to
  // land in the dialog rather than anywhere else -- an error thrown past the
  // form leaves a modal open over a page that looks like it worked.
  await page.click('#add-remote');
  await page.fill('#ticket', TICKET);
  await page.click('#paste-go');
  await page.waitForSelector('#paste-error:not([hidden])', { timeout: 30_000 });
  const dupe = (await page.textContent('#paste-error')).trim();
  console.log(`\n  duplicate  ${dupe}`);
  if (!/already attached/i.test(dupe)) failed = `a duplicate ticket said "${dupe}"`;
  await page.click('#add .dialog-x button');

  // Detaching gives the name and the route back. Without it a peer that has
  // gone away stays in the rail forever and its name stays taken.
  if (TICKET2) {
    await page.click('.conn:has(.conn-name:text-is("remote2")) .conn-x');
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('.conn .conn-name')].some((e) => e.textContent.trim() === 'remote2') &&
        ![...document.querySelectorAll('.schema-item')].some((e) => e.textContent.startsWith('remote2.')),
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
  const detach = await run(page, 'DETACH remote;');
  if (!detach.ok) failed = `a hand-typed DETACH failed:\n${detach.text}`;
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

  // Checked last, so it covers the whole run. Nothing above asserts on the
  // service worker directly -- it is meant to be invisible -- and "invisible"
  // is exactly what makes an error thrown inside it worth failing on.
  if (swErrors.length) failed = `the service worker logged ${swErrors.length} error(s): ${swErrors[0]}`;

} catch (err) {
  failed = err.message;
} finally {
  await browser.close();
  await server?.close();
}

console.log(failed ? `\n  FAILED: ${failed}\n` : '\n  PASS\n');
process.exit(failed ? 1 : 0);
