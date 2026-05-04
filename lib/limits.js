/**
 * Per-model output sizing.
 *
 *   estimateInputTokens(body)         - approx tokens that will be sent.
 *   effectiveMaxTokens(model, body)   - max_tokens the upstream will accept,
 *                                       clamped to the smaller of:
 *                                         body.max_tokens (caller's request)
 *                                         model.max_output_tokens (soft cap)
 *                                         model.context_window − input − safety
 *
 * Clamp floor: MIN_OUTPUT_TOKENS = 256. We always allow some output room. If
 * input >= context_window the request is doomed; we pass it through anyway
 * and let the provider return the real 400 (variant B).
 *
 * Pure functions, no I/O.
 */

"use strict";

const { estimate } = require("./tokens");

const MIN_OUTPUT_TOKENS = 256;
const DEFAULT_SAFETY_MARGIN = 256;
const DEFAULT_MAX_OUTPUT = 4096;

function estimateInputTokens(body) {
  if (!body || typeof body !== "object") return 0;
  let total = 0;

  const sys = body.system;
  if (typeof sys === "string") {
    total += estimate(sys);
  } else if (Array.isArray(sys)) {
    for (const block of sys) {
      if (block && typeof block.text === "string") total += estimate(block.text);
    }
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    const c = msg && msg.content;
    if (typeof c === "string") {
      total += estimate(c);
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.text === "string") total += estimate(block.text);
        else if (block.input !== undefined) total += estimate(JSON.stringify(block.input));
        else if (block.content !== undefined) total += estimate(typeof block.content === "string" ? block.content : JSON.stringify(block.content));
      }
    }
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const t of tools) {
    if (!t) continue;
    total += estimate(JSON.stringify(t));
  }

  return total;
}

function effectiveMaxTokens(model, body) {
  const requested = Number.isFinite(body && body.max_tokens) ? body.max_tokens : Infinity;
  const modelCap = Number.isFinite(model && model.max_output_tokens) ? model.max_output_tokens : Infinity;

  if (!model || !Number.isFinite(model.context_window)) {
    const fallback = Math.min(requested, modelCap);
    return Number.isFinite(fallback) ? fallback : DEFAULT_MAX_OUTPUT;
  }

  const safety = Number.isFinite(model.output_safety_margin)
    ? model.output_safety_margin
    : DEFAULT_SAFETY_MARGIN;
  const input = estimateInputTokens(body);
  const available = model.context_window - input - safety;

  const candidate = Math.min(requested, modelCap, available);
  return Math.max(MIN_OUTPUT_TOKENS, candidate);
}

module.exports = {
  estimateInputTokens,
  effectiveMaxTokens,
  MIN_OUTPUT_TOKENS,
  DEFAULT_SAFETY_MARGIN,
};
