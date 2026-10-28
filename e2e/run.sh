#!/usr/bin/env bash
# The end-to-end test, all in Docker: ./hardhub test
# Screenshots of each step land in e2e/out/.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
mkdir -p e2e/out
compose() { docker compose -p hardhub-e2e -f docker-compose.yml -f e2e/compose.e2e.yml ${E2E_COMPOSE_EXTRA:+-f "$E2E_COMPOSE_EXTRA"} "$@"; }
compose up --build --detach --wait --wait-timeout 1200 engine api web fake-anthropic bridge || { compose logs --tail 80; compose down --volumes; exit 1; }
compose run --rm tests
rc=$?
[ $rc -ne 0 ] && compose logs --tail 60 api engine
compose down --volumes >/dev/null 2>&1
echo
[ $rc -eq 0 ] && echo "End-to-end test passed. Screenshots: e2e/out/" || echo "End-to-end test FAILED. Screenshots: e2e/out/"
exit $rc
