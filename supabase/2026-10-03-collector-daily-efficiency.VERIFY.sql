-- Checks after an explicitly approved run of
--   supabase/migrations/20261003003832_collector_daily_efficiency.sql
-- Sections 1-5 are read-only. Section 6 exercises the RPCs inside a transaction that always
-- ROLLs BACK (it writes nothing that survives). products, price_history, affiliate links and
-- UI are never touched. Run before setting PRICE_QUERY_LEDGER=1 in Actions and Vercel.

-- 1. Tables exist with RLS; anon/authenticated have no access; service_role does.
select c.relname, c.relrowsecurity as rls,
  has_table_privilege('anon', c.oid, 'select') as anon_can_read,
  has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_read,
  has_table_privilege('service_role', c.oid, 'select,insert,update') as service_can_use,
  has_table_privilege('service_role', c.oid, 'delete') as service_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('collector_query_runs','collector_product_progress');
-- expect 2 rows: rls=true, anon/authenticated=false, service_can_use=true, service_can_delete=false

-- 2. Six RPCs: SECURITY INVOKER, pinned search_path, execute for service_role only.
select p.proname, p.prosecdef as security_definer, p.proconfig,
  has_function_privilege('anon',p.oid,'execute') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'execute') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'execute') as service_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
  'collector_query_claim','collector_query_begin','collector_query_finish',
  'collector_query_invalidate','collector_query_expire_results','collector_progress_record')
order by p.proname;
-- expect 6 rows: security_definer=false, proconfig has search_path, only service_can_execute=true

-- 3. Indexes (primary keys enforce one row per source + KST date + query/product).
select tablename, indexname, indexdef from pg_indexes
where schemaname='public' and tablename in ('collector_query_runs','collector_product_progress')
order by tablename, indexname;
-- expect: collector_product_progress_pkey (source,kst_date,product_key),
--         collector_query_runs_pkey (source,kst_date,query_hash),
--         collector_query_runs_date_status_idx, collector_query_runs_result_expiry_idx

-- 4. Constraints: failure vocabulary, request cap (<=2/query/day), payload size, counters.
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.collector_query_runs'::regclass, 'public.collector_product_progress'::regclass)
order by 1, 2;

-- 5. Operating view (after enabling). confirmed = finished external requests;
--    uncertain = begin without finish (crash between begin and response) — never re-requested today.
select source,kst_date,count(*) as query_rows,
  sum(request_count) as request_intents,
  sum(confirmed_request_count) as finished_external_requests,
  sum(request_count-confirmed_request_count) as uncertain_request_intents,
  count(*) filter (where request_count>0) as unique_external_queries,
  sum(greatest(request_count-1,0)) as repeat_requests,
  count(*) filter (where status='completed') as completed_query_rows,
  count(*) filter (where status='running' and request_started_at is not null) as uncertain_inflight,
  sum(coalesce(octet_length(result::text),0)) as cached_payload_bytes
from public.collector_query_runs
where kst_date >= (now() at time zone 'Asia/Seoul')::date-7
group by source,kst_date order by kst_date desc,source;

select source,kst_date,failure_reason,count(*) from public.collector_query_runs
where kst_date=(now() at time zone 'Asia/Seoul')::date and failure_reason is not null
group by source,kst_date,failure_reason order by source,failure_reason;

select source,kst_date,count(*) as progress_rows,
  count(*) filter (where attempted_at is not null) as attempted,
  count(*) filter (where success_at is not null) as success,
  count(*) filter (where transient_failures >= 3) as transient_capped,
  count(*) filter (where mismatch_at is not null) as option_mismatch_seen
from public.collector_product_progress
where kst_date >= (now() at time zone 'Asia/Seoul')::date-7
group by source,kst_date order by kst_date desc,source;

select source,failure_reason,count(*) from public.collector_product_progress
where kst_date=(now() at time zone 'Asia/Seoul')::date and success_at is null
group by source,failure_reason order by source,count(*) desc;

-- 6. Behavior: atomic claim, one begin per claim, canonical guard, hash guard.
--    Always rolled back. Raises an exception (and stays rolled back) on any violation.
begin;
do $$
declare
  q text := 'verify collector ledger ' || gen_random_uuid()::text;
  h text := encode(sha256(convert_to(q,'UTF8')),'hex');
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb; d date;
begin
  r1 := public.collector_query_claim('adpick', q, h, t1, 60);
  r2 := public.collector_query_claim('adpick', q, h, t2, 60);
  if r1->>'action' <> 'claimed' or r2->>'action' <> 'inflight' then
    raise exception 'duplicate prevention failed: % / %', r1->>'action', r2->>'action';
  end if;
  d := (r1->>'kst_date')::date;
  if d <> (clock_timestamp() at time zone 'Asia/Seoul')::date then raise exception 'claim date is not the KST date'; end if;
  if not public.collector_query_begin('adpick', d, h, t1) then raise exception 'owner could not begin'; end if;
  if public.collector_query_begin('adpick', d, h, t1) then raise exception 'second begin allowed'; end if;
  if public.collector_query_begin('adpick', d, h, t2) then raise exception 'non-owner begin allowed'; end if;
  begin
    perform public.collector_query_claim('adpick', 'Not Canonical', encode(sha256(convert_to('Not Canonical','UTF8')),'hex'), gen_random_uuid(), 60);
    raise exception 'non-canonical query accepted';
  exception when raise_exception then
    if sqlerrm not like '%not canonical%' then raise; end if;
  end;
  begin
    perform public.collector_query_claim('adpick', 'other query', h, gen_random_uuid(), 60);
    raise exception 'mismatched hash accepted';
  exception when raise_exception then
    if sqlerrm not like '%hash mismatch%' then raise; end if;
  end;
  raise notice 'collector ledger behavior OK (rolled back)';
end $$;
rollback;
