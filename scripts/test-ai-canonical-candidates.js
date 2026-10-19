#!/usr/bin/env node
/**
 * AI 후보 창 · canonical 최저가 종단 회귀 — 2026-10-15 PR #145 사후 감사. 완전 오프라인.
 *
 *   node scripts/test-ai-canonical-candidates.js
 *
 * ── 실측 사고 ──────────────────────────────────────────────────────
 *   "소니 WH-CH730N 최저가 확인해줘" → AI 는 묶음 밖 쿠팡 199,000원만 권했다.
 *   운영 묶음: 더블유컨셉코리아 189,000 · 예스이십사 199,000 · GS SHOP 199,000 (전부 ADPICK).
 *   #145 가 공급원 교차 정렬을 넣었지만 운영 재현은 그대로였다. 원인은 세 겹이었다.
 *     1) AI 가 «소니 WH-CH730N» 원문으로 검색해 /api/search 의 ADPICK 캐시 키
 *        («소니 wh ch730n»)를 못 맞혔다 → 실호출은 대기 0 이라 리미터에 거절 → ADPICK 0건.
 *     2) 식별 점수가 부속·중고·렌탈·세트에도 1.0 이라, 그런 글이 앞을 채우면 교차해도
 *        정확한 묶음 구성원이 8개 창 밖으로 밀렸다.
 *     3) 묶음을 랭킹 «뒤» 에 접고 AI 가격은 대표 판매처 값(199,000)을 그대로 읽었다.
 *        카드만 189,000원이고 답변·정렬은 199,000원이었다.
 *
 * ── 무엇을 지키는가 ────────────────────────────────────────────────
 *   A. 공급원 순서 기아: 쿠팡 정확 6 + ADPICK [무관, 구성원×3] → 구성원이 창 안
 *   B. 부속·중고·렌탈·세트 폭주에도 구성원이 창 안, 정확 모델이 언제나 앞
 *   C. 적대적 형제·부속·옵션·상태·세트·렌탈은 정확 모델과 같은 등급으로 올라오지 않는다
 *   D. AI 검색어는 /api/search 캐시 키와 같다(구분자 차이만 있을 때만)
 *   E. 핸들러 전체: 프롬프트·결정론 답변·추천 1위·카드가 묶음 최저가 189,000원으로 일치
 *
 * api/ai.js 핸들러, _shop.orderAiSearchCandidates, _canonicalconsumer, _aiidentity,
 * _search, _concierge 는 진짜 코드가 돈다. Supabase 는 읽기 전용 메모리 표, LLM·쇼핑
 * 검색은 가짜다. 외부 호출 0회, DB 쓰기 0회.
 */
'use strict';

const path = require('path');
const Module = require('module');

process.env.AUTH_SECRET = 'offline-canonical-candidates-key';
process.env.OPENROUTER_API_KEY = 'sk-or-v1-OFFLINE-CANONICAL';
process.env.OPENROUTER_MODELS = 'test/offline:free';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
for (const k of ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'ADPICK_API_KEY']) delete process.env[k];
process.env.AI_SEARCH_TIMEOUT_MS = '400';
process.env.AI_ENRICH_TIMEOUT_MS = '800';
process.env.IDENTITY_CANONICAL_CONSUMER_ENABLED = 'true';
process.env.IDENTITY_CANONICAL_CONSUMER_ROLLOUT_PERCENT = '100';
delete process.env.IDENTITY_CANONICAL_CONSUMER_GROUP_KEYS;

/* ── 가짜 Supabase (읽기 전용) ─────────────────────────────────────── */
const tables = {
  products: [], price_history: [], canonical_product_groups: [], canonical_product_members: []
};
let dbWrites = 0;
function query(table) {
  let rows = (tables[table] || []).slice();
  const q = {
    select() { return q; },
    in(col, vals) { const s = new Set((vals || []).map(String)); rows = rows.filter(r => s.has(String(r[col]))); return q; },
    eq(col, v) { rows = rows.filter(r => String(r[col]) === String(v)); return q; },
    gte(col, v) { rows = rows.filter(r => String(r[col]) >= String(v)); return q; },
    lte(col, v) { rows = rows.filter(r => String(r[col]) <= String(v)); return q; },
    order() { return q; },
    limit(n) { rows = rows.slice(0, n); return q; },
    range() { return q; },
    maybeSingle() { rows = rows.slice(0, 1); q._single = true; return q; },
    then(resolve, reject) {
      const data = q._single ? (rows[0] ? { ...rows[0] } : null) : rows.map(r => ({ ...r }));
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
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

/* ── 가짜 LLM ─────────────────────────────────────────────────────── */
const llmStub = { classify: 'A', answer: '', answerFails: false };
const captured = { answerBody: null };
let externalCalls = 0;
global.fetch = async (url, opts) => {
  if (!String(url).includes('openrouter.ai')) {
    externalCalls++;
    throw new Error(`오프라인 테스트에서 예상 밖 외부 호출: ${url}`);
  }
  const body = JSON.parse(opts.body);
  if (body.max_tokens >= 700) {
    captured.answerBody = body;
    if (llmStub.answerFails) return { ok: false, status: 503, json: async () => ({ error: { message: 'offline down' } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: llmStub.answer } }] }) };
  }
  if (body.max_tokens === 120) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' } }] }) };
  }
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: llmStub.classify } }] }) };
};

/* ── 인증·레이트리밋·검색 대역 ───────────────────────────────────────── */
const auth = require('../api/_auth');
auth.identify = () => ({ ok: true, email: 'canonical@fixture.local' });
const http = require('../api/_http');
http.applyCors = () => true;
http.noStore = () => {};
require('../api/_ratelimit').guard = () => true;
const shop = require('../api/_shop');
const realOrder = shop.orderAiSearchCandidates;
/*
 * searchAll 대역: 공급원 응답(쿠팡·ADPICK)만 가짜이고, 결합은 진짜 searchAll 과 같이
 * AI 호출이면 orderAiSearchCandidates 로 한다. 넘어온 검색어·옵션을 기록한다.
 */
const stubSearch = { coupang: [], adpick: [], calls: [] };
shop.searchAll = async (keyword, o = {}) => {
  stubSearch.calls.push({ keyword, opts: o });
  const c = stubSearch.coupang.map(it => ({ ...it, _source: 'api' }));
  const a = stubSearch.adpick.map(it => ({ ...it, _source: 'cache' }));
  const ai = (o.coupangOpts && o.coupangOpts.source === 'ai') || (o.adpickOpts && o.adpickOpts.source === 'ai');
  const items = ai ? realOrder(o.identityQuery || keyword, c, a) : c.concat(a);
  return { items, from: 'api', blocked: false };
};
shop.saveProducts = async () => ({ saved: 0 });
require('../api/_trust').attachTrust = async list => {
  (list || []).forEach(it => { if (it) it.trust = { level: 'high', label: '확인된 가격', reasons: [] }; });
  return list;
};

const OI = require('../api/_offeridentity');
const P = require('../api/_identitypromotion');
const S = require('../api/_search');
const AIID = require('../api/_aiidentity');
const llm = require('../api/_llm');
const handler = require('../api/ai.js');
/*
 * 고치기 전 코드(이 export 들이 없는 main)에서도 시험이 죽지 않고 «어느 경우가 틀렸는지» 를
 * 하나씩 FAIL 로 보여 주게, 없는 함수는 «아무것도 안 하는» 함수로 둔다.
 */
const AI = Object.assign({ aiSearchKeyword: q => q, canonicalDisplayItem: it => it }, handler._internal);

/* ── 검사 도구 ──────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
let currentGroup = '';
function section(name) { currentGroup = name; console.log(`\n── ${name} ──`); }
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else {
    fail++; failures.push(`${currentGroup} :: ${name}`);
    console.log(`  [FAIL] ${name}${detail ? ` — ${String(detail).slice(0, 500)}` : ''}`);
  }
}
const mk = (mall, productId, title, extra) => Object.assign({ mall, productId, title }, extra || {});
const ids = list => list.map(x => x.productId);
const DAY = 86400e3;
const kstDate = n => new Date(Date.now() + 9 * 3600e3 - n * DAY).toISOString().slice(0, 10);
const histRow = (pid, mall, vid, price, n) => ({
  product_id: pid, mall, vendor_item_id: vid, price, recorded_date: kstDate(n), recorded_at: new Date(Date.now() - n * DAY).toISOString()
});

async function ask(question, opts = {}) {
  try { llm._internal._reset(); } catch (e) { /* 없으면 그만 */ }
  llmStub.classify = opts.classify || 'A';
  llmStub.answer = opts.answer !== undefined ? opts.answer : '';
  llmStub.answerFails = !!opts.answerFails;
  captured.answerBody = null;
  stubSearch.calls = [];
  let status = 200, payload;
  const res = {
    status(c) { status = c; return this; },
    setHeader() { return this; },
    json(v) { payload = v; return this; },
    end() { payload = {}; return this; }
  };
  const quiet = console.log, quietWarn = console.warn, quietErr = console.error, quietInfo = console.info;
  console.log = () => {}; console.warn = () => {}; console.error = () => {}; console.info = () => {};
  try {
    await handler({ method: 'POST', headers: {}, query: {}, body: { question, chatHistory: [], contextProducts: [], view: { source: 'none' } } }, res);
  } finally {
    console.log = quiet; console.warn = quietWarn; console.error = quietErr; console.info = quietInfo;
  }
  return { status, body: payload || {} };
}

/* ── 운영 묶음을 본뜬 fixture ────────────────────────────────────────── */
const NOW = new Date().toISOString();
const ADPICK_LINK = i => `https://biz.adpick.co.kr/offer/ch730n-${i}`;
const MEMBERS = [
  { product_id: 'wconcept-730', mall_label: '더블유컨셉코리아', lprice: 189000,
    title: '소니/소니 노이즈캔슬링 무선 블루투스 헤드폰 WH-CH730N/디지털기기 헤드셋/이어폰' },
  { product_id: 'yes24-730', mall_label: '예스이십사', lprice: 199000,
    title: '소니 WH-CH730N 노이즈캔슬링 블루투스 헤드폰' },
  { product_id: 'gsshop-730', mall_label: 'GS SHOP', lprice: 199000,
    title: '[ 공식대리점 ] 소니 노이즈캔슬링 무선 헤드폰 WH-CH730N' }
];
function seedCanonicalGroup() {
  const products = MEMBERS.map((m, i) => ({
    product_id: m.product_id, mall: 'ADPICK', mall_label: m.mall_label, vendor_item_id: '', title: m.title,
    lprice: m.lprice, link: ADPICK_LINK(i), image: '', keyword: '소니 wh ch730n', collected_at: NOW
  }));
  const identities = products.map(row => OI.parseOffer({
    key: row.mall + '|' + row.product_id, title: row.title, mall: row.mall_label,
    productId: row.product_id, vendorItemId: '', price: row.lprice
  }));
  const strong = P.commonStrongIdentifier(identities);
  const tier = strong ? 'A' : 'B';
  const identity = P.canonicalIdentity(identities, strong, tier);
  tables.products = products;
  tables.canonical_product_groups = [{ id: 5, canonical_key: P.canonicalKeyOf(identity), status: 'ACTIVE', identity, confidence_tier: tier }];
  tables.canonical_product_members = products.map((row, i) => ({
    group_id: 5, source_mall: 'ADPICK', product_id: row.product_id, mall: row.mall_label, vendor_item_id: '',
    offer_key: 'ADPICK|' + row.product_id, identity_snapshot: P.snapshotOf(identities[i])
  }));
  return products;
}
const adpickRow = (m, i) => mk('ADPICK', m.product_id, m.title, {
  lprice: m.lprice, oprice: m.lprice, savePct: 0, link: ADPICK_LINK(i), image: '', mallLabel: m.mall_label,
  isCoupang: false, vendorItemId: ''
});
const coupangRow = i => mk('쿠팡', `c${i}`, `소니 가벼운 노이즈 캔슬링 헤드폰 WH-CH730N ${['블랙', '화이트', '블루', '베이지', '그레이', '네이비'][i % 6]}`, {
  lprice: 199000, oprice: 219000, savePct: 9, image: '', isCoupang: true, vendorItemId: `v${i}`,
  link: `https://link.coupang.com/re/AFFSDP?lptag=AF1234567&pageKey=c${i}&vendorItemId=v${i}`
});

(async () => {
  console.log('=== AI 후보 창 · canonical 최저가 회귀 (외부 호출 0회) ===');

  /* ── A ── */
  section('A) 공급원 순서 기아 — 쿠팡 정확 6 + ADPICK [무관, 구성원×3]');
  {
    const q = '소니 WH-CH730N';
    const coupang = Array.from({ length: 6 }, (_, i) => coupangRow(i));
    const adpick = [mk('ADPICK', 'irrelevant', '[해외] KUANJIE 소니 FX3 FX30 카메라 케이지 액세서리')]
      .concat(MEMBERS.map(adpickRow));
    const window = realOrder(q, coupang, adpick).slice(0, 8);
    const members = MEMBERS.map(m => m.product_id).filter(id => ids(window).includes(id));
    ok(members.length >= 2, `구성원이 첫 8개에 들어온다 (${members.length}/3)`, ids(window).join(','));
    ok(!ids(window).includes('irrelevant'), '무관한 ADPICK 상품은 정확 상품을 밀어내고 창에 들어오지 않는다', ids(window).join(','));
    const ten = Array.from({ length: 10 }, (_, i) => coupangRow(i));
    const w10 = realOrder(q, ten, adpick).slice(0, 8);
    ok(MEMBERS.some(m => ids(w10).includes(m.product_id)), '쿠팡이 10개를 먼저 줘도 구성원이 창 안', ids(w10).join(','));
    const plain = realOrder(q, coupang, []);
    ok(ids(plain).join() === ids(coupang).join(), '쿠팡만 있으면 같은 점수의 원래 순서를 그대로 둔다');
    const only = realOrder(q, [], adpick);
    ok(only[0] && MEMBERS.some(m => m.product_id === only[0].productId), 'ADPICK 만 있어도 정확 상품이 맨 앞');
    ok(Array.isArray(realOrder(q, null, undefined)) && realOrder(q, null, undefined).length === 0, 'null/undefined 입력은 빈 배열');
    ok(realOrder(q, [null, coupang[0]], [undefined]).length === 3, 'null 원소가 있어도 던지지 않고 아무것도 버리지 않는다');
    const eq = Array.from({ length: 5 }, (_, i) => mk('쿠팡', `e${i}`, '소니 WH-CH730N 헤드폰'));
    const eqA = Array.from({ length: 5 }, (_, i) => mk('ADPICK', `f${i}`, '소니 WH-CH730N 헤드폰'));
    ok(ids(realOrder(q, eq, eqA)).join() === 'e0,f0,e1,f1,e2,f2,e3,f3,e4,f4', '같은 점수 다수는 공급원별 순번을 안정적으로 교차');
  }

  /* ── B ── */
  section('B) 부속·중고·렌탈·세트 폭주 — 식별 점수 1.0 동점 함정');
  {
    const q = '소니 WH-CH730N';
    const flood = [
      mk('ADPICK', 'pad', '소니 WH-CH730N 이어패드 교체용'),
      mk('ADPICK', 'used', '[중고] 소니 WH-CH730N'),
      mk('ADPICK', 'rent', '소니 WH-CH730N 렌탈 월 9900원'),
      mk('ADPICK', 'set', '소니 WH-CH730N 2개 세트')
    ].concat(MEMBERS.map(adpickRow));
    ['pad', 'used', 'rent', 'set'].forEach(id => {
      const t = flood.find(x => x.productId === id).title;
      ok(S.identityMatchScore(q, t) === 1, `전제 확인: identityMatchScore 가 «${t}» 에도 1.0 (정렬 키로 단독 사용 불가)`);
    });
    const w = realOrder(q, Array.from({ length: 6 }, (_, i) => coupangRow(i)), flood).slice(0, 8);
    ok(MEMBERS.filter(m => ids(w).includes(m.product_id)).length >= 1, '폭주에도 묶음 구성원이 첫 8개 안', ids(w).join(','));
    ok(!ids(w).includes('pad'), '본품 질의에서 부속은 창 안으로 올라오지 않는다', ids(w).join(','));
  }

  /* ── C ── */
  section('C) 적대적 형제·부속·옵션·상태·세트·렌탈 — 정확 모델이 언제나 앞, 같은 등급 금지');
  {
    const cases = [
      ['exact/sibling', '소니 WH-CH730N', '소니 WH-CH730N 노이즈캔슬링 헤드폰', '소니 WH-CH720N 노이즈캔슬링 헤드폰'],
      ['accessory', '소니 WH-CH730N', '소니 WH-CH730N 노이즈캔슬링 헤드폰', '소니 WH-CH730N 이어패드 교체용'],
      ['compatible accessory', '소니 WH-CH730N', '소니 WH-CH730N 노이즈캔슬링 헤드폰', 'WH-CH730N 호환 헤드폰 커버'],
      ['accessory', 'AirPods Pro 3', 'Apple AirPods Pro 3', 'AirPods Pro 3 Case'],
      ['variant', 'iPhone 17 Pro', 'Apple iPhone 17 Pro 256GB', 'Apple iPhone 17 Pro Max 256GB'],
      ['option', '아이폰 17 프로 256GB', '애플 아이폰 17 프로 256GB', '애플 아이폰 17 프로 512GB'],
      ['variant', '갤럭시 버즈3', '삼성 갤럭시 버즈3', '삼성 갤럭시 버즈3 프로'],
      ['sibling', 'MX Master 3', '로지텍 MX Master 3', '로지텍 MX Master 3S'],
      ['condition', '소니 WH-CH730N', '소니 WH-CH730N 노이즈캔슬링 헤드폰', '[중고] 소니 WH-CH730N'],
      ['rental', '소니 WH-CH730N', '소니 WH-CH730N 노이즈캔슬링 헤드폰', '소니 WH-CH730N 렌탈 월 9900원'],
      ['bundle', '소니 WH-CH730N', '소니 WH-CH730N 노이즈캔슬링 헤드폰', '소니 WH-CH730N 2개 세트']
    ];
    for (const [kind, q, exact, other] of cases) {
      // 나쁜 후보를 쿠팡 맨 앞에, 정확 모델을 ADPICK 뒤에 둔다 — 공급원 순서가 정답과 정반대.
      const ordered = realOrder(q, [mk('쿠팡', 'other', other)], [mk('ADPICK', 'exact', exact)]);
      ok(ordered[0].productId === 'exact', `[${kind}] «${q}»: 정확 모델이 «${other}» 보다 앞`, ids(ordered).join(','));
      // 하류 식별 계약(_aiidentity.partition)도 같은 등급으로 보지 않는다.
      const contract = AIID.buildContract({ query: q, titles: [exact, other] });
      const gate = AIID.partition([{ title: exact }, { title: other }], contract);
      const tierOf = t => { const hit = gate.items.find(x => x.title === t); return hit ? hit._identity.tier : AIID.TIER.MISMATCH; };
      ok(tierOf(exact) === AIID.TIER.EXACT && tierOf(other) > AIID.TIER.EXACT,
        `[${kind}] 정확=EXACT, «${other}» 는 EXACT 아님 (tier ${tierOf(other)})`);
    }
    // canonical 은 이런 상품을 같은 묶음으로 만들지 않는다 (fail-closed).
    const pairs = [
      ['소니 WH-CH730N 노이즈캔슬링 헤드폰', '소니 WH-CH720N 노이즈캔슬링 헤드폰'],
      ['소니 WH-CH730N 노이즈캔슬링 헤드폰', '소니 WH-CH730N 이어패드 교체용'],
      ['Apple AirPods Pro 3', 'AirPods Pro 3 Case'],
      ['Apple iPhone 17 Pro 256GB', 'Apple iPhone 17 Pro Max 256GB'],
      ['Apple iPhone 17 Pro 256GB', 'Apple iPhone 17 Pro 512GB'],
      ['삼성 갤럭시 버즈3', '삼성 갤럭시 버즈3 프로'],
      ['로지텍 MX Master 3', '로지텍 MX Master 3S'],
      ['소니 WH-CH730N 노이즈캔슬링 헤드폰', '[중고] 소니 WH-CH730N 노이즈캔슬링 헤드폰'],
      ['소니 WH-CH730N 노이즈캔슬링 헤드폰', '소니 WH-CH730N 노이즈캔슬링 헤드폰 렌탈'],
      ['소니 WH-CH730N 노이즈캔슬링 헤드폰', '소니 WH-CH730N 노이즈캔슬링 헤드폰 2개 세트']
    ];
    for (const [a, b] of pairs) {
      const x = OI.parseOffer({ key: 'A|1', title: a, mall: 'Hmall', productId: '1', price: 100000 });
      const y = OI.parseOffer({ key: 'A|2', title: b, mall: 'SSG', productId: '2', price: 100000 });
      const m = OI.matchOffers(x, y, OI.contextFactory([x, y])(x, y));
      ok(m.decision !== OI.DECISION.MATCH, `canonical 매칭 금지: «${a}» ≠ «${b}» (${m.decision})`);
    }
  }

  /* ── D ── */
  section('D) AI 검색어 = /api/search 캐시 키 (구분자 차이만 있을 때)');
  {
    ok(AI.aiSearchKeyword('소니 WH-CH730N') === S.normalizeText('소니 WH-CH730N'), '«소니 WH-CH730N» → «소니 wh ch730n» (/api/search 와 같은 키)');
    ok(AI.aiSearchKeyword('로지텍 G304 X SUPERLIGHT') === '로지텍 g304 x superlight', '대소문자만 다른 질의도 같은 키');
    ok(AI.aiSearchKeyword('갤럭시 S25+') === '갤럭시 S25+', "'+' 처럼 뜻 있는 기호가 빠지는 질의는 원문 그대로");
    ok(AI.aiSearchKeyword('2.5L 전기포트') === '2.5L 전기포트', '소수점 표기는 원문 그대로');
    ok(AI.aiSearchKeyword('') === '', '빈 질의는 빈 문자열');
  }

  /* ── E ── */
  section('E) 핸들러 전체 — 프롬프트·결정론 답변·추천 1위·카드가 묶음 최저가와 일치');
  {
    seedCanonicalGroup();
    // 운영과 같이 189,000원 판매처는 이번 검색 결과에 없다. 묶음 DB 로만 알 수 있다.
    // 운영과 같이 묶음 밖 쿠팡에도, 묶음 최저가 오퍼에도 가격 기록이 있다. 대표(예스이십사)의
    // 기록만 떼고 표시 오퍼 기록을 안 붙이면 묶음이 기록 가점을 잃고 쿠팡 199,000원 아래로 간다.
    tables.price_history = [histRow('c0', '쿠팡', 'v0', 199000, 0), histRow('wconcept-730', 'ADPICK', '', 189000, 0),
      histRow('ssg-730', 'ADPICK', '', 199000, 0),
      histRow('yes24-730', 'ADPICK', '', 215000, 3), histRow('yes24-730', 'ADPICK', '', 199000, 0)];
    /*
     * 후보 창은 2026-10-15 운영 캐시(«소니 wh ch730n»)와 같은 모양이다. 싼 부속(7,070~46,320원)이
     * 창에 함께 있어 «이번 후보 안에서의» 가격 가점 차이가 거의 없다 — 그래서 기록 가점(+4)
     * 하나가 1위를 가른다. 쿠팡 정확 상품을 6개 깔면 이 함정이 가려진다(A 절에서 따로 본다).
     */
    const adpickExtra = (id, title, lprice, mallLabel) => mk('ADPICK', id, title, {
      lprice, image: '', mallLabel, link: `https://biz.adpick.co.kr/offer/${id}`, isCoupang: false, vendorItemId: ''
    });
    stubSearch.coupang = [
      Object.assign(coupangRow(0), { title: '소니 가벼운 노이즈 캔슬링 헤드폰 WH-CH730N', oprice: 199000, savePct: 0 }),
      Object.assign(coupangRow(1), { title: '소니 WH-CH700N WH-CH710N 이어폰커버 wh-ch720n이어패드 이어 패드', lprice: 11000, oprice: 11000, savePct: 0 }),
      Object.assign(coupangRow(2), { title: '스페이스쉴드 소니 WH-1000XM6 호환 헤드폰 이어 쿠션 패드 커버', lprice: 46320, oprice: 46320, savePct: 0 })
    ];
    stubSearch.adpick = [
      adpickRow(MEMBERS[1], 1),
      adpickExtra('ssg-730', '[소니] [ 공식대리점 ] 소니 노이즈캔슬링 무선 헤드폰 WH-CH730N[이마트몰] [YY3006]', 199000, 'SSG'),
      adpickRow(MEMBERS[2], 2),
      adpickExtra('irrelevant', '[해외] KUANJIE TH-145N NATO/듀얼 소니 FX3 FX30 카메라 케이지 액세서리', 39200, '알리'),
      adpickExtra('eartip', '[해외] 소니 WF-C500 WF-C510 WF-C700N WF-C710N 이어팁 이어폰 교체용 이어플러그', 7070, '알리')
    ];

    const r = await ask('소니 WH-CH730N 최저가 확인해줘', { classify: 'C|소니 WH-CH730N', answerFails: true });
    const call = stubSearch.calls[0] || { opts: {} };
    ok(call.keyword === '소니 wh ch730n', `공급원 검색어가 /api/search 캐시 키와 같다 («${call.keyword}»)`);
    ok(call.opts.identityQuery === '소니 WH-CH730N', '후보 창 정렬은 원문 상품 구절로 한다');
    ok(call.opts.adpickOpts && call.opts.adpickOpts.source === 'ai'
      && call.opts.adpickOpts.maxWaitMs === 0
      && Number.isFinite(call.opts.adpickOpts.timeoutMs)
      && call.opts.adpickOpts.timeoutMs > 0
      && call.opts.adpickOpts.timeoutMs <= 400,
      'AI 경로는 ADPICK 호출 간격 제한에서 대기하지 않고 검색 예산 안으로 timeout을 제한한다');

    const cards = r.body.items || [];
    const canon = cards.find(c => c.isCanonicalGroup === true);
    ok(r.status === 200 && !!canon, '묶음 카드가 응답에 있다', JSON.stringify(cards.map(c => [c.mall, c.mallLabel, c.lprice])));
    ok(canon && canon.displayPrice === 189000 && canon.canonicalLowestMerchant === '더블유컨셉코리아',
      '카드 표시가 = 묶음 최저가 189,000원 · 더블유컨셉코리아', canon && JSON.stringify({ d: canon.displayPrice, m: canon.canonicalLowestMerchant }));
    ok(cards[0] && cards[0].isCanonicalGroup === true, '«최저가» 질문의 첫 카드는 189,000원 묶음 (쿠팡 199,000원이 아님)',
      JSON.stringify(cards.map(c => [c.mallLabel || c.mall, c.displayPrice || c.lprice])));
    const top = r.body.topRecommendation;
    ok(top && top.index === 0 && cards[0] && top.productId === cards[0].productId,
      '추천 1위(topRecommendation)가 묶음 카드를 가리킨다', JSON.stringify(top));
    const text = String(r.body.text || '');
    ok(/189,000원/.test(text), `결정론 답변이 189,000원을 말한다`, text);
    ok(!/추천:[^\n]*199,000원/.test(text), '결정론 답변의 추천 줄이 199,000원이 아니다', text);
    ok(/더블유컨셉/.test(text) || /189,000원/.test(text), '답변의 가격 근거가 카드의 최저가 판매처와 같은 오퍼', text);

    // 모델이 받은 프롬프트에서도 묶음 후보의 «현재가» 가 189,000원이어야 한다.
    const r2 = await ask('소니 WH-CH730N 최저가 확인해줘', {
      classify: 'C|소니 WH-CH730N',
      answer: '소니 WH-CH730N 노이즈캔슬링 블루투스 헤드폰은 더블유컨셉코리아에서 189,000원으로 가장 쌉니다.'
    });
    const prompt = captured.answerBody ? JSON.stringify(captured.answerBody.messages) : '';
    // 상품 블록 머리는 «[P1] 판매처 | 상품명 | productId=…» 다(describe). 안내문 속 [P1] 언급은 건너뛴다.
    const block = (prompt.match(/\[P1\] [^|[]*\|[^[]*/) || [''])[0];
    ok(/현재가 189,000원/.test(block) && /더블유컨셉코리아/.test(block), 'P1(묶음) 프롬프트 줄: 현재가 189,000원 · 더블유컨셉코리아', block.slice(0, 400));
    ok(!/현재가 199,000원/.test(block), '묶음 후보의 현재가 줄에 대표 판매처 199,000원이 나오지 않는다', block.slice(0, 400));
    ok(/189,000원/.test(String(r2.body.text || '')), '모델 답변(189,000원)이 grounding 을 통과해 그대로 나간다', r2.body.text);
  }

  /* ── F ── */
  section('F) canonicalDisplayItem 단위 — 다른 판매 글이면 대표의 기록·정가를 뗀다');
  {
    const base = {
      isCanonicalGroup: true, productId: 'yes24-730', vendorItemId: '', price: 199000, mall: '예스이십사',
      displayPrice: 189000, displayMerchant: '더블유컨셉코리아', displayProductId: 'wconcept-730', displayVendorItemId: '',
      hist: { count: 9, avg30: 215000 }, verdict: { label: '평소보다 쌈' }, listPrice: 219000, discountPct: 9
    };
    const x = AI.canonicalDisplayItem(Object.assign({}, base));
    ok(x.price === 189000 && x.mall === '더블유컨셉코리아', '가격·판매처를 표시 오퍼로');
    ok(x.productId === 'yes24-730', 'productId(기록·추천 참조 식별)는 그대로');
    ok(!x.hist && !x.verdict && !x.listPrice && !x.discountPct, '다른 판매 글의 가격 기록·판정·정가는 뗀다');
    const same = AI.canonicalDisplayItem(Object.assign({}, base, { price: 189000, productId: 'wconcept-730' }));
    ok(same.hist && same.hist.count === 9, '대표가 곧 최저가 오퍼면 가격 기록을 유지');
    const plain = { price: 1000, mall: '쿠팡', hist: { count: 1 } };
    ok(AI.canonicalDisplayItem(plain) === plain && plain.price === 1000 && plain.hist, '묶음이 아닌 후보는 건드리지 않는다');
    const noDisplay = AI.canonicalDisplayItem({ isCanonicalGroup: true, price: 5, hist: { count: 1 } });
    ok(noDisplay.price === 5 && noDisplay.hist, '표시가가 없으면(fail-closed) 바꾸지 않는다');
  }

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
