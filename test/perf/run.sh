#!/usr/bin/env bash
# This laptop and one exe.dev VM, one serving a DuckDB over iroh and the other
# querying it, for a fixed stretch of wall clock. Prints a
# latency/throughput/reliability summary and leaves the raw CSV behind.
#
#   test/perf/run.sh                       # 10 min; creates a VM, destroys it after
#   test/perf/run.sh --duration 3600       # an hour
#   test/perf/run.sh --vm <name>           # against a VM that already exists
#   test/perf/run.sh --local server        # laptop serves, VM queries (the NAT'd case)
#   test/perf/run.sh --region fra          # place the VM across the Atlantic
#   test/perf/run.sh --pull-rows 5000,25000,100000   # sweep transfer sizes
#   test/perf/run.sh --keep                # leave the VM up, print the reuse command
#
# Costs money: unless --vm names an existing one, it creates a billed VM and
# destroys it on exit, including on Ctrl-C. --keep opts out and prints the
# `ssh exe.dev rm` to undo that.
set -euo pipefail

# Resolved before the cd, because --help reads this file back and $0 is
# relative to where it was invoked from.
SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
cd "$(dirname "$0")"
REPO_ROOT=$(cd ../.. && pwd)

DURATION=600
INTERVAL=5
ROWS=200000
PULL_ROWS=50000
PUSH_ROWS=5000
TIMEOUT=90
CPU=2
MEMORY=4GB
KEEP=0
VM=""
REGION=""
LOCAL_ROLE=client
QH_VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$REPO_ROOT/crates/Cargo.toml" | head -1)
# Pinned, not ranged, and to the same release npm/package.json pins: its
# version() is v1.5.5, the duckdb_version the extension is built against, so the
# ABI match is true by construction rather than by luck.
NODE_API="1.5.5-r.4"
LOCAL_DIR="$REPO_ROOT/test/perf/.local"
OUT="$REPO_ROOT/test/perf/results"

while [ $# -gt 0 ]; do
  case "$1" in
    --duration) DURATION=$2; shift 2 ;;
    --interval) INTERVAL=$2; shift 2 ;;
    --rows) ROWS=$2; shift 2 ;;
    --pull-rows) PULL_ROWS=$2; shift 2 ;;
    --push-rows) PUSH_ROWS=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --cpu) CPU=$2; shift 2 ;;
    --memory) MEMORY=$2; shift 2 ;;
    --region) REGION=$2; shift 2 ;;
    --vm) VM=$2; shift 2 ;;
    --local) LOCAL_ROLE=$2; shift 2 ;;
    --version) QH_VERSION=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$SELF"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
case "$LOCAL_ROLE" in client|server) ;; *) echo "--local takes 'client' or 'server'" >&2; exit 1 ;; esac

# --pull-rows takes a comma list to sweep sizes. A size past the seeded row count
# is not an error anywhere downstream -- LIMIT just returns fewer rows -- but the
# client bills `bytes` as size x 88, so the sweep would report a transfer larger
# than the one it made, and two points past the seed would report different
# sizes for the same pull.
MAX_PULL=$(echo "$PULL_ROWS" | tr ',' '\n' | sort -n | tail -1)
if [ "$MAX_PULL" -gt "$ROWS" ]; then
  echo "--pull-rows tops out at $MAX_PULL but only $ROWS rows are seeded; raise --rows" >&2
  exit 1
fi

say() { printf '\n== %s\n' "$*"; }
SSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=15"
# The VM may have installed its own node under $HOME rather than upgrading the
# system one, so every remote node call goes through this.
RNODE='PATH=$HOME/.local/node/bin:$PATH'

RUN_ID=$(date +%s | tail -c 7)
TOKEN="perf-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"

if [ -n "$VM" ]; then
  CREATED=0
else
  VM="qhperf-$RUN_ID"
  CREATED=1
fi

# exe.dev places VMs from an account-wide preference rather than a flag on
# `new`, so a region means set, create, restore -- restored on the trap too, so
# an interrupted run does not leave the account pointing somewhere else.
ORIG_REGION=""
if [ -n "$REGION" ]; then
  [ "$CREATED" = 1 ] || { echo '--region and --vm are mutually exclusive' >&2; exit 1; }
  ORIG_REGION=$(ssh -o BatchMode=yes exe.dev whoami --json |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).region))')
fi

# --- teardown ----------------------------------------------------------------
#
# Trapped rather than tacked onto the end: a failed setup, a hung client and a
# Ctrl-C at minute three all leave a billed VM running otherwise.
LOCAL_SERVER_PID=""
cleanup() {
  set +e
  [ -n "$LOCAL_SERVER_PID" ] && kill "$LOCAL_SERVER_PID" 2>/dev/null
  [ -n "${SERVING:-}" ] && $SSH "$VM.exe.xyz" "pkill -f 'node server[.]mjs'" >/dev/null 2>&1
  [ -n "$ORIG_REGION" ] && ssh -o BatchMode=yes exe.dev set-region "$ORIG_REGION" >/dev/null 2>&1
  if [ "$CREATED" = 1 ] && [ "$KEEP" = 0 ]; then
    say "destroying $VM"
    ssh -o BatchMode=yes exe.dev rm "$VM"
  elif [ "$CREATED" = 1 ]; then
    say "left running -- reuse with: test/perf/run.sh --vm $VM"
    echo "   destroy with: ssh exe.dev rm $VM"
  fi
}
trap cleanup EXIT

# --- the VM ------------------------------------------------------------------
if [ "$CREATED" = 1 ]; then
  say "creating $VM ($CPU cpu, $MEMORY${REGION:+, $REGION})"
  [ -n "$REGION" ] && ssh -o BatchMode=yes exe.dev set-region "$REGION" >/dev/null
  # Value flags take `=`, and the value must not contain a space: ssh joins argv
  # into one string and the far side re-splits it, so `--comment=a b` arrives as
  # a flag plus a positional and `new` rejects the lot.
  ssh -o BatchMode=yes exe.dev new --json "--name=$VM" "--cpu=$CPU" "--memory=$MEMORY" \
    --no-email --tag=qhperf "--comment=quackhole-perf-$RUN_ID" >/dev/null
  echo "   created $VM${REGION:+ in $REGION}"
  if [ -n "$ORIG_REGION" ]; then
    ssh -o BatchMode=yes exe.dev set-region "$ORIG_REGION" >/dev/null
    ORIG_REGION=""
  fi
fi

# `new` returns before sshd is up, so this is the readiness gate.
printf '   waiting for %s' "$VM"
for _ in $(seq 1 60); do
  $SSH "$VM.exe.xyz" true >/dev/null 2>&1 && { printf ' ok\n'; break; }
  printf '.'; sleep 5
done
$SSH "$VM.exe.xyz" true || { echo "   $VM never came up" >&2; exit 1; }

say 'installing on both sides'
mkdir -p "$LOCAL_DIR"
(
  $SSH "$VM.exe.xyz" 'mkdir -p ~/qhperf'
  scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    setup.sh server.mjs client.mjs "$VM.exe.xyz:~/qhperf/"
  $SSH "$VM.exe.xyz" "QH_VERSION=$QH_VERSION NODE_API=$NODE_API bash ~/qhperf/setup.sh" | sed "s/^/   [vm] /"
) &
REMOTE_SETUP=$!
# The scripts are copied beside the laptop's node_modules rather than run from
# the repo: node resolves a bare import from the importing file's directory, not
# from the cwd, so test/perf/client.mjs cannot see test/perf/.local/node_modules.
cp server.mjs client.mjs "$LOCAL_DIR/"
QHPERF_DIR="$LOCAL_DIR" QH_VERSION=$QH_VERSION NODE_API=$NODE_API bash ./setup.sh | sed 's/^/   [laptop] /'
wait $REMOTE_SETUP

# --- serve -------------------------------------------------------------------
if [ "$LOCAL_ROLE" = server ]; then
  SERVER_SIDE=laptop; CLIENT_SIDE=vm
else
  SERVER_SIDE=vm; CLIENT_SIDE=laptop
fi
say "server on $SERVER_SIDE, client on $CLIENT_SIDE ($ROWS rows)"

if [ "$SERVER_SIDE" = vm ]; then
  # The redirect has to wrap the whole backgrounded group, not just node.
  # `a && b &` backgrounds the list in a subshell that still holds the ssh
  # channel's stdout, so redirecting only the last command leaves ssh waiting on
  # that subshell for as long as the server runs -- which is forever.
  # A server left over from an interrupted run still holds 127.0.0.1:9494, and
  # quackhole_serve reuses whatever is already listening there rather than
  # starting its own -- so the new server would be handed the old one's Quack
  # and print a token that Quack does not accept. The client then fails to
  # attach with an authentication error that names nothing.
  $SSH "$VM.exe.xyz" "pkill -f 'node server[.]mjs'; sleep 1" >/dev/null 2>&1 || true
  $SSH "$VM.exe.xyz" \
    "rm -f ~/qhperf/server.log; { cd ~/qhperf && QH_TOKEN='$TOKEN' setsid nohup \
     env $RNODE node server.mjs --rows $ROWS; } > ~/qhperf/server.log 2>&1 < /dev/null &"
  SERVING=1
  SERVER_LOG="ssh:$VM"
  ticket_line() { $SSH "$VM.exe.xyz" "grep -m1 '^QHPERF_TICKET ' ~/qhperf/server.log 2>/dev/null" || true; }
  served_line() { $SSH "$VM.exe.xyz" "grep -m1 '^QHPERF_SERVED ' ~/qhperf/server.log" || true; }
  dump_log() { $SSH "$VM.exe.xyz" 'tail -30 ~/qhperf/server.log'; }
else
  rm -f "$LOCAL_DIR/server.log"
  ( cd "$LOCAL_DIR" && QHPERF_DIR="$LOCAL_DIR" QH_TOKEN="$TOKEN" \
      node "$LOCAL_DIR/server.mjs" --rows "$ROWS" > "$LOCAL_DIR/server.log" 2>&1 ) &
  LOCAL_SERVER_PID=$!
  ticket_line() { grep -m1 '^QHPERF_TICKET ' "$LOCAL_DIR/server.log" 2>/dev/null || true; }
  served_line() { grep -m1 '^QHPERF_SERVED ' "$LOCAL_DIR/server.log" 2>/dev/null || true; }
  dump_log() { tail -30 "$LOCAL_DIR/server.log"; }
fi

# quackhole_serve blocks until the endpoint learns its home relay -- a ticket
# minted before then omits the relay and sends the peer to pkarr, which
# routinely has not seen a server this new. So this waits rather than assuming.
TICKET=""
for _ in $(seq 1 60); do
  TICKET=$(ticket_line | cut -d' ' -f2)
  [ -n "$TICKET" ] && break
  sleep 2
done
if [ -z "$TICKET" ]; then
  echo '   the server never printed a ticket:' >&2
  dump_log >&2 || true
  exit 1
fi
served_line | cut -d' ' -f2- | sed 's/^/   /'
echo "   ticket ${TICKET:0:24}… (${#TICKET} chars)"

# --- measure -----------------------------------------------------------------
mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
CSV="$OUT/$STAMP.csv"
say "running the client for ${DURATION}s"

if [ "$CLIENT_SIDE" = laptop ]; then
  QHPERF_DIR="$LOCAL_DIR" node "$LOCAL_DIR/client.mjs" --ticket "$TICKET" \
    --duration "$DURATION" --interval "$INTERVAL" --pull-rows "$PULL_ROWS" --push-rows "$PUSH_ROWS" \
    --timeout "$TIMEOUT" --out "$CSV" 2>&1 | sed 's/^/   /' || echo '   client exited non-zero; keeping whatever it wrote' >&2
else
  $SSH "$VM.exe.xyz" \
    "cd ~/qhperf && env $RNODE node client.mjs --ticket '$TICKET' \
     --duration $DURATION --interval $INTERVAL --pull-rows $PULL_ROWS --push-rows $PUSH_ROWS \
     --timeout $TIMEOUT" \
    2>&1 | sed 's/^/   /' || echo '   client exited non-zero; keeping whatever it wrote' >&2
  scp -q -o BatchMode=yes "$VM.exe.xyz:~/qhperf/results.csv" "$CSV"
fi

# --- results -----------------------------------------------------------------
[ "$SERVER_SIDE" = vm ] && $SSH "$VM.exe.xyz" 'tail -5 ~/qhperf/server.log' > "$OUT/$STAMP.server.log" 2>/dev/null
say 'summary'
node summarize.mjs "$CSV"
echo "  raw: $CSV"
