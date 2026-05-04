/**
 * Token estimator.
 *
 * Baseline: chars / 4 — the standard rule-of-thumb for GPT/Claude family
 * tokenizers. Underestimates for CJK, slightly overestimates for code with
 * many short tokens, but is honest within ~20% across mixed prompts and
 * needs no native dependencies.
 *
 * If a model-specific tokenizer becomes worth the weight (tiktoken,
 * sentencepiece), replace the body of `estimate` and keep the signature.
 */

"use strict";

const CHARS_PER_TOKEN = 4;

function estimate(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

module.exports = { estimate };
