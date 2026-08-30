#!/usr/bin/env bash
#
# Two-process end-to-end demo: one DuckDB serves its database over iroh, another
# ATTACHes it by endpoint id and queries it.
#
# Two processes rather than one because that is the real topology -- and because
# a single process attaching to its own quack_serve would prove nothing about
# the transport.
#
# Usage:
#   scripts/demo_two_process.sh              # use the built ./build/release/duckdb
#   QUACKHOLE_LOADABLE=1 scripts/demo_two_process.sh   # stock duckdb + LOAD the .duckdb_extension
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="$(mktemp -d)"
TOKEN="quackhole-demo-token"
SERVER_LOG="$WORKDIR/server.out"
SERVER_PID=""

cleanup() {
  # Kill the whole process group: $! after a pipeline names only the last
  # command (duckdb), so killing it alone orphans the `sleep` feeding its stdin.
  [[ -n "$SERVER_PID" ]] && kill -- "-$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# Static build by default; QUACKHOLE_LOADABLE exercises the dlopen path instead,
# which is what users actually get and what CI ships.
if [[ "${QUACKHOLE_LOADABLE:-0}" == "1" ]]; then
  DUCKDB_BIN="$(command -v duckdb)"
  EXT_PATH="$ROOT/build/release/extension/quackhole/quackhole.duckdb_extension"
  [[ -f "$EXT_PATH" ]] || { echo "missing $EXT_PATH -- run 'make release' first" >&2; exit 1; }
  PRELUDE="LOAD '$EXT_PATH';"
else
  DUCKDB_BIN="$ROOT/build/release/duckdb"
  [[ -x "$DUCKDB_BIN" ]] || { echo "missing $DUCKDB_BIN -- run 'make release' first" >&2; exit 1; }
  PRELUDE="LOAD quackhole;"
fi

echo "==> building sample database"
"$DUCKDB_BIN" -unsigned "$WORKDIR/server.db" -c "
CREATE TABLE logs AS
  SELECT range AS id, 'evt_' || range AS name, TIMESTAMP '2026-08-29 12:00:00' - INTERVAL (range) MINUTE AS ts
  FROM range(1000);
" >/dev/null

echo "==> starting server"
# Keep stdin open for the process lifetime: the DuckDB CLI exits when stdin
# closes, which would take the serving threads with it.
# set -m + a subshell puts the pipeline in its own process group so cleanup can
# take down both the CLI and the `sleep` feeding it.
set -m
( {
  cat <<SQL
INSTALL quack; LOAD quack;
$PRELUDE
CALL quackhole_serve(token := '$TOKEN');
SELECT 'SERVER_READY ' || endpoint_id AS marker FROM quackhole_status();
SQL
  sleep 300
} | "$DUCKDB_BIN" -unsigned "$WORKDIR/server.db" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
) & SERVER_PID=$!

echo "==> waiting for the endpoint id"
ENDPOINT_ID=""
for _ in $(seq 1 60); do
  if grep -q 'SERVER_READY' "$SERVER_LOG" 2>/dev/null; then
    ENDPOINT_ID="$(grep -o 'SERVER_READY [a-z0-9]*' "$SERVER_LOG" | head -1 | awk '{print $2}')"
    [[ -n "$ENDPOINT_ID" ]] && break
  fi
  sleep 1
done

if [[ -z "$ENDPOINT_ID" ]]; then
  echo "server never reported an endpoint id:" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi
echo "    endpoint: $ENDPOINT_ID"

echo "==> client attaching over iroh"
"$DUCKDB_BIN" -unsigned -c "
INSTALL quack; LOAD quack;
$PRELUDE
-- Both processes run on this machine and would otherwise load the same
-- ~/.quackhole/key, share one endpoint id, and iroh would refuse the dial.
-- GLOBAL because the dial path reads database-level settings, not session ones.
SET GLOBAL quackhole_ephemeral = true;
CREATE SECRET (TYPE quack, TOKEN '$TOKEN');
ATTACH 'quack:${ENDPOINT_ID}.iroh:9494' AS remote;
SELECT count(*) AS rows_over_iroh FROM remote.logs;
SELECT id, name FROM remote.logs WHERE id < 3 ORDER BY id;
FROM quackhole_status();
"

echo "==> server-side view"
grep -c 'SERVER_READY' "$SERVER_LOG" >/dev/null && echo "    server still up"
echo "==> OK"
