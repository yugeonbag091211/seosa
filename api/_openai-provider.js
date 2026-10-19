'use strict';

/*
 * Direct OpenAI provider for SEOSA.
 *
 * The API key is read only from Vercel/server environment variables and is never
 * embedded in source.  This module intentionally only builds/parses the request;
 * timeout, circuit-breaker, fallback and accounting stay centralized in _llm.js.
 */
const ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-6-luna';
const MAX_MODEL_LEN = 80;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function modelFromEnv() {
  const raw = String(process.env.OPENAI_MODEL || DEFAULT_MODEL).trim().slice(0, MAX_MODEL_LEN);
  return MODEL_RE.test(raw) ? raw : DEFAULT_MODEL;
}

function request(model, opts) {
  const messages = Array.isArray(opts && opts.messages) ? opts.messages : [];
  const instructions = messages
    .filter(m => m && (m.role === 'system' || m.role === 'developer'))
    .map(m => String(m.content || ''))
    .filter(Boolean)
    .join('\n');

  const input = messages
    .filter(m => m && m.role !== 'system' && m.role !== 'developer')
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '')
    }));

  const body = {
    model,
    input,
    max_output_tokens: Math.max(1, Number(opts && opts.maxTokens) || 900),
    store: false
  };
  // GPT-6 Luna defaults to medium reasoning, which can consume most of SEOSA's
  // interactive latency budget before producing visible text. SEOSA already does
  // its product/ranking reasoning deterministically, so use Luna's documented
  // no-reasoning mode for the final conversational pass. Do not apply this to
  // other models because their supported effort levels can differ.
  if (/^gpt-6-luna(?:$|-)/i.test(model)) body.reasoning = { effort: 'none' };
  if (instructions) body.instructions = instructions;

  return {
    url: ENDPOINT,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body
  };
}

function parse(data) {
  let text = '';
  const output = Array.isArray(data && data.output) ? data.output : [];
  for (const item of output) {
    if (!item || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string') text += part.text;
    }
  }
  // Some SDK/proxy surfaces expose output_text as a convenience field. The raw
  // Responses API normally uses output[].content[], but accepting this is harmless.
  if (!text && data && typeof data.output_text === 'string') text = data.output_text;

  const u = data && data.usage;
  const usage = u ? {
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    totalTokens: Number(u.total_tokens) || ((Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0))
  } : null;

  return {
    text,
    finish: String((data && data.status) || ''),
    usage
  };
}

/*
 * ── Agent (function calling) requests — AI Concierge v2 (api/_agent.js) ──────
 *
 * The plain request() above folds a chat transcript into one Responses call.
 * The v2 shopping agent instead runs a short tool loop: the model may answer
 * directly, or emit function_call items that the server executes and returns as
 * function_call_output items.  Everything stays stateless (store:false), so every
 * round re-sends the transcript, including the model's own function_call items.
 *
 * The caller builds `input` as Responses input items.  This module only shapes
 * the HTTP body and reads the output; tools run in api/_agenttools.js.
 */
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);

function agentModelFromEnv() {
  const raw = String(process.env.AI_V2_MODEL || '').trim().slice(0, MAX_MODEL_LEN);
  return raw && MODEL_RE.test(raw) ? raw : modelFromEnv();
}

/** Reasoning effort for agent rounds. Luna keeps the same no-reasoning default as request(). */
function agentReasoningEffort(model) {
  const raw = String(process.env.AI_V2_REASONING_EFFORT || '').trim().toLowerCase();
  if (REASONING_EFFORTS.has(raw)) return raw;
  return /^gpt-6-luna(?:$|-)/i.test(model) ? 'none' : '';
}

function agentRequest(model, opts) {
  const o = opts || {};
  const body = {
    model,
    input: Array.isArray(o.input) ? o.input : [],
    max_output_tokens: Math.max(16, Number(o.maxTokens) || 900),
    store: false
  };
  if (o.instructions) body.instructions = String(o.instructions);
  if (Array.isArray(o.tools) && o.tools.length) {
    body.tools = o.tools;
    body.tool_choice = o.toolChoice === 'none' || o.toolChoice === 'required' ? o.toolChoice : 'auto';
    body.parallel_tool_calls = o.parallelToolCalls !== false;
  }
  if (o.textFormat && typeof o.textFormat === 'object') body.text = { format: o.textFormat };
  const effort = agentReasoningEffort(model);
  if (effort) {
    body.reasoning = { effort };
    // Stateless reasoning items can only be replayed with their encrypted content.
    if (effort !== 'none') body.include = ['reasoning.encrypted_content'];
  }
  return {
    url: ENDPOINT,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body
  };
}

/**
 * Responses output → { text, toolCalls, replay, finish, usage }.
 *
 * replay holds the items to append to `input` before the next round: the model's
 * function_call items (id dropped — store:false has nothing to reference) and any
 * reasoning items carrying encrypted content.  Assistant text that accompanied tool
 * calls is replayed as an assistant message so the next round sees it.
 */
function parseAgent(data) {
  const base = parse(data);
  const output = Array.isArray(data && data.output) ? data.output : [];
  const toolCalls = [];
  const replay = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call' && typeof item.name === 'string') {
      const callId = String(item.call_id || item.id || '').slice(0, 128);
      if (!callId) continue;
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {});
      toolCalls.push({ callId, name: item.name.slice(0, 64), arguments: args });
      replay.push({ type: 'function_call', call_id: callId, name: item.name.slice(0, 64), arguments: args });
    } else if (item.type === 'reasoning' && item.encrypted_content) {
      replay.push(item);
    }
  }
  if (toolCalls.length && base.text) replay.unshift({ role: 'assistant', content: base.text });
  const incomplete = data && data.incomplete_details && data.incomplete_details.reason;
  // Latency accounting (api/_agent.js debug trace): cached prompt tokens and hidden reasoning tokens.
  const u = data && data.usage;
  const usage = base.usage ? Object.assign({}, base.usage, {
    cachedTokens: Number(u && u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0,
    reasoningTokens: Number(u && u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0
  }) : null;
  return {
    text: base.text,
    toolCalls,
    replay,
    finish: incomplete ? `incomplete:${String(incomplete).slice(0, 40)}` : base.finish,
    usage
  };
}

module.exports = {
  ENDPOINT,
  DEFAULT_MODEL,
  modelFromEnv,
  request,
  parse,
  agentModelFromEnv,
  agentReasoningEffort,
  agentRequest,
  parseAgent,
  _internal: { MODEL_RE }
};
