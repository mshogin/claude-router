#!/usr/bin/env node
/**
 * footer-proxy: thin HTTP layer in front of claude-code-router (:3456).
 *
 * Responsibilities:
 *   1. Forward every request to ccr (which uses lib/router.js for scoring).
 *   2. Footer injection in every response (streaming + non-streaming).
 *   3. Adaptive chat-template tool-call rescue: if an upstream returns
 *      raw chat-template tokens (`<｜tool▁calls▁begin｜>...`) instead of
 *      proper tool_calls, parse them and synthesize Anthropic tool_use
 *      blocks. Only kicks in when markers are detected, so models that
 *      emit proper tool_calls keep their live-streaming behavior.
 *   4. 429 / 5xx quarantine: write quarantine state to a JSON file the
 *      custom router reads on the next request.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CCR_HOST = "127.0.0.1";
const CCR_PORT = 3456;
const PROXY_PORT = parseInt(process.env.FOOTER_PROXY_PORT || "3457", 10);

// Per-user dirs to avoid /tmp ownership conflicts on multi-user hosts.
// Must match lib/router.js so quarantine state and decision log are shared.
const LOGS_DIR = process.env.CLAUDE_ROUTER_LOGS_DIR ||
  path.join(os.homedir(), ".claude-router", "logs");
const STATE_DIR = process.env.CLAUDE_ROUTER_STATE_DIR ||
  path.join(os.homedir(), ".claude-router", "state");
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

const DECISIONS_LOG = path.join(LOGS_DIR, "decisions.log");
const QUARANTINE_FILE = path.join(STATE_DIR, "quarantine.json");
const META_PATH = path.join(os.homedir(), ".claude-code-router", "footer-proxy.json");

// Debug mode: dump every request and upstream response body to disk so we
// can diagnose stream-shape issues like "Content block is not a text block"
// after the fact. Enable with FOOTER_PROXY_DEBUG=1 in run.sh's env.
const DEBUG = process.env.FOOTER_PROXY_DEBUG === "1";
const RAW_DIR = path.join(LOGS_DIR, "raw");
if (DEBUG) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  console.log(`[footer-proxy] DEBUG=1 - dumping req/resp to ${RAW_DIR}/`);
}
let _debugReqCounter = 0;
function debugDumpFile(suffix) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const n = String(++_debugReqCounter).padStart(4, "0");
  return path.join(RAW_DIR, `${ts}-req${n}-${suffix}`);
}

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  } catch (e) {
    console.error(
      `[footer-proxy] WARN: cannot read ${META_PATH}: ${e.message}. ` +
      "Run bin/build-config.sh."
    );
    return { quarantine_minutes: 5, models: [] };
  }
}
let META = loadMeta();
fs.watchFile(META_PATH, { interval: 1000 }, () => {
  META = loadMeta();
  console.log("[footer-proxy] meta reloaded");
});

function readLatestDecision() {
  try {
    const data = fs.readFileSync(DECISIONS_LOG, "utf8");
    const lines = data.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d && d.modelId) return d;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function formatFooter(d) {
  if (!d) return "";
  const dom = JSON.stringify(d.features?.domain || {});
  const action = d.features?.action || "?";
  const complexity = d.features?.complexity || "?";
  return (
    "\n\n---\n" +
    `[router] ${d.modelId} (${d.modelName}) · ` +
    `action=${action} complexity=${complexity} domain=${dom}\n`
  );
}

// ---- chat-template tool-call rescue ---------------------------------------
//
// Some OpenAI-shape upstreams don't extract tool_calls from chat-template
// tokens. They return:
//   "content": "I'll check.<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{\"city\":\"SPB\"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>"
//   "tool_calls": []
// Claude Code rejects this with finish_reason=tool_calls but no usable blocks.
// We parse the tokens here and synthesize proper Anthropic tool_use blocks.
//
// ADAPTIVE behavior:
//   - Real OpenAI tool_calls (proper content_block_start type=tool_use):
//     pass through as live stream, no buffering.
//   - Chat-template tokens detected in text_delta: switch to tool-buffer
//     mode, accumulate until message_stop, then emit synthesized blocks.

const TOOL_MARKER_RE = /<[｜|][^<>|｜]*?tool[_▁](?:calls?[_▁])?(?:begin|sep|end)/;
const TOOL_CALL_RE =
  /<[｜|]tool[_▁]call[_▁]begin[｜|]>([\s\S]*?)<[｜|]tool[_▁]sep[｜|]>([\s\S]*?)<[｜|]tool[_▁]call[_▁]end[｜|]>/g;

function hasToolTemplateMarker(s) {
  return typeof s === "string" && TOOL_MARKER_RE.test(s);
}

function parseToolTemplateText(text) {
  const calls = [];
  TOOL_CALL_RE.lastIndex = 0;
  let m;
  while ((m = TOOL_CALL_RE.exec(text)) !== null) {
    const name = m[1].trim();
    const argsStr = m[2].trim();
    if (!name) continue;
    calls.push({
      id: "toolu_" + Math.random().toString(36).slice(2, 18),
      name,
      arguments: argsStr,
    });
  }
  return calls;
}

function stripToolTemplate(text) {
  // Remove the tool-call envelope, keep the assistant preamble before it.
  const idx = text.search(/<[｜|]tool[_▁]calls?[_▁]begin/);
  if (idx === -1) return text;
  return text.slice(0, idx);
}

function makeToolUseSSE(index, call) {
  const start = {
    type: "content_block_start",
    index,
    content_block: {
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: {},
    },
  };
  const delta = {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: call.arguments },
  };
  const stop = { type: "content_block_stop", index };
  return (
    `event: content_block_start\ndata: ${JSON.stringify(start)}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify(stop)}\n\n`
  );
}

// ---- chat-template control tokens: truncate at boundary -------------------
//
// Some OpenAI-compatible servers leak the model's chat-template control
// tokens into the visible response. Per the ChatML spec these are
// conversation-boundary markers and should be consumed by the inference
// server as stop tokens; they're not meant to reach the client at all.
//
//   <|im_end|>    "this assistant turn is over"            (ChatML / Qwen)
//   <|im_start|>  "starting a new turn" - usually a model
//                 hallucinating a continuation as the user (ChatML)
//   <|endoftext|>                                          (GPT EOS)
//   <｜begin▁of▁sentence｜>  <｜end▁of▁sentence｜>             (DeepSeek)
//
// Correct behavior: truncate at the FIRST such token. Everything from the
// token onward is either the token itself or model hallucination of the
// next turn - neither is part of the assistant reply the model intended
// the user to see.
//
// Tool-call markers (<｜tool▁...｜>) are NOT in this set - they're parsed
// separately above as a real tool-use signal.

const CHAT_TEMPLATE_BOUNDARY_RE =
  /<[｜|](?!tool[_▁])(?:im_(?:start|end)|endoftext|begin[_▁]of[_▁]sentence|end[_▁]of[_▁]sentence)[｜|]>/;

function truncateAtChatTemplateBoundary(s) {
  if (typeof s !== "string") return s;
  const m = s.match(CHAT_TEMPLATE_BOUNDARY_RE);
  if (!m) return s;
  return s.slice(0, m.index);
}

function makeFooterSSE(index, text) {
  const start = {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  };
  const delta = {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  };
  const stop = { type: "content_block_stop", index };
  return (
    `event: content_block_start\ndata: ${JSON.stringify(start)}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify(stop)}\n\n`
  );
}

function readQuarantine() {
  try {
    return JSON.parse(fs.readFileSync(QUARANTINE_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function writeQuarantine(state) {
  try {
    fs.writeFileSync(QUARANTINE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[footer-proxy] quarantine write failed: ${e.message}`);
  }
}

function markQuarantined(modelId, minutes) {
  const state = readQuarantine();
  state[modelId] = Date.now() + minutes * 60 * 1000;
  writeQuarantine(state);
  console.log(`[footer-proxy] quarantined ${modelId} for ${minutes}m`);
}

function buildHandler(req, res, body) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  let parsedBody = null;
  try {
    parsedBody = body && body.length ? JSON.parse(body.toString("utf8")) : null;
  } catch (_) {}

  const target = {
    host: CCR_HOST, port: CCR_PORT, pathPrefix: "", label: "ccr",
  };

  console.log(
    `[footer-proxy] ${req.method} ${url.pathname} -> ${target.label} ` +
    `(tools=${parsedBody?.tools?.length || 0})`
  );

  let debugId = null;
  if (DEBUG && body && url.pathname.includes("messages")) {
    debugId = String(_debugReqCounter + 1).padStart(4, "0");
    try {
      fs.writeFileSync(debugDumpFile("request.json"), body);
    } catch (e) {
      console.error(`[footer-proxy] debug request dump failed: ${e.message}`);
    }
  }

  // Reshape Claude Code's <system-reminder>...</system-reminder> blocks
  // from messages[*].content[*].text into proper system[] entries.
  //
  // Anthropic-trained models recognize <system-reminder> inside user
  // content as system-level directives. Non-Anthropic upstreams in our
  // pool (Qwen, DeepSeek, GLM via internal-gateway, sglang, ollama, ...) are not
  // trained on this convention - to them the tag is just text, easily
  // ignored on long contexts. As a result, ~/.claude/CLAUDE.md and
  // ~/.claude/rules/* (which Claude Code packs into <system-reminder>
  // tags inside the first user message) had no effective weight.
  //
  // We extract the inner text of every <system-reminder> tag from user
  // content and append it to system[] - the slot all OpenAI-shape models
  // genuinely treat as overriding context. The original tag is stripped
  // from the user message so the content isn't duplicated.
  if (parsedBody && Array.isArray(parsedBody.messages)) {
    if (!Array.isArray(parsedBody.system)) {
      parsedBody.system = parsedBody.system
        ? [{ type: "text", text: String(parsedBody.system) }]
        : [];
    }
    let reshapedCount = 0;
    const reminderRegex = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
    for (const msg of parsedBody.messages) {
      if (!Array.isArray(msg.content)) continue;
      const newContent = [];
      for (const block of msg.content) {
        if (
          !block ||
          block.type !== "text" ||
          typeof block.text !== "string" ||
          !block.text.includes("<system-reminder>")
        ) {
          newContent.push(block);
          continue;
        }
        let stripped = block.text;
        let m;
        reminderRegex.lastIndex = 0;
        while ((m = reminderRegex.exec(block.text)) !== null) {
          const inner = m[1].trim();
          if (inner) {
            parsedBody.system.push({ type: "text", text: inner });
            reshapedCount++;
          }
          stripped = stripped.replace(m[0], "");
        }
        stripped = stripped.trim();
        if (stripped) {
          newContent.push({ ...block, text: stripped });
        }
        // if the block was nothing but a reminder, drop it entirely
      }
      msg.content = newContent;
    }
    if (reshapedCount > 0) {
      console.log(
        `[footer-proxy] reshaped ${reshapedCount} <system-reminder> ` +
        `block(s) from user content into system[]`
      );
    }
    body = Buffer.from(JSON.stringify(parsedBody), "utf8");
  }

  const headers = { ...req.headers };
  delete headers["content-length"];
  delete headers["host"];
  if (body) headers["content-length"] = String(body.length);

  const opts = {
    hostname: target.host,
    port: target.port,
    method: req.method,
    path: target.pathPrefix + url.pathname + url.search,
    headers,
  };

  const upstreamReq = http.request(opts, (upstreamRes) => {
    handleUpstreamResponse(upstreamRes, res);
  });

  upstreamReq.on("error", (e) => {
    console.error(`[footer-proxy] upstream error (${target.label}): ${e.message}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: `Upstream ${target.label} unreachable: ${e.message}`,
      },
    }));
  });

  if (body) upstreamReq.end(body);
  else upstreamReq.end();
}

function handleUpstreamResponse(upstreamRes, res) {
  const ct = (upstreamRes.headers["content-type"] || "").toLowerCase();
  const status = upstreamRes.statusCode || 502;
  const isStream = ct.includes("text/event-stream");
  const isJson = ct.includes("application/json");

  // Quarantine on 429 / 5xx for whichever model the router last picked.
  if (status === 429 || (status >= 500 && status < 600)) {
    const d = readLatestDecision();
    if (d?.modelId) {
      markQuarantined(d.modelId, META.quarantine_minutes || 5);
    }
  }

  const decision = readLatestDecision();
  const footer = formatFooter(decision);

  if (status >= 400 || (!isStream && !isJson) || !footer) {
    const outHeaders = { ...upstreamRes.headers };
    res.writeHead(status, outHeaders);
    upstreamRes.pipe(res);
    return;
  }

  if (isStream) {
    const outHeaders = { ...upstreamRes.headers };
    delete outHeaders["content-length"];
    res.writeHead(status, outHeaders);

    // DEBUG: tee both raw upstream stream and our processed output to disk.
    // Compare the two files to localize "Content block is not a text block":
    //   if raw is invalid -> upstream model / ccr issue
    //   if processed is invalid but raw is fine -> our footer-proxy injection broke shape
    let debugRawStream = null;
    let debugOutStream = null;
    if (DEBUG) {
      try {
        debugRawStream = fs.createWriteStream(debugDumpFile("upstream.sse"));
        debugOutStream = fs.createWriteStream(debugDumpFile("processed.sse"));
      } catch (e) {
        console.error(`[footer-proxy] debug stream dump failed: ${e.message}`);
      }
    }
    const writeOut = (s) => {
      res.write(s);
      if (debugOutStream) debugOutStream.write(s);
    };

    let buffer = "";
    let footerInjected = false;
    let highestIndex = 0;
    let sawToolUseBlock = false;          // real Anthropic tool_use block

    // Adaptive chat-template parser state.
    //   "stream"      - normal passthrough; we tee each text_delta and watch
    //                   for chat-template tool tokens.
    //   "tool_buffer" - markers seen, we stop emitting text_deltas and
    //                   buffer the rest of the assistant turn so we can
    //                   synthesize proper tool_use blocks at the end.
    let mode = "stream";
    let toolBufferText = "";              // accumulated tokens (incl. preamble after split)
    let textBlockOpenIdx = null;          // index of currently-open text block
    let pendingMessageDelta = null;       // hold message_delta until we emit synthesized blocks

    function emitTextDelta(idx, text) {
      if (!text) return "";
      const ev = {
        type: "content_block_delta",
        index: idx,
        delta: { type: "text_delta", text },
      };
      return `event: content_block_delta\ndata: ${JSON.stringify(ev)}\n\n`;
    }

    upstreamRes.on("data", (chunk) => {
      if (debugRawStream) debugRawStream.write(chunk);
      buffer += chunk.toString("utf8");
      let out = "";
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, idx + 2);
        buffer = buffer.slice(idx + 2);

        const ix = event.match(/"index"\s*:\s*(\d+)/);
        if (ix) {
          const v = parseInt(ix[1], 10);
          if (v > highestIndex) highestIndex = v;
        }

        // Real Anthropic tool_use block start - don't synthesize, don't inject.
        if (
          /"type"\s*:\s*"content_block_start"/.test(event) &&
          /"type"\s*:\s*"tool_use"/.test(event)
        ) {
          sawToolUseBlock = true;
        }

        // Track open text block indices so we can close them later.
        if (
          /"type"\s*:\s*"content_block_start"/.test(event) &&
          /"type"\s*:\s*"text"/.test(event)
        ) {
          const m = event.match(/"index"\s*:\s*(\d+)/);
          if (m) textBlockOpenIdx = parseInt(m[1], 10);
        }

        // === Adaptive parser: check text_deltas for chat-template marker ===
        if (mode === "stream") {
          const textDeltaMatch =
            /"type"\s*:\s*"content_block_delta"/.test(event) &&
            /"type"\s*:\s*"text_delta"/.test(event);
          if (textDeltaMatch) {
            const dataM = event.match(/^data: (.*)$/m);
            if (dataM) {
              try {
                const payload = JSON.parse(dataM[1]);
                const text = payload.delta?.text || "";
                if (hasToolTemplateMarker(text)) {
                  // Split: emit clean prefix, switch to tool_buffer for the rest.
                  const sIdx = text.search(/<[｜|]tool[_▁]/);
                  const preamble = sIdx > 0 ? text.slice(0, sIdx) : "";
                  if (preamble) {
                    out += emitTextDelta(
                      payload.index ?? 0,
                      truncateAtChatTemplateBoundary(preamble),
                    );
                  }
                  toolBufferText = text.slice(sIdx);
                  mode = "tool_buffer";
                  continue; // do not forward original delta
                }
                // Truncate at chat-template boundary (e.g. <|im_end|>).
                // If we hit a boundary, emit only the clean prefix and
                // suppress every subsequent text_delta until message_delta.
                const truncated = truncateAtChatTemplateBoundary(text);
                if (truncated !== text) {
                  if (truncated) {
                    out += emitTextDelta(payload.index ?? 0, truncated);
                  }
                  mode = "drop_until_message_delta";
                  continue;
                }
              } catch (_) {}
            }
          }
          // Inject footer before message_delta (only for normal chat replies).
          if (
            !footerInjected &&
            !sawToolUseBlock &&
            /"type"\s*:\s*"message_delta"/.test(event)
          ) {
            out += makeFooterSSE(Math.max(99, highestIndex + 1), footer);
            footerInjected = true;
          }
          out += event;
          continue;
        }

        // mode === "drop_until_message_delta"
        // We hit a chat-template boundary (e.g. <|im_end|>) in the current
        // text block. We need to suppress the rest of THAT block's noise
        // but never drop a legitimate new block (a tool_use following the
        // leaked text was the original symptom of "Content block not
        // found" on the client).
        if (mode === "drop_until_message_delta") {
          if (/"type"\s*:\s*"content_block_stop"/.test(event)) {
            out += event; // close the dirty text block normally
            continue;
          }
          // A NEW content block is starting (e.g. tool_use after a text
          // block that leaked chat-template tokens). The dirty block has
          // already been closed (or will be) - the new block is legit and
          // must be forwarded with all its deltas, so we exit drop mode.
          if (/"type"\s*:\s*"content_block_start"/.test(event)) {
            // Track tool_use so we don't inject a footer later.
            if (/"type"\s*:\s*"tool_use"/.test(event)) {
              sawToolUseBlock = true;
            }
            out += event;
            mode = "stream";
            continue;
          }
          if (/"type"\s*:\s*"message_delta"/.test(event)) {
            // Inject footer before message_delta, then resume passthrough.
            if (!footerInjected && !sawToolUseBlock) {
              out += makeFooterSSE(Math.max(99, highestIndex + 1), footer);
              footerInjected = true;
            }
            out += event;
            mode = "stream";
            continue;
          }
          if (/"type"\s*:\s*"message_stop"/.test(event)) {
            out += event;
            mode = "stream";
            continue;
          }
          // anything else (more text_delta in the dirty block, ...) -> drop.
          continue;
        }

        // mode === "tool_buffer"
        if (
          /"type"\s*:\s*"content_block_delta"/.test(event) &&
          /"type"\s*:\s*"text_delta"/.test(event)
        ) {
          const dataM = event.match(/^data: (.*)$/m);
          if (dataM) {
            try {
              const payload = JSON.parse(dataM[1]);
              toolBufferText += payload.delta?.text || "";
            } catch (_) {}
          }
          continue; // swallow
        }
        if (/"type"\s*:\s*"content_block_stop"/.test(event)) {
          // Hold; we'll emit the close ourselves once we synthesize tools.
          continue;
        }
        if (/"type"\s*:\s*"message_delta"/.test(event)) {
          pendingMessageDelta = event;
          continue;
        }
        if (/"type"\s*:\s*"message_stop"/.test(event)) {
          // Flush tool-buffer: parse, emit synthesized SSE.
          const calls = parseToolTemplateText(toolBufferText);
          // Close the still-open text block (the one we started splitting from).
          if (textBlockOpenIdx !== null) {
            const stopEv = {
              type: "content_block_stop",
              index: textBlockOpenIdx,
            };
            out += `event: content_block_stop\ndata: ${JSON.stringify(stopEv)}\n\n`;
          }
          let nextIdx = (textBlockOpenIdx ?? -1) + 1;
          for (const call of calls) {
            out += makeToolUseSSE(nextIdx, call);
            nextIdx++;
          }
          // Replace pendingMessageDelta's stop_reason with tool_use.
          if (pendingMessageDelta) {
            try {
              const dm = pendingMessageDelta.match(/^data: (.*)$/m);
              const obj = JSON.parse(dm[1]);
              obj.delta = obj.delta || {};
              obj.delta.stop_reason = calls.length ? "tool_use" : "end_turn";
              out +=
                `event: message_delta\ndata: ${JSON.stringify(obj)}\n\n`;
            } catch (_) {
              out += pendingMessageDelta;
            }
            pendingMessageDelta = null;
          }
          out += event; // message_stop
          mode = "stream"; // reset
          toolBufferText = "";
          sawToolUseBlock = sawToolUseBlock || calls.length > 0;
          continue;
        }
        // any other event type while buffering - just swallow it.
      }
      if (out) writeOut(out);
    });

    upstreamRes.on("end", () => {
      if (buffer) writeOut(buffer);
      res.end();
      if (debugRawStream) debugRawStream.end();
      if (debugOutStream) debugOutStream.end();
    });
    upstreamRes.on("error", () => {
      res.end();
      if (debugRawStream) debugRawStream.end();
      if (debugOutStream) debugOutStream.end();
    });
    return;
  }

  // application/json — buffer, optionally rescue chat-template tool calls,
  // append footer.
  let respBody = "";
  upstreamRes.on("data", (c) => (respBody += c.toString("utf8")));
  upstreamRes.on("end", () => {
    try {
      const json = JSON.parse(respBody);
      if (Array.isArray(json.content)) {
        // Rescue chat-template tool calls in any text block.
        const newContent = [];
        let synthesized = 0;
        for (const c of json.content) {
          if (c.type === "text" && hasToolTemplateMarker(c.text || "")) {
            const preamble = truncateAtChatTemplateBoundary(stripToolTemplate(c.text));
            if (preamble.trim()) {
              newContent.push({ type: "text", text: preamble });
            }
            for (const call of parseToolTemplateText(c.text)) {
              newContent.push({
                type: "tool_use",
                id: call.id,
                name: call.name,
                input: (() => {
                  try { return JSON.parse(call.arguments); }
                  catch (_) { return {}; }
                })(),
              });
              synthesized++;
            }
          } else if (c.type === "text" && typeof c.text === "string") {
            // Truncate at chat-template boundary for plain text replies too.
            newContent.push({ ...c, text: truncateAtChatTemplateBoundary(c.text) });
          } else {
            newContent.push(c);
          }
        }
        json.content = newContent;
        if (synthesized > 0 && json.stop_reason !== "tool_use") {
          json.stop_reason = "tool_use";
        }

        const hasToolUse = newContent.some((c) => c.type === "tool_use");
        if (!hasToolUse) {
          newContent.push({ type: "text", text: footer });
        }
      }
      const out = JSON.stringify(json);
      const outHeaders = { ...upstreamRes.headers };
      delete outHeaders["content-length"];
      res.writeHead(status, outHeaders);
      res.end(out);
    } catch (_) {
      const outHeaders = { ...upstreamRes.headers };
      res.writeHead(status, outHeaders);
      res.end(respBody);
    }
  });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    try {
      buildHandler(req, res, body);
    } catch (e) {
      console.error(`[footer-proxy] handler error: ${e?.message || e}`);
      try {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal proxy error");
      } catch (_) {}
    }
  });
  req.on("error", (e) => {
    console.error(`[footer-proxy] request error: ${e.message}`);
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(`Bad request: ${e.message}`);
  });
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`[footer-proxy] listening on :${PROXY_PORT} -> ccr :${CCR_PORT}`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
