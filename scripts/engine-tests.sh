#!/usr/bin/env bash
# The engine's own tests, inside its image (KiCad, Freerouting, the lot):
#   ./scripts/engine-tests.sh                      every test
#   ./scripts/engine-tests.sh tests/test_edit.py   one file (any pytest arguments)
# CI runs it with no arguments; the reviewer may add a throwaway test under
# engine/tests/ and run just that file. The image is rebuilt first, so new or
# changed tests are in it.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
. scripts/compose.sh
engine() { compose -p hardhub-engine-tests -f engine/docker-compose.yml "$@"; }
trap 'engine down --volumes >/dev/null 2>&1 || true' EXIT
engine build engine
engine run --rm --no-deps engine python3 -m pytest -q -p no:cacheprovider "${@:-tests}"
