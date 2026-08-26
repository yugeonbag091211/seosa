-- 2026-08-26  ADPICK 상품의 사용자 표시용 몰 이름(cp_name 기반)
--
-- 백엔드 식별자(products.mall = 'ADPICK')는 그대로 둔다. 화면에는 실제
-- 제휴몰 이름(cp_name, 예: '알리익스프레스'→'알리')을 보여줘야 해서
-- 표시 전용 컬럼을 따로 둔다 — api/_shop.js recordPrices()가 채운다.
--
-- ※ create/alter ... if not exists, create or replace view 뿐이라 몇 번
--   실행해도 안전하다. 기존 데이터·기존 컬럼을 지우지 않는다.

alter table products add column if not exists mall_label text not null default '';

-- price_drop_top("오늘의 가격 하락" 시세판이 보는 뷰)도 이 값을 함께 내보낸다.
-- 기존 컬럼 순서는 그대로 두고 마지막에 추가한다 — CREATE OR REPLACE VIEW는
-- 기존 출력 컬럼을 앞쪽에서 그대로 유지해야 하며, 끝에 추가하는 것만 허용된다.
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
    and recorded_date >= current_date - interval '30 days'
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
  p2.image,
  p2.mall_label
from latest l
join prev pv using (product_id, mall, vendor_item_id)
left join agg a using (product_id, mall, vendor_item_id)
join products p2 on p2.product_id = l.product_id and p2.mall = l.mall;
