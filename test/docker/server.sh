#!/usr/bin/env bash
#
# The "laptop on cafe wi-fi": builds a small database, serves it over iroh, and
# publishes its endpoint id through the shared volume -- which stands in for the
# out-of-band channel a real user would use (Slack, a text message).
set -euo pipefail
ROLE=server
# shellcheck source=lib.sh
source /opt/qh/lib.sh

isolate_from "${QH_PEER_SUBNET:-}"
block_udp

mkdir -p "$HANDOFF"
# A rerun must not let the client pick up the previous run's endpoint id and
# then "succeed" against a server that is no longer there.
rm -f "$HANDOFF"/*

nc -lk 0.0.0.0 "$PROBE_PORT" </dev/null >/dev/null 2>&1 &

log "building the sample database"
# No INTERVAL arithmetic anywhere: it pulls in ICU, which this build does not
# necessarily carry.
duckdb /tmp/server.db -c "
CREATE TABLE logs AS
  SELECT range AS id, 'evt_' || range AS name, range % 7 AS bucket FROM range(1000);
-- 200k rows is ~9 round trips at quack's default fetch batch of 12 chunks
-- (12 x 2048 rows), which is what exercises the fetch loop. The payload is
-- deliberately narrow: we want many round trips, not a big download.
CREATE TABLE wide AS
  SELECT range AS id, repeat('x', 8) AS payload FROM range(200000);
" >/dev/null

log "starting quackhole_serve"
{
  cat <<SQL
.mode list
.headers off
LOAD quack;
LOAD quackhole;
CALL quackhole_serve(token := '$TOKEN');
SELECT 'SERVER_READY', endpoint_id FROM quackhole_status();
SQL
  # The home relay is picked after the endpoint binds, so it is not knowable in
  # the first statement. Feeding a second query down the same pipe a few seconds
  # later asks the same session again -- a separate process would be a different
  # endpoint with a different answer.
  sleep 8
  echo "SELECT 'SERVER_RELAY', relay_url, serving FROM quackhole_status();"
  sleep infinity
} | duckdb /tmp/server.db > /tmp/server.out 2>&1 &

log "waiting for the endpoint id"
for _ in $(seq 1 90); do
  grep -q '^SERVER_READY|' /tmp/server.out 2>/dev/null && break
  sleep 1
done
grep -q '^SERVER_READY|' /tmp/server.out 2>/dev/null || {
  cat /tmp/server.out >&2
  die "server never reported an endpoint id"
}

ENDPOINT_ID="$(awk -F'|' '$1 == "SERVER_READY" { print $2; exit }' /tmp/server.out)"
[[ -n "$ENDPOINT_ID" ]] || die "empty endpoint id"

SERVER_IP="$(my_ip)"
# The client's isolation preflight is built on this address; an empty one would
# turn the check into a no-op and quietly weaken the whole test.
[[ -n "$SERVER_IP" ]] || die "could not determine this container's address"

printf '%s' "$SERVER_IP"     > "$HANDOFF/server_ip"
printf '%s' "$ENDPOINT_ID"   > "$HANDOFF/endpoint_id"
# Written last: it is the flag the client waits on, so everything it reads has
# to already be there.
printf '%s' ready            > "$HANDOFF/ready"
log "endpoint $ENDPOINT_ID at $SERVER_IP"

# Best effort: the client only uses this to check that the relay it will be
# talking to is reachable from its own network.
for _ in $(seq 1 30); do
  if grep -q '^SERVER_RELAY|' /tmp/server.out 2>/dev/null; then
    relay="$(awk -F'|' '$1 == "SERVER_RELAY" { print $2; exit }' /tmp/server.out)"
    # A SQL NULL prints as the four characters NULL, which would otherwise be
    # handed to the client as a URL to curl.
    [[ -n "$relay" && "$relay" != "NULL" ]] \
      && printf '%s' "$relay" > "$HANDOFF/relay_url" && log "home relay $relay"
    break
  fi
  sleep 1
done

# Stay up for the client, and surface the server's view of the session at the end.
tail -f /tmp/server.out
