#!/usr/bin/env bash
# The end-to-end test, all in Docker: ./hardhub test
# Screenshots of each step land in e2e/out/.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
. scripts/compose.sh
mkdir -p e2e/out
e2e() { compose -p hardhub-e2e -f docker-compose.yml -f e2e/compose.e2e.yml ${E2E_COMPOSE_EXTRA:+-f "$E2E_COMPOSE_EXTRA"} "$@"; }
e2e up --build --detach --wait --wait-timeout 1200 engine api web fake-anthropic bridge || { e2e logs --tail 80; e2e down --volumes; exit 1; }
e2e run --rm tests
rc=$?
[ $rc -ne 0 ] && e2e logs --tail 60 api engine
e2e down --volumes >/dev/null 2>&1
echo
[ $rc -eq 0 ] && echo "End-to-end test passed. Screenshots: e2e/out/" || echo "End-to-end test FAILED. Screenshots: e2e/out/"
exit $rc
