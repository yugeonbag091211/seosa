-- Replace the historical Search 10/hour gate with shared minute budgets.
-- This migration keeps all existing call rows and does not touch product or
-- price data. Apply it before deploying api/_coupang.js which calls v2.

alter table public.coupang_api_calls
  add column if not exists api_type text not null default 'search';

create index if not exists coupang_api_calls_type_called_at_idx
  on public.coupang_api_calls (api_type, called_at desc);

-- Search and all-provider counters are reserved under one advisory transaction
-- lock. Interactive searches can use the whole operating budget; background
-- work is capped separately and cannot consume the reserved interactive share.
create or replace function public.coupang_acquire_v2(
  p_source text,
  p_keyword text,
  p_search_operating_cap int default 20,
  p_global_operating_cap int default 80,
  p_interactive_reserve int default 15,
  p_collector_cap int default 5
)
returns table (allowed boolean, call_id bigint, reason text, used int)
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_source text := left(coalesce(p_source, ''), 40);
  v_blocked timestamptz;
  v_reason text;
  v_search_used int;
  v_global_used int;
  v_background_used int;
  v_search_operating int;
  v_global_operating int;
  v_interactive_reserve int;
  v_collector_cap int;
  v_id bigint;
begin
  if v_source = '' then
    raise exception 'p_source is required';
  end if;

  -- These hard ceilings are deliberately fixed in the database. A caller may
  -- lower an operating budget but cannot raise Coupang's stated limits.
  v_global_operating := least(greatest(coalesce(p_global_operating_cap, 80), 1), 100);
  v_search_operating := least(greatest(coalesce(p_search_operating_cap, 20), 1), 50, v_global_operating);
  v_interactive_reserve := least(greatest(coalesce(p_interactive_reserve, 15), 0), v_search_operating);
  v_collector_cap := least(
    greatest(coalesce(p_collector_cap, 5), 0),
    greatest(v_search_operating - v_interactive_reserve, 0)
  );

  perform pg_advisory_xact_lock(8912042601);

  select s.blocked_until, s.reason into v_blocked, v_reason
    from public.coupang_api_state s where s.id = 1;

  if v_blocked is not null and v_blocked > v_now then
    return query select false, null::bigint,
      '호출 중단 중 (재개 ' || to_char(v_blocked, 'YYYY-MM-DD HH24:MI:SSOF') || ') '
        || coalesce(v_reason, ''),
      0;
    return;
  end if;

  select count(*)::int into v_global_used
    from public.coupang_api_calls
   where called_at > v_now - interval '1 minute';

  select count(*)::int into v_search_used
    from public.coupang_api_calls
   where api_type = 'search'
     and called_at > v_now - interval '1 minute';

  select count(*)::int into v_background_used
    from public.coupang_api_calls
   where api_type = 'search'
     and source <> 'search'
     and called_at > v_now - interval '1 minute';

  if v_global_used >= 100 then
    return query select false, null::bigint,
      '전체 API 분당 hard cap ' || v_global_used || '/100', v_global_used;
    return;
  end if;

  if v_search_used >= 50 then
    return query select false, null::bigint,
      'Search 분당 hard cap ' || v_search_used || '/50', v_search_used;
    return;
  end if;

  if v_global_used >= v_global_operating then
    return query select false, null::bigint,
      '전체 API 분당 운영 budget ' || v_global_used || '/' || v_global_operating,
      v_global_used;
    return;
  end if;

  if v_search_used >= v_search_operating then
    return query select false, null::bigint,
      'Search 분당 운영 budget ' || v_search_used || '/' || v_search_operating,
      v_search_used;
    return;
  end if;

  if v_source <> 'search' and (
    v_background_used >= v_collector_cap
    or v_search_used >= greatest(v_search_operating - v_interactive_reserve, 0)
  ) then
    return query select false, null::bigint,
      'collector/background 분당 budget ' || v_background_used || '/' || v_collector_cap,
      v_search_used;
    return;
  end if;

  insert into public.coupang_api_calls (api_type, source, keyword, outcome)
  values ('search', v_source, left(coalesce(p_keyword, ''), 80), 'pending')
  returning id into v_id;

  return query select true, v_id, ''::text, v_search_used + 1;
end;
$$;

-- Keep old application instances safe during a rolling deploy. They use the
-- same ledger/lock and no longer inherit the obsolete hourly rejection.
create or replace function public.coupang_acquire(max_per_min int, src text, kw text)
returns table (allowed boolean, call_id bigint, reason text, used int)
language plpgsql
as $$
begin
  return query
    select * from public.coupang_acquire_v2(
      coalesce(src, 'unknown'), coalesce(kw, ''),
      least(greatest(coalesce(max_per_min, 20), 1), 20),
      80, 15, 5
    );
end;
$$;

-- Retry-After may be shorter than one minute or longer than the default
-- cooldown, so store a bounded seconds duration in the shared circuit state.
create or replace function public.coupang_block_seconds(p_seconds int, why text)
returns void
language sql
as $$
  update public.coupang_api_state
     set blocked_until = greatest(coalesce(blocked_until, clock_timestamp()),
                                  clock_timestamp() + make_interval(secs =>
                                    least(greatest(coalesce(p_seconds, 1), 1), 604800))),
         reason        = left(coalesce(why, ''), 300),
         updated_at    = clock_timestamp()
   where id = 1;
$$;

revoke all on function public.coupang_acquire_v2(text,text,int,int,int,int) from public;
revoke all on function public.coupang_acquire(int,text,text) from public;
revoke all on function public.coupang_block_seconds(int,text) from public;
revoke all on function public.coupang_acquire_v2(text,text,int,int,int,int) from anon, authenticated;
revoke all on function public.coupang_acquire(int,text,text) from anon, authenticated;
revoke all on function public.coupang_block_seconds(int,text) from anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.coupang_acquire_v2(text,text,int,int,int,int) to service_role;
    grant execute on function public.coupang_acquire(int,text,text) to service_role;
    grant execute on function public.coupang_block_seconds(int,text) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
