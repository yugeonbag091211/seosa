-- 2026-09-23-adpick-rate-limiter.sql 적용 확인 — 읽기 전용 (예약 행을 만들지 않는다).

-- 1) 표·함수가 있다
select to_regclass('public.adpick_rate_slots') is not null as table_exists,
       to_regprocedure('public.adpick_acquire(text,int,int,int,int,text)') is not null as function_exists;

-- 2) RLS 가 켜져 있다
select relrowsecurity as rls_enabled from pg_class where oid = 'public.adpick_rate_slots'::regclass;

-- 3) 권한: service_role 만 실행·조회할 수 있다 (anon/authenticated 는 false 여야 한다)
select r as role,
       has_function_privilege(r, 'public.adpick_acquire(text,int,int,int,int,text)', 'execute') as can_execute,
       has_table_privilege(r, 'public.adpick_rate_slots', 'select') as can_select
  from unnest(array['anon', 'authenticated', 'service_role']) as r;

-- 4) 최근 예약 (운영 관찰용): 버킷별 최근 60초 슬롯 수 — 상한 이하여야 한다
select bucket, count(*) as slots_last_60s
  from public.adpick_rate_slots
 where slot_at > now() - interval '60 seconds'
 group by bucket;
