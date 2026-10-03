-- Additive, disabled until PRICE_QUERY_LEDGER=1. Does not touch catalog/price rows.
-- Only indexes on the new empty tables: no full-catalog scan or price_history lock.
-- Invoker RPCs, pinned search_path, RLS, service_role-only ACLs.
-- Failure vocabulary and retry lists mirror api/_collector-failure.js (a test compares them).
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table if not exists public.collector_query_runs (
  source text not null check (source in ('coupang', 'adpick')),
  kst_date date not null,
  -- Provider input is capped at 80 characters before NFKC; normalization may expand Unicode.
  normalized_query text not null check (length(normalized_query) between 1 and 2048),
  query_hash text not null check (query_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('running','completed','failed','deferred')),
  claim_token uuid not null,
  lease_until timestamptz not null,
  request_started_at timestamptz,
  searched_at timestamptz,
  request_count integer not null default 0 check (request_count between 0 and 2),
  confirmed_request_count integer not null default 0
    check (confirmed_request_count between 0 and request_count),
  result_count integer not null default 0 check (result_count between 0 and 20),
  failure_reason text check (failure_reason in ('RATE_LIMIT','NETWORK_ERROR','TIMEOUT','NO_RESULT',
    'NO_MATCH','AMBIGUOUS_MATCH','OPTION_MISMATCH','INVALID_PRODUCT','AUTH_ERROR','SOURCE_ERROR',
    'WRITE_REJECTED','UNKNOWN')),
  next_retry_at timestamptz,
  result jsonb,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (source, kst_date, query_hash),
  check (result is null or octet_length(result::text) <= 160000)
);
alter table public.collector_query_runs enable row level security;
revoke all on public.collector_query_runs from public, anon, authenticated;
grant select, insert, update on public.collector_query_runs to service_role;
create index if not exists collector_query_runs_date_status_idx
  on public.collector_query_runs (kst_date, source, status);
create index if not exists collector_query_runs_result_expiry_idx
  on public.collector_query_runs (expires_at) where result is not null;

-- Atomic claim: INSERT .. ON CONFLICT + row lock. Concurrent workers on the same
-- provider/query/KST day serialize here; exactly one gets 'claimed'.
create or replace function public.collector_query_claim(
  p_source text, p_normalized_query text, p_query_hash text,
  p_token uuid, p_lease_seconds integer default 180
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_now timestamptz := clock_timestamp();
  v_date date := (v_now at time zone 'Asia/Seoul')::date;
  v_row public.collector_query_runs%rowtype;
  v_action text;
begin
  if p_source not in ('coupang','adpick') or p_query_hash !~ '^[0-9a-f]{64}$'
    or p_token is null or length(p_normalized_query) not between 1 and 2048 then
    raise exception 'invalid query identity';
  end if;
  -- Canonical form (JS normalizeQuery): NFKC, no ASCII upper case, single inner spaces, no edge
  -- space, no C0/C1 control character. Every check is locale-independent so Supabase and the
  -- local test database agree. The hash is recomputed so a caller cannot pair a query with
  -- another query's identity.
  if p_normalized_query is not nfkc normalized
    or p_normalized_query <> btrim(p_normalized_query, ' ')
    or strpos(p_normalized_query, '  ') > 0
    or p_normalized_query ~ '[A-Z]'
    or p_normalized_query ~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']') then
    raise exception 'query not canonical';
  end if;
  if p_query_hash <> encode(sha256(convert_to(p_normalized_query, 'UTF8')), 'hex') then
    raise exception 'query hash mismatch';
  end if;
  insert into public.collector_query_runs(source,kst_date,normalized_query,query_hash,status,claim_token,lease_until)
    values(p_source,v_date,p_normalized_query,p_query_hash,'running',p_token,
      v_now + make_interval(secs => least(180,greatest(30,coalesce(p_lease_seconds,180)))))
    on conflict (source,kst_date,query_hash) do nothing;
  select * into strict v_row from public.collector_query_runs
    where source=p_source and kst_date=v_date and query_hash=p_query_hash for update;
  if v_row.normalized_query <> p_normalized_query then raise exception 'query hash collision'; end if;
  if v_row.status='completed' then
    v_action := case when v_row.result is not null and v_row.expires_at > v_now then 'cached' else 'daily_done' end;
  elsif v_row.status='running' and v_row.claim_token=p_token then
    v_action := 'claimed';
  elsif v_row.status='running' and (v_row.request_started_at is not null or v_row.lease_until > v_now) then
    -- Crash AFTER begin is uncertain: never repeat a potentially completed request today.
    v_action := 'inflight';
  elsif v_row.request_count >= 2 then v_action := 'daily_done';
  elsif v_row.status='failed' and coalesce(v_row.failure_reason,'UNKNOWN')
      not in ('RATE_LIMIT','NETWORK_ERROR','TIMEOUT','SOURCE_ERROR','UNKNOWN') then
    -- AUTH_ERROR, INVALID_PRODUCT, NO_RESULT ...: the same request is never repeated today.
    v_action := 'daily_done';
  elsif v_row.next_retry_at > v_now then v_action := 'deferred';
  else
    -- An expired claim that never began, a deferral, or a retryable failure after backoff.
    update public.collector_query_runs set status='running',claim_token=p_token,
      lease_until=v_now + make_interval(secs => least(180,greatest(30,coalesce(p_lease_seconds,180)))),
      request_started_at=null, updated_at=v_now
      where source=p_source and kst_date=v_date and query_hash=p_query_hash returning * into v_row;
    v_action := 'claimed';
  end if;
  return jsonb_build_object('action',v_action,'kst_date',v_date,'claim_token',v_row.claim_token,
    'result',case when v_action='cached' then v_row.result else null end,
    'failure_reason',v_row.failure_reason,'next_retry_at',v_row.next_retry_at,'request_count',v_row.request_count);
end $$;

-- Called immediately before the provider fetch. One begin per claim; at most 2 per query/day.
create or replace function public.collector_query_begin(
  p_source text, p_date date, p_query_hash text, p_token uuid
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_updated integer;
begin
  update public.collector_query_runs set request_count=request_count+1,
    request_started_at=clock_timestamp(),searched_at=clock_timestamp(),updated_at=clock_timestamp()
    where source=p_source and kst_date=p_date and query_hash=p_query_hash and claim_token=p_token
      and status='running' and request_started_at is null and lease_until > clock_timestamp()
      and request_count < 2 and p_date=(clock_timestamp() at time zone 'Asia/Seoul')::date;
  get diagnostics v_updated = row_count;
  return v_updated=1;
end $$;

create or replace function public.collector_query_finish(
  p_source text, p_date date, p_query_hash text, p_token uuid, p_status text,
  p_failure_reason text, p_result jsonb, p_next_retry_at timestamptz, p_result_count integer
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_updated integer; v_expires timestamptz;
begin
  if p_status not in ('completed','failed','deferred') then raise exception 'invalid query status'; end if;
  if p_result is not null then
    if jsonb_typeof(p_result) is distinct from 'object'
      or octet_length(p_result::text)>160000 or jsonb_typeof(p_result->'version') is distinct from 'number'
      or p_result->>'version' is distinct from '1'
      or p_result->>'source' is distinct from p_source
      or jsonb_typeof(p_result->'fetchedAt') is distinct from 'string'
      or jsonb_typeof(p_result->'items') is distinct from 'array'
      or jsonb_typeof(p_result->'allItems') is distinct from 'array'
      or jsonb_array_length(p_result->'allItems')>20
      or ((p_result->>'fetchedAt')::timestamptz at time zone 'Asia/Seoul')::date is distinct from p_date then
      raise exception 'invalid query result';
    end if;
    v_expires := least((p_date+1)::timestamp at time zone 'Asia/Seoul',
      (p_result->>'fetchedAt')::timestamptz + interval '24 hours');
  elsif p_status='completed' then raise exception 'completed query requires result';
  end if;
  update public.collector_query_runs set status=p_status,result=p_result,expires_at=v_expires,
    confirmed_request_count=confirmed_request_count + case when request_started_at is not null then 1 else 0 end,
    result_count=least(20,greatest(0,coalesce(p_result_count,0))),failure_reason=p_failure_reason,
    next_retry_at=case when p_next_retry_at is not null then greatest(p_next_retry_at,clock_timestamp()+interval '2 minutes') else null end,
    updated_at=clock_timestamp()
    where source=p_source and kst_date=p_date and query_hash=p_query_hash
      and claim_token=p_token and status='running';
  get diagnostics v_updated = row_count;
  return v_updated=1;
end $$;

create or replace function public.collector_query_expire_results(p_batch_size integer default 1000)
returns integer language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_updated integer;
begin
  -- Explicit maintenance only; no schedule/trigger and no deletion of rows or facts.
  -- Skip locked rows so an active collector is never blocked or force-unlocked.
  with expired as (
    select source,kst_date,query_hash from public.collector_query_runs
    where result is not null and expires_at <= clock_timestamp()
      and kst_date < (clock_timestamp() at time zone 'Asia/Seoul')::date
    order by expires_at,source,query_hash limit least(1000,greatest(1,coalesce(p_batch_size,1000)))
    for update skip locked
  ) update public.collector_query_runs q set result=null, updated_at=clock_timestamp()
    from expired e where q.source=e.source and q.kst_date=e.kst_date and q.query_hash=e.query_hash;
  get diagnostics v_updated = row_count;
  return v_updated;
end $$;

create or replace function public.collector_query_invalidate(
  p_source text,p_date date,p_query_hash text,p_token uuid
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_retry timestamptz;
begin
  -- Do not clear the attempt counter or token; at most one bounded repair request.
  update public.collector_query_runs set status='failed',result=null,expires_at=null,
    failure_reason='SOURCE_ERROR',next_retry_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
    where source=p_source and kst_date=p_date and query_hash=p_query_hash
      and claim_token=p_token and status='completed' returning next_retry_at into v_retry;
  return jsonb_build_object('next_retry_at',v_retry);
end $$;

revoke all on function public.collector_query_claim(text,text,text,uuid,integer) from public,anon,authenticated;
revoke all on function public.collector_query_begin(text,date,text,uuid) from public,anon,authenticated;
revoke all on function public.collector_query_finish(text,date,text,uuid,text,text,jsonb,timestamptz,integer) from public,anon,authenticated;
revoke all on function public.collector_query_invalidate(text,date,text,uuid) from public,anon,authenticated;
revoke all on function public.collector_query_expire_results(integer) from public,anon,authenticated;
grant execute on function public.collector_query_claim(text,text,text,uuid,integer) to service_role;
grant execute on function public.collector_query_begin(text,date,text,uuid) to service_role;
grant execute on function public.collector_query_finish(text,date,text,uuid,text,text,jsonb,timestamptz,integer) to service_role;
grant execute on function public.collector_query_invalidate(text,date,text,uuid) to service_role;
grant execute on function public.collector_query_expire_results(integer) to service_role;

-- Per target (Coupang: product|mall|vendorItemId), per provider, per KST day.
CREATE TABLE IF NOT EXISTS public.collector_product_progress (
  source text NOT NULL CHECK (source IN ('coupang', 'adpick')),
  kst_date date NOT NULL,
  product_key text NOT NULL CHECK (length(product_key) BETWEEN 1 AND 512),
  attempted_at timestamptz,
  success_at timestamptz,
  failure_reason text CHECK (failure_reason IN ('RATE_LIMIT','NETWORK_ERROR','TIMEOUT','NO_RESULT',
    'NO_MATCH','AMBIGUOUS_MATCH','OPTION_MISMATCH','INVALID_PRODUCT','AUTH_ERROR','SOURCE_ERROR',
    'WRITE_REJECTED','UNKNOWN')),
  -- Actual attempts: a request started for this target, or a real same-day response evaluated.
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- Requests that left the process and failed without a response (retry cap input).
  transient_failures integer NOT NULL DEFAULT 0 CHECK (transient_failures >= 0),
  -- Number of evaluated queries at the first OPTION_MISMATCH/AMBIGUOUS_MATCH (one alternate after it).
  mismatch_at integer CHECK (mismatch_at >= 1),
  last_query text NOT NULL DEFAULT '',
  last_status text NOT NULL DEFAULT 'pending',
  next_retry_at timestamptz,
  -- Distinct normalized queries whose real response was evaluated for this target today.
  queries jsonb NOT NULL DEFAULT '[]',
  event_ids jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, kst_date, product_key)
);
ALTER TABLE public.collector_product_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.collector_product_progress FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.collector_product_progress TO service_role;

CREATE OR REPLACE FUNCTION public.collector_progress_record(p_source text, p_date date, p_events jsonb)
RETURNS SETOF public.collector_product_progress
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  e jsonb; old public.collector_product_progress; q text; reason text; v_queries jsonb;
  v_attempted boolean; v_evaluated boolean; v_success boolean; v_done boolean;
  stamp timestamptz := clock_timestamp();
BEGIN
  IF p_source NOT IN ('coupang','adpick') OR p_date IS NULL
    OR jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) > 200 THEN
    RAISE EXCEPTION 'invalid collector progress batch';
  END IF;
  -- Stable lock order across overlapping batches prevents inverse-order deadlocks.
  FOR e IN SELECT value FROM jsonb_array_elements(p_events) WITH ORDINALITY AS events(value, ord)
    ORDER BY value->>'product_key', ord LOOP
    IF coalesce(e->>'product_key','') = '' OR coalesce(e->>'event_id','') = '' THEN
      RAISE EXCEPTION 'invalid collector progress event';
    END IF;
    q := coalesce(e->>'query','');
    reason := nullif(e->>'failure_reason','');
    IF length(q) > 2048 THEN RAISE EXCEPTION 'invalid collector progress query'; END IF;
    IF reason IS NOT NULL AND reason NOT IN ('RATE_LIMIT','NETWORK_ERROR','TIMEOUT','NO_RESULT',
      'NO_MATCH','AMBIGUOUS_MATCH','OPTION_MISMATCH','INVALID_PRODUCT','AUTH_ERROR','SOURCE_ERROR',
      'WRITE_REJECTED','UNKNOWN') THEN
      RAISE EXCEPTION 'invalid collector failure reason';
    END IF;
    v_attempted := coalesce((e->>'attempted')::boolean, false);
    v_evaluated := coalesce((e->>'evaluated')::boolean, false);
    v_success := coalesce((e->>'success')::boolean, false);
    INSERT INTO public.collector_product_progress(source,kst_date,product_key)
      VALUES(p_source,p_date,e->>'product_key') ON CONFLICT DO NOTHING;
    SELECT * INTO old FROM public.collector_product_progress
      WHERE source=p_source AND kst_date=p_date AND product_key=e->>'product_key' FOR UPDATE;
    IF NOT (old.event_ids ? (e->>'event_id')) THEN
      v_done := old.success_at IS NOT NULL OR v_success;
      v_queries := CASE WHEN v_evaluated AND q <> '' AND NOT (old.queries ? q)
        THEN old.queries || jsonb_build_array(q) ELSE old.queries END;
      UPDATE public.collector_product_progress SET
        attempted_at = coalesce(old.attempted_at, CASE WHEN v_attempted OR v_success THEN stamp END),
        success_at = coalesce(old.success_at, CASE WHEN v_success THEN stamp END),
        attempt_count = old.attempt_count + CASE WHEN v_attempted THEN 1 ELSE 0 END,
        transient_failures = old.transient_failures + CASE WHEN v_attempted AND NOT v_evaluated AND NOT v_success
          AND reason IN ('RATE_LIMIT','NETWORK_ERROR','TIMEOUT','SOURCE_ERROR','UNKNOWN') THEN 1 ELSE 0 END,
        mismatch_at = coalesce(old.mismatch_at, CASE WHEN v_evaluated
          AND reason IN ('OPTION_MISMATCH','AMBIGUOUS_MATCH') THEN jsonb_array_length(v_queries) END),
        last_query = CASE WHEN q <> '' THEN q ELSE old.last_query END,
        last_status = CASE WHEN v_done THEN 'success' ELSE coalesce(nullif(e->>'status',''),'pending') END,
        -- Success is monotonic; a product-terminal reason sticks for the rest of the day.
        failure_reason = CASE WHEN v_done THEN NULL
          WHEN old.failure_reason IN ('INVALID_PRODUCT','AUTH_ERROR','WRITE_REJECTED') THEN old.failure_reason
          ELSE reason END,
        next_retry_at = CASE WHEN v_done THEN NULL ELSE (e->>'next_retry_at')::timestamptz END,
        queries = v_queries,
        event_ids = old.event_ids || jsonb_build_array(e->>'event_id'), updated_at = stamp
      WHERE source=p_source AND kst_date=p_date AND product_key=e->>'product_key' RETURNING * INTO old;
    END IF;
    RETURN NEXT old;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.collector_progress_record(text,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.collector_progress_record(text,date,jsonb) TO service_role;

-- PostgREST must see the new RPCs before PRICE_QUERY_LEDGER=1 (delivered at commit).
notify pgrst, 'reload schema';
commit;
