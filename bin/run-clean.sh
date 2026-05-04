#!/usr/bin/env bash
# Launch Claude Code in fully isolated mode through the router.
#
# Isolation flags:
#   --bare                skip hooks, LSP, auto-memory, CLAUDE.md auto-discovery
#   --strict-mcp-config   ignore all MCP servers
#   --setting-sources ""  ignore user/project/local settings.json
#
# Lazy-starts the stack if it isn't running.
#
# IMPORTANT: this is a bash script. macOS dictation (Fn+Fn) needs claude to
# run as a direct child of the terminal. If you want dictation, use the zsh
# function `claude-router-up` and launch claude yourself with the same flags.

set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOOPBACK_CURL=(curl -sf --noproxy '*')

# Lazy-start the stack if footer-proxy isn't responding.
if ! "${LOOPBACK_CURL[@]}" -o /dev/null http://127.0.0.1:3457/ 2>/dev/null; then
  echo "[claude-router] stack not running - starting..."
  "${REPO_DIR}/bin/run.sh" >/dev/null 2>&1 || {
    echo "[claude-router] stack failed to start. Run bin/run.sh for verbose output."
    exit 1
  }
fi

ROUTER_BASE="http://localhost:3457"
if ! "${LOOPBACK_CURL[@]}" -o /dev/null "${ROUTER_BASE}/" 2>/dev/null; then
  ROUTER_BASE="http://localhost:3456"
fi

# Stay in the user's current directory. --bare already disables CLAUDE.md
# auto-discovery so changing cwd is not necessary.
export ANTHROPIC_BASE_URL="${ROUTER_BASE}"
export ANTHROPIC_AUTH_TOKEN=not-needed
export ANTHROPIC_API_KEY=not-needed
export API_TIMEOUT_MS=600000
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

echo "=== claude-router clean (isolated) ==="
echo "  cwd:    ${PWD}"
echo "  router: ${ROUTER_BASE}"
echo "  flags:  --bare --strict-mcp-config --setting-sources \"\""
echo

exec claude --bare --strict-mcp-config --setting-sources "" "$@"
