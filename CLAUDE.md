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

`make lifecycle-check`, `test/docker/run.sh`, `test/browser/run.mjs` and
`site/verify.mjs` cover what those cannot; see the READMEs.

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
  server accepts. Pass `target := '127.0.0.1:9495'` for the second. Needed to
  test anything multi-remote locally, which is what `site/verify.mjs` with
  `QH_TICKET2` does.
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
  copied, never bundled.** `VERBATIM` in `site/vite.config.js` is the list.
  `qh-worker.js` reaches its siblings through `importScripts('./protocol.js')`
  at runtime, which no content hash survives, and `coi-serviceworker.js`
  registers itself by `document.currentScript.src`, so a move into `assets/`
  would scope the service worker to `assets/` and silently stop it controlling
  the page.
