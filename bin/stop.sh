#!/usr/bin/env bash
# Stop the full claude-router stack.
set -u

echo "Stopping ccr..."
ccr stop 2>&1 | tail -3 || true

for port_label in "3457:footer-proxy" "8080:promptlint"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  pids=$(lsof -ti ":${port}" 2>/dev/null || true)
  if [ -n "${pids}" ]; then
    kill ${pids} 2>/dev/null || true
    echo "Stopped ${label} (:${port}) pid=${pids}"
  fi
done
