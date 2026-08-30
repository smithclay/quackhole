#!/bin/sh
#
# Starts a DuckDB on this machine that a browser can reach, and prints the
# ticket that connects the two.
#
# This is what https://smithclay.github.io/quackhole/ tells a visitor to run.
# It is served from that page as start.sh, and it is meant to be read before it
# is run -- which is why the page says to download it rather than piping it
# into a shell.
#
# What it does, in order: fetch the quackhole extension for this platform (and
# a matching DuckDB CLI, if the one on PATH is the wrong version or absent),
# build a small sample database in a temp directory, start DuckDB serving it
# over iroh, and print the link quackhole_serve() returns.
#
# The link is the whole handoff -- opening it adds this database to the
# workbench and connects. quackhole_serve waits for the home relay and mints
# the ticket itself, so nothing here knows the ticket format.
#
# Nothing is installed outside the temp directory -- not even the DuckDB CLI,
# so no sudo and no PATH changes -- no cryptographic identity is persisted (the
# endpoint is ephemeral), and nothing is left running after Ctrl-C.
#
# POSIX sh on purpose: this runs on whatever a stranger happens to have.
#
# Two overrides exist for developing on this repo, and they are what let the
# script be exercised before any release has been published:
#
#   QH_EXT=build/release/extension/quackhole/quackhole.duckdb_extension
#   QH_DUCKDB=build/release/duckdb

set -eu

REPO="${QH_REPO:-smithclay/quackhole}"
PAGE="${QH_PAGE:-https://smithclay.github.io/quackhole/}"
# The extension ABI is tied to a DuckDB version; a mismatch fails at LOAD with
# a message that does not explain itself, so we check and say so first.
WANT_DUCKDB="${QH_DUCKDB_VERSION:-v1.5.5}"

WORKDIR=""
SERVER_PID=""

die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }
step() { printf '  %s\n' "$*"; }

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$WORKDIR" ] && rm -rf "$WORKDIR" || true
}
trap cleanup EXIT INT TERM

printf '\n  quackhole demo\n  --------------\n\n'

# --- what we need ----------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "Need curl or wget to download the extension."
fi

# --- which build ------------------------------------------------------------
#
# Needed before anything is downloaded: it names both the extension and, if we
# end up fetching one, the DuckDB CLI.

case "$(uname -s)" in
  Darwin) OS=osx ;;
  Linux)  OS=linux ;;
  *)      die "Unsupported platform $(uname -s). On Windows, run this under WSL or Git Bash." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=amd64 ;;
  *)             die "Unsupported architecture $(uname -m)." ;;
esac
PLATFORM="${OS}_${ARCH}"

WORKDIR="$(mktemp -d)"
EXT="$WORKDIR/quackhole.duckdb_extension"

# --- DuckDB ------------------------------------------------------------------
#
# The extension ABI is tied to a DuckDB version, and a mismatch fails at LOAD
# with a message that does not explain itself. So rather than asking for a
# matching CLI and failing when it is absent, fetch one into the temp directory
# and use it for this run only. Nothing is installed, nothing needs sudo, and
# whatever DuckDB the user already had keeps whatever version it had.

duckdb_version_of() {
  "$1" --version 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9][0-9.]*\).*/v\1/p'
}

DUCKDB="${QH_DUCKDB:-}"
if [ -n "$DUCKDB" ]; then
  # An explicit QH_DUCKDB is a developer saying "use this one". Honour it even
  # if the version disagrees, but say so, because that mismatch explains most
  # of the ways the next few lines can fail.
  command -v "$DUCKDB" >/dev/null 2>&1 || [ -x "$DUCKDB" ] ||
    die "QH_DUCKDB is set to '$DUCKDB', which is not executable."
  HAVE="$(duckdb_version_of "$DUCKDB")"
  [ "$HAVE" = "$WANT_DUCKDB" ] ||
    step "note: QH_DUCKDB is $HAVE, the extension is built for $WANT_DUCKDB."
elif command -v duckdb >/dev/null 2>&1 && [ "$(duckdb_version_of duckdb)" = "$WANT_DUCKDB" ]; then
  DUCKDB=duckdb
  step "using the DuckDB $WANT_DUCKDB already on your PATH"
else
  HAVE="$(command -v duckdb >/dev/null 2>&1 && duckdb_version_of duckdb || true)"
  if [ -n "$HAVE" ]; then
    step "your DuckDB is $HAVE and the extension needs $WANT_DUCKDB"
  fi
  command -v unzip >/dev/null 2>&1 ||
    die "Need unzip to unpack the DuckDB CLI, or install DuckDB $WANT_DUCKDB yourself:
  https://duckdb.org/docs/installation/"
  case "$OS" in
    osx)   CLI_ZIP="duckdb_cli-osx-universal.zip" ;;
    linux) CLI_ZIP="duckdb_cli-linux-${ARCH}.zip" ;;
  esac
  step "fetching DuckDB $WANT_DUCKDB into $WORKDIR (nothing is installed)"
  fetch "https://github.com/duckdb/duckdb/releases/download/$WANT_DUCKDB/$CLI_ZIP" "$WORKDIR/duckdb.zip" ||
    die "Could not download the DuckDB CLI for $PLATFORM."
  unzip -oq "$WORKDIR/duckdb.zip" -d "$WORKDIR" || die "Could not unpack the DuckDB CLI."
  DUCKDB="$WORKDIR/duckdb"
  chmod +x "$DUCKDB" 2>/dev/null || true
  [ -x "$DUCKDB" ] || die "The DuckDB CLI did not unpack as expected."
fi

# quackhole_serve reuses a Quack that is already listening rather than starting
# one, so if another DuckDB got there first, the token generated below is NOT
# the token that server accepts. The browser then fails to attach with an
# authentication error that says nothing about the real cause. Catch it here,
# where we can explain it.
port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  else
    # No way to tell. Assume free: a demo that refuses to start is worse than
    # one that hits a rare, explainable failure later.
    return 1
  fi
}

if port_in_use 9494; then
  die "Something is already listening on 127.0.0.1:9494 -- most likely a DuckDB
  still serving from an earlier run of this script.

  quackhole_serve would reuse it instead of starting a fresh Quack, so the token
  below would not be the one it accepts and the browser could not attach. Stop
  that process and run this again."
fi

# --- the extension -----------------------------------------------------------

if [ -n "${QH_EXT:-}" ]; then
  step "using the local extension $QH_EXT"
  cp "$QH_EXT" "$EXT" || die "Could not read $QH_EXT"
else
  URL="https://github.com/$REPO/releases/latest/download/quackhole-$PLATFORM.duckdb_extension"
  step "fetching the extension for $PLATFORM"
  fetch "$URL" "$EXT" || die "Could not download $URL
  If the release has no build for $PLATFORM, see $PAGE for the by-hand path."
fi

# --- the sample database ----------------------------------------------------

TOKEN="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
HOSTNAME_="$(uname -n)"
OS_DESC="$(uname -s) $(uname -m)"
LOG="$WORKDIR/server.log"
FIFO="$WORKDIR/sql"
mkfifo "$FIFO"

step "building a sample database in $WORKDIR"

# DuckDB reads SQL from the FIFO for the life of the process, which is what
# lets us come back and poll for the relay after serving has started. Writing
# the SQL up front and closing stdin would end the process immediately.
"$DUCKDB" -unsigned "$WORKDIR/demo.db" > "$LOG" 2>&1 < "$FIFO" &
SERVER_PID=$!
exec 3> "$FIFO"

cat >&3 <<SQL
.mode list
.headers off
INSTALL quack; LOAD quack;
LOAD '$EXT';

CREATE TABLE laptop_info AS SELECT
  '$HOSTNAME_' AS host, '$OS_DESC' AS os, version() AS duckdb_version, now() AS started_at;

CREATE TABLE events AS SELECT
  range AS id,
  'evt_' || range AS name,
  (['debug', 'info', 'warn', 'error'])[(range % 4) + 1] AS level,
  now()::TIMESTAMP - INTERVAL (range) MINUTE AS ts,
  (range * 7919 % 1000) / 10.0 AS duration_ms
FROM range(5000);

-- A throwaway identity, so the header's promise above holds: without this the
-- extension persists an ed25519 key at ~/.quackhole/key, which outlives the
-- temp directory and this process. It also keeps a stale ticket from an
-- earlier run from dialling successfully and then failing at token auth,
-- since each run now has a different endpoint id. Read when the endpoint
-- binds, so it has to precede the serve call.
SET GLOBAL quackhole_ephemeral = true;

-- The extension bakes in the public workbench; this is what makes QH_PAGE work
-- against a local build. Set unconditionally so the link the script prints and
-- the link the extension mints can never disagree.
SET GLOBAL quackhole_workbench_url = '$PAGE';

-- quackhole_serve waits for the endpoint to learn its home relay and mints the
-- ticket and the workbench link itself, so there is nothing to poll for and no
-- ticket format spelled out here. Captured into a table because serve can only
-- be called once -- calling it again would try to start the accept loop twice.
CREATE TABLE qh AS SELECT * FROM quackhole_serve(token := '$TOKEN');
SELECT 'QH_ROWS ' || count(*) FROM events;
SELECT 'QH_ID ' || endpoint_id FROM qh;
SELECT 'QH_RELAY ' || coalesce(relay_url, '') FROM qh;
SELECT 'QH_URL ' || coalesce(url, '') FROM qh;

-- Dropped once it has been read: a browser lists the remote's tables through
-- sqlite_master, so anything left here shows up in the workbench next to the
-- sample data as though it were part of the demo.
DROP TABLE qh;
SQL

step "starting the endpoint"

# serve blocks internally until the relay is known, so this is waiting on one
# statement rather than polling for a value that arrives late. The bound is
# still generous: the extension gives up on the relay well before this does.
i=0
while [ "$i" -lt 60 ]; do
  grep -q '^QH_URL ' "$LOG" 2>/dev/null && break
  # A LOAD failure means the process is already gone; do not wait out the loop.
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
  i=$((i + 1))
done

ENDPOINT_ID="$(sed -n 's/^QH_ID //p' "$LOG" | head -1)"
RELAY="$(sed -n 's/^QH_RELAY //p' "$LOG" | grep . | head -1 || true)"
URL="$(sed -n 's/^QH_URL //p' "$LOG" | grep . | head -1 || true)"

if [ -z "$URL" ]; then
  printf '\n  DuckDB never reported a usable endpoint. Its output:\n\n' >&2
  sed 's/^/    /' "$LOG" >&2
  exit 1
fi

# The seed runs as ordinary SQL against a background process, so a statement
# that fails does not stop the script -- it just leaves a database with nothing
# in it, and the demo then advertises a connection to an empty laptop. Confirm
# the rows are actually there before handing out a ticket.
ROWS="$(sed -n 's/^QH_ROWS //p' "$LOG" | head -1)"
if [ "$ROWS" != "5000" ]; then
  printf '\n  The sample data did not load (events has %s rows, expected 5000).\n' "${ROWS:-no}" >&2
  printf '  DuckDB said:\n\n' >&2
  sed 's/^/    /' "$LOG" >&2
  exit 1
fi

# --- the link ---------------------------------------------------------------

cat <<BANNER

  Serving as $ENDPOINT_ID
  through $RELAY

  ------------------------------------------------------------------
  Open this link. It adds this database to the workbench and connects:

  $URL
  ------------------------------------------------------------------

  The link carries the token, so treat it like one: anyone holding it
  can query this database until you stop.

  Serving 5,000 rows in 'events'. Ctrl-C to stop.

BANNER

# Hold the process open. The trap tears down DuckDB and the temp directory.
wait "$SERVER_PID"
