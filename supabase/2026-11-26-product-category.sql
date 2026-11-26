-- "검색어 vs 상품 카테고리" 안전망(api/_category-classifier.js)을 위해
-- 상품마다 GPT 1회 분류한 대분류 카테고리를 캐싱한다. product_kind와 똑같은
-- 패턴: product_id 당 평생 한 번만 분류하고, 검색어와 무관한 "상품 자체의
-- 성격" 이라 캐싱해도 안전하다 (2026-11-25-product-kind.sql 참고).
--
-- 값이 없으면(null) "아직 안 물어봤다" 는 뜻이지 특정 카테고리가 아니다 —
-- 호출부(api/_search-category-guard.js)는 null/unknown 을 "모른다"로 다루고
-- 가드를 적용하지 않는다(안전 기본값).

alter table public.products
  add column if not exists category text;

comment on column public.products.category is
  'GPT 1회 분류 결과: 전자기기 | 패션의류 | 패션잡화 | 뷰티 | 식품 | '
  '생활용품 | 가구인테리어 | 스포츠레저 | 완구취미 | 반려동물용품 | '
  '도서문구 | 여행티켓 | 기타 | unknown | null(아직 분류 안 함). '
  '검색어와 무관하게 상품 자체의 대분류 — api/_category-classifier.js 참고. '
  '"그래픽카드" 검색에 "트럼프카드" 맨투맨이 글자만 겹쳐서 섞여 들어오는 것을 '
  '막는 두 번째 안전망(api/_search-category-guard.js)에 쓴다.';
