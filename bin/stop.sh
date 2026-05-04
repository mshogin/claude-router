#!/usr/bin/env bash
# Stop the full claude-router stack.
set -u

CONFIG_DIR="${CONFIG_DIR:-${HOME}/.claude-router}"

# Resolve ccr binary - same lookup as run.sh.
if [ -x "${CONFIG_DIR}/node_modules/.bin/ccr" ]; then
  CCR_BIN="${CONFIG_DIR}/node_modules/.bin/ccr"
else
  CCR_BIN="$(command -v ccr 2>/dev/null || true)"
fi

echo "Stopping ccr..."
if [ -n "${CCR_BIN}" ]; then
  "${CCR_BIN}" stop 2>&1 | tail -3 || true
fi

for port_label in "3457:footer-proxy" "8080:promptlint"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  pids=$(lsof -ti ":${port}" 2>/dev/null || true)
  if [ -n "${pids}" ]; then
    kill ${pids} 2>/dev/null || true
    echo "Stopped ${label} (:${port}) pid=${pids}"
  fi
done
