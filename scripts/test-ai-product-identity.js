#!/usr/bin/env node
/**
 * 상품 식별·가격 귀속·대화 참조 회귀 테스트 — 완전 오프라인(외부 호출 0회).
 *
 * ── 왜 이 파일이 따로 있는가 ────────────────────────────────────
 *
 * test-ai-pipeline.js 는 "파이프라인이 이어져 있는가"를 본다. 이 파일이
 * 보는 것은 하나뿐이다.
 *
 *   SEOSA 가 «어떤 상품» 을 말하고 있는지 끝까지 유지하고,
 *   «그 상품» 의 가격만 말하는가.
 *
 * 운영 soak 에서 실제로 재현된 네 가지를 고정한다.
 *
 *   A  일반 G304 를 요구했는데 G304 X SUPERLIGHT 가 선택되고,
 *      그 109,000원이 일반 G304 의 가격처럼 답변됐다.
 *   B  «본품만» 을 요구했는데 충전 케이스·보호 커버·호환 액세서리가
 *      후보에 섞이고 최종 추천까지 올라왔다.
 *   C  확정된 상품을 «그거/아까 거/첫 번째» 로 가리켰을 때 문자열 유사도로
 *      새 상품이 재선택됐다.
 *   D  생성 실패·타임아웃·깨진 JSON·grounding 거절에서 전체 API 가 깨지거나
 *      실패 상태가 남았다.
 *
 * ── 이 파일이 지키는 선 ─────────────────────────────────────────
 *
 *   · 특정 상품명을 통과시키는 검사를 쓰지 않는다. 검사 기준은 언제나
 *     productId/vendorItemId 라는 결정적 식별자다 — 정규식으로 답변 문장을
 *     훑어 "맞은 것 같다"고 세지 않는다(그 방식이 과거에 정확도를 과대평가했다).
 *   · G304 X 와 액세서리를 «전역 차단» 하지 않는다. 사용자가 그것을
 *     지목하면 그것이 정답이어야 한다 — 그 반대 방향도 함께 검사한다.
 */
'use strict';

/*
 * 오프라인 대역은 scripts/_ai-offline-harness.js 가 갖고 있다.
 * ★ api/ai.js 보다 먼저 require 되어야 한다 — 그 모듈이 그 순서를 보장한다.
 */
const H = require('./_ai-offline-harness.js');
const { stub, call, reset, kstToday, daysAgo } = H;

/* ── 검사 도구 ────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ── 픽스처 ──────────────────────────────────────────────────── */

/*
 * G304 — 같은 모델코드를 공유하지만 다른 상품인 세 개.
 *
 *   G1  일반(기본) G304                39,000원
 *   G2  G304 X SUPERLIGHT             109,000원
 *   G3  G PRO X SUPERLIGHT 2 (다른 제품군) 159,000원
 */
function mouseItems() {
  return [
    { title: '로지텍 G304 LIGHTSPEED 무선 게이밍 마우스, 블랙', lprice: 39000,
      link: 'https://l.c/g1', image: '', mall: '쿠팡', productId: 'G1',
      vendorItemId: 'V-G1', isCoupang: true, oprice: 45000, savePct: 13 },
    { title: '로지텍 G304 X SUPERLIGHT 무선 게이밍 마우스, 화이트', lprice: 109000,
      link: 'https://l.c/g2', image: '', mall: '쿠팡', productId: 'G2',
      vendorItemId: 'V-G2', isCoupang: true, oprice: 129000, savePct: 16 },
    { title: '로지텍 G PRO X SUPERLIGHT 2 무선 게이밍 마우스', lprice: 159000,
      link: 'https://l.c/g3', image: '', mall: '쿠팡', productId: 'G3',
      vendorItemId: 'V-G3', isCoupang: true, oprice: 159000, savePct: 0 }
  ];
}

/*
 * AirPods Pro 3 — 본품 하나와 액세서리 넷, 그리고 무관한 상품 하나.
 */
function budsItems() {
  return [
    { title: 'Apple 에어팟 프로 3 USB-C 블루투스 이어폰', lprice: 329000,
      link: 'https://l.c/a1', image: '', mall: '쿠팡', productId: 'A1',
      vendorItemId: 'V-A1', isCoupang: true, oprice: 359000, savePct: 8 },
    { title: '애플 에어팟 프로 3 충전 케이스 단품', lprice: 89000,
      link: 'https://l.c/a2', image: '', mall: '쿠팡', productId: 'A2',
      vendorItemId: 'V-A2', isCoupang: true, oprice: 89000, savePct: 0 },
    { title: '에어팟 프로 3 호환 실리콘 보호 케이스 키링', lprice: 4900,
      link: 'https://l.c/a3', image: '', mall: '쿠팡', productId: 'A3',
      vendorItemId: 'V-A3', isCoupang: true, oprice: 4900, savePct: 0 },
    { title: '에어팟 프로 3 전용 투명 커버 거치대', lprice: 3200,
      link: 'https://l.c/a4', image: '', mall: '쿠팡', productId: 'A4',
      vendorItemId: 'V-A4', isCoupang: true, oprice: 3200, savePct: 0 },
    { title: '에어팟 프로 3 호환 이어팁 교체용 S M L', lprice: 7900,
      link: 'https://l.c/a5', image: '', mall: '쿠팡', productId: 'A5',
      vendorItemId: 'V-A5', isCoupang: true, oprice: 7900, savePct: 0 }
  ];
}

function accessoryOnlyItems() {
  return budsItems().filter(it => it.productId !== 'A1');
}

const topCard = r => ((r.body.items || [])[0] || {});
const cardIds = r => (r.body.items || []).map(c => c.productId).join(',');

/* ================================================================== *
 *  A — 모델 변형(일반 G304 ↔ G304 X SUPERLIGHT)
 * ================================================================== */
async function groupA() {
  console.log('\n[A] 모델 변형 식별 — 일반 G304 ↔ G304 X SUPERLIGHT');

  /* A-1 — 일반형을 물었고, 두 후보가 모두 검색 결과에 있다. */
  reset(mouseItems());
  stub.llm.answer = '결론부터, 로지텍 G304 LIGHTSPEED 를 권합니다. 현재 39,000원입니다.';
  let r = await call({ question: 'G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(r.status === 200, 'A-1 HTTP 200', String(r.status));
  ok(topCard(r).productId === 'G1',
    '★ A-1 일반 G304 요구 → 일반 G304 가 1위', `top=${topCard(r).productId} cards=${cardIds(r)}`);
  ok(r.body.topProductId === 'G1',
    '★ A-1 서버 결정의 1위도 일반 G304', String(r.body.topProductId));

  /* A-2 — "X 말고" 라고 명시했다. */
  reset(mouseItems());
  stub.llm.answer = '로지텍 G304 LIGHTSPEED 가 39,000원입니다.';
  r = await call({ question: 'G304 X 말고 일반 G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(topCard(r).productId === 'G1',
    '★ A-2 "G304 X 말고" → X 가 선택되지 않는다', `top=${topCard(r).productId} cards=${cardIds(r)}`);
  ok(r.body.topProductId !== 'G2', 'A-2 결정의 1위도 X 가 아니다', String(r.body.topProductId));

  /* A-2b — 영어로 같은 요구. */
  reset(mouseItems());
  stub.llm.classify = 'D|Logitech G304';
  stub.llm.answer = 'Logitech G304 LIGHTSPEED is 39,000원.';
  r = await call({ question: 'Logitech G304 standard model only, not the X', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(topCard(r).productId === 'G1',
    '★ A-2b 영어 "standard only, not the X" → 일반형', `top=${topCard(r).productId} cards=${cardIds(r)}`);

  /* A-2c — SUPERLIGHT 를 빼 달라고 했다. */
  reset(mouseItems());
  stub.llm.classify = 'D|G304';
  stub.llm.answer = '로지텍 G304 LIGHTSPEED 가 39,000원입니다.';
  r = await call({ question: 'SUPERLIGHT 말고 G304 보여줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(topCard(r).productId === 'G1',
    '★ A-2c "SUPERLIGHT 말고" → 일반형', `top=${topCard(r).productId} cards=${cardIds(r)}`);

  /*
   * A-3 — 일반 G304 에 X 의 가격을 붙인 답변은 통과하지 못한다.
   *
   * 폐기 뒤 서버가 조립하는 글은 후보 목록을 그대로 적으므로 109,000원이라는
   * 글자 자체는 남는다(그 상품 자리에서). 여기서 재는 것은 «모델이 쓴 잘못된
   * 귀속 문장이 사용자에게 나가지 않는가» 다.
   */
  reset(mouseItems());
  stub.llm.answer = '로지텍 G304 LIGHTSPEED 무선 게이밍 마우스는 현재 109,000원입니다.';
  r = await call({ question: 'G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(r.body.degraded === true && !/LIGHTSPEED[^.]*109,000/.test(r.body.text),
    '★ A-3 다른 모델(109,000원)의 가격을 일반 G304 에 붙인 답은 폐기된다',
    `degraded=${r.body.degraded} text=${String(r.body.text).slice(0, 60)}`);
  ok(/39,000/.test(String(r.body.text)),
    'A-3 폐기 뒤에도 일반 G304 의 실제 가격은 전한다', String(r.body.text).slice(0, 80));

  /* A-3b — 반대로 올바른 귀속은 살아 있어야 한다. */
  reset(mouseItems());
  stub.llm.classify = 'D|G304 X SUPERLIGHT';
  stub.llm.answer = '로지텍 G304 X SUPERLIGHT 무선 게이밍 마우스는 현재 109,000원입니다.';
  r = await call({ question: 'G304 X SUPERLIGHT 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(r.body.degraded !== true && /109,000/.test(r.body.text),
    '★ A-3b X 의 가격을 X 에 붙인 올바른 답은 유지된다',
    `degraded=${r.body.degraded} text=${String(r.body.text).slice(0, 60)}`);

  /* A-4 — X 를 명시적으로 요구하면 X 가 정답이다 (전역 차단 금지). */
  reset(mouseItems());
  stub.llm.classify = 'D|G304 X SUPERLIGHT';
  stub.llm.answer = '로지텍 G304 X SUPERLIGHT 가 109,000원입니다.';
  r = await call({ question: 'G304 X SUPERLIGHT 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(topCard(r).productId === 'G2',
    '★ A-4 X 를 지목하면 X 가 1위 (X 전역 차단 금지)', `top=${topCard(r).productId} cards=${cardIds(r)}`);

  /* A-5 — 일반형 후보가 아예 없으면 X 를 일반형으로 둘러대지 않는다. */
  reset(mouseItems().filter(it => it.productId !== 'G1'));
  stub.llm.answer = '로지텍 G304 X SUPERLIGHT 가 109,000원입니다.';
  r = await call({ question: 'G304 기본형 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(topCard(r).productId !== 'G1', 'A-5 없는 상품을 만들어내지 않는다', cardIds(r));
  ok(!/39,000/.test(String(r.body.text)),
    '★ A-5 일반형 후보가 없으면 일반형 가격을 지어내지 않는다', String(r.body.text).slice(0, 80));
}

/* ================================================================== *
 *  B — 본품 ↔ 액세서리
 * ================================================================== */
async function groupB() {
  console.log('\n[B] 본품 ↔ 액세서리 — AirPods Pro 3');

  /*
   * B-1 — "본체만 / 케이스 제외"
   *
   * ★ 분류기 스텁이 사용자 문장을 거의 그대로 검색어로 돌려주게 둔다.
   *   작은 모델이 실제로 그렇게 행동하고, 그때 «케이스» 가 검색어에 남아
   *   액세서리 검색으로 읽히는 것이 바로 재현된 사고다. production 의
   *   cleanQuery 가 그것을 지우는지 함께 재야 한다.
   */
  reset(budsItems());
  stub.llm.classify = 'D|에어팟 프로 3 본체만 케이스 제외';
  stub.llm.answer = 'Apple 에어팟 프로 3 USB-C 블루투스 이어폰이 329,000원입니다.';
  let r = await call({ question: '에어팟 프로 3 본체만. 케이스 제외.', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(r.status === 200, 'B-1 HTTP 200', String(r.status));
  ok(topCard(r).productId === 'A1',
    '★ B-1 "본체만·케이스 제외" → 본품이 1위', `top=${topCard(r).productId} cards=${cardIds(r)}`);
  ok(!(r.body.items || []).slice(0, 1).some(c => ['A2', 'A3', 'A4', 'A5'].includes(c.productId)),
    'B-1 액세서리가 최종 추천 자리에 오지 않는다', cardIds(r));

  /* B-1b — 호환품 제외 */
  reset(budsItems());
  stub.llm.classify = 'D|에어팟 프로 3';
  stub.llm.answer = 'Apple 에어팟 프로 3 USB-C 블루투스 이어폰이 329,000원입니다.';
  r = await call({ question: '에어팟 프로3 정품 이어폰만, 호환품 제외', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(topCard(r).productId === 'A1',
    '★ B-1b "호환품 제외" → 본품이 1위', `top=${topCard(r).productId} cards=${cardIds(r)}`);

  /* B-1c — 영어 본품 요구 */
  reset(budsItems());
  stub.llm.classify = 'D|AirPods Pro 3';
  stub.llm.answer = 'Apple 에어팟 프로 3 USB-C 블루투스 이어폰이 329,000원입니다.';
  r = await call({ question: 'AirPods Pro 3 earbuds only, no case', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(topCard(r).productId === 'A1',
    '★ B-1c 영어 "earbuds only, no case" → 본품이 1위', `top=${topCard(r).productId} cards=${cardIds(r)}`);

  /* B-2 — 액세서리만 있을 때 본품 가격으로 둘러대지 않는다. */
  reset(accessoryOnlyItems());
  stub.llm.answer = '에어팟 프로 3 는 현재 89,000원입니다.';
  r = await call({ question: '에어팟 프로 3 본체만 얼마야', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(r.status === 200, 'B-2 HTTP 200', String(r.status));
  ok(!/89,000|4,900|3,200|7,900/.test(String(r.body.text)),
    '★ B-2 본품 후보가 없으면 액세서리 가격을 본품 가격으로 말하지 않는다',
    String(r.body.text).slice(0, 100));
  ok(topCard(r).productId !== 'A2',
    'B-2 액세서리를 본품 추천 자리에 올리지 않는다', cardIds(r));

  /* B-3 — 사용자가 케이스를 명시적으로 요구하면 케이스가 정답이다. */
  reset(budsItems());
  stub.llm.classify = 'D|에어팟 프로 3 케이스';
  stub.llm.answer = '애플 에어팟 프로 3 충전 케이스 단품이 89,000원입니다.';
  r = await call({ question: '에어팟 프로 3 케이스 가격', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(['A2', 'A3', 'A4'].includes(topCard(r).productId),
    '★ B-3 케이스를 지목하면 케이스가 1위 (액세서리 전역 차단 금지)',
    `top=${topCard(r).productId} cards=${cardIds(r)}`);

  /* B-4 — 무관한 상품은 본품 자리에 오지 않는다. */
  reset(budsItems().concat([{ title: '삼성 갤럭시 버즈3 프로 무선 이어폰', lprice: 199000,
    link: 'https://l.c/x1', image: '', mall: '쿠팡', productId: 'X1',
    vendorItemId: 'V-X1', isCoupang: true, oprice: 219000, savePct: 9 }]));
  stub.llm.classify = 'D|AirPods Pro 3';
  stub.llm.answer = 'Apple 에어팟 프로 3 USB-C 블루투스 이어폰이 329,000원입니다.';
  r = await call({ question: 'AirPods Pro 3 price', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(topCard(r).productId !== 'X1',
    '★ B-4 다른 브랜드 제품이 1위로 오지 않는다', `top=${topCard(r).productId} cards=${cardIds(r)}`);
}

/* ================================================================== *
 *  C — 대화 참조 (그거 / 아까 거 / 첫 번째 / A)
 * ================================================================== */
async function groupC() {
  console.log('\n[C] 대화 참조 — 확정된 상품을 끝까지 유지한다');

  /* C-1 — 1턴에서 일반 G304 를 확정하고, 2턴에서 "그거" 로 가리킨다. */
  reset(mouseItems());
  stub.llm.classify = 'C|로지텍 G304 기본형';
  stub.llm.answer = '로지텍 G304 LIGHTSPEED 를 권합니다. 현재 39,000원입니다.';
  let t1 = await call({ question: '로지텍 G304 기본형 찾아줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(t1.body.topProductId === 'G1', 'C-1 turn1 일반 G304 확정', String(t1.body.topProductId));
  ok(!!t1.body.topRecommendationRef, 'C-1 turn1 서명 참조가 발급된다',
    t1.body.topRecommendationRef ? 'ref 있음' : 'ref 없음');

  const hist1 = [
    { role: 'user', text: '로지텍 G304 기본형 찾아줘' },
    { role: 'assistant', text: t1.body.text, sig: t1.body.turnSig }
  ];

  stub.llm.classify = 'D|로지텍 G304 기본형';
  stub.llm.answer = '로지텍 G304 LIGHTSPEED 는 현재 39,000원입니다.';
  let t2 = await call({
    question: '그거 가격 알려줘', contextProducts: [], chatHistory: hist1,
    prevTopRef: t1.body.topRecommendationRef, prevTop: t1.body.topProductId,
    view: { source: 'none' }
  });
  ok(t2.status === 200, 'C-1 turn2 HTTP 200', String(t2.status));
  ok(t2.body.topProductId === 'G1' || topCard(t2).productId === 'G1',
    '★ C-1 "그거 가격" → 같은 상품(G1) 을 유지한다',
    `top=${t2.body.topProductId} cards=${cardIds(t2)}`);
  ok(topCard(t2).productId !== 'G2' && !/109,000/.test(String(t2.body.text)),
    '★ C-1 "그거 가격" 이 G304 X 로 바뀌지 않는다',
    `cards=${cardIds(t2)} text=${String(t2.body.text).slice(0, 60)}`);
  ok((t2.body.items || []).every(c => c.productId === 'G1') || !(t2.body.items || []).length,
    'C-1 참조 해결 시 다른 상품 카드를 끼워 넣지 않는다', cardIds(t2));

  /* C-1b — 같은 요구의 다른 표현들. */
  for (const phrase of ['아까 거 가격 알려줘', '아까꺼 얼마야', '그 상품 가격 알려줘',
    '방금 말한 제품 가격', '아까 추천한 거 가격']) {
    reset(mouseItems());
    stub.llm.classify = 'D|로지텍 G304 기본형';
    stub.llm.answer = '로지텍 G304 LIGHTSPEED 는 현재 39,000원입니다.';
    // 카탈로그에 두 후보 모두 들어 있어야 "다른 것을 고를 수도 있었다"가 성립한다.
    await call({ question: '로지텍 G304 기본형 찾아줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
    const ref = t1.body.topRecommendationRef;
    const rr = await call({
      question: phrase, contextProducts: [], chatHistory: hist1,
      prevTopRef: ref, prevTop: 'G1', view: { source: 'none' }
    });
    ok(topCard(rr).productId !== 'G2' && !/109,000/.test(String(rr.body.text)),
      `★ C-1b "${phrase}" 가 다른 모델로 바뀌지 않는다`,
      `cards=${cardIds(rr)} text=${String(rr.body.text).slice(0, 50)}`);
  }

  /* C-2 — 사용자가 명시적으로 X 로 바꾸면 전환되어야 한다. */
  reset(mouseItems());
  stub.llm.classify = 'D|G304 X SUPERLIGHT';
  stub.llm.answer = '로지텍 G304 X SUPERLIGHT 는 109,000원입니다.';
  const t3 = await call({
    question: '아까 거 말고 G304 X 보여줘', contextProducts: [], chatHistory: hist1,
    prevTopRef: t1.body.topRecommendationRef, prevTop: 'G1', view: { source: 'none' }
  });
  ok(topCard(t3).productId === 'G2',
    '★ C-2 사용자가 명시적으로 바꾸면 G304 X 로 전환된다',
    `top=${topCard(t3).productId} cards=${cardIds(t3)}`);

  /* C-3 — 참조가 없거나 변조됐으면 비슷한 상품을 임의로 고르지 않는다. */
  reset(mouseItems());
  stub.llm.classify = 'D|로지텍 G304';
  stub.llm.answer = '로지텍 G304 X SUPERLIGHT 는 109,000원입니다.';
  const t4 = await call({
    question: '아까 추천한 그 상품 가격 알려줘', contextProducts: [], chatHistory: hist1,
    prevTopRef: 'air2.dGFtcGVyZWQ.AAAA', prevTop: 'G1', view: { source: 'none' }
  });
  ok(t4.status === 200, 'C-3 HTTP 200', String(t4.status));
  ok(!(t4.body.items || []).length && !/109,000|39,000/.test(String(t4.body.text)),
    '★ C-3 서명이 변조된 참조로는 상품·가격을 말하지 않는다',
    `cards=${cardIds(t4)} text=${String(t4.body.text).slice(0, 80)}`);

  /* C-4 — 사용자가 "A" 라고 이름 붙인 상품. 검증할 수 없으면 아무 상품도 고르지 않는다. */
  reset(mouseItems());
  stub.llm.classify = 'D|A 제품';
  stub.llm.answer = '로지텍 G304 X SUPERLIGHT 는 109,000원입니다.';
  const t5 = await call({
    question: 'A 제품 가격 다시 알려줘', contextProducts: [], chatHistory: hist1,
    view: { source: 'none' }
  });
  ok(t5.status === 200, 'C-4 HTTP 200', String(t5.status));
  ok(!/109,000/.test(String(t5.body.text)),
    '★ C-4 검증할 수 없는 별칭 참조로 다른 상품의 가격을 말하지 않는다',
    String(t5.body.text).slice(0, 80));

  /* C-5 — 참조가 유효하면 productId·vendorItemId 가 모두 유지된다. */
  reset(mouseItems());
  stub.llm.classify = 'C|로지텍 G304 기본형';
  stub.llm.answer = '로지텍 G304 LIGHTSPEED 를 권합니다. 현재 39,000원입니다.';
  const s1 = await call({ question: '로지텍 G304 기본형 찾아줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  stub.llm.answer = '로지텍 G304 LIGHTSPEED 는 현재 39,000원입니다.';
  const s2 = await call({
    question: '아까 추천한 그 상품 가격 알려줘', contextProducts: [], chatHistory: [
      { role: 'user', text: '로지텍 G304 기본형 찾아줘' },
      { role: 'assistant', text: s1.body.text, sig: s1.body.turnSig }
    ],
    prevTopRef: s1.body.topRecommendationRef, prevTop: s1.body.topProductId, view: { source: 'none' }
  });
  const kept = (s2.body.items || [])[0];
  ok(!!kept && kept.productId === 'G1' && kept.vendorItemId === 'V-G1',
    '★ C-5 유효한 참조는 productId·vendorItemId 를 그대로 되살린다',
    kept ? `${kept.productId}/${kept.vendorItemId}` : '카드 없음');
}

/* ================================================================== *
 *  D — 생성 실패 / fallback
 * ================================================================== */
async function groupD() {
  console.log('\n[D] 생성 실패 · fallback · 자동 복구');

  const cases = [
    ['provider 5xx', () => { stub.llm.answerStatus = 500; }],
    ['rate limit 429', () => { stub.llm.answerStatus = 429; }],
    ['network 오류', () => { stub.llm.answerMode = 'network'; }],
    ['깨진 JSON', () => { stub.llm.answerMode = 'malformed'; }],
    ['형식 다른 본문', () => { stub.llm.answerMode = 'non-json-body'; }],
    ['빈 생성', () => { stub.llm.answer = ''; }]
  ];

  for (const [label, apply] of cases) {
    reset(mouseItems());
    apply();
    const r = await call({ question: 'G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
    ok(r.status === 200, `D-${label}: API 가 깨지지 않는다 (200)`, String(r.status));
    ok(!!String(r.body.text || '').trim(), `D-${label}: 빈 답변을 내보내지 않는다`,
      String(r.body.text || '').slice(0, 50));
    ok(!r.body.error, `D-${label}: 업스트림 오류 원문이 새지 않는다`, String(r.body.error || ''));
    // 찾아 놓은 상품은 버리지 않는다. 그리고 그 상품은 여전히 올바른 상품이어야 한다.
    if ((r.body.items || []).length) {
      ok(topCard(r).productId === 'G1',
        `★ D-${label}: fallback 에서도 상품 식별이 유지된다`, `top=${topCard(r).productId}`);
    }
  }

  /* D-timeout */
  reset(mouseItems());
  stub.llm.answerMode = 'hang';
  const rT = await call({ question: 'G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(rT.status === 200 && !!String(rT.body.text || '').trim(),
    'D-timeout: 느린 생성에서도 안전한 답이 나간다', String(rT.status));

  /*
   * D-recovery — 실패 상태가 «남지» 않는다.
   *
   * ★ 바로 다음 요청이 반드시 정상이어야 한다고 재지 않는다. 그렇게 재면
   *   틀린 것을 재는 것이다. api/_llm.js 는 실패한 provider:model 에 짧은
   *   cooldown 을 건다(네트워크·5xx·timeout 60초, 쿼터 15분, 인증 10분).
   *   사슬의 모델이 전부 같은 이유로 죽으면 그 창 동안은 degraded 가 맞다 —
   *   죽은 공급자를 매 요청 다시 때리는 것이 고장이다.
   *
   *   여기서 재는 것은 두 가지다.
   *     1) 실패를 응답 캐시에 넣지 않는다 (넣으면 복구가 TTL 만큼 늦어진다)
   *     2) cooldown 이 지나면 같은 질문이 그대로 정상 답변으로 돌아온다
   *   cooldown 경과는 _llm._internal._reset() 로 대신한다 — 그 함수가 지우는
   *   것이 바로 cooldown 표(providerDead)다.
   */
  const llm = require('../api/_llm');
  reset(mouseItems());
  stub.llm.answerStatus = 500;
  const bad = await call({ question: 'G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(bad.body.degraded === true, 'D-recovery: 실패 턴은 degraded 로 나간다', `degraded=${bad.body.degraded}`);
  const afterFail = llm.stats();
  ok(afterFail.failures > 0 && afterFail.cacheHits === 0,
    '★ D-recovery: 실패를 응답 캐시에 넣지 않는다',
    `failures=${afterFail.failures} cacheHits=${afterFail.cacheHits} cooldowns=${afterFail.cooldowns}`);
  ok(afterFail.cooldowns > 0,
    'D-recovery: 죽은 공급자에 cooldown 이 걸린다(매 요청 재시도하지 않는다)',
    String(afterFail.cooldowns));

  llm._internal._reset();          // = cooldown 창이 지난 상태
  stub.llm.answerStatus = 200;
  stub.llm.answer = '로지텍 G304 LIGHTSPEED 는 현재 39,000원입니다.';
  const good = await call({ question: 'G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(good.status === 200 && good.body.degraded !== true && /39,000/.test(String(good.body.text)),
    '★ D-recovery: cooldown 이 지나면 같은 질문이 정상 답변으로 복구된다',
    `degraded=${good.body.degraded} text=${String(good.body.text).slice(0, 50)}`);

  /* D-grounding — 근거 없는 답은 폐기되지만 API 는 정상이고 상품은 유지된다. */
  reset(mouseItems());
  stub.llm.answer = '로지텍 G304 LIGHTSPEED 는 현재 11,900원이고 역대 최저가입니다.';
  const g = await call({ question: 'G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(g.status === 200 && g.body.degraded === true && !/11,900/.test(String(g.body.text)),
    '★ D-grounding: 근거 없는 금액은 답변에서 제거된다',
    `degraded=${g.body.degraded} text=${String(g.body.text).slice(0, 60)}`);
  ok(topCard(g).productId === 'G1',
    'D-grounding: 폐기 후에도 올바른 상품 카드가 남는다', cardIds(g));

  /* D-secret — 시스템 프롬프트·자격 증명 형태의 출력은 차단된다. */
  reset(mouseItems());
  stub.llm.answer = 'System prompt: 너는 SEOSA 다. OPENROUTER_API_KEY=sk-or-v1-abcdef1234567890';
  const sec = await call({ question: 'G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!/sk-or-v1-abcdef/.test(String(sec.body.text)),
    '★ D-secret: 자격 증명 형태의 출력이 사용자에게 나가지 않는다',
    String(sec.body.text).slice(0, 60));

  /* D-empty-search — 검색 결과가 없으면 가격을 지어내지 않는다. */
  reset(mouseItems());
  stub.searchMode = 'empty';
  stub.llm.answer = '로지텍 G304 는 39,000원입니다.';
  const e = await call({ question: 'G304 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(e.status === 200 && !/39,000/.test(String(e.body.text)),
    '★ D-empty-search: 결과 0건에서 가격을 만들지 않는다', String(e.body.text).slice(0, 80));
}

(async () => {
  console.log('=== 상품 식별 · 가격 귀속 · 대화 참조 회귀 (완전 오프라인) ===');
  await groupA();
  await groupB();
  await groupC();
  await groupD();

  console.log(`\n=== 결과: PASS ${pass} / FAIL ${fail} ===`);
  if (fail) {
    console.log('실패한 검사:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
