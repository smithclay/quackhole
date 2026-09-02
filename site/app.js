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
import { registerAgentTools } from './webmcp.js';

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
    // Anchored to something that names a response, because `withRemedy` is on
    // the path of every statement the shell runs and a bare /401/ matches
    // `date field value out of range: "401"`.
    /unauthori[sz]ed|\b(?:http|status|code)\b[^\n]{0,40}\b401\b|\b401\b[^\n]{0,20}\bunauthor/i,
    'The server rejected the token. A second server on one machine reuses Quack on port 9494 and prints a token the first never issued — restart it with --port 9495 and use its new link.',
  ],
  [
    /invalid connection id/i,
    'The shell lost its connection to DuckDB, which is what resetting the database does. Reload the page to get a new one; anything loaded into the browser-side database is gone either way.',
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
    "Start duckdb v1.5.5 or higher and make it reachable with quackhole.",
    "If the duckdb database is empty, create some sample data in memory.",
    // On its own line: it is the longest thing here and the only part whose
    // length this file does not control, so wrapping around it would re-flow
    // the paragraph every time a self-hosted copy moved.
    `Read ${AGENT_DOCS} first.`,
    '',
    `Then serve the database I would want to query and leave it running.`,
    `Use the token '${manualToken}'.`,
    '',
    'Reply with the qh1_… ticket and nothing else: it grants query access',
    'to this machine, so keep it out of files, logs and commits.',
  ].join('\n');
}

// The by-hand path, built here rather than written into index.html because it
// carries the token minted in this tab.
function renderManualCommand() {
  $('#cmd-manual').querySelector('code').textContent = [
    '-- Note: DuckDB v1.5.5 or higher is required',
    'INSTALL quack; LOAD quack;',
    'INSTALL quackhole FROM community;',
    'LOAD quackhole;',
    '',
    '-- serve waits for the endpoint to learn its home relay, then returns the',
    '-- link to open. No ticket to assemble by hand.',
    '.mode line',
    `SELECT url FROM quackhole_serve(token := '${manualToken}');`,
  ].join('\n');
}

/// Wire a tablist up for the keyboard.
///
/// Automatic activation -- arrowing onto a tab selects it -- because every panel
/// is already in the DOM and switching costs nothing, which is the case the ARIA
/// practices name it for. Roving tabindex, so Tab moves past the strip to the
/// panel rather than stopping at each tab on the way.
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
      // Only the selected tab is a Tab stop. Without this the strip costs a
      // press per tab to cross, which is the thing roving tabindex exists to
      // stop.
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
    // Wrapping, because a strip this short has no meaningful end to stop at.
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

// --- fitting the viewport ----------------------------------------------------

/// Keep `--app-h` equal to the space the browser is actually giving the page.
///
/// The stylesheet defaults it to `100dvh`, which tracks a phone's retracting URL
/// bar and is right until a keyboard opens. The on-screen keyboard shrinks the
/// *visual* viewport and leaves the layout viewport alone, so `dvh` still
/// measures the whole screen and the terminal's last rows -- the prompt among
/// them, which is the row being typed into -- sit behind the keyboard.
/// `visualViewport` is the only thing that reports the difference.
///
/// The shell's own ResizeObserver picks it up from there: the element's height
/// changes, so xterm re-measures and reflows to the rows that are left.
///
/// Left alone entirely where there is no `visualViewport`, so the CSS default
/// stands rather than being replaced by a worse guess.
function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
  vv.addEventListener('resize', apply);
  apply();
}

/// Open the rail's panels on a wide screen, close them on a narrow one.
///
/// `open` is an attribute rather than a style, so the breakpoint cannot do this
/// on its own. Beside the terminal there is room for all three and collapsing
/// them would only hide things; above it, three open panels are a screen of
/// scrolling in front of the prompt.
///
/// Reapplied on the crossing rather than on every resize, so a panel somebody
/// opened stays open until the layout itself changes underneath it.
function trackRailPanels() {
  const narrow = matchMedia('(max-width: 52rem)');
  const apply = () => {
    for (const panel of document.querySelectorAll('.rail-block')) panel.open = !narrow.matches;
  };
  narrow.addEventListener('change', apply);
  apply();
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
// Which wasm build `selectBundle` picked, for `browser_info`. Named at boot
// rather than sniffed out of the URL later.
let bundleName = null;

/// What the shell opens on, kept as a view so the statement that shows it is
/// short enough to read as an invitation.
///
/// Typed out in full it would be three quoted strings wrapping across the
/// terminal, which looks like output nobody meant to produce. `FROM welcome;` is
/// the whole of it, and it stays runnable afterwards.
///
/// A view rather than a table because the rail lists `duckdb_tables()`, which
/// does not include views -- that panel is for the visitor's own tables, and a
/// greeting sitting in it would be the first thing they had to tidy up.
const WELCOME = `CREATE OR REPLACE VIEW welcome AS SELECT unnest([
  'This is a full DuckDB SQL shell, running inside your browser tab.',
  'Nothing was installed, and it all goes away when you close the tab.',
  'There is already a table here: try SELECT * FROM browser_info;',
  'Press "+ add remote" to attach a DuckDB on another machine and query it here.'
]) AS welcome`;

/// Quote a string as a SQL literal.
///
/// The same one `web/session.js` keeps for the same reason, and not imported
/// from it: that is the shipped client's, and this is the page building its own
/// statement. A user agent string is allowed to contain an apostrophe.
const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;

/// What this tab is, as a table.
///
/// The local database opens holding one, so the schema rail is never empty and
/// there is something to query before any remote exists. `FROM browser_info;`
/// is a first statement that answers with the visitor's own machine, which is a
/// better introduction to a SQL shell than an empty catalog.
///
/// A table where `welcome` is a view, and for the opposite reason: the rail
/// lists `duckdb_tables()`, which excludes views, and the point of this one is
/// to be listed. It is the local half of the demo server's `host_info` -- the
/// same question, asked of the machine the browser is on.
///
/// Every value is quoted rather than bound, because this goes down the same
/// connection everything else does and that takes text.
function browserInfoSql(bundleName) {
  // userAgentData is the supported way to ask and is Chromium-only. The UA
  // string is the fallback, read for the one token that names the engine rather
  // than parsed properly -- that is a job nobody has ever finished, and a demo
  // table is not the place to start.
  const brand = navigator.userAgentData?.brands?.find((b) => !/not.a.brand/i.test(b.brand));
  const browser = brand
    ? `${brand.brand} ${brand.version}`
    : (navigator.userAgent.match(/\b(Firefox|Edg|Chrome|Safari)\/(\d+)/)?.slice(1).join(' ') ?? 'unknown');

  // navigator.platform is deprecated and still the only thing every browser
  // answers; userAgentData.platform is preferred where it exists.
  const platform = navigator.userAgentData?.platform || navigator.platform || 'unknown';
  const cores = Number.isInteger(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 'NULL';

  return `CREATE OR REPLACE TABLE browser_info AS SELECT
    ${sqlString(browser)} AS browser,
    ${sqlString(platform)} AS platform,
    ${cores} AS cores,
    version() AS duckdb_version,
    ${sqlString(bundleName)} AS wasm_bundle,
    ${crossOriginIsolated} AS cross_origin_isolated`;
}

/// A session over a fresh connection, with the transport extension loaded.
///
/// Separate from bootLocal because it happens more than once: `.open` in the
/// shell resets the database, and everything here has to be done again against
/// whatever replaced it.
async function newSession() {
  const conn = await db.connect();
  await conn.query('INSTALL quack');
  await conn.query('LOAD quack');
  // Recreated here rather than once at boot, because `.open` resets the database
  // and both of these should still be there afterwards -- an empty rail after a
  // reset looks like the reset broke something.
  await conn.query(WELCOME);
  await conn.query(browserInfoSql(bundleName));
  return new QuackholeSession({ conn, worker });
}

async function bootLocal() {
  const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);
  bundleName = bundle.mainModule === DUCKDB_BUNDLES.mvp.mainModule ? 'mvp' : 'eh';

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
      // Run, now that there is a way to. This used to copy a SELECT to the
      // clipboard, because the shell takes its input from the keyboard and
      // publishes no way to put text on its prompt -- `runInShell` is that way,
      // and it types the statement where the visitor can see it rather than
      // handing them something to paste.
      //
      // DESCRIBE rather than a SELECT, because the question a table name in a
      // rail asks is "what is in it?" and the answer that is always safe to run
      // is its shape. A SELECT on a remote is a relay round trip over however
      // many rows, decided by a click on a name.
      btn.title = `Describe ${qualified} in the shell`;
      btn.addEventListener('click', async () => {
        try {
          await runInShell(`DESCRIBE ${qualified};`);
        } catch {
          // The prompt had something in it, or the statement never settled.
          // The terminal is where the answer would have gone and there is
          // nowhere in the rail to put a message, so the button says it briefly
          // and that is all -- the name is still there to type by hand.
          btn.dataset.blocked = '';
          setTimeout(() => delete btn.dataset.blocked, 1600);
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
  let drawn = null;
  try {
    const conn = await session.attach(ticket, { onDialing: (record) => (drawn = addWire(record)) });
    drawn.wire.setState('live');
    renderConnections();
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

/// Put the workbench back in step with a remote that just arrived.
///
/// The two lines every attach ends with, in one place because three callers
/// reach them now: the ticket field, the offer a link opens, and the agent tool.
/// The rail first, so the tables are listed beside the terminal by the time the
/// statement that reads them lands in it.
///
/// The dialogs close before calling this rather than after, because listing a
/// remote's tables is a relay round trip and nobody should watch a modal
/// through one.
async function attached(conn) {
  // Never throws. By the time this runs the ATTACH has landed, and the dialog
  // that called it has already closed -- so a redraw that fails would render
  // its error into a dialog nobody can see, and would tell an agent the attach
  // failed when the remote is sitting there attached. Same trade `rebuild`
  // makes, for the same reason: the half worth keeping is the one that worked.
  try {
    await refreshSchema();
  } catch (err) {
    console.error('[quackhole] could not redraw after attaching:', err);
  }
  announce(conn);
}

/// Attach a remote on an agent's behalf, and then get out of its way.
///
/// The same path the ticket field takes -- `addRemote` is still the only way in
/// -- with whatever modal was up closed afterwards. An agent that attached a
/// remote has done the thing the front door asks for, and a dialog left over the
/// workbench hides the rail the attach just changed.
async function attachForAgent(ticket) {
  const conn = await addRemote(ticket);
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  await attached(conn);
  return conn;
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

  // Counting keystrokes is the only way to know whether a line is part-typed,
  // because the terminal renders to a canvas and cannot be read. Registered
  // after `embed`, since xterm creates the textarea these arrive at.
  watchPrompt(mount);

  // `embed` hands its resize handler back by assigning `container.onresize`,
  // and a <div> never fires a resize event -- so nothing calls it. Without an
  // observer the terminal keeps the width it measured on its first frame, and
  // every result wraps at that width for the rest of the session, including
  // after the rail appears beside it. Invoking the property rather than
  // reaching into the shell keeps this at the handoff point the shell chose.
  new ResizeObserver(() => mount.onresize?.()).observe(mount);

  // Greet by running a query rather than printing a line, because what there is
  // to say about this page is that it runs queries.
  greet();
}

/// Put the workbench back together after the shell reset the database.
///
/// Nothing here is recoverable: the remotes were attached to a catalog that no
/// longer exists and their secrets went with it, so this rebuilds the local half
/// and lets the rail say what is true, which is that nothing is attached.
///
/// Never throws. Its caller is the shell's own `open`, and a rejection there
/// costs the visitor their terminal -- see the note at that call site.
async function rebuild() {
  try {
    session = await newSession();
    // syncWires, reached through here, drops the routes whose remotes the reset
    // took with it -- the same path a hand-typed DETACH takes.
    await refreshSchema();
  } catch (err) {
    // The rail is now stale and the terminal is not, which is the better half to
    // keep. Nothing on screen can say so without claiming the shell is broken.
    console.error('[quackhole] could not rebuild the session after a reset:', err);
  }
}

/// Say in the shell that a remote is connected, and under what name.
///
/// Run rather than printed, because the shell has no way to print -- and a
/// statement that came back is better evidence the connection works than a line
/// claiming it does.
///
/// Local on purpose. It used to list the remote's tables, which meant a relay
/// round trip on top of the two the attach already paid, for something the rail
/// beside it was about to show anyway. The name is the part worth saying: it is
/// what every later query has to be spelled with.
///
/// The catalog name goes inside a string literal, safe for the reason session.js
/// gives where it interpolates the same thing: nothing but its `#uniqueName`
/// produces one, and that builds them from a fixed base.
///
/// Kept to ASCII. Every character here is dispatched as a `keydown` with itself
/// as `key`, and xterm is only reliable about that for printable ASCII.
function announce(conn) {
  typeIntoShell(`SELECT '${conn.name} connected' AS quackhole;`);
}

/// The statement the shell opens on. Named, because two places have to agree on
/// it: the one that types it and the one that notices it ran.
const GREETING = 'FROM welcome;';
let greeted = false;

/// Type the greeting, once the shell is ready to take it.
///
/// `embed` resolves before the shell is. It starts the Rust half's
/// `configureDatabase` and does not await it, so the prompt is still being drawn
/// when the promise settles, and anything typed before it arrives is dropped
/// when the prompt resets the input.
///
/// Nothing published says when that finishes, and the terminal cannot be read to
/// find out either: xterm draws to a canvas wherever WebGL is available, which
/// leaves no text in the DOM. So this tries, and the proxy is what says whether
/// to stop -- the greeting runs through `runQuery` like any other statement, so
/// `greeted` is set from the same place the wire pulses are.
///
/// Bounded, and quiet when it runs out: a shell that opens at an empty prompt is
/// where this page was before the greeting existed.
function greet(tries = 12) {
  if (greeted || tries === 0) return;
  typeIntoShell(GREETING);
  setTimeout(() => greet(tries - 1), 250);
}

/// Roughly how much is sitting at the prompt, unsubmitted.
///
/// The terminal cannot be read to find out: xterm draws to a canvas wherever
/// WebGL is available, which is the same fact that stops `greet` polling for
/// readiness. So this counts the keys instead -- every one the visitor presses
/// reaches the helper textarea, and Enter is what hands the line to the shell.
///
/// It only ever has to be right about the difference between "empty" and "not",
/// and it errs towards not: an arrow key or a paste moves the real line in ways
/// this does not model, and every one of those makes it read as busier than it
/// is. Refusing to type when the prompt was actually clear costs an agent one
/// retry. Typing into a line that was not clear runs a statement nobody wrote,
/// which is what this exists to stop.
let promptLen = 0;

/// Is somebody part-way through a line at the prompt?
const promptBusy = () => promptLen > 0;

/// Count what the terminal is handed, including what this page types into it.
///
/// Registered in the capture phase on the container, so it runs before xterm
/// sees the key and regardless of what xterm does with it. Synthetic keys from
/// `typeIntoShell` come through here too, which is what makes the count land
/// back at zero on the Enter that submits them.
function watchPrompt(mount) {
  mount.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') promptLen = 0;
      else if (e.key === 'Backspace') promptLen = Math.max(0, promptLen - 1);
      else if (e.key.length === 1) promptLen += 1;
    },
    true,
  );
  // Paste never fires a keydown, and is the one way a long line arrives at once.
  // The length is not tracked past "there is something there", because nothing
  // here needs it to be.
  mount.addEventListener('paste', () => (promptLen += 1), true);
}

/// Type a statement at the shell's prompt and run it, the way a visitor does.
///
/// There is no other way in. `embed` takes a database and four display settings
/// and resolves to `undefined`, and the package exports that function, a URL
/// helper and five version strings -- no terminal, no shell handle, nothing on a
/// global. Its one startup-query path is the `#queries=v0,…` fragment its share
/// links use, which is read before `embed` is called and is exactly the fragment
/// this page clears on arrival because a ticket lives there.
///
/// So this goes in the way a keyboard does: xterm reads printable characters off
/// `keydown` on the textarea it keeps for the purpose, and Enter submits. The
/// events are dispatched straight at that textarea rather than through focus,
/// because at boot the onboarding dialog is the modal that should have it.
///
/// Reaching past a published interface, so it is written to fail quietly: if
/// xterm moves that element or stops reading `key`, nothing is typed and the
/// shell opens at an empty prompt, which is where it was before this existed.
function typeIntoShell(sql) {
  // Typing into a line somebody else started splices the two together and runs
  // the result. `DELETE FROM events WHERE ` with a statement appended is a
  // statement nobody wrote, and the shell runs it without hesitating.
  if (promptBusy()) return false;
  const input = $('#shell .xterm-helper-textarea');
  if (!input) return false;
  const press = (key) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  for (const ch of sql) press(ch);
  press('Enter');
  return true;
}

// --- statements typed on somebody else's behalf ------------------------------

/// Statements waiting to be told how they went, keyed by their exact text.
///
/// The shell hands `runQuery` the line it read, unchanged -- the same fact
/// `greet` leans on to know its greeting ran -- so the text is the key. If the
/// line reaching DuckDB is not the line that was typed, nothing matches and the
/// wait times out, which is the honest outcome: something else was at the
/// prompt and the statement that ran was not the one asked for.
///
/// One waiter per text is enough, because `runInShell` lets only one statement
/// be at the prompt at a time. Without that it would not be: two identical
/// statements in flight would share a key, and the second registration would
/// drop the first one's waiter on the floor.
const pending = new Map();

/// Hand a typed statement's outcome back to whoever typed it.
const settle = (text, err, ms) => {
  const waiter = pending.get(text);
  if (!waiter) return;
  pending.delete(text);
  if (err) waiter.reject(err);
  else waiter.resolve(ms);
};

/// Run a statement in the shell, the way a person does, and say how it went.
///
/// This is what the agent tools run SQL through. An agent's statement belongs
/// where the visitor can see it -- typed at the prompt, with its result drawn in
/// the terminal -- rather than on a connection of its own running invisibly
/// beside one. So the rows are not collected here: they are on screen, which is
/// the whole reason for putting the statement there. What comes back is whether
/// it ran, which the `observed` proxy is already watching for.
///
/// Typed once and never retried. `greet` retries because a greeting that arrives
/// twice is still a greeting; a statement may have carried an INSERT to another
/// machine, and delivery is at-most-once here for the same reason it is on the
/// wire.
///
/// One at a time. The terminal is a serial device with a single prompt, and the
/// shell is not reading input while a query is in flight -- so a second
/// statement typed over the first lands nowhere at all, and waits out its
/// timeout having never run. Callers queue rather than race for the prompt.
let inTurn = Promise.resolve();
function runInShell(sql, opts) {
  const turn = inTurn.then(() => typeAtPrompt(sql, opts));
  // The chain carries the turn, not the outcome: without the catch, one failed
  // statement would reject every statement queued behind it.
  inTurn = turn.catch(() => {});
  return turn;
}

/// Type one statement and wait for the shell to answer it.
///
/// Never called directly -- `runInShell` is what serialises the callers.
async function typeAtPrompt(sql, { timeoutMs = 60_000 } = {}) {
  // One line. Every character goes in as its own keydown and Enter submits, so
  // a newline inside the statement would send the first half of it.
  const text = String(sql ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('There is no statement to run.');

  // xterm reads printable characters off `key` and is only dependable about it
  // for ASCII. Refusing beats typing `Zurich` where the statement said `Zürich`
  // and running a query nobody wrote.
  const stray = [...text].find((ch) => ch < ' ' || ch > '~');
  if (stray) {
    throw new Error(
      `The terminal only takes printable ASCII, and this statement holds ${JSON.stringify(stray)}.`,
    );
  }

  // A line comment would swallow the rest of the statement, because the rest of
  // the statement is now on the same line -- including the terminator added
  // below, which is what would leave the shell waiting mid-statement. The check
  // is deliberately blunt: `--` inside a string literal is refused too, and
  // rewriting the statement without a comment is a cheaper answer than a SQL
  // scanner living here.
  if (text.includes('--')) {
    throw new Error(
      'A -- comment cannot be used here: the statement is typed as one line, so everything after' +
        ' it would be commented out, including the terminator. Use /* */ instead.',
    );
  }

  // The shell treats a statement as finished only when it ends in a semicolon.
  // Without one it drops to its `...>` continuation prompt and waits, and the
  // next thing typed at that prompt -- by the visitor, or by `greet` still
  // retrying its greeting -- is appended and the pair run as one statement.
  // That is how `SELECT 41 + 1 AS answer` and `FROM welcome;` became a single
  // query returning three rows.
  const statement = text.endsWith(';') ? text : `${text};`;

  if (promptBusy()) {
    throw new Error(
      'Something is already typed at the terminal, so this statement was not sent -- it would have' +
        ' run joined onto whatever is there. Ask whoever is at the keyboard to finish or clear the' +
        ' line, then send it again. Nothing ran.',
    );
  }

  let waiter;
  const settled = new Promise((resolve, reject) => {
    waiter = { resolve, reject };
    pending.set(statement, waiter);
  });

  // Only if the registration is still this call's own. `settle` has already
  // removed it by the time this runs on the happy path, and on a later identical
  // statement the entry belongs to that one.
  const forget = () => {
    if (pending.get(statement) === waiter) pending.delete(statement);
  };

  if (!typeIntoShell(statement)) {
    forget();
    throw new Error('The terminal is not ready to take a statement. Nothing ran.');
  }

  const expired = new Promise((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `The statement did not finish within ${Math.round(timeoutMs / 1000)}s. It is either still` +
              ' running or it never reached the prompt -- the terminal shows which. Do not send it' +
              ' again without looking: it may already have reached the machine.',
          ),
        ),
      timeoutMs,
    );
  });

  return Promise.race([settled, expired]).finally(forget);
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
            // Settled with the error as DuckDB threw it, not the one bound for
            // the terminal: `withRemedy` folds the remedy and a URL into the
            // message with CRLFs, which are there so the terminal wraps them,
            // and whoever typed this attaches the remedy itself in its own
            // shape. Handing over the terminal's copy would send an agent
            // carriage returns and the same sentence twice.
            settle(text, err);
            throw withRemedy(err);
          }
          const ms = performance.now() - t0;
          afterQuery(text, ms);
          settle(text, null, ms);
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
          // Started, not awaited, and it swallows its own failures. What the
          // shell does with a rejected `open` is give up on it: `open_command`
          // writes the message and returns *before* reconnecting, leaving the
          // shell holding the connection id the reset just destroyed, and every
          // statement after that fails with "Invalid connection id" until the
          // page is reloaded. Rebuilding the session is fallible -- it reinstalls
          // an extension over the network -- so awaiting it here would let a
          // slow repository take the terminal down with it.
          rebuild();
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
  // Stops `greet` retrying. Set here rather than where it is typed, because
  // reaching the prompt and being run are different things.
  if (text === GREETING) greeted = true;
  if (!session) return;
  for (const c of session.connections) {
    if (c.kind === 'remote' && new RegExp(`\\b${c.name}\\s*\\.`, 'i').test(text)) views.get(c.name)?.wire.pulse(ms);
  }
  // DDL typed at the prompt changes what the rail should show. ATTACH and
  // DETACH are the ones that matter, and the session reconciles against
  // duckdb_databases(), so a remote removed by hand leaves the rail on its own.
  // Not awaited -- this is on the shell's own path and nothing here can wait --
  // so it needs a catch of its own, or a redraw against the connection `.open`
  // just destroyed surfaces as an unhandled rejection instead of a log line.
  if (/^\s*(create|drop|attach|detach|alter)\b/i.test(text)) {
    refreshSchema().catch((err) => console.error('[quackhole] could not redraw after a statement:', err));
  }
}

// --- dialogs -----------------------------------------------------------------

// Adding a remote is two jobs done on two machines: start something serving,
// then bring its ticket here. One dialog each, which is the trade #connect
// already makes -- a visitor holding a ticket has done the first and should not
// have to scroll past it to reach a field.
const splash = $('#splash');
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
  // `#add` is the one with state to carry: a ticket that failed is still in the
  // field, its error is still under it, and `openAdd` may have retitled it.
  // Reaching it from `#serve` or from the front door is a fresh attempt, so it
  // opens the way pressing "+ add remote" does.
  if (to === add) openAdd();
  else to.showModal();
};
$('#to-add').addEventListener('click', () => cross(serve, add));
$('#to-serve').addEventListener('click', () => cross(add, serve));
$('#splash-add').addEventListener('click', () => cross(splash, add));
$('#splash-serve').addEventListener('click', () => cross(splash, serve));

/// Draw the concept on the front door.
///
/// The same diagram the rail draws per remote, because what this page is for is
/// exactly what that diagram shows, and a picture of it beats a paragraph about
/// it. Live rather than broken: the rail's copies open broken because that is
/// the honest state of a connection nobody has made, and this one is not
/// reporting a state.
///
/// The round trip repeats, slowly, because the still diagram says only that a
/// path exists and the offer is that queries travel it. Stopped when the splash
/// closes -- and never started at all for anyone who asked not to see motion,
/// which the stylesheet's reduced-motion rule cannot do for it: that turns off
/// CSS animation, and this is the Web Animations API.
function drawSplash() {
  const wire = createWire($('#splash .wire-mount'), 'the DuckDB you want');
  wire.setState('live');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const beat = setInterval(() => splash.open && wire.pulse(900), 2600);
  splash.addEventListener('close', () => clearInterval(beat), { once: true });
}

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
    await attached(conn);
  } catch (err) {
    // Leave the dialog open: the error is about the ticket, and the field it
    // refers to is in here.
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
  // Guarded like wire.js guards it: a ticket minted before the endpoint learned
  // its home relay carries an empty string, and a throw here would lose the
  // dialog entirely rather than showing a peer with no relay to name.
  try {
    $('#connect-relay').textContent = new URL(peer.relayUrl).host;
  } catch {
    $('#connect-relay').textContent = peer.relayUrl || 'none — this ticket names no relay';
  }
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
      await attached(conn);
    } catch (err) {
      // Same reasoning as the paste form: the dialog stays open because the
      // thing that failed is the ticket this dialog is about.
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

// Both before bootLocal, so the shell's first measurement is of the size it is
// actually going to have. xterm picks its column count from the element it is
// handed and only re-measures when something tells it to.
trackViewport();
trackRailPanels();

try {
  await bootLocal();
  // Uncovered only once there is something under it worth looking at. The shell
  // greets with the DuckDB version over the connection it was handed, which is
  // the same thing the notebook's hello query used to say and says it without
  // anything here having to run a query to hear it.
  $('#boot').hidden = true;
  await refreshSchema();

  // Offered to an agent driving this browser, now there is a session to offer.
  // Everything goes in as a callback rather than a value because `.open` at the
  // shell's prompt replaces `session` wholesale -- see `rebuild`. Resolves false
  // and never throws: WebMCP is behind a flag in every browser that has it at
  // all, so registering nothing is the ordinary outcome.
  await registerAgentTools({
    session: () => session,
    attach: attachForAgent,
    run: runInShell,
    refresh: refreshSchema,
    remedyFor,
  });
} catch (err) {
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
  // Nothing to attach and nothing serving yet, so the front door: it is the only
  // screen that says what this is rather than what to do next, and it offers
  // both ways on -- a ticket somebody was handed, or the instructions for
  // producing one.
  drawSplash();
  splash.showModal();
}
