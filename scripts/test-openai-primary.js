#!/usr/bin/env node
'use strict';

/* Offline contract test: direct OpenAI is primary; the existing free router is fallback. */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const savedEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  AI_CACHE_TTL_MS: process.env.AI_CACHE_TTL_MS
};
const realFetch = global.fetch;
const realWarn = console.warn;

process.env.OPENAI_API_KEY = 'sk-test-openai-secret-never-log';
process.env.OPENAI_MODEL = 'gpt-6-luna';
process.env.OPENROUTER_API_KEY = 'sk-or-test-fallback';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.AI_CACHE_TTL_MS = '0';

const llm = require('../api/_llm');
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

function openAIResponse(text) {
  return {
    ok: true, status: 200,
    json: async () => ({
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 }
    })
  };
}

function openRouterResponse(text) {
  return {
    ok: true, status: 200,
    json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: text } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    })
  };
}

(async () => {
  console.log('=== OpenAI primary provider contract ===');

  // 1) Success: OpenAI must be the first and only upstream call.
  {
    llm._internal._reset();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts, body: JSON.parse(opts.body) });
      if (String(url) === 'https://api.openai.com/v1/responses') return openAIResponse('OPENAI_OK');
      throw new Error(`unexpected fallback call: ${url}`);
    };
    const r = await llm.chat({ role: 'answer', messages: [{ role: 'user', content: 'G304 가격 알려줘' }], maxTokens: 200, budgetMs: 9000 });
    ok(r.ok && r.provider === 'openai' && r.text === 'OPENAI_OK', 'OpenAI success is returned as primary');
    ok(calls.length === 1 && calls[0].url === 'https://api.openai.com/v1/responses', 'OpenAI Responses endpoint is called first');
    ok(calls[0].body.model === 'gpt-6-luna' && calls[0].body.store === false, 'configured model + store:false are enforced');
    ok(calls[0].body.reasoning && calls[0].body.reasoning.effort === 'none', 'Luna uses reasoning:none for interactive latency');
    ok(calls[0].body.max_output_tokens === 200, 'output token ceiling is forwarded');
    const s = llm.stats();
    ok(s.primaryProvider === 'openai' && s.paidCalls === 1 && s.openAI.successes === 1, 'paid-provider accounting records the call');
    ok(Number(r.costUsd) > 0 && Number(s.estimatedCostUsd) > 0, 'known Luna usage produces a cost estimate');
    const otherReq = require('../api/_openai-provider').request('gpt-6.1-sol', { messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
    ok(!otherReq.body.reasoning, 'Luna latency override is not applied to other models');
  }

  // 2) Quota/rate failure: user still receives the old free OpenRouter answer.
  {
    llm._internal._reset();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(String(url));
      if (String(url) === 'https://api.openai.com/v1/responses') {
        return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) };
      }
      if (String(url).includes('openrouter.ai/api/v1/chat/completions')) return openRouterResponse('FREE_FALLBACK_OK');
      throw new Error(`unexpected provider: ${url}`);
    };
    const r = await llm.chat({ role: 'answer', messages: [{ role: 'user', content: '이어폰 추천' }], maxTokens: 200, budgetMs: 9000 });
    ok(r.ok && r.provider === 'openrouter' && r.text === 'FREE_FALLBACK_OK', 'OpenAI failure falls back to existing free router');
    ok(calls[0] === 'https://api.openai.com/v1/responses' && calls.some(x => x.includes('openrouter.ai')), 'fallback happens only after OpenAI attempt');
    ok(Array.isArray(r.tried) && r.tried[0] && r.tried[0].provider === 'openai', 'tried trace records OpenAI failure first');
  }

  // 3) Auth errors must not log the API key or upstream body.
  {
    llm._internal._reset();
    const logs = [];
    console.warn = (...args) => logs.push(args.join(' '));
    global.fetch = async url => {
      if (String(url) === 'https://api.openai.com/v1/responses') return { ok: false, status: 401, json: async () => ({ error: { message: process.env.OPENAI_API_KEY } }) };
      if (String(url).includes('openrouter.ai')) return openRouterResponse('SAFE_FALLBACK');
      throw new Error(`unexpected provider: ${url}`);
    };
    const r = await llm.chat({ role: 'answer', messages: [{ role: 'user', content: '안녕' }], maxTokens: 100, budgetMs: 9000 });
    console.warn = realWarn;
    ok(r.ok, 'auth failure still falls back safely');
    ok(logs.every(x => !x.includes('sk-test-openai-secret-never-log')), 'OpenAI API key is never logged');
  }

  // 4) No OpenAI key: behavior remains the previous free router exactly.
  {
    llm._internal._reset();
    delete process.env.OPENAI_API_KEY;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(String(url));
      if (String(url).includes('openrouter.ai')) return openRouterResponse('FREE_ONLY_OK');
      throw new Error(`unexpected provider without OPENAI_API_KEY: ${url}`);
    };
    const r = await llm.chat({ role: 'answer', messages: [{ role: 'user', content: '안녕' }], maxTokens: 100, budgetMs: 9000 });
    ok(r.ok && r.provider === 'openrouter' && r.text === 'FREE_ONLY_OK', 'missing OpenAI key preserves old free behavior');
    ok(calls.every(x => !x.includes('api.openai.com')), 'no OpenAI request occurs without a key');
    process.env.OPENAI_API_KEY = 'sk-test-openai-secret-never-log';
  }

  console.log(`\nOpenAI primary: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})().catch(err => {
  console.warn = realWarn;
  console.error(err && err.stack || err);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = realFetch;
  console.warn = realWarn;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
