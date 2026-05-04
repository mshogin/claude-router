# claude-router - zsh integration
#
# Functions are defined as zsh shell functions (not aliases-to-scripts) so
# `claude` runs as a direct child of the current terminal. This is required
# for macOS dictation (Fn+Fn) and for some terminal multiplexers.
#
# Sourced via:
#   source ~/.claude-router/claude-router.zsh
#
# The line above is added to ~/.zshrc by `make install`.

# Resolve the repo root from this file's path (handles symlinks via :A).
typeset -g CLAUDE_ROUTER_REPO=${${(%):-%N}:A:h:h}
typeset -g CLAUDE_ROUTER_CONFIG_DIR="${HOME}/.claude-router"

# Drop any stale aliases left over from an older install. zsh can't define a
# function with the same name as an existing alias - it errors with
# "defining function based on alias". This keeps re-source idempotent.
unalias claude-router claude-router-stop claude-router-watch claude-router-status \
        claude-router-clean claude-router-shell claude-router-reload \
        claude-router-up claude-router-down 2>/dev/null

# ---- aliases -----------------------------------------------------------------

alias claude-router='${CLAUDE_ROUTER_REPO}/bin/run.sh'
alias claude-router-stop='${CLAUDE_ROUTER_REPO}/bin/stop.sh'
alias claude-router-watch='tail -f "${CLAUDE_ROUTER_CONFIG_DIR}/logs/decisions.log"'

# Loopback health probe that ignores HTTP(S)_PROXY in env. Corporate proxies
# refuse 127.0.0.1 with 503; without --noproxy '*' the checks below would
# wrongly report a healthy stack as down.
_claude_router_alive() {
  curl -sf --noproxy '*' -o /dev/null "$1" 2>/dev/null
}

# Lazy-start the stack if footer-proxy isn't responding. Idempotent -
# safe to call from every launcher; if the stack is already up, it's a no-op.
_claude_router_ensure_stack() {
  if _claude_router_alive http://127.0.0.1:3457/; then
    return 0
  fi
  echo "[claude-router] stack not running - starting..."
  "${CLAUDE_ROUTER_REPO}/bin/run.sh" >/dev/null 2>&1 || {
    echo "[claude-router] stack failed to start. Try: claude-router (verbose output)"
    return 1
  }
}

# Export router-pointed Anthropic env into the current shell. Strips any
# corporate HTTP(S)_PROXY so claude itself talks to localhost directly.
#
# Only ANTHROPIC_API_KEY is set, not ANTHROPIC_AUTH_TOKEN: claude v2.1+
# warns "Auth conflict" when both are set, and --bare mode strictly
# requires ANTHROPIC_API_KEY anyway. ANTHROPIC_AUTH_TOKEN is also unset
# proactively in case the user had it from an earlier session.
_claude_router_export_env() {
  export ANTHROPIC_BASE_URL=http://localhost:3457
  export ANTHROPIC_API_KEY=not-needed
  export API_TIMEOUT_MS=600000
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  unset ANTHROPIC_AUTH_TOKEN
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
}

# Friendly check that Claude Code CLI is installed. The router stack can
# still run without it (it just proxies API calls), but the -shell / -clean
# launchers need 'claude' on PATH.
_claude_router_require_claude() {
  if command -v claude >/dev/null 2>&1; then
    return 0
  fi
  cat <<'EOF' >&2
[claude-router] 'claude' command not found.

Install Claude Code first, then retry. Quick options:
  npm i -g @anthropic-ai/claude-code        # Anthropic official CLI
  brew install --cask claude-code           # macOS Homebrew (if a tap is set up)

Docs: https://docs.anthropic.com/en/docs/claude-code

The router stack itself is running - you can talk to it from your own
client by pointing ANTHROPIC_BASE_URL to http://localhost:3457.
EOF
  return 1
}

# Per-port lsof - lsof 4.91 on macOS errors out on multi-port `-i :a :b :c`,
# which made the old single-call status alias always print 0/3.
claude-router-status() {
  local up=0
  for port in 8080 3456 3457; do
    if lsof -ti ":${port}" >/dev/null 2>&1; then
      up=$((up + 1))
    fi
  done
  echo "claude-router services up: ${up} / 3"
}

# ---- functions ---------------------------------------------------------------

# Mode 1: prepare-only.
# Ensures the stack is running and exports router env into the current shell,
# then hands control back. You launch `claude` yourself - this is the only
# mode where macOS dictation (Fn+Fn) works, because claude must be a direct
# child of the terminal, not a child of a zsh function.
#
# Idempotent: safe to re-run any time.
#
# Usage:
#   claude-router-up         # stack + env, no claude launch
#   claude                   # full personal context (CLAUDE.md / hooks / skills sent upstream)
#   # OR
#   claude --bare --strict-mcp-config --setting-sources ""   # fully isolated
#   # ...
#   claude-router-down       # unset env (stack keeps running)
claude-router-up() {
  _claude_router_ensure_stack || return 1
  _claude_router_export_env

  cat <<EOF
[claude-router-up] env exported in this shell:
  ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL
  HTTP(S)_PROXY     = (unset)

Now launch claude yourself (dictation Fn+Fn works because claude is a
direct child of this terminal):

  claude
      Full personal context. CLAUDE.md, hooks, skills, auto-memory and
      MCP servers WILL be sent to the upstream LLM pool. Use only with
      providers you trust with that data.

  claude --bare --strict-mcp-config --setting-sources ""
      Fully isolated. No CLAUDE.md, no hooks, no auto-memory, no
      settings.json, no MCP. Recommended when routing to a shared
      or corporate LLM pool you don't want personal context to reach.

Stop / undo:
  claude-router-down                       # unset env (stack keeps running)
  claude-router-stop                       # stop the stack
EOF
}

# Revert env exported by claude-router-up. Stack is left running.
claude-router-down() {
  unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN \
        API_TIMEOUT_MS CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  echo "[claude-router-down] env reverted in this shell. Stack still running."
}

# Mode 3: fully isolated.
# Ensures the stack is running, then launches claude with every personal
# data source disabled:
#   --bare              skip hooks, LSP, auto-memory, CLAUDE.md auto-discovery
#   --strict-mcp-config ignore all MCP servers
#   --setting-sources ""  ignore user/project/local settings.json
#
# Use this when routing to a shared or corporate LLM pool - guarantees
# that personal context, memory, and skill auto-loads do not leak.
#
# Note: dictation (Fn+Fn) does NOT work here because claude is launched
# from inside a zsh function. If you need dictation, use `claude-router-up`
# instead and run claude yourself with the same flags.
claude-router-clean() {
  _claude_router_ensure_stack || return 1
  _claude_router_require_claude || return 1
  _claude_router_export_env

  echo "=== claude-router-clean (isolated) ==="
  echo "  cwd:    $PWD"
  echo "  router: $ANTHROPIC_BASE_URL"
  echo "  flags:  --bare --strict-mcp-config --setting-sources \"\""
  echo

  claude --bare --strict-mcp-config --setting-sources "" "$@"
}

# Mode 2: all-in-one with personal config.
# Ensures the stack is running, then launches claude with full personal
# context: CLAUDE.md, hooks, skills, auto-memory, MCP servers - all sent
# to the upstream LLM pool. Use only with providers you trust.
#
# Note: dictation (Fn+Fn) does NOT work here. For dictation, use
# `claude-router-up` and run plain `claude` yourself.
claude-router-shell() {
  _claude_router_ensure_stack || return 1
  _claude_router_require_claude || return 1
  _claude_router_export_env
  claude "$@"
}

# Stop everything, rebuild config, restart, launch claude (clean) inline.
# `--no-cli` skips the claude launch.
claude-router-reload() {
  "${CLAUDE_ROUTER_REPO}/bin/stop.sh" >/dev/null 2>&1
  sleep 1
  if ! "${CLAUDE_ROUTER_REPO}/bin/run.sh"; then
    echo "Stack failed to start" >&2
    return 1
  fi
  if [ "${1:-}" = "--no-cli" ]; then
    echo
    echo "Stack ready. Run 'claude-router-clean' when needed."
    return 0
  fi
  echo
  echo "=== launching claude (clean mode) ==="
  claude-router-clean
}
