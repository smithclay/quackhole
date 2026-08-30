#!/usr/bin/env bash
#
# The "DuckDB somewhere else": proves it cannot reach the server by any ordinary
# route, then attaches over iroh anyway and times the queries.
set -euo pipefail
ROLE=client
# shellcheck source=lib.sh
source /opt/qh/lib.sh

BUDGET_MS=${QH_BUDGET_MS:-1000}
EXPECT_PATH=${QH_EXPECT_PATH:-}
# Seconds to hold the session open and untouched before querying again.
IDLE=${QH_IDLE_SECONDS:-0}

isolate_from "${QH_PEER_SUBNET:-}"
block_udp

log "waiting for the server to publish its endpoint id"
wait_for_file "$HANDOFF/ready" "${QH_WAIT:-180}" || die "server never became ready"
ENDPOINT_ID="$(cat "$HANDOFF/endpoint_id")"
SERVER_IP="$(cat "$HANDOFF/server_ip")"

# ---------------------------------------------------------------------------
# Preflight. Without this the whole run is worthless: if the two networks were
# reachable, iroh would find a direct path and we would be testing loopback with
# extra steps.
# ---------------------------------------------------------------------------
log "preflight: server is at $SERVER_IP, and must be unreachable from here"

# Resolution is not reachability, and Docker's embedded DNS has changed its
# cross-network behaviour before, so this is reported rather than enforced. The
# ICMP and TCP checks below are the ones that actually decide.
if getent hosts server >/dev/null 2>&1; then
  log "note: 'server' resolves by name; reachability is still checked below"
fi

if ping -c 1 -W 2 "$SERVER_IP" >/dev/null 2>&1; then
  die "$SERVER_IP answers ICMP -- the networks are not isolated"
fi

if timeout 5 bash -c "exec 3<>/dev/tcp/$SERVER_IP/$PROBE_PORT" 2>/dev/null; then
  die "TCP $SERVER_IP:$PROBE_PORT connected -- the networks are not isolated"
fi
log "preflight: no route to the server (no DNS, no ICMP, no TCP)"

# Distinguishes "isolated from the server" from "no network at all", which would
# otherwise look identical when the query later fails.
EGRESS="$(cat "$HANDOFF/relay_url" 2>/dev/null || true)"
[[ "$EGRESS" == "NULL" ]] && EGRESS=""
EGRESS="${EGRESS:-${QH_EGRESS_PROBE:-https://usw1-1.relay.n0.iroh.link./}}"
if curl -sS --max-time 20 -o /dev/null "$EGRESS" 2>/dev/null; then
  log "preflight: internet egress works ($EGRESS reachable)"
else
  log "WARNING: could not reach $EGRESS -- if the query fails, suspect egress, not iroh"
fi

# ---------------------------------------------------------------------------
# The actual test.
# ---------------------------------------------------------------------------
cat > /tmp/head.sql <<SQL
.mode list
.headers off
LOAD quack;
LOAD quackhole;
SET GLOBAL quackhole_ephemeral = true;
CREATE SECRET (TYPE quack, TOKEN '$TOKEN');
.timer on
SELECT 'MARK:attach';
ATTACH 'quack:$ENDPOINT_ID.iroh:$QUACK_PORT' AS remote;
SELECT 'MARK:count_cold';
SELECT 'VAL:logs_count', count(*) FROM remote.logs;
SELECT 'MARK:count_warm_1';
SELECT 'VAL:logs_count_again', count(*) FROM remote.logs;
SELECT 'MARK:sum_warm';
SELECT 'VAL:logs_sum', sum(id) FROM remote.logs;
SELECT 'MARK:point_lookup';
SELECT 'VAL:point', name FROM remote.logs WHERE id = 42;
SELECT 'MARK:big_scan';
SELECT 'VAL:wide_bytes', sum(length(payload)) FROM remote.wide;
SQL

: > /tmp/tail.sql
if [[ "$IDLE" -gt 0 ]]; then
  # A read alone would not settle anything: if quack served it from a local
  # cache the session could be dead and the answer still correct. A write has to
  # reach the server, so it is the part that actually proves the tunnel survived.
  cat >> /tmp/tail.sql <<'SQL'
SELECT 'MARK:after_idle_read';
SELECT 'VAL:logs_count_after_idle', count(*) FROM remote.logs;
SELECT 'MARK:after_idle_write';
CREATE TABLE remote.idle_probe AS SELECT 42 AS n;
SELECT 'VAL:idle_probe', n FROM remote.idle_probe;
SQL
fi
cat >> /tmp/tail.sql <<'SQL'
.timer off
SELECT 'PEER', endpoint_id, peer_id, peer_path, peer_direction, relay_url FROM quackhole_status();
SQL

log "attaching quack:$ENDPOINT_ID.iroh:$QUACK_PORT"
START=$(date +%s)
# Fed down a pipe rather than from a file so the idle wait happens *inside* one
# DuckDB session. Reopening the CLI would prove nothing: the question is whether
# an ATTACH that has sat untouched still works, not whether a fresh one does.
if ! {
      cat /tmp/head.sql
      if [[ "$IDLE" -gt 0 ]]; then
        log "holding the session open and idle for ${IDLE}s"
        sleep "$IDLE"
      fi
      cat /tmp/tail.sql
     } | duckdb > /tmp/client.out 2>&1; then
  cat /tmp/client.out >&2
  die "the client session failed"
fi
log "session finished in $(( $(date +%s) - START ))s"

# awk rather than grep|cut: grep exits non-zero when a value is missing, and
# under `pipefail` that would abort the script instead of reporting a FAIL.
val() { awk -F'|' -v key="VAL:$1" '$1 == key { print $2; exit }' /tmp/client.out; }

# A statement's own marker is timed too, so each label is followed by two
# timings: the marker's, then the statement we care about.
timings() {
  awk -F'real ' '
    /^MARK:/    { split($0, a, ":"); label = a[2]; seen = 0; next }
    /Run Time/  { if (label != "" && ++seen == 2) { split($2, b, " "); print label, b[1]; label = "" } }
  ' /tmp/client.out
}

echo
echo "=== results ==================================================="
cat /tmp/client.out
echo "==============================================================="
echo

fail=0
check() {
  local name=$1 want=$2 got
  got="$(val "$name")"
  if [[ "$got" == "$want" ]]; then
    printf '  ok    %-20s = %s\n' "$name" "$got"
  else
    printf '  FAIL  %-20s = %s (want %s)\n' "$name" "${got:-<missing>}" "$want"
    fail=1
  fi
}

echo "correctness:"
check logs_count       1000
check logs_count_again 1000
check logs_sum         499500
check point            evt_42
check wide_bytes       1600000
if [[ "$IDLE" -gt 0 ]]; then
  check logs_count_after_idle 1000
  check idle_probe 42
fi

echo
echo "latency (seconds, as reported by the DuckDB CLI timer):"
timings | while read -r label secs; do printf '  %-18s %8.3f\n' "$label" "$secs"; done

WARM="$(timings | awk '$1 == "count_warm_1" { print $2 }')"
if [[ -n "$WARM" ]]; then
  over=$(awk -v w="$WARM" -v b="$BUDGET_MS" 'BEGIN { print (w * 1000 > b) ? 1 : 0 }')
  ms=$(awk -v w="$WARM" 'BEGIN { printf "%.0f", w * 1000 }')
  if [[ "$over" == "1" ]]; then
    echo "  BUDGET: warm query ${ms}ms exceeds ${BUDGET_MS}ms"
    if [[ "${QH_ENFORCE_BUDGET:-0}" == "1" ]]; then fail=1; fi
  else
    echo "  BUDGET: warm query ${ms}ms is within ${BUDGET_MS}ms"
  fi
else
  echo "  BUDGET: no warm timing captured"
fi

PATH_USED="$(awk -F'|' '$1 == "PEER" { print $4; exit }' /tmp/client.out)"
echo
echo "transport: peer_path=${PATH_USED:-<none>}"
if [[ -n "$EXPECT_PATH" && "$PATH_USED" != "$EXPECT_PATH" ]]; then
  echo "  FAIL  expected peer_path=$EXPECT_PATH"
  fail=1
fi

exit "$fail"
