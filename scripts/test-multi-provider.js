#!/usr/bin/env node
'use strict';

/* Gemini → Groq → OpenRouter(:free) 라우팅. 실제 네트워크 호출은 0회다. */
process.env.GEMINI_API_KEY = 'gemini-secret-test';
process.env.GROQ_API_KEY = 'groq-secret-test';
process.env.OPENROUTER_API_KEY = 'sk-or-v1-secret-test';
process.env.AI_CACHE_TTL_MS = '0';

const llm = require('../api/_llm');
let pass = 0, fail = 0;
const seenLogs = [];
const realWarn = console.warn;
console.warn = (...args) => { seenLogs.push(args.join(' ')); realWarn(...args); };
function ok(v, name, detail) {
  if (v) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

const state = { gemini: 'ok', groq: 'ok', openrouter: 'ok', calls: [] };
function providerOf(url) {
  if (String(url).includes('generativelanguage.googleapis.com')) return 'gemini';
  if (String(url).includes('api.groq.com')) return 'groq';
  if (String(url).includes('openrouter.ai')) return 'openrouter';
  return 'unknown';
}
global.fetch = async (url, opts) => {
  const provider = providerOf(url);
  const body = JSON.parse(opts.body);
  const model = provider === 'gemini'
    ? decodeURIComponent(String(url).match(/models\/([^:]+)/)[1]) : body.model;
  state.calls.push({ provider, model, headers: opts.headers });
  const mode = state[provider];
  if (typeof mode === 'number') return { ok: false, status: mode, text: async () =>
    `{"error":"${process.env.GEMINI_API_KEY} ${process.env.GROQ_API_KEY} ${process.env.OPENROUTER_API_KEY}"}` };
  if (mode === 'badjson') return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
  if (provider === 'gemini') return { ok: true, status: 200, json: async () => ({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'gemini-ok' }] } }]
  }) };
  return { ok: true, status: 200, json: async () => ({
    choices: [{ finish_reason: 'stop', message: { content: `${provider}-ok` } }]
  }) };
};

const base = { role: 'answer', messages: [{ role: 'user', content: '안녕' }], maxTokens: 32,
  temperature: 0, perCallMs: 5000, budgetMs: 20000 };
function reset(g, q, o) {
  llm._internal._reset(); state.calls = [];
  state.gemini = g; state.groq = q; state.openrouter = o;
  process.env.GEMINI_MODEL = llm.DEFAULT_GEMINI_MODEL;
  process.env.GROQ_MODEL = llm.DEFAULT_GROQ_MODEL;
}

(async () => {
  console.log('=== 무료 multi-provider router (외부 호출 0회) ===');

  reset('ok', 'ok', 'ok');
  let r = await llm.chat(base);
  ok(r.ok && r.provider === 'gemini', 'Gemini 성공 → Gemini 응답');
  ok(state.calls.map(x => x.provider).join(',') === 'gemini', 'Groq/OpenRouter 호출 0');

  reset(429, 'ok', 'ok');
  r = await llm.chat(base);
  ok(r.ok && r.provider === 'groq', 'Gemini 429 → Groq 성공');
  ok(state.calls.map(x => x.provider).join(',') === 'gemini,groq', '순서가 Gemini → Groq');

  reset(500, 429, 'ok');
  r = await llm.chat(base);
  ok(r.ok && r.provider === 'openrouter', 'Gemini 실패 + Groq 429 → OpenRouter 성공');
  ok(state.calls.map(x => x.provider).join(',') === 'gemini,groq,openrouter', '세 provider 순서 고정');
  ok(state.calls.filter(x => x.provider === 'openrouter').every(x => /:free$/.test(x.model)), 'OpenRouter는 :free만 호출');

  reset('badjson', 500, 429);
  r = await llm.chat(base);
  ok(!r.ok, '세 provider 전부 실패하면 호출부 fallback으로 반환');
  ok(new Set(state.calls.map(x => `${x.provider}:${x.model}`)).size === state.calls.length,
    '동일 요청에서 같은 provider/model 재시도 0');

  reset('ok', 'ok', 'ok');
  process.env.GEMINI_MODEL = 'gemini-3.7-pro-paid';
  process.env.GROQ_MODEL = 'openai/gpt-oss-120b';
  r = await llm.chat(base);
  ok(r.ok && r.provider === 'openrouter', 'allowlist 밖 Gemini/Groq 모델은 skip');
  ok(state.calls.every(x => x.provider === 'openrouter' && /:free$/.test(x.model)), '유료/미승인 provider 모델 network attempt 0');

  const blob = JSON.stringify(r);
  const html = require('fs').readFileSync(require('path').resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok(!blob.includes(process.env.GEMINI_API_KEY) && !html.includes('GEMINI_API_KEY'), 'Gemini key 응답/HTML 비노출');
  ok(!blob.includes(process.env.GROQ_API_KEY) && !html.includes('GROQ_API_KEY'), 'Groq key 응답/HTML 비노출');
  ok(!blob.includes(process.env.OPENROUTER_API_KEY) && !html.includes('OPENROUTER_API_KEY'), 'OpenRouter key 응답/HTML 비노출');
  ok(!seenLogs.join('\n').includes(process.env.GEMINI_API_KEY), 'Gemini key 로그 비노출');
  ok(!seenLogs.join('\n').includes(process.env.GROQ_API_KEY), 'Groq key 로그 비노출');
  ok(!seenLogs.join('\n').includes(process.env.OPENROUTER_API_KEY), 'OpenRouter key 로그 비노출');

  const src = require('fs').readFileSync(require('path').resolve(__dirname, '..', 'api', '_llm.js'), 'utf8');
  ok(!/console\.(?:log|warn|error)\([^\n]*(?:GEMINI_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY)/.test(src), 'provider key 로그 경로 0');
  ok(llm.stats().paidCalls === 0, 'paid network calls = 0');

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  console.warn = realWarn;
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
