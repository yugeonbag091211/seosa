-- 2026-08-26  ADPICK BIZ 연동 — 검색 캐시 테이블
--
-- 쿠팡(supabase/coupang-quota.sql 의 coupang_search_cache)과 같은 이유로 캐시를
-- 둔다: 같은 키워드를 반복 조회할 때마다 ADPICK API를 부르면 호출량이 필요
-- 이상으로 늘고, 응답이 늦으면 검색 자체가 느려진다. 구조도 그대로 따온다.
--
-- ADPICK은 products / price_history 에 새 컬럼을 요구하지 않는다.
--   - 몰 구분        products.mall = 'ADPICK'  (상수, 기존 컬럼 그대로)
--                    cp_code는 넣지 않는다 — product_id가 이미 commissionlink 전체를
--                    해시한 값이라 cp_code가 다르면 product_id 자체가 달라진다.
--   - 상품 식별자    products.product_id = sha256(commissionlink)  (기존 컬럼 그대로)
--   - 옵션 식별자    item_id / vendor_item_id 는 빈 문자열로 둔다 (ADPICK 응답에
--                    옵션 개념이 없다 — api/_price.js vendorIdOf/itemIdOf가
--                    빈 값을 그대로 받아들이므로 별도 처리가 필요 없다)
--
-- ※ create if not exists / alter add if not exists 뿐이라 몇 번 실행해도 안전하다.
--   기존 products / price_history / coupang_* 테이블은 건드리지 않는다.

create table if not exists adpick_search_cache (
  keyword    text        primary key,
  items      jsonb       not null default '[]'::jsonb,
  req_limit  int         not null default 0,
  fetched_at timestamptz not null default now()
);

-- service_role(서버) 이 아니면 접근하지 못하게 한다. coupang_search_cache와 같은 정책.
alter table adpick_search_cache enable row level security;

-- 방금 만든 테이블을 PostgREST가 바로 알아보게 한다.
notify pgrst, 'reload schema';
