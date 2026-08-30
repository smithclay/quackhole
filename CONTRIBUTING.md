# Contributing

## Build

Needs a Rust toolchain: the iroh transport is a static library linked into an ordinary C++
DuckDB extension.

```sh
git clone --recurse-submodules https://github.com/smithclay/quackhole
cd quackhole
make release
```

Then `./build/release/duckdb`, or `LOAD` the loadable extension from
`build/release/extension/quackhole/quackhole.duckdb_extension`.

## Test

```sh
make test                                  # sqllogictests
make rust-check                            # cargo fmt --check, clippy -D warnings, cargo test
make lifecycle-check                       # database close and fork-after-LOAD

scripts/demo_two_process.sh                # end-to-end, two processes, real relays
QUACKHOLE_LOADABLE=1 scripts/demo_two_process.sh   # same, via the loadable extension

test/docker/run.sh                         # two DuckDBs on networks that cannot reach each other
cd test/browser && npm install && node run.mjs iroh   # a browser against a native server
```

Tests that need the network are gated on `QUACKHOLE_NET_TESTS=1`, so the default suite stays
hermetic:

```sh
cd crates && QUACKHOLE_NET_TESTS=1 cargo test
```

`make lifecycle-check` covers what SQL tests cannot: closing a database with a bound endpoint,
and forking after `LOAD`. Both are hang-class failures, so each scenario runs in a child
process and is judged on whether it *exits*. It needs the Python bindings at the DuckDB
version the extension was built against, which the target derives from the submodule.

`test/docker/run.sh` is the one that tests the actual claim. Both peers run in containers on
separate Docker networks with no route between them, and the client refuses to proceed until
it has confirmed it cannot reach the server by ICMP or TCP — OrbStack routes between bridge
networks by default, which would otherwise let the test pass while measuring loopback. A
second scenario drops outbound UDP at both ends, so iroh must tunnel QUIC over the relay's
HTTPS connection, and the run fails unless `peer_path` comes back `relay`.

See [test/docker/README.md](test/docker/README.md) and
[test/browser/README.md](test/browser/README.md), both explicit about what they do *not*
prove.

## Formatting and lints

Run as pre-commit hooks, so they fail on your machine rather than in the CI matrix:

```sh
brew install prek && prek install
prek run --all-files            # first time, or after changing the config
```

`prek` is a drop-in for `pre-commit` and reads the same `.pre-commit-config.yaml`.

CI's own gates can be run directly. They cover a slightly different set — `format.py` reaches
into `test/`, the hooks reach the C ABI header it does not:

```sh
pip install "black>=24" cmake-format "clang_format==11.0.1"
make format-check
TIDY_BINARY=$(brew --prefix llvm)/bin/clang-tidy make tidy-check
```

## Things that bite

- **clang-format must be exactly 11.0.1.** Newer releases disagree about line breaking and CI
  rejects the result. `prek` pins it.
- **`.clang-format` and `.clang-tidy` are committed symlinks** into the duckdb submodule. CI's
  format-check job never builds, so nothing recreates them there; without them clang-format
  falls back to its LLVM default and demands two-space indent for a tab-indented codebase.
- **`format.py` rewrites a sqllogictest's `# group:`** to match its directory, so a
  hand-written group is a CI failure rather than a preference.
- **`quackhole_routing.test` needs httpfs**, which is not built into this tree, so it skips
  locally and only runs in CI.
- **iroh for wasm needs `default-features = false, features = ["tls-ring"]`.** Dropping
  default features alone compiles `presets::N0` away, and the error names only `N0`.

## Commits

Lowercase conventional commits — see [CLAUDE.md](CLAUDE.md).

## Layout

```
src/                        C++ extension
  quackhole_extension.cpp     entry point, table functions, load-order re-arm
  quackhole_http.cpp          QuackholeHTTPUtil / QuackholeHTTPClient
  quackhole_state.cpp         per-DatabaseInstance state; shuts the core down on close
crates/                     Cargo workspace: one Cargo.lock, one target/
  quackhole-core/             Rust static library (iroh + tokio)
    src/http.rs                 request building and parsing, shared by both clients
    include/quackhole_core.h    hand-written C ABI
  quackhole-web/              the same core built for browsers (wasm-bindgen, relay-only)
web/                        browser client: the XHR shim and its bridge worker
test/docker/                two peers on unroutable networks; the cross-network test
test/browser/               drives the browser client through headless Chromium
```

For why it is shaped this way, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
