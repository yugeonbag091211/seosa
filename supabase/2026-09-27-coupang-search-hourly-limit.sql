-- 쿠팡 파트너스 Search 공식 시간당 10회 제한을 모든 서비스/작업에 전역 적용한다.
-- 기존 예약 기록은 유지하며, 호출 허가 함수만 원자적으로 교체한다.
-- 공식 가이드: https://partners.coupangcdn.com/partners-guide/partners-guide-20241216163254.pdf

create or replace function public.coupang_acquire(max_per_min int, src text, kw text)
returns table (allowed boolean, call_id bigint, reason text, used int)
language plpgsql
as $$
declare
  v_blocked timestamptz;
  v_reason text;
  v_min_used int;
  v_hour_used int;
  v_id bigint;
begin
  perform pg_advisory_xact_lock(8912042601);

  select s.blocked_until, s.reason into v_blocked, v_reason
    from public.coupang_api_state s where s.id = 1;

  if v_blocked is not null and v_blocked > now() then
    return query select false, null::bigint,
      '호출 중단 중 (재개 ' || to_char(v_blocked, 'YYYY-MM-DD HH24:MI:SSOF') || ') '
        || coalesce(v_reason, ''),
      0;
    return;
  end if;

  select count(*)::int into v_hour_used
    from public.coupang_api_calls
   where called_at > now() - interval '1 hour';

  if v_hour_used >= 10 then
    return query select false, null::bigint,
      '시간당 검색 한도 ' || v_hour_used || '/10', v_hour_used;
    return;
  end if;

  select count(*)::int into v_min_used
    from public.coupang_api_calls
   where called_at > now() - interval '1 minute';

  if v_min_used >= max_per_min then
    return query select false, null::bigint,
      '분당 한도 ' || v_min_used || '/' || max_per_min, v_min_used;
    return;
  end if;

  insert into public.coupang_api_calls (source, keyword, outcome)
  values (left(coalesce(src, ''), 40), left(coalesce(kw, ''), 80), 'pending')
  returning id into v_id;

  return query select true, v_id, ''::text, v_min_used + 1;
end;
$$;

notify pgrst, 'reload schema';