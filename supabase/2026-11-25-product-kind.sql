-- "본품 vs 부속" GPT 1회 분류 결과를 상품마다 캐싱한다 (api/_product-kind-classifier.js).
-- product_id 당 평생 한 번만 분류하고, 그 결과를 여기 저장해 재호출을 막는다.
-- 값이 없으면(null) "아직 안 물어봤다" 는 뜻이지 "본품이다" 가 아니다 — 안전 기본값은
-- 호출부(api/_shop.js classifyNewProductKinds)가 null/unknown 을 "모른다"로 다룬다.

alter table public.products
  add column if not exists product_kind text;

comment on column public.products.product_kind is
  'GPT 1회 분류 결과: main | accessory | unknown | null(아직 분류 안 함). '
  '검색어와 무관하게 상품 자체의 성격 — api/_product-kind-classifier.js 참고.';
