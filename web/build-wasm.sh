#!/usr/bin/env bash
#
# Builds the browser transport into web/wasm/.
#
# getrandom's browser backend is selected by a cfg in
# crates/quackhole-web/.cargo/config.toml.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v wasm-pack >/dev/null 2>&1 || {
  echo "need wasm-pack: cargo install wasm-pack" >&2
  exit 1
}

# `ring` compiles C, so this needs a C compiler that can target
# wasm32-unknown-unknown. Apple clang cannot, which is why macOS has to reach
# for Homebrew LLVM; the clang Linux distributions ship already has the target,
# so on CI and on Linux desktops whatever is on PATH is correct.
if [[ "$(uname -s)" == "Darwin" ]]; then
  LLVM="$(brew --prefix llvm)/bin"
  [[ -x "$LLVM/clang" ]] || { echo "need Homebrew LLVM: brew install llvm" >&2; exit 1; }
  export CC="$LLVM/clang" AR="$LLVM/llvm-ar"
else
  export CC="${CC:-clang}" AR="${AR:-llvm-ar}"
  command -v "$CC" >/dev/null 2>&1 || {
    echo "need clang and llvm-ar with a wasm32 target: apt-get install -y clang llvm lld" >&2
    exit 1
  }
fi

cd "$HERE/../crates/quackhole-web"
wasm-pack build --release --target web \
  --out-dir "$HERE/wasm" --out-name quackhole "$@"
