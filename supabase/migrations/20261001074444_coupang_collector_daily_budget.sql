-- First-stage collector policy: 20/min, Search operating 35/min, reserve 15/min.
-- Apply after the 2026-09-28 minute-quota and search-path migrations, before
-- enabling the faster collector. Do not replay historical bootstrap files.
-- No product, price history, call ledger or circuit state is cleared.

create index if not exists coupang_api_calls_collect_day_idx
  on public.coupang_api_calls (called_at)
  where source = 'collect';
create or replace function public.coupang_acquire_v2(
  p_source text,
  p_keyword text,
  p_search_operating_cap int default 35,
  p_global_operating_cap int default 80,
  p_interactive_reserve int default 15,
  p_collector_cap int default 20
)
returns table (allowed boolean, call_id bigint, reason text, used int)
language plpgsql
set search_path = ''
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
  v_day_start timestamptz;
  v_day_used int;
begin
  if v_source = '' then
    raise exception 'p_source is required';
  end if;

  -- These hard ceilings are deliberately fixed in the database. A caller may
  -- lower an operating budget but cannot raise Coupang's stated limits.
  v_global_operating := least(greatest(coalesce(p_global_operating_cap, 80), 1), 100);
  v_search_operating := least(greatest(coalesce(p_search_operating_cap, 35), 1), 50, v_global_operating);
  v_interactive_reserve := least(greatest(coalesce(p_interactive_reserve, 15), 15), v_search_operating);
  v_collector_cap := least(
    greatest(coalesce(p_collector_cap, 20), 0),
    20,
    greatest(v_search_operating - v_interactive_reserve, 0)
  );

  perform pg_advisory_xact_lock(8912042601);
  -- Capture time after waiting for the shared lock, including KST midnight.
  v_now := clock_timestamp();

  select s.blocked_until, s.reason into v_blocked, v_reason
    from public.coupang_api_state s where s.id = 1;

  if v_blocked is not null and v_blocked > v_now then
    return query select false, null::bigint,
      '호출 중단 중 (재개 ' || to_char(v_blocked, 'YYYY-MM-DD HH24:MI:SSOF') || ') '
        || coalesce(v_reason, ''),
      0;
    return;
  end if;

  -- Reserve the collect-source KST daily allowance under the same lock as the
  -- minute counters. Include pending/error rows: a crashed caller must never
  -- free a possibly-started external request. Interactive calls do not use it.
  if v_source = 'collect' then
    v_day_start := date_trunc('day', v_now at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
    select count(*)::int into v_day_used
      from public.coupang_api_calls
     where source = 'collect'
       and called_at >= v_day_start
       and called_at < v_day_start + interval '1 day';
    if v_day_used >= 3400 then
      return query select false, null::bigint,
        'collector 하루 호출 예산 ' || v_day_used || '/3400', v_day_used;
      return;
    end if;
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

  insert into public.coupang_api_calls (api_type, source, keyword, outcome, called_at)
  values ('search', v_source, left(coalesce(p_keyword, ''), 80), 'pending', v_now)
  returning id into v_id;

  return query select true, v_id, ''::text, v_search_used + 1;
end;
$$;

-- CREATE OR REPLACE keeps the existing service_role-only privileges.
revoke all on function public.coupang_acquire_v2(text,text,int,int,int,int) from public, anon, authenticated;
grant execute on function public.coupang_acquire_v2(text,text,int,int,int,int) to service_role;
notify pgrst, 'reload schema';