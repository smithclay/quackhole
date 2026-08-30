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

`make lifecycle-check`, `test/docker/run.sh` and `test/browser/run.mjs` cover
what those cannot; see the READMEs.

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
