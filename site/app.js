// The workbench.
//
// A DuckDB-Wasm session that boots on arrival and is useful immediately, plus a
// list of remote DuckDBs attached into it over iroh. Adding a remote is a
// dialog, not a page: it is a task you finish once, and after that the page is
// a notebook.
//
// The transport is unmodified `web/` -- the same shim, bridge and wasm client
// anyone would vendor into their own app. If this page works, that does too,
// because they are the same files.
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
  const n = connections.filter((c) => c.kind === 'remote').length;
  if (n === 0) setStatus('local', 'local only');
  else setStatus('live', `${n} remote${n === 1 ? '' : 's'} · relay`);
}

const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;

/// Read a ticket, using the transport's own decoder.
///
/// Imported at runtime rather than bundled: `web/` is copied in verbatim, and
/// this is the page reaching into the client it ships rather than keeping a
/// second copy of it. The address, the secret name and the ticket format are
/// all the extension's, so there is nothing here for them to drift against.
const decodeTicket = async (input) => {
  const { parseTicket } = await import(/* @vite-ignore */ asset('peer.js'));
  return parseTicket(input);
};

// --- what to run on the other machine ---------------------------------------

// A token minted here rather than by the script, so the by-hand path has one to
// paste. The script generates its own.
const manualToken = (() => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
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

  $('#cmd-serve').querySelector('code').textContent = `curl -fsSL ${scriptUrl} | sh`;
  $('#cmd-serve-2').querySelector('code').textContent =
    `curl -fsSL ${scriptUrl} -o quackhole-demo.sh\nsh quackhole-demo.sh`;

  if (platform === 'windows') {
    $('#cmd-os').textContent = 'windows — use wsl or git bash';
  } else {
    $('#cmd-os').textContent = platform === 'macos' ? 'macos — terminal' : 'linux — shell';
  }

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

// Named per session so two tabs do not update each other's peer map. The bridge
// joins the same channel and answers peer registrations on it.
const CHANNEL = `qh-${crypto.randomUUID()}`;
const channel = new BroadcastChannel(CHANNEL);

let session = null;

/// Register a peer's relay with the bridge, and wait for it to say so.
///
/// The ATTACH that follows travels a different path -- DuckDB worker, shim,
/// SharedArrayBuffer -- so without waiting for the ack the dial can overtake the
/// registration and be made on whatever relay the bridge had before.
function registerPeer(endpointId, relayUrl) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.removeEventListener('message', onAck);
      reject(new Error('The transport bridge did not acknowledge the relay. Reload and try again.'));
    }, 10_000);
    function onAck(e) {
      if (e.data?.__qh !== 'peer-ack' || e.data.endpointId !== endpointId) return;
      clearTimeout(timer);
      channel.removeEventListener('message', onAck);
      resolve();
    }
    channel.addEventListener('message', onAck);
    channel.postMessage({ __qh: 'peer', endpointId, relay: relayUrl });
  });
}

async function bootLocal() {
  setStatus('booting', 'booting duckdb');
  const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);

  // qh-worker installs the XHR shim into the worker global and only then loads
  // duckdb's own worker bundle, so duckdb is entirely unmodified underneath.
  // No `relay=` here: relays are per-peer now and arrive over the channel.
  const workerUrl =
    `${asset('qh-worker.js')}?target=${encodeURIComponent(bundle.mainWorker)}` +
    `&mode=iroh&channel=${encodeURIComponent(CHANNEL)}`;

  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  await conn.query('INSTALL quack');
  await conn.query('LOAD quack');

  session = { conn, db, worker };
  setRestingStatus();
}

// --- connections -------------------------------------------------------------

// The local wasm database is a connection like any other, and listing it first
// is what makes "add remote" read as adding a second one rather than as the
// page's real beginning.
const connections = [{ name: 'memory', kind: 'local', detail: 'duckdb-wasm, this tab' }];

/// The catalog name a remote gets attached as.
///
/// Auto-named rather than asked for, because the link from `quackhole_serve`
/// carries no name and a dialog that demands one before it will connect is a
/// worse first minute than a second remote called `laptop2`. It is a DuckDB
/// identifier and it is interpolated unquoted into SQL below, so nothing but
/// this function may produce one.
function uniqueName(base) {
  const taken = new Set(connections.map((c) => c.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

function renderConnections() {
  const list = $('#conn-list');
  list.replaceChildren();
  for (const c of connections) {
    const li = document.createElement('li');
    li.className = 'conn';
    li.dataset.kind = c.kind;
    li.innerHTML = `<span class="conn-name"></span><span class="conn-detail"></span>`;
    li.querySelector('.conn-name').textContent = c.name;
    li.querySelector('.conn-detail').textContent = c.detail;
    // Only remotes can be removed. Without this a remote whose laptop has gone
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

/// List the tables in every connection.
///
/// Local and remote need different queries. A Quack-attached catalog is lazy --
/// it resolves a table name on demand but enumerates nothing, so
/// `duckdb_tables()`, `SHOW TABLES FROM laptop` and `information_schema` are all
/// empty for it. `sqlite_master` is the one listing Quack pushes down to the
/// remote DuckDB, which answers it from its own catalog.
async function tablesIn(conn) {
  const sql =
    conn.kind === 'local'
      ? `SELECT table_name AS name FROM duckdb_tables() ORDER BY name`
      : `SELECT name FROM ${conn.name}.sqlite_master ORDER BY name`;
  try {
    return rowsOf(await session.conn.query(sql)).map((r) => r.name);
  } catch {
    return null;
  }
}

/// Drop remotes that are no longer attached.
///
/// The rail is a claim about what this session holds, and a visitor can type
/// `DETACH laptop2` into a cell and make it false. duckdb_databases() is the
/// only thing that knows -- and it answers locally, with no round trip, so
/// reconciling against it costs nothing.
async function syncConnections() {
  let live;
  try {
    const rows = rowsOf(await session.conn.query('SELECT database_name FROM duckdb_databases()'));
    live = new Set(rows.map((r) => r.database_name));
  } catch {
    return;
  }
  for (const c of [...connections]) {
    if (c.kind !== 'remote' || live.has(c.name)) continue;
    connections.splice(connections.indexOf(c), 1);
    c.el?.remove();
  }
  if (!$('#wire-list').children.length) $('#wire-panel').hidden = true;
  renderConnections();
  setRestingStatus();
}

/// Redraw the table rail, and hand back what it found.
///
/// Returning the listing is what keeps a newly attached remote to one metadata
/// round trip: the rail needs its tables and so does the seed below, and asking
/// twice would put a second relay round trip in front of the first result.
async function refreshSchema() {
  await syncConnections();
  const list = $('#schema-list');
  const groups = await Promise.all(connections.map(async (c) => [c, await tablesIn(c)]));

  list.replaceChildren();
  let any = false;
  for (const [conn, names] of groups) {
    if (!names || names.length === 0) continue;
    any = true;
    for (const name of names) {
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
  return new Map(groups.map(([c, names]) => [c.name, names ?? []]));
}

// --- remotes -----------------------------------------------------------------

/// Draw this remote's own route in the rail.
///
/// One wire per remote rather than one wire with several ends: each remote is
/// reached through its own relay, and they are not the same relay. A single
/// diagram would have to pick one to name.
function addWire(conn) {
  const li = $('#wire-tpl').content.firstElementChild.cloneNode(true);
  li.dataset.name = conn.name;
  li.querySelector('.wire-peer-name').textContent = conn.name;
  // Appended before createWire, which resolves the relay legend by walking up
  // to .wire-frame -- cheap to get wrong, and it fails by silently leaving the
  // placeholder in place.
  $('#wire-list').append(li);
  $('#wire-panel').hidden = false;

  const w = createWire(li.querySelector('.wire-mount'), conn.name);
  w.setRelayLabel(conn.relayUrl);
  w.setState('connecting');
  return { wire: w, el: li };
}

/// Attach a remote described by a ticket, into the session that already exists.
async function addRemote(peer) {
  const { endpointId, relayUrl, token } = peer;

  // Attaching the same laptop twice would work and would be a lie: two catalog
  // names over one connection, listed as if they were two machines.
  const already = connections.find((c) => c.endpointId === endpointId);
  if (already) throw new Error(`That laptop is already attached, as "${already.name}".`);

  const conn = {
    name: uniqueName('laptop'),
    // Named after the peer, not after the catalog: that is the name the
    // extension prints too, so the two sides of the demo spell one thing once.
    secretName: peer.secretName,
    kind: 'remote',
    endpointId,
    relayUrl,
    detail: `${endpointId.slice(0, 8)}… via relay`,
  };

  setStatus('connecting', 'dialling');
  Object.assign(conn, addWire(conn));

  try {
    await registerPeer(endpointId, relayUrl);

    // Named and scoped to this one endpoint. An unnamed secret is a single
    // global, so the second remote would either collide on the name or quietly
    // hand the first remote's token to a different machine. Quack resolves the
    // secret by the ATTACH path, so the scope is what routes the right token to
    // the right laptop -- a secret scoped elsewhere is not found at all.
    //
    // Both strings come off the peer, which is what makes them the same string:
    // a scope that disagrees with the ATTACH path by one character fails as
    // "Could not find a Quack authentication token".
    if (token) {
      await session.conn.query(
        `CREATE SECRET ${conn.secretName} (TYPE quack, TOKEN ${sqlString(token)}, SCOPE ${sqlString(peer.address)})`,
      );
    }
    const t0 = performance.now();
    await session.conn.query(`ATTACH ${sqlString(peer.address)} AS ${conn.name}`);
    conn.attachMs = performance.now() - t0;
  } catch (err) {
    conn.wire.setState('failed');
    conn.el.remove();
    if (!$('#wire-list').children.length) $('#wire-panel').hidden = true;
    await session.conn.query(`DROP SECRET IF EXISTS ${conn.secretName}`).catch(() => {});
    throw err;
  }

  connections.push(conn);
  renderConnections();
  conn.wire.setState('live');
  setRestingStatus();
  return conn;
}

/// Detach a remote and give its name back.
///
/// The secret goes with it, so re-attaching the same laptop later works --
/// otherwise its `CREATE SECRET` would collide with the one left behind.
///
/// The rail is not edited here: refreshSchema reconciles it against
/// duckdb_databases(), which is the same path a hand-typed DETACH takes. Two
/// ways to remove a connection would be two things to keep agreeing.
async function dropRemote(conn) {
  // If the DETACH fails, the catalog really is still attached and the rail
  // should keep saying so -- which is better feedback than an exception nobody
  // sees.
  await session.conn.query(`DETACH ${conn.name}`).catch(() => {});
  await session.conn.query(`DROP SECRET IF EXISTS ${conn.secretName}`).catch(() => {});
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
      const table = await session.conn.query(text);
      const ms = performance.now() - t0;
      renderResult(art.querySelector('.cell-out'), table, ms);
      art.dataset.state = 'ok';
      art.querySelector('.cell-ms').textContent = `${Math.round(ms)}ms`;
      // Which wire to pulse, decided by reading the SQL: duckdb-wasm does not
      // report which catalogs a query touched, and with several remotes
      // attached, pulsing all of them would claim traffic that never happened.
      // A qualified reference is the only way to reach a remote, so `laptop.`
      // in the text is the signal. Names come from uniqueName(), so there is
      // nothing to escape.
      for (const c of connections) {
        if (c.kind === 'remote' && new RegExp(`\\b${c.name}\\s*\\.`, 'i').test(text)) c.wire.pulse(ms);
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
  if (connections.some((c) => c.kind === 'remote')) {
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
    const conn = await addRemote(await decodeTicket($('#ticket').value));
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
    if (connections.some((c) => c.kind === 'remote')) setRestingStatus();
    else setStatus('failed', 'no route');
    showError(String(err?.message ?? err));
  } finally {
    btn.disabled = false;
  }
});

/// Fill the notebook from what the remote actually has.
///
/// The first thing a visitor should see is their own data, not an empty box --
/// but only the demo script's laptop is known to have `laptop_info` and
/// `events`. A second remote is somebody's real database, and opening it on two
/// cells that guessed wrong is worse than opening it on one that guessed
/// nothing. So the listing the rail needs anyway decides what to run.
async function seedFor(conn) {
  const tables = (await refreshSchema()).get(conn.name) ?? [];
  const n = conn.name;

  const cells = [];
  if (tables.includes('laptop_info')) cells.push(`SELECT host, os, duckdb_version FROM ${n}.laptop_info`);
  if (tables.includes('events')) cells.push(`SELECT level, count(*) AS n FROM ${n}.events GROUP BY level ORDER BY n DESC`);
  if (cells.length === 0 && tables.length) cells.push(`SELECT * FROM ${n}.${tables[0]} LIMIT 20`);

  const blank = [...$('#notebook').querySelectorAll('.cell')].filter((c) => !c.querySelector('.cell-sql').value.trim());
  for (const c of blank) c.remove();
  for (const sql of cells) addCell(sql, { run: true });
  addCell('', { focus: false });
}

// --- boot --------------------------------------------------------------------

renderLaptopCommand();
renderConnections();

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
  // Run it rather than leaving it primed: the workbench is useful before any
  // remote exists, and a result on screen says that far better than an empty box.
  addCell("SELECT 'hello from duckdb-wasm' AS msg, version() AS version", { run: true });
  await refreshSchema();
} catch (err) {
  setStatus('failed', 'duckdb failed');
  addCell('', { focus: false });
  const p = document.createElement('p');
  p.className = 'result-error';
  p.textContent = `DuckDB-Wasm did not start: ${err?.message ?? err}`;
  $('#notebook').prepend(p);
}

if (fragment.startsWith('qh1_')) {
  // Arriving from the laptop's link: show the dialog already working rather than
  // showing a form the visitor has no reason to read.
  $('#ticket').value = fragment;
  $('#onboard-title').textContent = 'Connecting to your laptop';
  $('#onboard-lede').textContent = 'The link carried a ticket. Attaching it to this workbench now.';
  onboard.showModal();
  $('#paste-form').requestSubmit();
} else if (session) {
  onboard.showModal();
}
