# The demo site

The page at **https://smithclay.github.io/quackhole/** — walks a visitor from
nothing to a browser querying a DuckDB on their own laptop.

The interesting part is not the page. It is that the page uses
[`web/`](../web) unmodified: the same shim, the same bridge, the same wasm
transport a person would vendor into their own app. If the demo works, that
does too, because they are the same files.

    npm install
    ../web/build-wasm.sh     # produces web/wasm/, gitignored
    npm run dev              # http://127.0.0.1:8099

## The flow

| Where | What |
|---|---|
| laptop | `sh quackhole-demo.sh` — fetch the extension, seed a table, serve, print a ticket |
| browser | paste the ticket, which boots DuckDB-Wasm and `ATTACH`es over iroh |
| browser | four probes with real timings, then a free SQL console |

## The ticket

`quackhole_serve` already prints an `attach_sql`, and it is the wrong string to
hand a browser: it carries the endpoint id and the token but **not the relay
URL**. Without the relay, iroh resolves the peer through pkarr over HTTPS — a
round trip to a third party that must also have seen the peer publish, which a
server started seconds ago routinely has not. Native clients survive that
because they can retry later. A person watching a demo page will not.

So the laptop mints a ticket instead: `qh1_` + base64url of
`{"e": endpoint_id, "r": relay_url, "t": token}`. One word, no spaces, so a
half-selected copy fails loudly rather than silently truncating.

It is minted in two places that must agree — [`ticket.js`](ticket.js) decodes,
[`scripts/quackhole-demo.sh`](../scripts/quackhole-demo.sh) and the page's
by-hand SQL encode. Changing the shape means changing all three.

## Files

| | |
|---|---|
| `index.html` | Structure. Steps are labelled by *which machine* they happen on, not numbered |
| `app.js` | Onboarding, the DuckDB-Wasm boot through the shim, the tour, the console |
| `wire.js` | The topology diagram. Opens broken; pulses per query at the measured latency |
| `ticket.js` | Ticket encode/decode |
| `styles.css` | Yellow is DuckDB, periwinkle is iroh. Nothing else is coloured |
| `coi-serviceworker.js` | See below |
| `build.mjs` | Assembles `dist/` from here, `web/`, `web/wasm/` and duckdb-wasm |
| `verify.mjs` | Drives the built page against a real laptop, headless |

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

- **Fonts are self-hosted.** `build.mjs` fetches them at build time. Under
  `require-corp` a cross-origin `<link rel=stylesheet>` is fetched in no-cors
  mode and blocked unless the far end sends CORP, which Google Fonts does not
  promise. A failure there is cosmetic, so the build warns and falls back to
  system faces rather than failing.
- **`npm run dev` sets the headers directly** and does not rely on the service
  worker. That is deliberate: when something breaks, it separates a transport
  bug from a Pages-workaround bug. Use `node verify.mjs --sw` to exercise the
  worker path that a real visitor gets.

## Verifying it

`verify.mjs` asserts the thing that matters — that a ticket ends with this page
querying the machine that minted it. That path crosses duckdb-wasm, the XHR
shim, a `SharedArrayBuffer`, an iroh relay and a native DuckDB, and any of them
can break without the page looking broken.

    # terminal 1 -- the laptop
    QH_EXT=build/release/extension/quackhole/quackhole.duckdb_extension \
    QH_DUCKDB=build/release/duckdb \
      sh scripts/quackhole-demo.sh

    # terminal 2 -- the browser
    node build.mjs
    QH_TICKET=qh1_… node verify.mjs

It needs a live n0 relay and a native server, so it is not a CI test — it sits
alongside `test/docker` and `test/browser` as something a human runs.

## Deploying

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on pushes to
`main` that touch `site/`, `web/`, `crates/` or the demo script. It builds the
wasm and the site the same way this README does.

Two things must be true in repository settings, and neither is in this repo:

1. **The repository is public.** GitHub Pages does not serve from a private
   repo on a free plan.
2. **Pages source is set to GitHub Actions**, not a branch.
