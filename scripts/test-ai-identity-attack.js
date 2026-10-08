#!/usr/bin/env node
/**
 * 상품 식별 변형 공격 — 200+ 질의, 완전 오프라인(외부 호출 0회).
 *
 * ── 무엇을 재는가 ───────────────────────────────────────────────
 *
 * test-ai-product-identity.js 가 «대표 사례» 를 고정한다면, 이 파일은 같은
 * 요구를 사람이 실제로 쓰는 여러 꼴로 바꿔 가며 판정이 흔들리지 않는지 본다.
 *
 * ★ 판정 기준은 언제나 productId 다 — 결정적 식별자다.
 *   답변 문장을 정규식으로 훑어 «맞은 것 같다» 로 세지 않는다. 과거 평가에서
 *   그 방식이 실제 정확도를 과대평가한 적이 있다(보고서 참고). 여기서는
 *   «어떤 상품을 골랐는가» 하나만 센다.
 *
 * ★ 분류기 대역은 사용자 문장을 그대로 검색어로 돌려준다.
 *   작은 모델이 실제로 그렇게 행동한다(api/ai.js cleanQuery 주석). 그래서 이
 *   설정이 가장 나쁜 현실 조건이고, production 의 검색어 정리·부정 구문 제거가
 *   실제로 도는지 함께 재진다.
 *
 * ── 공격군 ──────────────────────────────────────────────────────
 *
 *   1  일반 G304 요구          → 일반 G304 가 1위여야 한다
 *   2  G304 X 요구             → G304 X 가 1위여야 한다 (전역 차단 금지)
 *   3  AirPods 본품 요구       → 본품이 1위여야 한다
 *   4  AirPods 액세서리 요구   → 액세서리가 1위여야 한다 (전역 차단 금지)
 *   5  확정된 상품 참조        → 같은 상품 하나만 유지해야 한다
 *   6  (대조) 새 후보 요구     → 참조로 묶지 말고 다시 찾아야 한다
 *   7  못 찾는 표기            → 틀린 상품을 고르지 않아야 한다
 *
 * 같은 틀에 낱말만 바꾼 숫자 채우기를 하지 않는다. 각 줄은 서로 다른 공격
 * 경로다 — 띄어쓰기·오타·언어·세대 표기·부정 구문·순서 참조·별칭·거부.
 */
'use strict';

/*
 * 오프라인 대역 (scripts/_ai-offline-harness.js).
 * ★ api/ai.js 보다 먼저 require 되어야 한다 — 그 모듈이 그 순서를 보장한다.
 */
const H = require('./_ai-offline-harness.js');
const { stub, call, reset } = H;

/* ── 검사 도구 ────────────────────────────────────────────────── */
const groups = new Map();
const failures = [];
let pass = 0, fail = 0;

function record(group, name, cond, detail) {
  const g = groups.get(group) || { pass: 0, fail: 0 };
  if (cond) { g.pass++; pass++; } else { g.fail++; fail++; failures.push(`[${group}] ${name} — ${detail}`); }
  groups.set(group, g);
}

/* ── 픽스처 (test-ai-product-identity.js 와 같은 상품) ─────────── */
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
 * ★ 일반 G304 를 «가장 비싼» 쪽으로 둔 변형도 함께 돌린다.
 *
 *   원래 픽스처에서는 일반형이 가장 싸서, 식별이 틀려도 «최저가 가점» 때문에
 *   우연히 1위가 될 수 있다. 가격 순서를 뒤집어도 같은 답이 나와야 식별이
 *   실제로 동작한다는 뜻이다 — 이 파일에서 가장 중요한 장치다.
 */
function mouseItemsPriceInverted() {
  const list = mouseItems();
  list[0].lprice = 129000; list[0].oprice = 139000;
  list[1].lprice = 29000;  list[1].oprice = 39000;
  return list;
}

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
      vendorItemId: 'V-A5', isCoupang: true, oprice: 7900, savePct: 0 },
    { title: '삼성 갤럭시 버즈3 프로 무선 이어폰', lprice: 199000,
      link: 'https://l.c/x1', image: '', mall: '쿠팡', productId: 'X1',
      vendorItemId: 'V-X1', isCoupang: true, oprice: 219000, savePct: 9 }
  ];
}

const ACCESSORY_IDS = ['A2', 'A3', 'A4', 'A5'];

/*
 * 답변 대역은 상품 이름도 금액도 담지 않는다.
 *
 * 일부러 그렇게 둔다. 이 파일이 재는 것은 «무엇을 골랐는가» 이고, 답변 문장이
 * 섞이면 grounding 게이트의 판정과 선택의 판정이 한 숫자에 뒤섞인다.
 * (문장 쪽은 test-ai-product-identity.js 의 A-3 · A-3b 가 따로 고정한다.)
 */
const NEUTRAL_ANSWER = '확인한 후보를 아래에 정리했습니다.';

const topId = r => (((r.body.items || [])[0] || {}).productId) || '';
const ids = r => (r.body.items || []).map(c => c.productId).join(',');

/** 질의 1건. 분류기 대역이 사용자 문장을 그대로 검색어로 돌려준다. */
async function ask(items, question, extra) {
  reset(items);
  stub.llm.classify = `D|${question}`;
  stub.llm.resolve = JSON.stringify({ q: question, use: '', brand: '', avoid: '' });
  stub.llm.answer = NEUTRAL_ANSWER;
  return call(Object.assign({
    question, contextProducts: [], chatHistory: [], view: { source: 'none' }
  }, extra || {}));
}

/* ================================================================== *
 *  1 — 일반 G304 요구 (G304 X 가 선택되면 실패)
 * ================================================================== */
const G304_STANDARD = [
  // 맨 모델명·띄어쓰기·대소문자
  'G304 가격 알려줘', 'g304 가격', 'G 304 가격 알려줘', 'G-304 얼마야',
  '로지텍 G304 가격', '로지텍g304 최저가', 'LOGITECH G304 price',
  // 기본형·일반형을 말로 밝힌 경우
  '로지텍 G304 기본형', 'G304 기본 모델 가격', 'G304 일반형 얼마야',
  'G304 스탠다드 가격', 'G304 standard price', 'Logitech G304 base model price',
  'G304 구형 말고 기본 모델', 'G304 오리지널 가격',
  // X 를 빼 달라고 한 경우
  'G304 X 말고 일반 G304 가격 알려줘', 'G304 X 빼고 G304 보여줘',
  'G304 X 제외하고 G304 최저가', 'G304 엑스 말고 G304',
  'Logitech G304 standard model only, not the X', 'G304 price, no X version',
  'G304 without the X variant', 'G304 except X',
  // SUPERLIGHT 를 빼 달라고 한 경우
  'SUPERLIGHT 말고 G304 보여줘', '슈퍼라이트 제외하고 G304 가격',
  'G304 superlight 아닌 거 가격', 'G304 price without superlight',
  'G304 슈퍼라이트는 빼줘',
  // 함께 섞인 조건 (예산·색상·용도)
  '5만원 이하 로지텍 G304 가격', 'G304 블랙 가격 알려줘', 'G304 검정색 얼마야',
  '게임용 로지텍 G304 기본형 최저가', '로지텍 G304 무선 마우스 가격',
  // 번들·중고를 빼 달라고 한 경우
  'G304 번들 제외하고 가격', 'G304 중고 말고 새 제품 가격',
  'G304 정품만 가격 알려줘', 'G304 세트 아닌 단품 가격',
  // 가격 이력·구매 시점을 묻는 꼴
  'G304 지금 사도 돼?', 'G304 기본형 가격 추이 알려줘', 'G304 역대 최저가였어?',
  'G304 기본형 지금 가격 괜찮아?', 'G304 기다릴까 지금 살까',
  // 오타·자모·붙여쓰기
  'G304가격', 'G304 얼마', 'G304 최저가로 알려줘', '지금 G304 판매가',
  'G304 마우스 가격 알려줘', '로지텍 G304 마우스 최저가 알려줘',
  // 문장형
  'G304 사려는데 얼마인지 알려줘', 'G304 하나 사고 싶은데 가격 좀',
  '로지텍 G304 어디서 제일 싸?', 'G304 기본형으로 추천해줘',
  'X 버전 아니고 그냥 G304 가격 알려줘', '일반 G304 한 개 가격',
  'G304 무선 마우스 기본형 최저가 찾아줘'
];

/* ================================================================== *
 *  2 — G304 X 요구 (전역 차단 금지: X 가 1위여야 한다)
 * ================================================================== */
const G304_X = [
  'G304 X SUPERLIGHT 가격 알려줘', 'G304 X 가격', 'G304X 얼마야',
  '로지텍 G304 X SUPERLIGHT 최저가', 'Logitech G304 X price',
  'G304 X SUPERLIGHT 지금 사도 돼?', 'G304 엑스 가격 알려줘',
  'G304 X 화이트 가격', 'G304 X superlight 가격 추이',
  'G304 X SUPERLIGHT 무선 마우스 가격', 'G304 슈퍼라이트 X 최저가',
  'G304 X 버전 가격 알려줘'
];

/* ================================================================== *
 *  3 — AirPods Pro 3 본품 요구 (액세서리·다른 브랜드가 1위면 실패)
 * ================================================================== */
const BUDS_MAIN = [
  // 본품을 말로 밝힌 경우
  '에어팟 프로 3 본체만. 케이스 제외.', '에어팟 프로3 본품만 가격',
  '에어팟 프로 3 유닛만 얼마야', '에어팟 프로 3 이어버드만 가격',
  '에어팟 프로 3 이어폰 본체 가격', '에어팟 프로 3 본체 최저가 알려줘',
  // 제외를 밝힌 경우
  '에어팟 프로 3 케이스 제외하고 가격', '에어팟 프로3 충전 케이스는 빼줘',
  '에어팟 프로 3 호환품 제외', '에어팟 프로3 정품 이어폰만, 호환품 제외',
  '에어팟 프로 3 보호 커버 말고 본품', '에어팟 프로 3 액세서리 제외하고 본품 가격',
  '에어팟 프로 3 키링 빼고 가격', '에어팟 프로 3 거치대 제외',
  '에어팟 프로 3 이어팁 말고 본품', '에어팟 프로 3 단품 가격 (케이스 아님)',
  // 영어
  'AirPods Pro 3 earbuds only, no case', 'AirPods Pro 3 price without case',
  'AirPods Pro 3 unit only', 'AirPods Pro 3 genuine earphones only',
  'AirPods Pro 3 not a case', 'AirPods Pro 3 excluding accessories',
  // 세대·표기 변형
  '에어팟 프로 3세대 가격', '에어팟프로3세대 본품 가격', '에어팟 프로3 가격 알려줘',
  '에어팟프로 3 최저가', 'airpods pro 3 price', 'AirPods Pro 3rd generation price',
  'Apple 에어팟 프로 3 가격', '애플 에어팟 프로 3 본체 얼마야',
  // 정품을 강조한 경우
  '에어팟 프로 3 정품 가격', '에어팟 프로 3 애플 정품 본체 가격',
  '에어팟 프로 3 풀박스 정품 가격',
  // 조건이 섞인 경우
  '40만원 이하 에어팟 프로 3 본품', '에어팟 프로 3 본체 지금 사도 돼?',
  '에어팟 프로 3 본품 가격 추이', '에어팟 프로 3 본체 역대 최저가',
  // 문장형
  '에어팟 프로 3 사려는데 본체만 얼마야', '에어팟 프로 3 본품 어디서 제일 싸',
  '에어팟 프로 3 이어폰 자체 가격만 알려줘',
  '충전 케이스 단품 아니고 에어팟 프로 3 본체 가격'
];

/*
 * 3c — 의도 분류의 기존 한계.
 *
 * 값 낱말이 하나도 없는 "…알려줘" 는 _intent.KNOWLEDGE_RE 가 지식 질문(B)으로
 * 받는다. 설계된 보수성이다("B 와 C 사이에서 애매하면 B" — api/ai.js
 * CLASSIFY_SYSTEM). 그래서 상품 검색이 돌지 않고 아무 상품도 고르지 않는다.
 *
 * ★ 이것을 통과로 바꾸려고 분류 규칙을 넓히지 않는다. 이번 작업의 요구는
 *   «틀린 상품을 고르지 않는다» 이고 그 요구는 지켜진다. 다만 숨기지 않기
 *   위해 따로 센다 — 보고서의 «남은 위험» 에 그대로 적는다.
 */
const MAIN_INTENT_LIMITS = [
  '케이스 필요 없고 에어팟 프로 3 본체만 알려줘',
  '에어팟 프로 3 본체만 알려줘'
];

/* ================================================================== *
 *  4 — 액세서리를 지목한 경우 (전역 차단 금지: 액세서리가 1위여야 한다)
 * ================================================================== */
const BUDS_ACCESSORY = [
  '에어팟 프로 3 케이스 가격', '에어팟 프로 3 충전 케이스 얼마야',
  '에어팟 프로 3 보호 케이스 추천', '에어팟 프로 3 케이스 최저가 알려줘',
  '에어팟 프로3 실리콘 케이스 가격', '에어팟 프로 3 커버 가격',
  '에어팟 프로 3 케이스 지금 사도 돼?', 'AirPods Pro 3 case price',
  '에어팟 프로 3 투명 커버 얼마야', '에어팟 프로 3 케이스 키링 가격',
  '에어팟 프로 3 이어팁 가격', '에어팟 프로 3 교체용 이어팁 최저가'
];

/* ================================================================== *
 *  5 — 확정된 상품 참조 (다른 상품으로 바뀌면 실패)
 * ================================================================== */
const REFERENCES = [
  '그거 가격 알려줘', '그거 얼마야', '그것 가격', '그건 얼마야',
  '그 상품 가격 알려줘', '그 제품 가격', '그 모델 가격 알려줘',
  '이거 가격 알려줘', '이 제품 얼마야',
  '아까 거 가격 알려줘', '아까꺼 얼마야', '아까 것 가격',
  '아까 추천한 거 가격', '아까 추천한 그 상품 가격 알려줘',
  '아까 추천한 제품 지금 사도 돼?', '아까 말한 제품 가격 알려줘',
  '방금 말한 제품 가격', '방금 보여준 거 얼마야', '방금 추천한 상품 가격',
  '앞서 추천한 상품 가격 알려줘', '이전에 말한 제품 가격',
  '첫 번째 상품 가격', '첫번째 제품 얼마야', '첫 번째 거 가격 알려줘',
  'A 제품 가격 다시 알려줘', 'A 상품 얼마야', 'B 제품 가격',
  '이전 제품 가격 알려줘', '원래 거 가격', '처음 거 얼마야',
  '그거 지금 사도 돼?', '그 상품 가격 추이 알려줘', '그 제품 역대 최저가였어?',
  '그거 가격 다시 확인해줘', '그 상품 현재가 알려줘', '아까 거 현재 판매가',
  '첫 번째 상품 지금 가격', 'A 제품 현재가 알려줘', '그거 최저가 알려줘',
  '아까 추천한 그 모델 가격 알려줘'
];

/* ================================================================== *
 *  6 — (대조) 새 후보를 달라는 말은 참조로 묶지 않는다
 * ================================================================== */
const NEW_CANDIDATE_REQUESTS = [
  '그거 말고 다른 거 보여줘', '그거보다 더 싼 거 없어?', '아까 거 말고 다른 상품',
  '이 중에서 가장 싼 것', '그중에 제일 싼 거', '비슷한 거 더 보여줘',
  '이거 너무 비싼데', '이거 너무 무거운데', '다른 모델 추천해줘',
  '더 좋은 거 없어?', '그거 말고 G304 X 보여줘', '아까 거 말고 X 버전 보여줘'
];

/* ================================================================== *
 *  7 — 못 찾는 표기 (틀린 상품을 고르지 않는다)
 * ================================================================== */
const UNMATCHED = [
  'エアーポッズプロ3の値段', 'AirPods Pro 3 価格', '에어팟 프로 7 가격',
  '에어팟 프로 3 엑스트라 울트라 가격', 'G999 가격 알려줘',
  '로지텍 G99999 기본형 가격'
];

/* ================================================================== *
 *  실행
 * ================================================================== */
(async () => {
  console.log('=== 상품 식별 변형 공격 (완전 오프라인) ===');

  /* 1 — 일반 G304. 가격 순서를 뒤집은 픽스처로도 한 번 더 돈다. */
  for (const [label, fixture] of [['정상가', mouseItems], ['가격역전', mouseItemsPriceInverted]]) {
    for (const q of G304_STANDARD) {
      const r = await ask(fixture(), q);
      record(`1. 일반 G304 (${label})`, q, topId(r) === 'G1',
        `top=${topId(r) || '없음'} cards=${ids(r)}`);
    }
  }

  /* 2 — G304 X 를 지목. 가격이 비싸도(정상가) 싸도(역전) X 가 1위여야 한다. */
  for (const [label, fixture] of [['정상가', mouseItems], ['가격역전', mouseItemsPriceInverted]]) {
    for (const q of G304_X) {
      const r = await ask(fixture(), q);
      record(`2. G304 X 지목 (${label})`, q, topId(r) === 'G2',
        `top=${topId(r) || '없음'} cards=${ids(r)}`);
    }
  }

  /* 3 — AirPods 본품. */
  for (const q of BUDS_MAIN) {
    const r = await ask(budsItems(), q);
    const t = topId(r);
    record('3. AirPods 본품', q, t === 'A1', `top=${t || '없음'} cards=${ids(r)}`);
    record('3b. 본품 요구에 액세서리 금지', q, !ACCESSORY_IDS.includes(t),
      `top=${t || '없음'} cards=${ids(r)}`);
  }

  /* 3c — 지식 질문으로 분류되는 꼴. 틀린 상품을 고르지 않는 것만 요구한다. */
  for (const q of MAIN_INTENT_LIMITS) {
    const r = await ask(budsItems(), q);
    const t = topId(r);
    record('3c. 의도 분류 한계(값 낱말 없는 "알려줘")', q, t === '' || t === 'A1',
      `top=${t || '없음(검색 미실행)'} cards=${ids(r)}`);
  }

  /* 4 — 액세서리를 지목. */
  for (const q of BUDS_ACCESSORY) {
    const r = await ask(budsItems(), q);
    const t = topId(r);
    record('4. 액세서리 지목', q, ACCESSORY_IDS.includes(t), `top=${t || '없음'} cards=${ids(r)}`);
  }

  /* 5 — 확정된 상품 참조. 참조가 가리키는 상품 하나만 남아야 한다. */
  for (const q of REFERENCES) {
    /*
     * 1턴에서 일반 G304 를 확정하고 서명 참조를 받는다. 그 턴은 카탈로그도
     * 채우므로(저장된 검색 결과 = 카탈로그), 2턴의 참조 조회가 운영과 같다.
     * ★ 2턴의 검색 결과는 «가격역전» 픽스처다 — 다시 검색해서 다시 고르면
     *   더 싼 G304 X 를 고르게 되므로, 실패가 반드시 드러난다.
     */
    const first = await ask(mouseItems(), '로지텍 G304 기본형 찾아줘');
    if (topId(first) !== 'G1' || !first.body.topRecommendationRef) {
      record('5. 상품 참조 유지', q, false, `1턴 준비 실패 top=${topId(first)}`);
      continue;
    }
    const ref = first.body.topRecommendationRef;
    const history = [
      { role: 'user', text: '로지텍 G304 기본형 찾아줘' },
      { role: 'assistant', text: first.body.text, sig: first.body.turnSig }
    ];
    stub.searchItems = mouseItemsPriceInverted();
    stub.llm.classify = `D|${q}`;
    stub.llm.resolve = JSON.stringify({ q, use: '', brand: '', avoid: '' });
    stub.llm.answer = NEUTRAL_ANSWER;
    const r = await call({
      question: q, contextProducts: [], chatHistory: history,
      prevTopRef: ref, prevTop: 'G1', view: { source: 'none' }
    });
    const cards = (r.body.items || []).map(c => c.productId);
    record('5. 상품 참조 유지', q, cards.length === 1 && cards[0] === 'G1',
      `cards=${cards.join(',') || '없음'}`);
    record('5b. 참조가 다른 모델로 바뀌지 않는다', q, !cards.includes('G2'),
      `cards=${cards.join(',') || '없음'}`);
  }

  /* 6 — (대조) 새 후보 요구는 다시 찾아야 한다. */
  for (const q of NEW_CANDIDATE_REQUESTS) {
    const first = await ask(mouseItems(), '로지텍 G304 기본형 찾아줘');
    const ref = first.body.topRecommendationRef || '';
    const history = [
      { role: 'user', text: '로지텍 G304 기본형 찾아줘' },
      { role: 'assistant', text: first.body.text, sig: first.body.turnSig }
    ];
    stub.searchItems = mouseItems();
    stub.llm.classify = `C|${q}`;
    stub.llm.resolve = JSON.stringify({ q: '로지텍 G304', use: '', brand: '', avoid: '' });
    stub.llm.answer = NEUTRAL_ANSWER;
    const r = await call({
      question: q, contextProducts: [], chatHistory: history,
      prevTopRef: ref, prevTop: 'G1', view: { source: 'none' }
    });
    record('6. (대조) 새 후보 요구', q, (r.body.items || []).length >= 2,
      `cards=${ids(r) || '없음'}`);
  }

  /* 7 — 못 찾는 표기. 틀린 상품을 «그 상품» 으로 내세우지 않는다. */
  for (const q of UNMATCHED) {
    const r = await ask(budsItems(), q);
    const t = topId(r);
    record('7. 못 찾는 표기', q, t === '' || t === 'A1',
      `top=${t || '없음'} cards=${ids(r)}`);
  }

  /* ── 결과 ──────────────────────────────────────────────────── */
  console.log('\n=== 공격군별 ===');
  let total = 0;
  groups.forEach((v, k) => {
    total += v.pass + v.fail;
    console.log(`  ${v.fail ? 'FAIL' : 'PASS'}  ${k}: ${v.pass} PASS / ${v.fail} FAIL`);
  });
  console.log(`\n질의 ${G304_STANDARD.length * 2 + G304_X.length * 2 + BUDS_MAIN.length
    + MAIN_INTENT_LIMITS.length + BUDS_ACCESSORY.length + REFERENCES.length + NEW_CANDIDATE_REQUESTS.length
    + UNMATCHED.length}건 · 검사 ${total}건`);
  console.log(`=== 결과: PASS ${pass} / FAIL ${fail} ===`);
  if (fail) {
    console.log('실패:');
    failures.slice(0, 40).forEach(f => console.log(`  - ${f}`));
    if (failures.length > 40) console.log(`  ... 그리고 ${failures.length - 40}건 더`);
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
