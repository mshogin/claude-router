/**
 * Custom router for claude-code-router.
 *
 * Pipeline:
 *   1. Extract last user-message text from req.body.
 *   2. POST it to promptlint /analyze for {action, complexity, domain, ...}.
 *   3. Score every non-quarantined model. Pick argmax.
 *   4. Clamp req.body.max_tokens to fit the chosen model's context window.
 *
 * Quarantine state is shared with footer-proxy via /tmp/claude-router-quarantine.json
 * (footer-proxy writes on 429/5xx, this module reads on each request).
 *
 * Decisions are written to /tmp/claude-router-decisions.log so footer-proxy
 * can render the right "[router] ..." footer into the response.
 */

const fs = require("fs");
const { estimateInputTokens, effectiveMaxTokens } = require("./limits");

const QUARANTINE_FILE = "/tmp/claude-router-quarantine.json";
const DECISIONS_LOG = "/tmp/claude-router-decisions.log";
const COMPLEXITY_RANK = { low: 1, medium: 2, high: 3 };

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

function scoreModel(features, model, weights) {
  let score = 0;
  const domains = features.domain || {};
  for (const [d, w] of Object.entries(domains)) {
    score += weights.domain * w * (model.strengths[d] || 0);
  }
  score += weights.action * actionBonus(features.action, model);
  score += weights.code_aware * codeAwareBonus(features, model);
  score -= weights.overcapacity_penalty * overcapacityPenalty(features, model);
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

  if (text && text.length >= 20) {
    features = await callPromptlint(meta.promptlint_url, text);
    if (features) {
      const candidates = meta.models.filter((m) => !isQuarantined(m.id));
      if (candidates.length > 0) {
        ranking = candidates
          .map((m) => ({
            id: m.id,
            model_name: m.model_name,
            score: scoreModel(features, m, meta.scoring_weights),
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
  try {
    fs.appendFileSync(DECISIONS_LOG, JSON.stringify(decision) + "\n");
  } catch (_) {}

  return picked;
};
