/*
 * 실제 AI·실제 검색을 운영 원장을 건드리지 않고 돌려 보는 검증 러너
 * (docs/ai-verification-preview.md, 2026-10-23 감사 CO-10).
 *
 * ── 무엇이 실제이고 무엇이 아닌가 ──────────────────────────────────
 *
 *   실제: LLM 공급자 호출, 쿠팡·ADPICK 검색 호출, DB «읽기», api/ai.js 핸들러 전체
 *   막음: DB 쓰기 전부 (api/_supabase.js 읽기 전용 가드 — SEOSA_DB_READONLY=1 없이는 실행하지 않는다)
 *
 * 그래서 Preview 배포·SSO 없이도 실호출 검증을 할 수 있다. 네트워크로 Vercel 에 가지 않고
 * 핸들러를 그대로 불러 쓴다 — 같은 코드 경로다.
 *
 * ── 쓰는 법 ────────────────────────────────────────────────────────
 *
 *   node scripts/verify-ai-live.js --env ../.env.local                 기본 7개 질문
 *   node scripts/verify-ai-live.js --env ../.env.local --only budget   예산 묶음만
 *   node scripts/verify-ai-live.js --env ../.env.local --ask "30만원 이하 노트북"
 *   node scripts/verify-ai-live.js --env ../.env.local --out reports/live.json
 *
 * --env 파일의 값은 이미 설정된 환경변수를 덮지 않는다. 비밀값은 출력하지 않는다.
 *
 * ★ 이 스크립트는 npm test 에 넣지 않는다 — 실제 공급자 호출과 비용이 든다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { scopeDropPassed, confirmedMerchantResult } = require('./_verify-ai-live-evaluator');

/* ── 인자 ─────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const envFile = arg('env', '');
const only = arg('only', '');
const requireLiveSearch = argv.includes('--require-live-search');
const askOne = arg('ask', '');
const outFile = arg('out', '');
/* 호출 사이 간격(ms) — ADPICK·쿠팡 분당 제한 때문에 붙여 던지면 두 번째부터 검색이 SKIP 된다(실측). */
const DELAY = Number(arg('delay', 7500));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 환경 ─────────────────────────────────────────────────────────── */
if (envFile) {
  const p = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(p)) { console.error(`환경 파일이 없습니다: ${p}`); process.exit(2); }
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) return;
    const key = m[1];
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = v;
  });
}
// The user explicitly requires zero production writes and a capped live
// evaluation. Refuse to run in Production; never erase VERCEL_ENV in order to
// bypass the read-only guard's own production safety check.
if (process.env.VERCEL_ENV === 'production') {
  console.error('LIVE_PREFLIGHT_FAIL production_environment: 실제 평가를 Production에서 실행할 수 없습니다.');
  process.exit(2);
}
const maxUsd = Number(arg('max-usd', process.env.SEOSA_LIVE_MAX_USD || ''));
if (!(Number.isFinite(maxUsd) && maxUsd > 0 && maxUsd <= 5)) {
  console.error('LIVE_PREFLIGHT_FAIL max_usd: --max-usd 5 이하의 양수 비용 상한을 지정해 주세요.');
  process.exit(2);
}
if (!process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
  console.error('LIVE_PREFLIGHT_FAIL llm_credentials: 모델 공급자 키가 없어 실호출 검증을 실행하지 않습니다.');
  process.exit(2);
}
if (!(process.env.COUPANG_ACCESS_KEY && process.env.COUPANG_SECRET_KEY) && !process.env.ADPICK_API_KEY) {
  console.error('LIVE_PREFLIGHT_FAIL marketplace_credentials: 실제 상품 API 키가 없어 실호출 검증을 실행하지 않습니다.');
  process.exit(2);
}
if (!((process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) || process.env.NEON_DATABASE_URL)) {
  console.error('LIVE_PREFLIGHT_FAIL database_credentials: 읽기 전용 데이터 조회 환경이 구성되지 않았습니다.');
  process.exit(2);
}
// Readonly is mandatory; no save or RPC-write path can proceed.
process.env.SEOSA_DB_READONLY = '1';
// 읽기 전용 rpc 허용 목록 — 가격 이력 읽기에 쓰는 함수들.
if (!process.env.SEOSA_DB_READONLY_RPC) {
  process.env.SEOSA_DB_READONLY_RPC = 'price_history_prior_obs,price_history_latest,price_history_series';
}

const handler = require('../api/ai.js');
const db = require('../api/_supabase');
if (!db.__readOnlyGuard.enabled) {
  console.error('LIVE_PREFLIGHT_FAIL db_guard: 데이터베이스 읽기 전용 보호가 비활성화되어 있습니다.');
  process.exit(2);
}
const llm = require('../api/_llm');
const knownRates = llm.OPENAI_PRICES_USD_PER_1M || {};
const model = require('../api/_openai-provider').modelFromEnv();
if (process.env.OPENAI_API_KEY && !knownRates[model]) {
  console.error('LIVE_PREFLIGHT_FAIL unpriced_model: 모르는 모델의 사용료를 5달러 이하로 보증할 수 없습니다.');
  process.exit(2);
}
function estimatedSpend() { return Number(llm.stats().estimatedCostUsd || 0); }
function underLimit() { return estimatedSpend() < maxUsd; }

/* ── 질문 묶음 ──────────────────────────────────────────────────────
 * 감사 작업지시서의 재현 질문에서 가져왔다 (CO-01 예산, CO-03 범위, CO-04 모델/옵션, CO-05 비쇼핑).
 * cap: 서버가 지켜야 하는 하드 상한. 카드가 그 위면 FAIL.
 */
const SUITES = {
  adpickGrace85: [
    { q: '15만원 이하 무선 이어폰 추천해줘', cap: 150000 },
    { q: '10만원 이하 게이밍 헤드셋 추천해줘', cap: 100000 },
    { q: '5만원 이하 무선 마우스 추천해줘', cap: 50000 },
    { q: '15만원 이하 기계식 키보드 추천해줘', cap: 150000 },
    { q: '30만원 이하 블루투스 스피커 추천해줘', cap: 300000 },
    { q: '40만원 이하 모니터 추천해줘', cap: 400000 },
    { q: '50만원 이하 무선 청소기 추천해줘', cap: 500000 },
    { q: '80만원 이하 노트북 추천해줘', cap: 800000 },
    { q: '7만원 이하 보조배터리 추천해줘', cap: 70000 },
    { q: '12만원 이하 에어프라이어 추천해줘', cap: 120000 }
  ],
  budget: [
    { q: '30만원 이하 노트북 추천해줘', cap: 300000 },
    { q: '10만원 이하 게이밍 노트북 추천해줘', cap: 100000 },
    { q: '1만원 이하 노트북 추천해줘', cap: 10000, expectNone: true }
  ],
  scope: [
    { turns: ['30만원 이하 노트북 추천해줘', '고마워', '좋아', '그래', '응', '청소기 추천해줘'], scopeDrop: true }
  ],
  identity: [
    { q: '로지텍 G304 마우스 최저가', must: /g304/i },
    { q: '에어팟 프로 3 본품만, 케이스는 제외하고 찾아줘', mustNot: /케이스|case/i }
  ],
  talk: [
    { q: '아까 말한 조건 기억해?', expectNoCards: true }
  ]
};

/* ── 핸들러 호출 ────────────────────────────────────────────────── */
async function ask(body) {
  let status = 200;
  let payload = null;
  const res = {
    status(c) { status = c; return this; },
    setHeader() { return this; },
    json(v) { payload = v; return this; },
    end() { payload = payload || {}; return this; }
  };
  const t0 = Date.now();
  await handler({
    method: 'POST', headers: {}, query: {},
    body: Object.assign({ contextProducts: [], view: { source: 'none' } }, body)
  }, res);
  const b = payload || {};
  return {
    status, ms: Date.now() - t0, body: b,
    text: String(b.text || ''),
    cards: Array.isArray(b.items) ? b.items : [],
    verify: b.verify || null,
    convState: typeof b.convState === 'string' ? b.convState : ''
  };
}

function cardLine(c) {
  return `${String(c.title || '').slice(0, 44)} | ${c.lprice} | ${c.mall || ''}`;
}

const results = [];
let pass = 0;
const fails = [];
function check(cond, name, detail) {
  if (cond) { pass++; console.log(`    [PASS] ${name}`); return; }
  fails.push(name);
  console.log(`    [FAIL] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
}

async function runOne(c) {
  console.log(`\n■ ${c.q}`);
  const r = await ask({ question: c.q, chatHistory: [{ role: 'user', text: c.q }] });
  console.log(`  status ${r.status} · ${r.ms}ms · verify ${JSON.stringify(r.verify)}`);
  if (requireLiveSearch) check(confirmedMerchantResult(r), '실제 판매처 검색·상품 카드 확인', r.verify && r.verify.search);
  console.log(`  답변: ${r.text.replace(/\s+/g, ' ').slice(0, 220)}`);
  r.cards.slice(0, 6).forEach(x => console.log(`   · ${cardLine(x)}`));
  if (c.cap) {
    const over = r.cards.filter(x => Number(x.lprice) > c.cap);
    check(over.length === 0, `카드 전체가 ${c.cap.toLocaleString('ko-KR')}원 이하`, over.map(cardLine));
  }
  if (c.must) check(r.cards.length === 0 || r.cards.some(x => c.must.test(String(x.title))),
    `요청한 모델이 카드에 있다 (${c.must})`, r.cards.map(cardLine));
  if (c.mustNot && r.cards.length) check(!c.mustNot.test(String(r.cards[0].title)),
    `첫 카드가 제외 조건에 걸리지 않는다 (${c.mustNot})`, cardLine(r.cards[0]));
  if (c.expectNoCards) check(r.cards.length === 0, '검색이 필요 없는 말에는 카드가 없다', r.cards.map(cardLine));
  if (c.expectNone) {
    // 상한 안에 상품이 없을 질문 — 없는 상품을 지어내지 않고, 못 찾았다/확인 못 했다고 말해야 한다.
    check(r.cards.length === 0, '상한 안에 상품이 없으면 카드를 내지 않는다', r.cards.map(cardLine));
    check(/못|없|확인|어렵/.test(r.text), '못 찾았다는 사실을 말한다', r.text.slice(0, 160));
  }
  /*
   * 쓰기가 «실행되지 않았다» 는 것이 이 검증의 전제다. 막힌 수는 0이 아니어도 된다 —
   * 실측(2026-10-23): saveProducts 는 먼저 생략되지만, 쿠팡 전역 한도 rpc(coupang_acquire_v2)와
   * 검색 캐시 힌트가 쓰기를 시도한다. 가드가 그것을 막았다는 사실이 통과 조건이다.
   */
  check(!!r.verify && r.verify.dbWritesBlocked !== null, '읽기 전용 가드가 켜져 있고 쓰기 시도를 계측했다', r.verify);
  results.push({ q: c.q, status: r.status, ms: r.ms, verify: r.verify, text: r.text, cards: r.cards.map(cardLine) });
  return r;
}

async function runTurns(c) {
  console.log(`\n■ ${c.turns.length}턴 대화`);
  let history = [];
  let convState = '';
  let last = null;
  for (const q of c.turns) {
    if (last && DELAY > 0) await sleep(DELAY);
    history.push({ role: 'user', text: q });
    last = await ask({ question: q, chatHistory: history.slice(-10), convState });
    history.push({ role: 'assistant', text: last.text });
    history = history.slice(-10);
    if (last.convState) convState = last.convState;
    console.log(`  [${q}] → ${last.text.replace(/\s+/g, ' ').slice(0, 120)} · verify ${JSON.stringify(last.verify)}`);
    last.cards.slice(0, 3).forEach(x => console.log(`   · ${cardLine(x)}`));
  }
  if (c.scopeDrop) {
    check(scopeDropPassed(last), '상품 전환 뒤 예산을 거두고 실제 가격이 있는 카드를 찾았다', {
      budgetDropped: !!(last.verify && last.verify.budgetDropped), cards: last.cards.length
    });
  }
  results.push({ turns: c.turns, verify: last && last.verify, text: last && last.text, cards: last ? last.cards.map(cardLine) : [] });
}

(async () => {
  console.log('=== 실호출 검증 (읽기 전용) ===');
  console.log(`DB 가드: ${JSON.stringify(db.__readOnlyGuard)}`);
  console.log(`공급자 키: coupang=${!!process.env.COUPANG_ACCESS_KEY} adpick=${!!process.env.ADPICK_API_KEY}`
    + ` openrouter=${!!process.env.OPENROUTER_API_KEY} openai=${!!process.env.OPENAI_API_KEY}`);

  let cases;
  if (askOne) cases = [{ q: askOne }];
  else if (only) {
    if (!SUITES[only]) { console.error(`묶음을 찾을 수 없습니다: ${only} (${Object.keys(SUITES).join(', ')})`); process.exit(2); }
    cases = SUITES[only];
  } else cases = Object.keys(SUITES).reduce((all, k) => all.concat(SUITES[k]), []);

  /*
   * 호출 사이를 띄운다 — ADPICK 은 분당 간격 제한이 있고(api/_adpick.js), 쿠팡은 분당 창이 있다.
   * 붙여서 던지면 두 번째 질문부터 검색이 SKIP 되어 "검색 실패" 만 검증하게 된다(실측).
   */
  let first = true;
  for (const c of cases) {
    if (!underLimit()) {
      fails.push('비용 상한 도달 — 남은 시나리오를 실행하지 않음');
      console.log('[STOP] estimated LLM spend limit reached');
      break;
    }
    if (!first && DELAY > 0) await sleep(DELAY);
    first = false;
    try {
      if (c.turns) await runTurns(c); else await runOne(c);
    } catch (e) {
      fails.push(`${c.q || '대화'} — 예외: ${e.message}`);
      console.log(`    [FAIL] 예외: ${e.message}`);
    }
  }

  const guard = db.__readOnlyGuard;
  if (estimatedSpend() > maxUsd) fails.push('추정 실제 비용이 상한을 초과함');
  console.log('LLM 추정 사용료(USD): ' + estimatedSpend().toFixed(6) + ' / 상한 ' + maxUsd.toFixed(2));
  console.log(`\n=== 결과: ${pass} PASS / ${fails.length} FAIL ===`);
  console.log(`DB 가드 최종: ${JSON.stringify(guard)}`);
  if (fails.length) fails.forEach(f => console.log(`  - ${f}`));
  if (outFile) {
    fs.writeFileSync(path.resolve(process.cwd(), outFile),
      JSON.stringify({ at: new Date().toISOString(), guard, pass, fails, results }, null, 2));
    console.log(`기록: ${outFile}`);
  }
  process.exit(fails.length ? 1 : 0);
})();
