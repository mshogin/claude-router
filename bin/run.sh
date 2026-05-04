#!/usr/bin/env bash
# Start the full claude-router stack:
#   1) promptlint   on :8080  (optional - falls back if not installed)
#   2) ccr          on :3456  (claude-code-router by musistudio)
#   3) footer-proxy on :3457  (chat-template tool-call rescue + footer injection)
#
# Override paths via env:
#   CONFIG_DIR     default: ~/.claude-router
#   CCR_DIR        default: ~/.claude-code-router
#   PROMPTLINT_BIN default: $(which promptlint) or /tmp/promptlint
#
# Usage: bin/run.sh

set -euo pipefail

# Loopback health checks must bypass any corporate HTTP(S)_PROXY in env -
# the proxy refuses 127.0.0.1 and returns 503, which would mark a healthy
# service as failed. `--noproxy '*'` makes curl ignore the proxy env vars.
LOOPBACK_CURL=(curl -sf --noproxy '*')

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${CONFIG_DIR:-${HOME}/.claude-router}"
SECRETS_DIR="${SECRETS_DIR:-${HOME}/secrets}"

# Resolve ccr binary - prefer the user-space install in CONFIG_DIR (no sudo
# required, what `make deps` produces) and fall back to PATH for users who
# installed it themselves with `npm install -g`.
if [ -x "${CONFIG_DIR}/node_modules/.bin/ccr" ]; then
  CCR_BIN="${CONFIG_DIR}/node_modules/.bin/ccr"
else
  CCR_BIN="$(command -v ccr 2>/dev/null || true)"
fi
if [ -z "${CCR_BIN}" ]; then
  echo "ERROR: ccr binary not found. Run 'make deps' to install it under ${CONFIG_DIR}/node_modules/." >&2
  exit 1
fi

# Resolve promptlint binary - PATH first, then GOBIN/GOPATH/~/go/bin so
# `go install`-only setups (no shell PATH update) still work.
if [ -z "${PROMPTLINT_BIN:-}" ]; then
  for cand in \
      "$(command -v promptlint 2>/dev/null || true)" \
      "$(go env GOBIN 2>/dev/null)/promptlint" \
      "$(go env GOPATH 2>/dev/null)/bin/promptlint" \
      "${HOME}/go/bin/promptlint"; do
    if [ -n "${cand}" ] && [ -x "${cand}" ]; then
      PROMPTLINT_BIN="${cand}"
      break
    fi
  done
fi
PROMPTLINT_BIN="${PROMPTLINT_BIN:-/tmp/promptlint}"

# Per-user log/state dirs (avoid /tmp ownership conflicts on multi-user hosts).
LOGS_DIR="${CLAUDE_ROUTER_LOGS_DIR:-${CONFIG_DIR}/logs}"
STATE_DIR="${CLAUDE_ROUTER_STATE_DIR:-${CONFIG_DIR}/state}"
mkdir -p "${LOGS_DIR}" "${STATE_DIR}"
PROMPTLINT_LOG="${LOGS_DIR}/promptlint.log"
CCR_LOG="${LOGS_DIR}/ccr-start.log"
FOOTER_PROXY_LOG="${LOGS_DIR}/footer-proxy.log"
DECISIONS_LOG="${LOGS_DIR}/decisions.log"

# Pass log/state paths to ccr (which loads lib/router.js) and to the
# footer-proxy node process so they read/write the same files.
export CLAUDE_ROUTER_LOGS_DIR="${LOGS_DIR}"
export CLAUDE_ROUTER_STATE_DIR="${STATE_DIR}"

echo "=== claude-router stack ==="

# 1) Build ccr config (only if missing or stale vs models.yaml).
# Existing config.json already has decrypted api_keys baked in - reusing it
# means we don't ask for the gpg passphrase on every restart.
CONFIG_JSON="${CCR_DIR:-${HOME}/.claude-code-router}/config.json"
MODELS_YAML="${CONFIG_DIR}/models.yaml"

NEED_REBUILD=0
if [ ! -f "${CONFIG_JSON}" ]; then
  NEED_REBUILD=1
  echo "[config] missing - generating fresh"
elif [ "${MODELS_YAML}" -nt "${CONFIG_JSON}" ]; then
  NEED_REBUILD=1
  echo "[config] models.yaml is newer - regenerating"
elif [ "${FORCE_REBUILD:-0}" = "1" ]; then
  NEED_REBUILD=1
  echo "[config] FORCE_REBUILD=1 - regenerating"
fi

if [ "${NEED_REBUILD}" = "1" ]; then
  # build-config.sh prints actionable, model-specific hints itself; we just
  # exit non-zero so the caller knows the stack didn't start.
  if ! "${REPO_DIR}/bin/build-config.sh"; then
    exit 1
  fi
else
  echo "[config] reusing existing ${CONFIG_JSON}"
fi

# 2) PromptLint on :8080 (optional - if not installed, custom router falls back).
if ! "${LOOPBACK_CURL[@]}" -X POST -H "Content-Type: text/plain" --data "ping" \
     -o /dev/null http://localhost:8080/analyze 2>&1; then
  if [ -x "${PROMPTLINT_BIN}" ]; then
    echo "[promptlint] starting ${PROMPTLINT_BIN} on :8080"
    nohup env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
      -u ALL_PROXY -u all_proxy no_proxy='*' NO_PROXY='*' \
      "${PROMPTLINT_BIN}" serve > "${PROMPTLINT_LOG}" 2>&1 &
    sleep 1
  else
    echo "[promptlint] not installed (router will use fallback model)"
  fi
fi
if "${LOOPBACK_CURL[@]}" -X POST -H "Content-Type: text/plain" --data "ping" \
   -o /dev/null http://localhost:8080/analyze 2>&1; then
  echo "[ok]   promptlint :8080"
else
  echo "[warn] promptlint :8080 (fallback model will be used)"
fi

# 3) ccr - corporate proxy env stripped (some upstreams must be reached directly).
"${CCR_BIN}" stop >/dev/null 2>&1 || true
sleep 1
nohup env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  -u ALL_PROXY -u all_proxy \
  no_proxy='*' NO_PROXY='*' \
  "${CCR_BIN}" start > "${CCR_LOG}" 2>&1 &

# Wait up to 15s for ccr to bind :3456 (cold start can take >3s while
# transformers register).
ccr_ready=0
for _ in $(seq 1 30); do
  if "${LOOPBACK_CURL[@]}" -o /dev/null http://127.0.0.1:3456/ ; then
    ccr_ready=1
    break
  fi
  sleep 0.5
done

if [ "${ccr_ready}" = "1" ]; then
  echo "[ok]   ccr        :3456"
else
  echo "[fail] ccr did not start within 15s. Last log:"
  tail -20 "${CCR_LOG}"
  exit 1
fi

# 4) Footer-proxy on :3457 - chat-template tool-call rescue + footer injection.
if ! lsof -ti :3457 >/dev/null 2>&1; then
  echo "[footer-proxy] starting on :3457"
  nohup env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
    -u ALL_PROXY -u all_proxy no_proxy='*' NO_PROXY='*' \
    node "${REPO_DIR}/lib/footer-proxy.js" > "${FOOTER_PROXY_LOG}" 2>&1 &
  sleep 1
fi
if "${LOOPBACK_CURL[@]}" -o /dev/null http://127.0.0.1:3457/ ; then
  echo "[ok]   footer-proxy :3457"
else
  echo "[warn] footer-proxy didn't respond on :3457"
  tail -10 "${FOOTER_PROXY_LOG}" || true
fi

cat <<EOF

=== Ready ===

In a fresh shell:

  export ANTHROPIC_BASE_URL=http://localhost:3457
  export ANTHROPIC_AUTH_TOKEN=not-needed
  export ANTHROPIC_API_KEY=not-needed
  export API_TIMEOUT_MS=600000
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
  claude --bare --strict-mcp-config       # clean (no personal CLAUDE.md / hooks / skills)

Or use the helpers:
  bin/run-clean.sh                         # clean Claude in ~/sandbox/llm-clean
  bin/reload.sh                            # stop, start, launch clean Claude inline

Logs:
  Routing:      tail -f ${CCR_LOG}
  PromptLint:   tail -f ${PROMPTLINT_LOG}
  Footer-proxy: tail -f ${FOOTER_PROXY_LOG}
  Decisions:    tail -f ${DECISIONS_LOG}
EOF
