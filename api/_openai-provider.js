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

module.exports = {
  ENDPOINT,
  DEFAULT_MODEL,
  modelFromEnv,
  request,
  parse,
  _internal: { MODEL_RE }
};
