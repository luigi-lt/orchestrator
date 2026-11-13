#!/usr/bin/env bash
# End-to-end test: starts the full local stack with fake GitHub and fake Anthropic API, runs the scenario,
# prints logs on failure and tears everything down (set KEEP=1 to keep the stack running).
# Expects the images orchestrator-app:local and orchestrator-workspace:local (./bin/orchestrator up builds them,
# or BUILD=1 builds them here).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose() {
  docker compose -p orchestrator-e2e -f "$ROOT/infra/local/docker-compose.yml" -f "$ROOT/test/e2e/docker-compose.e2e.yml" \
    --env-file "$ROOT/test/e2e/e2e.env" "$@"
}

if [[ "${BUILD:-0}" == "1" ]]; then
  compose --profile build-only build workspace-image
  compose build api
fi

compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d
status=0
node "$ROOT/test/e2e/run.mjs" || status=$?
if [[ $status -ne 0 ]]; then
  echo "---- logs ----"
  compose logs --tail=80 worker api workspace-manager sandbox-gateway egress-proxy fake-anthropic || true
fi
if [[ "${KEEP:-0}" != "1" ]]; then
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker ps -aq --filter label=orch.workspace=1 | xargs -r docker rm -f >/dev/null 2>&1 || true
fi
exit $status
