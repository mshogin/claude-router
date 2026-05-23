# Changelog

Следует [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

**Процесс:** каждый функциональный коммит — запись в `[Unreleased]` (Added/Changed/Removed/Fixed). При выпуске тега: переименовать `[Unreleased]` в `[X.Y.Z] - YYYY-MM-DD`, создать новую пустую `[Unreleased]` сверху.

## [Unreleased]

### Added
- Add DeepSeek provider support for the router

## [0.1.5] - 2026-05-13

### Fixed
- `lib/footer-proxy.js` — поддержка reasoning-моделей (Qwen3.6-Coder через ccr `reasoning` transformer): unsupported content blocks (`thinking`, `redacted_thinking`, `signature` и т.п.) теперь дропаются из ответа, а оставшиеся text/tool_use блоки переиндексируются в плотную нумерацию 0..N - claude CLI требует именно этого формата. До фикса агентский pipeline получал ошибку "Content block is not a text block" либо пустой content.
- `lib/footer-proxy.js` — fallback на thinking-as-text: если LLM закончила `end_turn` на этапе reasoning и не выдала ни одного text/tool_use блока, накопленное содержимое thinking-блоков синтезируется в финальный text-блок (для stream и non-stream branches). Иначе ответ был бы пустым.
- `lib/footer-proxy.js` — mis-typed delta check вынесен ПЕРЕД re-indexing. Раньше re-indexed deltas обходили фильтр и text_delta внутри tool_use блока проходил в claude CLI - ронялся agent-mode с "Content block is not a text block" на multi-tool ответах.
- `lib/footer-proxy.js` — footer-injection больше не вставляет пустой text-блок если `FOOTER_PROXY_FOOTER=0`. Раньше пустой блок попадал в конец content[] и claude CLI печатал пустой результат.
- `lib/footer-proxy.js` — фильтрация unsupported content blocks и mis-typed deltas теперь выполняется независимо от того, включён footer или нет. Раньше при `FOOTER_PROXY_FOOTER=0` весь поток пропускался через direct pipe без обработки.

## [0.1.4] - 2026-05-12

### Fixed
- `lib/footer-proxy.js` — footer теперь opt-in через `FOOTER_PROXY_FOOTER=1` (default OFF). Footer с index:99 в SSE stream ломал claude CLI парсинг финального content. В агентском/сервисном режиме footer не нужен — он только для интерактивной chat-сессии локально.
- `lib/footer-proxy.js` — `truncateAtChatTemplateBoundary` теперь удаляет только chat-template токены (replace), а не обрезает весь текст после них. Reasoning-модели (Qwen3.6, DeepSeek-V3) теперь не теряют финальный ответ после <|im_end|> разделителя thinking/answer.

### Changed
- `lib/limits.js` — `MIN_OUTPUT_TOKENS` поднят с 256 до 2048. Прежний floor ломал thinking-модели (Qwen3.6 reasoning, DeepSeek-V3): они тратят 200-1000 токенов на внутренний reasoning ДО первого visible content-токена, при floor=256 модель упиралась в `max_tokens` внутри thinking и возвращала `content=[]` + `stop_reason=max_tokens`. Также добавлен per-model override через `model.min_output_tokens` в `models.yaml` для тонкой настройки.

## [0.1.3] - 2026-05-05

### Added
- `bin/run-tests.sh` — bash test runner. Каждый `tests/*.json` кейс гоняется в `mktemp` sandbox через `claude -p --dangerously-skip-permissions --output-format stream-json --verbose`. Парсит stream на `tool_use` блоки и `stop_reason`, сравнивает с `expect`. Per-test JSON результат (sandbox path, model picked, tools called, status, reason) сохраняется в `~/sandbox/claude-router-tests/results/<ts>/<name>.json` — failures дебагаемы постфактум. Sandboxes чистятся при PASS.
- Первый тест-кейс для проверки выбора модели.
- Dynamic `max_tokens` clamp in `lib/router.js` based on per-model `context_window`. On every request the router computes `effective = min(body.max_tokens, model.max_output_tokens, context_window - estimated_input - safety)`, floored at 256, and writes it back into `req.body.max_tokens`. Long inputs no longer 400 the provider with `'max_tokens' is too large`.
- `lib/tokens.js` - token estimator (chars/4 baseline, signature stable for future tiktoken swap).
- `lib/limits.js` - `estimateInputTokens(body)` and `effectiveMaxTokens(model, body)` as pure helpers.
- `models.yaml` per-model field `output_safety_margin` (optional, default 256) - tokens reserved for tokenizer drift.
- `decisions.log` entries now carry `sizing: {input_tokens, max_tokens_requested, max_tokens_effective}` and `fallback: bool` for observability.

### Changed
- `models.yaml` field `context_max_k` is replaced by `context_window` (exact tokens, e.g. `32768` instead of `32`). REQUIRED for every model. **Breaking** - no migration shim; `bin/build-config.sh` errors out with a clear message if missing.

### Removed
- Default `maxtoken` ccr transformer. Per-model output cap is now applied in the router (single source of truth, dynamic against actual input size). The `extra_transformers` escape hatch is unchanged.
- `upstream-proxies/qwen-proxy.py` - was needed to adapt an Anthropic-shape upstream for Claude Code. With the chat-template tool-call rescue now done in `lib/footer-proxy.js`, every OpenAI-shape model in the pool can serve tool-using requests directly. No separate Anthropic-shape route needed.
- `router.tools_route` config and the chat/agentic classifier in footer-proxy. Every request now goes through ccr to the scored model pool. If the chosen model emits chat-template tokens, the rescue path turns them into proper `tool_use` blocks.

### Added
- `Makefile` with `install` / `deps` / `uninstall` / `status` targets. `make install` is idempotent and now also installs external tools (`@musistudio/claude-code-router` via npm, `promptlint` via go install).
- `make install` creates `~/sandbox/llm-clean/` and the per-host config dir.
- Per-model `api_key` (plain string) and `api_key_env` (env var name) options in `models.yaml`. `auth_secret` (gpg) is now one of three options, not the only one.
- Explicit `router.tools_route` config: an Anthropic-shape upstream that handles tool-using requests. If a request contains `tools` and `tools_route` is not configured, footer-proxy returns 400 with a clear error - tool calls are never silently dropped.
- 429 / 5xx **quarantine** is wired end-to-end: footer-proxy writes `/tmp/claude-router-quarantine.json` on upstream errors, `lib/router.js` reads it and excludes the model from candidate scoring until the cooldown expires.
- `~/.claude-code-router/footer-proxy.json` side-car (generated by `bin/build-config.sh`) carries `tools_route` + quarantine config to the proxy. Proxy hot-reloads on file change.
- `shell/claude-router.zsh` - single sourced file with all aliases and zsh functions. `claude-router-clean` / `-shell` / `-reload` are functions (not subshell scripts) so macOS dictation (Fn+Fn) keeps working.
- Symlinks: `~/bin/claude-router` -> `bin/run.sh`, `~/.claude-router/claude-router.zsh` -> `shell/claude-router.zsh`.

### Removed
- `tooluse`, `enhancetool`, `deepseek` ccr transformers - they were no-ops for our actual upstreams. Tool calling now relies on the dedicated `tools_route` upstream that already speaks Anthropic-shape tool_use blocks natively.
- DeepSeek/Qwen chat-template token stripping in `footer-proxy.js`. Tool requests go to a tool-aware upstream or fail loudly; we never sanitize broken tool calls anymore.

### Changed
- Default kept transformers: `cleancache` (strip Anthropic prompt-cache fields). Pure pass-through that can't break a request. (The `maxtoken` default is removed in this release - see top of Unreleased.)

## [0.1.0] - 2026-04-30

Initial extraction from a private working setup.

### Added
- `lib/router.js` - custom router for ccr (PromptLint-driven model scoring + 429 quarantine).
- `lib/footer-proxy.js` - smart-routing HTTP proxy on :3457:
  - Routes tool requests to qwen-proxy (Anthropic shape), chat requests to ccr (OpenAI pool).
  - Injects router-decision footer into both streaming SSE and non-streaming JSON responses.
  - Strips chat-template tool tokens from text and downgrades `stop_reason: tool_use → end_turn` so Claude Code doesn't deadlock on broken tool calls.
- `bin/build-config.sh` - generates ccr config from `~/.claude-router/models.yaml`, supports gpg secrets and env-var fallback.
- `bin/run.sh / stop.sh / reload.sh / run-clean.sh` - lifecycle scripts.
- `upstream-proxies/qwen-proxy.py` - generic Anthropic-shape upstream proxy (configure via `UPSTREAM_URL`).
- `examples/models.example.yaml` - sample catalog with OpenAI / DeepSeek / local Ollama / GLM examples.
