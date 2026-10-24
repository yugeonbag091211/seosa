#!/usr/bin/env node
'use strict';

/*
 * Paid live-model check for one read-only Neon price-history snapshot.
 *
 * The product row and observations below were read from the migration-test
 * Neon branch in a SET TRANSACTION READ ONLY transaction on 2026-10-23.
 * Search, trust, persistence, auth, plan and rate-limit boundaries are mocked;
 * only api.openai.com/v1/responses is allowed through the fetch firewall.
 * This checks GPT + real persisted facts through api/ai.js, not a live vendor
 * search or a Production endpoint.
 */
require('./_env.js');
const fs = require('node:fs');
const path = require('node:path');
const { statsFrom } = require('../api/_pricestat');
const { modelFromEnv } = require('../api/_openai-provider');
const { snapshotQuestionCheck } = require('./_live-price-check');

const MAX_BUDGET_USD = 0.25;
const PRICE = { input: 0.10, output: 0.50 }; // USD / 1M tokens; same rate used by api/_llm.js
const DEFAULT_PRODUCT = {
  productId: '8327026885', title: '대웅 취사 보온 전기밥솥 10인용', lprice: 40900,
  mall: '쿠팡', mallLabel: '쿠팡', vendorItemId: '95189584451', itemId: '21246706432',
  collectedAt: '2026-10-22T18:32:56.341Z'
};
const DEFAULT_OBSERVATIONS = [
  ['2026-10-07', 39900], ['2026-10-08', 39900], ['2026-10-09', 39900], ['2026-10-10', 39900],
  ['2026-10-11', 40900], ['2026-10-12', 40900], ['2026-10-13', 40900], ['2026-10-14', 40900],
  ['2026-10-15', 40900], ['2026-10-23', 40900]
].map(([date, price]) => ({ date, price }));
const DEFAULT_EXPECTED = { current: 40900, lastDate: '2026-10-23', low7: 40900, low7Days: 1,
  low30: 39900, low30Days: 10, allTimeLow: 39900, maxGapDays: 8 };
const DEFAULT_QUESTIONS = [
  { id: 'current-last-observed', question: '대웅 취사 보온 전기밥솥 10인용의 현재 확인 가격과 마지막 관측일을 알려줘.',
    check: t => /40,?900\s*원/.test(t) && /10월\s*23일|2026[-/.]10[-/.]23|10\/23/.test(t) },
  { id: 'low-30d', question: '대웅 취사 보온 전기밥솥 10인용의 최근 30일 최저 관측가는 얼마야? 관측 기간과 횟수도 알려줘.',
    check: t => /39,?900\s*원/.test(t) && /30일/.test(t) },
  { id: 'low-7d-sparse', question: '이 밥솥의 최근 7일 최저가는 얼마고, 며칠 기록된 값이야?',
    check: t => /40,?900\s*원/.test(t) && /7일/.test(t) && /1일|하루/.test(t) },
  { id: 'yesterday-gap', question: '어제보다 얼마나 떨어졌어? 어제 기록이 없으면 추측하지 말고 말해줘.',
    check: t => /어제/.test(t) && /(?:기록|관측).{0,24}(?:없|확인할 수 없|비교할 수 없|계산할 수 없)|(?:확인할 수 없|비교할 수 없|계산할 수 없).{0,24}어제/.test(t) },
  { id: 'all-time-not-current-low', question: '현재가가 역대 최저가야? 실제 기록과 비교해서 근거를 알려줘.',
    check: t => /39,?900\s*원/.test(t) && /40,?900\s*원/.test(t) && /아니|아닙|더 높|높은/.test(t) }
];

const snapshotFile = process.env.LIVE_PRICE_HISTORY_SNAPSHOT_FILE || '';
const SNAPSHOT = snapshotFile
  ? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), snapshotFile), 'utf8'))
  : null;
const PRODUCT = SNAPSHOT && SNAPSHOT.product || DEFAULT_PRODUCT;
const OBSERVATIONS = SNAPSHOT && SNAPSHOT.observations || DEFAULT_OBSERVATIONS;
const EXPECTED = SNAPSHOT && SNAPSHOT.expected || DEFAULT_EXPECTED;

const QUESTIONS = SNAPSHOT && Array.isArray(SNAPSHOT.questions)
  ? SNAPSHOT.questions.map(q => ({ ...q, check: text => snapshotQuestionCheck(q, text) }))
  : DEFAULT_QUESTIONS;

if (!process.env.OPENAI_API_KEY) {
  console.error('LIVE_MODEL=not-run reason=OPENAI_API_KEY_missing');
  process.exit(2);
}
if (modelFromEnv() !== 'gpt-6-luna') {
  console.error(`LIVE_MODEL=not-run reason=unpriced_model model=${modelFromEnv()}`);
  process.exit(2);
}
process.env.AI_CACHE_TTL_MS = '0';
process.env.AUTH_SECRET = 'ephemeral-live-price-verification-only';
process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.OPENROUTER_API_KEY = 'LIVE_PRICE_CHECK_GATE_ONLY_NOT_A_CREDENTIAL';
process.env.AI_HOTDEAL_TOOL = '0';

const stats = statsFrom(OBSERVATIONS);
const statChecks = SNAPSHOT ? {
  lastPrice: PRODUCT.lprice,
  lastDate: EXPECTED.lastDate,
  low: EXPECTED.low,
  low7: EXPECTED.low7,
  low7Days: EXPECTED.low7Days,
  low30: EXPECTED.low30,
  low30Days: EXPECTED.low30Days
} : {
  count: 10, lastPrice: 40900, lastDate: '2026-10-23', low: 39900,
  lowCount: 4, lowConfirmed: true, low7: 40900, low7Days: 1,
  low30: 39900, low30Days: 10, avg30: 40500, maxGapDays: 8
};
for (const [key, value] of Object.entries(statChecks)) {
  if (stats[key] !== value) throw new Error(`snapshot/stat mismatch ${key}: ${stats[key]} != ${value}`);
}

// Keep the actual API handler and its prompt, intent, price-claim, and option
// validation code. Replace only service boundaries so no database is written.
const auth = require('../api/_auth');
auth.identify = () => ({ ok: true, email: 'live-price-check@seosa.invalid' });
const http = require('../api/_http');
http.applyCors = () => true;
http.noStore = () => {};
const rateLimit = require('../api/_ratelimit');
rateLimit.guard = () => true;
const plan = require('../api/_plan');
plan.resolvePlan = async () => ({ plan: 'pro', limit: 100000 });
plan.reserve = async () => ({ allowed: true, used: 1, degraded: false });
plan.release = async () => {};
plan.usagePayload = (p, used, limit) => ({ plan: p, used, limit, remaining: limit - used });
const shop = require('../api/_shop');
const trust = require('../api/_trust');
const priceStats = require('../api/_pricestat');
let searchCalls = 0;
let saveCallsSuppressed = 0;
shop.searchAll = async () => {
  searchCalls++;
  return { items: [{ ...PRODUCT, _source: 'cache', _verifiedBy: 'catalog' }],
    allItems: [{ ...PRODUCT, _source: 'cache', _verifiedBy: 'catalog' }], from: 'cache', blocked: false, failed: false };
};
shop.saveProducts = async () => { saveCallsSuppressed++; return { saved: 0 }; };
trust.attachTrust = async list => list;
priceStats.loadStats = async keys => {
  const out = new Map();
  (Array.isArray(keys) ? keys : []).forEach(k => {
    if (!k || String(k.productId) !== PRODUCT.productId || String(k.mall) !== PRODUCT.mall
        || String(k.vendorItemId) !== PRODUCT.vendorItemId) return;
    out.set(`${PRODUCT.productId}|${PRODUCT.mall}|${PRODUCT.vendorItemId}`, stats);
  });
  return out;
};

const AI = require('../api/ai');
const AI_INTERNAL = AI._internal;
const ORIGIN_FETCH = global.fetch;
const calls = [];
const routeWarnings = [];
let estimatedSpendUsd = 0;
let reservedUsd = 0;
let activeQuestion = null;
const redact = value => String(value == null ? '' : value)
  .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]')
  .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
const originalWarn = console.warn;
console.warn = (...args) => {
  const message = redact(args.join(' '));
  if (message.includes('[ai] grounding 실패')) routeWarnings.push({ questionId: activeQuestion, message });
  originalWarn(...args);
};
global.fetch = async (input, init) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input && input.url || '');
  if (!/^https:\/\/api\.openai\.com\/v1\/responses(?:\?|$)/i.test(url)) {
    return new Response('{"error":{"message":"non-OpenAI network blocked"}}',
      { status: 599, headers: { 'content-type': 'application/json' } });
  }
  const body = (() => { try { return JSON.parse(init && init.body || '{}'); } catch (_) { return {}; } })();
  const model = String(body.model || '');
  if (model !== 'gpt-6-luna') throw new Error('unpriced model blocked before network');
  const maxOutput = Number(body.max_output_tokens) || 900;
  const inputBytes = Buffer.byteLength(JSON.stringify(body.input || []) + String(body.instructions || ''), 'utf8');
  const reserve = (Math.ceil(inputBytes / 3) * PRICE.input + maxOutput * PRICE.output) / 1e6;
  if (estimatedSpendUsd + reservedUsd + reserve > MAX_BUDGET_USD) {
    throw new Error('LIVE_PRICE_CHECK $0.25 spend ceiling preflight');
  }
  reservedUsd += reserve;
  const started = Date.now();
  try {
    const response = await ORIGIN_FETCH(input, init);
    let cost = reserve;
    let usage = null;
    let modelOutput = '';
    if (response.ok) {
      try {
        const data = await response.clone().json();
        if (data && data.usage) {
          usage = { inputTokens: Number(data.usage.input_tokens) || 0, outputTokens: Number(data.usage.output_tokens) || 0 };
          cost = (usage.inputTokens * PRICE.input + usage.outputTokens * PRICE.output) / 1e6;
        }
        modelOutput = (Array.isArray(data && data.output) ? data.output : []).flatMap(x =>
          Array.isArray(x && x.content) ? x.content.filter(c => c && c.type === 'output_text').map(c => c.text) : []).join('');
      } catch (_) {}
    }
    estimatedSpendUsd += cost;
    calls.push({ questionId: activeQuestion, kind: maxOutput <= 120 ? 'classify' : 'answer', model,
      status: response.status, latencyMs: Date.now() - started, usage, estimatedCostUsd: cost,
      modelOutput: redact(modelOutput).slice(0, 1800) });
    return response;
  } catch (error) {
    calls.push({ questionId: activeQuestion, kind: maxOutput <= 120 ? 'classify' : 'answer', model,
      status: 0, latencyMs: Date.now() - started, error: redact(error && error.message || error),
      estimatedCostUsd: reserve });
    estimatedSpendUsd += reserve;
    throw error;
  } finally {
    reservedUsd = Math.max(0, reservedUsd - reserve);
  }
};

function invoke(body) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      setHeader() {},
      json(value) { resolve({ status, body: value }); return this; },
      end() { resolve({ status, body: {} }); return this; }
    };
    Promise.resolve(AI({ method: 'POST', headers: {}, query: {}, body }, res)).catch(reject);
  });
}

(async () => {
  const answers = [];
  for (const q of QUESTIONS) {
    activeQuestion = q.id;
    const warningStart = routeWarnings.length;
    let response;
    try {
      response = await invoke({ question: q.question, contextProducts: [], chatHistory: [], view: { source: 'none' } });
    } catch (error) {
      response = { status: 0, body: { error: redact(error && error.message || error), text: '' } };
    }
    const answerText = redact(response && response.body && response.body.text || '');
    const normalized = AI_INTERNAL.normItem({ ...PRODUCT, price: PRODUCT.lprice, hist: stats });
    const unsupported = AI_INTERNAL.unverifiedProductPrices(answerText, [normalized]).length
      + AI_INTERNAL.unverifiedCurrentPrices(answerText, [normalized]).length
      + AI_INTERNAL.unverifiedContextualPrices(answerText, [normalized]).length;
    const liveCalls = calls.filter(c => c.questionId === q.id && c.status >= 200 && c.status < 300);
    const modelAnswer = liveCalls.filter(c => c.kind === 'answer').slice(-1)[0];
    const modelText = modelAnswer ? modelAnswer.modelOutput : '';
    answers.push({ id: q.id, status: response.status, intent: response.body && response.body.intent || null,
      text: answerText, expectedFactCheck: q.check(answerText), unsupportedPriceClaims: unsupported,
      successfulOpenAICalls: liveCalls.length, degraded: !!(response.body && response.body.degraded),
      routeWarnings: routeWarnings.slice(warningStart),
      modelText, modelFactCheck: q.check(modelText),
      modelUnsupportedPriceClaims: AI_INTERNAL.unverifiedProductPrices(modelText, [normalized]).length
        + AI_INTERNAL.unverifiedCurrentPrices(modelText, [normalized]).length
        + AI_INTERNAL.unverifiedContextualPrices(modelText, [normalized]).length });
  }
  const passed = answers.filter(x => x.status === 200 && x.expectedFactCheck && x.unsupportedPriceClaims === 0 && !x.degraded).length;
  const rawPassed = answers.filter(x => x.modelFactCheck && x.modelUnsupportedPriceClaims === 0).length;
  console.log(JSON.stringify({
    verification: 'actual OpenAI Responses API + actual Neon products/price_history snapshot',
    model: modelFromEnv(), costCeilingUsd: MAX_BUDGET_USD,
    estimatedSpendUsd: Number(estimatedSpendUsd.toFixed(8)),
    snapshotBranch: 'migration-test-20261020 (Production mapping not verified)',
    search: 'actual Neon products row injected through mocked searchAll; no live vendor search',
    database: 'read-only snapshot fixture; writes suppressed',
    snapshot: { productId: PRODUCT.productId, vendorItemId: PRODUCT.vendorItemId, itemId: PRODUCT.itemId,
      expected: EXPECTED, observationDates: OBSERVATIONS.map(o => o.date) },
    result: { routePassed: passed, rawModelPassed: rawPassed, total: answers.length, providerCalls: calls.length,
      providerSuccesses: calls.filter(c => c.status >= 200 && c.status < 300).length },
    answers, providerCalls: calls, searchCalls, saveCallsSuppressed
  }, null, 2));
  if (passed !== answers.length) process.exitCode = 1;
})().catch(error => {
  console.error(`LIVE_PRICE_CHECK_FAILED ${redact(error && error.message || error)}`);
  process.exitCode = 1;
});
