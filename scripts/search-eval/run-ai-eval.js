'use strict';
/*
 * /api/ai (legacy 경로 — 운영이 실제로 쓰는 경로) 오프라인 평가.
 *
 *   node scripts/search-eval/run-ai-eval.js --set dev|holdout --snapshot <catalog.jsonl>
 *        [--code <api 가 있는 루트>] [--label x] [--out <json>] [--only D181] [--show-fail 10]
 *
 * - 게스트(로그인 없음) 요청 — 운영 비로그인 사용자와 같은 경로.
 * - LLM 은 대역: 분류기는 의도(C)만 돌려준다 → 검색어는 서버의 결정적 추출(_intent)을 그대로 쓴다.
 *   답변 생성은 대역 문자열 — 카드는 검색 결과에서만 만들어지므로 카드 채점에는 영향이 없다.
 * - 쇼핑 검색은 동결 카탈로그 검색기(catalog-retriever) — 쿠팡·ADPICK 호출 0회.
 * - 후속 질문(followup)은 seed 질문 다음에 같은 세션(웹 프론트와 같은 chatHistory·convState·서명 참조)으로 보낸다.
 * - 채점: 응답 카드(body.items)를 문항 조건(spec.js)으로. 후보(pool)는 그 턴의 검색이 실제로 돌려준 상품 전체.
 * - 답변 문장 속 «N원» 이 카드 가격·질문 예산 어디에도 없으면 «근거 없는 가격» 으로 센다.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { performance } = require('perf_hooks');

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const SET = arg('--set', 'dev');
const SNAPSHOT = arg('--snapshot');
const CODE = path.resolve(arg('--code', path.join(__dirname, '..', '..')));
const LABEL = arg('--label', path.basename(CODE));
const OUT = arg('--out');
const ONLY = arg('--only');
const SHOW_FAIL = Number(arg('--show-fail', 0));
const CATS = arg('--cats');

const Spec = require('./spec');
const { CatalogRetriever } = require('./catalog-retriever');

process.env.AUTH_SECRET = 'offline-ai-eval-signing-key';
delete process.env.OPENAI_API_KEY;
process.env.OPENROUTER_API_KEY = 'sk-or-v1-OFFLINE-EVAL';
process.env.OPENROUTER_MODELS = 'test/offline:free';
delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY;
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SECRET_KEY; delete process.env.NEON_DATABASE_URL;
delete process.env.SEOSA_DB_READONLY; delete process.env.ENABLE_AI_V3; delete process.env.IDENTITY_CANONICAL_CONSUMER_ENABLED;
process.env.AI_SEARCH_TIMEOUT_MS = '3000';
process.env.AI_ENRICH_TIMEOUT_MS = '1500';
process.env.AI_CACHE_TTL_MS = '0';

let dbWrites = 0;
let externalCalls = 0;
function fakeQuery(table) {
  const o = {};
  ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'gt', 'order', 'limit', 'range', 'is', 'not', 'or', 'filter', 'match', 'neq', 'ilike', 'like', 'contains']
    .forEach(m => { o[m] = () => o; });
  o.maybeSingle = () => Promise.resolve({ data: null, error: null });
  o.single = () => Promise.resolve({ data: null, error: null });
  ['upsert', 'insert', 'update', 'delete'].forEach(m => { o[m] = () => { dbWrites++; return Promise.resolve({ data: null, error: null }); }; });
  o.then = (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
  return o;
}
const fakeSupabase = { from: t => fakeQuery(t), rpc: () => Promise.resolve({ data: [], error: null }) };
const realLoad = Module._load;
Module._load = function (request, parent) {
  if ((request === './_supabase' || request === './_supabase.js') && parent && /[\\/]api[\\/]/.test(parent.filename || '')) return fakeSupabase;
  return realLoad.apply(this, arguments);
};
global.fetch = async (url, opts) => {
  if (!String(url).includes('openrouter.ai')) { externalCalls++; throw new Error(`평가 중 외부 호출 금지: ${url}`); }
  const body = JSON.parse(opts.body);
  // 분류기(짧은 응답): 의도만 — 검색어는 서버의 결정적 추출을 쓴다. 답변(긴 응답): 고정 문장.
  const content = body.max_tokens >= 700 ? '확인된 상품 정보만 바탕으로 안내합니다.' : (body.max_tokens === 120 ? '' : 'C');
  return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
};

const auth = require(path.join(CODE, 'api', '_auth'));
auth.identify = () => ({ ok: false, reason: 'guest' });
const http = require(path.join(CODE, 'api', '_http'));
http.applyCors = () => true;
http.noStore = () => {};
require(path.join(CODE, 'api', '_ratelimit')).guard = () => true;
const shop = require(path.join(CODE, 'api', '_shop'));
let retriever;
let turnPool = [];
shop.searchAll = async (keyword) => {
  const items = retriever.search(keyword, 30);
  const coupang = shop.relevantItems(keyword, items.filter(x => x.mall === '쿠팡'));
  const adpick = shop.relevantItems(keyword, items.filter(x => x.mall !== '쿠팡'));
  const kept = [...coupang.kept, ...adpick.kept].map(x => ({ ...x }));
  kept.forEach(x => { if (!turnPool.some(p => p.productId === x.productId && p.mall === x.mall)) turnPool.push({ ...x }); });
  return { items: kept, from: 'api', failed: false, blocked: false, errors: [], freshAnswered: true,
    providerSources: { coupang: 'api', adpick: 'api' }, providerBlocked: { coupang: false, adpick: false } };
};
shop.saveProducts = async () => ({ saved: 0 });
require(path.join(CODE, 'api', '_trust')).attachTrust = async list => list;
const handler = require(path.join(CODE, 'api', 'ai.js'));

async function ask(state, question) {
  const body = {
    question, chatHistory: state.history.slice(-10), prevTop: state.prevTop, prevTopRef: state.prevTopRef,
    convState: state.convState, view: { source: 'none' }, contextProducts: []
  };
  let status = 200, payload;
  const res = { status(c) { status = c; return this; }, setHeader() { return this; }, json(v) { payload = v; return this; }, end() { payload = {}; return this; } };
  const q = [console.log, console.warn, console.error];
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  turnPool = [];
  const t0 = performance.now();
  try { await handler({ method: 'POST', headers: {}, query: {}, body }, res); }
  finally { [console.log, console.warn, console.error] = q; }
  const ms = performance.now() - t0;
  const b = payload || {};
  state.history.push({ role: 'user', text: question });
  const turn = { role: 'assistant', text: b.text || '' };
  if (b.turnSig) turn.sig = String(b.turnSig);
  state.history.push(turn);
  if (b.topProductId) state.prevTop = String(b.topProductId);
  if (b.topRecommendationRef) state.prevTopRef = String(b.topRecommendationRef);
  if (b.convState) state.convState = String(b.convState);
  return { status, body: b, ms, pool: turnPool.slice() };
}

const numberOf = s => Number(String(s).replace(/[^\d]/g, ''));
function ungroundedPrices(text, cards, question) {
  const said = [...String(text || '').matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*원/g)].map(m => numberOf(m[1]));
  const allowed = new Set(cards.flatMap(c => [c.lprice, c.price, c.displayPrice, c.lowestPrice, c.oprice].map(Number).filter(n => n > 0)));
  const budget = [...String(question).matchAll(/(\d+)\s*만\s*원?/g)].map(m => Number(m[1]) * 10000);
  budget.forEach(n => allowed.add(n));
  return said.filter(n => !allowed.has(n));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)];
}

(async () => {
  retriever = new CatalogRetriever(SNAPSHOT);
  let questions = require(SET === 'holdout' ? './questions-holdout' : './questions-dev');
  if (CATS) questions = questions.filter(q => CATS.split(',').includes(q.cat));
  if (ONLY) questions = questions.filter(q => ONLY.split(',').includes(q.id));
  const results = [];
  const latencies = [];
  for (const spec of questions) {
    const state = { history: [], prevTop: '', prevTopRef: '', convState: '' };
    let seedTurn = null;
    if (spec.seed) seedTurn = await ask(state, spec.seed);
    const t = await ask(state, spec.q);
    latencies.push(t.ms);
    const cards = Array.isArray(t.body.items) ? t.body.items.map(c => ({ ...c, lprice: Number(c.lprice != null ? c.lprice : c.price) })) : [];
    const graded = Spec.gradeQuestion(spec, t.pool, cards);
    const bad = ungroundedPrices(t.body.text, cards, `${spec.seed || ''} ${spec.q}`);
    results.push({
      id: spec.id, cat: spec.cat, q: spec.q, seed: spec.seed || '', verdict: graded.verdict, reason: graded.reason,
      metrics: graded.metrics, status: t.status, cards: cards.length, pool: t.pool.length, ms: Math.round(t.ms),
      seedCards: seedTurn ? (seedTurn.body.items || []).length : undefined,
      ungroundedPrices: bad, text: String(t.body.text || '').slice(0, 160), top: graded.shownTop
    });
  }
  const count = v => results.filter(r => r.verdict === v).length;
  const avg = key => { const v = results.map(r => r.metrics[key]).filter(x => typeof x === 'number'); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 1000) / 1000 : null; };
  const verifiable = results.filter(r => r.verdict !== 'UNVERIFIED');
  const byCat = {};
  results.forEach(r => { const c = byCat[r.cat] || (byCat[r.cat] = { PASS: 0, FAIL: 0, UNVERIFIED: 0 }); c[r.verdict]++; });
  const summary = {
    label: LABEL, set: SET, path: '/api/ai (legacy guest)', questions: results.length,
    PASS: count('PASS'), FAIL: count('FAIL'), UNVERIFIED: count('UNVERIFIED'),
    accuracyVerifiable: verifiable.length ? Math.round(count('PASS') / verifiable.length * 1000) / 10 : null,
    precisionAt5: avg('precision5'), recallAt10: avg('recall10'),
    accessoryConfusionRate: Math.round(results.filter(r => r.metrics.accessoryConfusion).length / results.length * 1000) / 10,
    modelMismatchRate: Math.round(results.filter(r => r.metrics.modelMismatch).length / results.length * 1000) / 10,
    budgetViolations: results.filter(r => r.metrics.budgetViolation).length,
    usedViolations: results.filter(r => r.metrics.usedViolation).length,
    noCardRate: Math.round(results.filter(r => r.cards === 0).length / results.length * 1000) / 10,
    ungroundedPriceClaims: results.reduce((a, r) => a + r.ungroundedPrices.length, 0),
    non200: results.filter(r => r.status !== 200).length,
    latencyMsAvg: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)),
    latencyMsP95: Math.round(percentile(latencies, 95)),
    externalCalls, dbWritesAttempted: dbWrites, byCategory: byCat
  };
  console.log(JSON.stringify(summary, null, 1));
  if (SHOW_FAIL) results.filter(r => r.verdict === 'FAIL').slice(0, SHOW_FAIL).forEach(r => {
    console.log(`\nFAIL ${r.id} [${r.cat}] ${r.seed ? r.seed + ' → ' : ''}${r.q} — ${r.reason} (cards ${r.cards}, pool ${r.pool})`);
    r.top.forEach(t => console.log(`   ${t.ok ? 'ok ' : 'XX '} ${t.price} ${t.title.slice(0, 80)}`));
  });
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1)); }
})().catch(e => { console.error('AI_EVAL_FAIL', e.stack); process.exitCode = 1; });
