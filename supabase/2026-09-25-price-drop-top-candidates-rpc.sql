-- 2026-09-25: compute the all-time minimum only for the 200 rows served to the home page.
--
-- Production logs showed the existing price_drop_top request being canceled by
-- PostgREST's 8-second statement_timeout. The ranked 30-day window remains
-- unchanged; this RPC first selects the same highest-drop candidates, then uses
-- the existing (product_id, mall, vendor_item_id, price) index to look up each
-- candidate's all-time minimum. It does not change collection or deal rules.
--
-- The user-visible result columns and ordering match the existing view contract.
-- Test-project synthetic benchmark and EXCEPT ALL parity are documented in
-- docs/seosa2/PROGRESS.md. Production impact is not claimed before approval.
--
-- Additive function only: no table/view/index/data change. Reapplying is safe.
-- Rollback: deploy the API call back to public.price_drop_top, then drop this
-- function with the statement in docs/seosa2/price-drop-top-candidates-rpc-rollback.md.

create or replace function public.price_drop_top_candidates(p_limit integer default 200)
returns table (
  product_id text,
  mall text,
  mall_label text,
  title text,
  current_price integer,
  prev_price integer,
  drop_amount integer,
  drop_pct numeric,
  is_all_time_low boolean,
  link text,
  image text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
  with ranked as (
    select
      ph.product_id,
      ph.mall,
      ph.vendor_item_id,
      ph.price,
      row_number() over (
        partition by ph.product_id, ph.mall, ph.vendor_item_id
        order by ph.recorded_date desc
      ) as rn
    from public.price_history ph
    where ph.vendor_item_id <> '__LEGACY__'
      and ph.recorded_date >= current_date - interval '30 days'
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
  candidates as materialized (
    select
      lp.product_id,
      lp.mall,
      lp.vendor_item_id,
      p.title,
      lp.current_price,
      lp.prev_price,
      coalesce(lp.prev_price - lp.current_price, 0) as drop_amount,
      case
        when lp.prev_price > 0 and lp.current_price < lp.prev_price
        then round((1.0 - lp.current_price::numeric / lp.prev_price::numeric) * 100::numeric, 1)
        else 0::numeric
      end as drop_pct,
      p.mall_label,
      p.link,
      p.image
    from latest_prev lp
    join public.products p
      on p.product_id = lp.product_id
     and p.mall = lp.mall
    order by drop_pct desc
    limit least(greatest(coalesce(p_limit, 200), 1), 200)
  )
  select
    c.product_id,
    c.mall,
    c.mall_label,
    c.title,
    c.current_price,
    c.prev_price,
    c.drop_amount,
    c.drop_pct,
    c.current_price <= history_min.all_time_low as is_all_time_low,
    c.link,
    c.image
  from candidates c
  cross join lateral (
    select min(ph.price) as all_time_low
    from public.price_history ph
    where ph.product_id = c.product_id
      and ph.mall = c.mall
      and ph.vendor_item_id = c.vendor_item_id
      and ph.vendor_item_id <> '__LEGACY__'
  ) history_min
  order by c.drop_pct desc;
$function$;

revoke all on function public.price_drop_top_candidates(integer) from public, anon, authenticated;
grant execute on function public.price_drop_top_candidates(integer) to service_role;

notify pgrst, 'reload schema';
