#!/usr/bin/env node
'use strict';

/*
 * 검색어와 «숫자 조각» 으로만 이어진 상품은 결과에 넣지 않는다.
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
 * 1위의 점수는 0 이었다. 공급자 단계 필터(_shop.relevantItems)는 «16» 이
 * «16g» 안에 들어 있다는 이유만으로 통과시켰고, rankItems 는 api/search.js 가
 * minScore 0 을 넘기므로 `0 >= 0` 으로 그대로 남겼다.
 *
 * ── 왜 «0점이면 무조건» 이 아닌가 (2026-11-24 재검증) ─────────────────
 *
 * 처음 규칙(score > 0)을 운영 공급자 캐시의 검색어 4,416개에 재생하자 한 글자
 * 검색어가 통째로 비었다 — «김»·«컵»·«풀» 결과 0건. scoreTitle 은 한 글자 토큰을
 * «도시락김»·«머그컵»·«목공풀» 같은 합성어 안에서 인정하지 않는다. «굴»(생굴)·
 * «쌀»(햅쌀)·«짐 백»(스포츠백)에서도 진짜 상품이 빠졌다. 0점은 «관련 없음» 이
 * 아니라 «이 채점기가 못 알아봤음» 일 수 있다.
 *
 * 그래서 지금 규칙은 이렇다:
 *   0점이면서, 검색어의 «낱말» 토큰(글자가 든 두 글자 이상) 중 어느 것도 제목에
 *   부분 문자열로조차 없는 상품만 뺀다. 낱말 토큰이 없는 검색어는 아무것도 빼지
 *   않는다. 목록이 통째로 비게 되면 빼지 않는다.
 * 같은 재생에서 결과가 비는 검색어 5개 → 0개, 빠지는 상품 537건 → 119건이 됐고
 * 남은 119건은 «16g»·«170ml»·«14ea»·«100매» 같은 숫자 조각 연결이었다.
 *
 * 외부 호출 0 · DB 조회 0. 상품명은 운영 응답·운영 공급자 캐시에서 그대로 가져왔다.
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
const show = r => r.items.map(it => `${it.relevance}:${it.title.slice(0, 28)}`);

/* 2026-11-23 운영 /api/search?keyword=LG 그램 16 응답에서 가져온 상품명. */
const GRAM = [
  '올가드 보습 스파 핸드 마스크 16g',                                   // «16g» 의 16 뿐
  '액티비아 컵 딸기 16입 (80gx16개)',                                   // '16' 만 (점수는 0 이 아니다)
  '(티머니 카드 무료 증정) 대한민국 5G 무제한 데이터 SIM 카드 (LG U+)',  // 'lg' 만
  'LG 그램16 16Z90TL 키스킨',
  'LG 그램16 16ZD90P i7 16GB 512GB 윈도우11 노트북',
  'LG전자 2026 그램 16 코어 Ultra5'
];

console.log('\n숫자 조각으로만 이어진 상품은 목록에 들어가지 않는다');
{
  const r = rank('LG 그램 16', GRAM);
  check(!has(r, '핸드 마스크'), 'LG 그램 16: 「올가드 보습 스파 핸드 마스크 16g」 가 빠진다', show(r));

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
  check(!has(r2, '갤럭시A25'), '아이폰17 프로맥스 256: 「갤럭시A25 보호필름」 이 빠진다', show(r2));

  /* 운영 공급자 캐시(2026-11-24)에서 숫자 조각으로만 걸려 있던 상품 */
  const r3 = rank('아이폰 17', ['Apple 아이폰 17 256GB 자급제', '녹차원 아이스커피 170ml']);
  check(!has(r3, '아이스커피') && has(r3, '아이폰 17'), '아이폰 17: 「아이스커피 170ml」 가 빠지고 아이폰은 남는다', show(r3));
  const r4 = rank('애플워치 시리즈 10', [
    'Apple 애플워치 시리즈 10 GPS 42mm 알루미늄 케이스',
    '비타민하우스 파이토 마그네슘B6 1100mg x 90정',
    '올가드 이염방지 세탁시트 100매'
  ]);
  check(r4.items.length === 1 && has(r4, '시리즈 10'),
    '애플워치 시리즈 10: 「1100mg」·「100매」 상품이 빠지고 시계만 남는다', show(r4));
}

console.log('\n검색어 낱말이 하나라도 걸리면 아무리 낮아도 남는다 (minScore 0 의 뜻은 그대로다)');
{
  const r = rank('LG 그램 16', GRAM);
  check(has(r, '액티비아'), 'LG 그램 16: 「16」 하나만 걸린 요거트는 남는다(낮은 점수로)', show(r));
  check(has(r, 'SIM 카드'), 'LG 그램 16: 「lg」 하나만 걸린 유심은 남는다', show(r));
  check(has(r, '키스킨'), 'LG 그램 16: 부속(키스킨)은 여전히 남는다');
  for (const t of ['16ZD90P', '2026 그램 16']) {
    check(has(r, t), `LG 그램 16: 본품 「${t}」 이 남는다`);
  }
  check(r.items.length === GRAM.length - 1, 'LG 그램 16: 빠진 것은 그 한 건뿐이다',
    { kept: r.items.length, input: GRAM.length });
}

console.log('\n한 글자 검색어는 비지 않는다 (2026-11-24 재검증에서 찾은 회귀)');
{
  /* 처음 규칙(score > 0)에서는 아래 세 검색어의 결과가 0건이었다. */
  const kim = rank('김', [
    '국내산으로 만든 사계절 프리미엄 반계탕 800g', '양반 들기름김 식탁',
    '비비고 더바삭한 직화김 4.5g,12봉', '들기름 재래김 도시락김 13+7봉 (100g)', '곰곰 광천 도시락김'
  ]);
  check(kim.items.length === 5, '김: 5건 모두 남는다(빼는 근거가 될 낱말 토큰이 없다)', show(kim));
  const cup = rank('컵', [
    '라이프란스 베이직 투톤 무광 머그컵 360ml', '탐사 고평량 종이컵 무인쇄 380ml', '글라스락 내열강화 다용도 머그 350ml'
  ]);
  check(cup.items.length === 3, '컵: 머그컵·종이컵이 남는다', show(cup));
  const glue = rank('풀', ['오공 오공본드 205목공용수용성 목공풀 800g 접착제', '델리 아로마 점보 중형 고체풀 21g 글루스틱']);
  check(glue.items.length === 2, '풀: 목공풀·고체풀이 남는다', show(glue));
}

console.log('\n합성어 안에 검색어가 든 진짜 상품은 남는다');
{
  const oyster = rank('굴', ['통영 햇 생굴 최상급 1kg 버블세척', '여수 세척 석화 3kg 5kg 10kg 석화굴 굴구이', '백설 프리미엄 굴소스 500g']);
  check(oyster.items.length === 3, '굴: 생굴·석화굴이 남는다', show(oyster));
  const rice = rank('쌀', ['임금님표이천 2026년산 햅쌀 GAP 인증 이천쌀 특등급', '한음미가 2026년산 햅쌀 우리쌀 백미 상등급, 10kg']);
  check(rice.items.length === 2, '쌀: 햅쌀이 남는다', show(rice));
  const gym = rank('짐 백', [
    '코멧 스포츠 다용도 스포츠백 축구화 운동용품 농구공 축구공 수납 멀티 가방',
    '[해외] 2026년형 강력 자석 부착형 짐백, 등산용 가방, 휴대폰 및 물병 수납 가능'
  ]);
  check(gym.items.length === 2, '짐 백: 스포츠백·짐백이 남는다', show(gym));
}

console.log('\n숫자뿐인 검색어는 이 규칙으로 아무것도 빼지 않는다');
{
  const r = rank('5090', ['[해외] ASUS RTX4090 /RTX3090 /RTX5090 /RTX4060', '[인베스트] 리본 넥 셔링 벨루아 블라우스_IN5W1BL5090']);
  check(r.items.length === 2 && has(r, 'RTX5090'), '5090: 「RTX5090」 이 든 그래픽카드 글이 남는다', show(r));
}

console.log('\n목록이 통째로 비게 되면 빼지 않는다 (예전보다 결과가 줄지 않는다)');
{
  const r = rank('16 ah1075tx', ['올가드 보습 스파 핸드 마스크 16g', '[면세점/약국판매] 네오메디컬 프리미엄 실버치약 165g']);
  check(r.items.length === 2, '16 ah1075tx: 전부 숫자 조각 연결이어도 목록은 그대로다', show(r));
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
  check(!has(r, '핸드 마스크') && !has(r, '액티비아'), 'minScore 0.3: 0점과 0.25점이 모두 빠진다', show(r));
  check(has(r, 'SIM 카드'), 'minScore 0.3: 0.5점은 남는다(기존 기준 그대로)');
}

console.log(`\nZero-coverage filter: ${pass}/${pass + fail} PASS, ${fail} FAIL. External calls: 0. DB queries: 0.`);
process.exit(fail ? 1 : 0);
