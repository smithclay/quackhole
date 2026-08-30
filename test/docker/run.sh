#!/usr/bin/env bash
#
# Cross-network verification for quackhole. See README.md in this directory.
#
#   test/docker/run.sh                 # both scenarios
#   test/docker/run.sh open            # normal egress; reports whichever path iroh picked
#   test/docker/run.sh relay-only      # UDP blocked both ends; the relay is the only way through
#   test/docker/run.sh idle            # attach, sit idle 15 min, query again
#   test/docker/run.sh --no-build open
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

BUILD=1
SCENARIOS=()
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    open|relay-only|idle) SCENARIOS+=("$arg") ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
# `idle` is not in the default set -- it takes a quarter of an hour.
[[ ${#SCENARIOS[@]} -eq 0 ]] && SCENARIOS=(open relay-only)

command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  || { echo "the docker daemon is not running" >&2; exit 1; }

compose() { docker compose "$@"; }

if [[ "$BUILD" == "1" ]]; then
  echo "==> building the image (first run compiles DuckDB; later runs are cached)"
  compose build server
fi

run_scenario() {
  local name=$1
  echo
  echo "############################################################"
  echo "# scenario: $name"
  echo "############################################################"

  case "$name" in
    open)       export QH_BLOCK_UDP=0 QH_EXPECT_PATH=  QH_IDLE_SECONDS=0 ;;
    relay-only) export QH_BLOCK_UDP=1 QH_EXPECT_PATH=relay QH_IDLE_SECONDS=0 ;;
    idle)       export QH_BLOCK_UDP=0 QH_EXPECT_PATH=  QH_IDLE_SECONDS="${QH_IDLE_SECONDS:-900}" ;;
  esac

  # A stale handoff volume would let the client read a previous run's endpoint
  # id, so every scenario starts from nothing.
  compose down -v --remove-orphans >/dev/null 2>&1 || true

  compose up -d server
  echo "==> networks:"
  for net in cafe office; do
    printf '    %-8s %s\n' "$net" \
      "$(docker network inspect "quackhole-nat_$net" \
         --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null)"
  done

  local rc=0
  compose run --rm -T client || rc=$?

  echo
  echo "==> server-side session log:"
  compose logs --no-log-prefix server 2>/dev/null | tail -20 | sed 's/^/    /'

  compose down -v --remove-orphans >/dev/null 2>&1 || true

  if [[ "$rc" == "0" ]]; then
    echo "==> scenario $name: PASS"
  else
    echo "==> scenario $name: FAIL (exit $rc)"
  fi
  return "$rc"
}

overall=0
declare -a summary=()
for s in "${SCENARIOS[@]}"; do
  if run_scenario "$s"; then summary+=("PASS $s"); else summary+=("FAIL $s"); overall=1; fi
done

echo
echo "==> summary"
printf '    %s\n' "${summary[@]}"
exit "$overall"
