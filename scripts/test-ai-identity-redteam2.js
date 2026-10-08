#!/usr/bin/env node
/**
 * PR #128 2차 — Codex 독립 레드팀이 깨뜨린 결함의 재현·회귀 (완전 오프라인).
 *
 * ── 이 파일의 규칙 ─────────────────────────────────────────────
 *
 *   · 판정 기준은 결정적 식별자뿐이다: productId · vendorItemId · 서명 수락/거부 ·
 *     랭킹의 _identityMiss. 답변 문장을 정규식으로 훑어 «선택이 맞았다» 고 세지
 *     않는다. (답변 문장이 등장하는 곳은 R2 하나 — «그 문장이 폐기됐는가»,
 *     즉 degraded 여부라는 서버 판정만 본다.)
 *   · 수정 전 코드에서 실패하고 수정 후 통과해야 의미가 있다. 그래서 이 파일은
 *     새 API 가 없을 때도 죽지 않고 «FAIL» 로 센다(typeof 검사).
 *   · 핵심 검증을 지우는 mutation 을 걸면 여기서 반드시 깨져야 한다
 *     (scripts/mutation-identity.js 가 그것을 확인한다).
 *
 * ── 공격군 (Codex 보고서 번호) ──────────────────────────────────
 *
 *   R1  G304 / G304 X 복합 부정                         (#1)
 *   R2  가격 · 식별 결속                                  (#2 · #3)
 *   R4  순서 참조 (첫 번째 · 두 번째 · 세 번째)            (#4)
 *   R5  사용자 별칭 (A · B)                               (#5)
 *   R6  모델 변형 판정기 FP / FN                          (#6)
 *   R7  액세서리 유형                                     (#7)
 *   R8  다른 제품군 후보 오염                             (#8)
 *   R9  서명 참조의 세션 결속 (cross-session replay)      (#9)
 *   R10 서명 검증 보호                                   (#10)
 */
'use strict';

const H = require('./_ai-offline-harness.js');
const { stub, call, browser, reset } = H;
const AC = require('../api/_aicontext');
const SI = require('../api/_shopintent');
const Intent = require('../api/_intent');
const I = require('../api/ai.js')._internal;

/* ── 집계 ─────────────────────────────────────────────────────── */
const groups = new Map();
const failures = [];
let pass = 0, fail = 0;
function record(group, name, cond, detail) {
  const g = groups.get(group) || { pass: 0, fail: 0 };
  if (cond) { g.pass++; pass++; } else { g.fail++; fail++; failures.push(`[${group}] ${name} — ${detail}`); }
  groups.set(group, g);
}

const NEUTRAL = '확인한 후보를 아래에 정리했습니다.';
const ids = r => (r.body.items || []).map(c => c.productId);
const topId = r => ids(r)[0] || '';

/* ── 픽스처 ──────────────────────────────────────────────────── */
const C = (productId, title, lprice, extra) => Object.assign({
  title, lprice, link: `https://l.c/${productId}`, image: '', mall: '쿠팡', productId,
  vendorItemId: `${productId}V`, isCoupang: true, oprice: lprice, savePct: 0
}, extra || {});

function mice(inverted) {
  return [
    C('G1', '로지텍 G304 LIGHTSPEED 무선 게이밍 마우스, 블랙', inverted ? 129000 : 39000),
    C('G2', '로지텍 G304 X SUPERLIGHT 무선 게이밍 마우스, 화이트', inverted ? 29000 : 109000),
    C('G3', '로지텍 G PRO X SUPERLIGHT 2 무선 게이밍 마우스', 159000)
  ];
}
/* 번들 · 중고까지 섞인 결과. 일반형이 가장 비싸게 둔다 — 식별이 틀리면 반드시 드러난다. */
function miceFull() {
  return mice(true).concat([
    C('G4', '로지텍 G304 LIGHTSPEED 무선 마우스 + 마우스패드 번들 세트', 25000),
    C('G5', '[중고] 로지텍 G304 LIGHTSPEED 무선 게이밍 마우스', 15000)
  ]);
}
/* Codex 가 쓴 최소 픽스처 그대로. */
function codexPair(samePrice) {
  return [
    C('G1', 'Logitech G304', 39000, { vendorItemId: 'G1V' }),
    C('G2', 'G304 X SUPERLIGHT', samePrice ? 39000 : 109000, { vendorItemId: 'G2V' })
  ];
}
function buds() {
  return [
    C('A1', 'Apple 에어팟 프로 3 USB-C 블루투스 이어폰', 329000),
    C('A1W', 'Apple 에어팟 프로 3 USB-C 블루투스 이어폰 화이트 정품', 335000),
    C('AC1', '애플 에어팟 프로 3 충전 케이스 단품 정품', 89000),
    C('AC2', '에어팟 프로 3 실리콘 보호 케이스', 9900),
    C('AC3', '에어팟 프로 3 투명 하드 커버', 6900),
    C('AC4', '에어팟 프로 3 호환 폼 이어팁 S M L', 7900),
    C('AC5', '에어팟 프로 3 넥 스트랩 분실방지 끈', 5900),
    C('AC6', '에어팟 프로 3 충전 거치대 스탠드', 15900),
    C('AC7', '에어팟 프로 3 키링 카라비너', 3900),
    C('AC8', 'USB-C 20W 충전 어댑터 에어팟 프로 3 호환', 12900),
    C('AC9', 'USB-C to USB-C 케이블 1m 에어팟 프로 3 호환', 4900),
    C('X1', '삼성 갤럭시 버즈3 프로 무선 이어폰', 199000),
    C('X2', '삼성 갤럭시 버즈3 무선 이어폰', 149000)
  ];
}
function dyson() {
  return [
    C('D1', '다이슨 V15 디텍트 무선 청소기', 899000),
    C('D2', '다이슨 V12 슬림 무선 청소기', 699000)
  ];
}
function threeMice() {
  return [
    C('O1', '알파 무선 마우스 M100', 30000),
    C('O2', '베타 무선 마우스 M200', 40000),
    C('O3', '감마 무선 마우스 M300', 50000)
  ];
}

/** 질의 1건. 분류기 대역은 사용자 문장을 그대로 검색어로 돌려준다(가장 나쁜 현실 조건). */
async function ask(items, question, extra) {
  reset(items);
  stub.llm.classify = `D|${question}`;
  stub.llm.resolve = JSON.stringify({ q: question, use: '', brand: '', avoid: '' });
  stub.llm.answer = (extra && extra.answer) || NEUTRAL;
  return call(Object.assign({ question, contextProducts: [], chatHistory: [], view: { source: 'none' } },
    (extra && extra.body) || {}));
}

/**
 * 같은 대화의 다음 턴. reset 하지 않는다 — 카탈로그(저장된 검색 결과)가 남아
 * 있어야 서명 참조를 서버가 다시 확인할 수 있다(운영과 같다).
 */
async function turn(conv, items, question, opts) {
  const o = opts || {};
  stub.searchItems = (items || []).map(it => Object.assign({}, it));
  stub.stats = H.statsFor(stub.searchItems);
  stub.llm.classify = o.classify || `D|${question}`;
  stub.llm.resolve = JSON.stringify({ q: o.resolveQ || question, use: '', brand: '', avoid: '' });
  stub.llm.answer = o.answer || NEUTRAL;
  require('../api/_llm')._internal._reset();
  const body = {
    question, contextProducts: o.contextProducts || [], chatHistory: conv.history.slice(),
    prevTopRef: o.ref !== undefined ? o.ref : conv.ref, prevTop: conv.top || '', view: o.view || { source: 'none' }
  };
  const r = conv.browser ? await conv.browser.call(body) : await call(body);
  conv.history.push({ role: 'user', text: question },
    { role: 'assistant', text: String(r.body.text || ''), sig: r.body.turnSig });
  if (r.body.topRecommendationRef !== undefined) conv.ref = String(r.body.topRecommendationRef || '');
  else conv.ref = '';                  // 프론트(index.html 9648)와 같다 — 응답에 없으면 비운다
  if (r.body.topProductId) conv.top = String(r.body.topProductId);
  return r;
}
const newConv = b => ({ history: [], ref: '', top: '', browser: b || null });

/* ================================================================== *
 *  R1 — 복합 부정
 * ================================================================== */
const R1_FULL = [
  'G304 X랑 SUPERLIGHT랑 번들은 빼고 일반 G304만 가격 알려줘',
  'G304 X, SUPERLIGHT, 번들 다 빼고 일반 G304 가격',
  'G304 X하고 SUPERLIGHT하고 번들 제외하고 G304 기본형만',
  'X 모델이랑 슈퍼라이트랑 번들 말고 그냥 G304 최저가',
  'G304 X나 SUPERLIGHT나 번들 아닌 일반 G304 얼마야',
  '번들이랑 중고랑 G304 X는 빼고 G304 가격 알려줘',
  '중고랑 G304 X는 제외하고 검정 기본형',
  'G304 X 말고, SUPERLIGHT 말고, 번들도 말고 G304만',
  'SUPERLIGHT 제외, X 제외, 번들 제외 G304 가격',
  'G304 X와 SUPERLIGHT 및 번들 제외 G304 가격',
  'G304 X가 아니라 일반 G304 가격 알려줘 번들 말고 중고도 말고',
  '중고 제외 번들 제외 X 제외하고 로지텍 G304 가격',
  '패드 포함 제외하고 X도 빼고 중고도 빼고 G304 기본형 가격',
  'G304 X랑 번들이랑 중고는 싫고 일반 G304',
  'G304 standard only, not X, not SUPERLIGHT, no bundle, not used',
  'G304 X 버전 아니고 번들도 아니고 중고도 아니고 G304만',
  '로지텍 G304 사려는데 X랑 슈퍼라이트는 빼줘 번들이랑 중고도',
  'G304 중고 말고 새거, X 말고 기본, 번들 말고'
];
const R1_SINGLE = [
  'G304 X 말고 G304 가격', 'G304 X 제외 G304 가격', 'G304 X는 빼고 G304 가격',
  'G304 X가 아니라 G304 가격', 'SUPERLIGHT 말고 G304 가격', 'X 말고 일반 G304 가격',
  'G304 X는 제외하고 기본형', 'G304인데 X는 아닌 거 가격'
];
const R1_USED_BUNDLE = [
  ['G304 중고 제외 가격', 'G5'], ['G304 번들 제외 가격', 'G4'],
  ['G304 패드 포함 제외 가격', 'G4'], ['G304 중고는 빼고 가격', 'G5'],
  ['G304 번들은 말고 가격', 'G4'], ['G304 중고 아닌 거 가격', 'G5']
];
const R1_EXPLICIT_X = [
  'G304 X SUPERLIGHT 가격 알려줘', 'G304 X 가격', 'G304 X만 보여줘',
  '일반 G304 말고 G304 X 가격', 'G304 기본형 말고 X 버전 가격', 'SUPERLIGHT 버전 G304 X 가격',
  'G304 X SUPERLIGHT 번들 말고 가격', '중고 말고 G304 X SUPERLIGHT 새 제품 가격'
];

async function groupR1() {
  for (const q of R1_FULL) {
    const r = await ask(miceFull(), q);
    record('R1 복합 부정 → 일반 G304', q, topId(r) === 'G1', `top=${topId(r) || '없음'} cards=${ids(r)}`);
    const sent = String((stub.captured.searchQueries || []).slice(-1)[0] || '').toLowerCase();
    const leaked = [/(^|[^a-z0-9])x([^a-z0-9]|$)/, /superlight|슈퍼라이트/, /번들/, /중고/, /패드/]
      .filter(re => re.test(sent));
    record('R1q 부정 대상이 검색어에 남지 않는다', q, leaked.length === 0, `검색어="${sent}"`);
  }
  for (const inverted of [false, true]) {
    for (const q of R1_SINGLE) {
      const r = await ask(mice(inverted), q);
      record(`R1 단일 부정 → 일반 G304 (${inverted ? '가격역전' : '정상가'})`, q, topId(r) === 'G1',
        `top=${topId(r) || '없음'} cards=${ids(r)}`);
    }
  }
  for (const [q, banned] of R1_USED_BUNDLE) {
    const r = await ask(miceFull(), q);
    record('R1 중고·번들 제외', q, topId(r) === 'G1' && topId(r) !== banned,
      `top=${topId(r) || '없음'} cards=${ids(r)}`);
  }
  for (const inverted of [false, true]) {
    for (const q of R1_EXPLICIT_X) {
      const r = await ask(inverted ? miceFull() : mice(false).concat(miceFull().slice(3)), q);
      record(`R1 G304 X 명시 → X (${inverted ? '가격역전' : '정상가'})`, q, topId(r) === 'G2',
        `top=${topId(r) || '없음'} cards=${ids(r)}`);
    }
  }
}

/* ================================================================== *
 *  R2 — 가격 · 식별 결속
 * ================================================================== */
async function groupR2() {
  const G = 'R2 가격·식별 결속';
  /* 선택 = G1(일반형). 아래 답변은 전부 «다른 상품의 이름·가격» 이라 폐기돼야 한다. */
  const wrongForG1 = [
    ['selected G1 + G2 이름·가격', 'G304 X SUPERLIGHT는 현재 109,000원입니다.'],
    ['selected G1 + G2 이름(가격 없음)', 'G304 X SUPERLIGHT를 추천합니다.'],
    ['selected G1 + G2 가격(모델명 모호)', 'G304는 현재 109,000원입니다.'],
    ['selected G1 이름 + G2 가격', 'Logitech G304는 현재 109,000원입니다.'],
    ['selected G1 답에 G2 가격을 덧붙임', 'Logitech G304는 39,000원이고 G304 X SUPERLIGHT는 109,000원입니다.'],
    ['selected G1 + G2 를 최저가로 단정', '가장 싼 건 G304 X SUPERLIGHT로 109,000원입니다.']
  ];
  for (const [label, answer] of wrongForG1) {
    const r = await ask(codexPair(false), 'G304 가격 알려줘', { answer });
    record(G, label, r.body.degraded === true && r.body.text !== answer,
      `degraded=${r.body.degraded} top=${r.body.topProductId} text=${String(r.body.text).slice(0, 50)}`);
  }
  /* 대조 — 올바른 귀속은 살아 있어야 한다(전부 폐기해서 통과하는 것을 막는다). */
  {
    const answer = 'Logitech G304는 현재 39,000원입니다.';
    const r = await ask(codexPair(false), 'G304 가격 알려줘', { answer });
    record(G, '(대조) selected G1 + G1 가격 → 유지', r.body.degraded !== true && r.body.text === answer,
      `degraded=${r.body.degraded} text=${String(r.body.text).slice(0, 50)}`);
  }
  /* 같은 가격 — 금액만으로는 못 가른다. 이름이 다른 상품이면 폐기. */
  {
    const r = await ask(codexPair(true), 'G304 가격 알려줘', { answer: 'G304 X SUPERLIGHT는 현재 39,000원입니다.' });
    record(G, '같은 가격이라도 다른 상품 이름이면 폐기', r.body.degraded === true,
      `degraded=${r.body.degraded} top=${r.body.topProductId}`);
  }
  /* 선택 = G2 인데 답은 G1. */
  {
    const r = await ask(codexPair(false), 'G304 X SUPERLIGHT 가격 알려줘', { answer: 'Logitech G304는 현재 39,000원입니다.' });
    record(G, 'answer title G1 + internally selected G2 → 폐기', r.body.degraded === true && r.body.topProductId === 'G2',
      `degraded=${r.body.degraded} top=${r.body.topProductId}`);
    const ok2 = await ask(codexPair(false), 'G304 X SUPERLIGHT 가격 알려줘', { answer: 'G304 X SUPERLIGHT는 현재 109,000원입니다.' });
    record(G, '(대조) selected G2 + G2 가격 → 유지', ok2.body.degraded !== true,
      `degraded=${ok2.body.degraded} text=${String(ok2.body.text).slice(0, 50)}`);
  }
  /* 같은 상품명 · 다른 옵션 — 옵션 결속. */
  {
    const items = [
      C('G1', 'Logitech G304', 39000, { vendorItemId: 'G1V-BK' }),
      C('G1', 'Logitech G304', 41000, { vendorItemId: 'G1V-WH' })
    ];
    const r = await ask(items, 'G304 가격 알려줘', { answer: 'Logitech G304는 현재 41,000원입니다.' });
    const top = (r.body.items || [])[0] || {};
    record(G, '같은 제목 · 다른 옵션 가격을 선택 옵션에 붙이면 폐기', r.body.degraded === true,
      `degraded=${r.body.degraded} selected=${top.vendorItemId}`);
  }
  /* 서명 참조 G1 + 답은 G2 가격. */
  {
    reset(codexPair(false));
    const conv = newConv();
    const t1 = await turn(conv, codexPair(false), 'G304 가격 알려줘', { answer: 'Logitech G304는 현재 39,000원입니다.' });
    const t2 = await turn(conv, codexPair(false), '아까 추천한 그 상품 가격 알려줘',
      { answer: 'G304 X SUPERLIGHT는 현재 109,000원입니다.' });
    record(G, 'ref G1 + price G2 → 폐기', t1.body.topProductId === 'G1' && t2.body.degraded === true
      && ids(t2).every(id => id === 'G1'), `t1=${t1.body.topProductId} degraded=${t2.body.degraded} cards=${ids(t2)}`);
  }
  /* productId 와 vendorItemId 를 엇갈려 붙인 화면 상품. */
  {
    reset(codexPair(false));
    await turn(newConv(), codexPair(false), 'G304 가격 알려줘');      // 카탈로그 채우기
    stub.llm.classify = 'E';
    stub.llm.answer = '이 상품은 현재 39,000원입니다.';
    const r = await call({
      question: '이거 지금 얼마야?', view: { source: 'modal' }, chatHistory: [],
      contextProducts: [{ productId: 'G1', vendorItemId: 'G2V', mall: '쿠팡', mallId: '쿠팡', title: 'Logitech G304' }]
    });
    record(G, 'G1 productId + G2 vendorItemId → 가격을 말하지 않는다',
      !/39,000|109,000/.test(String(r.body.text)) && !(r.body.items || []).length,
      `text=${String(r.body.text).slice(0, 60)}`);
  }
  /* 서버가 서명했더라도 엇갈린 쌍은 카탈로그와 맞지 않으면 쓰지 않는다. */
  {
    reset(codexPair(false));
    await turn(newConv(), codexPair(false), 'G304 가격 알려줘');
    const session = typeof AC.sessionBinding === 'function' ? AC.sessionBinding({ email: stub.email }) : '';
    const crossed = AC.createRecommendationRef({ productId: 'G1', vendorItemId: 'G2V', mallId: '쿠팡' }, undefined, { session });
    stub.llm.classify = 'E';
    stub.llm.answer = '그 상품은 현재 39,000원입니다.';
    const r = await call({ question: '아까 추천한 그 상품 가격 알려줘', prevTopRef: crossed, chatHistory: [], view: { source: 'none' } });
    record(G, '서명된 엇갈린 쌍(G1+G2V) → 가격을 말하지 않는다',
      !/39,000|109,000/.test(String(r.body.text)) && !(r.body.items || []).length,
      `text=${String(r.body.text).slice(0, 60)}`);
  }
  /* 단위 — 결속 판정 자체. */
  const base = { productId: 'A', vendorItemId: 'A1', mallId: '쿠팡', isCoupang: true };
  record(G, 'unit: A/A1 = A/A1', I.productIdentityMatches(base, Object.assign({}, base)), '');
  record(G, 'unit: A ≠ B', !I.productIdentityMatches(base, Object.assign({}, base, { productId: 'B' })), '');
  record(G, 'unit: A/A1 ≠ A/B1', !I.productIdentityMatches(base, Object.assign({}, base, { vendorItemId: 'B1' })), '');
  record(G, 'unit: A/A1 ≠ B/A1', !I.productIdentityMatches(base, Object.assign({}, base, { productId: 'B' })), '');
  record(G, 'unit: 쿠팡 옵션 없음 ≠', !I.productIdentityMatches(Object.assign({}, base, { vendorItemId: '' }), Object.assign({}, base, { vendorItemId: '' })), '');
  record(G, 'unit: 몰 다름 ≠', !I.productIdentityMatches(base, Object.assign({}, base, { mallId: 'ADPICK' })), '');
  /* 단위 — 금액 귀속: 선택 상품이 뒷받침하지 않는 금액은 근거 없음. */
  const g1 = { ref: 'P1', title: 'Logitech G304', price: 39000, productId: 'G1', vendorItemId: 'G1V', mall: '쿠팡', mallId: '쿠팡', isCoupang: true, trust: { level: 'high' } };
  const g2 = { ref: 'P2', title: 'G304 X SUPERLIGHT', price: 109000, productId: 'G2', vendorItemId: 'G2V', mall: '쿠팡', mallId: '쿠팡', isCoupang: true, trust: { level: 'high' } };
  record(G, 'unit: G1 단독 근거에서 "G304 X SUPERLIGHT 109,000원" 은 근거 없음',
    I.unverifiedProductPrices('G304 X SUPERLIGHT는 현재 109,000원입니다.', [g1]).includes(109000), '');
  record(G, 'unit: G1 근거에서 "Logitech G304 39,000원" 은 근거 있음',
    I.unverifiedProductPrices('Logitech G304는 현재 39,000원입니다.', [g1]).length === 0, '');
  record(G, 'unit: 두 상품 근거라도 G1 이름에 G2 금액은 근거 없음',
    I.unverifiedProductPrices('Logitech G304는 현재 109,000원입니다.', [g1, g2]).includes(109000), '');
}

/* ================================================================== *
 *  R4 — 순서 참조
 * ================================================================== */
const R4_SECOND = [
  '두 번째 상품 가격', '두번째 상품 가격', '두 번째 거 얼마야', '2번째 상품 가격', '둘째 거 가격',
  '두 번째 제품 가격 알려줘', '두 번째 꺼 얼마', '2번 상품 가격', '두 번째 거 지금 사도 돼?', '두 번째 추천 가격',
  '두 번째 상품 다시 보여줘', '두번째꺼 가격', '2번째 거 얼마야', '두 번째 마우스 가격', '두 번째로 보여준 거 가격',
  '두 번째 상품은 얼마야?', '둘째 상품 가격 알려줘', '두 번째 것 가격', '2번째 제품 현재가', '두 번째 상품 최저가'
];
const R4_FIRST = [
  '첫 번째 상품 가격', '첫번째 거', '1번째 상품 가격', '처음 거 가격', '맨 처음 거 얼마야',
  '위에 거 가격', '맨 위 상품 가격', '첫 번째 제품 다시 알려줘', '1번 상품 얼마야', '첫째 거 가격'
];
const R4_THIRD = ['세 번째 상품 가격', '3번째 거 얼마야', '마지막 거 가격', '세번째 제품', '맨 아래 거 가격'];
const R4_NEGATED = [
  ['세 번째 말고 두 번째', 1], ['첫 번째 말고 세 번째 가격', 2], ['두 번째 빼고 첫 번째', 0],
  ['세 번째 아니고 첫 번째 상품', 0], ['첫 번째 말고 두 번째 거 얼마야', 1]
];

async function groupR4() {
  record('R4 parser', '마지막으로 묻는다 is not the last product ordinal',
    Intent.recommendationTarget('마지막으로 묻는다 999,999원이 맞지?') === null,
    JSON.stringify(Intent.recommendationTarget('마지막으로 묻는다 999,999원이 맞지?')));
  const run = async (phrase, wantIndex, group) => {
    reset(threeMice());
    const conv = newConv();
    const t1 = await turn(conv, threeMice(), '무선 마우스 추천해줘', { classify: 'C|무선 마우스' });
    const order = ids(t1);
    if (order.length < 3) { record(group, phrase, false, `1턴 카드 ${order}`); return; }
    const r = await turn(conv, threeMice(), phrase);
    const want = order[wantIndex];
    record(group, phrase, ids(r).length === 1 && ids(r)[0] === want,
      `want=${want} got=${ids(r) || '없음'} (1턴 순서 ${order})`);
  };
  for (const p of R4_SECOND) await run(p, 1, 'R4 두 번째');
  for (const p of R4_FIRST) await run(p, 0, 'R4 첫 번째');
  for (const p of R4_THIRD) await run(p, 2, 'R4 세 번째');
  for (const [p, i] of R4_NEGATED) await run(p, i, 'R4 부정된 순서');

  /* Codex 시나리오 — 4턴 연속. 참조 턴이 목록을 덮어쓰면 3·4턴이 틀린다. */
  {
    reset(threeMice());
    const conv = newConv();
    const t1 = await turn(conv, threeMice(), '무선 마우스 추천해줘', { classify: 'C|무선 마우스' });
    const order = ids(t1);
    const t2 = await turn(conv, threeMice(), '두 번째 상품 가격');
    const t3 = await turn(conv, threeMice(), '첫 번째 상품 다시');
    const t4 = await turn(conv, threeMice(), '세 번째 말고 두 번째');
    record('R4 4턴 연속', 'turn2 두 번째 → B', ids(t2)[0] === order[1] && ids(t2).length === 1, `got=${ids(t2)}`);
    record('R4 4턴 연속', 'turn3 첫 번째 → A', ids(t3)[0] === order[0] && ids(t3).length === 1, `got=${ids(t3)}`);
    record('R4 4턴 연속', 'turn4 세 번째 말고 두 번째 → B', ids(t4)[0] === order[1] && ids(t4).length === 1, `got=${ids(t4)}`);
  }
  /* 목록 밖 순서 → 아무 상품도 고르지 않는다. */
  {
    reset(threeMice());
    const conv = newConv();
    await turn(conv, threeMice(), '무선 마우스 추천해줘', { classify: 'C|무선 마우스' });
    const r = await turn(conv, threeMice(), '다섯 번째 상품 가격');
    record('R4 범위 밖', '다섯 번째 (3개뿐) → 상품 없음', ids(r).length === 0, `got=${ids(r)}`);
  }
  /* 클라이언트가 순서를 바꿔 끼운 토큰 → 거부. */
  {
    reset(threeMice());
    const conv = newConv();
    const t1 = await turn(conv, threeMice(), '무선 마우스 추천해줘', { classify: 'C|무선 마우스' });
    const order = ids(t1);
    const parts = String(conv.ref).split('.');
    let tampered = '';
    if (parts.length === 3) {
      try {
        const d = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        if (Array.isArray(d.l) && d.l.length >= 2) { const x = d.l[0]; d.l[0] = d.l[1]; d.l[1] = x; }
        const enc = Buffer.from(JSON.stringify(d)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        tampered = `${parts[0]}.${enc}.${parts[2]}`;
      } catch (e) { tampered = ''; }
    }
    const r = await turn(conv, threeMice(), '첫 번째 상품 가격', { ref: tampered });
    record('R4 위조', '순서를 바꿔 끼운 토큰 → 상품 없음', !!tampered && ids(r).length === 0,
      `got=${ids(r)} 원래 1위=${order[0]}`);
  }
}

/* ================================================================== *
 *  R5 — 사용자 별칭
 * ================================================================== */
const R5_A = [
  'A 제품 가격 알려줘', 'A 가격', 'A 얼마야', 'A 상품 가격', 'A 지금 사도 돼?',
  'A 다시 보여줘', 'A 제품 현재가', 'A는 얼마야', 'A 최저가', 'A 모델 가격'
];
async function aliasConversation() {
  reset(mice(false));
  const conv = newConv();
  const t1 = await turn(conv, mice(false), 'G304를 A라고 할게', { classify: 'C|G304' });
  const t2 = await turn(conv, buds(), '에어팟 프로 3를 B라고 할게', { classify: 'C|에어팟 프로 3' });
  const t3 = await turn(conv, dyson(), '다이슨 청소기 찾아줘', { classify: 'C|다이슨 청소기' });
  return { conv, t1, t2, t3 };
}
async function groupR5() {
  for (const p of R5_A) {
    const { conv, t1 } = await aliasConversation();
    const r = await turn(conv, dyson(), p);
    record('R5 A = G304 유지', p, t1.body.topProductId === 'G1' && ids(r).length === 1 && ids(r)[0] === 'G1',
      `t1=${t1.body.topProductId} got=${ids(r) || '없음'}`);
  }
  {
    const { conv, t2 } = await aliasConversation();
    const r = await turn(conv, dyson(), 'B 가격 알려줘');
    record('R5 B = AirPods 유지', 'B 가격 알려줘', ids(r).length === 1 && ids(r)[0] === t2.body.topProductId && /^A1/.test(ids(r)[0]),
      `t2=${t2.body.topProductId} got=${ids(r) || '없음'}`);
  }
  {
    const { conv } = await aliasConversation();
    const r = await turn(conv, dyson(), 'C 제품 가격 알려줘');
    record('R5 정의되지 않은 별칭', 'C 제품 → 상품 없음', ids(r).length === 0, `got=${ids(r)}`);
  }
  {
    reset(buds());
    const conv = newConv();
    await turn(conv, buds(), '에어팟 프로 3 찾아줘', { classify: 'C|에어팟 프로 3' });
    const def = await turn(conv, buds(), '이걸 B라고 부를게', { classify: 'A' });
    await turn(conv, dyson(), '다이슨 청소기 찾아줘', { classify: 'C|다이슨 청소기' });
    const r = await turn(conv, dyson(), 'B 가격');
    record('R5 지시어로 정의한 별칭', '이걸 B라고 부를게 → B 가격', ids(r).length === 1 && /^A1/.test(ids(r)[0]),
      `def=${def.status} got=${ids(r) || '없음'}`);
  }
  {
    const { conv } = await aliasConversation();
    await turn(conv, dyson(), '다이슨 V15를 A라고 할게', { classify: 'C|다이슨 V15' });
    const r = await turn(conv, mice(false), 'A 가격');
    record('R5 명시적 재정의', '다이슨 V15를 A라고 할게 → A = D1', ids(r).length === 1 && ids(r)[0] === 'D1', `got=${ids(r)}`);
  }
}

/* ================================================================== *
 *  R6 — 모델 변형 판정기 (rankItems 의 _identityMiss 로 잰다)
 * ================================================================== */
/* [질의, 질의와 정확히 같은 제목, 다른 변형 제목] — 다른 변형은 식별 어긋남이어야 한다. */
const R6_DIFFERENT = [
  ['갤럭시 버즈3', '삼성 갤럭시 버즈3 무선 이어폰', '삼성 갤럭시 버즈3 프로 무선 이어폰'],
  ['갤럭시 버즈3 프로', '삼성 갤럭시 버즈3 프로 무선 이어폰', '삼성 갤럭시 버즈3 무선 이어폰'],
  ['Galaxy Buds3', 'Samsung Galaxy Buds3 Wireless', 'Samsung Galaxy Buds3 Pro Wireless'],
  ['Galaxy Buds3 Pro', 'Samsung Galaxy Buds3 Pro Wireless', 'Samsung Galaxy Buds3 Wireless'],
  ['버즈3', '갤럭시 버즈3 블랙', '갤럭시 버즈3 프로 블랙'],
  ['에어팟 프로 3', 'Apple 에어팟 프로 3 USB-C', 'Apple 에어팟 프로 2 USB-C'],
  ['에어팟 프로 2', 'Apple 에어팟 프로 2 USB-C', 'Apple 에어팟 프로 3 USB-C'],
  ['AirPods Pro 3', 'Apple AirPods Pro 3 USB-C', 'Apple AirPods Pro 2 USB-C'],
  ['AirPods Pro 2', 'Apple AirPods Pro 2 USB-C', 'Apple AirPods Pro 3 USB-C'],
  ['에어팟 4', 'Apple 에어팟 4 USB-C', 'Apple 에어팟 프로 2 USB-C'],
  ['에어팟 프로', 'Apple 에어팟 프로 2 USB-C', 'Apple 에어팟 맥스 USB-C'],
  ['에어팟 맥스', 'Apple 에어팟 맥스 USB-C', 'Apple 에어팟 프로 2 USB-C'],
  ['아이폰 17', 'Apple 아이폰 17 256GB 자급제', 'Apple 아이폰 17 Pro 256GB 자급제'],
  ['아이폰 17', 'Apple 아이폰 17 256GB 자급제', 'Apple 아이폰 17 Pro Max 256GB 자급제'],
  ['아이폰 17 프로', 'Apple 아이폰 17 Pro 256GB 자급제', 'Apple 아이폰 17 Pro Max 256GB 자급제'],
  ['아이폰 17 프로', 'Apple 아이폰 17 Pro 256GB 자급제', 'Apple 아이폰 17 256GB 자급제'],
  ['아이폰 17 프로 맥스', 'Apple 아이폰 17 Pro Max 256GB 자급제', 'Apple 아이폰 17 Pro 256GB 자급제'],
  ['iPhone 17 Pro Max', 'Apple iPhone 17 Pro Max 256GB', 'Apple iPhone 17 Pro 256GB'],
  ['iPhone 17', 'Apple iPhone 17 256GB', 'Apple iPhone 17 Plus 256GB'],
  ['아이폰 17 플러스', 'Apple 아이폰 17 Plus 256GB', 'Apple 아이폰 17 256GB'],
  ['아이폰 16', 'Apple 아이폰 16 128GB', 'Apple 아이폰 17 128GB'],
  ['아이폰 17', 'Apple 아이폰 17 128GB', 'Apple 아이폰 16 128GB'],
  ['아이폰 SE', 'Apple 아이폰 SE 3세대 64GB', 'Apple 아이폰 16 128GB'],
  ['다이슨 V15', '다이슨 V15 무선 청소기', '다이슨 V15 디텍트 무선 청소기'],
  ['다이슨 V15 디텍트', '다이슨 V15 디텍트 무선 청소기', '다이슨 V15 무선 청소기'],
  // (픽스처 정정) 기준 제목은 질의와 «같은» 모델이어야 한다 — "Detect Absolute" 는 그 자체로 다른 판형이다.
  ['Dyson V15 Detect', 'Dyson V15 Detect Cordless', 'Dyson V15 Slim'],
  ['다이슨 V12', '다이슨 V12 무선 청소기', '다이슨 V12 슬림 무선 청소기'],
  ['다이슨 V12 슬림', '다이슨 V12 슬림 무선 청소기', '다이슨 V12 무선 청소기'],
  ['MX Master 3', '로지텍 MX Master 3 무선 마우스', '로지텍 MX Master 3S 무선 마우스'],
  ['MX Master 3S', '로지텍 MX Master 3S 무선 마우스', '로지텍 MX Master 3 무선 마우스'],
  ['로지텍 MX 마스터 3', '로지텍 MX 마스터 3 무선 마우스', '로지텍 MX 마스터 3S 무선 마우스'],
  ['갤럭시 S25', '삼성 갤럭시 S25 256GB 자급제', '삼성 갤럭시 S25 울트라 256GB 자급제'],
  ['갤럭시 S25', '삼성 갤럭시 S25 256GB 자급제', '삼성 갤럭시 S25+ 256GB 자급제'],
  ['갤럭시 S25', '삼성 갤럭시 S25 256GB 자급제', '삼성 갤럭시 S25 FE 256GB 자급제'],
  ['갤럭시 S25 울트라', '삼성 갤럭시 S25 울트라 256GB', '삼성 갤럭시 S25 256GB'],
  ['갤럭시 S25 플러스', '삼성 갤럭시 S25 플러스 256GB', '삼성 갤럭시 S25 256GB'],
  ['Galaxy S25 Ultra', 'Samsung Galaxy S25 Ultra 256GB', 'Samsung Galaxy S25 256GB'],
  ['RTX 5070', '지포스 RTX 5070 12GB 그래픽카드', '지포스 RTX 5070 Ti 16GB 그래픽카드'],
  ['RTX 5070 Ti', '지포스 RTX 5070 Ti 16GB 그래픽카드', '지포스 RTX 5070 12GB 그래픽카드'],
  ['G304', '로지텍 G304 무선 마우스', '로지텍 G304 X SUPERLIGHT 무선 마우스'],
  ['G304 X', '로지텍 G304 X SUPERLIGHT 무선 마우스', '로지텍 G304 무선 마우스'],
  ['맥북 에어 M3', 'Apple 맥북 에어 13 M3', 'Apple 맥북 프로 14 M3'],
  ['맥북 프로 M3', 'Apple 맥북 프로 14 M3', 'Apple 맥북 에어 13 M3'],
  ['아이패드 프로', 'Apple 아이패드 프로 11 M4', 'Apple 아이패드 에어 11 M2'],
  ['아이패드 에어', 'Apple 아이패드 에어 11 M2', 'Apple 아이패드 프로 11 M4'],
  ['아이패드 미니', 'Apple 아이패드 미니 7세대', 'Apple 아이패드 에어 11 M2'],
  ['닌텐도 스위치', '닌텐도 스위치 본체 네온', '닌텐도 스위치 OLED 본체 화이트'],
  ['닌텐도 스위치 OLED', '닌텐도 스위치 OLED 본체 화이트', '닌텐도 스위치 라이트 본체 블루'],
  ['갤럭시 Z 폴드6', '삼성 갤럭시 Z 폴드6 512GB', '삼성 갤럭시 Z 플립6 512GB'],
  ['갤럭시 Z 플립6', '삼성 갤럭시 Z 플립6 512GB', '삼성 갤럭시 Z 폴드6 512GB'],
  ['갤럭시 Z 폴드6', '삼성 갤럭시 Z 폴드6 512GB', '삼성 갤럭시 Z 폴드5 512GB'],
  ['갤럭시 워치7', '삼성 갤럭시 워치7 44mm', '삼성 갤럭시 워치 울트라 47mm'],
  ['갤럭시 워치 울트라', '삼성 갤럭시 워치 울트라 47mm', '삼성 갤럭시 워치7 44mm'],
  // (픽스처 정정) 기준 제목 "PS5 슬림" 은 Slim 판형이라 질의 "PS5" 와 같은 모델이 아니다.
  ['PS5', '소니 PS5 디스크 에디션', '소니 PS5 Pro 디지털 에디션'],
  ['PS5 프로', '소니 PS5 Pro 디지털 에디션', '소니 PS5 슬림 디스크 에디션'],
  ['갤럭시 탭 S10', '삼성 갤럭시 탭 S10 256GB', '삼성 갤럭시 탭 S10 울트라 256GB'],
  ['갤럭시 탭 S10 울트라', '삼성 갤럭시 탭 S10 울트라 256GB', '삼성 갤럭시 탭 S10 256GB'],
  ['픽셀 9', '구글 픽셀 9 128GB', '구글 픽셀 9 Pro 128GB'],
  ['픽셀 9 프로', '구글 픽셀 9 Pro 128GB', '구글 픽셀 9 128GB'],
  ['갤럭시 버즈 FE', '삼성 갤럭시 버즈 FE 무선 이어폰', '삼성 갤럭시 버즈3 무선 이어폰'],
  ['에어팟 프로 3', 'Apple 에어팟 프로 3 USB-C', 'Apple 에어팟 4 USB-C'],
  ['갤럭시 S24 FE', '삼성 갤럭시 S24 FE 256GB', '삼성 갤럭시 S24 256GB'],
  ['아이폰 16 프로 맥스', 'Apple 아이폰 16 Pro Max 256GB', 'Apple 아이폰 16 Pro 256GB'],
  ['아이폰 16e', 'Apple 아이폰 16e 128GB', 'Apple 아이폰 16 128GB'],
  ['아이폰 16', 'Apple 아이폰 16 128GB', 'Apple 아이폰 16e 128GB'],
  ['애플워치 SE', 'Apple 애플워치 SE 2세대 44mm', 'Apple 애플워치 울트라 2 49mm'],
  ['애플워치 울트라 2', 'Apple 애플워치 울트라 2 49mm', 'Apple 애플워치 울트라 49mm'],
  ['에어팟 프로 2', 'Apple 에어팟 프로 2세대 USB-C', 'Apple 에어팟 프로 3세대 USB-C'],
  ['에어팟 프로 3세대', 'Apple 에어팟 프로 3세대 USB-C', 'Apple 에어팟 프로 2세대 USB-C'],
  ['갤럭시 버즈2 프로', '삼성 갤럭시 버즈2 프로 무선 이어폰', '삼성 갤럭시 버즈3 프로 무선 이어폰'],
  ['소니 WH-1000XM5', '소니 WH-1000XM5 무선 헤드폰', '소니 WH-1000XM4 무선 헤드폰'],
  ['소니 WF-1000XM5', '소니 WF-1000XM5 무선 이어폰', '소니 WF-1000XM4 무선 이어폰'],
  ['RTX 4060', '지포스 RTX 4060 8GB', '지포스 RTX 4060 Ti 8GB'],
  ['갤럭시 북4 프로', '삼성 갤럭시 북4 프로 16', '삼성 갤럭시 북4 울트라 16'],
  ['갤럭시 북4', '삼성 갤럭시 북4 15.6', '삼성 갤럭시 북4 프로 16'],
  ['아이폰 15 프로', 'Apple 아이폰 15 Pro 128GB', 'Apple 아이폰 15 128GB'],
  ['Xbox Series X', 'MS Xbox Series X 1TB', 'MS Xbox Series S 512GB'],
  ['갤럭시 S25 엣지', '삼성 갤럭시 S25 엣지 256GB', '삼성 갤럭시 S25 256GB'],
  ['다이슨 V15 디텍트 앱솔루트', '다이슨 V15 디텍트 앱솔루트 무선 청소기', '다이슨 V15 디텍트 무선 청소기'],
  ['에어팟 맥스 2', 'Apple 에어팟 맥스 2 USB-C', 'Apple 에어팟 맥스 USB-C']
];
/* [질의, 기본 제목, 같은 상품의 색상·옵션·SKU 표기] — 식별 어긋남이 되면 안 된다. */
const R6_SAME = [
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 K/DA 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 BK 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 WH 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 블랙 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 화이트 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 LIGHTSPEED 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 910-005286 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 라일락 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '[국내정품] 로지텍 G304 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 BLACK 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 WHITE 무선 게이밍 마우스'],
  ['G304', '로지텍 G304 무선 게이밍 마우스', '로지텍 G304 BLK 무선 게이밍 마우스'],
  ['에어팟 프로 3', 'Apple 에어팟 프로 3 USB-C', 'Apple 에어팟 프로 3 MFHP4KH/A USB-C'],
  ['에어팟 프로 3', 'Apple 에어팟 프로 3 USB-C', 'Apple 에어팟 프로 3 USB-C 화이트 정품'],
  ['아이폰 17', 'Apple 아이폰 17 256GB 자급제', 'Apple 아이폰 17 512GB 자급제 블랙'],
  ['아이폰 17', 'Apple 아이폰 17 256GB 자급제', 'Apple 아이폰 17 256GB 자급제 라벤더'],
  ['다이슨 V15', '다이슨 V15 무선 청소기', '다이슨 V15 (SV47) 무선 청소기'],
  ['갤럭시 버즈3 프로', '삼성 갤럭시 버즈3 프로 무선 이어폰', '삼성 갤럭시 버즈3 프로 SM-R630 실버'],
  ['MX Master 3S', '로지텍 MX Master 3S 무선 마우스', '로지텍 MX Master 3S 그래파이트 무선 마우스'],
  ['갤럭시 S25', '삼성 갤럭시 S25 256GB 자급제', '삼성 갤럭시 S25 SM-S931N 256GB 아이시블루'],
  ['RTX 5070', '지포스 RTX 5070 12GB 그래픽카드', '지포스 RTX 5070 12GB OC 그래픽카드'],
  ['갤럭시 Z 폴드6', '삼성 갤럭시 Z 폴드6 512GB', '삼성 갤럭시 Z 폴드6 512GB 실버 섀도우']
];
async function groupR6() {
  const mk = (id, title, price) => ({ ref: id, productId: id, title, price, mall: '쿠팡', mallId: '쿠팡', vendorItemId: `${id}V`, trust: { level: 'high' } });
  for (const [q, exact, other] of R6_DIFFERENT) {
    const ranked = SI.rankItems([mk('EXACT', exact, 200000), mk('OTHER', other, 100000)], {}, q, { userText: q });
    const o = ranked.find(it => it.productId === 'OTHER');
    const ok = ranked[0] && ranked[0].productId === 'EXACT' && (!o || o._identityMiss === true);
    record('R6 변형 구분 (FN 이면 실패)', `${q} | ${other}`, ok,
      `1위=${ranked[0] && ranked[0].productId} other.identityMiss=${o ? o._identityMiss : '(제거됨)'}`);
  }
  for (const [q, exact, cosmetic] of R6_SAME) {
    const ranked = SI.rankItems([mk('EXACT', exact, 200000), mk('SAME', cosmetic, 100000)], {}, q, { userText: q });
    const s = ranked.find(it => it.productId === 'SAME');
    record('R6 같은 상품 표기 (FP 이면 실패)', `${q} | ${cosmetic}`, !!s && s._identityMiss !== true,
      `same=${s ? `identityMiss=${!!s._identityMiss}` : '(제거됨)'}`);
  }
}

/* ================================================================== *
 *  R7 — 액세서리 유형
 * ================================================================== */
const R7 = [
  ['AC1', ['에어팟 프로 3 충전 케이스 가격', '에어팟 프로3 충전케이스 단품', '에어팟 프로 3 충전 케이스만',
    'AirPods Pro 3 charging case', '에어팟 프로 3 충전 케이스 분실해서 새로', '에어팟 프로 3 충전케이스 정품 가격']],
  ['AC2', ['에어팟 프로 3 보호 케이스', '에어팟 프로 3 실리콘 케이스', '에어팟 프로3 케이스 실리콘으로',
    'AirPods Pro 3 silicone case', '에어팟 프로 3 보호케이스 추천']],
  ['AC3', ['에어팟 프로 3 커버', '에어팟 프로 3 투명 커버', '에어팟 프로3 하드 커버', 'AirPods Pro 3 cover', '에어팟 프로 3 커버 가격']],
  ['AC4', ['에어팟 프로 3 이어팁', '에어팟 프로3 폼팁', '에어팟 프로 3 이어팁 교체', 'AirPods Pro 3 ear tips', '에어팟 프로 3 이어 팁 가격',
    '에어팟 프로 3 폼 이어팁 S M L']],
  ['AC5', ['에어팟 프로 3 스트랩', '에어팟 프로 3 넥스트랩', '에어팟 프로3 분실방지 스트랩', 'AirPods Pro 3 strap', '에어팟 프로 3 목걸이 스트랩']],
  ['AC6', ['에어팟 프로 3 거치대', '에어팟 프로 3 스탠드', '에어팟 프로3 충전 거치대', 'AirPods Pro 3 stand', '에어팟 프로 3 거치대 가격']],
  ['AC7', ['에어팟 프로 3 키링', '에어팟 프로 3 카라비너', '에어팟 프로3 키링 가격', 'AirPods Pro 3 keyring', '에어팟 프로 3 키링 추천']],
  ['AC8', ['에어팟 프로 3 충전 어댑터', '에어팟 프로 3 충전기', '에어팟 프로3 어댑터 20W', 'AirPods Pro 3 charger adapter', '에어팟 프로 3 충전기 가격']],
  ['AC9', ['에어팟 프로 3 케이블', '에어팟 프로 3 충전 케이블', '에어팟 프로3 USB-C 케이블', 'AirPods Pro 3 cable', '에어팟 프로 3 케이블 가격']]
];
async function groupR7() {
  for (const [want, phrases] of R7) {
    for (const q of phrases) {
      const r = await ask(buds(), q);
      record('R7 액세서리 유형', `${q} → ${want}`, topId(r) === want, `top=${topId(r) || '없음'} cards=${ids(r).slice(0, 4)}`);
    }
  }
}

/* ================================================================== *
 *  R8 — 다른 제품군 후보 오염
 * ================================================================== */
const R8_MAIN = [
  '에어팟 프로 3 찾아줘', '에어팟 프로 3 가격', '에어팟 프로3 최저가', '에어팟 프로 3 본체만', 'AirPods Pro 3 price',
  'AirPods Pro 3 찾아줘', '에어팟 프로 3세대 가격', '에어팟프로3 가격', '에어팟 프로 3 지금 사도 돼?', '에어팟 프로 3 정품 가격',
  '에어팟 프로 3 케이스 제외', '에어팟 프로 3 본품 가격', '애플 에어팟 프로 3 가격', 'Apple AirPods Pro 3', '에어팟 프로 3 얼마야',
  '에어팟 프로 3 어디서 사', '에어팟 프로 3 추천해줘', '에어팟 프로 3 화이트 가격', '에어팟 프로 3 USB-C 가격', '에어팟 프로 3 가격 추이',
  '에어팟 프로 3 최저가 알려줘', '에어팟 프로3 정품 본체', '에어팟 프로 3 이어폰 가격', '에어팟 프로 3 사고 싶어', '에어팟 프로 3 현재가',
  '에어팟 프로 3 판매처', '에어팟 프로 3 링크 줘', '에어팟 프로 3 살까', '에어팟 프로 3 역대 최저가', '에어팟 프로 3 가격 확인',
  'airpods pro 3', '에어팟 프로3', '에어팟 프로 3 무선 이어폰', '에어팟 프로 3 블루투스 이어폰', '에어팟 프로 3 노캔 이어폰',
  '에어팟 프로 3 선물용', '에어팟 프로 3 40만원 이하', '에어팟 프로 3 할인', '에어팟 프로 3 특가', '에어팟 프로 3 쿠팡',
  '에어팟 프로 3 정가', '에어팟 프로 3 가격 알려줘', '에어팟 프로3 얼마', 'AirPods Pro 3 earbuds', '에어팟 프로 3 이어버드',
  '에어팟 프로 3 본체 최저가', '에어팟 프로 3 지금 가격', '에어팟 프로 3 구매', '에어팟 프로 3 사려고', '에어팟 프로 3 신품'
];
const R8_COMPARE = [
  'AirPods Pro 3랑 Galaxy Buds3 Pro 비교해줘', '에어팟 프로 3 vs 갤럭시 버즈3 프로',
  '에어팟 프로3와 버즈3 프로 중 뭐가 나아', '에어팟 프로 3랑 갤럭시 버즈3 프로 차이', '에어팟 프로 3 갤럭시 버즈3 프로 비교'
];
/*
 * Codex 와 같은 조건 — 같은 제품군의 본품 목록이 하나뿐이다. 액세서리가 걸러지면
 * 상위 3 자리를 채우는 것은 다른 제품군뿐이라, 오염이 그대로 드러난다.
 */
const budsSingleMain = () => {
  /*
   * ★ 순서가 중요하다. AI 경로는 검색 결과 앞의 MAX_CTX_ITEMS(8)건만 랭킹에 넣는다.
   *   다른 제품군을 뒤에 두면 그 컷에서 잘려 오염이 «보이지 않는» 것처럼 측정된다
   *   (실측: 12건 픽스처에서 버즈가 컷 밖으로 밀려 거짓 PASS 였다). 실제 검색
   *   결과처럼 섞어 둔다.
   */
  const by = Object.fromEntries(buds().map(it => [it.productId, it]));
  return ['A1', 'X1', 'AC1', 'X2', 'AC2', 'AC3', 'AC4', 'AC7'].map(id => by[id]);
};
async function groupR8() {
  for (const q of R8_MAIN) {
    const r = await ask(budsSingleMain(), q);
    const top3 = ids(r).slice(0, 3);
    record('R8 본품 질의 상위 3에 다른 제품군 없음', q, !top3.some(id => /^X/.test(id)) && top3.length > 0,
      `top3=${top3}`);
  }
  for (const q of R8_COMPARE) {
    const r = await ask(budsSingleMain(), q);
    const all = ids(r);
    record('R8 (대조) 비교 질의는 두 제품군 모두 남긴다', q, all.some(id => /^A1/.test(id)) && all.some(id => /^X/.test(id)),
      `cards=${all}`);
  }
}

/* ================================================================== *
 *  R9 — 세션 결속
 * ================================================================== */
async function groupR9() {
  const G = 'R9 세션 결속';
  /* 로그인 사용자 */
  {
    reset(mice(false));
    const conv = newConv();
    stub.email = 'alice@seosa.test';
    const t1 = await turn(conv, mice(false), 'G304 가격 알려줘');
    const ref = conv.ref;
    const same = await turn(conv, mice(false), '아까 추천한 그 상품 가격 알려줘', { ref });
    record(G, '로그인 · 같은 계정 → 수락', ids(same).length === 1 && ids(same)[0] === t1.body.topProductId, `got=${ids(same)}`);
    stub.email = 'mallory@seosa.test';
    const other = await turn(newConv(), mice(false), '아까 추천한 그 상품 가격 알려줘', { ref });
    record(G, '로그인 · 다른 계정이 재사용 → 거부', ids(other).length === 0, `got=${ids(other)}`);
    stub.guest = true;
    const asGuest = await call({ question: '아까 추천한 그 상품 가격 알려줘', prevTopRef: ref, chatHistory: [], view: { source: 'none' } });
    record(G, '로그인 토큰을 게스트가 재사용 → 거부', ids(asGuest).length === 0, `got=${ids(asGuest)}`);
    stub.guest = false;
  }
  /* 게스트 */
  {
    reset(mice(false));
    stub.guest = true;
    const b1 = browser();
    const conv = newConv(b1);
    const t1 = await turn(conv, mice(false), 'G304 가격 알려줘');
    const ref = conv.ref;
    const same = await turn(conv, mice(false), '아까 추천한 그 상품 가격 알려줘', { ref });
    record(G, '게스트 · 같은 브라우저 → 수락', ids(same).length === 1 && ids(same)[0] === t1.body.topProductId,
      `got=${ids(same)} cookie=${b1.jar.size}`);
    const b2 = browser();
    const other = await turn(newConv(b2), mice(false), '아까 추천한 그 상품 가격 알려줘', { ref });
    record(G, '게스트 · 다른 브라우저가 재사용 → 거부', ids(other).length === 0, `got=${ids(other)}`);
    const b3 = browser();
    b3.jar.set('seosa_ai_sid', 'forged-session.AAAAAAAAAAAAAAAAAAAAAA');
    const forged = await turn(newConv(b3), mice(false), '아까 추천한 그 상품 가격 알려줘', { ref });
    record(G, '게스트 · 위조 세션 쿠키 → 거부', ids(forged).length === 0, `got=${ids(forged)}`);
    const b4 = browser();
    for (const [k, v] of b1.jar) b4.jar.set(k, v.replace(/.$/, ch => (ch === 'A' ? 'B' : 'A')));
    const flipped = await turn(newConv(b4), mice(false), '아까 추천한 그 상품 가격 알려줘', { ref });
    record(G, '게스트 · 세션 쿠키 서명 1글자 변조 → 거부', b1.jar.size > 0 && ids(flipped).length === 0, `got=${ids(flipped)}`);
    stub.guest = false;
    const asUser = await call({ question: '아까 추천한 그 상품 가격 알려줘', prevTopRef: ref, chatHistory: [], view: { source: 'none' } });
    record(G, '게스트 토큰을 로그인 사용자가 재사용 → 거부', ids(asUser).length === 0, `got=${ids(asUser)}`);
  }
  /* 세션 쿠키는 HttpOnly · SameSite 여야 한다(스크립트가 읽어 다른 곳으로 옮기지 못하게). */
  {
    reset(mice(false));
    stub.guest = true;
    const r = await call({ question: 'G304 가격 알려줘', chatHistory: [], view: { source: 'none' } });
    const raw = [].concat(r.headers['set-cookie'] || []).join(' | ');
    record(G, '세션 쿠키는 HttpOnly · SameSite', /seosa_ai_sid=/.test(raw) && /HttpOnly/i.test(raw) && /SameSite=/i.test(raw),
      `set-cookie=${raw || '(없음)'}`);
    stub.guest = false;
  }
}

/* ================================================================== *
 *  R10 — 서명 검증 보호
 * ================================================================== */
function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function unb64(s) { return JSON.parse(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
function groupR10() {
  const G = 'R10 서명 검증';
  const has = typeof AC.sessionBinding === 'function';
  const sessA = has ? AC.sessionBinding({ email: 'alice@seosa.test' }) : 'A';
  const sessB = has ? AC.sessionBinding({ email: 'bob@seosa.test' }) : 'B';
  const item = { productId: 'G1', vendorItemId: 'G1V', mallId: '쿠팡' };
  const now = Date.now();
  const tok = AC.createRecommendationRef(item, now, { session: sessA });
  const v = (t, s, at) => AC.verifyRecommendationRef(t, at === undefined ? now : at, { session: s === undefined ? sessA : s });
  record(G, 'sessionBinding API 가 있다', has, '');
  const okv = v(tok);
  record(G, '정상 · 같은 세션 → 수락', !!okv && okv.productId === 'G1' && okv.vendorItemId === 'G1V', JSON.stringify(okv));
  record(G, '다른 세션 → 거부', v(tok, sessB) === null, '');
  record(G, '세션 없이 검증 → 거부', AC.verifyRecommendationRef(tok, now) === null, '');
  const [pre, pay, sig] = String(tok).split('.');
  const flip = s => s.slice(0, 5) + (s[5] === 'A' ? 'B' : 'A') + s.slice(6);
  record(G, 'payload 1글자 변조 → 거부', v(`${pre}.${flip(pay)}.${sig}`) === null, '');
  record(G, 'signature 1글자 변조 → 거부', v(`${pre}.${pay}.${flip(sig)}`) === null, '');
  record(G, 'prefix 변조 → 거부', v(`airX.${pay}.${sig}`) === null, '');
  record(G, '잘린 토큰 → 거부', v(String(tok).slice(0, -4)) === null, '');
  let d = null;
  try { d = unb64(pay); } catch (e) { d = null; }
  const reenc = mut => { if (!d) return 'x.y.z'; const c = JSON.parse(JSON.stringify(d)); mut(c); return `${pre}.${b64(c)}.${sig}`; };
  record(G, 'productId 바꿔 재인코딩 → 거부', v(reenc(c => { c.p = 'G2'; })) === null, '');
  record(G, 'vendorItemId 바꿔 재인코딩 → 거부', v(reenc(c => { c.v = 'G2V'; })) === null, '');
  record(G, '만료 시각 늘려 재인코딩 → 거부', v(reenc(c => { c.exp = (c.exp || now) + 86400e3; })) === null, '');
  record(G, '세션 필드를 다른 값으로 → 거부', v(reenc(c => { c.s = sessB; })) === null, '');
  record(G, '세션 필드 삭제 → 거부', v(reenc(c => { delete c.s; })) === null, '');
  record(G, '목록 항목 바꿔 재인코딩 → 거부', v(reenc(c => { c.l = [['G2', 'G2V', '쿠팡']]; })) === null, '');
  record(G, '별칭 바꿔 재인코딩 → 거부', v(reenc(c => { c.a = { A: ['G2', 'G2V', '쿠팡'] }; })) === null, '');
  record(G, '만료된 토큰 → 거부', v(AC.createRecommendationRef(item, now - AC.REF_TTL_MS - 60e3, { session: sessA })) === null, '');
  record(G, '미래에 발급된 토큰 → 거부', v(AC.createRecommendationRef(item, now + 10 * 60e3, { session: sessA })) === null, '');
  const prev = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'some-other-server-key';
  const foreign = AC.createRecommendationRef(item, now, { session: sessA });
  process.env.AUTH_SECRET = prev;
  record(G, '다른 서버 키로 서명한 토큰 → 거부', v(foreign) === null, '');
}

(async () => {
  console.log('=== PR #128 2차 — Codex 레드팀 결함 재현·회귀 (완전 오프라인) ===');
  await groupR1();
  await groupR2();
  await groupR4();
  await groupR5();
  await groupR6();
  await groupR7();
  await groupR8();
  await groupR9();
  groupR10();

  console.log('\n=== 공격군별 ===');
  let total = 0;
  groups.forEach((g, k) => { total += g.pass + g.fail; console.log(`  ${g.fail ? 'FAIL' : 'PASS'}  ${k}: ${g.pass} PASS / ${g.fail} FAIL`); });
  console.log(`\n검사 ${total}건`);
  console.log(`=== 결과: PASS ${pass} / FAIL ${fail} ===`);
  if (fail) {
    const limit = process.env.SHOW_ALL ? failures.length : 60;
    console.log(`실패(앞 ${limit}건):`);
    failures.slice(0, limit).forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
