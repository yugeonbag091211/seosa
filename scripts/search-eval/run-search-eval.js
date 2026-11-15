'use strict';
/*
 * /api/search 핸들러 오프라인 평가 — 같은 후보를 서로 다른 코드 버전에 넣어 비교한다.
 *
 *   node scripts/search-eval/run-search-eval.js --set dev|holdout --snapshot <catalog.jsonl>
 *        [--code <api 가 있는 루트>] [--label after] [--out <json>] [--only D011] [--show-fail 10]
 *        [--replay <provider-caches.json> --replay-set <questions-replay.js>]
 *
 * --code 를 바꾸면 git archive 로 풀어 둔 이전 버전(main, PR #238)의 api/ 를 그대로 돌린다.
 * 문항·채점기·후보는 언제나 이 체크아웃의 것을 쓴다 — 버전 사이에 바뀌는 것은 검사 대상 코드뿐이다.
 *
 * 외부 호출 0회: 공급원은 동결 카탈로그 검색(catalog-retriever)이나 운영 캐시 재생(--replay),
 * DB 는 쓰기를 기록만 하는 대역이다. 저장 오염(«이 키워드로 저장된 틀린 상품»)도 그 기록으로 잰다.
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
const REPLAY = arg('--replay');
const REPLAY_SET = arg('--replay-set');

const Spec = require('./spec');
const { CatalogRetriever } = require('./catalog-retriever');

/* ── 격리: 환경변수·DB·네트워크 ── */
delete process.env.SEOSA_DB_READONLY;
delete process.env.IDENTITY_CANONICAL_CONSUMER_ENABLED;
delete process.env.SUPABASE_URL;
delete process.env.NEON_DATABASE_URL;
process.env.SEOSA_DB_BACKEND = 'supabase';
let externalCalls = 0;
global.fetch = async (url) => { externalCalls++; throw new Error(`평가 중 외부 호출 금지: ${url}`); };

const writes = [];
let dbReads = 0;
function fakeQuery(table) {
  const o = {};
  ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'gt', 'order', 'limit', 'range', 'is', 'not', 'or', 'filter', 'match', 'neq', 'ilike', 'like', 'contains']
    .forEach(m => { o[m] = () => o; });
  o.maybeSingle = () => Promise.resolve({ data: null, error: null });
  o.single = () => Promise.resolve({ data: null, error: null });
  const write = kind => rows => { writes.push({ table, kind, rows: Array.isArray(rows) ? rows : [rows] }); return Promise.resolve({ data: null, error: null }); };
  o.upsert = write('upsert'); o.insert = write('insert');
  o.update = () => { writes.push({ table, kind: 'update', rows: [] }); return o; };
  o.delete = () => { writes.push({ table, kind: 'delete', rows: [] }); return o; };
  o.then = (resolve, reject) => { dbReads++; return Promise.resolve({ data: [], error: null }).then(resolve, reject); };
  return o;
}
const fakeSupabase = { from: t => fakeQuery(t), rpc: () => { dbReads++; return Promise.resolve({ data: [], error: null }); } };
const supabasePath = path.join(CODE, 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && /[\\/]api[\\/]/.test(parent.filename) && (request === './_supabase' || request === './_supabase.js')) return fakeSupabase;
  if (request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};

const shop = require(path.join(CODE, 'api', '_shop'));
const trust = require(path.join(CODE, 'api', '_trust'));
const facets = require(path.join(CODE, 'api', '_facets'));
require(path.join(CODE, 'api', '_ratelimit')).guard = () => true;
let currentPool = [];
shop.searchAll = async (keyword) => {
  // 진짜 searchAll 은 fetchCoupang/fetchAdpick 안에서 relevantItems(토큰 하나 규칙)를 먼저 건다.
  const copy = currentPool.map(x => ({ ...x }));
  const coupang = shop.relevantItems(keyword, copy.filter(x => x.mall === '쿠팡'));
  const adpick = shop.relevantItems(keyword, copy.filter(x => x.mall !== '쿠팡'));
  return { items: [...coupang.kept, ...adpick.kept], from: 'api', failed: false, blocked: false, errors: [],
    providerSources: { coupang: 'api', adpick: 'api' }, providerBlocked: { coupang: false, adpick: false }, freshAnswered: true };
};
trust.attachTrust = async () => {};
facets.attachPriceChange = async () => {};
const handler = require(path.join(CODE, 'api', 'search.js'));

async function runHandler(keyword) {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; }, end() { return this; } };
  const q1 = console.log, q2 = console.warn, q3 = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const t0 = performance.now();
  try { await handler({ method: 'GET', headers: {}, query: { keyword } }, res); }
  finally { console.log = q1; console.warn = q2; console.error = q3; }
  return { ms: performance.now() - t0, status: res.statusCode, body: Array.isArray(res.body) ? res.body : [] };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)];
}

(async () => {
  let questions;
  let poolFor;
  if (REPLAY) {
    const caches = JSON.parse(fs.readFileSync(REPLAY, 'utf8'));
    const byKey = new Map();
    const add = (src, rows) => rows.forEach(r => {
      const list = byKey.get(r.keyword) || [];
      (Array.isArray(r.items) ? r.items : []).forEach(it => list.push(src === 'coupang'
        ? { title: it.title, lprice: Number(it.lprice), productId: String(it.productId), mall: '쿠팡', vendorItemId: String(it.vendorItemId || ''), link: it.link || '', isCoupang: true, oprice: Number(it.oprice) || Number(it.lprice), savePct: 0, _source: 'api' }
        : { title: it.title, lprice: Number(it.price), productId: require('crypto').createHash('sha256').update(String(it.commissionlink || '')).digest('hex'), mall: 'ADPICK', mallLabel: it.mallLabel || it.cpName || '', link: it.commissionlink || '', isCoupang: false, oprice: Number(it.price), savePct: 0, _source: 'api' }));
      byKey.set(r.keyword, list);
    });
    add('coupang', caches.coupang.rows);
    add('adpick', caches.adpick.rows);
    questions = require(path.resolve(REPLAY_SET));
    poolFor = q => (byKey.get(q.cacheKey || q.q) || []).filter(x => x.title && x.lprice > 0);
  } else {
    if (!SNAPSHOT) throw new Error('--snapshot 이 필요합니다');
    const retriever = new CatalogRetriever(SNAPSHOT);
    questions = require(SET === 'holdout' ? './questions-holdout' : './questions-dev');
    poolFor = q => retriever.search(q.retrieval || q.q, 30);
  }
  questions = questions.filter(q => q.cat !== 'followup');
  if (ONLY) questions = questions.filter(q => ONLY.split(',').includes(q.id));

  const results = [];
  const latencies = [];
  for (const spec of questions) {
    const pool = poolFor(spec);
    currentPool = pool;
    const before = writes.length;
    const r = await runHandler(spec.q);
    latencies.push(r.ms);
    const productWrites = writes.slice(before).filter(w => w.table === 'products' && w.kind === 'upsert').flatMap(w => w.rows);
    const savedWrong = productWrites.filter(row => !Spec.judgeItem(spec, { title: row.title, lprice: row.lprice }).ok && spec.kind !== 'acc');
    const graded = Spec.gradeQuestion(spec, pool, r.body);
    results.push({
      id: spec.id, cat: spec.cat, q: spec.q, verdict: graded.verdict, reason: graded.reason, metrics: graded.metrics,
      shown: r.body.length, pool: pool.length, ms: Math.round(r.ms * 10) / 10, status: r.status,
      saved: productWrites.length, savedWrong: savedWrong.length,
      savedWrongSample: savedWrong.slice(0, 3).map(x => String(x.title).slice(0, 60)),
      top: graded.shownTop
    });
  }

  const count = v => results.filter(r => r.verdict === v).length;
  const avg = (key) => {
    const vals = results.map(r => r.metrics[key]).filter(v => typeof v === 'number');
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 1000) / 1000 : null;
  };
  const verifiable = results.filter(r => r.verdict !== 'UNVERIFIED');
  const byCat = {};
  results.forEach(r => {
    const c = byCat[r.cat] || (byCat[r.cat] = { PASS: 0, FAIL: 0, UNVERIFIED: 0 });
    c[r.verdict]++;
  });
  const savedTotal = results.reduce((a, r) => a + r.saved, 0);
  const savedWrongTotal = results.reduce((a, r) => a + r.savedWrong, 0);
  const summary = {
    label: LABEL, set: REPLAY ? `replay:${path.basename(REPLAY_SET || '')}` : SET, code: CODE,
    questions: results.length, PASS: count('PASS'), FAIL: count('FAIL'), UNVERIFIED: count('UNVERIFIED'),
    accuracyVerifiable: verifiable.length ? Math.round(count('PASS') / verifiable.length * 1000) / 10 : null,
    precisionAt5: avg('precision5'), recallAt10: avg('recall10'),
    accessoryConfusionRate: Math.round(results.filter(r => r.metrics.accessoryConfusion).length / results.length * 1000) / 10,
    modelMismatchRate: Math.round(results.filter(r => r.metrics.modelMismatch).length / results.length * 1000) / 10,
    budgetViolations: results.filter(r => r.metrics.budgetViolation).length,
    usedViolations: results.filter(r => r.metrics.usedViolation).length,
    noResultRate: Math.round(results.filter(r => r.shown === 0).length / results.length * 1000) / 10,
    unverifiedRate: Math.round(count('UNVERIFIED') / results.length * 1000) / 10,
    latencyMsAvg: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length) * 10) / 10,
    latencyMsP95: Math.round(percentile(latencies, 95) * 10) / 10,
    externalCalls, dbReadsMocked: dbReads,
    savedRows: savedTotal, savedWrongRows: savedWrongTotal,
    savedWrongRate: savedTotal ? Math.round(savedWrongTotal / savedTotal * 1000) / 10 : 0,
    byCategory: byCat
  };
  console.log(JSON.stringify(summary, null, 1));
  if (SHOW_FAIL) {
    results.filter(r => r.verdict === 'FAIL').slice(0, SHOW_FAIL).forEach(r => {
      console.log(`\nFAIL ${r.id} [${r.cat}] ${r.q} — ${r.reason} (pool ${r.pool}, shown ${r.shown}, relevant ${r.metrics.relevantInPool})`);
      r.top.forEach(t => console.log(`   ${t.ok ? 'ok ' : 'XX '} ${t.price} ${t.title.slice(0, 80)}`));
    });
  }
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
  }
})().catch(e => { console.error('EVAL_FAIL', e.stack); process.exitCode = 1; });
