/**
 * Custom router for claude-code-router.
 *
 * Pipeline:
 *   1. Extract last user-message text from req.body.
 *   2. POST it to promptlint /analyze for {action, complexity, domain, ...}.
 *   3. Score every non-quarantined model. Pick argmax.
 *   4. Clamp req.body.max_tokens to fit the chosen model's context window.
 *
 * Quarantine state is shared with footer-proxy via state/quarantine.json
 * (footer-proxy writes on 429/5xx, this module reads on each request).
 *
 * Routing decisions: in-memory Prometheus counters + /last-decision endpoint (:3458),
 * the right "[router] ..." footer into the response.
 *
 * Paths default to ~/.claude-router/{logs,state}/. Override via env
 * CLAUDE_ROUTER_LOGS_DIR / CLAUDE_ROUTER_STATE_DIR. Per-user dirs avoid
 * /tmp ownership conflicts on multi-user macOS hosts.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { estimateInputTokens, effectiveMaxTokens } = require("./limits");

const LOGS_DIR = process.env.CLAUDE_ROUTER_LOGS_DIR ||
  path.join(os.homedir(), ".claude-router", "logs");
const STATE_DIR = process.env.CLAUDE_ROUTER_STATE_DIR ||
  path.join(os.homedir(), ".claude-router", "state");
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

const QUARANTINE_FILE = path.join(STATE_DIR, "quarantine.json");
const COMPLEXITY_RANK = { low: 1, medium: 2, high: 3 };

// ── Prometheus-метрики (in-memory, фаза-1 observability) ──────────────────────
// router.js — hook внутри ccr-процесса (:3456), у ccr нет своего /metrics для hook'а.
// Поэтому поднимаем СВОЙ in-process http listener :3458 (router-proxy федерирует его + promptlint
// :8080). Counters ручные (Node/Bun single-thread event loop -> .inc синхронный, гонок нет, без
// prom-client npm). globalThis-guard: listener+counters стартуют РОВНО один раз даже при re-require
// hook (config-watch) -> :3458 без EADDRINUSE, counters не обнуляются.
const CR_METRICS_PORT = Number(process.env.CR_METRICS_PORT || 3458);

function crEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function crRenderMetrics(m) {
  let out = "";
  out += "# HELP claude_router_decisions_total Routing decisions by chosen model and fallback flag\n";
  out += "# TYPE claude_router_decisions_total counter\n";
  for (const [k, v] of Object.entries(m.decisions)) {
    const i = k.lastIndexOf("|");
    const model = k.slice(0, i);
    const fb = k.slice(i + 1);
    out += `claude_router_decisions_total{model="${crEscape(model)}",fallback="${fb}"} ${v}\n`;
  }
  out += "# HELP claude_router_promptlint_unavailable_total Decisions where promptlint returned no features\n";
  out += "# TYPE claude_router_promptlint_unavailable_total counter\n";
  out += `claude_router_promptlint_unavailable_total ${m.plUnavailable}\n`;
  return out;
}

if (!globalThis.__crMetrics) {
  globalThis.__crMetrics = { decisions: {}, plUnavailable: 0 };
  try {
    const http = require("http");
    http
      .createServer((req, res) => {
        if (req.url === "/metrics") {
          res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
          res.end(crRenderMetrics(globalThis.__crMetrics));
        } else if (req.url === "/last-decision") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(globalThis.__claudeRouterLastDecision || null));
        } else {
          res.writeHead(404);
          res.end();
        }
      })
      .listen(CR_METRICS_PORT, "127.0.0.1", () => {
        console.log(`[claude-router] metrics listener on :${CR_METRICS_PORT}`);
      });
  } catch (e) {
    console.error("[claude-router] metrics listener failed:", e && e.message);
  }
}

// crRecordDecision — инкремент counters в момент решения (заменяет decisions.log append).
function crRecordDecision(modelName, fallback, promptlintUnavailable) {
  const m = globalThis.__crMetrics;
  const key = (modelName || "unknown") + "|" + (fallback ? "true" : "false");
  m.decisions[key] = (m.decisions[key] || 0) + 1;
  if (promptlintUnavailable) {
    m.plUnavailable++;
  }
}

function readQuarantine() {
  try {
    return JSON.parse(fs.readFileSync(QUARANTINE_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function isQuarantined(modelId) {
  const map = readQuarantine();
  const until = map[modelId];
  if (!until) return false;
  return Date.now() < until;
}

function extractUserText(body) {
  const messages = body?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const block of content) {
        if (block && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      return parts.join(" ");
    }
  }
  return "";
}

async function callPromptlint(url, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: text,
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function actionBonus(action, model) {
  const codeActions = ["fix", "refactor", "debug", "implement", "review"];
  const generalActions = ["explain", "summarize", "translate"];
  if (codeActions.includes(action)) return model.strengths.code || 0;
  if (generalActions.includes(action)) return model.strengths.general || 0;
  return 0;
}

function codeAwareBonus(features, model) {
  const has =
    features.has_code_block || features.has_code_ref || features.has_file_path;
  return has ? model.strengths.code || 0 : 0;
}

function overcapacityPenalty(features, model) {
  const promptRank = COMPLEXITY_RANK[features.complexity] || 2;
  const modelRank = COMPLEXITY_RANK[model.complexity_max] || 3;
  return promptRank > modelRank ? promptRank - modelRank : 0;
}

function scoreModel(features, model, weights, hasTools) {
  let score = 0;
  const domains = features.domain || {};
  for (const [d, w] of Object.entries(domains)) {
    score += weights.domain * w * (model.strengths[d] || 0);
  }
  score += weights.action * actionBonus(features.action, model);
  score += weights.code_aware * codeAwareBonus(features, model);
  score -= weights.overcapacity_penalty * overcapacityPenalty(features, model);
  // Effectively exclude tool-incapable models from tool-bearing requests.
  // Some upstreams (DeepSeek-V3.1 confirmed by the upstream team on 2026-05-04)
  // never emit proper tool_calls[] - the call sits as raw chat-template tokens
  // in content. tool_calling: false in models.yaml signals this; the penalty
  // is large enough that the model never wins when tools are requested, but
  // small enough that it can still be picked as a last-resort fallback if
  // every tool-capable model is quarantined.
  if (hasTools && model.tool_calling === false) {
    score -= 100;
  }
  return score;
}

function logDecision(features, ranking, picked) {
  const summary = ranking
    .slice(0, 3)
    .map((r) => `${r.id}=${r.score.toFixed(3)}`)
    .join(" ");
  const dom = JSON.stringify(features.domain || {});
  console.log(
    `[claude-router] action=${features.action} complexity=${features.complexity} ` +
    `domain=${dom} -> ${picked} | top: ${summary}`
  );
}

// Mutate req.body.max_tokens to fit model.context_window. Returns the sizing
// snapshot so callers can attach it to the decision log.
function applyMaxTokensClamp(body, model) {
  const inputTokens = estimateInputTokens(body);
  const requested = Number.isFinite(body.max_tokens) ? body.max_tokens : null;
  const effective = effectiveMaxTokens(model, body);
  body.max_tokens = effective;
  if (requested !== effective) {
    console.log(
      `[claude-router] clamp ${model.id}: input=${inputTokens} ` +
      `requested=${requested ?? "(none)"} effective=${effective} ` +
      `(context_window=${model.context_window})`
    );
  }
  return { input_tokens: inputTokens, max_tokens_requested: requested, max_tokens_effective: effective };
}

function findModel(meta, modelId) {
  return meta.models.find((m) => m.id === modelId) || null;
}

module.exports = async function router(req, config) {
  const meta = config._router_meta;
  if (!meta) {
    console.error("[claude-router] missing _router_meta in config");
    return null;
  }

  // Resolve which model the request will end up on, then clamp max_tokens for
  // it. The clamp must run on every path: scored winner, short-text bypass,
  // promptlint outage, all-quarantined - otherwise long inputs 400 from the
  // provider on the very paths where ccr falls back to the default model.
  const fallbackModel = findModel(meta, meta.fallback_model);

  const text = extractUserText(req.body);
  let features = null;
  let ranking = null;
  let chosenModel = null;
  let picked = null;

  const hasTools = Array.isArray(req.body?.tools) && req.body.tools.length > 0;

  if (text && text.length >= 20) {
    features = await callPromptlint(meta.promptlint_url, text);
    if (features) {
      const candidates = meta.models.filter((m) => !isQuarantined(m.id));
      if (candidates.length > 0) {
        ranking = candidates
          .map((m) => ({
            id: m.id,
            model_name: m.model_name,
            score: scoreModel(features, m, meta.scoring_weights, hasTools),
          }))
          .sort((a, b) => b.score - a.score);
        const winner = ranking[0];
        chosenModel = findModel(meta, winner.id);
        picked = `${winner.id},${winner.model_name}`;
        logDecision(features, ranking, picked);
      } else {
        console.log("[claude-router] all models quarantined - using fallback");
      }
    } else {
      console.log(`[claude-router] promptlint unavailable, fallback=${meta.fallback_model}`);
    }
  }

  // If routing didn't choose a model, ccr will use Router.default → fallback.
  // Clamp against the same model we know it'll land on.
  const effectiveModel = chosenModel || fallbackModel;
  const sizing = effectiveModel ? applyMaxTokensClamp(req.body, effectiveModel) : null;

  const decision = {
    ts: Date.now(),
    modelId: (chosenModel || fallbackModel || {}).id,
    modelName: (chosenModel || fallbackModel || {}).model_name,
    score: ranking ? ranking[0].score : null,
    fallback: !chosenModel,
    sizing,
    features: features
      ? {
          action: features.action,
          complexity: features.complexity,
          domain: features.domain,
          has_code_block: features.has_code_block,
          has_code_ref: features.has_code_ref,
          has_file_path: features.has_file_path,
        }
      : null,
  };
  globalThis.__claudeRouterLastDecision = decision;
  // Prometheus in-memory counters вместо append в decisions.log (файл убран: O(N) re-read не
  // масштабировался, footer-IPC снят). features===null -> promptlint вернул null (unavailable).
  crRecordDecision(decision.modelName, decision.fallback, decision.features === null);

  return picked;
};
