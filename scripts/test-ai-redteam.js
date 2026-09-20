#!/usr/bin/env node
'use strict';
// All provider responses are simulated. No external API calls.
const assert = require('node:assert/strict');
const llm = require('../api/_llm');
const rate = require('../api/_ratelimit');
const oldFetch = global.fetch;
const oldWarn = console.warn;
console.warn = () => {};
process.env.GEMINI_API_KEY = 'test-gemini';
process.env.GROQ_API_KEY = 'test-groq';
process.env.OPENROUTER_API_KEY = 'test-openrouter';
process.env.OPENROUTER_MODELS = 'test/one:free,test/two:free';
process.env.AI_CACHE_TTL_MS = '300000';
let passes = 0;
const calls = [];
const modes = { gemini: 'ok', groq: 'ok', openrouter: 'ok' };
let active = 0, peak = 0;
function provider(url) {
  if (url.includes('generativelanguage')) return 'gemini';
  if (url.includes('groq.com')) return 'groq';
  if (url.includes('openrouter.ai')) return 'openrouter';
  throw new Error(`unexpected fetch: ${url}`);
}
function response(p, mode) {
  const status = typeof mode === 'number' ? mode : mode && mode.status;
  if (status) return { ok: false, status, headers: { get: () => mode.retryAfter || '' },
    text: async () => '{"error":"offline"}' };
  if (mode === 'malformed') return { ok: true, status: 200, json: async () => { throw Error('bad json'); } };
  if (mode === 'body-hang') return { ok: true, status: 200, json: () => new Promise(() => {}) };
  const body = mode === 'empty' || mode === 'error-shaped' ? {} : p === 'gemini'
    ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] }
    : { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] };
  return { ok: true, status: 200, json: async () => body };
}
global.fetch = async (url, options) => {
  const p = provider(String(url));
  const body = JSON.parse(options.body);
  calls.push({ provider: p, model: body.model || p });
  active++; peak = Math.max(active, peak);
  try {
    const mode = modes[p];
    if (mode === 'network' || mode === 'reset') throw Error(mode);
    if (mode === 'fetch-hang') return await new Promise(() => {});
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 25));
    return response(p, mode);
  } finally { active--; }
};
const ask = (id = 'same', extra = {}) => llm.chat({ role: 'answer',
  messages: [{ role: 'user', content: id }], maxTokens: 50, temperature: 0,
  perCallMs: 1000, budgetMs: 5000, ...extra });
function reset(g = 'ok', q = 'ok', o = 'ok') {
  llm._internal._reset(); calls.length = 0; active = 0; peak = 0;
  modes.gemini = g; modes.groq = q; modes.openrouter = o;
}
function check(label, condition) {
  assert.ok(condition, label); passes++;
  console.log(`PASS ${label}`);
}
async function run() {
  for (const p of ['gemini', 'groq', 'openrouter']) {
    for (const mode of ['ok', 'empty', 'malformed', 'error-shaped', 400, 401, 402, 403,
      404, 408, 429, 500, 502, 503, 504, 'network', 'reset']) {
      reset(p === 'gemini' ? mode : 429, p === 'groq' ? mode : 429,
        p === 'openrouter' ? mode : 429);
      const r = await ask(`${p}-${mode}`);
      check(`${p} ${mode} terminates`, typeof r.ok === 'boolean' && calls.length <= 4);
    }
  }
  for (const [g, q, o, want] of [
    [429, 'ok', 'ok', 'groq'], [500, 429, 'ok', 'openrouter'],
    [402, 402, 'ok', 'openrouter'], [401, 401, 401, 'none'],
    [402, 402, 402, 'none'], [429, 429, 429, 'none'],
    [500, 500, 500, 'none']]) {
    reset(g, q, o);
    const r = await ask(`combo-${g}-${q}-${o}`);
    check(`combo ${g}/${q}/${o}`, want === 'none' ? !r.ok : r.provider === want);
    check('no repeat model within request', new Set(calls.map(c => `${c.provider}:${c.model}`)).size === calls.length);
  }
  reset(429, 'ok', 'ok');
  await ask('cool-a'); calls.length = 0;
  await ask('cool-b');
  check('Gemini 429 cooldown persists', !calls.some(c => c.provider === 'gemini'));
  reset(401, 'ok', 'ok');
  await ask('auth-a'); calls.length = 0;
  await ask('auth-b');
  check('provider auth cooldown persists', !calls.some(c => c.provider === 'gemini'));
  reset(404, 404, 404);
  await ask('dead-a'); calls.length = 0;
  await ask('dead-b');
  check('all 404 models skipped on next request', calls.length === 0);
  for (const raw of ['1', '10', '60', '600', '3600', '999999999', '-1', 'NaN', 'invalid date']) {
    reset(429, 429, { status: 429, retryAfter: raw });
    await ask(`retry-${raw}`);
    const until = Math.max(...llm._internal.state.providerDead.values());
    check(`Retry-After ${raw} bounded`, until - Date.now() <= 30 * 60 * 1000);
  }
  for (const n of [10, 50, 100, 200]) {
    reset('slow', 'ok', 'ok');
    const result = await Promise.all(Array.from({ length: n }, () => ask(`identical-${n}`)));
    check(`identical ${n}: one upstream`, calls.length === 1 && result.every(r => r.ok));
    console.log(`METRIC identical_${n}_calls=${calls.length}`);
  }
  reset('slow', 'slow', 'slow');
  await Promise.all(Array.from({ length: 100 }, (_, i) => ask(`unique-${i}`)));
  check('100 unique: provider/model cap', llm.stats().providerInflight === 0 && calls.length <= 8);
  console.log(`METRIC unique_100_calls=${calls.length} peak=${peak}`);
  reset(429, 429, 429);
  const storm = await Promise.all(Array.from({ length: 100 }, (_, i) => ask(`storm-${i}`)));
  check('100-user 429 storm terminates', storm.every(r => !r.ok) && calls.length <= 8);
  console.log(`METRIC all_429_calls=${calls.length}`);
  calls.length = 0;
  await ask('after-storm');
  check('429 cooldown prevents next wave', calls.length === 0);
  reset('body-hang', 'ok', 'ok');
  const started = Date.now();
  const timed = await ask('body-hang', { budgetMs: 5000 });
  check('body hang times out and falls back', timed.ok && timed.provider === 'groq' && Date.now() - started < 2500);
  check('body hang releases provider slot', llm.stats().providerInflight === 0);
  reset('fetch-hang', 'fetch-hang', 'fetch-hang');
  const allTimed = await ask('all-timeout', { budgetMs: 9000 });
  check('all-provider timeout terminates', !allTimed.ok && llm.stats().providerInflight === 0
    && calls.some(c => c.provider === 'openrouter'));
  for (let i = 0; i < 10000; i++) {
    rate.check({ headers: { 'x-forwarded-for': `198.51.100.${i}` } },
      { name: 'redteam-memory', limit: 30, windowMs: 60000 });
  }
  check('rate bucket map stays bounded', rate._internal.buckets.size <= rate._internal.MAX_KEYS);
  const verifiedAtCapacity = rate.check({ headers: { 'x-forwarded-for': '203.0.113.9' } },
    { name: 'redteam-auth', key: 'user:verified@example.test', limit: 30, windowMs: 60000 });
  check('verified user admitted during guest key flood', verifiedAtCapacity.ok
    && rate._internal.buckets.size <= rate._internal.MAX_KEYS);
  rate._internal.buckets.clear();
  // Exercise the actual handler: 50 verified accounts behind one NAT must not
  // consume a shared 300/minute allowance.
  const auth = require('../api/_auth');
  const handler = require('../api/ai');
  const savedChat = llm.chat;
  const savedLog = console.log;
  process.env.AUTH_SECRET = 'offline-redteam-signing-key';
  llm.chat = async () => ({ ok: true, text: '안녕하세요.', model: 'fake', provider: 'fake',
    finish: 'stop', tried: [], usage: null, costUsd: 0 });
  const statuses = [];
  const promptLengths = [];
  const bombStatuses = [];
  let outageResponse;
  console.log = () => {};
  try {
    for (let u = 0; u < 50; u++) {
      const token = auth.issueToken(`redteam-${u}@example.test`);
      for (let n = 0; n < 7; n++) {
        const req = { method: 'POST', headers: { authorization: `Bearer ${token}`,
          'x-forwarded-for': '203.0.113.50' }, body: { question: '안녕하세요' } };
        const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
          json() { statuses.push(this.statusCode); return this; }, end() { statuses.push(this.statusCode); } };
        await handler(req, res);
      }
    }
    llm.chat = async opts => {
      promptLengths.push(opts.messages.reduce((n, m) => n + String(m.content || '').length, 0));
      return { ok: true, text: '안녕하세요.', model: 'fake', provider: 'fake',
        finish: 'stop', tried: [], usage: null, costUsd: 0 };
    };
    const token = auth.issueToken('prompt-bomb@example.test');
    for (const size of [10_000, 100_000, 1_000_000, 5_000_000]) {
      const huge = '가'.repeat(size);
      const req = { method: 'POST', headers: { authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.51' }, body: {
        question: `안녕하세요 ${huge}`, chatHistory: [{ role: 'assistant', text: huge }],
        profile: { note: huge }, view: { source: 'search', keyword: huge },
        contextProducts: [{ title: huge, price: 10000 }]
      } };
      const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
        json() { bombStatuses.push(this.statusCode); return this; }, end() { bombStatuses.push(this.statusCode); } };
      await handler(req, res);
    }
    llm.chat = async () => ({ ok: false, reason: 'rate', text: '', model: '', tried: [] });
    const outageReq = { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'x-forwarded-for': '203.0.113.51' }, body: { question: '안녕하세요' } };
    const outageRes = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(body) { outageResponse = { status: this.statusCode, body }; return this; } };
    await handler(outageReq, outageRes);
  } finally { llm.chat = savedChat; console.log = savedLog; }
  check('50 verified users on one IP avoid shared 429', statuses.length === 350
    && statuses.every(s => s !== 429));
  check('10KB to 5MB inputs keep upstream prompt bounded', bombStatuses.length === 4
    && bombStatuses.every(s => s < 500) && promptLengths.length > 0
    && Math.max(...promptLengths) < 100000);
  check('all-provider outage on general question degrades without 500', outageResponse
    && outageResponse.status === 200 && outageResponse.body.degraded
    && !outageResponse.body.error);
  reset('ok', 'ok', 'ok');
  check('zero cost', llm.stats().paidCalls === 0 && llm.stats().estimatedCostUsd === 0);
  console.log(`TOTAL ${passes} PASS / 0 FAIL`);
}
run().catch(e => { console.warn = oldWarn; console.error(e); process.exitCode = 1; })
  .finally(() => { global.fetch = oldFetch; console.warn = oldWarn; });
