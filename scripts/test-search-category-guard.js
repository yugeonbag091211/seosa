#!/usr/bin/env node
/*
 * api/_search-category-guard.js 회귀 테스트 — 실제 Supabase/OpenAI 호출 0회.
 * api/_search-type-guard.js 테스트와 같은 정신: "본품이 절대 사라지면 안 된다"
 * 를 "카테고리를 모르면 절대 손대면 안 된다"로 그대로 가져온다.
 */
'use strict';

const { filterByCategory, expectedCategory, QUERY_CATEGORY_HINTS } = require('../api/_search-category-guard');
const { analyzeQuery } = require('../api/_search');

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, pass: !!cond });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`, cond ? '' : JSON.stringify(detail));
}

console.log('1. expectedCategory — "그래픽카드"는 전자기기');
check('전자기기로 판정', expectedCategory(analyzeQuery('그래픽카드')) === '전자기기');

console.log('\n2. expectedCategory — 사전에 없는 검색어는 모른다(null)');
check('null 반환', expectedCategory(analyzeQuery('아무말대잔치이상한검색어')) === null);

console.log('\n3. ★ 실사용 반례 — "그래픽카드" 검색에서 글자만 겹친 옷을 카테고리로 걸러낸다');
{
  const items = [
    { productId: '1', title: 'RTX 4070 그래픽카드 지포스 게이밍 PC용' },
    { productId: '2', title: '오픈런 아토가토 그래픽 맨투맨뒤면 게임 트럼프카드 니트패턴' },
    { productId: '3', title: '루이비통 1AHCN1 블랙 모노그램 그래픽 자카드 익스플로러 남성 후드티셔츠' }
  ];
  const categoryMap = new Map([['1', '전자기기'], ['2', '패션의류'], ['3', '패션의류']]);
  const r = filterByCategory('그래픽카드', items, categoryMap);
  check('적용됨(applied)', r.applied === true, r);
  check('진짜 GPU만 남음', r.kept.length === 1 && r.kept[0].productId === '1', r.kept);
  check('옷 2건은 제외됨', r.dropped.length === 2, r.dropped);
  check('기대 카테고리는 전자기기', r.queryCategory === '전자기기');
}

console.log('\n4. 상품 후보가 2건 미만이면 적용하지 않는다');
{
  const r = filterByCategory('그래픽카드', [{ productId: '1', title: 'RTX 4070' }], new Map([['1', '전자기기']]));
  check('적용 안 됨(too-few)', r.applied === false && r.reason === 'too-few', r);
}

console.log('\n5. 카테고리 캐시가 아예 비어 있으면(배치가 아직 아무것도 안 했으면) 적용하지 않는다');
{
  const items = [{ productId: '1', title: 'A' }, { productId: '2', title: 'B' }];
  const r = filterByCategory('그래픽카드', items, new Map());
  check('적용 안 됨(too-few, 캐시 없음도 포함)', r.applied === false, r);
  check('원본 그대로', r.kept === items);
}

console.log('\n6. 검색어의 기대 카테고리를 모르면(사전에 없음) 아무 것도 거르지 않는다');
{
  const items = [{ productId: '1', title: 'A' }, { productId: '2', title: 'B' }];
  const categoryMap = new Map([['1', '전자기기'], ['2', '패션의류']]);
  const r = filterByCategory('완전히낯선검색어', items, categoryMap);
  check('적용 안 됨(unknown-query-category)', r.applied === false && r.reason === 'unknown-query-category', r);
  check('둘 다 그대로 kept', r.kept.length === 2);
}

console.log('\n7. 상품의 카테고리를 모르는 건(아직 배치가 못 봄) 그대로 둔다');
{
  const items = [
    { productId: '1', title: 'RTX 4070 그래픽카드' },
    { productId: '2', title: '아직 분류 안 된 신상품' } // categoryMap에 없음
  ];
  const categoryMap = new Map([['1', '전자기기']]);
  const r = filterByCategory('그래픽카드', items, categoryMap);
  check('적용 안 됨(걸러낼 게 없음)', r.applied === false && r.reason === 'nothing-to-drop', r);
  check('둘 다 유지', r.kept.length === 2, r.kept);
}

console.log('\n8. GPT가 "unknown"(애매하다)으로 답한 상품도 안전하게 그대로 둔다');
{
  const items = [
    { productId: '1', title: 'RTX 4070 그래픽카드' },
    { productId: '2', title: '애매한 상품' }
  ];
  const categoryMap = new Map([['1', '전자기기'], ['2', 'unknown']]);
  const r = filterByCategory('그래픽카드', items, categoryMap);
  check('unknown은 걸러내지 않음', r.applied === false && r.reason === 'nothing-to-drop', r);
}

console.log('\n9. 전부 다른 카테고리로 판정되면(가드 오판 가능성) 적용하지 않는다 — would-empty 안전장치');
{
  const items = [
    { productId: '1', title: '트럼프카드 맨투맨' },
    { productId: '2', title: '자카드 후드티' }
  ];
  const categoryMap = new Map([['1', '패션의류'], ['2', '패션의류']]);
  const r = filterByCategory('그래픽카드', items, categoryMap);
  check('적용 안 됨(would-empty)', r.applied === false && r.reason === 'would-empty', r);
  check('원본 그대로 다 남음(한 건도 안 버림)', r.kept.length === 2, r.kept);
}

console.log('\n10. 검색어 안에 서로 다른 카테고리를 가리키는 토큰이 섞이면(애매함) 적용하지 않는다');
{
  // "그래픽카드"(전자기기) + 패션 신호가 될 만한 토큰이 섞인 가상의 경우를
  // expectedCategory 레벨에서 직접 확인한다 — 실제 사전에 이런 충돌 쌍은
  // 아직 없지만, 로직 자체가 안전한지(2건 이상이면 null) 검증해 둔다.
  const fakeAnalysis = { tokens: [{ text: '그래픽카드' }, { text: '맨투맨' }] };
  check('서로 다른 카테고리 2개 → null(애매함)', expectedCategory(fakeAnalysis) === null);
}

console.log('\n11. 판정 함수가 예외를 던져도 검색 자체는 안 죽는다');
{
  const items = [{ productId: '1', title: 'A' }, { productId: '2', title: 'B' }];
  const categoryMap = new Map([['1', '전자기기'], ['2', '패션의류']]);
  const brokenAnalyzeQuery = () => { throw new Error('분석기 사고'); };
  const r = filterByCategory('그래픽카드', items, categoryMap, { analyzeQuery: brokenAnalyzeQuery });
  check('적용 안 됨(error), 원본 그대로', r.applied === false && r.reason === 'error' && r.kept === items, r);
}

console.log('\n12. 사전 자체는 애매한 한 글자짜리 키를 담지 않는다 (오늘 버그의 재발 방지)');
{
  // "카드" 하나만으로는 그래픽카드인지 트럼프카드인지 알 수 없다 — 이런 짧고
  // 흔한 조각을 단독 키로 넣는 순간 오늘과 똑같은 종류의 사고가 재발한다.
  check('"카드" 단독 키 없음', !QUERY_CATEGORY_HINTS.has('카드'));
  check('"워치" 단독 키 없음', !QUERY_CATEGORY_HINTS.has('워치'));
  check('"케이스" 단독 키 없음 (전자기기/잡화 둘 다 쓰임)', !QUERY_CATEGORY_HINTS.has('케이스'));
}

const passed = checks.filter(c => c.pass).length;
const failed = checks.length - passed;
console.log(`\n${'='.repeat(60)}\n검색 카테고리 안전망 테스트: ${passed} PASS / ${failed} FAIL\n${'='.repeat(60)}`);
if (failed) process.exit(1);
