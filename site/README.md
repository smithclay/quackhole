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
  and the schema list all work against the local `memory` connection alone. Only
  the routes panel and remote queries need a real remote.

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
and after that the page is a DuckDB shell. Arriving with `#qh1_...` skips the
form entirely and shows the dialog already connecting.

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
these is me?" and the answer is a situation. `#onboard` is anchored to the top
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

Two things went with the notebook and are not coming back through this seam. The
page no longer seeds and runs a first query against a freshly attached remote,
and clicking a table in the rail copies a `SELECT` rather than running one —
both because the shell takes its input from the keyboard and publishes no way to
put text on its prompt.

## Files

| | |
|---|---|
| `index.html` | The workbench shell, plus the onboarding and notes dialogs |
| `app.js` | A view over `web/session.js`: the DuckDB-Wasm boot, the rail, the embedded shell, the dialogs. No connection model of its own |
| `wire.js` | The topology diagram, one per remote. Opens broken; pulses per query at the measured latency |
| `styles.css` | Yellow is DuckDB, periwinkle is iroh. Nothing else is coloured |
| `public/llms.txt` | The docs an agent is sent to read, shipped unhashed at the site root. The onboarding prompt names it, so it is part of the product rather than a courtesy |
| `public/coi-serviceworker.js` | See below. In `public/` so it ships unhashed at the root — it registers itself by its own URL, so a move into `assets/` would scope it there |
| `vite.config.js` | The build. Vite owns `index.html`, `styles.css` and `app.js`; two plugins own the verbatim copies and the fonts |
| `verify.mjs` | Drives the built page against a real server, headless. `QH_URL` points it at a deployment instead of `dist/`; `QH_TICKET2` adds a second server |

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
