# Shared by the two container roles. Sourced, not executed.

HANDOFF=${HANDOFF:-/handoff}
TOKEN=${QH_TOKEN:-quackhole-docker-token}
QUACK_PORT=9494
# A plain TCP listener that exists only so the client can try to reach the
# server directly. Quack itself binds loopback, so it would refuse a remote
# connection on its own and prove nothing about the network.
PROBE_PORT=9999

log() { printf '[%s] %s\n' "$ROLE" "$*" >&2; }
die() { printf '[%s] FAIL: %s\n' "$ROLE" "$*" >&2; exit 1; }

my_ip() { ip -4 -o addr show scope global | awk 'NR == 1 { split($4, a, "/"); print a[1] }'; }

# Cut the route to the other container. Docker's own inter-network isolation
# cannot be relied on -- OrbStack, for one, deliberately routes between bridge
# networks -- and "the test silently became a LAN test" is the failure mode that
# would make every result here meaningless. A DROP rather than a REJECT, because
# that is what an unreachable internet host looks like.
#
# The client re-checks the result rather than trusting this ran; see client.sh.
isolate_from() {
  local peer=$1
  [[ -n "$peer" ]] || die "QH_PEER_SUBNET is unset -- refusing to run without a network split"
  log "dropping all traffic to and from $peer"
  iptables -A OUTPUT -d "$peer" -j DROP
  iptables -A INPUT  -s "$peer" -j DROP
}

# Simulate a network that lets only TCP out: a captive portal, a corporate
# proxy, a hotel. iroh's QUIC datagrams cannot leave, so the only way through is
# to have a relay carry them over HTTPS. DNS stays open, or nothing resolves at
# all and we would be testing the wrong failure.
block_udp() {
  [[ "${QH_BLOCK_UDP:-0}" == "1" ]] || return 0
  log "blocking outbound UDP except DNS -- relay path is the only one left"
  # Loopback first, and unconditionally. Docker's embedded resolver lives at
  # 127.0.0.11 and is reached through a DNAT that rewrites the port before the
  # filter chain ever sees the packet, so a `--dport 53` rule does not match it
  # and every lookup dies. A captive portal does not block your own loopback
  # either.
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p udp -j DROP
  ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -p udp -j DROP 2>/dev/null || true
}

# Wait for $1 to exist, up to $2 seconds.
wait_for_file() {
  local path=$1 timeout=$2 waited=0
  while [[ ! -s "$path" ]]; do
    ((waited++ < timeout)) || return 1
    sleep 1
  done
}
