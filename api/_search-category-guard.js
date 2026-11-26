'use strict';
/*
 * 검색어 카테고리 vs 상품 카테고리 안전망.
 *
 * ── 왜 필요한가 (2026-11-26) ─────────────────────────────────────────
 *
 * "그래픽카드" 를 검색하면 진짜 GPU 말고도 "그래픽 맨투맨 ... 트럼프카드"
 * 같은 옷이 섞여 들어왔다. 원인은 api/_search.js 의 글자 매칭(tokenQuality)이
 * "그래픽"·"카드" 두 조각이 제목 어디에든 있으면 거의 일치로 쳐준 것이었고,
 * 그건 오늘 고쳤다(PR #277). 하지만 한국어는 단어 경계 표시가 없어서,
 * 아무리 글자 매칭 규칙을 촘촘히 짜도 "우연히 글자가 겹치는" 새로운 경우가
 * 또 나올 수 있다 — 끝없는 두더지 잡기다.
 *
 * 그래서 글자가 아니라 "이게 같은 종류의 물건인가" 를 보는 독립적인 두
 * 번째 안전망을 둔다: 상품마다 GPT로 한 번 매긴 대분류 카테고리
 * (api/_category-classifier.js, products.category)와, 검색어에서 뽑아낸
 * "기대 카테고리"가 완전히 다르면 — 글자 점수가 아무리 높아도 — 걸러낸다.
 *
 * ── 검색어의 "기대 카테고리" 는 어떻게 아는가 ───────────────────────
 *
 * 매 검색마다 GPT를 부르지 않는다(느려진다). 대신 자주 쓰는 구체적인
 * 상품명 → 카테고리 사전(QUERY_CATEGORY_HINTS)을 둔다. 여기 없는 검색어는
 * "모른다" — 가드를 적용하지 않고 기존 글자 매칭 그대로 통과시킨다
 * (안전 기본값, api/_search-type-guard.js 와 같은 원칙). "카드"처럼 혼자서는
 * 여러 카테고리에 걸치는 애매한 조각은 절대 이 사전의 단독 키로 넣지
 * 않는다 — 그게 애초에 오늘 버그의 원인이었다(짧고 흔한 조각으로 추측하는 것).
 *
 * ── 안전장치 ─────────────────────────────────────────────────────
 * - 검색어 카테고리를 모르면 적용 안 함.
 * - 상품 카테고리를 모르면(아직 배치가 못 본 상품) 그 상품은 그대로 둔다.
 * - 전부 걸러지면(가드 오판 가능성) 적용하지 않는다 — _search-type-guard.js
 *   와 같은 안전장치.
 */

/**
 * 구체적인 상품명 → 대분류 카테고리. 애매한 한두 글자 조각은 절대 넣지
 * 않는다 — 검색어 전체(정규화된 토큰 하나)가 그대로 일치할 때만 쓴다.
 * api/_search.js 의 SYNONYM_GROUPS 와 같은 정신으로, 새 충돌 사례가
 * 나올 때마다 여기 추가한다.
 */
const QUERY_CATEGORY_HINTS = new Map(Object.entries({
  // 전자기기
  '그래픽카드': '전자기기', '지포스': '전자기기', '라데온': '전자기기',
  '노트북': '전자기기', '랩탑': '전자기기', '맥북': '전자기기',
  '스마트폰': '전자기기', '휴대폰': '전자기기', '핸드폰': '전자기기', '아이폰': '전자기기',
  '태블릿': '전자기기', '아이패드': '전자기기', '갤럭시탭': '전자기기',
  '이어폰': '전자기기', '이어버드': '전자기기', '버즈': '전자기기', '헤드폰': '전자기기', '헤드셋': '전자기기',
  '마우스': '전자기기', '키보드': '전자기기', '모니터': '전자기기',
  '스마트워치': '전자기기', '청소기': '전자기기', '세탁기': '전자기기', '냉장고': '전자기기',
  '건조기': '전자기기', '에어컨': '전자기기', '공기청정기': '전자기기', '가습기': '전자기기', '제습기': '전자기기',
  '충전기': '전자기기', '보조배터리': '전자기기', '카메라': '전자기기', '그램': '전자기기',
  // 패션의류
  '맨투맨': '패션의류', '후드티': '패션의류', '후드티셔츠': '패션의류', '티셔츠': '패션의류',
  '니트': '패션의류', '자켓': '패션의류', '코트': '패션의류', '바지': '패션의류', '청바지': '패션의류',
  '원피스': '패션의류', '스커트': '패션의류', '패딩': '패션의류', '가디건': '패션의류', '조끼': '패션의류',
  // 패션잡화
  '가방': '패션잡화', '백팩': '패션잡화', '크로스백': '패션잡화', '지갑': '패션잡화',
  '벨트': '패션잡화', '모자': '패션잡화', '신발': '패션잡화', '운동화': '패션잡화', '구두': '패션잡화',
  '캐리어': '패션잡화', '여행가방': '패션잡화', '트렁크': '패션잡화',
  // 뷰티
  '화장품': '뷰티', '스킨': '뷰티', '로션': '뷰티', '선크림': '뷰티', '향수': '뷰티', '퍼퓸': '뷰티',
  '립스틱': '뷰티', '쿠션': '뷰티', '파운데이션': '뷰티',
  // 식품
  '원두': '식품', '라면': '식품', '과자': '식품', '영양제': '식품', '비타민': '식품',
  // 가구인테리어
  '침대': '가구인테리어', '매트리스': '가구인테리어', '소파': '가구인테리어', '책상': '가구인테리어', '의자': '가구인테리어',
  // 스포츠레저
  '자전거': '스포츠레저', '텐트': '스포츠레저', '골프채': '스포츠레저', '요가매트': '스포츠레저', '덤벨': '스포츠레저',
  // 반려동물용품
  '강아지사료': '반려동물용품', '고양이사료': '반려동물용품', '배변패드': '반려동물용품', '하네스': '반려동물용품',
  // 도서문구
  '다이어리': '도서문구', '볼펜': '도서문구'
}));

/**
 * 검색어에서 "기대 카테고리"를 뽑는다. 여러 토큰이 서로 다른 카테고리를
 * 가리키면(드묾) 애매하다고 보고 null — 섣불리 거르지 않는다.
 *
 * @param {object} analysis  S.analyzeQuery() 결과
 * @returns {string|null}
 */
function expectedCategory(analysis) {
  const tokens = (analysis && Array.isArray(analysis.tokens)) ? analysis.tokens : [];
  const found = new Set();
  for (const t of tokens) {
    const cat = QUERY_CATEGORY_HINTS.get(t.text);
    if (cat) found.add(cat);
  }
  if (found.size === 1) return [...found][0];
  return null; // 모르거나(0건) 애매함(2건 이상) — 적용하지 않는다.
}

/**
 * 검색어 카테고리와 완전히 다른 카테고리의 상품을 걸러낸다.
 *
 * @param {string} keyword
 * @param {Array} items  후보 상품 (각 항목은 productId 를 갖는다)
 * @param {Map<string,string>} categoryMap  productId -> category (api/_category-store.lookupCategories 결과)
 * @param {object} [opts]
 * @param {Function} [opts.analyzeQuery]  주입 가능 — 테스트용. 기본은 _search.analyzeQuery.
 * @returns {{kept: Array, dropped: Array, applied: boolean, reason: string, queryCategory: string|null}}
 */
function filterByCategory(keyword, items, categoryMap, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const cats = categoryMap instanceof Map ? categoryMap : new Map();

  if (list.length < 2 || !String(keyword || '').trim() || !cats.size) {
    return { kept: list, dropped: [], applied: false, reason: 'too-few', queryCategory: null };
  }

  const analyzeQuery = opts.analyzeQuery || require('./_search').analyzeQuery;
  let queryCategory;
  try {
    queryCategory = expectedCategory(analyzeQuery(keyword));
  } catch (e) {
    console.warn(`[category-guard:${keyword}] 검색어 카테고리 판정 실패(가드 생략): ${e.message}`);
    return { kept: list, dropped: [], applied: false, reason: 'error', queryCategory: null };
  }

  if (!queryCategory) {
    return { kept: list, dropped: [], applied: false, reason: 'unknown-query-category', queryCategory: null };
  }

  const kept = [], dropped = [];
  list.forEach(it => {
    const productCategory = cats.get(String(it && it.productId));
    // 상품 카테고리를 모르거나(아직 배치가 못 봄) GPT가 애매하다고 했으면
    // (unknown) 그대로 둔다 — 안전 기본값.
    const mismatched = productCategory && productCategory !== 'unknown' && productCategory !== queryCategory;
    (mismatched ? dropped : kept).push(it);
  });

  if (!dropped.length) {
    return { kept: list, dropped: [], applied: false, reason: 'nothing-to-drop', queryCategory };
  }

  if (!kept.length) {
    console.warn(
      `[category-guard:${keyword}] 후보 ${list.length}건이 모두 카테고리 불일치로 판정`
      + ` — 가드를 적용하지 않습니다 (기대: ${queryCategory})`
    );
    return { kept: list, dropped: [], applied: false, reason: 'would-empty', queryCategory };
  }

  console.log(
    `[category-guard:${keyword}] 카테고리 불일치 ${dropped.length}건 제외 (기대: ${queryCategory}, ${kept.length}건 유지)`
    + ` — ${dropped.slice(0, 3).map(d => String((d && d.title) || '').slice(0, 24)).join(' | ')}`
  );
  return { kept, dropped, applied: true, reason: 'filtered', queryCategory };
}

module.exports = { filterByCategory, expectedCategory, QUERY_CATEGORY_HINTS };
