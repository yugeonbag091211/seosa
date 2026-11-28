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

console.log('\n13. ★ 실사용 반례(2026-11-27, Codex 운영 확인) — "서큘레이터"도 전자기기로 걸러진다');
{
  // "서큘레이터 S11 슬림핏" 검색에 아이라이너·다이어트 보조제가 섞여 나왔다.
  // 원인은 "서큘레이터"가 QUERY_CATEGORY_HINTS 에 아예 없어서 가드가
  // "모른다"고 보고 적용 안 된 것 — 다른 전자기기 키워드들처럼 사전에
  // 추가해서 막는다.
  check('"서큘레이터" → 전자기기', expectedCategory(analyzeQuery('서큘레이터')) === '전자기기');
  check('"선풍기" → 전자기기', expectedCategory(analyzeQuery('선풍기')) === '전자기기');

  const items = [
    { productId: '1', title: '신일 서큘레이터 S11 슬림핏 무선 선풍기' },
    { productId: '2', title: '오띠 슬림핏 드로잉 펜슬 아이라이너 (블랙) 0.12g' },
    { productId: '3', title: '데일리 슬림핏 다이어트&유산균 3.5g x 30포' }
  ];
  const categoryMap = new Map([['1', '전자기기'], ['2', '뷰티'], ['3', '식품']]);
  const r = filterByCategory('서큘레이터 S11 슬림핏', items, categoryMap);
  check('적용됨(applied)', r.applied === true, r);
  check('진짜 서큘레이터만 남음', r.kept.length === 1 && r.kept[0].productId === '1', r.kept);
  check('아이라이너·유산균 2건은 제외됨', r.dropped.length === 2, r.dropped);
}

console.log('\n14. ★ 운영 실측(2026-11-28) — 분류기는 생활가전을 «생활용품» 으로 매긴다');
{
  // 운영 «가습기» 검색에서 본품(product_kind=main) 12건이 category=생활용품 이라 숨겨졌다.
  // 기대가 전자기기여도 생활용품은 이웃 카테고리로 보고 남긴다. 완전히 다른 것(도서)은 여전히 거른다.
  const items = [
    { productId: '1', title: '홈플래닛 초음파 가습기 4L' },
    { productId: '2', title: '[LG] LG전자 퓨리케어 자연기화 가습기 HW300BBB' },
    { productId: '3', title: '[국내도서] 가습기 살균제 참사의 기록' }
  ];
  const categoryMap = new Map([['1', '생활용품'], ['2', '전자기기'], ['3', '도서문구']]);
  const r = filterByCategory('가습기', items, categoryMap);
  check('생활용품 가습기 본품이 남는다', r.kept.some(it => it.productId === '1'), r.kept);
  check('도서는 여전히 제외', r.dropped.length === 1 && r.dropped[0].productId === '3', r.dropped);
}
{
  const items = [
    { productId: '1', title: '드럼세탁기세제 앨지 테크 베이킹소다 구연산 액체세제 2L' },
    { productId: '2', title: '[해외] 60cm 버팔로 드럼 스킨 페인트 라틴' },
    { productId: '3', title: 'LG전자 트롬 드럼 세탁기 21kg FX21WSQ' }
  ];
  const categoryMap = new Map([['1', '생활용품'], ['2', '완구취미'], ['3', '전자기기']]);
  const r = filterByCategory('드럼 세탁기 세제', items, categoryMap);
  check('«드럼 세탁기 세제» 에서 세제(생활용품)가 남는다', r.kept.some(it => it.productId === '1'), r.kept);
  check('악기 드럼 스킨(완구취미)은 여전히 제외', r.dropped.length === 1 && r.dropped[0].productId === '2', r.dropped);
}
{
  const items = [
    { productId: '1', title: '요넥스 배드민턴 가방 3단 라켓백' },
    { productId: '2', title: '요넥스 배드민턴 백팩 가방 BA26' },
    { productId: '3', title: '[국내도서] 배드민턴 교본' }
  ];
  const categoryMap = new Map([['1', '스포츠레저'], ['2', '패션잡화'], ['3', '도서문구']]);
  const r = filterByCategory('배드민턴 가방', items, categoryMap);
  check('«배드민턴 가방» 의 스포츠레저 가방을 거르지 않는다', r.kept.some(it => it.productId === '1'), r);
  check('도서는 여전히 제외', r.dropped.length === 1 && r.dropped[0].productId === '3', r.dropped);
}

console.log('\n15. 뜻이 갈리는 낱말은 사전의 단독 키가 아니다 (운영 일치율 0~22%)');
check('"쿠션" 단독 키 없음 (쿠션 파운데이션 / 방석·목쿠션)', !QUERY_CATEGORY_HINTS.has('쿠션'));
check('"트렁크" 단독 키 없음 (여행 트렁크 / 차량 트렁크 정리함)', !QUERY_CATEGORY_HINTS.has('트렁크'));
check('"신발" 단독 키 없음 (신발 정리대·방향제)', !QUERY_CATEGORY_HINTS.has('신발'));
check('"화장품" 단독 키 없음 (화장품 파우치·정리대)', !QUERY_CATEGORY_HINTS.has('화장품'));

console.log('\n16. ★ 운영 재앙(2026-11-28, Codex 118건 재생) — 이웃 하나가 would-empty 를 풀어 본품 덩어리가 숨겨지던 문제');
{
  // «에어 매트리스»: 사전은 매트리스→가구인테리어. 그러나 운영 상품 대부분이
  // 스포츠레저(캠핑 에어매트)로 분류된다. 생활용품(가구인테리어의 이웃) 하나가
  // kept 로 통과하면서 would-empty 가 풀리고, 스포츠레저 본품 8개가 통째로 숨겨졌다.
  // 기대(가구인테리어)를 직접 확증하는 상품도, 판단 보류 상품도 없으므로 물러나야 한다.
  const items = [
    ...Array.from({ length: 8 }, (_, i) => ({ productId: `s${i}`, title: `인텍스 에어매트리스 더블 ${i}` })),
    { productId: 'n1', title: '에어매트리스 커버 생활용품' }
  ];
  const categoryMap = new Map([
    ...items.slice(0, 8).map(it => [it.productId, '스포츠레저']),
    ['n1', '생활용품']
  ]);
  const r = filterByCategory('에어 매트리스', items, categoryMap);
  check('적용 안 됨(compatible-only) — 이웃만 남아 있으면 물러난다', r.applied === false && r.reason === 'compatible-only', r);
  check('스포츠레저 본품 8개가 전부 보존된다', r.kept.length === 9, { kept: r.kept.length });
}
{
  // «스마트폰 장갑»: 사전이 수식어 «스마트폰»(전자기기)을 집는다. 진짜 상품은 장갑
  // (의류/스포츠)이다. 생활용품으로 분류된 장갑 하나가 이웃으로 통과하면, 나머지
  // 의류·스포츠 장갑 본품이 숨겨진다 — 정확 확증·판단 보류가 없으므로 물러나야 한다.
  const items = [
    ...Array.from({ length: 6 }, (_, i) => ({ productId: `g${i}`, title: `터치 스마트폰 장갑 겨울 ${i}` })),
    { productId: 'n1', title: '스마트폰 장갑 보관함' }
  ];
  const categoryMap = new Map([
    ...items.slice(0, 3).map(it => [it.productId, '패션의류']),
    ...items.slice(3, 6).map(it => [it.productId, '스포츠레저']),
    ['n1', '생활용품']
  ]);
  const r = filterByCategory('스마트폰 장갑', items, categoryMap);
  check('적용 안 됨(compatible-only)', r.applied === false && r.reason === 'compatible-only', r);
  check('의류·스포츠 장갑 본품 6개가 보존된다', r.kept.length === 7, { kept: r.kept.length });
}
{
  // «소파 보호 패드 고양이»: 사전이 수식어 «소파»(가구인테리어)를 집는다. 진짜 상품은
  // 반려동물용 보호 패드다. 가구인테리어의 이웃(생활용품) 하나만 통과하고 정확 확증이
  // 없으면 물러난다 — 반려동물용품 본품을 지키지 않던 버그.
  const items = [
    { productId: 'p1', title: '고양이 소파 스크래치 방지 보호 패드 1' },
    { productId: 'p2', title: '고양이 소파 보호 패드 투명 2' },
    { productId: 'n1', title: '소파 보호 패드 생활용품 커버' }
  ];
  const categoryMap = new Map([['p1', '반려동물용품'], ['p2', '반려동물용품'], ['n1', '생활용품']]);
  const r = filterByCategory('소파 보호 패드 고양이', items, categoryMap);
  check('적용 안 됨(compatible-only)', r.applied === false && r.reason === 'compatible-only', r);
  check('반려동물용품 본품 2건이 보존된다', r.kept.length === 3, { kept: r.kept.length });
}

console.log('\n17. 정확 확증 상품이 하나라도 있으면 기존대로 거른다 (16의 물러남이 과하지 않음을 고정)');
{
  // 가전은 대부분 생활용품(이웃)이지만, 분류 전 신상품(모름) 하나가 섞이면 «판단 보류»가
  // 있으므로 가드가 계속 동작한다 — 완전히 다른 도서를 걸러낸다. (compatible-only 는
  // 오직 «이웃만» 남는 좁은 경우에만 물러난다는 것을 고정.)
  const items = [
    { productId: '1', title: '홈플래닛 초음파 가습기 4L' },        // 생활용품(이웃)
    { productId: '2', title: '막 등록돼 아직 분류 안 된 가습기 신상품' }, // 모름(판단 보류)
    { productId: '3', title: '[국내도서] 가습기 살균제 참사의 기록' }  // 도서문구(완전히 다름)
  ];
  const categoryMap = new Map([['1', '생활용품'], ['3', '도서문구']]); // 2번은 일부러 지도에 없음(모름)
  const r = filterByCategory('가습기', items, categoryMap);
  check('적용됨 — 판단 보류가 있으면 이웃만이어도 동작', r.applied === true, r);
  check('도서만 제외', r.dropped.length === 1 && r.dropped[0].productId === '3', r.dropped);
  check('가습기 본품과 신상품은 남는다', r.kept.length === 2, r.kept);
}

const passed = checks.filter(c => c.pass).length;
const failed = checks.length - passed;
console.log(`\n${'='.repeat(60)}\n검색 카테고리 안전망 테스트: ${passed} PASS / ${failed} FAIL\n${'='.repeat(60)}`);
if (failed) process.exit(1);
