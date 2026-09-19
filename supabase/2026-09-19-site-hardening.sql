-- 2026-09-19
-- Public API reads price_drop_top only through our server-side service-role client.
alter view public.price_drop_top set (security_invoker = true);
revoke all on table public.price_drop_top from anon;
revoke all on table public.price_drop_top from authenticated;
grant select on table public.price_drop_top to service_role;

-- Historical corruption guard. One pre-existing negative row was removed in production
-- before this constraint was applied; make fresh/replayed environments converge too.
delete from public.price_history where price <= 0;

alter table public.price_history
  add constraint price_history_price_positive check (price > 0) not valid;
alter table public.price_history validate constraint price_history_price_positive;

alter table public.products
  add constraint products_lprice_positive check (lprice > 0) not valid;
alter table public.products validate constraint products_lprice_positive;

-- Exact duplicate indexes: keep the newer canonical names.
drop index if exists public.idx_ph_title;
drop index if exists public.idx_products_keyword;
