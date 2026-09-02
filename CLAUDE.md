# quackhole

A DuckDB extension that carries Quack's HTTP over iroh QUIC streams, so a DuckDB
behind NAT is reachable from another DuckDB or from a browser, using only n0's
public relays.

## Conventions

**Commit messages and PR titles use lowercase conventional commits.** Type in
lowercase, description in lowercase, no trailing period:

    fix: track the clang-format symlink so ci can find it
    feat: bridge a synchronous xhr onto an async transport
    test: cover the ffi boundary
    build: bump duckdb to v1.5.5
    docs: record the phase 2 browser design
    refactor: move http framing into the core
    chore: switch to prek

Body prose is ordinary sentence case; only the subject line is lowercased.

## Before pushing

    prek run --all-files     # clang-format, black, cmake-format/lint, cargo fmt/clippy
    make test                # sqllogictest; add QUACKHOLE_NET_TESTS=1 for the gated ones
    make rust-check          # cargo fmt --check, clippy -D warnings, cargo test

`make lifecycle-check`, `test/docker/run.sh`, `test/browser/run.mjs`,
`site/verify.mjs` and `npm/test/scratch.mjs` cover what those cannot; see the
READMEs. The last one packs a tarball, serves it from a second origin, and runs
the npm README's own quickstart block against a live server.

## Things that are easy to get wrong

- **`.clang-format`, `.clang-tidy` and `.editorconfig` are committed symlinks**
  into the duckdb submodule. CI's format-check never builds, so nothing
  recreates them there; un-ignoring them is what makes local and CI agree.
- **clang-format must be exactly 11.0.1.** Newer releases disagree about line
  breaking and CI rejects the result. `prek` pins it.
- **HTTP framing lives in `crates/quackhole-core/src/http.rs`**, not in the C++
  or the browser client. Both drive it; two implementations would drift on the
  `Connection: close` framing, chunk extensions, and which caller headers get
  dropped.
- **Never retry a request that may have reached the peer.** Quack carries
  INSERTs and DDL, so at-most-once is the property that matters. See `may_retry`
  in `dial.rs`.
- **`format.py` rewrites a sqllogictest's `# group:`** to match its directory, so
  a hand-written group is a CI failure rather than a preference.
- **iroh for wasm needs `default-features = false, features = ["tls-ring"]`.**
  Dropping default features alone compiles `presets::N0` away.
- **Paths inside `web/` must stay relative.** `site/` is a *project* Pages site
  served under `/quackhole/`, so a leading `/` resolves to github.io itself.
  `test/browser` serves from the root and hides this, so it passes either way.
- **`web/` is loadable from an origin the page is not on, and that is what
  `QH_CONFIG` is for.** `new Worker(<cross-origin URL>)` throws `SecurityError`
  for module and classic workers alike, so a CDN copy comes in through a
  same-origin blob that `importScripts` it -- and a blob URL has no query string
  to read `?target=` from and an opaque path that `./protocol.js` will not
  resolve against. So `qh-worker.js` takes `self.QH_CONFIG` when a loader
  assigns one, falls back to parsing its own URL when it does not, and publishes
  whichever it used for `shim.js`, which must not parse a second time. `base` is
  the setting with no query-parameter equivalent and defaults to the worker's
  own URL, which is what keeps the relative rule above holding for a vendored
  copy. `npm/src/quackhole.js` is the loader; `test/browser` and `site/` both
  still take the query-param path, which is why they prove the transport was not
  changed by the move that changed its plumbing.
- **Peer identity lives in `crates/quackhole-core/src/peer.rs`**, and is bound
  twice: over the C ABI (`qh_ticket_mint`, `qh_ticket_parse`, `qh_peer_address`,
  `qh_peer_secret_name`, `qh_address_endpoint_id`) and over wasm-bindgen as
  `Peer`, reached from JavaScript through `web/peer.js`. The ticket format, the
  `quack:<id>.iroh:9494` address and the `qh_<id>` secret name are all derived
  from one endpoint id, and all three used to be spelled out in the C++ and
  again in the browser. Same trade as the HTTP framing above: both clients link
  the crate, so a shape defined there cannot drift.
- **The ticket is the whole handoff, and `quackhole_attach` is what consumes
  it.** It carries the relay, which is why it exists: without one iroh resolves
  through pkarr, which routinely has not seen a server this new. There used to
  be an `attach_sql` column printing a CREATE SECRET and an ATTACH instead --
  carrying no relay, with a fixed `AS remote` that collided on a second remote.
  The shell script and the page's by-hand SQL each hand-rolled the ticket format
  too, which meant three encoders agreeing on a shape none of them owned.
- **Two quackhole servers on one machine need distinct Quack ports.**
  `quackhole_serve` binds `127.0.0.1:9494` by default and reuses whatever is
  already listening there rather than starting its own -- so a second one is
  handed the first one's Quack, and the token it prints is not the token that
  server accepts. Pass `target := '127.0.0.1:9495'` for the second, or
  `npx ../npm --port 9495`. Needed to test anything multi-remote locally, which
  is what `site/verify.mjs` with `QH_TICKET2` does.
- **`quackhole_serve` blocks until the endpoint learns its home relay**, up to
  `quackhole_relay_wait_ms` (default 10s), because a ticket minted before then
  omits the relay and sends the browser to pkarr, which routinely has not seen
  a server this new. Tests that only want the lifecycle set the setting to 0
  rather than paying the wait per call.
- **A Quack-attached catalog enumerates nothing.** `duckdb_tables()`,
  `SHOW TABLES FROM <db>` and `information_schema` are all empty for it -- it
  resolves a table name on demand and nothing more. `SELECT name FROM
  <db>.sqlite_master` is the one listing Quack pushes down to the remote, which
  is how `site/app.js` fills the workbench rail. `duckdb_databases()` is the exception
  and is purely local: it does list the catalog, which is what lets the rail be
  reconciled after a hand-typed `DETACH` without a round trip.
- **A quack secret has to be named and scoped to hold more than one.** An
  unnamed `CREATE SECRET (TYPE quack, ...)` is a single global, so a second
  remote collides on the name or is handed the first one's token. Quack looks
  the secret up by the ATTACH path, so `SCOPE 'quack:<id>.iroh:9494'` is what
  routes a token to one peer; a secret scoped elsewhere is not found at all and
  the error is `Could not find a Quack authentication token`, which does not
  sound like a scope problem. `quackhole_attach` and `site/app.js` both build
  the named, scoped form out of `Peer::address` and `Peer::secret_name`, so the
  ATTACH path and the SCOPE cannot be two strings that drift.
- **The relay is per peer on both sides now.** `Core::set_peer_relay` keys it by
  endpoint id, exactly as `web/bridge-worker.js` does, and `quackhole_attach`
  fills it in from the ticket before the ATTACH dials. `quackhole_relay_url` is
  the fallback for peers with none registered, not an override -- one relay per
  process is what could not describe two remotes.
- **Which relay you home on and which relay reaches a peer are two settings, not
  one.** `quackhole_relays` (and the browser's `relays`) is the endpoint's own
  relay map, read once by `Core::new` when it binds -- so it decides the home
  relay, and therefore the relay the minted ticket carries. Nothing has to be
  listed there to *dial* a peer on it: iroh connects to whatever relay URL a
  ticket names, in the map or not, and consults the map only for that relay's
  auth token. `quackhole_core::relay_mode` parses the list for both clients, so
  the DuckDB setting and the browser config are one format -- and
  `parse_relay_url` is where a relay is validated, because `RelayUrl: FromStr`
  is `Url::parse` alone: `relay.example.org:443` parses happily, reading the
  *host* as the scheme, and would bind on a relay map nothing can connect to.
  Changing the setting after the endpoint is bound is refused, but only in
  `quackhole_serve` (beside the `ephemeral` guard, and against
  `QuackholeState::BoundRelays`): that is where the ticket is minted and so
  where a stale setting lies. Raising it from `GetOrCreateCore` instead -- which
  every `.iroh` dial calls -- failed ordinary queries against an already
  attached remote over a setting the dial never reads.
- **The bridge's relay is per-peer, keyed by endpoint id.** `web/bridge-worker.js`
  keeps a map the page fills with `peer` control frames (`web/protocol.js`).
  They travel the same shim-to-bridge channel as the dial, which is the whole
  reason they are frames and not a channel of the page's own: two messages on
  one port arrive in the order they were sent, so a registration cannot be
  overtaken by the ATTACH it precedes and there is nothing to acknowledge.
  `?relay=` is the fallback for a caller with one remote -- `test/browser`
  still uses it.
- **`web/shim.js` intercepts the page's control frames with a `message`
  listener, and that depends on load order.** `qh-worker.js` loads the shim
  before duckdb's bundle, so the shim's listener is registered before duckdb
  assigns `globalThis.onmessage` and therefore runs first --
  `stopImmediatePropagation` is what keeps duckdb from being handed a message
  with no `type`. Reorder those `importScripts` and the frames reach duckdb
  instead, which rejects inside its own dispatch.
- **A browser client that omits an optional query param takes a different code
  path.** `test/browser` always passes `timeout`, which is why a
  temporal-dead-zone bug in `shim.js` survived until `site/` left it out.
- **The embedded shell reads `window.location.hash` and runs it as SQL.**
  `@duckdb/duckdb-wasm-shell`'s `embed()` splits the fragment on commas and
  hands everything after the first to `passInitQueries` -- that is how
  shell.duckdb.org used to share a session. Reading only that function is
  misleading: it just stores them, and `configure_database` in `shell.rs` is what
  replays each one into the input and calls `on_sql`, which runs it. A quackhole
  link puts a *credential* in the fragment, so `site/app.js` reads the ticket and
  then clears the fragment with `replaceState` before embedding. A ticket is
  base64url and carries no comma of its own; a link with one appended would
  otherwise be a page that runs a stranger's SQL on arrival.
- **Nothing fallible may run inside the shell's `open`.** `site/app.js` proxies
  `AsyncDuckDB.open` so the workbench can rebuild its session after `.open`
  resets the database. That rebuild reinstalls an extension over the network, so
  it can fail or hang -- and `open_command` in `shell.rs` writes the message and
  `return`s *before* reconnecting, leaving the shell holding the connection id
  the reset just destroyed. Every statement after that fails with
  `Invalid connection id` until the page is reloaded. So `rebuild()` is started
  and not awaited, and swallows its own errors.
- **The shell publishes no way to write to its terminal.** `embed()` takes a
  database and four display settings and resolves to `undefined`; the package
  exports it, `getJsDelivrModule` and five version strings, and puts nothing on a
  global. So `typeIntoShell` in `site/app.js` dispatches `keydown` at
  `.xterm-helper-textarea`, which is how the greeting gets typed. Two things make
  that work: xterm reads printable characters off `key`, and dispatching at the
  element does not need focus -- which matters, because at boot the onboarding
  dialog is the modal that should have it.
- **`embed()` resolves before the shell is ready.** It starts the Rust half's
  `configureDatabase` and never awaits it, so the prompt is still being drawn
  when the promise settles and anything typed before it lands is dropped when the
  prompt resets the input. There is no readiness event, and the terminal cannot
  be polled for one either: xterm draws to a canvas wherever WebGL is available,
  which leaves no text in the DOM. `greet()` retries and stops on a flag set in
  `afterQuery`, so what says the greeting arrived is the proxy watching it run.
- **`embed()` hands its resize handler back by assigning `container.onresize`,
  and a `<div>` never fires `resize`.** Nothing calls it, so the terminal keeps
  the width it measured on its first frame and every result wraps there for the
  rest of the session. A `ResizeObserver` that invokes the property is the fix;
  the shell registers no window listener of its own.
- **The shell offers no hook into its terminal, so instrumentation goes through
  the database.** `observed()` in `site/app.js` proxies `runQuery` -- which is
  how the wire still pulses, the rail still redraws after DDL, and a known
  failure still arrives with its remedy. It proxies `open` too, because `.open`
  at the prompt resets the database and drops every attached catalog *and* the
  quack extension. `QuackholeSession` must keep querying through a connection on
  the real `db`, not the proxy, or `refreshSchema` triggers itself.
- **The terminal needs `--term`, not `--data`.** `site/vite.config.js` fetches
  IBM Plex Mono in the latin subsets only, and box-drawing characters live at
  U+2500 in none of them -- so every result table's borders come from whatever
  fallback the browser picks, at metrics that are not the cell width, and render
  as broken dashes.
- **`site/verify.mjs` has to deny WebGL to read the terminal at all.** xterm
  renders to a canvas when WebGL is available and to the DOM when it is not, and
  only the DOM path leaves text in `.xterm-rows`. The renderer is chosen once,
  at embed, from `probablySupportsContext`, `supportsContext` and
  `WebGL2RenderingContext` -- all three have to be defeated in an init script.
  It also clears the screen before each statement, because the terminal scrolls
  and earlier rows leave the DOM entirely.
- **A dedicated worker inherits its page's COEP.** Anything a dev-server
  middleware in `site/vite.config.js` answers itself has to send the isolation
  headers, because it short-circuits the middleware Vite applies
  `server.headers` with. Miss it and `qh-worker.js` is fetched, is 200, and
  still refuses to start -- with an error event carrying no message.
- **Inline Vite config is deep-merged into the config file, so `{}` does not
  clear anything.** `verify.mjs --sw` has to strip the isolation headers to
  exercise the service worker path; passing `preview: { headers: {} }` leaves
  both headers in place and the run quietly proves nothing. Mutating in a
  plugin's `config` hook is what actually removes them.
- **The demo's claim is that `web/` is unmodified, so the connection model has
  to live there.** `web/session.js` owns attach, detach, the connection list and
  the `duckdb_databases()` reconcile; `site/app.js` is a view and holds no model
  of its own. Anything about holding several remotes that ends up in `site/` is
  in the wrong place -- it makes the demo a lookalike rather than evidence.
- **`web/`, `public/coi-serviceworker.js` and the duckdb-wasm bundles are
  copied, never bundled.** `VERBATIM` in `site/vite.config.js` is the list, and
  `CLIENT` in `npm/build.mjs` is the same list for the npm package -- two
  callers, both copying, which is what makes what the demo proves true of what
  the package ships. `qh-worker.js` reaches its siblings through
  `importScripts('./protocol.js')` at runtime, which no content hash survives,
  and `coi-serviceworker.js` registers itself by `document.currentScript.src`,
  so a move into `assets/` would scope the service worker to `assets/` and
  silently stop it controlling the page.
- **`web/wasm/.gitignore` is `*`, and npm falls back to a `.gitignore` inside
  the package.** Copying it into `npm/dist/web/wasm/` drops the entire transport
  from the tarball, and the result installs, imports, and 404s for its wasm
  inside a worker -- which the browser reports as a CORS failure, because the
  404 response carries no `Access-Control-Allow-Origin`. `npm/build.mjs` filters
  it out on the way in.
- **A DuckDB extension file must be named `quackhole.duckdb_extension`.** DuckDB
  derives the entrypoint symbol it looks for from the basename, so a copy named
  anything else fails at `LOAD` with "did not contain the expected entrypoint
  function '<basename>_duckdb_cpp_init'" -- which does not sound like a filename
  problem. The CLI's extension cache therefore keys by directory
  (`<cache>/<version>/<platform>/quackhole.duckdb_extension`), never by
  filename.
- **The npm version is derived from `crates/Cargo.toml`, not maintained.**
  `npm/bin/quackhole.js` resolves the GitHub release tag it downloads from out
  of its own `package.json`, so a drifted npm version fetches a binary the CLI
  was not written for. npm and GitHub releases are two publishing surfaces and
  nothing else catches it. `node npm/build.mjs --check` asserts they agree; see
  `docs/UPDATING.md`.
