#!/usr/bin/env node
/**
 * "이거 왜 추천했어?" 멀티턴 + 추천 1위 카드 강조 회귀 — 2026-10-09. 완전 오프라인.
 *
 *   node scripts/test-ai-recommendation-reason.js
 *
 * ── 실측 사고 ──────────────────────────────────────────────────────
 *   1턴 "10만원 이하 무선 이어폰" → "추천: 어반사운드 에어 프로 … 11,990원"
 *   2턴 "이거 왜 추천했어?"      → "지금 보고 계신 상품은 SEOSA 서버 기록에서
 *                                   같은 상품·옵션을 확인하지 못해 …"
 *   _intent 의 PRIOR_RECOMMENDATION_RE 가 "아까 추천한 …" 꼴만 알아봐서, 이 말은
 *   requiresRecommendationIdentity 없이 화면 상품 선택자 경로로 갔다.
 *
 * ── 무엇을 지키는가 ────────────────────────────────────────────────
 *   A. 1턴 추천 A → 2턴 "이거 왜 추천했어?" 가 A 를 가리키고 A 의 실제 근거만 말한다
 *   B. 같은 뜻의 표현 (최소 7개) — 정규식에서 확정, LLM 분류·답변 호출 0회
 *   C. 화면에 B·C 가 떠 있어도 A 에서 바뀌지 않는다
 *   D. 참조 없음·변조·만료·다른 키 서명 → 상품을 추측하지 않고 «참조 없음» 안내
 *   E. 같은 productId 의 다른 vendorItemId 옵션 → 추천한 옵션을 그대로 유지
 *   F. 추천 카드 강조 — 서버 identity(topRecommendation) + 프런트 Chat.topCardIndex/miniGrid
 *
 * api/ai.js 핸들러 전체, _aicontext 카탈로그 조회, _pricestat 통계, _decision, _deal 은
 * 진짜 코드가 돈다. Supabase 는 읽기 전용 메모리 표, LLM·쇼핑 검색은 가짜다.
 * 외부 호출 0회, DB 쓰기 0회.
 */
'use strict';

const path = require('path');
const Module = require('module');

process.env.AUTH_SECRET = 'offline-recommendation-reason-key';
process.env.OPENROUTER_API_KEY = 'sk-or-v1-OFFLINE-REASON';
process.env.OPENROUTER_MODELS = 'test/offline:free';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
process.env.AI_SEARCH_TIMEOUT_MS = '300';
process.env.AI_ENRICH_TIMEOUT_MS = '600';

/* ── 가짜 Supabase (읽기 전용) ─────────────────────────────────────── */
const DAY = 86400e3;
const tables = { products: [], price_history: [] };
let dbWrites = 0;
function query(table) {
  let rows = (tables[table] || []).slice();
  const q = {
    select() { return q; },
    in(col, vals) { const s = new Set((vals || []).map(String)); rows = rows.filter(r => s.has(String(r[col]))); return q; },
    eq(col, v) { rows = rows.filter(r => String(r[col]) === String(v)); return q; },
    gte(col, v) { rows = rows.filter(r => String(r[col]) >= String(v)); return q; },
    order(col, o) {
      const asc = !o || o.ascending !== false;
      rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      return q;
    },
    limit(n) { rows = rows.slice(0, n); return q; },
    then(resolve, reject) { return Promise.resolve({ data: rows.map(r => ({ ...r })), error: null }).then(resolve, reject); }
  };
  ['upsert', 'insert', 'update', 'delete'].forEach(m => {
    q[m] = () => { dbWrites++; throw new Error(`오프라인 테스트에서 DB 쓰기 시도: ${table}.${m}`); };
  });
  return q;
}
const fakeSupabase = { from: t => query(t), rpc: () => { dbWrites++; throw new Error('rpc 금지'); } };
const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './_supabase' || request === '../api/_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};

/* ── 가짜 LLM — 일부러 «틀린» 답을 준다. 추천 이유 경로가 LLM 을 타면 바로 드러난다. ── */
const llmStub = { classify: 'A', resolve: '', answer: '' };
const llmCalls = { classify: 0, answer: 0, resolve: 0 };
let externalCalls = 0;
global.fetch = async (url, opts) => {
  if (!String(url).includes('openrouter.ai')) {
    externalCalls++;
    throw new Error(`오프라인 테스트에서 예상 밖 외부 호출: ${url}`);
  }
  const body = JSON.parse(opts.body);
  if (body.max_tokens >= 700) {
    llmCalls.answer++;
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: llmStub.answer } }] }) };
  }
  if (body.max_tokens === 120) {
    llmCalls.resolve++;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: llmStub.resolve || '' } }] }) };
  }
  llmCalls.classify++;
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: llmStub.classify } }] }) };
};

/* ── 인증·레이트리밋·검색 대역 ───────────────────────────────────────── */
const auth = require('../api/_auth');
auth.identify = () => ({ ok: true, email: 'reason@fixture.local' });
const http = require('../api/_http');
http.applyCors = () => true;
http.noStore = () => {};
require('../api/_ratelimit').guard = () => true;
const shop = require('../api/_shop');
const stubSearch = { items: [], calls: 0 };
shop.searchAll = async () => {
  stubSearch.calls++;
  return { items: stubSearch.items.map(it => ({ ...it, _source: 'api' })), from: 'api', blocked: false };
};
shop.saveProducts = async () => ({ saved: 0 });
require('../api/_trust').attachTrust = async list => {
  (list || []).forEach(it => { if (it) it.trust = { level: 'high', label: '확인된 가격', reasons: ['SEOSA 기록 확인'] }; });
  return list;
};

const pricestat = require('../api/_pricestat');
const AC = require('../api/_aicontext');
const llm = require('../api/_llm');
const handler = require('../api/ai.js');
const Intent = require('../api/_intent');
const CG = require('../api/_concierge');
const { dealOf } = require('../api/_deal');

/*
 * 기대 문구는 시험 쪽에 따로 적는다 — 고치기 전 코드(이 export 들이 없는 main)에서도
 * 시험이 죽지 않고 «어느 경우가 틀렸는지» 를 하나씩 FAIL 로 보여 주게 하기 위해서다.
 */
const REF_MISSING = '직전 추천 정보를 확인할 수 없어서 어떤 상품을 말씀하시는지 특정하기 어려워요. 상품명을 눌러주시거나 다시 말씀해 주세요.';
const PRICE_UNVERIFIED = '직전에 추천한 상품은 확인했지만, 지금 SEOSA 서버에서 그 상품·옵션의 현재 가격을 확인하지 못해 추천 근거를 다시 계산할 수 없어요. 가격은 상품 페이지에서 확인해 주세요.';
/** _deal 평서문 → 답변 말투 (api/_concierge politeFact 와 같은 규칙, 숫자는 그대로). */
function politeFact(x) {
  const t = String(x || '').trim().replace(/[.。]$/, '');
  const rules = [[/이다$/, '입니다.'], [/않는다$/, '않습니다.'], [/했다$/, '했습니다.'], [/렸다$/, '렸습니다.'], [/랐다$/, '랐습니다.'], [/하다$/, '합니다.'], [/다$/, '습니다.']];
  for (const [re, to] of rules) if (re.test(t)) return t.replace(re, to);
  return t + '.';
}
/** 없는 함수는 «틀린 결과» 로 센다 (고치기 전 코드에서 시험이 통째로 죽지 않게). */
const missing = () => undefined;

/* ── 검사 도구 ──────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
const group = {};
let currentGroup = '';
function section(name) { currentGroup = name; group[name] = group[name] || { pass: 0, fail: 0 }; console.log(`\n── ${name} ──`); }
function ok(cond, name, detail) {
  const g = group[currentGroup];
  if (cond) { pass++; if (g) g.pass++; console.log(`  [PASS] ${name}`); }
  else {
    fail++; if (g) g.fail++; failures.push(`${currentGroup} :: ${name}`);
    console.log(`  [FAIL] ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  }
}
const won = n => Number(n).toLocaleString('en-US');
const kstDate = n => new Date(Date.now() + 9 * 3600e3 - n * DAY).toISOString().slice(0, 10);
const isoAgo = n => new Date(Date.now() - n * DAY).toISOString();

async function ask(body, opts = {}) {
  try { llm._internal._reset(); } catch (e) { /* 없으면 그만 */ }
  if (opts.classify !== undefined) llmStub.classify = opts.classify;
  if (opts.resolve !== undefined) llmStub.resolve = opts.resolve;
  llmStub.answer = opts.answer !== undefined ? opts.answer : '확인했습니다.';
  stubSearch.items = opts.searchItems || [];
  const before = { search: stubSearch.calls, ...llmCalls };
  let status = 200, payload;
  const res = {
    status(c) { status = c; return this; },
    setHeader() { return this; },
    json(v) { payload = v; return this; },
    end() { payload = {}; return this; }
  };
  const quiet = console.log, quietWarn = console.warn, quietErr = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    await handler({ method: 'POST', headers: {}, query: {}, body: Object.assign({ chatHistory: [], contextProducts: [], view: { source: 'none' } }, body) }, res);
  } finally {
    console.log = quiet; console.warn = quietWarn; console.error = quietErr;
  }
  return {
    status, body: payload || {},
    searches: stubSearch.calls - before.search,
    llmClassify: llmCalls.classify - before.classify,
    llmAnswer: llmCalls.answer - before.answer,
    llmResolve: llmCalls.resolve - before.resolve
  };
}

/* ── 고정 데이터 ─────────────────────────────────────────────────────── */
const A = {
  title: '어반사운드 에어 프로 커널형 블루투스 무선 이어폰 블랙', lprice: 11990, oprice: 19900, savePct: 40,
  link: 'https://www.coupang.com/vp/products/9101?vendorItemId=A-BLK', image: '', mall: '쿠팡',
  productId: '9101', vendorItemId: 'A-BLK', isCoupang: true
};
const A_WHT = {
  title: '어반사운드 에어 프로 커널형 블루투스 무선 이어폰 화이트', lprice: 15990, oprice: 19900, savePct: 20,
  link: 'https://www.coupang.com/vp/products/9101?vendorItemId=A-WHT', image: '', mall: '쿠팡',
  productId: '9101', vendorItemId: 'A-WHT', isCoupang: true
};
const B = {
  title: '사운드코어 라이프 노이즈캔슬링 무선 이어폰', lprice: 45000, oprice: 59000, savePct: 24,
  link: 'https://www.coupang.com/vp/products/9102?vendorItemId=B-1', image: '', mall: '쿠팡',
  productId: '9102', vendorItemId: 'B-1', isCoupang: true
};
const C = {
  title: 'QCY 무선 이어폰 T20 블루투스', lprice: 79000, oprice: 79000, savePct: 0,
  link: 'https://adpick.example/9103', image: '', mall: 'ADPICK', mallLabel: '알리',
  productId: '9103', vendorItemId: '', isCoupang: false
};
function ph(pid, mall, vid, n, price) {
  return { product_id: pid, mall, vendor_item_id: vid, price, recorded_date: kstDate(n), recorded_at: isoAgo(n), title: 't', link: '' };
}
function catalogRow(it, vid) {
  return { product_id: it.productId, mall: it.mall, mall_label: it.mallLabel || '', title: it.title, lprice: it.lprice,
    oprice: it.oprice, save_pct: it.savePct, link: it.link, image: '', keyword: '무선 이어폰',
    collected_at: new Date().toISOString(), vendor_item_id: vid };
}
function aPrice(n) {
  // 61일 기록: 오늘·어제 11,990원(확인된 최저), 최근 6일 하락, 그 앞은 12,800~13,600원.
  if (n <= 1) return 11990;
  if (n <= 6) return 12100 + (n - 2) * 200;
  return 12800 + (n % 5) * 200;
}
(function seed() {
  // 카탈로그: 9101 의 대표 옵션은 A-BLK 다 (A-WHT 는 기록만 있다).
  tables.products = [catalogRow(A, 'A-BLK'), catalogRow(B, 'B-1'), catalogRow(C, '')];
  const rows = [];
  for (let n = 0; n <= 60; n++) rows.push(ph('9101', '쿠팡', 'A-BLK', n, aPrice(n)));
  for (let n = 0; n < 20; n++) rows.push(ph('9101', '쿠팡', 'A-WHT', n, 15990 + (n % 3) * 500));
  tables.price_history = rows;
})();
const searchFixture = () => [A, A_WHT, B, C].map(it => ({ ...it }));

/* A-BLK 의 «진짜» 통계와 구매 시점 판정 — 답변의 숫자는 여기서만 나와야 한다. */
const A_STAT = pricestat.statsFrom(tables.price_history
  .filter(r => r.product_id === '9101' && r.vendor_item_id === 'A-BLK')
  .map(r => ({ date: r.recorded_date, price: r.price }))
  .sort((a, b) => (a.date < b.date ? -1 : 1)));
const A_DEAL = dealOf(A_STAT, A.lprice, kstDate(0));

const T1_Q = '10만원 이하 무선 이어폰';
const WRONG_LLM = '사운드코어 라이프 노이즈캔슬링 무선 이어폰을 추천했어요. 45,000원입니다.';

/** 1턴: 검색 → 추천 A. 2턴에 쓸 서명 참조·대화 기록을 돌려준다. */
async function turn1() {
  const r = await ask({ question: T1_Q }, {
    classify: 'C|무선 이어폰', searchItems: searchFixture(),
    answer: `추천: ${A.title} — 11,990원\n관측한 61일 기록에서 가장 낮은 가격입니다.`
  });
  const hist = [{ role: 'user', text: T1_Q }, { role: 'assistant', text: r.body.text, sig: r.body.turnSig }];
  return { r, hist };
}
async function turn2(t1, question, extra, opts) {
  return ask(Object.assign({
    question,
    prevTop: t1.r.body.topProductId,
    prevTopRef: t1.r.body.topRecommendationRef,
    chatHistory: t1.hist.concat([{ role: 'user', text: question }])
  }, extra || {}), Object.assign({ classify: 'C|이유', resolve: '{"q":"이유","use":"","brand":"","avoid":""}', answer: WRONG_LLM }, opts || {}));
}

/** 답변 속 숫자(원·%·일)가 전부 서버 사실(가격·통계·판정·예산)에서 온 것인가. */
function numbersGrounded(text, allowedText) {
  const nums = String(text).match(/\d[\d,.]*/g) || [];
  const allowed = String(allowedText);
  return nums.filter(n => !allowed.includes(n));
}
const A_AVG_PCT = Math.round((1 - A.lprice / A_STAT.avg30) * 1000) / 10;
const A_ALLOWED = [won(A.lprice), '10만원', '100,000', won(A_STAT.avg30), String(A_AVG_PCT), '30일'].concat(A_DEAL.reasons).join(' | ');

function isAboutA(r) {
  const t = String(r.body.text || '');
  const it = (r.body.items || [])[0] || {};
  return t.includes('어반사운드 에어 프로') && !t.includes('사운드코어') && !t.includes('QCY')
    && (r.body.items || []).length === 1 && it.productId === '9101' && it.vendorItemId === 'A-BLK';
}

(async () => {
  console.log('=== "이거 왜 추천했어?" 멀티턴 · 추천 카드 강조 — 외부 호출 0회, DB 쓰기 0회 ===');
  ok(A_DEAL && A_DEAL.reasons.length >= 2, '(전제) 고정 데이터의 A 구매 시점 판정에 근거가 있다', JSON.stringify(A_DEAL && A_DEAL.reasons));

  /* ================================================================ */
  section('A. 1턴 추천 A → 2턴 "이거 왜 추천했어?"');
  const t1 = await turn1();
  {
    const top = t1.r.body.topRecommendation || {};
    ok(t1.r.searches === 1 && t1.r.body.topProductId === '9101' && /^air2\./.test(t1.r.body.topRecommendationRef || ''),
      '1턴: 검색해서 A 를 1위로 고르고 서명 참조를 준다', JSON.stringify({ top: t1.r.body.topProductId, text: (t1.r.body.text || '').slice(0, 120) }));
    const ref = AC.verifyRecommendationRef(t1.r.body.topRecommendationRef);
    ok(ref && ref.productId === '9101' && ref.vendorItemId === 'A-BLK' && ref.mall === '쿠팡',
      '1턴: 서명 참조 identity = productId 9101 · vendorItemId A-BLK · 쿠팡', JSON.stringify(ref));
    ok(top.productId === '9101' && top.vendorItemId === 'A-BLK' && top.mall === '쿠팡'
        && t1.r.body.items[top.index] && t1.r.body.items[top.index].vendorItemId === 'A-BLK',
      '1턴: 강조할 카드(topRecommendation)가 A-BLK 카드를 가리킨다', JSON.stringify(top));

    const r2 = await turn2(t1, '이거 왜 추천했어?');
    const text = String(r2.body.text || '');
    ok(isAboutA(r2), '2턴: 답과 카드가 A(9101/A-BLK) 하나만 가리킨다', text);
    ok(r2.searches === 0 && r2.llmClassify === 0 && r2.llmAnswer === 0 && r2.llmResolve === 0,
      '2턴: 새 검색 0회 · LLM 분류/답변 0회 (서버 결정론)', JSON.stringify(r2));
    ok(!/같은 상품·옵션을 확인하지 못해/.test(text) && !text.includes('45,000원'),
      '2턴: «같은 상품·옵션을 확인하지 못해» 오답이 나오지 않는다', text);
    ok(text.includes('예산 10만원 이하') && text.includes('무선'), '2턴: 조건 근거 — 예산 10만원 · 무선', text);
    const dealHits = A_DEAL.reasons.filter(r => text.includes(politeFact(r).replace(/\.$/, '')));
    ok(dealHits.length === Math.min(3, A_DEAL.reasons.length), '2턴: 가격 근거는 결정 엔진(_deal)의 실제 근거 문장 그대로',
      JSON.stringify({ expect: A_DEAL.reasons, text }));
    ok(text.includes(`현재 ${won(A.lprice)}원`), '2턴: 현재가는 서버가 확인한 11,990원', text);
    ok(text.includes(`30일 평균 ${won(A_STAT.avg30)}원보다 ${A_AVG_PCT}% 저렴`), '2턴: 30일 평균 대비는 검증된 기록의 avg30 으로 계산', JSON.stringify({ avg30: A_STAT.avg30, pct: A_AVG_PCT, text }));
    const stray = numbersGrounded(text, A_ALLOWED);
    ok(!stray.length, '2턴: 답 속 숫자는 전부 검증된 가격·통계·예산에서 왔다', JSON.stringify({ stray, text }));
    ok(/^air2\./.test(r2.body.topRecommendationRef || '') && AC.verifyRecommendationRef(r2.body.topRecommendationRef).vendorItemId === 'A-BLK',
      '2턴: 참조를 같은 identity 로 다시 발급한다 (3턴에도 이어진다)');
    ok((r2.body.topRecommendation || {}).vendorItemId === 'A-BLK', '2턴: 답과 함께 나간 A 카드도 추천 카드로 표시된다');
    console.log('\n  ── 2턴 실제 답변 ──\n' + text.split('\n').map(l => '    ' + l).join('\n') + '\n');

    // 3턴에서도 같은 질문 → 여전히 A
    const t2 = { r: r2, hist: t1.hist.concat([{ role: 'user', text: '이거 왜 추천했어?' }, { role: 'assistant', text, sig: r2.body.turnSig }]) };
    const r3 = await turn2(t2, '추천 이유 알려줘');
    ok(isAboutA(r3), '3턴: 2턴이 다시 발급한 참조로도 A 를 가리킨다', r3.body.text);
  }

  /* ================================================================ */
  section('B. 같은 뜻의 표현 — 정규식에서 확정');
  {
    const phrases = [
      '이거 왜 추천했어?', '왜 이거 추천했어?', '왜 추천했어?', '추천한 이유가 뭐야?', '추천 이유 알려줘',
      '아까 추천한 거 왜 추천했어?', '이걸 왜 골랐어?', '왜 이걸 1위로 골랐어?', '이 상품 고른 이유가 뭐야', '추천 근거 보여줘'
    ];
    for (const p of phrases) {
      const c = Intent.classify(p, t1.hist);
      ok(c.recommendationReason === true && c.requiresRecommendationIdentity === true && c.confidence === 'high' && c.query === '',
        `분류 "${p}" → recommendationReason · identity 필수 · 검색어 없음`, JSON.stringify(c));
      const r = await turn2(t1, p);
      ok(isAboutA(r) && r.searches === 0 && r.llmClassify === 0 && r.llmAnswer === 0,
        `멀티턴 "${p}" → A 의 근거, 검색·LLM 0회`, JSON.stringify({ text: r.body.text, s: r.searches, c: r.llmClassify, a: r.llmAnswer }));
    }
    // 대조군 — 새 추천 요청·변경 질문은 이 경로로 빨려 들어가지 않는다.
    for (const p of ['무선 이어폰 추천해줘', '노트북 추천해주고 추천 이유도 알려줘', '추천이 왜 바뀌었어?', '가성비 이어폰 골라줘']) {
      const c = Intent.classify(p, t1.hist);
      ok(!c.recommendationReason, `대조군 "${p}" 는 추천 이유 질문이 아니다`, JSON.stringify(c));
    }
  }

  /* ================================================================ */
  section('C. 화면에 B·C 가 떠 있어도 A 를 유지');
  {
    const screen = [B, C].map(it => ({ productId: it.productId, vendorItemId: it.vendorItemId, mallId: it.mall, mall: it.mall, title: it.title }));
    for (const [label, view] of [['검색 결과 화면', { source: 'search' }], ['B 가격 모달', { source: 'modal' }], ['찜 목록', { source: 'wish' }]]) {
      const ctx = label === 'B 가격 모달' ? screen.slice(0, 1) : screen;
      const r = await turn2(t1, '이거 왜 추천했어?', { contextProducts: ctx, view });
      ok(isAboutA(r) && !String(r.body.text).includes('45,000') && !String(r.body.text).includes('79,000'),
        `${label}: "이거 왜 추천했어?" 가 B/C 로 바뀌지 않는다`, r.body.text);
    }
    // 화면 상품을 A 의 가격·이름으로 위조해 보내도 근거 숫자는 서버 값이다.
    const forged = [{ productId: '9102', vendorItemId: 'B-1', mallId: '쿠팡', mall: '쿠팡', title: '어반사운드 에어 프로', price: 1000, hist: { low: 1 } }];
    const r = await turn2(t1, '왜 이거 추천했어?', { contextProducts: forged, view: { source: 'modal' } });
    ok(isAboutA(r) && !/1,000원/.test(r.body.text), '위조 화면 상품(가격·이름)이 답을 바꾸지 못한다', r.body.text);
  }

  /* ================================================================ */
  section('D. 직전 추천 참조 없음·변조·만료 → 추측하지 않는다');
  {
    const good = t1.r.body.topRecommendationRef;
    const parts = good.split('.');
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const swapped = Buffer.from(JSON.stringify(Object.assign({}, payload, { p: '9102', v: 'B-1' }))).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const realSecret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'some-other-deployment-key';
    const otherKey = AC.createRecommendationRef({ productId: '9101', vendorItemId: 'A-BLK', mallId: '쿠팡' });
    process.env.AUTH_SECRET = realSecret;
    const cases = [
      ['참조 없음', ''],
      ['payload 변조(B 로 바꿔치기)', `${parts[0]}.${swapped}.${parts[2]}`],
      ['서명 변조', `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`],
      ['만료', AC.createRecommendationRef({ productId: '9101', vendorItemId: 'A-BLK', mallId: '쿠팡' }, Date.now() - AC.REF_TTL_MS - 60e3)],
      ['다른 키로 서명', otherKey],
      ['형식 깨짐', 'air2.not-a-ref']
    ];
    const screen = [{ productId: '9102', vendorItemId: 'B-1', mallId: '쿠팡', mall: '쿠팡', title: B.title }];
    for (const [label, ref] of cases) {
      const r = await turn2(t1, '이거 왜 추천했어?', { prevTopRef: ref, contextProducts: screen, view: { source: 'modal' } });
      const t = String(r.body.text || '');
      ok(t === REF_MISSING && !(r.body.items || []).length && !r.body.topRecommendation && !r.body.topRecommendationRef
          && r.searches === 0 && r.llmAnswer === 0 && !/\d{1,3}(,\d{3})+원/.test(t) && !/같은 상품·옵션/.test(t),
        `${label} → «직전 추천 정보를 확인할 수 없어» 안내, 상품·가격 추측 0`, JSON.stringify({ t, items: r.body.items, s: r.searches }));
    }
    ok(/직전 추천 정보를 확인할 수 없어서 어떤 상품을 말씀하시는지 특정하기 어려워요/.test(REF_MISSING)
        && /상품명을 눌러주시거나 다시 말씀해 주세요/.test(REF_MISSING),
      '안내 문구: 대화 참조 문제로 말한다(가격 데이터 문제로 말하지 않는다)');
  }

  /* ================================================================ */
  section('E. 같은 productId · 다른 vendorItemId 옵션');
  {
    // 화면에 같은 상품의 다른 옵션(A-WHT)이 떠 있어도 추천한 A-BLK 를 유지한다.
    const wht = [{ productId: '9101', vendorItemId: 'A-WHT', mallId: '쿠팡', mall: '쿠팡', title: A_WHT.title }];
    const r1 = await turn2(t1, '이거 왜 추천했어?', { contextProducts: wht, view: { source: 'modal' } });
    ok(isAboutA(r1) && !r1.body.text.includes('15,990') && r1.body.text.includes('11,990원'),
      '화면의 A-WHT 옵션으로 바뀌지 않고 A-BLK(11,990원)의 근거를 말한다', r1.body.text);

    // 직전 추천이 A-WHT 옵션이었다면 — A-BLK 의 가격·근거로 갈아타지 않는다.
    const whtRef = AC.createRecommendationRef({ productId: '9101', vendorItemId: 'A-WHT', mallId: '쿠팡' });
    const r2 = await turn2(t1, '이거 왜 추천했어?', { prevTopRef: whtRef, prevTop: '9101' });
    const t2 = String(r2.body.text || '');
    const items2 = r2.body.items || [];
    ok(!t2.includes('11,990') && items2.every(it => it.vendorItemId === 'A-WHT') && r2.searches === 0
        && (!r2.body.topRecommendation || r2.body.topRecommendation.vendorItemId === 'A-WHT'),
      'A-WHT 참조 → A-BLK 가격(11,990원)·카드로 갈아타지 않는다', JSON.stringify({ t2, items2 }));
    ok(t2 === PRICE_UNVERIFIED,
      'A-WHT 현재가를 서버가 보증 못 하면 «가격 확인 불가» 로 말한다 (참조 없음과 구분)', t2);

    // 서명 참조의 옵션만 바꾼 변조 → 참조 없음
    const parts = t1.r.body.topRecommendationRef.split('.');
    const d = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const vSwap = Buffer.from(JSON.stringify(Object.assign({}, d, { v: 'A-WHT' }))).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r3 = await turn2(t1, '이거 왜 추천했어?', { prevTopRef: `${parts[0]}.${vSwap}.${parts[2]}` });
    ok(r3.body.text === REF_MISSING, '참조의 vendorItemId 만 바꾼 변조 → 서명 불일치로 참조 없음', r3.body.text);
  }

  /* ================================================================ */
  section('A-2. 근거가 적으면 적은 만큼만 말한다');
  {
    // B 는 가격 기록이 없다 — 가격 근거(%·관측일)를 지어내면 안 된다.
    const bRef = AC.createRecommendationRef({ productId: '9102', vendorItemId: 'B-1', mallId: '쿠팡' });
    const r = await turn2(t1, '이거 왜 추천했어?', { prevTopRef: bRef, prevTop: '9102' });
    const t = String(r.body.text || '');
    const bullets = t.split('\n').filter(l => l.startsWith('- '));
    ok(t.includes('사운드코어') && !/%/.test(t) && !/관측한/.test(t) && /가격 기록이 충분하지 않아/.test(t)
        && bullets.length === 3,
      '가격 기록 없는 상품: 예산·무선 2개 근거 + «가격 기록 부족» 한 줄, 수치 지어내기 0', t);
    const stray = numbersGrounded(t, [won(B.lprice), '10만원'].join(' | '));
    ok(!stray.length, '그 답의 숫자도 전부 서버 사실', JSON.stringify({ stray, t }));

    const unit = (CG.recommendationReason || (() => ({ text: '', reasonCount: -1 })))({
      top: { title: '테스트 이어폰', price: 30000, featureHit: [] },
      decision: { recommendation: 'moderate' }, deal: null, constraints: {}
    });
    ok(!/\d+%/.test(unit.text) && unit.reasonCount === 0 && /내세울 만한 근거는 확인되지 않았어요/.test(unit.text),
      '근거가 하나도 없으면 «근거 없음» 이라고 말한다 (그럴듯한 이유를 만들지 않는다)', unit.text);
  }

  /* ================================================================ */
  section('F. 추천 카드 강조 — 서버 identity');
  {
    const I = Object.assign({ topRecommendationCard: missing }, handler._internal);
    const items = [A, A_WHT, B].map((it, i) => Object.assign(I.normItem(I.fromSearchResult(it)), { ref: `P${i + 1}` }));
    const cards = [A, A_WHT, B].map(it => I.toCard(it, null));
    const dec = r => ({ top: { ref: r }, recommendation: 'moderate' });
    const h1 = I.topRecommendationCard(dec('P1'), items, cards, [A, A_WHT, B]);
    ok(h1 && h1.index === 0 && h1.vendorItemId === 'A-BLK', '1위 P1 → A-BLK 카드', JSON.stringify(h1));
    // 카드 순서와 결정 1위가 다르면 결정 1위를 따른다(0번 가정 금지).
    const h2 = I.topRecommendationCard(dec('P2'), items, cards, [A, A_WHT, B]);
    ok(h2 && h2.index === 1 && h2.vendorItemId === 'A-WHT', '1위가 P2(같은 상품 다른 옵션) → A-WHT 카드, 0번이 아니다', JSON.stringify(h2));
    ok(I.topRecommendationCard(null, items, cards, [A, A_WHT, B]) === null, '결정(추천 1위) 없음 → 강조 없음');
    ok(I.topRecommendationCard({ top: { ref: 'P1' }, recommendation: 'weak' }, items, cards, [A, A_WHT, B]) === null,
      '«권하기 어려움(weak)» 1위 → 강조 없음');
    ok(I.topRecommendationCard(dec('P1'), items, cards.slice(1), [A_WHT, B]) === null, '1위 카드가 목록에 없으면 강조 없음');
    ok(I.topRecommendationCard(dec('P1'), items, [cards[0], cards[0]], [A, A]) === null, '같은 identity 카드가 둘이면 고르지 않는다');

    // 일반(비쇼핑) 답변 · LLM 실패 fallback
    const chat = await ask({ question: '블루투스 코덱 차이가 뭐야?' }, { classify: 'B', answer: 'SBC·AAC·LDAC 는 압축 방식이 다릅니다.' });
    ok(!chat.body.topRecommendation && !(chat.body.items || []).length, '지식 질문 응답: 카드도 강조도 없다');
  }

  /* ================================================================ */
  section('F-2. 추천 카드 강조 — 프런트 (public/index.html 실제 실행)');
  {
    const { loadApp, elFromHtml } = require('./_fake-dom');
    const app = loadApp().app;
    app.Chat.topCardIndex = app.Chat.topCardIndex || (() => -2);
    app.Chat.miniGrid = app.Chat.miniGrid || (res => '<div class="mini-grid">' + res.items.map(app.Chat.miniCard).join('') + '</div>');
    const cards = t1.r.body.items;
    const res = { items: cards, topRecommendation: t1.r.body.topRecommendation };
    const idx = app.Chat.topCardIndex(res);
    ok(idx === t1.r.body.topRecommendation.index && cards[idx].vendorItemId === 'A-BLK', '실제 1턴 응답: A-BLK 카드 자리', idx);
    const grid = app.Chat.miniGrid(res);
    const tops = (grid.match(/class="mini is-top"/g) || []).length;
    const badges = (grid.match(/<span class="mtop">추천 상품<\/span>/g) || []).length;
    ok(tops === 1 && badges === 1, '추천 1위 카드 하나만 .is-top + «추천 상품» 표시', JSON.stringify({ tops, badges }));
    const els = grid.split(/<div class="mini(?= is-top"|")/).slice(1);
    ok(els.length === cards.length && els.filter((s, i) => i !== idx).every(s => !/is-top|mtop/.test(s)),
      '2위 이하 카드는 기존 디자인 그대로');
    const plain = app.Chat.miniGrid({ items: cards });
    ok(!/is-top|mtop/.test(plain), '추천 1위가 없는 응답(topRecommendation 없음) → 강조 0');
    // 서버 identity 와 카드가 어긋나면(옵션만 다름) 강조하지 않는다 — 0번 가정 금지.
    const mismatch = { items: cards, topRecommendation: Object.assign({}, t1.r.body.topRecommendation, { vendorItemId: 'ZZZ', index: 0 }) };
    ok(app.Chat.topCardIndex(mismatch) === -1, 'identity 가 안 맞으면 강조 0 (index 만으로 고르지 않는다)');
    // 기존 카드 클릭·링크·가격·이미지 fallback 은 그대로.
    const before = app.Chat.miniCard(cards[idx]);
    const after = app.Chat.miniCard(cards[idx], true);
    ok(before.replace('class="mini"', 'class="mini is-top"').replace('<span class="mtop">추천 상품</span>', '') === after.replace('<span class="mtop">추천 상품</span>', '')
        && !/is-top|mtop/.test(before),
      '강조는 클래스·표시 한 줄만 더한다 (data-link·가격·이미지 마크업 동일)');
    const el = elFromHtml(after);
    ok(el.getAttribute('data-act') === 'mini-go' && el.getAttribute('data-vid') === 'A-BLK', '강조 카드도 같은 클릭 위임(mini-go)·옵션 속성');
    // index.map 의 두 번째 인자(숫자)가 isTop 으로 새지 않는다.
    ok(!/is-top/.test(app.Chat.miniCard(cards[1], 1)), 'miniCard 두 번째 인자는 정확히 true 일 때만 강조');

    // CSS — 라이트/다크 토큰 · 모바일 · 네온 금지
    const html = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const rule = (html.match(/\.mini\.is-top,\.mini\.is-top:hover\{[^}]*\}/) || [''])[0];
    ok(/border-color:var\(--down\)/.test(rule) && /box-shadow:0 0 0 \.5px var\(--down\)/.test(rule) && !/\d+px\s+\d+px\s+\d+px/.test(rule.replace('0 0 0 .5px', '')),
      '테두리: 의미색 --down 1px + 0.5px 링 = 1.5px, 번지는 그림자 없음', rule);
    ok(/\.mini\.is-top \.mb\{background:var\(--down-bg\)\}/.test(html), '옅은 면: --down-bg (라이트 #E9F5EF · 다크 #0F2A1E 토큰)');
    ok(/--down:#0A7A46; --down-bg:#E9F5EF;/.test(html) && /html\[data-theme="dark"\]\{[\s\S]*?--down:#3ECF8E; --down-bg:#0F2A1E;/.test(html),
      '라이트/다크 모두 --down · --down-bg 가 정의돼 있다');
    ok(/\.mini \.mtop\{font-size:\.42rem;padding:2px 4px;top:3px;right:3px\}/.test(html), '모바일: 표시 크기를 몰 배지와 같이 줄인다');
    ok(!/\.mini\.is-top[^{]*\{[^}]*(?:border-width|border:\s*2px|width|height|padding)/.test(html),
      '강조 카드의 크기(테두리 두께·폭·높이·여백)를 바꾸지 않는다 — 2열 격자 어긋남 방지');
  }

  /* ── 결과 ── */
  console.log('\n=== 그룹별 ===');
  Object.entries(group).forEach(([k, v]) => console.log(`  ${k}: ${v.pass} PASS / ${v.fail} FAIL`));
  console.log(`\n외부 호출 ${externalCalls}회, DB 쓰기 시도 ${dbWrites}회`);
  if (externalCalls || dbWrites) { fail++; failures.push('오프라인 계약 위반'); }
  console.log(`=== 결과: ${pass}/${pass + fail} PASS ===`);
  if (failures.length) {
    console.log('실패:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
