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
- **The extension is the only thing that mints a ticket.** `MintTicket` in
  `src/quackhole_extension.cpp` builds it; `site/ticket.js` decodes it; nothing
  else may encode one. It exists because `attach_sql` omits the relay URL,
  which a browser cannot do without. The shell script and the page's by-hand
  SQL each used to hand-roll the format, which meant three encoders agreeing on
  a shape none of them owned.
- **`quackhole_serve` blocks until the endpoint learns its home relay**, up to
  `quackhole_relay_wait_ms` (default 10s), because a ticket minted before then
  omits the relay and sends the browser to pkarr, which routinely has not seen
  a server this new. Tests that only want the lifecycle set the setting to 0
  rather than paying the wait per call.
- **The bridge's relay is per-peer, keyed by endpoint id.** `web/bridge-worker.js`
  keeps a map the page fills over a `BroadcastChannel`, because the bridge is
  nested inside the DuckDB worker and cannot be reached by postMessage. The
  `?relay=` query param is only the fallback for a caller with one remote --
  `test/browser` still uses it. Register a peer and wait for the ack *before*
  ATTACH: the dial travels the SharedArrayBuffer path and will otherwise
  overtake the registration.
- **A browser client that omits an optional query param takes a different code
  path.** `test/browser` always passes `timeout`, which is why a
  temporal-dead-zone bug in `shim.js` survived until `site/` left it out.
