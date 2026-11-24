#!/usr/bin/env bash
# Rebuild and restart the Jhola container, keeping exactly one previous build.
#
#   scripts/deploy.sh              tests, build, restart, health check, tidy
#   SKIP_TESTS=1 scripts/deploy.sh
#
# The previous image is kept as compareprice:previous. If the new container
# isn't healthy within HEALTH_WAIT seconds, the previous image is started again
# and the script exits 1. After a healthy start, only untagged leftovers of
# this project's builds are removed (label org.opencontainers.image.title=jhola).
# The data folder, volumes and other projects' images are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=${CONTAINER:-basket}
IMAGE=compareprice
DATA=${BASKET_DATA:-$HOME/basket-data}
PORTS=${BASKET_PORTS:-7777:7777}
HEALTH_WAIT=${HEALTH_WAIT:-60}
LABEL='org.opencontainers.image.title=jhola'

say() { printf '[deploy] %s\n' "$*"; }

start() {
  docker run -d --name "$NAME" --restart unless-stopped -p "$PORTS" \
    -v "$DATA:/data" -e TZ=Asia/Kolkata --shm-size=1g "$1" >/dev/null
}

healthy() {
  local port=${PORTS##*:}
  for _ in $(seq 1 "$HEALTH_WAIT"); do
    if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

[ -d "$DATA" ] || { say "data folder $DATA not found; set BASKET_DATA"; exit 1; }

if [ "${SKIP_TESTS:-}" != 1 ]; then
  say 'npm test'
  npm test --silent >/tmp/jhola-deploy-test.log 2>&1 || { say 'tests failed, nothing deployed (see /tmp/jhola-deploy-test.log)'; exit 1; }
fi

# Don't restart in the middle of a search: wait for the queue to drain.
port=${PORTS##*:}
for _ in $(seq 1 120); do
  h=$(curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null || true)
  case "$h" in *'"busy":true'*|*'"queued":'[1-9]*) say 'a job is running; waiting…'; sleep 10 ;; *) break ;; esac
done

# Keep the running image as :previous (re-tagging untags the older :previous).
if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
  docker tag "$IMAGE:latest" "$IMAGE:previous"
fi

say 'docker build'
docker build -q -t "$IMAGE:latest" . >/dev/null

say "restart $NAME"
docker rm -f "$NAME" >/dev/null 2>&1 || true
start "$IMAGE:latest"

if ! healthy; then
  say "new build not healthy after ${HEALTH_WAIT}s; rolling back to $IMAGE:previous"
  docker logs --tail 30 "$NAME" || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if docker image inspect "$IMAGE:previous" >/dev/null 2>&1; then
    start "$IMAGE:previous"
    healthy && say 'previous build is running again' || say 'previous build did not come up either; check docker logs'
  fi
  exit 1
fi

# Healthy: drop this project's untagged leftovers (old :previous, build intermediates).
# The legacy builder chains intermediates, so repeat until nothing more is freed.
for _ in $(seq 1 20); do
  out=$(docker image prune -f --filter "label=$LABEL" 2>&1)
  case "$out" in *'deleted'*|*'Deleted'*) ;; *) break ;; esac
done
say "done: $(curl -fsS "http://127.0.0.1:$port/health"); disk $(df -h / | awk 'NR==2{print $4" free ("$5" used)"}')"
