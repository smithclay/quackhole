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
# What it does, in order: fetch the quackhole extension for this platform,
# build a small sample database in a temp directory, start DuckDB serving it
# over iroh, wait until the endpoint has learned its home relay, and print a
# ticket carrying the endpoint id, that relay, and a freshly generated token.
#
# Nothing is installed outside the temp directory, and nothing is left running
# after Ctrl-C.
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

DUCKDB="${QH_DUCKDB:-duckdb}"
command -v "$DUCKDB" >/dev/null 2>&1 ||
  die "No '$DUCKDB' on PATH. Install the CLI first: https://duckdb.org/docs/installation/"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "Need curl or wget to download the extension."
fi

HAVE_DUCKDB="v$("$DUCKDB" --version 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9][0-9.]*\).*/\1/p')"
if [ "$HAVE_DUCKDB" != "$WANT_DUCKDB" ]; then
  step "note: your DuckDB is $HAVE_DUCKDB, the extension is built for $WANT_DUCKDB."
  step "      if LOAD fails below, that mismatch is why."
  printf '\n'
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

# --- which build ------------------------------------------------------------

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

CALL quackhole_serve(token := '$TOKEN');
SELECT 'QH_ROWS ' || count(*) FROM events;
SELECT 'QH_ID ' || endpoint_id FROM quackhole_status();
SQL

step "starting the endpoint"

# The home relay is not known the instant an endpoint binds -- it is learned a
# moment later -- and a ticket without it sends the browser to pkarr, which
# routinely has not seen a server this new. So poll rather than read once.
ENDPOINT_ID=""
RELAY=""
i=0
while [ "$i" -lt 60 ]; do
  if grep -q '^QH_ID ' "$LOG" 2>/dev/null; then
    ENDPOINT_ID="$(sed -n 's/^QH_ID //p' "$LOG" | head -1)"
  fi
  if [ -n "$ENDPOINT_ID" ]; then
    printf "SELECT 'QH_RELAY ' || coalesce(relay_url, '') FROM quackhole_status();\n" >&3
    sleep 1
    RELAY="$(sed -n 's/^QH_RELAY //p' "$LOG" | grep . | head -1 || true)"
    [ -n "$RELAY" ] && break
  else
    sleep 1
  fi
  # A LOAD failure means the process is already gone; do not wait out the loop.
  kill -0 "$SERVER_PID" 2>/dev/null || break
  i=$((i + 1))
done

if [ -z "$ENDPOINT_ID" ] || [ -z "$RELAY" ]; then
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

# --- the ticket -------------------------------------------------------------

# qh1_ + base64url(JSON). Kept byte-identical to site/ticket.js, which decodes
# it. tr strips the padding and swaps the two alphabet characters that are not
# URL-safe; base64 wraps lines on some platforms and not others, hence tr -d.
b64url() { base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='; }
TICKET="qh1_$(printf '%s' \
  "{\"e\":\"$ENDPOINT_ID\",\"r\":\"$RELAY\",\"t\":\"$TOKEN\"}" | b64url)"

cat <<BANNER

  Serving as $ENDPOINT_ID
  through $RELAY

  ------------------------------------------------------------------
  Open this link, or paste the ticket into the page:

  $PAGE#$TICKET

  $TICKET
  ------------------------------------------------------------------

  The ticket carries the token, so treat it like one: anyone holding it
  can query this database until you stop.

  Serving 5,000 rows in 'events'. Ctrl-C to stop.

BANNER

# Hold the process open. The trap tears down DuckDB and the temp directory.
wait "$SERVER_PID"
