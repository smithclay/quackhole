// Drives the whole page: renders the laptop instructions, takes the ticket,
// boots DuckDB-Wasm through the quackhole transport, then runs the tour and
// the console.
//
// The DuckDB half is deliberately the same sequence test/browser/app.mjs runs,
// because that is the path with a passing cross-network test behind it. What
// is new here is everything around it.
import * as duckdb from '@duckdb/duckdb-wasm';
import { decodeTicket } from './ticket.js';
import { createWire } from './wire.js';

const $ = (sel) => document.querySelector(sel);
// Every asset is addressed relative to the page, never from the root: this is
// a project Pages site served under /quackhole/, so a leading slash would
// resolve to github.io itself.
const asset = (path) => new URL(path, document.baseURI).href;

const wire = createWire($('#wire'));
const statusEl = $('#status');
const statusText = $('#status-text');

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
  wire.setState(state);
}

// --- step 1: what to run on the laptop ------------------------------------

// The script mints its own token and puts it in the ticket, so nothing secret
// has to travel through an argv or this page's URL. The token below exists
// only for the hand-rolled path, where the user has to name one themselves.
const manualToken = (() => {
  const key = 'qh-demo-token';
  // Survives the one reload coi-serviceworker performs on first visit.
  let t = sessionStorage.getItem(key);
  if (!t) {
    t = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem(key, t);
  }
  return t;
})();

function detectPlatform() {
  const s = `${navigator.userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`;
  if (/win/i.test(s) && !/darwin/i.test(s)) return 'windows';
  if (/mac|darwin/i.test(s)) return 'macos';
  return 'linux';
}

function renderLaptopCommand() {
  const platform = detectPlatform();
  const scriptUrl = asset('start.sh');

  // Downloaded rather than piped into sh, so it can be read before it runs.
  // The command itself is the same everywhere; only the label and the caveat
  // depend on which machine is reading it.
  $('#cmd-serve').querySelector('code').textContent =
    `curl -fsSL ${scriptUrl} -o quackhole-demo.sh\nsh quackhole-demo.sh`;

  if (platform === 'windows') {
    $('#cmd-os').textContent = 'windows — use wsl or git bash';
    $('#prereq').innerHTML =
      'The setup script is POSIX shell, so on Windows run it under WSL or Git Bash — ' +
      'or open the by-hand path below, which is plain SQL.';
  } else {
    $('#cmd-os').textContent = platform === 'macos' ? 'macos — terminal' : 'linux — shell';
  }

  $('#cmd-manual').querySelector('code').textContent = [
    "INSTALL quack; LOAD quack;",
    "LOAD './quackhole.duckdb_extension';",
    '',
    '-- Same two tables scripts/quackhole-demo.sh creates, so the tour below',
    '-- finds what it expects. Edit the host string to taste.',
    'CREATE TABLE laptop_info AS',
    "  SELECT 'your laptop' AS host, 'by hand' AS os,",
    '         version() AS duckdb_version, now() AS started_at;',
    '',
    'CREATE TABLE events AS',
    "  SELECT range AS id, 'evt_' || range AS name,",
    "         ['debug','info','warn','error'][(range % 4) + 1] AS level,",
    '         now()::TIMESTAMP - INTERVAL (range) MINUTE AS ts',
    '  FROM range(5000);',
    '',
    `CALL quackhole_serve(token := '${manualToken}');`,
    '',
    '-- The ticket. Re-run this line if it says not ready yet.',
    "SELECT CASE WHEN relay_url IS NULL THEN 'not ready yet - run this line again'",
    "  ELSE 'qh1_' || rtrim(replace(replace(to_base64(encode(",
    `       '{\"e\":\"' || endpoint_id || '\",\"r\":\"' || relay_url || '\",\"t\":\"${manualToken}\"}'`,
    "       )), '+', '-'), '/', '_'), '=') END AS ticket",
    'FROM quackhole_status();',
  ].join('\n');
}

for (const btn of document.querySelectorAll('.copy')) {
  btn.addEventListener('click', async () => {
    const was = btn.textContent;
    try {
      await navigator.clipboard.writeText($(btn.dataset.copy).textContent.trim());
      btn.textContent = 'copied';
    } catch {
      // Denied, or the document is not focused. Saying so beats leaving the
      // visitor to paste whatever was on the clipboard before.
      btn.textContent = 'copy failed';
    }
    setTimeout(() => { btn.textContent = was; }, 1400);
  });
}

// Keep the diagram pointing at whichever machine the reader is looking at.
const stepObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) wire.focus(e.target.dataset.where);
  },
  { rootMargin: '-45% 0px -45% 0px' },
);
for (const step of document.querySelectorAll('.step')) stepObserver.observe(step);

// --- step 2: the connection ------------------------------------------------

const DUCKDB_BUNDLES = {
  mvp: { mainModule: asset('duckdb/duckdb-mvp.wasm'), mainWorker: asset('duckdb/duckdb-browser-mvp.worker.js') },
  eh: { mainModule: asset('duckdb/duckdb-eh.wasm'), mainWorker: asset('duckdb/duckdb-browser-eh.worker.js') },
};

const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;

// The whole chain is tracked, not just the connection. A failed ATTACH still
// leaves a DuckDB worker, the bridge worker it spawned, an 8 MB
// SharedArrayBuffer and a live iroh endpoint behind -- so a visitor who pastes
// a stale ticket twice would hold two of each, and a successful reconnect
// would silently orphan the first.
let session = null;

async function teardown() {
  if (!session) return;
  const { conn, db, worker } = session;
  session = null;
  // Each step can fail if the layer below already died; that is not worth
  // reporting, but it must not stop the ones after it.
  try { await conn.close(); } catch { /* already gone */ }
  try { await db.terminate(); } catch { /* already gone */ }
  worker.terminate();
}

async function connect(ticket) {
  await teardown();
  const { endpointId, relayUrl, token } = ticket;
  setStatus('connecting', 'dialling');
  wire.setRelayLabel(relayUrl);

  const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);

  // qh-worker installs the XHR shim into the worker global and only then loads
  // duckdb's own worker bundle, so duckdb is entirely unmodified underneath.
  const workerUrl =
    `${asset('qh-worker.js')}?target=${encodeURIComponent(bundle.mainWorker)}` +
    `&mode=iroh&relay=${encodeURIComponent(relayUrl)}`;

  const worker = new Worker(workerUrl);
  let db;
  let c;
  try {
    db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    c = await db.connect();

    await c.query('INSTALL quack');
    await c.query('LOAD quack');
    if (token) await c.query(`CREATE SECRET (TYPE quack, TOKEN ${sqlString(token)})`);

    const t0 = performance.now();
    await c.query(`ATTACH ${sqlString(`quack:${endpointId}.iroh:9494`)} AS laptop`);
    const attachMs = performance.now() - t0;

    session = { conn: c, db, worker };
    return attachMs;
  } catch (err) {
    try { await c?.close(); } catch { /* never opened */ }
    try { await db?.terminate(); } catch { /* never instantiated */ }
    worker.terminate();
    throw err;
  }
}

const pasteError = $('#paste-error');
const pasteNote = $('#paste-note');

function showError(msg) {
  pasteError.textContent = msg;
  pasteError.hidden = false;
}

$('#paste-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  pasteError.hidden = true;
  pasteNote.hidden = true;

  // The bridge parks the DuckDB thread in Atomics.wait, so without a
  // SharedArrayBuffer there is nothing to wait on. Say so before the failure
  // arrives as something less legible from inside a worker.
  if (!self.crossOriginIsolated) {
    showError(
      'This page is not cross-origin isolated, so SharedArrayBuffer is unavailable and the ' +
      'transport cannot run. Reload once — the service worker that adds the headers installs ' +
      'on first visit. If it persists, your browser may be blocking service workers here.',
    );
    return;
  }

  let ticket;
  try {
    ticket = decodeTicket($('#ticket').value);
  } catch (err) {
    showError(err.message);
    return;
  }

  const btn = $('#connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  try {
    const attachMs = await connect(ticket);
    setStatus('live', 'live · relay');
    pasteNote.textContent =
      `Attached in ${Math.round(attachMs)}ms as "laptop". That is three round trips through the relay.`;
    pasteNote.hidden = false;
    wire.pulse(attachMs);
    unlockQuery();
  } catch (err) {
    setStatus('failed', 'no route');
    showError(
      `Could not attach: ${err?.message ?? err}\n\n` +
      'Most often this means the laptop stopped serving, or the ticket is from an earlier run. ' +
      'Check the terminal is still running and copy a fresh ticket.',
    );
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

// --- step 3: the tour, then the console ------------------------------------

// Each probe has to prove something the previous one did not, or it is just
// latency theatre.
const PROBES = [
  {
    sql: 'SELECT host, os, duckdb_version FROM laptop.laptop_info',
    why: 'Read off the machine itself. That hostname is your laptop, not this tab.',
    format: (rows) => {
      const r = rows[0];
      return r ? `${r.host} · ${r.os} · duckdb ${r.duckdb_version}` : 'no rows';
    },
  },
  {
    sql: 'SELECT count(*) AS n FROM laptop.events',
    why: 'A full count, executed on the laptop. Only the answer crosses the wire.',
    format: (rows) => `${rows[0].n} rows`,
  },
  {
    sql: 'SELECT level, count(*) AS n FROM laptop.events GROUP BY level ORDER BY n DESC',
    why: 'The grouping happens there too — Quack pushes the aggregate down.',
    format: (rows) => rows.map((r) => `${r.level}=${r.n}`).join('  '),
  },
  {
    sql: "SELECT name, ts FROM laptop.events WHERE id = 42",
    why: 'A warm point lookup, for comparison. This is what steady-state latency costs.',
    format: (rows) => (rows[0] ? `${rows[0].name} @ ${rows[0].ts}` : 'no rows'),
  },
];

// Arrow hands back values that stringify badly. Counts arrive as BigInt, and
// DuckDB timestamps arrive as epoch milliseconds with a fractional part rather
// than as a Date -- so `ts` renders as 1788058053144.624 unless the column's
// declared type is consulted. That is why formatting is per field, not per
// value: the JS value alone cannot tell a timestamp from a large number.
const asDate = (v) => {
  const d = new Date(Number(v));
  return Number.isNaN(d.getTime()) ? String(v) : `${d.toISOString().slice(0, 19).replace('T', ' ')}Z`;
};

const cell = (v, type) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return asDate(v);
  if (/timestamp|^date/i.test(type) && (typeof v === 'number' || typeof v === 'bigint')) return asDate(v);
  if (typeof v === 'bigint') return Number(v);
  return v;
};

const rowsOf = (table) => {
  const types = Object.fromEntries(table.schema.fields.map((f) => [f.name, String(f.type)]));
  return table
    .toArray()
    .map((r) => Object.fromEntries(Object.entries(r.toJSON()).map(([k, v]) => [k, cell(v, types[k] ?? '')])));
};

function unlockQuery() {
  const step = $('#step-query');
  step.removeAttribute('data-locked');
  $('#tour').hidden = false;
  $('#console').hidden = false;
  runTour();
}

async function runTour() {
  const list = $('#probes');
  list.replaceChildren();

  for (const probe of PROBES) {
    const li = document.createElement('li');
    li.className = 'probe';
    li.dataset.state = 'pending';
    li.innerHTML =
      `<span class="probe-sql"></span><span class="probe-ms">running…</span>` +
      `<span class="probe-why"></span><span class="probe-out"></span>`;
    li.querySelector('.probe-sql').textContent = probe.sql;
    li.querySelector('.probe-why').textContent = probe.why;
    list.append(li);

    const t0 = performance.now();
    try {
      const rows = rowsOf(await session.conn.query(probe.sql));
      const ms = performance.now() - t0;
      li.dataset.state = 'ok';
      li.querySelector('.probe-ms').textContent = `${Math.round(ms)}ms`;
      li.querySelector('.probe-out').textContent = probe.format(rows);
      wire.pulse(ms);
    } catch (err) {
      // Keep going. The probes are independent, and stopping here would hide
      // three working ones behind a single missing table.
      li.dataset.state = 'failed';
      li.querySelector('.probe-ms').textContent = 'failed';
      li.querySelector('.probe-out').textContent = String(err?.message ?? err);
    }
  }
}

function renderResult(table, ms) {
  const mount = $('#result');
  const rows = rowsOf(table);
  const cols = table.schema.fields.map((f) => f.name);

  if (rows.length === 0) {
    mount.innerHTML = '<p class="result-meta"></p>';
    mount.querySelector('.result-meta').textContent = `No rows · ${Math.round(ms)}ms`;
    return;
  }

  const el = document.createElement('table');
  const head = el.insertRow();
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c;
    head.append(th);
  }
  // Enough to see the shape without turning the page into a grid widget.
  for (const r of rows.slice(0, 50)) {
    const tr = el.insertRow();
    for (const c of cols) {
      const td = tr.insertCell();
      td.textContent = r[c] === null ? '—' : String(r[c]);
    }
  }

  const meta = document.createElement('p');
  meta.className = 'result-meta';
  meta.textContent =
    `${rows.length} row${rows.length === 1 ? '' : 's'}` +
    `${rows.length > 50 ? ' (first 50 shown)' : ''} · ${Math.round(ms)}ms round trip`;

  mount.replaceChildren(el, meta);
}

$('#sql-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sql = $('#sql').value.trim();
  if (!sql || !session) return;

  const btn = $('#run');
  btn.disabled = true;
  const t0 = performance.now();
  try {
    const table = await session.conn.query(sql);
    const ms = performance.now() - t0;
    renderResult(table, ms);
    wire.pulse(ms);
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'result-error';
    p.textContent = String(err?.message ?? err);
    $('#result').replaceChildren(p);
  } finally {
    btn.disabled = false;
  }
});

$('#sql').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('#sql-form').requestSubmit();
});

// --- boot ------------------------------------------------------------------

renderLaptopCommand();
setStatus('idle', 'no route');

// A ticket can also arrive in the fragment, which never leaves the browser --
// it is not sent to GitHub's servers and does not appear in their logs. That
// makes `#qh1_...` a reasonable way to hand someone a working link.
// decodeURIComponent throws on a truncated escape, and a shared link is
// exactly the thing that arrives mangled. A bad fragment should leave the page
// usable, not abort the last statement of the boot sequence.
let fragment = '';
try {
  fragment = decodeURIComponent(location.hash.slice(1));
} catch {
  fragment = location.hash.slice(1);
}
if (fragment.startsWith('qh1_')) {
  $('#ticket').value = fragment;
  $('#paste-form').requestSubmit();
}
