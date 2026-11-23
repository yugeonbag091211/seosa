#!/usr/bin/env node
'use strict';

/*
 * 검색어 토큰이 **하나도** 안 걸린 상품은 결과에 넣지 않는다.
 *
 * ── 왜 생겼나 (2026-11-23 전수 감사, 운영 실측) ──────────────────────
 *
 * 운영 `/?q=LG 그램 16` 을 «최저가순» 으로 보면 1위가 노트북이 아니었다.
 *
 *     1위     699원  올가드 보습 스파 핸드 마스크 16g       ← 핸드팩
 *     2위   7,920원  LG 그램16 16Z90TL 키스킨
 *     3위   8,480원  액티비아 컵 딸기 16입 (80gx16개)       ← 요거트
 *     4위   8,600원  … 5G 무제한 데이터 SIM 카드 (LG U+)    ← 유심
 *
 * 최저가 비교 서비스에서 «가장 싼 것» 자리에 699원 핸드팩이 선다.
 *
 * 1위의 점수는 0 이었다. scoreTitle 이 `hits: []` 를 돌려준다 — 검색어의
 * 어느 토큰도, 정확히도 부분문자열로도 어간으로도 합성어 조각으로도 동의어로도
 * 제목에 없다. 그런데 rankItems 의 통과 조건이 `score >= minScore` 이고
 * api/search.js 는 minScore 0 을 넘긴다. `0 >= 0` 이라 그대로 통과했다.
 *
 * ── 왜 «0 보다 크다» 만 보는가 ───────────────────────────────────────
 *
 * minScore 0 은 의도된 값이다(api/search.js 주석: «지금까지 보이던 상품이
 * 갑자기 사라지는 쪽이 섞여 보이는 쪽보다 나쁘다»). 그 결정을 뒤집지 않는다.
 * 0 은 «낮은 관련도» 가 아니라 «관련이 하나도 확인되지 않음» 이라서 다르다.
 *
 * relevance 가 0 이 되는 길은 이것 하나뿐이다 — 곱해지는 관계 계수
 * (titleRelation · variantRelation · conditionRelation · substituteRelation ·
 * productFocus) 중 0 을 돌려주는 것이 하나도 없다. 가장 낮은 값이 0.25 다.
 *
 * 실측 범위: 2026-11-23 운영 검색어 34개 · 상품 506건 중 점수 0 은 2건(0.4%).
 * 둘 다 명백한 무관 상품이었고(핸드팩 · 갤럭시A25 보호필름), 진짜 상품이
 * 0 을 받은 사례는 없었다.
 *
 * 외부 호출 0 · DB 조회 0. 상품명은 운영 응답에서 그대로 가져왔다.
 */

const S = require('../api/_search');

let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); return; }
  fail++;
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`);
}
function rank(query, titles, opts) {
  const items = titles.map((title, i) => ({ title, lprice: 1000 + i, productId: 'p' + i }));
  return S.rankItems(query, items, opts || { minScore: 0 });
}
function has(result, fragment) {
  return result.items.some(it => it.title.indexOf(fragment) > -1);
}

/* 2026-11-23 운영 /api/search?keyword=LG 그램 16 응답에서 가져온 상품명. */
const GRAM = [
  '올가드 보습 스파 핸드 마스크 16g',                                   // 토큰 0개 일치
  '액티비아 컵 딸기 16입 (80gx16개)',                                   // '16' 만
  '(티머니 카드 무료 증정) 대한민국 5G 무제한 데이터 SIM 카드 (LG U+)',  // 'lg' 만
  'LG 그램16 16Z90TL 키스킨',
  'LG 그램16 16ZD90P i7 16GB 512GB 윈도우11 노트북',
  'LG전자 2026 그램 16 코어 Ultra5'
];

console.log('\n토큰이 하나도 안 걸린 상품은 목록에 들어가지 않는다');
{
  const r = rank('LG 그램 16', GRAM);
  check(!has(r, '핸드 마스크'),
    'LG 그램 16: 「올가드 보습 스파 핸드 마스크 16g」 가 빠진다',
    r.items.map(it => `${it.relevance}:${it.title.slice(0, 30)}`));

  const a = S.analyzeQuery('LG 그램 16', { titles: GRAM.map(t => S.analyzeTitle(t)) });
  check(S.scoreTitle(a, S.analyzeTitle('올가드 보습 스파 핸드 마스크 16g')).hits.length === 0,
    'LG 그램 16: 그 상품은 실제로 토큰이 한 개도 안 걸린다(hits 비어 있음)');

  /* 2026-11-23 운영 /api/search?keyword=아이폰17 프로맥스 256 의 4위 */
  const iphone = [
    'Apple 아이폰 17 Pro Max 자급제',
    '보스펫 아이폰18 프로 맥스 미러 카드홀더 크로스끈 가죽 휴대폰 케이스',
    '8H 방탄필름 액정보호 2매 갤럭시A25 5G A256'
  ];
  const r2 = rank('아이폰17 프로맥스 256', iphone);
  check(!has(r2, '갤럭시A25'),
    '아이폰17 프로맥스 256: 「갤럭시A25 보호필름」 이 빠진다',
    r2.items.map(it => `${it.relevance}:${it.title.slice(0, 30)}`));
}

console.log('\n한 토큰이라도 걸리면 아무리 낮아도 남는다 (minScore 0 의 뜻은 그대로다)');
{
  const r = rank('LG 그램 16', GRAM);
  check(has(r, '액티비아'), 'LG 그램 16: 「16」 하나만 걸린 요거트는 남는다(낮은 점수로)',
    r.items.map(it => `${it.relevance}:${it.title.slice(0, 26)}`));
  check(has(r, 'SIM 카드'), 'LG 그램 16: 「lg」 하나만 걸린 유심은 남는다',
    r.items.map(it => `${it.relevance}:${it.title.slice(0, 26)}`));
  check(has(r, '키스킨'), 'LG 그램 16: 부속(키스킨)은 여전히 남는다');
  for (const t of ['16ZD90P', '2026 그램 16']) {
    check(has(r, t), `LG 그램 16: 본품 「${t}」 이 남는다`);
  }
  check(r.items.length === GRAM.length - 1,
    'LG 그램 16: 빠진 것은 그 한 건뿐이다',
    { kept: r.items.length, input: GRAM.length });
}

console.log('\n검색어에 쓸 토큰이 없으면 이 규칙은 아무것도 걸러내지 않는다');
{
  /* 토큰이 없는 검색어는 rankItems 가 전부 relevance 1 로 돌려준다 —
   * 거를 근거가 없기 때문이다. 그 계약을 건드리지 않는다. */
  const r = rank('!!!', ['아무 상품', '다른 상품']);
  check(r.items.length === 2, '토큰 없는 검색어: 두 건 모두 남는다', r.items.length);
  check(r.items.every(it => it.relevance === 1), '토큰 없는 검색어: relevance 는 1 그대로');
}

console.log('\nminScore 를 올려 부르는 쪽(저장 필터 등)의 동작은 그대로다');
{
  const r = rank('LG 그램 16', GRAM, { minScore: 0.3 });
  check(!has(r, '핸드 마스크') && !has(r, '액티비아'),
    'minScore 0.3: 0점과 0.25점이 모두 빠진다',
    r.items.map(it => `${it.relevance}:${it.title.slice(0, 26)}`));
  check(has(r, 'SIM 카드'), 'minScore 0.3: 0.5점은 남는다(기존 기준 그대로)');
}

console.log(`\nZero-coverage filter: ${pass}/${pass + fail} PASS, ${fail} FAIL. External calls: 0. DB queries: 0.`);
process.exit(fail ? 1 : 0);
