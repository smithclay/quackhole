PROJ_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

# Configuration of extension
EXT_NAME=quackhole
EXT_CONFIG=${PROJ_DIR}extension_config.cmake

# Include the Makefile from extension-ci-tools
include extension-ci-tools/makefiles/duckdb_extension.Makefile
# extension-ci-tools has no Rust gate, so this is ours. Same checks the prek
# hook runs, for anyone who would rather type make. Defined after the include
# so it does not become the default goal.
.PHONY: rust-check
rust-check:
	cd crates && cargo fmt --all --check
	cd crates && cargo clippy --all-targets -- -D warnings
	cd crates && cargo test

# Runtime lifecycle checks: database close with a bound endpoint, and fork after
# LOAD. Both are hang-class failures, so each scenario runs in a child process
# and is judged on whether it exits. Kept out of `make test` because it needs the
# Python bindings at the DuckDB version the extension was built against -- which
# this target derives from the submodule rather than making you look it up.
.PHONY: lifecycle-check
lifecycle-check:
	python3 -m venv build/lifecycle-venv
	build/lifecycle-venv/bin/pip install -q "duckdb==$$(git -C duckdb describe --tags | sed 's/^v//')"
	build/lifecycle-venv/bin/python test/manual/test_runtime_lifecycle.py
