# Where the version lives

The extension's version is stated twice and derived everywhere else. Bumping it
means editing exactly these two, in the same commit:

- `description.yml` — `extension.version`, the community-extensions entry.
- `crates/Cargo.toml` — `[workspace.package] version`, which both Rust crates
  inherit.

Derived from those, and not to be edited by hand:

- `web/wasm/package.json` — written by `wasm-pack` out of the crate version.
- The C++ `EXTENSION_VERSION` — set by the build.
- `npm/package.json` — written by `npm/build.mjs` out of `crates/Cargo.toml`.
  `node npm/build.mjs --check` asserts they agree and changes nothing.

The npm one is derived rather than maintained because `npm/bin/quackhole.js`
resolves the GitHub release tag it downloads the extension from out of its own
`package.json`. An npm version that drifted would send `npx quackhole` to a
release whose binaries it was not written for — and since npm and GitHub
releases are two publishing surfaces, nothing else would catch it.

## Cutting a release

Order matters, and it is enforced in
[`release.yml`](../.github/workflows/release.yml): the `npm` job `needs` the
binary upload. `npx quackhole` downloads the extension from the tag's release
assets, so a package on npm before those assets exist fails on first run for as
long as the build matrix takes.

    # bump description.yml and crates/Cargo.toml, then
    node npm/build.mjs        # syncs npm/package.json
    git commit -am 'chore: bump to 0.0.2'
    git tag v0.0.2 && git push --tags

Publishing needs an `NPM_TOKEN` repository secret with publish rights on
`quackhole`. Without it the binaries still publish and only `npx` is missing,
which is the right way round.

# Extension updating 
When cloning this template, the target version of DuckDB should be the latest stable release of DuckDB. However, there 
will inevitably come a time when a new DuckDB is released and the extension repository needs updating. This process goes
as follows:

- Bump submodules
  - `./duckdb` should be set to latest tagged release
  - `./extension-ci-tools` should be set to updated branch corresponding to latest DuckDB release. So if you're building for DuckDB `v1.1.0` there will be a branch in `extension-ci-tools` named `v1.1.0` to which you should check out. 
- Bump versions in `./github/workflows`
  - `duckdb_version` input in `duckdb-stable-build` job in `MainDistributionPipeline.yml` should be set to latest tagged release
  - `duckdb_version` input in `duckdb-stable-deploy` job in `MainDistributionPipeline.yml` should be set to latest tagged release
  - the reusable workflow `duckdb/extension-ci-tools/.github/workflows/_extension_distribution.yml` for the `duckdb-stable-build` job should be set to latest tagged release
  - `duckdb_version` in `release.yml`, both in the `build` job and in the
    `publish` job's `DUCKDB_VERSION` env
- Bump `@duckdb/node-api` in `npm/package.json` to the release whose `version()`
  is that same DuckDB. This one is easy to miss and fails late: `npx quackhole`
  loads a native extension into those bindings, so a mismatch is an ABI error at
  `LOAD` that names neither version. The pin is what makes the match true by
  construction — see the note beside it in `npm/package.json`.

# API changes
DuckDB extensions built with this extension template are built against the internal C++ API of DuckDB. This API is not guaranteed to be stable.
What this means for extension development is that when updating your extensions DuckDB target version using the above steps, you may run into the fact that your extension no longer builds properly.

Currently, DuckDB does not (yet) provide a specific change log for these API changes, but it is generally not too hard to figure out what has changed.

For figuring out how and why the C++ API changed, we recommend using the following resources:
- DuckDB's [Release Notes](https://github.com/duckdb/duckdb/releases)
- DuckDB's history of [Core extension patches](https://github.com/duckdb/duckdb/commits/main/.github/patches/extensions)
- The git history of the relevant C++ Header file of the API that has changed