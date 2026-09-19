-- 2026-09-19
-- Pin function lookup paths so objects cannot be shadowed through a mutable search_path.
alter function public.block_truncate() set search_path = public, pg_temp;
alter function public.bump_metric(text, date) set search_path = public, pg_temp;
alter function public.coupang_acquire(integer, text, text) set search_path = public, pg_temp;
alter function public.coupang_block(integer, text) set search_path = public, pg_temp;
alter function public.coupang_finish(bigint, text, integer, text, integer) set search_path = public, pg_temp;
alter function public.coupang_prune(integer) set search_path = public, pg_temp;
alter function public.coupang_unblock() set search_path = public, pg_temp;
alter function public.coupang_usage() set search_path = public, pg_temp;
alter function public.increment_search_stat(text) set search_path = public, pg_temp;
alter function public.set_recorded_date() set search_path = public, pg_temp;
alter function public.track_visit(text, date) set search_path = public, pg_temp;
