-- ══════════════════════════════════════════════════════════════════
--  2026-09-22  collector target timeout + single-call batch RPC
--
--  collector_target_products() takes ~7-12s on the current catalog while
--  PostgREST/authenticator defaults to statement_timeout=8s. Give only this
--  collector RPC a bounded exemption, then expose a JSONB wrapper so the
--  client can fetch the full target set with one DB execution instead of
--  re-running the same expensive function for every 1,000-row page.
-- ══════════════════════════════════════════════════════════════════

alter function public.collector_target_products(integer, integer)
  set statement_timeout = '30s';

create or replace function public.collector_target_products_batch(
  p_rotation_days integer default 7,
  p_rotation_bucket integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = public
set statement_timeout = '30s'
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', t.product_id,
        'mall', t.mall,
        'tier', t.tier
      )
      order by t.tier, t.mall, t.product_id
    ),
    '[]'::jsonb
  )
  from public.collector_target_products(p_rotation_days, p_rotation_bucket) t
$$;

revoke execute on function public.collector_target_products_batch(integer, integer)
  from public, anon, authenticated;
grant execute on function public.collector_target_products_batch(integer, integer)
  to service_role;

notify pgrst, 'reload schema';
