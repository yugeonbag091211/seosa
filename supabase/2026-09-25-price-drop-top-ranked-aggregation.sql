-- 2026-09-25: avoid spilling the duplicated ranked price window in price_drop_top.
--
-- The live view reads the same 30-day ranked CTE twice (rn=1 and rn=2).
-- On the production-sized test fixture (155,767 history rows, 38,210 option
-- keys), PostgreSQL materialized 137,948 ranked rows to temporary files:
-- 34,325 blocks read / 34,450 written. This view aggregates rn=1/rn=2 in
-- one pass, preserving one output per (product_id, mall, vendor_item_id)
-- that has at least two observations. The test plan wrote/read zero temp blocks.
--
-- This is a read-only view replacement. It does not change price history,
-- collection, deal classification, or product rows. Column order/types match
-- the current public.price_drop_top contract.
--
-- Test project result parity: EXCEPT ALL returned 0 rows in both directions,
-- including one-observation, legacy-only, orphan, and multiple-option fixtures.
-- Test project EXPLAIN ANALYZE: 556.5 ms baseline, 281.3 ms rewritten, with
-- 34,326/34,451 temp blocks reduced to 0/0. This is a test measurement, not a
-- promise of the same Production latency improvement.
--
-- Rollback: reapply the prior view body documented in
-- docs/seosa2/price-drop-top-ranked-aggregation-rollback.md.
-- No Production database change is included in this PR.

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
latest_prev as (
  select
    product_id,
    mall,
    vendor_item_id,
    max(price) filter (where rn = 1) as current_price,
    max(price) filter (where rn = 2) as prev_price
  from ranked
  group by product_id, mall, vendor_item_id
  having count(*) filter (where rn = 2) > 0
),
agg as (
  select
    product_id,
    mall,
    vendor_item_id,
    min(price) as all_time_low
  from price_history
  where vendor_item_id <> '__LEGACY__'
  group by product_id, mall, vendor_item_id
)
select
  lp.product_id,
  lp.mall,
  p2.title,
  lp.current_price,
  lp.prev_price,
  a.all_time_low,
  coalesce(lp.prev_price - lp.current_price, 0) as drop_amount,
  case
    when lp.prev_price > 0 and lp.current_price < lp.prev_price
    then round((1.0 - lp.current_price::numeric / lp.prev_price::numeric) * 100::numeric, 1)
    else 0::numeric
  end as drop_pct,
  lp.current_price <= a.all_time_low as is_all_time_low,
  p2.link,
  p2.image,
  p2.mall_label
from latest_prev lp
left join agg a using (product_id, mall, vendor_item_id)
join products p2 on p2.product_id = lp.product_id and p2.mall = lp.mall;

notify pgrst, 'reload schema';

-- After applying the migration, verify only the query result shape and count:
-- select count(*) from price_drop_top;
-- select count(*) from price_drop_top where link is null;
-- Roll back by reapplying the previous definition in the Markdown file above.