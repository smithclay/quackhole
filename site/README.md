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
  place, so an attached remote and a notebook full of results survive it. Only
  `app.js`, `wire.js` and the files under `web/` force a reload —
  they own workers and a wasm session, and hot-swapping a module that spawned a
  worker leaves the old one running.
- **The ticket lives in the fragment, and the fragment survives a reload.** Open
  the link one laptop printed, and every reload comes back already attached —
  you are iterating on the connected page, not on the empty one.
- **You do not need a laptop for most of it.** The notebook, the connection rail
  and the schema list all work against the local `memory` connection alone. Only
  the routes panel and remote queries need a real remote.

`vite.config.js` owns the two things Vite does not do by itself, and the
comments there say why each is the way it is: the files that must ship
byte-identical rather than bundled, and the fonts, which are fetched rather than
found.

## The flow

| Where | What |
|---|---|
| browser | DuckDB-Wasm boots on arrival; the notebook works before any remote exists |
| laptop | `npx quackhole` — fetch the extension, seed a table, serve, print a link |
| browser | opening that link `ATTACH`es the laptop into the session already running |

Onboarding is a dialog, not a page: adding a remote is a task you finish once,
and after that the page is a notebook. Arriving with `#qh1_...` skips the form
entirely and shows the dialog already connecting.

## More than one remote

Repeat the flow and the second machine attaches beside the first, as `laptop2`,
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
- **Secrets are named and scoped.** `CREATE SECRET laptop2 (TYPE quack, TOKEN
  …, SCOPE 'quack:<endpoint-id>.iroh:9494')`. An unnamed secret is a single
  global, so the second remote would collide on the name or be handed the first
  one's token. Quack resolves the secret by the ATTACH path, so the scope is
  what routes the right token to the right laptop — a secret scoped anywhere
  else is not found at all, and the failure reads `Could not find a Quack
  authentication token`.
- **The rail is reconciled, not bookkept.** `duckdb_databases()` answers
  locally, with no round trip, and it is what the connection list is redrawn
  from — so typing `DETACH laptop2` into a cell removes it from the rail exactly
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

## Files

| | |
|---|---|
| `index.html` | The workbench shell, plus the onboarding and notes dialogs |
| `app.js` | A view over `web/session.js`: the DuckDB-Wasm boot, the rail, the notebook, the dialogs. No connection model of its own |
| `wire.js` | The topology diagram, one per remote. Opens broken; pulses per query at the measured latency |
| `styles.css` | Yellow is DuckDB, periwinkle is iroh. Nothing else is coloured |
| `public/coi-serviceworker.js` | See below. In `public/` so it ships unhashed at the root — it registers itself by its own URL, so a move into `assets/` would scope it there |
| `vite.config.js` | The build. Vite owns `index.html`, `styles.css` and `app.js`; two plugins own the verbatim copies and the fonts |
| `verify.mjs` | Drives the built page against a real laptop, headless. `QH_URL` points it at a deployment instead of `dist/`; `QH_TICKET2` adds a second laptop |

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

    # terminal 1 -- the laptop
    QH_EXT=build/release/extension/quackhole/quackhole.duckdb_extension \
      npx ../npm

    # terminal 2 -- the browser
    npm run build
    QH_TICKET=qh1_… node verify.mjs

Give it `QH_TICKET2` as well and it attaches a second laptop, queries both in
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
