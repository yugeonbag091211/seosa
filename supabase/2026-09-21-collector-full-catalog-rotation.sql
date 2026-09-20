-- ══════════════════════════════════════════════════════════════════
--  2026-09-21  전체 카탈로그 회전 수집 대상
--
--  상시 추적 대상은 매일 그대로 수집하고, bulk-seed 전용 상품은
--  product_id|mall 고정 해시 버킷으로 나눠 하루 한 버킷씩 추가한다.
--  기본 7버킷이면 지원 몰(쿠팡·ADPICK) 전체가 7일에 한 번씩 대상이 된다.
--
--  2026-09-21 운영 실측:
--    products 전체        69,722
--    상시 추적             3,027
--    오늘(버킷 4) 회전      9,639
--    오늘 합계             12,666
--
--  함수는 읽기 전용이며 products/price_history 행을 수정하지 않는다.
--  collector 는 service_role 로만 호출한다.
-- ══════════════════════════════════════════════════════════════════

create or replace function public.collector_target_products(
  p_rotation_days integer default 7,
  p_rotation_bucket integer default 0
)
returns table (product_id text, mall text, tier text)
language sql
stable
security invoker
set search_path = public
as $$
  with p0 as (
    select greatest(coalesce(p_rotation_days, 7), 1) as days,
           coalesce(p_rotation_bucket, 0) as bucket
  ),
  params as (
    select days, mod(mod(bucket, days) + days, days) as bucket
      from p0
  ),
  daily as (
    select e.product_id, e.mall
      from public.collector_eligible_products() e
     where e.mall in ('쿠팡', 'ADPICK')
  ),
  rotation as (
    select p.product_id, p.mall
      from public.products p
      cross join params x
      left join daily d
        on d.product_id = p.product_id
       and d.mall = p.mall
     where p.mall in ('쿠팡', 'ADPICK')
       and d.product_id is null
       and mod(
             mod(hashtextextended(p.product_id || '|' || p.mall, 0), x.days)
             + x.days,
             x.days
           ) = x.bucket
  )
  select d.product_id, d.mall, 'daily'::text as tier
    from daily d
  union all
  select r.product_id, r.mall, 'rotation'::text as tier
    from rotation r
$$;

revoke execute on function public.collector_target_products(integer, integer)
  from public, anon, authenticated;
grant execute on function public.collector_target_products(integer, integer)
  to service_role;

notify pgrst, 'reload schema';

-- 확인 예시:
-- select tier, mall, count(*)
--   from public.collector_target_products(7, 4)
--  group by tier, mall
--  order by tier, mall;
