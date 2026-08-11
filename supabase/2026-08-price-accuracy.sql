-- ══════════════════════════════════════════════════════════════════
--  2026-08-09 가격 정확도 마이그레이션
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 이 파일을 통째로
--    붙여넣고 Run.
--
--  안전성
--    - add column if not exists / create index if not exists 뿐이다.
--    - drop / truncate / delete / update 가 하나도 없다.
--    - 기존 컬럼의 타입이나 기본값을 바꾸지 않는다.
--    → 몇 번을 실행해도 안전하고, 실행하지 않아도 사이트는 그대로 동작한다
--      (api/_shop.js 가 컬럼이 없으면 그 값 없이 저장하도록 되어 있다).
--
--  ※ supabase/schema.sql 은 실행하지 마세요 (monthly_curation 을 덮어씁니다).
-- ══════════════════════════════════════════════════════════════════


-- ── 1. 판매 단위 식별자 ──────────────────────────────────────────
--
--  왜 필요한가
--    쿠팡의 product_id 는 "상품 페이지" 단위다. 색상·용량·수량 옵션이 전부
--    같은 product_id 를 공유하고, 검색 API 는 그중 한 옵션의 가격을 돌려준다.
--    어느 옵션이 올지는 우리가 고를 수 없다.
--
--    2026-08-09 확인한 실제 사례 (price_history 기준)
--      9536222150  "OpenDots 2 ... 블루 그레이-GY"  /  "... 펄 화이트-WT"
--      9468250277  "아이스 쿨토시, 화이트, 10세트"  /  "... 블랙, 10세트"
--      9530771909  "햇빛가리개 원터치, 1개, 모던블랙" / "햇빛가리개 원터치"
--    같은 행에 서로 다른 상품명이 번갈아 들어오고 있었고, 그때마다 가격도
--    같이 바뀐다. 그걸 "가격이 내렸다"로 기록하면 시세가 오염된다.
--
--    실제로 팔리는 단위는 itemId / vendorItemId 이고, 이 값은 지금도
--    products.link 안에 전부 들어 있다 (쿠팡 상품 654행 중 654행).
--    지금까지 버리고 있었을 뿐이다.
--
--  이 컬럼이 채워지면 api/_price.js 의 classifyPrice() 가 "옵션이 바뀌면서
--  가격이 튄 것"과 "같은 옵션의 가격이 내린 것"을 구분한다.
alter table products add column if not exists item_id        text not null default '';
alter table products add column if not exists vendor_item_id text not null default '';

-- 같은 vendorItemId 를 여러 product_id 가 공유하는지 확인할 때 쓴다.
create index if not exists products_vendor_item_id_idx
  on products (vendor_item_id) where vendor_item_id <> '';


-- ── 2. 현재가 갱신 시점 조회 인덱스 ──────────────────────────────
--
--  api/_shop.js 의 freshRows() 가 collected_at 으로 "현재가로 쓸 수 있는 행"을
--  가른다. products_collected_at_idx 는 2026-08 하드닝에서 이미 만들었고,
--  여기서는 몰별 조회를 같이 태우는 복합 인덱스만 추가한다.
create index if not exists products_mall_collected_at_idx
  on products (mall, collected_at desc);


-- ── 3. 직전 관측 조회 인덱스 ─────────────────────────────────────
--
--  저장 전에 "이 상품의 직전 가격"을 찾아 비정상 급변을 판정한다
--  (api/_shop.js loadPrevObservations). product_id in (...) + recorded_date desc
--  조회라 2026-08 하드닝의 price_history_pid_mall_date_idx 로 이미 커버되지만,
--  그 마이그레이션을 아직 안 돌린 환경을 위해 여기서도 보장한다.
create index if not exists price_history_pid_mall_date_idx
  on price_history (product_id, mall, recorded_date desc);


-- ── 4. PostgREST 스키마 캐시 갱신 ────────────────────────────────
--  이걸 빠뜨리면 방금 추가한 컬럼을 한동안 못 찾아서 api/_shop.js 가
--  옵션 교체 감지를 끈 채로 동작한다 (저장 자체는 정상).
notify pgrst, 'reload schema';


-- ── 5. 확인 (읽기 전용) ──────────────────────────────────────────
--
--   select column_name from information_schema.columns
--    where table_name = 'products' and column_name in ('item_id','vendor_item_id');
--   → 2행이 보이면 정상
--
--  적용 뒤 다음 수집부터 vendor_item_id 가 채워진다. 기존 행은 빈 문자열이라
--  옵션 교체 감지가 그 상품에 대해서는 다음 수집 때부터 켜진다.
