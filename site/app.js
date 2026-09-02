// The workbench.
//
// A DuckDB-Wasm session that boots on arrival and is useful immediately, plus a
// list of remote DuckDBs attached into it over iroh. Adding a remote is a
// dialog, not a page: it is a task you finish once, and after that the page is
// duckdb's own web shell.
//
// This file is a view and nothing else. The connection model -- attaching,
// detaching, listing, and keeping the list honest against what DuckDB actually
// holds -- is `QuackholeSession` in unmodified `web/`, alongside the shim, the
// bridge and the wasm client. If this page works, what anyone would vendor
// works, because they are the same files. That claim used to be true of the
// transport and false of everything above it.
//
// The query surface is the third thing here that is somebody else's,
// unmodified: `@duckdb/duckdb-wasm-shell` is duckdb's own embeddable web shell,
// handed this session's database through the one hook it offers. It knows
// nothing about iroh, and that is the point -- a query box of our own could
// always be accused of knowing where the bytes came from, and this one cannot,
// because it was written before any of this existed.
//
// Not to be confused with what runs at shell.duckdb.org, which has since moved
// to a frontend of its own on @xterm/xterm. This package is still published out
// of duckdb/duckdb-wasm and still versioned in lockstep with duckdb-wasm --
// same version string, same day -- which is what makes it safe to pin beside
// it. If that ever stops being true, this is the thing to check.
import * as duckdb from '@duckdb/duckdb-wasm';
import * as shell from '@duckdb/duckdb-wasm-shell';
import { createWire } from './wire.js';

// xterm draws the terminal, and the shell package does not carry its
// stylesheet. Pinned in package.json for this one file: the shell depends on
// xterm 5, and @xterm/xterm -- the package that superseded it -- ships a
// different stylesheet for a different major.
import 'xterm/css/xterm.css';

// The shell's other half. Fetched at runtime rather than bundled -- it is wasm,
// and the only thing this page needs is where it landed. Content-hashed, which
// nothing here objects to: `web/` is copied verbatim because its files reach
// their siblings by relative path at runtime and a hash would break that, but
// this one is fetched from an href computed right here.
import shellModule from '@duckdb/duckdb-wasm-shell/dist/shell_bg.wasm?url';

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

// --- what to do about an error -----------------------------------------------

// Known failures, matched against the raw message and paired with the one line
// that unsticks them. The raw text stays on screen -- it is what a search or a
// bug report needs -- and the remedy is view furniture, which is why this map
// lives here rather than in the session. docs/TROUBLESHOOTING.md is the long
// form, keyed by the same strings.
const REMEDIES = [
  [
    /could not find a quack authentication token/i,
    'A hand-written secret has to be named and scoped to the exact ATTACH address. "+ add remote" builds it that way from the ticket.',
  ],
  [
    /unauthori[sz]ed|\b401\b/i,
    'The server rejected the token. A second server on one machine reuses Quack on port 9494 and prints a token the first never issued — restart it with --port 9495 and use its new link.',
  ],
  [
    /timed? ?out/i,
    'The machine may have stopped serving, or this ticket predates its current run. Ask for a fresh link.',
  ],
  [
    /sharedarraybuffer|cross-?origin/i,
    'The page is not cross-origin isolated, which the transport needs. Serving this page yourself? Send the COOP/COEP headers, or put coi-serviceworker.js at your root.',
  ],
];

const TROUBLESHOOTING = 'https://github.com/smithclay/quackhole/blob/main/docs/TROUBLESHOOTING.md';

/// The remedy for a raw message, or null.
///
/// Split out because there are now two surfaces that show one and they take it
/// differently: a DOM node gets an element, and the shell's terminal gets text
/// or nothing. One reader of REMEDIES is what keeps them saying the same thing.
const remedyFor = (msg) => REMEDIES.find(([re]) => re.test(msg))?.[1] ?? null;

/// Show an error with its remedy, when the message is one the map knows.
///
/// `fallback` is for a call site that knows what failed better than the message
/// says -- a ticket that would not parse is a copying problem whatever words
/// the parser chose.
function renderError(el, err, fallback = null) {
  const msg = String(err?.message ?? err);
  el.replaceChildren(document.createTextNode(msg));
  const remedy = remedyFor(msg) ?? fallback;
  if (remedy) {
    const hint = document.createElement('span');
    hint.className = 'error-hint';
    hint.append(`${remedy} `);
    const a = document.createElement('a');
    a.href = TROUBLESHOOTING;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = 'troubleshooting →';
    hint.append(a);
    el.append(hint);
  }
  el.hidden = false;
}

/// The same remedy, folded into the error itself.
///
/// For failures that surface in the shell, which writes an error's message to
/// its terminal and gives nobody a place to hang anything beside it. Returned
/// as a new Error rather than mutated, because the error came out of duckdb-wasm
/// and rewriting its message would change what the caller that catches it next
/// sees. CRLF because this lands in a raw terminal write: a bare newline moves
/// down without returning, and the remedy would stagger off the right edge.
function withRemedy(err) {
  const msg = String(err?.message ?? err);
  const remedy = remedyFor(msg);
  return remedy ? new Error(`${msg}\r\n\r\n${remedy}\r\n${TROUBLESHOOTING}`) : err;
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

// A token minted here rather than by the CLI, so the two ways the dialog offers
// -- the agent prompt and the by-hand SQL -- share a single credential rather
// than inviting the visitor to invent two. `npx quackhole` is not one of them
// and generates its own.
const manualToken = (() => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
})();

// Where the agent is sent to read before it does anything.
//
// Resolved against this page, so a vendored or self-hosted workbench points at
// its own copy -- except on loopback, where it must not. The agent is on
// another machine by construction, and a dev server's URL resolves only on the
// laptop that started it, so testing this flow against a real sandbox would
// hand the agent a link it cannot fetch.
const AGENT_DOCS = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
  ? 'https://smithclay.github.io/quackhole/llms.txt'
  : new URL('llms.txt', document.baseURI).href;

/// The prompt to hand an agent already working on the machine with the data.
///
/// It states the goal, the credential and the handoff, and leaves every step to
/// llms.txt. That is the whole point of the split: an agent told the SQL inline
/// will still be pasting this release's SQL two releases from now, whereas the
/// doc is a thing that gets to be wrong exactly once. Which is also why this
/// prompt names no function, no flag and no install command.
function renderAgentPrompt() {
  $('#cmd-agent').querySelector('code').textContent = [
    "Make this machine's DuckDB reachable from my browser with quackhole.",
    // On its own line: it is the longest thing here and the only part whose
    // length this file does not control, so wrapping around it would re-flow
    // the paragraph every time a self-hosted copy moved.
    `Read ${AGENT_DOCS} first.`,
    '',
    'Then serve the database I would want to query from here — an existing',
    '.duckdb file if there is one, otherwise a fresh one with views over',
    `the data files here — with the token '${manualToken}'.`,
    'Leave it running.',
    '',
    'Reply with the qh1_… ticket and nothing else: it grants query access',
    'to this machine, so keep it out of files, logs and commits.',
  ].join('\n');
}

// The by-hand path, built here rather than written into index.html because it
// carries the token minted in this tab.
function renderManualCommand() {
  $('#cmd-manual').querySelector('code').textContent = [
    'INSTALL quack; LOAD quack;',
    'INSTALL quackhole FROM community;',
    'LOAD quackhole;',
    '',
    '-- serve waits for the endpoint to learn its home relay, then returns the',
    '-- link to open. No ticket to assemble by hand.',
    `SELECT url FROM quackhole_serve(token := '${manualToken}');`,
  ].join('\n');
}

/// Wire a tablist up for the keyboard.
///
/// Automatic activation -- arrowing onto a tab selects it -- because all three
/// panels are already in the DOM and switching costs nothing, which is the case
/// the ARIA practices name it for. Roving tabindex, so Tab moves past the strip
/// to the panel rather than walking three stops through it.
///
/// The markup carries the whole relationship already: aria-controls names the
/// panel, aria-selected says which is showing, and `hidden` on the other two is
/// what does the hiding. This adds behaviour and reads state from there rather
/// than keeping an index of its own.
function initTabs(list) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];

  const select = (tab, { focus = true } = {}) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      // Only the selected tab is a Tab stop. Without this the strip costs three
      // presses to cross, which is the thing roving tabindex exists to stop.
      t.tabIndex = on ? 0 : -1;
      $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
    }
    if (focus) tab.focus();
  };

  list.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) select(tab);
  });

  list.addEventListener('keydown', (e) => {
    const from = tabs.indexOf(document.activeElement);
    if (from < 0) return;
    // Wrapping, because a strip of three has no meaningful end to stop at.
    const to = {
      ArrowRight: (from + 1) % tabs.length,
      ArrowLeft: (from - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[e.key];
    if (to === undefined) return;
    // Home and End scroll the dialog otherwise, which moves the thing being
    // navigated out from under the person navigating it.
    e.preventDefault();
    select(tabs[to]);
  });

  // Whichever the markup marked, so the resting tab is chosen in one place.
  // Not focused: this runs at load, and taking focus would move it off the page.
  select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0], { focus: false });
}

for (const list of document.querySelectorAll('[role="tablist"]')) initTabs(list);

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

// Kept past bootLocal, because the shell reaches the database through them and
// because `.open` typed at its prompt takes the session down -- see `observed`.
let db = null;
let worker = null;

/// A session over a fresh connection, with the transport extension loaded.
///
/// Separate from bootLocal because it happens more than once: `.open` in the
/// shell resets the database, and everything here has to be done again against
/// whatever replaced it.
async function newSession() {
  const conn = await db.connect();
  await conn.query('INSTALL quack');
  await conn.query('LOAD quack');
  return new QuackholeSession({ conn, worker });
}

async function bootLocal() {
  setStatus('booting', 'booting duckdb');
  const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);

  // qh-worker installs the XHR shim into the worker global and only then loads
  // duckdb's own worker bundle, so duckdb is entirely unmodified underneath.
  // No `relay=` here: relays are per-peer, and each arrives with its remote.
  const workerUrl = `${asset('qh-worker.js')}?target=${encodeURIComponent(bundle.mainWorker)}&mode=iroh`;

  worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  // Booting is the app's half -- which bundle, which logger, where the .wasm
  // is served from. Everything after it is the session's.
  session = await newSession();
  setRestingStatus();

  await embedShell();
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
      const btn = li.querySelector('button');
      btn.textContent = qualified;
      // Copied rather than run. The notebook could open a cell on a table; the
      // shell takes its input from the keyboard and publishes no way to put text
      // on its prompt, so this hands the query over and leaves running it to the
      // visitor. Same intent as before -- start them off, do not decide what
      // they wanted.
      btn.title = `Copy a query over ${qualified}`;
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(`SELECT * FROM ${qualified} LIMIT 20;`);
          btn.dataset.copied = '';
          setTimeout(() => delete btn.dataset.copied, 1200);
        } catch {
          // Denied, or the document is not focused. There is nothing to fall
          // back to and nowhere in the rail to put an error, and the table name
          // is still on screen to be typed.
        }
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

// --- the shell --------------------------------------------------------------

/// duckdb's own web shell, embedded over the session's database.
///
/// The whole integration is `resolveDatabase`: the shell asks for a database
/// and does not care where it came from, so the transport can be underneath it
/// without the shell knowing anything about iroh, relays or tickets. That is
/// the same claim `web/` makes one level down -- the files are unmodified, so
/// what runs here is evidence about them rather than a lookalike.
async function embedShell() {
  const mount = $('#shell');
  const style = getComputedStyle(document.documentElement);

  await shell.embed({
    shellModule,
    container: mount,
    // Read off the page rather than restated, so the terminal is not floating
    // in a colour scheme of its own. --term rather than --data on purpose:
    // styles.css says why.
    fontFamily: style.getPropertyValue('--term').trim() || 'monospace',
    backgroundColor: style.getPropertyValue('--ink-2').trim() || '#111',
    resolveDatabase: async () => observed(db),
  });

  // `embed` hands its resize handler back by assigning `container.onresize`,
  // and a <div> never fires a resize event -- so nothing calls it. Without an
  // observer the terminal keeps the width it measured on its first frame, and
  // every result wraps at that width for the rest of the session, including
  // after the rail appears beside it. Invoking the property rather than
  // reaching into the shell keeps this at the handoff point the shell chose.
  new ResizeObserver(() => mount.onresize?.()).observe(mount);
}

/// The database the shell drives: `db`, with the queries it runs observed.
///
/// The shell owns its terminal and offers no hook into it -- `embed` takes a
/// database, a wasm module and two display settings, and that is the whole of
/// it. But it
/// reaches the database through `runQuery`, which is on AsyncDuckDB's published
/// interface, so wrapping that is where the things the notebook used to do
/// around a query still fit: pulse the wire the SQL names, redraw the rail
/// after DDL, and put the remedy for a known failure next to the failure.
///
/// Methods are bound to the real database rather than forwarded with the proxy
/// as their receiver. AsyncDuckDB keeps its worker, its pending-message table
/// and its logger in instance fields, and there is nothing to be gained by
/// routing every one of those reads back through here.
///
/// The session queries through a connection off the real `db` and not through
/// this, so its own metadata queries do not arrive at `afterQuery` -- which is
/// what stops refreshSchema below from triggering itself.
function observed(database) {
  return new Proxy(database, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;

      if (prop === 'runQuery') {
        return async (conn, text) => {
          const t0 = performance.now();
          let result;
          try {
            result = await value.call(target, conn, text);
          } catch (err) {
            throw withRemedy(err);
          }
          afterQuery(text, performance.now() - t0);
          return result;
        };
      }

      // `.open` at the prompt resets the database: every connection is dropped
      // and every catalog with it, including the extension the transport needs.
      // Nothing here is recoverable -- the remotes were attached to a catalog
      // that no longer exists and their secrets went with it -- so the session
      // is rebuilt rather than repaired. Left alone, the rail would go on naming
      // remotes that are gone and every metadata query would fail against a
      // connection that no longer exists.
      if (prop === 'open') {
        return async (config) => {
          const result = await value.call(target, config);
          session = await newSession();
          // syncWires, reached through here, drops the routes whose remotes the
          // reset took with it -- the same path a hand-typed DETACH takes.
          await refreshSchema();
          return result;
        };
      }

      return value.bind(target);
    },
  });
}

/// Redraw whatever a query the shell ran has changed.
///
/// Which wire to pulse is decided by reading the SQL, exactly as the notebook
/// decided it: duckdb-wasm does not report which catalogs a query touched, and
/// with several remotes attached, pulsing all of them would claim traffic that
/// never happened. A qualified reference is the only way to reach a remote, so
/// `remote.` in the text is the signal. The session uniquifies names from a
/// fixed base, so there is nothing to escape.
function afterQuery(text, ms) {
  if (!session) return;
  for (const c of session.connections) {
    if (c.kind === 'remote' && new RegExp(`\\b${c.name}\\s*\\.`, 'i').test(text)) views.get(c.name)?.wire.pulse(ms);
  }
  // DDL typed at the prompt changes what the rail should show. ATTACH and
  // DETACH are the ones that matter, and the session reconciles against
  // duckdb_databases(), so a remote removed by hand leaves the rail on its own.
  if (/^\s*(create|drop|attach|detach|alter)\b/i.test(text)) refreshSchema();
}

// --- dialogs -----------------------------------------------------------------

// Adding a remote is two jobs done on two machines: start something serving,
// then bring its ticket here. One dialog each, which is the trade #connect
// already makes -- a visitor holding a ticket has done the first and should not
// have to scroll past it to reach a field.
const serve = $('#serve');
const add = $('#add');
const pasteError = $('#paste-error');
const pasteNote = $('#paste-note');

function showError(err, fallback = null) {
  renderError(pasteError, err, fallback);
}

/// Cross from one half to the other.
///
/// Closed before the next is opened, because two open modals stack their
/// backdrops and only the newer one takes focus -- so the older stays on screen,
/// dimmed, behind a dialog it did not open.
const cross = (from, to) => {
  from.close();
  to.showModal();
};
$('#to-add').addEventListener('click', () => cross(serve, add));
$('#to-serve').addEventListener('click', () => cross(add, serve));

/// Open the ticket field, cleared.
///
/// What `+ add remote` does, because by the time somebody presses it they are
/// usually holding a ticket already. Whoever is not is one press from the setup.
function openAdd() {
  pasteError.hidden = true;
  pasteNote.hidden = true;
  $('#ticket').value = '';
  // The second time through, this is not onboarding any more -- the visitor has
  // done this once and needs the field, not the explanation of what it is for.
  if (session?.connections.some((c) => c.kind === 'remote')) {
    $('#add-title').textContent = 'Add another remote';
    $('#add-lede').textContent =
      'Paste the next machine\'s ticket. Each remote is attached under its own name and reached over its own relay.';
  }
  add.showModal();
}

$('#add-remote').addEventListener('click', openAdd);
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
    add.close();
    // The rail is the only thing that changes here now. The notebook used to
    // open cells over the new remote and run them; the shell owns its terminal
    // and takes nothing from this side, so the first query is the visitor's.
    await refreshSchema();
  } catch (err) {
    // Leave the dialog open: the error is about the ticket, and the field it
    // refers to is in here. The pill only goes red when nothing is attached --
    // a failed second remote does not make the first one stop working.
    if (session?.connections.some((c) => c.kind === 'remote')) setRestingStatus();
    else setStatus('failed', 'no route');
    showError(err);
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
    showError(err, 'A ticket is one qh1_… word with no spaces, so check that the whole string was copied.');
    add.showModal();
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
      await refreshSchema();
    } catch (err) {
      // Same reasoning as the paste form: the dialog stays open because the
      // thing that failed is the ticket this dialog is about.
      setStatus('failed', 'no route');
      renderError(error, err);
    } finally {
      btn.disabled = false;
    }
  });
}

// --- boot --------------------------------------------------------------------

renderAgentPrompt();
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

// Taken back out of the address bar now it has been read. The shell reads
// window.location.hash itself when it starts, splits it on commas and runs
// everything after the first one as SQL -- which is how shell.duckdb.org shares
// a session. A quackhole link carries a credential rather than a session, and a
// ticket is base64url so it holds no comma of its own; but a link that arrived
// with one appended would be a page that runs a stranger's SQL on arrival.
// replaceState rather than assignment, which would push a history entry and
// fire hashchange.
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

try {
  await bootLocal();
  // Uncovered only once there is something under it worth looking at. The shell
  // greets with the DuckDB version over the connection it was handed, which is
  // the same thing the notebook's hello query used to say and says it without
  // anything here having to run a query to hear it.
  $('#boot').hidden = true;
  await refreshSchema();
} catch (err) {
  setStatus('failed', 'duckdb failed');
  // The overlay stays up and turns into the error. Dismissing it would reveal a
  // workbench with a dead terminal in it and no way to find out why.
  $('#boot').dataset.state = 'failed';
  $('#boot-title').textContent = 'DuckDB did not start';
  renderError($('#boot-detail'), err);
}

if (fragment.startsWith('qh1_')) {
  // Arriving from the link the server printed: ask about this one peer, rather than
  // opening the setup story the visitor has already been through.
  await offerConnect(fragment);
} else if (session) {
  // Nothing to attach and nothing serving yet, so the first half is the one to
  // open. It names the way to the second for whoever was handed a ticket
  // somewhere other than a link.
  serve.showModal();
}
