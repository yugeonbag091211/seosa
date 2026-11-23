#!/usr/bin/env node
'use strict';

/*
 * 범주어 검색이 «한 건» 때문에 브랜드 검색으로 뒤집히지 않는다.
 *
 * ── 왜 생겼나 (2026-11-23 전수 감사, 운영 실측) ──────────────────────
 *
 * 운영 /api/search?keyword=운동화 의 1위가 신발이 아니라 책이었다.
 *
 *     1위  14,400원  [국내도서] 운동화 신은 뇌            relevance 1.00
 *     2위  11,900원  이더커머스 남성 발편한 가벼운 운동화   relevance 0.65
 *     …    (실제 운동화 19건이 전부 0.65)
 *
 * 원인은 점수표가 아니라 «검색 의도» 판정이다. analyzeQuery 의 primaryHead 는
 * 받아온 상품명 중 머리 토큰으로 시작하는 것이 «하나라도» 있으면 그 검색어를
 * 브랜드/대표 머리 질의로 본다. 그 하나가 바로 저 책이었다 —
 * identityTokens 가 ["운동화","신은","뇌"] 라 머리로 시작한다.
 *
 * 토큰이 하나뿐이면 intent 는 BRAND_ONLY 가 되고, titleRelation 의 late-head
 * 규칙이 «머리 토큰이 3번째 이후에 나오는» 제목에 0.65를 곱한다. 한국어 상품명은
 * 범주어가 맨 뒤에 온다(«… 가벼운 운동화»). 그래서 진짜 상품만 전부 감점되고,
 * 범주어로 시작한 책 한 권만 1.00 으로 남았다.
 *
 * ── 무엇을 고정하나 ──────────────────────────────────────────────────
 *
 * 상품명 한 건은 검색 의도의 근거가 되지 못한다는 것. 브랜드 검색(«삼성» 등)은
 * 여러 상품명이 그 말로 시작하므로 영향을 받지 않는다 —
 * scripts/test-search-ranking-intent.js 의 brands 픽스처가 그쪽을 지킨다.
 *
 * 외부 호출·DB 조회 0. 상품명은 2026-11-23 운영 응답에서 그대로 가져왔다.
 */

const S = require('../api/_search');

let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); return; }
  fail++;
  console.log(`  FAIL  ${label}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
}

function rank(query, titles) {
  const items = titles.map((title, i) => ({ title, lprice: 10000 + i * 100, productId: 'p' + i }));
  const result = S.rankItems(query, items, { minScore: 0 });
  return S.sortByRelevance(result.items);
}
function rel(ranked, titleFragment) {
  const hit = ranked.find(it => it.title.indexOf(titleFragment) > -1);
  return hit ? hit.relevance : null;
}
function detail(ranked) {
  return ranked.map(it => `${it.relevance}:${(it.relevanceWhy || '-')}:${it.title.slice(0, 40)}`);
}

/* 2026-11-23 운영 /api/search?keyword=운동화 응답에서 가져온 상품명. */
const BOOK = '[국내도서] 운동화 신은 뇌';
const SNEAKERS = [
  '이더커머스 남성 발편한 가벼운 운동화',
  '디아핏 가벼운 발편한 남성 런닝화 운동화',
  '아디다스 바레다 로우 운동화 KI6726',
  'JLVJ 여성 운동화 가벼운 스니커즈 데일리 런닝화',
  '뉴발란스/뉴발란스 2002 남여공용 운동화 네이비 M2002WA/스니커즈 스니커즈'
];

console.log('\n범주어 검색: 머리로 시작하는 상품명 한 건이 의도를 뒤집지 않는다');
{
  const titles = [BOOK, ...SNEAKERS];
  const analysis = S.analyzeQuery('운동화', { titles: titles.map(t => S.analyzeTitle(t)) });
  check(analysis.intent !== 'BRAND_ONLY',
    '운동화: 상품명 한 건으로 BRAND_ONLY 가 되지 않는다', { intent: analysis.intent });

  const ranked = rank('운동화', titles);
  for (const sneaker of SNEAKERS) {
    check(rel(ranked, sneaker.slice(0, 10)) >= rel(ranked, '운동화 신은 뇌'),
      `운동화: «${sneaker.slice(0, 14)}» 가 책보다 낮지 않다`, detail(ranked));
  }
  check(ranked.every(it => !String(it.relevanceWhy || '').includes('late-head')),
    '운동화: 진짜 상품에 late-head 감점이 걸리지 않는다', detail(ranked));
}

console.log('\n같은 목록에서 그 한 건을 빼도 나머지 점수는 그대로다');
{
  const withBook = rank('운동화', [BOOK, ...SNEAKERS]);
  const without = rank('운동화', SNEAKERS);
  for (const sneaker of SNEAKERS) {
    const key = sneaker.slice(0, 10);
    check(rel(withBook, key) === rel(without, key),
      `운동화: «${sneaker.slice(0, 14)}» 점수가 책의 유무와 무관하다`,
      { with: rel(withBook, key), without: rel(without, key) });
  }
}

console.log('\n여러 상품명이 머리로 시작하는 브랜드 검색은 그대로 브랜드 검색이다');
{
  /* 머리 토큰이 상품명 여러 건의 맨 앞에 오는 것이 브랜드의 특징이다
   * (detectBrandHead 주석). 그 경우에는 의도 판정이 달라지지 않아야 한다. */
  const titles = [
    '삼성전자 갤럭시 S26 자급제 SM-S942N',
    '삼성전자 갤럭시 A37 자급제 SM-A376N',
    '삼성전자 갤럭시북6 노트북',
    '[해외] JC97-04574A HP LaserJet Managed 삼성 K7 시리즈용 레이저 스캐너 어셈블리',
    'ABC 삼성 프린터용 호환 토너 카트리지'
  ];
  const analysis = S.analyzeQuery('삼성', { titles: titles.map(t => S.analyzeTitle(t)) });
  check(analysis.intent === 'BRAND_ONLY',
    '삼성: 여러 상품명이 머리로 시작하면 BRAND_ONLY 를 유지한다', { intent: analysis.intent });

  const ranked = rank('삼성', titles);
  check(ranked[0].title.indexOf('삼성전자') === 0,
    '삼성: 본품이 호환 부속보다 위에 있다', detail(ranked));
  check(rel(ranked, '레이저 스캐너') < rel(ranked, '갤럭시 S26'),
    '삼성: 늦게 언급된 호환 부속은 여전히 아래다', detail(ranked));
}

console.log(`\nCategory-head intent: ${pass}/${pass + fail} PASS, ${fail} FAIL. External calls: 0. DB queries: 0.`);
process.exit(fail ? 1 : 0);
