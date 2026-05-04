#!/usr/bin/env bash
# Full reload: stop everything -> start stack -> (optionally) launch clean Claude.
#
# Usage:
#   bin/reload.sh           - stop + start + launch claude (clean)
#   bin/reload.sh --no-cli  - only restart the stack, don't start the CLI

set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WITH_CLI=1
for arg in "$@"; do
  case "$arg" in
    --no-cli) WITH_CLI=0 ;;
  esac
done

echo "=== claude-router reload ==="
echo "[1/2] stopping..."
"${REPO_DIR}/bin/stop.sh" >/dev/null 2>&1 || true
sleep 1

echo "[2/2] starting..."
if ! "${REPO_DIR}/bin/run.sh"; then
  echo "ERROR: stack failed to start" >&2
  exit 1
fi

if [ "${WITH_CLI}" -eq 0 ]; then
  echo
  echo "Stack ready. Launch claude with: bin/run-clean.sh"
  exit 0
fi

echo
echo "=== launching claude (clean mode) ==="
exec "${REPO_DIR}/bin/run-clean.sh"
