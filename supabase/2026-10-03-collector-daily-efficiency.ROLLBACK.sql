-- Rollback for supabase/migrations/20261003003832_collector_daily_efficiency.sql
--
-- STEP 1 (always, and usually enough): set PRICE_QUERY_LEDGER=0 (or remove it) in BOTH the
--   GitHub Actions repository variables and the Vercel environment. Let any running collector
--   finish on its own — never terminate it and never force-release its lock. With the flag off
--   every code path is the pre-ledger behavior; the tables below are simply unused.
--
-- STEP 2 (optional, only after STEP 1 is live everywhere): remove the additive objects.
--   Drops ONLY what the migration created. products, price_history, price_job_state,
--   provider caches, quota tables and affiliate data are not referenced here.
--   Lost by STEP 2: same-day query/progress bookkeeping only (no price observations).
--   If the flag were still on, the collector's startup preflight falls back to the
--   pre-ledger path instead of stopping collection.
begin;
set local lock_timeout = '3s';
drop function if exists public.collector_progress_record(text, date, jsonb);
drop function if exists public.collector_query_invalidate(text, date, text, uuid);
drop function if exists public.collector_query_expire_results(integer);
drop function if exists public.collector_query_finish(text, date, text, uuid, text, text, jsonb, timestamptz, integer);
drop function if exists public.collector_query_begin(text, date, text, uuid);
drop function if exists public.collector_query_claim(text, text, text, uuid, integer);
drop table if exists public.collector_product_progress;
drop table if exists public.collector_query_runs;
notify pgrst, 'reload schema';
commit;

-- After STEP 2, expect both to be NULL:
select to_regclass('public.collector_query_runs') as query_ledger,
       to_regclass('public.collector_product_progress') as product_progress;
