/*
 * SIBLING 오염이 추천·가격 비교·추천 문장에 번지지 않는지 확인한다 (CO-04 통합 검증, 2026-10-23).
 *
 * #182 는 SIBLING 모델을 «카드» 에서 뺐지만, items[] 자체에는 랭킹·결정·pareto·프롬프트 맥락을
 * 위해 남긴다. 이번 검증은 그 남은 SIBLING 이 아래 네 자리 어디에서도 사용자 결과를 흐리지
 * 않는지 묻는다 — 단순히 화면에서 숨기는 것이 아니라 «실제 추천 상품과 가격 근거까지»
 * 올바른 제품에 속하는지.
 *
 *   1. decision.top (추천 1위)        — 정확한 모델이어야 한다
 *   2. 카드 (user items)              — 다른 모델은 없어야 한다
 *   3. 조립본 "다른 후보"               — 다른 모델은 올리지 않는다
 *   4. identityNote 라벨               — EXACT 상태의 카드에는 붙지 않는다
 *
 * 상품 종류를 바꿔 가며 재현한다: 마우스(G304)·노트북(RTX 4060/Ti)·스마트폰(iPhone Pro)·
 * 이어폰(에어팟 3/Pro)·용량(256/512GB)·중고/신품.
 *
 * api/ai.js 핸들러를 실제로 돌린다. 가짜 쇼핑·가짜 LLM. 외부 호출 0회, DB 쓰기 0회.
 */
'use strict';

const path = require('path');
const Module = require('module');

process.env.AUTH_SECRET = 'offline-sibling-contamination';
process.env.OPENROUTER_API_KEY = 'sk-or-v1-OFFLINE-SIBLING';
process.env.OPENROUTER_MODELS = 'test/offline:free';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
process.env.AI_SEARCH_TIMEOUT_MS = '300';

/* ── 가짜 Supabase ────────────────────────────────────────────── */
function builder() {
  const b = {
    select() { return b; }, in() { return b; }, eq() { return b; }, gte() { return b; }, lte() { return b; },
    order() { return b; }, limit() { return b; },
    then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); }
  };
  ['upsert', 'insert', 'update', 'delete'].forEach(m => {
    b[m] = () => { throw new Error(`DB write forbidden in test: ${m}`); };
  });
  return b;
}
const fakeSupabase = { from: () => builder(), rpc: () => Promise.resolve({ data: [], error: null }) };
const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request) {
  if (request === './_supabase' || request === '../api/_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};

/* ── 가짜 쇼핑 ─────────────────────────────────────────────── */
let feed = [];
const shop = require('../api/_shop');
shop.searchAll = async () => ({ items: feed.map(it => ({ ...it, _source: 'api' })), from: 'api', blocked: false });
shop.saveProducts = async () => ({ saved: 0 });
require('../api/_trust').attachTrust = async list => {
  (list || []).forEach(it => { if (it) it.trust = { level: 'high', label: '확인된 가격', reasons: ['SEOSA 기록 확인'] }; });
  return list;
};

const handler = require('../api/ai.js');
const CG = require('../api/_concierge');

/* ── 러너 ──────────────────────────────────────────────────── */
async function ask(body) {
  let status = 200, payload = null;
  const res = {
    status(c) { status = c; return this; },
    setHeader() { return this; },
    json(v) { payload = v; return this; },
    end() { payload = payload || {}; return this; }
  };
  const quiet = console.log, qw = console.warn, qe = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    await handler({ method: 'POST', headers: {}, query: {}, body: Object.assign({ contextProducts: [], view: { source: 'none' } }, body) }, res);
  } finally {
    console.log = quiet; console.warn = qw; console.error = qe;
  }
  const b = payload || {};
  return {
    status, text: String(b.text || ''),
    cards: Array.isArray(b.items) ? b.items : [],
    topRef: b.topRecommendationRef || null,
    body: b
  };
}

function item(id, title, price, mall) {
  return {
    productId: id, title, lprice: price, mall: mall || 'ADPICK', mallLabel: mall || 'ADPICK',
    link: `https://example.com/${id}`, image: 'https://example.com/i.png',
    vendorItemId: id, isCoupang: false, isRocket: false, oprice: 0, savePct: 0
  };
}

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); return; }
  fails.push(name);
  console.log(`  [FAIL] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 320)}`}`);
}
function section(t) { console.log(`\n── ${t}`); }

// 각 카테고리 한 질문당 세 가지 자리를 다 본다.
async function auditNoContamination({ question, feedItems, siblingPattern, exactPattern, label }) {
  feed = feedItems;
  const r = await ask({ question, chatHistory: [{ role: 'user', text: question }] });
  const titles = r.cards.map(c => c.title);
  // 1) 카드에 SIBLING 패턴이 전혀 없다
  ok(!r.cards.some(c => siblingPattern.test(c.title)),
    `${label}: 카드에 다른 모델이 섞이지 않는다`, titles);
  // 2) 1위 카드는 EXACT 패턴
  ok(r.cards.length >= 1 && exactPattern.test(r.cards[0].title),
    `${label}: 1위 카드가 요청한 모델`, r.cards[0] && r.cards[0].title);
  // 3) 조립본의 "다른 후보" 가 SIBLING 을 올리지 않는다
  const normed = feedItems.map((it, i) => ({
    ...it, title: it.title, lprice: it.lprice, mall: it.mall,
    _identity: siblingPattern.test(it.title) ? { tier: 2 /* SIBLING */, label: '요청하신 모델과 다름', reasons: ['model'] }
      : exactPattern.test(it.title) ? { tier: 0, label: '', reasons: [] }
      : { tier: 1 /* NEAR */, label: '다름', reasons: ['near'] }
  }));
  const composed = CG.compose({ items: normed, cards: [], decision: null, deal: null, constraints: null,
    noResult: null, degraded: false, identity: { state: 'EXACT', label: '' } });
  ok(!siblingPattern.test(composed.text),
    `${label}: 조립본 "다른 후보" 에 다른 모델이 올라오지 않는다 (SIBLING 필터)`, composed.text.slice(0, 200));
  // 4) EXACT 상태 카드에는 identityNote 가 붙지 않는다
  ok(r.cards.every(c => !c.identityNote),
    `${label}: EXACT 상태 카드는 identityNote 없음`, r.cards.map(c => c.identityNote || '-'));
}

(async () => {
  /* ================================================================ */
  section('A. 마우스 (G304 vs G304 X · G102)');
  await auditNoContamination({
    question: '로지텍 G304 마우스 추천',
    feedItems: [
      item('m1', '로지텍 G304 무선 게이밍 마우스', 40900),
      item('m2', '로지텍 공식 G304 LIGHTSPEED 무선 게이밍 마우스', 55900),
      item('m3', '로지텍코리아 공식 G304 X SUPERLIGHT 게이밍 마우스 블랙', 109000),
      item('m4', '로지텍 광마우스 G102 LIGHTSPEED', 29000)
    ],
    siblingPattern: /G304\s*X|G102/i,
    exactPattern: /G304(?!\s*X)/i,
    label: '마우스 G304'
  });

  /* ================================================================ */
  section('B. 노트북 (RTX 4060 vs 4060 Ti)');
  await auditNoContamination({
    question: 'RTX 4060 노트북 추천',
    feedItems: [
      item('n1', '레노버 리전5 RTX 4060 노트북 16GB', 1250000),
      item('n2', 'ASUS TUF 게이밍 RTX 4060 노트북 i7', 1399000),
      item('n3', '레노버 리전7 RTX 4060 Ti 노트북', 1890000),
      item('n4', 'ASUS ROG RTX 4060 Ti 노트북 OLED', 2290000)
    ],
    siblingPattern: /4060\s*Ti/i,
    exactPattern: /4060(?!\s*Ti)/i,
    label: '노트북 RTX 4060'
  });

  /* ================================================================ */
  section('C. 스마트폰 (iPhone 17 Pro vs Pro Max)');
  await auditNoContamination({
    question: '아이폰 17 프로 추천',
    feedItems: [
      item('p1', 'Apple 아이폰 17 Pro 256GB 블랙티타늄 자급제', 1599000),
      item('p2', 'Apple 아이폰 17 Pro 256GB 화이트티타늄 자급제', 1599000),
      item('p3', 'Apple 아이폰 17 Pro Max 256GB 블랙 자급제', 1899000),
      item('p4', 'Apple 아이폰 17 Pro Max 512GB 화이트 자급제', 2290000)
    ],
    siblingPattern: /Pro\s*Max/i,
    exactPattern: /Pro(?!\s*Max)/i,
    label: '아이폰 17 Pro'
  });

  /* ================================================================ */
  section('D. 이어폰 (에어팟 Pro 3 vs 일반 3세대)');
  await auditNoContamination({
    question: '에어팟 프로 3 추천',
    feedItems: [
      item('e1', 'Apple 에어팟 프로 3세대 USB-C 자급제', 329000),
      item('e2', 'Apple 에어팟 프로 3 MagSafe 충전 케이스', 349000),
      item('e3', 'Apple 에어팟 3세대 Lightning', 219000),
      item('e4', 'Apple 에어팟 2세대 (라이트닝 케이스)', 169000)
    ],
    siblingPattern: /에어팟(?!\s*프로)|AirPods(?!\s*Pro)/i,
    exactPattern: /에어팟\s*프로|AirPods\s*Pro/i,
    label: '에어팟 Pro 3'
  });

  /* ================================================================ */
  section('E. 용량 (256GB — 다른 용량은 NEAR, 유지되지만 라벨)');
  {
    // 용량은 NEAR tier 라서 SIBLING 필터에 걸리지 않는다 — 라벨은 붙는다.
    feed = [
      item('s1', 'Apple MacBook Air M4 13 256GB 스페이스블랙', 1690000),
      item('s2', 'Apple MacBook Air M4 13 512GB 미드나이트', 1990000)
    ];
    const r = await ask({ question: '맥북 에어 M4 256GB 추천', chatHistory: [{ role: 'user', text: '맥북 에어 M4 256GB 추천' }] });
    const by = Object.fromEntries(r.cards.map(c => [c.productId, c]));
    ok(by.s1 && by.s2, '256GB·512GB 둘 다 카드에 있다 (NEAR 는 카드에 유지)', Object.keys(by));
    ok(by.s1 && !by.s1.identityNote && by.s2 && /용량/.test(String(by.s2.identityNote || '')),
      '요청한 용량은 라벨 없음, 다른 용량(512GB)에 「용량 다름」 라벨',
      { s1: by.s1 && by.s1.identityNote, s2: by.s2 && by.s2.identityNote });
  }

  /* ================================================================ */
  section('F. 중고 vs 신품 — EXCLUDED 는 소프트 유지, SIBLING 필터와 섞이지 않음');
  {
    const AI = require('../api/_aiidentity');
    const items = [
      { title: '애플 아이폰 15 프로 128GB 새상품', _identity: { tier: AI.TIER.EXACT, label: '', reasons: [] } },
      { title: '[중고] 애플 아이폰 15 프로 128GB', _identity: { tier: AI.TIER.EXCLUDED, label: '제외 요청하신 중고 상태', reasons: ['condition-excluded'] } },
      { title: '애플 아이폰 15 프로 맥스 128GB 새상품', _identity: { tier: AI.TIER.SIBLING, label: '요청하신 모델과 다름', reasons: ['model'] } }
    ];
    const composed = CG.compose({ items, cards: [], decision: null, deal: null, constraints: null,
      noResult: null, degraded: false, identity: { state: 'EXACT', label: '아이폰 15 프로' } });
    ok(!/맥스/.test(composed.text), 'SIBLING(Pro Max) 은 조립본에 올라오지 않는다', composed.text.slice(0, 180));
    ok(/중고/.test(composed.text) || /중고/.test(JSON.stringify(items[1])),
      'EXCLUDED(중고) 는 조립본에서 완전히 지우지 않는다 (라벨 유지 — items[] 그대로)', composed.text.slice(0, 180));
  }

  /* ================================================================ */
  section('G. 추천 1위는 EXACT — SIBLING 이 topRef 로 들어가지 않는다');
  {
    feed = [
      item('t1', '로지텍 G304 무선 게이밍 마우스', 40900),
      // SIBLING 이 더 싸도 1위가 되면 안 된다 — "다른 모델이 더 싸다" 는 추천 근거가 아니다.
      item('t2', '로지텍 G102 LIGHTSPEED 유선 마우스', 19900)
    ];
    const r = await ask({ question: '로지텍 G304 추천', chatHistory: [{ role: 'user', text: '로지텍 G304 추천' }] });
    ok(r.cards.length >= 1 && /G304/.test(r.cards[0].title) && !/G102/.test(r.cards[0].title),
      '더 싼 다른 모델(G102)이 있어도 요청한 G304 가 1위', r.cards.map(c => `${c.title}|${c.lprice}`));
    ok(!r.cards.some(c => /G102/.test(c.title)), 'G102 는 카드에서 빠진다', r.cards.map(c => c.title));
  }

  /* ================================================================ */
  section('H. 본품·부속과 일반형 AirPods 3 모델 구별');
  {
    feed = [
      item('a3-main', 'Apple AirPods 3세대 Lightning 본체', 219000),
      item('a3-pro-case', 'AirPods Pro 3 전용 실리콘 케이스 2개입', 4900),
      item('a3-pro', 'Apple AirPods Pro 3세대 USB-C 자급제', 329000),
      item('a3-pro2', 'Apple AirPods Pro 2 USB-C', 289000)
    ];
    const question = '에어팟 3세대 본체만, 케이스나 액세서리는 빼고 찾아줘';
    const contract = require('../api/_aiidentity').buildContract({ query: question, userText: question });
    ok(contract.anchors.includes('3') && !contract.wantsAccessory && contract.excludeAccessory,
      '부정 목록에서 케이스·액세서리를 분리하고 AirPods 3 본품 조건을 보존한다', {
        anchors: contract.anchors, wantsAccessory: contract.wantsAccessory, excludeAccessory: contract.excludeAccessory
      });
    const r = await ask({ question, chatHistory: [{ role: 'user', text: question }] });
    ok(r.cards.some(c => /AirPods 3세대|에어팟 3세대/i.test(c.title)
      && !/Pro|프로/i.test(c.title)),
    '일반 AirPods 3 본품이 후보에 있을 때 1개 이상 권한다', r.cards.map(c => c.title));
    ok(r.cards.every(c => !/케이스|case|AirPods Pro|에어팟 프로/i.test(c.title)),
      '케이스와 Pro 형제 모델은 카드에서 제외한다', r.cards.map(c => c.title));
  }

  {
    feed = [
      item('a3-main-option', 'Apple AirPods 3세대 Lightning 본체', 219000),
      item('a3-pro2-option', 'Apple AirPods Pro 2 USB-C', 289000)
    ];
    const question = 'AirPods 3 일반형 256GB 있으면 그중에 제일 싼 것';
    const r = await ask({ question, chatHistory: [{ role: 'user', text: question }] });
    ok(r.cards.every(c => !/AirPods Pro|에어팟 프로/i.test(c.title)),
      '저장 공간 조건이 맞지 않아도 Pro 형제 모델로 바꾸지 않는다', r.cards.map(c => c.title));
  }

  /* ================================================================ */
  section('I. 가격 이력 기간 숫자는 상품 모델이 아니다');
  {
    feed = [
      item('g304-history', 'Logitech G304 Lightspeed Wireless Gaming Mouse 910-005284', 59900),
      item('g304x-history', 'Logitech G304 X Wireless Gaming Mouse', 62900)
    ];
    const question = '로지텍 G304 무선 마우스 현재가, 최근 30일 최저가와 가격 변동을 실제 가격 이력 기준으로 알려줘.';
    const contract = require('../api/_aiidentity').buildContract({ query: question, userText: question });
    ok(contract.anchors.includes('g304') && !contract.anchors.includes('30'),
      '30일 이력 기간은 모델 식별 anchor로 처리하지 않는다', contract.anchors);
    const r = await ask({ question, chatHistory: [{ role: 'user', text: question }] });
    ok(r.cards.some(c => /G304/i.test(c.title) && !/G304\s*X|G304X/i.test(c.title)),
      'G304 가격 질문은 G304 본품 후보를 남긴다', r.cards.map(c => c.title));
    ok(r.cards.every(c => !/G304\s*X|G304X/i.test(c.title)),
      'G304 가격 질문에서 G304 X 형제 모델을 제외한다', r.cards.map(c => c.title));
  }

  console.log(`\n=== 결과: ${pass}/${pass + fails.length} PASS ===`);
  if (fails.length) {
    console.log('\n실패:');
    fails.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
