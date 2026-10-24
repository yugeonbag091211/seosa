#!/usr/bin/env node
'use strict';
/*
 * 모델 번호 뒤 계열 꼬리 — _aiidentity buildContract/verdict 회귀.
 *
 * 운영 ADPICK 캐시 재생(2026-10, PR #146 감사): "로지텍 G304 X SUPERLIGHT" 질의에
 * 다른 마우스인 «로지텍 G304 LIGHTSPEED» 59,900원이 EXACT 로 1위 추천이 됐다.
 * 앵커가 g304 하나뿐이고 'X'·'SUPERLIGHT' 는 아무 판정에도 쓰이지 않았다.
 *
 * 양방향을 본다 — 꼬리를 요구한 질의에 꼬리 없는 상품, 꼬리 없는 질의에 꼬리 붙은 상품.
 * 기존 형제 모델 판정(MX Master 3/3S · Buds3/Buds3 Pro · iPhone 17 Pro/Pro Max ·
 * WH-CH730N/720N)이 그대로인지도 함께 고정한다. 네트워크 0회.
 */
const I = require('../api/_aiidentity');
const { TIER } = I;

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
const tierOf = (query, title) => I.verdict(I.buildContract({ query }), { title }).tier;
const NAME = { 0: 'EXACT', 1: 'NEAR', 2: 'SIBLING', 3: 'EXCLUDED', 9: 'MISMATCH' };

const G304_X = '로지텍 G304 X SUPERLIGHT 무선 게이밍 마우스';
const G304_LS = '로지텍 G304 LIGHTSPEED 무선 게이밍 마우스';
const G304_LS2 = 'Logitech G304 LIGHTSPEED Wireless Gaming Mouse 블랙';

const CASES = [
  // 원 결함 — 꼬리를 요구했는데 꼬리 없는 상품
  ['로지텍 G304 X SUPERLIGHT', G304_X, TIER.EXACT],
  ['로지텍 G304 X SUPERLIGHT', G304_LS, TIER.SIBLING],
  ['로지텍 G304 X SUPERLIGHT', G304_LS2, TIER.SIBLING],
  // 브랜드 없이 쓰면 앵커 뒤 첫 이름 낱말(superlight)이 계열 이름(core)이 된다 — 기존 규칙으로 MISMATCH
  ['G304 X SUPERLIGHT 최저가', G304_LS, TIER.MISMATCH],
  ['G304 X SUPERLIGHT 최저가', G304_X, TIER.EXACT],
  ['로지텍 G304 X', G304_LS, TIER.SIBLING],
  ['로지텍 G304 X', G304_X, TIER.EXACT],
  // 반대 방향 — 꼬리 없는 질의에 "G304 X" 는 다른 계열이다
  ['로지텍 G304', G304_X, TIER.SIBLING],
  ['로지텍 G304', G304_LS, TIER.EXACT],
  ['로지텍 G304 LIGHTSPEED', G304_X, TIER.SIBLING],
  ['로지텍 G304 LIGHTSPEED', G304_LS, TIER.EXACT],
  ['로지텍 G304 무선 마우스', G304_X, TIER.SIBLING],
  ['로지텍 G304 무선 마우스', G304_LS, TIER.EXACT],
  // 같은 꼴의 다른 계열
  ['로지텍 G502 X PLUS', '로지텍 G502 HERO 게이밍 마우스', TIER.SIBLING],
  ['로지텍 G502 HERO', '로지텍 G502 X PLUS 무선 게이밍 마우스', TIER.SIBLING],
  ['RTX 5070 Ti 그래픽카드', 'MSI 지포스 RTX 5070 게이밍 그래픽카드', TIER.SIBLING],
  ['RTX 5070 Ti 그래픽카드', 'MSI 지포스 RTX 5070 Ti 게이밍 그래픽카드', TIER.EXACT],
  // 역방향도 분리: plain 모델 질의에 짧은 계열 suffix(Ti/XT)가 붙은 SKU는 형제다.
  ['RTX 5070 그래픽카드', 'MSI 지포스 RTX 5070 Ti 게이밍 그래픽카드', TIER.SIBLING],
  ['RX 7900 그래픽카드', 'AMD Radeon RX 7900 XT 그래픽카드', TIER.SIBLING],
  // 긴 마케팅/계열 낱말은 plain anchor만으로 과잉 분리하지 않는다.
  ['로지텍 G304 무선 마우스', G304_LS, TIER.EXACT],

  // 기존 형제 판정 — 그대로여야 한다
  ['로지텍 MX Master 3S', 'Logitech MX Master 3S 무선 마우스 (로지텍 MX Master 3S)', TIER.EXACT],
  ['로지텍 MX Master 3S', 'Logitech MX Master 3 무선 마우스 (로지텍 MX Master 3)', TIER.SIBLING],
  ['로지텍 MX Master 3', 'Logitech MX Master 3 무선 마우스 (로지텍 MX Master 3)', TIER.EXACT],
  ['갤럭시 버즈3 프로', 'Samsung Galaxy Buds3 Pro (삼성 갤럭시 버즈3 프로)', TIER.EXACT],
  ['갤럭시 버즈3 프로', 'Samsung Galaxy Buds3 (삼성 갤럭시 버즈3)', TIER.SIBLING],
  ['아이폰 17 프로', 'Apple iPhone 17 Pro 256GB 블랙 자급제 (애플 아이폰 17 프로)', TIER.EXACT],
  ['아이폰 17 프로 맥스', 'Apple iPhone 17 Pro Max 256GB 블랙 자급제 (애플 아이폰 17 프로 맥스)', TIER.EXACT],
  ['아이폰 17 프로 맥스', 'Apple iPhone 17 Pro 256GB 블랙 자급제 (애플 아이폰 17 프로)', TIER.SIBLING],
  ['iPhone 17 Pro Max 256GB', 'Apple iPhone 17 Pro Max 256GB 블랙 자급제', TIER.EXACT],
  ['소니 WH-CH730N', '소니 WH-CH730N 노이즈캔슬링 무선 헤드폰', TIER.EXACT],
  ['소니 WH-CH730N', '소니 WH-CH720N 노이즈캔슬링 무선 헤드폰', TIER.SIBLING],
  ['소니 WH-CH720N', '소니 WH-CH720N 노이즈캔슬링 무선 헤드폰', TIER.EXACT],
  // 마케팅 라인에 붙은 Plus는 숫자 모델 등급이 아니다. 동일 상품명이 스스로 sibling이 되면 안 된다.
  ['LG전자 퓨리케어 360도 오브제컬렉션 플러스 공기청정기 100㎡ 방문설치',
    'LG전자 퓨리케어 360도 오브제컬렉션 플러스 공기청정기 100㎡ 방문설치', TIER.EXACT]
];
for (const [q, t, want] of CASES) {
  const got = tierOf(q, t);
  ok(got === want, `"${q}" ↔ "${t}" 는 ${NAME[want]}`, NAME[got]);
}

// 기존 판정: 꼬리 없는 질의에서 등급 표기만 더 붙은 상품은 extraVariant 로 남는다(partition 이 판단)
{
  const v = I.verdict(I.buildContract({ query: '갤럭시 버즈3' }), { title: 'Samsung Galaxy Buds3 Pro (삼성 갤럭시 버즈3 프로)' });
  ok(v.tier === TIER.EXACT && v.extraVariant && v.extraVariant.has('pro'), '버즈3 ↔ 버즈3 Pro 는 extraVariant(partition 몫)', v);
}

// 운영 재생 형태: 최저가 LIGHTSPEED 가 1위가 되지 않는다
{
  const items = [
    { title: G304_LS, lprice: 59900 },
    { title: G304_X, lprice: 89000 },
    { title: '로지텍 G304 X SUPERLIGHT 마우스 그립테이프', lprice: 9900 }
  ];
  const p = I.partition(items, I.buildContract({ query: '로지텍 G304 X SUPERLIGHT' }));
  ok(p.state === 'EXACT' && p.items[0].title === G304_X, 'G304 X SUPERLIGHT 질의의 1위는 G304 X SUPERLIGHT', p.items.map(x => [x.title, x._identity]));
  const lsRow = p.items.find(x => x.title === G304_LS);
  ok(lsRow && lsRow._identity.tier === TIER.SIBLING && lsRow._identity.reasons.includes('model-line'), 'G304 LIGHTSPEED 는 model-line SIBLING', lsRow && lsRow._identity);
  const p2 = I.partition(items.slice(0, 2), I.buildContract({ query: '로지텍 G304' }));
  ok(p2.items[0].title === G304_LS && p2.items[1]._identity.tier === TIER.SIBLING, 'G304 질의의 1위는 G304 LIGHTSPEED, G304 X 는 SIBLING', p2.items.map(x => [x.title, x._identity]));
}

// 계약: 꼬리 읽기는 앵커 바로 뒤 영문만 — 한글 설명·용량·색에서 끊긴다
{
  ok(JSON.stringify(I.buildContract({ query: '로지텍 G304 X SUPERLIGHT' }).lineQualifiers) === '["x","superlight"]', 'G304 X SUPERLIGHT 꼬리 = x, superlight');
  ok(I.buildContract({ query: '아이폰 17 프로 256GB 블랙' }).lineQualifiers.length === 0, '아이폰 17 프로 256GB 블랙 은 꼬리 없음');
  ok(I.buildContract({ query: '로지텍 G304 무선 마우스' }).lineQualifiers.length === 0, 'G304 무선 마우스 는 꼬리 없음');
  ok(I.buildContract({ query: '로지텍 MX Master 3S' }).lineQualifiers.length === 0, 'MX Master 3S 는 꼬리 없음');
}

// Calendar dates in price-history questions are not model-number anchors.
{
  const title = 'LG전자 퓨리케어 360도 오브제컬렉션 플러스 공기청정기 100㎡ 방문설치';
  const datedQuestion = `${title}의 어제(2026년 10월 22일) 관측가와 오늘 현재가를 비교해줘`;
  const contract = I.buildContract({ query: datedQuestion, userText: datedQuestion, titles: [title] });
  ok(I.verdict(contract, { title }).tier === TIER.EXACT, '가격 이력 질문의 달력 날짜를 상품 모델 번호로 보지 않는다', I.verdict(contract, { title }));
}

// A different product grade must not set the requested product's budget floor.
{
  const query = '삼성 990 PRO NVMe SSD 2TB 30만원 이하 신품 추천해줘';
  const exact = { productId: '990-pro-2tb', title: '삼성전자 990 PRO PCIe4.0 NVMe SSD 2TB MZ-V9P2T0BW', price: 941000 };
  const sibling = { productId: '990-evo-plus-2tb', title: '삼성전자 SSD 990 EVO PLUS NVMe M.2 2TB MZ-V9S2T0BW', price: 865000 };
  const contract = I.buildContract({ query, userText: query, titles: [exact.title, sibling.title] });
  const gate = I.partition([sibling, exact], contract);
  const constraints = { budgetMax: 300000, budgetSaid: 300000, budgetSoft: false };
  const outside = require('../api/_shopintent').budgetFilter(gate.items, constraints).outside;
  const facts = I.exactBudgetFacts(outside);
  ok(gate.state === 'EXACT' && gate.items.find(x => x.productId === '990-evo-plus-2tb')._identity.tier === TIER.SIBLING,
    '990 EVO Plus 는 정확한 990 PRO 후보와 분리된다', gate.items.map(x => [x.productId, x._identity]));
  ok(facts.length === 1 && facts[0].productId === '990-pro-2tb',
    '예산 초과 최저가 사실은 정확한 모델 후보만 센다', facts.map(x => [x.productId, x.price]));
  const options = require('../api/_noresult').relaxations(facts, constraints, []);
  const text = require('../api/_concierge').budgetNoMatch({ constraints, label: contract.label, outside: facts, options }).text;
  ok(/941,000원/.test(text) && /641,000원/.test(text) && !/865,000원/.test(text),
    '예산 안내가 990 EVO Plus 가격 865,000원을 990 PRO 가격으로 제시하지 않는다', text);
  ok(I.exactBudgetFacts([{ title: '서버에서 선택한 상품', price: 100000 }]).length === 1,
    '서버가 확인한 선택 상품은 identity 메타데이터가 없어도 유지한다');
}

console.log(`test-ai-identity-model-line: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
