# claude-router

Smart per-prompt LLM router for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Pick the best model in your pool for each request, see which one answered via a footer in every reply, and get tool-calling on models that don't natively support it.

---

## Quickstart

### Prerequisites

- `node` 18+ and `npm` (no sudo required)
- `python3`
- `go` (optional, only for `promptlint` scoring; falls back to a single model otherwise)
- `claude` (Claude Code CLI). User-space install:
  ```bash
  npm i --prefix ~/.local @anthropic-ai/claude-code
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
  source ~/.zshrc
  claude --version
  ```

### Install

```bash
# 1. Clone + install (deps, symlinks, ~/.zshrc block - all user-space, no sudo)
git clone https://github.com/mshogin/claude-router.git ~/claude-router
cd ~/claude-router
make install

# 2. Reload shell so the helper functions become available
source ~/.zshrc

# 3. Configure auth for each model in your catalog
$EDITOR ~/.claude-router/models.yaml
# Three options per model:
#   api_key:     "sk-..."        # plain text, simplest
#   api_key_env: VAR_NAME        # reads from $VAR_NAME at config-build time
#   auth_secret: <name>          # gpg-encrypted at ~/secrets/<name>.gpg,
#                                # OR override via env: CR_SECRET_<UPPER_NAME>=...

# 4. Start everything and launch Claude
claude-router-shell
```

That's it. Every reply now ends with a `[router] model · features` footer telling you which model in your pool answered.

Re-running `claude-router-shell` later is idempotent: it lazy-starts the stack if it's down, otherwise just exports env and launches `claude`.

---

## Configuration

The default config goes in `~/.claude-router/models.yaml`. `make install` copies a starter from `examples/models.example.yaml`.

Three ways to authenticate per model:

```yaml
models:
  - id: openai-gpt5
    base_url: https://api.openai.com/v1
    model_name: gpt-5
    api_key: sk-PUT-YOUR-KEY-HERE          # plain string (simplest)

  - id: deepseek
    base_url: https://api.deepseek.com/v1
    model_name: deepseek-chat
    api_key_env: DEEPSEEK_API_KEY          # read from environment

  - id: claude-sonnet
    base_url: https://api.anthropic.com/v1
    model_name: claude-sonnet-4-6
    auth_secret: anthropic-api-key         # ~/secrets/<name>.gpg via gpg agent

  - id: local-llama
    base_url: http://localhost:11434/v1
    model_name: llama3.1:8b                # no auth field = sends "not-needed"
```

Each model declares its output sizing:

```yaml
  - id: openai-gpt5
    context_window: 200000        # REQUIRED. Total input+output the model accepts.
    max_output_tokens: 65536      # OPTIONAL. Soft ceiling for response size.
    output_safety_margin: 256     # OPTIONAL. Tokenizer-drift buffer (default 256).
```

`router.js` clamps `max_tokens` per request to
`min(requested, max_output_tokens, context_window - estimated_input - safety)`,
floored at 256. Long inputs no longer 400 the provider with `'max_tokens' is too large`.

After editing the catalog, regenerate the ccr config and restart:

```bash
~/my/claude-router/bin/build-config.sh && ccr restart
# or, if you changed timestamps:  FORCE_REBUILD=1 claude-router-reload
```

---

## Daily commands

Three launch modes, pick the one that fits your situation:

| Command | What it does | Personal context (CLAUDE.md / hooks / skills / memory) | macOS Fn+Fn dictation |
|---|---|---|---|
| `claude-router-shell` | Lazy-starts the stack, launches `claude` with your full setup | sent to upstream | no |
| `claude-router-up` then `claude` | Lazy-starts the stack + exports env, you run `claude` yourself | sent to upstream | yes |
| `claude-router-clean` | Lazy-starts the stack, launches `claude --bare --strict-mcp-config --setting-sources ""` | none — fully isolated | no |

Use `claude-router-clean` when you don't want personal context, memory, or skills to reach the upstream pool (e.g. a corporate or shared LLM provider).

Other helpers:

| Command | What it does |
|---|---|
| `claude-router` | Just start the stack (no Claude launch) |
| `claude-router-stop` | Stop everything |
| `claude-router-reload` | Stop → start → launch isolated Claude inline |
| `claude-router-down` | Unset env in this shell. Stack keeps running. |
| `claude-router-watch` | `tail -f ~/.claude-router/logs/decisions.log` |
| `claude-router-status` | Quick "N of 3 services up" check |
| `bin/run.sh --version` | Print script, node, and ccr versions with port defaults and exit |

**Note on dictation:** macOS Fn+Fn requires `claude` to be a *direct* child of the terminal — not wrapped in a zsh function. `claude-router-up` prepares the shell and returns control so you can type `claude` yourself.

---

## What's in the box

```
Claude Code
   |
   v
[3457] footer-proxy            # tool-call rescue + footer injection
   |
   v
[3456] ccr (claude-code-router by musistudio)
   |
   |  custom-router.js calls...
   |--> [8080] promptlint      # extracts prompt features
   v
OpenAI-compatible LLM pool (any provider)
```

Three local services:

- **`promptlint`** (Go binary, `:8080`) — extracts features from each prompt: `action`, `complexity`, `domain`, `has_code_block`, `has_file_path`, etc. No LLM needed.
- **`ccr`** (`@musistudio/claude-code-router`, `:3456`) — translates Claude Code's Anthropic API into OpenAI-shape requests, multiplexes across providers. Uses our `lib/router.js` as `CUSTOM_ROUTER_PATH` for scoring.
- **`footer-proxy`** (Node.js, `:3457`) — sits in front of ccr and:
  - injects a footer (`[router] model · action=... complexity=... domain=...`) into every reply
  - rescues broken tool-calls: if an upstream emits `<｜tool▁calls▁begin｜>...<｜tool▁call▁end｜>` raw in `content` instead of `tool_calls[]`, we parse and synthesize proper Anthropic `tool_use` blocks
  - truncates leaked chat-template control tokens at the boundary (`<|im_end|>`, `<|endoftext|>`, etc.)
  - on 429/5xx, writes the model id to a quarantine file so the router skips it for `quarantine_minutes`

---

## How model selection works

Each request passes through `lib/router.js` (running inside ccr):

1. Extract user message text.
2. POST to `promptlint /analyze` → `{action, complexity, domain, has_code_*, ...}`.
3. Score every non-quarantined model in the pool:
   ```
   score = sum(domain[d] * strengths[d]) for d in domain
         + action_bonus(action, model) * w_action
         + (has_code_block||has_code_ref||has_file_path) * strengths.code * w_code
         - max(0, complexity_rank - model.complexity_max_rank) * w_overcapacity
   ```
4. Pick the argmax. Fall back to `fallback_model` if `promptlint` is unreachable.
5. Append the decision to `~/.claude-router/logs/decisions.log` so footer-proxy can render the right footer.

Tune `strengths` and `scoring_weights` in `models.yaml` until routing matches your preferences. All decisions are logged.

---

## Make targets

| Target | What |
|---|---|
| `make install` | Full install: deps + config dir + sandbox dir + symlinks + zshrc block (idempotent) |
| `make deps` | External tools only (`@musistudio/claude-code-router`, `promptlint`, `pyyaml`) |
| `make uninstall` | Remove symlinks + zshrc block. **Keeps** `~/.claude-router/` |
| `make status` | Show install state + live port status |

---

## Files

```
bin/
  run.sh           Start full stack (promptlint + ccr + footer-proxy)
  stop.sh          Stop everything
  reload.sh        stop -> start -> launch claude (clean mode)
  run-clean.sh     Standalone clean Claude (assumes stack is up)
  build-config.sh  Generate ~/.claude-code-router/config.json from models.yaml

lib/
  router.js        Custom router for ccr (CUSTOM_ROUTER_PATH). Picks model + clamps max_tokens.
  limits.js        Pure helpers: estimateInputTokens, effectiveMaxTokens
  tokens.js        Token estimator (chars/4 baseline)
  footer-proxy.js  HTTP proxy: footer injection, tool-call rescue, quarantine

shell/
  claude-router.zsh   All aliases and zsh functions, sourced from ~/.zshrc

examples/
  models.example.yaml   Sample catalog (place at ~/.claude-router/models.yaml)
```

---

## Roadmap / known limitations

- Calibration of `strengths` is heuristic. Future: A/B harness driven by request telemetry.
- Quarantine is reactive only (no proactive health probes).
- No MCP routing — MCP traffic is opt-out via `--strict-mcp-config`.
- macOS dictation (Fn+Fn) requires `claude` to run as a direct child of the terminal — see `claude-router-up`.

---

## Acknowledgements

- [`@musistudio/claude-code-router`](https://github.com/musistudio/claude-code-router) — the underlying multi-provider router and transformer pipeline.
- [`promptlint`](https://github.com/mshogin/promptlint) — prompt feature extraction (Go).

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
