#!/usr/bin/env node
/**
 * ZERO-COST FALLBACK security test.
 *
 * SEOSA now intentionally uses the owner's direct OpenAI API as the paid primary
 * provider.  This test keeps the old guarantee where it still matters: every
 * fallback provider (Gemini/Groq/OpenRouter) must remain free-only, and an
 * accidental paid OpenRouter model must still be blocked before network I/O.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const saved = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODELS: process.env.OPENROUTER_MODELS,
  OPENROUTER_CLASSIFY_MODELS: process.env.OPENROUTER_CLASSIFY_MODELS,
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  OPENROUTER_CLASSIFY_MODEL: process.env.OPENROUTER_CLASSIFY_MODEL,
  OPENROUTER_ALLOW_PAID: process.env.OPENROUTER_ALLOW_PAID,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  AI_CACHE_TTL_MS: process.env.AI_CACHE_TTL_MS
};
const realFetch = global.fetch;

// This suite verifies the fallback router only. Paid-primary behavior has its own
// offline contract in test-openai-primary.js.
delete process.env.OPENAI_API_KEY;
process.env.OPENROUTER_API_KEY = 'sk-or-test-free-only';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_MODELS;
delete process.env.OPENROUTER_CLASSIFY_MODELS;
delete process.env.OPENROUTER_MODEL;
delete process.env.OPENROUTER_CLASSIFY_MODEL;
delete process.env.OPENROUTER_ALLOW_PAID;
process.env.AI_CACHE_TTL_MS = '0';

const llm = require('../api/_llm');
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

const calls = [];
global.fetch = async (url, opts) => {
  if (!String(url).includes('openrouter.ai/api/v1/chat/completions')) {
    throw new Error(`zero-cost fallback attempted unexpected endpoint: ${url}`);
  }
  const body = JSON.parse(opts.body);
  const model = String(body.model || '');
  calls.push(model);
  if (!/:free$/.test(model)) throw new Error(`paid fallback escaped guard: ${model}`);
  return {
    ok: true, status: 200,
    json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: 'FREE_OK' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    })
  };
};

(async () => {
  console.log('=== ZERO-COST FALLBACK security test ===');

  const wrapperSrc = fs.readFileSync(path.join(ROOT, 'api', '_llm.js'), 'utf8');
  const fallbackSrc = fs.readFileSync(path.join(ROOT, 'api', '_llm-free.js'), 'utf8');
  const aiSrc = fs.readFileSync(path.join(ROOT, 'api', 'ai.js'), 'utf8');

  ok(wrapperSrc.includes("require('./_llm-free')"), 'primary router delegates failures to preserved fallback router');
  ok(/function allowPaid\(\)\s*\{\s*return false;\s*\}/.test(fallbackSrc), 'fallback paid-model switch remains permanently disabled');
  ok(/paid-blocked/.test(fallbackSrc), 'fallback has a network-edge paid-model block');
  ok(aiSrc.indexOf('openrouter.ai/api/') === -1 && aiSrc.indexOf('api.openai.com/') === -1,
    'api/ai.js cannot bypass the central LLM router');

  llm._internal._reset();
  const answerChain = llm.chainFor('answer');
  const classifyChain = llm.chainFor('classify');
  ok(answerChain.length > 0 && answerChain.every(llm.isFree), 'answer fallback chain is entirely :free', answerChain.join(' -> '));
  ok(classifyChain.length > 0 && classifyChain.every(llm.isFree), 'classify fallback chain is entirely :free', classifyChain.join(' -> '));
  ok(llm.allowPaid() === false, 'paid primary is disabled when OPENAI_API_KEY is absent');

  const r1 = await llm.chat({ role: 'answer', messages: [{ role: 'user', content: '안녕' }], maxTokens: 100, budgetMs: 5000 });
  ok(r1.ok && r1.provider === 'openrouter', 'no OpenAI key uses free fallback router');
  ok(calls.length > 0 && calls.every(x => /:free$/.test(x)), 'all actual fallback network calls are free models');
  ok(llm.stats().paidCalls === 0 && llm.stats().zeroCost === true, 'fallback-only runtime records zero paid calls');

  // Configuration accident: even explicitly requesting a paid OpenRouter model
  // cannot turn fallback billing on.
  llm._internal._reset();
  process.env.OPENROUTER_ALLOW_PAID = '1';
  process.env.OPENROUTER_MODELS = 'anthropic/claude-sonnet-5';
  const before = calls.length;
  const r2 = await llm.chat({ role: 'answer', messages: [{ role: 'user', content: '추천' }], maxTokens: 100, budgetMs: 5000 });
  const after = calls.slice(before);
  ok(r2.ok, 'bad paid OpenRouter config still falls back successfully');
  ok(after.length > 0 && after.every(x => /:free$/.test(x)), 'paid OpenRouter override is filtered before network I/O');

  // Defense in depth: bypass chainFor and call the old network-edge attempt directly.
  llm._internal._reset();
  const beforeDirect = calls.length;
  const blocked = await llm._internal.attempt('anthropic/claude-sonnet-5', {
    messages: [{ role: 'user', content: '안녕' }], maxTokens: 100, temperature: 0.2
  }, 3000);
  ok(blocked.ok === false && blocked.reason === 'paid-blocked', 'direct paid OpenRouter attempt is blocked');
  ok(calls.length === beforeDirect, 'blocked paid OpenRouter attempt performs no network call');

  console.log(`\nZero-cost fallback: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})().catch(err => {
  console.error(err && err.stack || err);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
