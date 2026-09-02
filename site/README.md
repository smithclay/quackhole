# The demo site

The page at **https://smithclay.github.io/quackhole/** — a DuckDB workbench that
runs entirely in the browser and attaches DuckDBs that have no address.

The interesting part is not the page. It is that the page uses
[`web/`](../web) unmodified: the same shim, the same bridge, the same wasm
transport a person would vendor into their own app. If the demo works, that
does too, because they are the same files.

    npm install
    ../web/build-wasm.sh     # produces web/wasm/, gitignored
    npm run dev              # http://127.0.0.1:8099, reloads on save

[Vite](https://vite.dev) is the build. `npm run dev` serves the page unbundled
with HMR; `npm run build` produces `dist/`; `npm run preview` serves that
`dist/` back, which is the way to be sure you are looking at exactly what
deploys. Both servers set the cross-origin isolation headers directly — see
below for why that matters.

Three things make this a usable loop rather than a fast one:

- **Editing `styles.css` does not restart DuckDB.** The stylesheet is swapped in
  place, so an attached remote and a terminal full of results survive it. Only
  `app.js`, `wire.js` and the files under `web/` force a reload —
  they own workers and a wasm session, and hot-swapping a module that spawned a
  worker leaves the old one running.
- **The ticket lives in the fragment, and the fragment survives a reload.** Open
  the link one server printed, and every reload comes back already attached —
  you are iterating on the connected page, not on the empty one.
- **You do not need a second machine for most of it.** The shell, the connection rail
  and the schema list all work against the local `memory` connection alone —
  which opens holding a `browser_info` table, so the rail has something in it
  and there is something to click before any remote exists. Only the routes
  panel and remote queries need a real remote.

`vite.config.js` owns the two things Vite does not do by itself, and the
comments there say why each is the way it is: the files that must ship
byte-identical rather than bundled, and the fonts, which are fetched rather than
found.

## The flow

| Where | What |
|---|---|
| browser | DuckDB-Wasm boots on arrival; the shell works before any remote exists |
| server | `quackhole_serve` — an agent, a DuckDB you have open, or `npx quackhole` — starts serving and prints a link |
| browser | opening that link `ATTACH`es the remote into the session already running |

Onboarding is a dialog, not a page: adding a remote is a task you finish once,
and after that the page is a DuckDB shell. Arriving with `#qh1_...` skips all of
it and offers the one peer the link names.

Four dialogs, one job each. `#splash` is the front door and the only screen that
says what this is rather than what to do next — a sentence, the wire diagram the
rail draws per remote, and the two ways on. `#serve` is how to start something
serving. `#add` is a ticket field. `#connect` handles a ticket that arrived in
the URL, which has to name whose machine it is before anything dials.

The splash draws the wire live rather than broken. The rail's copies open broken
because that is the honest state of a connection nobody has made yet; this one
is not reporting a state, it is a picture of what is on offer. It pulses slowly,
because a still diagram says only that a path exists and the offer is that
queries travel it — and it checks `prefers-reduced-motion` itself, since the
stylesheet's blanket rule turns off CSS animation and this is the Web Animations
API.

The dialog offers two ways to serve that other end, as tabs. They are
alternatives — you need one — so stacking them down the dialog made everyone
scroll past the one they had already decided against, and left the ticket field,
which is what a returning visitor came for, below a screen of prose.

The order is the argument. **The prompt for a coding agent leads**, because the
machine worth querying is usually one nobody is typing into — a sandbox, a VM, a
box behind SSH — and an agent is already sitting in it. It carries the token
minted in the tab and points at [`public/llms.txt`](public/llms.txt) rather than
spelling out the SQL, so the steps live in a document that gets to be wrong once
instead of in a string that ages inside a copied prompt. **The SQL is second**,
because it serves the database you already have open.

`npx quackhole` used to be a third. It seeds a sample table in a temp directory
and takes no database path, so what it demonstrates is the connection rather
than anything of yours — which makes it a thing to read about, not a way to add
the remote this dialog exists to add. It is still in the root README and the npm
package, and this file still reaches for it below to test against a real server.

Nothing numbers the tabs. The order is a gradient — from the machine you are not
typing into to the DuckDB you have open — rather than a sequence, and `01/02`
would promise steps to be done in turn. They are labelled by what you do rather
than by what the thing is, because the question being answered is "which of
these is me?" and the answer is a situation. `#serve` is anchored to the top
of the viewport rather than centred, which a modal dialog is by default: the
panels are different heights, and a centred dialog re-centres on every switch,
sliding the tab strip out from under the cursor that just clicked it.

## More than one remote

Repeat the flow and the second machine attaches beside the first, as `remote2`,
with its own route drawn in the rail. One statement can then read both — which
is the point, and is the thing a single DuckDB behind NAT cannot do for you.

Three things make that work, and each is a place a single-remote shortcut used
to sit:

- **The bridge keys relays by endpoint id.** `web/bridge-worker.js` holds a map
  the page fills with a `peer` control frame per remote; `?relay=` survives only
  as the fallback for a caller with one. Two remotes on two relays would
  otherwise both be dialled through whichever relay arrived first. The frame
  goes down the same channel as the ATTACH that follows it, so there is no ack
  to wait for and no way for the dial to arrive first.
- **Secrets are named and scoped.** `CREATE SECRET remote2 (TYPE quack, TOKEN
  …, SCOPE 'quack:<endpoint-id>.iroh:9494')`. An unnamed secret is a single
  global, so the second remote would collide on the name or be handed the first
  one's token. Quack resolves the secret by the ATTACH path, so the scope is
  what routes the right token to the right peer — a secret scoped anywhere
  else is not found at all, and the failure reads `Could not find a Quack
  authentication token`.
- **The rail is reconciled, not bookkept.** `duckdb_databases()` answers
  locally, with no round trip, and it is what the connection list is redrawn
  from — so typing `DETACH remote2` into a cell removes it from the rail exactly
  the way the × does.

## The ticket

An endpoint id and a token are not enough to hand a browser. Without the relay
URL, iroh resolves the peer through pkarr over HTTPS — a round trip to a third
party that must also have seen the peer publish, which a server started seconds
ago routinely has not. Native clients survive that because they can retry later.
A person clicking a link will not.

So `quackhole_serve` waits for the home relay and mints a ticket:
`qh1_` + base64url of `{"e": endpoint_id, "r": relay_url, "t": token}`. One word,
no spaces, so a half-selected copy fails loudly rather than truncating quietly.
Its `url` column wraps that in a link to this page.

**`crates/quackhole-core` is the only implementation.** It mints the ticket for
the extension and reads it back for this page, over `web/peer.js`. Both clients
link the same crate, so there is nothing here to drift: the address this page
ATTACHes and the scope it files the token under are one function call, not two
strings that have to match.

## The query surface is somebody else's

The terminal is `@duckdb/duckdb-wasm-shell`, duckdb's own embeddable web shell,
embedded unmodified. It is the third thing on this page that ships as-is —
`web/` is the second — and for the same reason: a query box written here could
always be accused of knowing where its bytes came from, and this one cannot,
because it was written before any of this existed. It knows nothing about iroh,
relays or tickets. It asks for an `AsyncDuckDB` and gets the one the transport
is already under.

That handoff is the whole integration:

```js
await shell.embed({ shellModule, container, resolveDatabase: async () => db });
```

It is *not* what runs at [shell.duckdb.org](https://shell.duckdb.org), which has
since moved to a frontend of its own on `@xterm/xterm`. This package is still
published out of `duckdb/duckdb-wasm` and still versioned in lockstep with
`@duckdb/duckdb-wasm` — the same version string, released the same day — which
is what makes it safe to pin beside it and the first thing to check if it ever
drifts.

The shell offers no hook into its terminal, so the things the page still needs
to do around a query are done by observing the database instead of the terminal:
`observed()` in `app.js` wraps `runQuery`, which is how the wire still pulses at
the measured latency, how the rail still redraws after DDL, and how a known
failure still arrives with its remedy from `docs/TROUBLESHOOTING.md` attached.
It wraps `open` too, because `.open` at the prompt resets the database and takes
every attached remote with it.

The keyboard is the only way in, so anything the page wants to run goes in as
keystrokes — `runInShell`, which is also what the agent tools use, with all the
constraints listed under them. Clicking a table in the rail runs
`DESCRIBE <catalog>.<table>;` through it. That used to copy a `SELECT` to the
clipboard instead, because there was no way to put text on the prompt; there is
now, and handing somebody a thing to paste was never the better half of that
trade.

`DESCRIBE` rather than a `SELECT`, because the question a table name in a rail
asks is "what is in it?", and the answer that is always safe to run is its
shape. A `SELECT` on a remote is a relay round trip over however many rows,
decided by a click on a name.

The one thing that did go with the notebook and is not coming back: the page no
longer seeds and runs a first query against a freshly attached remote. It says
the remote is connected and leaves the rail beside it to say what is in it.

## Files

| | |
|---|---|
| `index.html` | The workbench shell, plus the four onboarding dialogs |
| `app.js` | A view over `web/session.js`: the DuckDB-Wasm boot, the rail, the embedded shell, the dialogs. No connection model of its own |
| `wire.js` | The topology diagram, one per remote. Opens broken; pulses per query at the measured latency |
| `webmcp.js` | The three WebMCP tools, registered on `document.modelContext` when a browser has one. Same session and same redraw as the dialogs; `run-sql` types at the terminal and returns no rows |
| `styles.css` | Yellow is DuckDB, periwinkle is iroh. Nothing else is coloured |
| `public/llms.txt` | The docs an agent is sent to read, shipped unhashed at the site root. The onboarding prompt names it, so it is part of the product rather than a courtesy |
| `public/coi-serviceworker.js` | See below. In `public/` so it ships unhashed at the root — it registers itself by its own URL, so a move into `assets/` would scope it there |
| `vite.config.js` | The build. Vite owns `index.html`, `styles.css` and `app.js`; two plugins own the verbatim copies and the fonts |
| `verify.mjs` | Drives the built page against a real server, headless. `QH_URL` points it at a deployment instead of `dist/`; `QH_TICKET2` adds a second server |

## Tools for an agent in the browser

The page registers three [WebMCP](https://webmachinelearning.github.io/webmcp/)
tools on `document.modelContext`, so an agent driving the browser can do what a
visitor does: `attach-remote` takes a `qh1_…` ticket, `list-connections` says
what is attached and what tables each one holds, and `run-sql` runs a statement.

They go through `QuackholeSession` and then the view's own redraw, so a remote
an agent attached leaves the rail, the routes and the terminal exactly where a
click would have left them. That is the same trade the rest of `app.js` makes,
and it is why `webmcp.js` is here rather than in `web/`: the transport is
copied verbatim into anything that vendors it, and a library that reached for
its host page's `document` and hung tools on it would be deciding something
that is not the transport's to decide. An agent surface is a view.

**`run-sql` returns no rows.** It types the statement at the terminal and the
result is drawn there, for whoever is sitting in front of it; what comes back
to the agent is that the statement ran and how long it took. An agent querying
somebody's machine over a connection of its own, invisibly, beside a terminal
showing nothing, is the version of this page nobody should ship — and the
visible one costs the agent only a thing it can ask a person for.

Typing rather than querying is most of what `runInShell` is, and the prompt is
a worse target than it looks:

- **It ends in a semicolon, added if it is missing.** The shell reads a
  statement as finished only when it ends in one. Without it the prompt drops
  to `   ...>` and waits, and the *next* thing typed there is appended and the
  pair run as one statement — which is how `SELECT 41 + 1 AS answer` and a
  greeting retry became a single query returning three rows of 42. For the same
  reason `--` comments are refused: everything after one is on the same line
  now, including the terminator.
- **One line of printable ASCII.** Every character goes in as its own `keydown`
  and Enter submits, so newlines collapse to spaces. xterm reads printable
  characters off `key` and is only dependable about ASCII, so
  `WHERE city = 'Zürich'` is turned away rather than typed as `Zurich` and run
  as a query nobody wrote.
- **Nothing is typed into a line somebody else started.** Spliced onto a
  half-written `DELETE FROM events WHERE `, an agent's statement is a statement
  nobody wrote, and the shell runs it without hesitating. The terminal cannot
  be read to check — it is a canvas wherever WebGL is available — and none of
  Ctrl+C, Ctrl+U, Escape or End clears the line, so there is nothing to reach
  for. `promptLen` counts keystrokes instead, in the capture phase on the
  container, and `run-sql` refuses while it is above zero. It errs towards
  busy: a needless refusal costs an agent a retry, and the other mistake runs
  SQL nobody wrote.
- **One statement at a time.** The terminal is a serial device, and the shell
  is not reading input while a query is in flight — a second statement typed
  over the first lands nowhere and waits out its timeout having never run. So
  callers queue for the prompt rather than racing for it.
- **Typed once, never retried.** A statement may have carried an INSERT to
  another machine, so delivery here is at-most-once for the same reason it is
  on the wire. One that does not settle says so rather than going again.
- **The outcome comes back through `observed`.** The proxy already wraps
  `runQuery` for the wire pulse and the rail redraw; it now also settles
  whoever typed the statement, keyed by the exact text the shell hands DuckDB —
  the same fact `greet` leans on to know its greeting ran. It settles with the
  error DuckDB threw, not the one bound for the terminal: `withRemedy` folds a
  remedy and a URL into the message with carriage returns, and the caller
  attaches the remedy itself in a field of its own.

Two more things about the API are worth knowing before reading `webmcp.js`:

- **A rejected `execute` reaches the agent with its reason dropped.** The spec
  hands the user agent null and false, so a thrown error becomes "that call
  failed" and nothing else — losing the mistyped ticket, the missing table, the
  token scoped to the wrong peer. So the tools report failures as ordinary
  results with `ok: false`, carrying the same remedy the page puts under an
  error on screen. The result is JSON-serialized *after* `execute` resolves, so
  anything that will not stringify fails the same reasonless way — worth
  remembering if a tool here ever starts returning rows again, because
  `JSON.stringify` throws on a BigInt and DuckDB answers `count(*)` with one.
- **`registerTool` needs an origin-keyed agent cluster** and rejects with
  `SecurityError` without one. This page gets that for free: cross-origin
  isolation forces origin keying, and the transport needs to be cross-origin
  isolated anyway. The COOP/COEP pair that buys it a `SharedArrayBuffer` buys
  the tools their agent cluster.

No shipping browser exposes the API without a flag. Chrome and Edge have it
under an origin trial, and preview builds put it behind
`chrome://flags/#enable-webmcp-testing`; the
[Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd)
extension is the way to call a tool by hand. Registering nothing is the
ordinary outcome, and the page has to be exactly as good then — which is why
`registerAgentTools` resolves false rather than throwing, and why nothing else
on the page reads its result.

## On a phone

Below `52rem` the rail stops being a wall beside the terminal and becomes a
stack of disclosures above it. Each block is a `<details>` — the platform's own
disclosure, so the keyboard behaviour, the `aria-expanded` state and the
open/closed styling hook all come with it. `app.js` sets `open` per breakpoint
rather than per resize, so a panel you opened stays open until the layout
itself changes underneath it.

Four things were load-bearing and none of them were obvious:

- **The rail's `height` was never overridden.** It kept `calc(100vh - bar)` at
  every width, so on a phone it was a full screen of mostly empty panel and the
  terminal — the thing the page is for — started below the fold. That single
  declaration was most of the bad mobile experience.
- **`100vh` is the wrong unit on a phone.** It measures the *large* viewport,
  with the URL bar retracted, so a full-height terminal spends its life with
  its last rows behind browser chrome. Everything reads `--app-h`, which
  defaults to `100dvh` and is overwritten by `app.js` with
  `visualViewport.height` — the only thing that reports the on-screen keyboard,
  which shrinks the visual viewport and leaves the layout viewport alone. The
  shell's existing `ResizeObserver` picks it up from there and xterm reflows.
- **`.shell` needs `flex: 1 1 0`, not `auto`.** `.shell > * { height: 100% }`
  makes the terminal's height circular with its own content, so an auto basis
  resolves to the whole scrollback — 2400px of shell under a 390px screen. And
  the rail needs `align-self: stretch`, because the base rule's `align-self:
  start` means the *cross* axis once the workbench is a flex column, which puts
  the whole rail in a 129px strip down the left.
- **`zoom` is the only lever on the terminal's width.** `embed()` takes a font
  family and no size, and xterm measures its cell from its own configured size
  rather than from the container — setting `font-size` on `.shell` changes
  nothing, which was worth measuring before resorting to a trick. `zoom` affects
  layout, so xterm measures the larger box and lays out more columns. At 390px
  that is 44 columns against 52, and the shell answers 44 by narrowing every
  column until `platform` is `plat/form` and a version is `v1.5/.4`. A browser
  without `zoom` gets the 44, which is what it had.

Touch gets two fixes that are not layout. The detach `×` was `opacity: 0` until
hover, and a touch screen has no hover — so on a phone there was no way to
remove a remote at all. And rail rows are padded up to a 24px target under
`@media (hover: none)`, which is what WCAG 2.5.8 asks and what a row of table
names at rail density is under.

## Cross-origin isolation, on a host that cannot send headers

The transport parks the DuckDB thread in `Atomics.wait` on a
`SharedArrayBuffer`, which browsers only hand to a cross-origin-isolated page —
COOP `same-origin` plus COEP `require-corp`. **GitHub Pages serves static files
and cannot set either.**

`coi-serviceworker.js` is the way out: once a service worker controls the page
it synthesises the responses the browser sees, headers included. The cost is
one reload on a visitor's first arrival, because the document that registered
the worker was itself fetched without the headers.

Two consequences worth knowing:

- **Fonts are self-hosted.** `vite.config.js` fetches them at build time. Under
  `require-corp` a cross-origin `<link rel=stylesheet>` is fetched in no-cors
  mode and blocked unless the far end sends CORP, which Google Fonts does not
  promise. A failure there is cosmetic, so the build warns and falls back to
  system faces rather than failing.
- **`npm run dev` and `npm run preview` set the headers directly** and do not
  rely on the service worker. That is deliberate: when something breaks, it
  separates a transport bug from a Pages-workaround bug. Use `node verify.mjs
  --sw` to exercise the worker path that a real visitor gets.
- **A worker inherits its page's COEP.** Anything `vite.config.js` serves itself
  has to send the isolation headers too, because that middleware runs ahead of
  the one Vite applies `server.headers` with. Miss it and `qh-worker.js` is
  fetched, is 200, and still refuses to start — with an error event carrying no
  message.

## Verifying it

`verify.mjs` asserts the thing that matters — that a ticket ends with this page
querying the machine that minted it. That path crosses duckdb-wasm, the XHR
shim, a `SharedArrayBuffer`, an iroh relay and a native DuckDB, and any of them
can break without the page looking broken.

Set `QH_URL=https://smithclay.github.io/quackhole/` to run the same assertions
against what is actually deployed. A passing local `dist/` says nothing about
whether Pages is serving it.

    # terminal 1 -- the machine being queried
    QH_EXT=build/release/extension/quackhole/quackhole.duckdb_extension \
      npx ../npm

    # terminal 2 -- the browser
    npm run build
    QH_TICKET=qh1_… node verify.mjs

Give it `QH_TICKET2` as well and it attaches a second server, queries both in
one statement, refuses a duplicate ticket, and detaches one of them — the four
things one remote cannot exercise. A second server needs a second machine, or a
different Quack port locally: `quackhole_serve` binds `127.0.0.1:9494` by
default and reuses whatever is already there rather than starting its own, so
the second one needs `npx ../npm --port 9495`. It refuses to start otherwise,
because the token it would print is not the token that server accepts.

It drives the WebMCP tools too, against a stub it installs in place of the
browser's own implementation — Playwright ships a Chromium with neither the flag
nor an origin trial token, so there is nothing else to register against. The
stub is not a polyfill and nothing ships it; what it models is the part the
tools have to survive, which is that a result is JSON-serialized after `execute`
resolves and a rejection arrives with its reason gone. What it asserts about
`run-sql` is the visitor's screen, because that is where the rows are.

It needs a live n0 relay and a native server, so it is not a CI test — it sits
alongside `test/docker` and `test/browser` as something a human runs.

## Deploying

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on pushes to
`main` that touch `site/`, `web/` or `crates/`. It builds the wasm and the site
the same way this README does.

Two things must be true in repository settings, and neither is in this repo:

1. **The repository is public.** GitHub Pages does not serve from a private
   repo on a free plan.
2. **Pages source is set to GitHub Actions**, not a branch.
