#!/usr/bin/env bash
# Bootstrap one side of the perf harness -- either this laptop or an exe.dev VM.
#
# Idempotent: re-running against a warm directory re-checks and exits in a
# second or two, which is what makes `run.sh --vm <existing>` cheap.
set -euo pipefail

QH_VERSION="${QH_VERSION:?QH_VERSION not set}"
NODE_API="${NODE_API:?NODE_API not set}"
DIR="${QHPERF_DIR:-$HOME/qhperf}"

say() { printf '  setup: %s\n' "$*"; }

# DuckDB's platform naming, which is also how the release assets are named.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)   TARGET=linux_amd64; NARCH=x64 ;;
  Linux/aarch64)  TARGET=linux_arm64; NARCH=arm64 ;;
  Darwin/arm64)   TARGET=osx_arm64 ;;
  Darwin/x86_64)  TARGET=osx_amd64 ;;
  *) echo "no quackhole build for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

# --- node --------------------------------------------------------------------
#
# exeuntu ships Node 18 and @duckdb/node-api wants 20+. Installed under $HOME
# rather than through apt so the bootstrap needs no sudo and no package lists,
# and resolved from nodejs.org rather than pinned, because a pinned patch
# release is a 404 waiting to happen. Only on Linux: on a laptop, upgrading the
# user's node behind their back is not this script's business.
# Ahead of the check, not inside the install branch: a VM this script has
# already run on has a good node here and a stale one in /usr/bin, and checking
# before the export re-reports every warm run as an install.
export PATH="$HOME/.local/node/bin:$PATH"
node_major() { command -v node >/dev/null 2>&1 && node -e 'console.log(process.versions.node.split(".")[0])' || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  if [ "$(uname -s)" != "Linux" ]; then
    echo "node 20+ required, found $(node --version 2>/dev/null || echo none)" >&2
    exit 1
  fi
  say 'installing node 22'
  ver=$(curl -fsSL https://nodejs.org/dist/index.json |
    python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.") and r.get("lts")))')
  mkdir -p "$HOME/.local/node"
  curl -fsSL "https://nodejs.org/dist/$ver/node-$ver-linux-$NARCH.tar.xz" |
    tar -xJ -C "$HOME/.local/node" --strip-components=1
fi
say "node $(node --version) on $TARGET"

# --- the extension -----------------------------------------------------------
#
# The release asset, loaded by path, exactly as npm/bin/quackhole.js does -- so
# the binary under test is the one that shipped, not whatever
# community-extensions happens to serve today. The basename must be
# quackhole.duckdb_extension: DuckDB derives the entrypoint symbol it looks for
# from it, and a copy under any other name fails at LOAD talking about
# entrypoints rather than about its name.
mkdir -p "$DIR/ext"
ext="$DIR/ext/quackhole.duckdb_extension"
if [ ! -s "$ext" ]; then
  say "fetching quackhole $QH_VERSION for $TARGET"
  curl -fsSL -o "$ext.part" \
    "https://github.com/smithclay/quackhole/releases/download/v$QH_VERSION/quackhole-$TARGET.duckdb_extension"
  mv "$ext.part" "$ext"
fi
say "extension $(du -h "$ext" | awk '{print $1}')"

# --- the driver --------------------------------------------------------------
cd "$DIR"
if [ ! -d node_modules/@duckdb/node-api ]; then
  say "installing @duckdb/node-api@$NODE_API"
  printf '{"name":"qhperf","private":true,"type":"module"}\n' > package.json
  npm install --no-audit --no-fund --loglevel=error "@duckdb/node-api@$NODE_API"
fi
say "duckdb $(node -e 'import("@duckdb/node-api").then(async m => { const i = await m.DuckDBInstance.create(":memory:"); const c = await i.connect(); console.log((await c.runAndReadAll("SELECT version() v")).getRowObjectsJS()[0].v) })')"
say 'ready'
