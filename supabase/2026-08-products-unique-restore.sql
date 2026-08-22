-- ══════════════════════════════════════════════════════════════════
--  2026-08-16  products UNIQUE 복원 — 일일 가격 갱신 정지 장애 복구
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 붙여넣고 Run.
--
--  안전성
--    - DELETE / TRUNCATE / UPDATE 없음. 제약 추가 하나뿐이다.
--    - 몇 번을 실행해도 안전하다 (pg_constraint 존재 확인).
--    - 사전 확인: 2026-08-16 기준 products 810행,
--      distinct (product_id, mall) 810 → 중복 0건. 바로 적용 가능하다.
--
--  ── 무엇이 고장났었나 ────────────────────────────────────────────
--
--  2026-08-14 에 2026-08-vendor-identity.sql 의 Phase 2b 가 products 의
--  UNIQUE 를 (product_id, mall) 에서 (product_id, mall, vendor_item_id) 로
--  바꿨다. 그런데 배포된 api/_shop.js 는 계속
--    upsert(rows, { onConflict: 'product_id,mall' })
--  로 저장하고 있었다. 대응하는 제약이 없으니 Postgres 가
--    42P10  there is no unique or exclusion constraint matching
--           the ON CONFLICT specification
--  로 거부했고, products 쓰기가 그날부터 100% 실패했다.
--
--  증상 (2026-08-16 확인)
--    - products.collected_at 최댓값이 2026-08-13T18:19 에서 멈춤
--    - 사이트 표시가 vs 최신 관측가: 443건 중 110건(24.8%) 불일치, 최대 11.66배
--    - GitHub Actions daily-prices 8/14·8/15 첫 실행 failure
--      (recordPrices 가 오류 시 recorded 를 0 으로 보고 → collectedNothing → exit 1)
--    - 검색·AI·cron 이 찾아낸 새 상품이 하나도 저장되지 않음
--    - MAX_DISPLAY_AGE_DAYS(10) 때문에 2026-08-24 부터 홈 섹션이 통째로 빌 예정이었음
--
--  ── 왜 코드가 아니라 제약을 되돌리는가 ──────────────────────────
--
--  products 는 "상품 1개당 1행" 으로 설계돼 있다. vendor_item_id 는 식별자가
--  아니라 시간에 따라 바뀌는 속성이다.
--
--    api/_coupang.js collapseOptions   productId 당 최저가 옵션 1건으로 접는다
--    api/_shop.js    recordPrices      중복 키를 `product_id|mall` 로 접는다
--    api/_shop.js    loadStoredVendorIds  Map<"pid|mall"> 하나만 둔다
--    api/_price.js   classifyPrice     같은 상품의 vendor_item_id 가 "바뀌는 것" 을
--                                      옵션 교체로 판정한다 (OPTION_SWITCH_RATIO)
--
--  마지막 줄이 결정적이다. 옵션 교체 감지 자체가 "한 상품의 vid 는 바뀐다" 를
--  전제로 한다. vid 를 키에 넣으면 비교할 직전 행을 영영 못 찾는다.
--
--  실측 (2026-08 price_history 2,787행)
--    링크에서 vendorItemId 추출 실패      0건 (0.00%)
--    상품 716개 중 vid 고정               596 (83.2%)
--    vid 가 2종 이상으로 바뀜             120 (16.8%)  — 많게는 5종
--    → 키에 넣으면 8월 관측만으로 716행 → 874행 (+22%), 이후 무한 증가.
--      같은 상품이 홈에 서로 다른 가격의 카드 여러 장으로 뜬다.
--
--  price_history 는 반대다. 옵션별 독립 추적이 맞고, 그래서 그쪽 마이그레이션은
--  그대로 둔다. 같은 커밋에서 api/_shop.js 가 price_history 에
--  vendor_item_id / item_id 를 채워 넣도록 고쳤다.
-- ══════════════════════════════════════════════════════════════════


-- ── products: (product_id, mall) UNIQUE 복원 ────────────────────
--
-- 2026-08-vendor-identity.sql 이 만든 products_pid_mall_vid_key 는 지우지
-- 않는다. (product_id, mall) 이 더 강한 제약이라 자동으로 만족되고, 굳이
-- 제약을 삭제하는 위험을 감수할 이유가 없다.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'products'::regclass
      and conname = 'products_pid_mall_key'
  ) then
    alter table products
      add constraint products_pid_mall_key unique (product_id, mall);
    raise notice 'products: (product_id, mall) UNIQUE 복원 완료';
  else
    raise notice 'products: products_pid_mall_key 이미 있음 — 건너뜀';
  end if;
end $$;


-- ── PostgREST 스키마 캐시 갱신 ──────────────────────────────────
notify pgrst, 'reload schema';


-- ── 확인 쿼리 (읽기 전용, 별도로 실행) ──────────────────────────
--
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'products'::regclass and contype = 'u';
--
--   -- 적용 후 수동 수집을 돌리고 나서:
--   select max(collected_at) from products;          -- 오늘 날짜여야 한다
--   select count(*) from price_history
--    where recorded_date = current_date and vendor_item_id <> '';   -- 0 이 아니어야 한다
