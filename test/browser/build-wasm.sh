#!/usr/bin/env bash
#
# Builds the browser transport into public/wasm/.
#
# Apple clang cannot target wasm32-unknown-unknown and `ring` needs a C compiler
# that can, so Homebrew LLVM is required. getrandom's browser backend is selected
# by a cfg in crates/quackhole-web/.cargo/config.toml.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLVM="$(brew --prefix llvm)/bin"

[[ -x "$LLVM/clang" ]] || { echo "need Homebrew LLVM: brew install llvm" >&2; exit 1; }

cd "$HERE/../../crates/quackhole-web"
CC="$LLVM/clang" AR="$LLVM/llvm-ar" \
  wasm-pack build --release --target web \
    --out-dir "$HERE/public/wasm" --out-name quackhole "$@"
