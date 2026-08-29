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
