-- ══════════════════════════════════════════════════════════════════
--  2026-08-14 vendorItemId 기반 상품 동일성 마이그레이션
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 이 파일을 통째로
--    붙여넣고 Run. 순서대로 실행된다.
--
--  안전성
--    - DELETE / TRUNCATE 없음. 기존 데이터의 price, recorded_date,
--      product_id, link 등은 변경하지 않는다.
--    - ADD COLUMN + UPDATE(백필) + DROP/CREATE CONSTRAINT 뿐이다.
--    - 몇 번을 실행해도 안전하다 (IF NOT EXISTS 및 pg_constraint 존재 확인 사용).
--    - 기존 제약을 이름이 아닌 컬럼 집합으로 식별하여 삭제한다.
--      id PK 는 건드리지 않는다.
--
--  이 마이그레이션이 하는 일
--    Phase 1: price_history에 vendor_item_id, item_id 컬럼 추가 + 백필
--    Phase 2: UNIQUE 제약을 (pid, mall, vid, date)로 변경
-- ══════════════════════════════════════════════════════════════════


-- ── Phase 1: price_history 컬럼 추가 ────────────────────────────
alter table price_history add column if not exists vendor_item_id text not null default '';
alter table price_history add column if not exists item_id        text not null default '';


-- ── Phase 1b: 기존 데이터 백필 (link URL에서 파싱) ──────────────
--
-- 쿠팡 제휴 링크에는 vendorItemId=숫자 / itemId=숫자 가 항상 들어 있다.
-- 7/29~30의 레거시 데이터(네이버/11번가 link가 mall='쿠팡'으로 저장된 것)는
-- 파싱 결과가 빈 문자열이 되고, 아래에서 '__LEGACY__'로 격리한다.

-- vendorItemId 백필
update price_history
   set vendor_item_id = (regexp_match(link, '[?&]vendorItemId=(\d+)'))[1]
 where vendor_item_id = ''
   and link ~ '[?&]vendorItemId=\d+';

-- itemId 백필
update price_history
   set item_id = (regexp_match(link, '[?&]itemId=(\d+)'))[1]
 where item_id = ''
   and link ~ '[?&]itemId=\d+';

-- 복원 불가 레거시 레코드 격리 (쿠팡인데 vendorItemId가 여전히 빈 것)
update price_history
   set vendor_item_id = '__LEGACY__'
 where vendor_item_id = ''
   and mall = '쿠팡';


-- ── Phase 1c: products 테이블 보완 ──────────────────────────────
-- vendor_item_id가 비어 있지만 link에서 파싱 가능한 행을 채운다.
update products
   set vendor_item_id = (regexp_match(link, '[?&]vendorItemId=(\d+)'))[1]
 where vendor_item_id = ''
   and link ~ '[?&]vendorItemId=\d+';

update products
   set item_id = (regexp_match(link, '[?&]itemId=(\d+)'))[1]
 where item_id = ''
   and link ~ '[?&]itemId=\d+';


-- ── Phase 2: UNIQUE 제약 변경 ───────────────────────────────────
--
-- 기존: (product_id, mall, recorded_date) — 같은 페이지의 다른 옵션이 덮어씀
-- 신규: (product_id, mall, vendor_item_id, recorded_date) — 옵션별 독립 추적
--
-- 사전 검증으로 충돌 0건을 확인했으므로 안전하게 적용 가능.
--
-- 기존 제약 이름을 모르므로 pg_constraint 에서 동적으로 찾아 삭제한다.
-- 이름을 추측해서 DROP 하면 (1) id PK 를 날리거나 (2) 이름 불일치 시
-- 기존 제약이 잔존해 새 모델의 upsert 가 실패한다.

-- price_history: (product_id, mall, recorded_date) 를 포함하는
-- UNIQUE 또는 PRIMARY KEY 제약만 삭제 (id PK 는 건드리지 않는다).
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'price_history'::regclass
      and c.contype in ('u', 'p')
      and c.conname <> 'price_history_pid_mall_vid_date_key'
      and (
        select array_agg(a.attname::text order by a.attname)
        from pg_attribute a
        where a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      ) @> array['mall','product_id','recorded_date']::text[]
      and array_length(c.conkey, 1) <= 3
  loop
    raise notice 'price_history: dropping old constraint %', r.conname;
    execute format('alter table price_history drop constraint %I', r.conname);
  end loop;
end $$;

-- 새 UNIQUE 제약 추가 (이미 있으면 건너뛴다 — 멱등성 보장)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'price_history'::regclass
      and conname = 'price_history_pid_mall_vid_date_key'
  ) then
    alter table price_history
      add constraint price_history_pid_mall_vid_date_key
      unique (product_id, mall, vendor_item_id, recorded_date);
  end if;
end $$;


-- ── Phase 2b: products 테이블 UNIQUE 제약 변경 ──────────────────
-- products도 vendor_item_id를 키에 포함시킨다.
-- 현재는 1 product_id당 1행이므로 충돌 없이 적용 가능.
--
-- (product_id, mall) 을 포함하는 UNIQUE/PK 제약만 삭제 (id PK 는 건드리지 않는다).
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'products'::regclass
      and c.contype in ('u', 'p')
      and c.conname <> 'products_pid_mall_vid_key'
      and (
        select array_agg(a.attname::text order by a.attname)
        from pg_attribute a
        where a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      ) @> array['mall','product_id']::text[]
      and array_length(c.conkey, 1) <= 2
  loop
    raise notice 'products: dropping old constraint %', r.conname;
    execute format('alter table products drop constraint %I', r.conname);
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'products'::regclass
      and conname = 'products_pid_mall_vid_key'
  ) then
    alter table products
      add constraint products_pid_mall_vid_key
      unique (product_id, mall, vendor_item_id);
  end if;
end $$;


-- ── 인덱스 추가 ────────────────────────────────────────────────
create index if not exists price_history_vid_idx
  on price_history (vendor_item_id) where vendor_item_id <> '' and vendor_item_id <> '__LEGACY__';


-- ── Phase 6: price_drop_top 뷰 재생성 ───────────────────────────
--
-- 기존 뷰는 (product_id, mall) 단위로 가격을 비교한다.
-- 다른 vendorItemId의 가격끼리 비교하면 가짜 하락이 나온다.
-- 같은 vendorItemId 안에서만 비교하도록 수정한다.
--
-- CREATE OR REPLACE 는 컬럼이 같으면 기존 뷰를 안전하게 대체한다.
create or replace view price_drop_top as
with ranked as (
  select
    product_id,
    mall,
    vendor_item_id,
    price,
    recorded_date,
    row_number() over (
      partition by product_id, mall, vendor_item_id
      order by recorded_date desc
    ) as rn
  from price_history
  where vendor_item_id <> '__LEGACY__'
),
latest as (
  select product_id, mall, vendor_item_id, price as current_price, recorded_date as latest_date
  from ranked where rn = 1
),
prev as (
  select product_id, mall, vendor_item_id, price as prev_price
  from ranked where rn = 2
),
agg as (
  select product_id, mall, vendor_item_id, min(price) as all_time_low
  from price_history
  where vendor_item_id <> '__LEGACY__'
  group by product_id, mall, vendor_item_id
)
select
  l.product_id,
  l.mall,
  p2.title,
  l.current_price,
  pv.prev_price,
  a.all_time_low,
  coalesce(pv.prev_price - l.current_price, 0) as drop_amount,
  case
    when pv.prev_price > 0 and l.current_price < pv.prev_price
    then round((1.0 - l.current_price::numeric / pv.prev_price) * 100, 1)
    else 0
  end as drop_pct,
  (l.current_price <= a.all_time_low) as is_all_time_low,
  p2.link,
  p2.image
from latest l
left join prev pv using (product_id, mall, vendor_item_id)
left join agg  a  using (product_id, mall, vendor_item_id)
left join products p2 on p2.product_id = l.product_id and p2.mall = l.mall
  and p2.vendor_item_id = l.vendor_item_id
where pv.prev_price is not null;


-- ── PostgREST 스키마 캐시 갱신 ──────────────────────────────────
notify pgrst, 'reload schema';


-- ── 확인 쿼리 (읽기 전용) ───────────────────────────────────────
-- 실행 후 아래를 별도로 실행하여 확인:
--
--   -- 백필 결과 확인
--   select vendor_item_id, count(*)
--     from price_history
--    where mall = '쿠팡'
--    group by (vendor_item_id = ''), (vendor_item_id = '__LEGACY__'), (vendor_item_id not in ('', '__LEGACY__'));
--
--   -- 제약 확인
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'price_history'::regclass and contype = 'u';
