// The workbench.
//
// A DuckDB-Wasm session that boots on arrival and is useful immediately, plus a
// list of remote DuckDBs attached into it over iroh. Adding a remote is a
// dialog, not a page: it is a task you finish once, and after that the page is
// a notebook.
//
// This file is a view and nothing else. The connection model -- attaching,
// detaching, listing, and keeping the list honest against what DuckDB actually
// holds -- is `QuackholeSession` in unmodified `web/`, alongside the shim, the
// bridge and the wasm client. If this page works, what anyone would vendor
// works, because they are the same files. That claim used to be true of the
// transport and false of everything above it.
import * as duckdb from '@duckdb/duckdb-wasm';
import { createWire } from './wire.js';

const $ = (sel) => document.querySelector(sel);

// Every asset is resolved against <base>, because this is served from a project
// Pages site under /quackhole/ where a leading slash means github.io itself.
const asset = (path) => new URL(path, document.baseURI).href;

const statusEl = $('#status');
const statusText = $('#status-text');

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
}

// The pill's resting state, recomputed rather than set at each call site: with
// more than one remote, "live" is a property of the list, not of whichever
// attach happened last.
function setRestingStatus() {
  const n = session ? session.connections.filter((c) => c.kind === 'remote').length : 0;
  if (n === 0) setStatus('local', 'local only');
  else setStatus('live', `${n} remote${n === 1 ? '' : 's'} · relay`);
}

/// The shipped client, imported at runtime rather than bundled.
///
/// `web/` is copied into the site verbatim, so this is the page reaching into
/// the thing it ships rather than keeping a second copy of it.
const { QuackholeSession } = await import(/* @vite-ignore */ asset('session.js'));
// Same reach, for the same reason: the ticket format belongs to the crate, so
// naming a peer on screen has to go through the binding rather than a second
// decoder written here that would drift the first time the format moves.
const { parseTicket } = await import(/* @vite-ignore */ asset('peer.js'));

// --- what to run on the other machine ---------------------------------------

// A token minted here rather than by the CLI, so the by-hand path has one to
// paste. `npx quackhole` generates its own.
const manualToken = (() => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
})();

// `npx quackhole` is the same command on every platform, so it is written out
// in index.html rather than built here. This is only the by-hand path, which
// needs a token minted in this tab.
function renderManualCommand() {
  $('#cmd-manual').querySelector('code').textContent = [
    'INSTALL quack; LOAD quack;',
    "LOAD './quackhole.duckdb_extension';",
    '',
    '-- serve waits for the endpoint to learn its home relay, then returns the',
    '-- link to open. No ticket to assemble by hand.',
    `SELECT url FROM quackhole_serve(token := '${manualToken}');`,
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
    setTimeout(() => {
      btn.textContent = was;
    }, 1200);
  });
}

// --- the local session -------------------------------------------------------

const DUCKDB_BUNDLES = {
  mvp: { mainModule: asset('duckdb/duckdb-mvp.wasm'), mainWorker: asset('duckdb/duckdb-browser-mvp.worker.js') },
  eh: { mainModule: asset('duckdb/duckdb-eh.wasm'), mainWorker: asset('duckdb/duckdb-browser-eh.worker.js') },
};

let session = null;

async function bootLocal() {
  setStatus('booting', 'booting duckdb');
  const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);

  // qh-worker installs the XHR shim into the worker global and only then loads
  // duckdb's own worker bundle, so duckdb is entirely unmodified underneath.
  // No `relay=` here: relays are per-peer, and each arrives with its remote.
  const workerUrl = `${asset('qh-worker.js')}?target=${encodeURIComponent(bundle.mainWorker)}&mode=iroh`;

  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  await conn.query('INSTALL quack');
  await conn.query('LOAD quack');

  // Booting is the app's half -- which bundle, which logger, where the .wasm
  // is served from. Everything after it is the session's.
  session = new QuackholeSession({ conn, worker });
  setRestingStatus();
}

// --- connections -------------------------------------------------------------

// Per-remote view state, keyed by catalog name. Deliberately beside the
// session's records rather than hung off them: the session's list is the model,
// and everything drawn is derived from it -- which is what makes a hand-typed
// DETACH remove a wire without anything having to notice the DETACH.
const views = new Map();

function renderConnections() {
  const list = $('#conn-list');
  list.replaceChildren();
  for (const c of session.connections) {
    const li = document.createElement('li');
    li.className = 'conn';
    li.dataset.kind = c.kind;
    li.innerHTML = `<span class="conn-name"></span><span class="conn-detail"></span>`;
    li.querySelector('.conn-name').textContent = c.name;
    li.querySelector('.conn-detail').textContent =
      c.kind === 'local' ? 'duckdb-wasm, this tab' : `${c.endpointId.slice(0, 8)}… via relay`;
    // Only remotes can be removed. Without this a remote whose host has gone
    // away stays in the rail forever, and its name stays taken.
    if (c.kind === 'remote') {
      const x = document.createElement('button');
      x.className = 'conn-x';
      x.type = 'button';
      x.textContent = '×';
      x.title = `Detach ${c.name}`;
      x.setAttribute('aria-label', `Detach ${c.name}`);
      x.addEventListener('click', () => dropRemote(c));
      li.append(x);
    }
    list.append(li);
  }
}

/// Draw one route per remote, and remove any whose remote has gone.
///
/// One wire per remote rather than one wire with several ends: each is reached
/// through its own relay, and they are not the same relay. A single diagram
/// would have to pick one to name.
///
/// Derived from the session's list rather than edited alongside it, so there is
/// no second place that has to be told a connection went away.
function syncWires() {
  for (const [name, view] of views) {
    if (session.connections.some((c) => c.name === name)) continue;
    view.el.remove();
    views.delete(name);
  }
  $('#wire-panel').hidden = views.size === 0;
}

function addWire(conn) {
  const li = $('#wire-tpl').content.firstElementChild.cloneNode(true);
  li.dataset.name = conn.name;
  li.querySelector('.wire-peer-name').textContent = conn.name;
  // Appended before createWire, which resolves the relay legend by walking up
  // to .wire-frame -- cheap to get wrong, and it fails by silently leaving the
  // placeholder in place.
  $('#wire-list').append(li);
  $('#wire-panel').hidden = false;

  const wire = createWire(li.querySelector('.wire-mount'), conn.name);
  wire.setRelayLabel(conn.relayUrl);
  wire.setState('connecting');
  const view = { wire, el: li };
  views.set(conn.name, view);
  return view;
}

/// Redraw everything the session's state decides, and hand back its tables.
///
/// Returning the listing is what keeps a newly attached remote to one metadata
/// round trip: the rail needs its tables and so does the seed below, and asking
/// twice would put a second relay round trip in front of the first result.
async function refreshSchema() {
  // Reconciles against duckdb_databases() on the way, so a remote detached by
  // hand is already gone from the list by the time anything is drawn from it.
  const groups = await session.tables();
  syncWires();
  renderConnections();
  setRestingStatus();

  const list = $('#schema-list');
  list.replaceChildren();
  let any = false;
  for (const conn of session.connections) {
    for (const name of groups.get(conn.name) ?? []) {
      any = true;
      const qualified = `${conn.name}.${name}`;
      const li = document.createElement('li');
      li.innerHTML = `<button class="schema-item" type="button"></button>`;
      li.querySelector('button').textContent = qualified;
      // Clicking a table writes a query rather than running one: the point is to
      // start you off, not to decide what you wanted.
      li.querySelector('button').addEventListener('click', () => {
        addCell(`SELECT * FROM ${qualified} LIMIT 20`, { run: true });
      });
      list.append(li);
    }
  }
  if (!any) list.innerHTML = '<li class="schema-empty">no tables yet</li>';
  return groups;
}

// --- remotes -----------------------------------------------------------------

/// Attach a remote described by a ticket, and draw its route while it dials.
///
/// The route goes up on onDialing rather than on the result, because the dial
/// is the second the visitor is waiting through -- drawing it afterwards would
/// show the connection only once there was nothing left to watch.
async function addRemote(ticket) {
  setStatus('connecting', 'dialling');
  let drawn = null;
  try {
    const conn = await session.attach(ticket, { onDialing: (record) => (drawn = addWire(record)) });
    drawn.wire.setState('live');
    renderConnections();
    setRestingStatus();
    return conn;
  } catch (err) {
    // A route for a remote that is not attached would be a claim the session
    // cannot back, and the session did not keep the record -- so deriving the
    // routes from it again is all the cleanup there is. Nothing is drawn at all
    // when the ticket itself is the problem, which is the common case and would
    // otherwise flicker.
    syncWires();
    throw err;
  }
}

/// Detach a remote and give its name back.
///
/// Nothing is removed from the rail here: refreshSchema redraws it from the
/// session, which reconciles against duckdb_databases() -- the same path a
/// hand-typed DETACH takes. Two ways to remove a connection would be two things
/// to keep agreeing.
async function dropRemote(conn) {
  await session.detach(conn);
  await refreshSchema();
}

// --- results -----------------------------------------------------------------

// Arrow hands timestamps back as epoch millis and integers as BigInt, and JSON
// cannot carry either -- so `ts` renders as 1788058053144.624 unless the
// column's declared type is consulted. Formatting is per field, not per value:
// the JS value alone cannot tell a timestamp from a large number.
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

function renderResult(mount, table, ms) {
  const rows = rowsOf(table);
  const cols = table.schema.fields.map((f) => f.name);

  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'result-meta';
    p.textContent = `No rows · ${Math.round(ms)}ms`;
    mount.replaceChildren(p);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'result';
  const el = document.createElement('table');
  const head = el.insertRow();
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c;
    head.append(th);
  }
  // Enough to see the shape without turning this into a grid widget.
  for (const r of rows.slice(0, 200)) {
    const tr = el.insertRow();
    for (const c of cols) {
      const td = tr.insertCell();
      td.textContent = r[c] === null ? '—' : String(r[c]);
    }
  }
  wrap.append(el);

  const meta = document.createElement('p');
  meta.className = 'result-meta';
  meta.textContent =
    `${rows.length} row${rows.length === 1 ? '' : 's'}` +
    `${rows.length > 200 ? ' (first 200 shown)' : ''} · ${Math.round(ms)}ms round trip`;

  mount.replaceChildren(wrap, meta);
}

// --- the notebook ------------------------------------------------------------

let cellSeq = 0;

function addCell(sql = '', { run = false, focus = false } = {}) {
  const n = ++cellSeq;
  const art = document.createElement('article');
  art.className = 'cell';
  art.dataset.state = 'idle';
  art.innerHTML = `
    <div class="cell-head">
      <span class="cell-n">[${n}]</span>
      <span class="cell-ms"></span>
      <button class="cell-run" type="button">run</button>
      <button class="cell-del" type="button" aria-label="Remove cell">×</button>
    </div>
    <textarea class="cell-sql" spellcheck="false" rows="1"></textarea>
    <div class="cell-out"></div>`;

  const ta = art.querySelector('.cell-sql');
  ta.value = sql;

  // Grow with the query. A notebook where long SQL scrolls inside a 3-row box
  // is a worse text editor than the one it is imitating.
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 56)}px`;
  };
  ta.addEventListener('input', autosize);

  const runCell = async () => {
    const text = ta.value.trim();
    if (!text || !session) return;
    art.dataset.state = 'running';
    art.querySelector('.cell-ms').textContent = 'running…';
    const t0 = performance.now();
    try {
      const table = await session.query(text);
      const ms = performance.now() - t0;
      renderResult(art.querySelector('.cell-out'), table, ms);
      art.dataset.state = 'ok';
      art.querySelector('.cell-ms').textContent = `${Math.round(ms)}ms`;
      // Which wire to pulse, decided by reading the SQL: duckdb-wasm does not
      // report which catalogs a query touched, and with several remotes
      // attached, pulsing all of them would claim traffic that never happened.
      // A qualified reference is the only way to reach a remote, so `remote.`
      // in the text is the signal. The session uniquifies names from a fixed
      // base, so there is nothing to escape.
      for (const c of session.connections) {
        if (c.kind === 'remote' && new RegExp(`\\b${c.name}\\s*\\.`, 'i').test(text)) {
          views.get(c.name)?.wire.pulse(ms);
        }
      }
      // DDL in a cell changes what the rail should show.
      if (/^\s*(create|drop|attach|detach|alter)\b/i.test(text)) refreshSchema();
    } catch (err) {
      const p = document.createElement('p');
      p.className = 'result-error';
      p.textContent = String(err?.message ?? err);
      art.querySelector('.cell-out').replaceChildren(p);
      art.dataset.state = 'failed';
      art.querySelector('.cell-ms').textContent = 'failed';
    }
  };

  art.querySelector('.cell-run').addEventListener('click', runCell);
  art.querySelector('.cell-del').addEventListener('click', () => {
    art.remove();
    if (!$('#notebook').querySelector('.cell')) addCell('', { focus: true });
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runCell();
    }
  });

  $('#notebook').append(art);
  autosize();
  if (focus) ta.focus();
  if (run) runCell();
  return art;
}

// --- dialogs -----------------------------------------------------------------

const onboard = $('#onboard');
const pasteError = $('#paste-error');
const pasteNote = $('#paste-note');

function showError(msg) {
  pasteError.textContent = msg;
  pasteError.hidden = false;
}

$('#add-remote').addEventListener('click', () => {
  pasteError.hidden = true;
  pasteNote.hidden = true;
  $('#ticket').value = '';
  // The second time through, the dialog is not onboarding any more -- the
  // visitor has done this once and needs the command and the field, not the
  // explanation of what they are about to do.
  if (session?.connections.some((c) => c.kind === 'remote')) {
    $('#onboard-title').textContent = 'Add another remote';
    $('#onboard-lede').textContent =
      'Run this on the next machine. Each remote is attached under its own name and reached over its own relay.';
  }
  onboard.showModal();
});
$('#open-notes').addEventListener('click', () => $('#notes').showModal());

$('#paste-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  pasteError.hidden = true;
  pasteNote.hidden = true;

  const btn = $('#paste-go');
  btn.disabled = true;
  try {
    const conn = await addRemote($('#ticket').value);
    pasteNote.textContent =
      `Attached in ${Math.round(conn.attachMs)}ms as "${conn.name}".` +
      ' That is three round trips through the relay.';
    pasteNote.hidden = false;
    onboard.close();
    seedFor(conn);
  } catch (err) {
    // Leave the dialog open: the error is about the ticket, and the field it
    // refers to is in here. The pill only goes red when nothing is attached --
    // a failed second remote does not make the first one stop working.
    if (session?.connections.some((c) => c.kind === 'remote')) setRestingStatus();
    else setStatus('failed', 'no route');
    showError(String(err?.message ?? err));
  } finally {
    btn.disabled = false;
  }
});

/// Offer a ticket that arrived in the link, instead of acting on it.
///
/// Attaching grants this tab query access to somebody else's machine, so the
/// visitor sees whose before anything dials. Parsing up front is also what
/// makes a mangled link explain itself: a truncated fragment fails here, next
/// to a field that can hold it, rather than three round trips into an attach.
async function offerConnect(ticket) {
  const dialog = $('#connect');
  const error = $('#connect-error');
  const note = $('#connect-note');

  let peer;
  try {
    peer = await parseTicket(ticket);
  } catch (err) {
    // Nothing to offer, so fall back to the form that can take a fresh one --
    // with the ticket still in the field, since it is what needs correcting.
    $('#ticket').value = ticket;
    showError(String(err?.message ?? err));
    onboard.showModal();
    return;
  }

  $('#connect-id').textContent = peer.endpointId;
  $('#connect-relay').textContent = new URL(peer.relayUrl).host;
  dialog.showModal();

  $('#connect-no').addEventListener('click', () => dialog.close(), { once: true });

  $('#connect-go').addEventListener('click', async () => {
    const btn = $('#connect-go');
    btn.disabled = true;
    error.hidden = true;
    try {
      const conn = await addRemote(ticket);
      note.textContent =
        `Attached in ${Math.round(conn.attachMs)}ms as "${conn.name}".` +
        ' That is three round trips through the relay.';
      note.hidden = false;
      dialog.close();
      seedFor(conn);
    } catch (err) {
      // Same reasoning as the paste form: the dialog stays open because the
      // thing that failed is the ticket this dialog is about.
      setStatus('failed', 'no route');
      error.textContent = String(err?.message ?? err);
      error.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

/// Fill the notebook from what the remote actually has.
///
/// The first thing a visitor should see is their own data, not an empty box --
/// but only the demo script's host is known to have `host_info` and `events`. A
/// second remote is somebody's real database, and opening it on two cells that
/// guessed wrong is worse than opening it on one that guessed nothing. So the
/// listing the rail needs anyway decides what to run.
///
/// Both spellings of the info table are accepted because the page and the npm
/// package deploy on different clocks: this site ships on a push to main, the
/// CLI on a release tag, and `npx` resolves a pinned version. Until the release
/// after the rename has spread, a visitor can arrive from either one.
async function seedFor(conn) {
  const tables = (await refreshSchema()).get(conn.name) ?? [];
  const n = conn.name;

  const cells = [];
  const info = ['host_info', 'laptop_info'].find((t) => tables.includes(t));
  if (info) cells.push(`SELECT host, os, duckdb_version FROM ${n}.${info}`);
  if (tables.includes('events')) cells.push(`SELECT level, count(*) AS n FROM ${n}.events GROUP BY level ORDER BY n DESC`);
  if (cells.length === 0 && tables.length) cells.push(`SELECT * FROM ${n}.${tables[0]} LIMIT 20`);

  const blank = [...$('#notebook').querySelectorAll('.cell')].filter((c) => !c.querySelector('.cell-sql').value.trim());
  for (const c of blank) c.remove();
  for (const sql of cells) addCell(sql, { run: true });
  addCell('', { focus: false });
}

// --- boot --------------------------------------------------------------------

renderManualCommand();

// A ticket can arrive in the fragment, which never leaves the browser -- it is
// not sent to GitHub's servers and does not appear in their logs. That is what
// makes the link quackhole_serve() returns safe to click.
// decodeURIComponent throws on a truncated escape, and a shared link is exactly
// the thing that arrives mangled, so a bad fragment must leave the page usable.
let fragment = '';
try {
  fragment = decodeURIComponent(location.hash.slice(1));
} catch {
  fragment = location.hash.slice(1);
}

try {
  await bootLocal();
  // Uncovered only once there is something under it worth looking at.
  $('#boot').hidden = true;
  // Run it rather than leaving it primed: the workbench is useful before any
  // remote exists, and a result on screen says that far better than an empty box.
  addCell("SELECT 'hello from duckdb-wasm' AS msg, version() AS version", { run: true });
  await refreshSchema();
} catch (err) {
  setStatus('failed', 'duckdb failed');
  // The overlay stays up and turns into the error. Dismissing it would reveal a
  // workbench with no database behind it, where every cell fails one at a time.
  $('#boot').dataset.state = 'failed';
  $('#boot-title').textContent = 'DuckDB did not start';
  $('#boot-detail').textContent = String(err?.message ?? err);
  addCell('', { focus: false });
  const p = document.createElement('p');
  p.className = 'result-error';
  p.textContent = `DuckDB-Wasm did not start: ${err?.message ?? err}`;
  $('#notebook').prepend(p);
}

if (fragment.startsWith('qh1_')) {
  // Arriving from the link the server printed: ask about this one peer, rather than
  // opening the setup story the visitor has already been through.
  await offerConnect(fragment);
} else if (session) {
  onboard.showModal();
}
