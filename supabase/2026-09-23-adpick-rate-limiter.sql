-- ══════════════════════════════════════════════════════════════════
-- ADPICK 전역 호출 리미터 (2026-09-23)
--
-- 공식 한도: 상품 검색 «분당 10회, API 키 기준» (ADPICK BIZ API 가이드).
-- 키 하나를 수집기(GitHub Actions)·Vercel(검색·cron)·핫딜 workflow 가 나눠 쓰는데,
-- 리미터가 프로세스마다 따로라 합을 막지 못했다. 2026-09-01 이후 429 22건이
-- 전부 직전 60초의 11·12번째 호출이었다 (서로 다른 프로세스의 합 포함).
--
-- adpick_acquire 는 모든 경로의 예약을 advisory lock 하나로 줄 세운다.
--   · 새 슬롯은 «가장 최근 p_max_per_min 번째 슬롯 + 60초 + 여유» 이후다
--     → 임의의 연속 60초(양 끝 포함)에 p_max_per_min 개 이하
--   · 기다려야 하는 시간이 p_max_wait_ms 를 넘으면 예약하지 않고 거절한다
--   · 예약은 «허가 = 카운트» — 거절된 요청은 행을 남기지 않는다
--
-- 클라이언트: api/_adpicklimit.js createGlobalAcquire (api/_adpick.js 가 부른다).
-- 이 파일을 적용하지 않아도 서비스는 그대로 돈다 — 함수가 없으면 클라이언트가
-- 프로세스 안 한도만 쓴다 (분당 기본 3회, 수집기 5회).
--
-- 안전성
--   · 새 표·새 함수만 만든다. 기존 표를 읽거나 쓰지 않는다.
--   · create ... if not exists / create or replace 뿐이다 — 여러 번 실행해도 된다.
--   · 표는 RLS 를 켜고 anon/authenticated 권한을 모두 뺀다. service_role 만 쓴다.
--   · 되돌리기: supabase/2026-09-23-adpick-rate-limiter.ROLLBACK.sql
--   · 적용 확인: supabase/2026-09-23-adpick-rate-limiter.VERIFY.sql
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.adpick_rate_slots (
  id         bigserial   primary key,
  bucket     text        not null,               -- 'search' 등 (API 기능별 한도가 다르다)
  slot_at    timestamptz not null,               -- 호출이 나가도 되는 가장 이른 시각
  source     text        not null default '',    -- collect / search / cron / external-hotdeal …
  created_at timestamptz not null default now()
);

comment on table public.adpick_rate_slots is
  'ADPICK 전역 호출 예약. adpick_acquire() 만 쓴다. 10분 지난 행은 함수가 스스로 지운다.';

create index if not exists adpick_rate_slots_bucket_slot_idx
  on public.adpick_rate_slots (bucket, slot_at desc);

alter table public.adpick_rate_slots enable row level security;
revoke all on table public.adpick_rate_slots from public, anon, authenticated;
revoke all on sequence public.adpick_rate_slots_id_seq from public, anon, authenticated;
grant select, insert, delete on table public.adpick_rate_slots to service_role;
grant usage, select on sequence public.adpick_rate_slots_id_seq to service_role;

create or replace function public.adpick_acquire(
  p_bucket        text,
  p_max_per_min   int,
  p_margin_ms     int,
  p_not_before_ms int,
  p_max_wait_ms   int,
  p_source        text
)
returns table (allowed boolean, wait_ms int, reason text, used int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_slot timestamptz;
  v_last timestamptz;
  v_kth  timestamptz;
  v_used int;
  v_wait int;
begin
  -- 공식 한도(분당 10회)를 넘는 상한은 받지 않는다 — 클라이언트 설정 실수로 한도를 올릴 수 없다.
  if p_max_per_min is null or p_max_per_min < 1 or p_max_per_min > 10 then
    raise exception 'adpick_acquire: p_max_per_min 은 1..10 이어야 한다 (공식 한도 분당 10회), 받은 값 %', p_max_per_min;
  end if;

  -- 이 함수 전용 락 번호 (coupang_acquire 는 8912042601).
  perform pg_advisory_xact_lock(8912042602);

  delete from public.adpick_rate_slots
   where bucket = p_bucket and slot_at < v_now - interval '10 minutes';

  select max(s.slot_at) into v_last
    from public.adpick_rate_slots s where s.bucket = p_bucket;

  select s.slot_at into v_kth
    from public.adpick_rate_slots s
   where s.bucket = p_bucket
   order by s.slot_at desc
  offset p_max_per_min - 1
   limit 1;

  v_slot := v_now + make_interval(secs => greatest(coalesce(p_not_before_ms, 0), 0) / 1000.0);
  -- 슬롯은 시간 순으로만 늘어난다 — 앞선 예약보다 앞당기지 않는다.
  if v_last is not null and v_last > v_slot then
    v_slot := v_last;
  end if;
  -- 최근 p_max_per_min 개 중 가장 이른 것이 60초(+여유) 밖으로 나가야 한 자리가 난다.
  if v_kth is not null then
    v_slot := greatest(v_slot,
      v_kth + make_interval(secs => 60 + (greatest(coalesce(p_margin_ms, 0), 0) + 1) / 1000.0));
  end if;

  v_wait := ceil(extract(epoch from (v_slot - v_now)) * 1000)::int;

  -- 지금 기준 최근 60초에 이미 잡힌 예약 수 (로그·거절 사유용).
  select count(*)::int into v_used
    from public.adpick_rate_slots s
   where s.bucket = p_bucket and s.slot_at > v_now - interval '60 seconds';

  if v_wait > greatest(coalesce(p_max_wait_ms, 0), 0) then
    return query select false, v_wait, '전역 분당 한도'::text, v_used;
    return;
  end if;

  insert into public.adpick_rate_slots (bucket, slot_at, source)
  values (p_bucket, v_slot, left(coalesce(p_source, ''), 40));

  return query select true, greatest(v_wait, 0), ''::text, v_used + 1;
end;
$$;

revoke all on function public.adpick_acquire(text, int, int, int, int, text) from public, anon, authenticated;
grant execute on function public.adpick_acquire(text, int, int, int, int, text) to service_role;

-- PostgREST 가 새 함수를 바로 보게 한다.
notify pgrst, 'reload schema';
