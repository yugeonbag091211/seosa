-- 2026-09-19
-- 9/18 bulk seed catalog must not become the daily collector denominator.
create or replace function public.collector_eligible_products(
  cutoff timestamptz default timestamptz '2026-09-17 15:00:00+00'
)
returns table(product_id text, mall text)
language sql
stable
security invoker
set search_path = public
as $$
  select p.product_id, p.mall
  from public.products p
  where exists (
    select 1
    from public.price_history h
    where h.product_id = p.product_id
      and h.mall = p.mall
      and (
        h.recorded_at < cutoff
        or coalesce(h.source, '') in ('search','ai','cron','import')
      )
  );
$$;

revoke all on function public.collector_eligible_products(timestamptz) from public;
revoke all on function public.collector_eligible_products(timestamptz) from anon;
revoke all on function public.collector_eligible_products(timestamptz) from authenticated;
grant execute on function public.collector_eligible_products(timestamptz) to service_role;
