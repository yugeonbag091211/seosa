-- 20261115000000_ai_v3_neon.sql 적용 전·후 확인 (읽기 전용 — 맨 아래 «보존» 절만 예외로 주석 처리).
--
-- 적용 전 기대: 1·2·3 이 0, 4 가 neondb_owner 하나
-- 적용 후 기대: 1·2·3 이 1, 5 가 빈 결과(오류 없음), 6 이 0 이상

-- 1. 표
select count(*) as ai_v3_profiles from information_schema.tables where table_schema = 'public' and table_name = 'ai_v3_profiles';
select count(*) as ai_v3_monitor_events from information_schema.tables where table_schema = 'public' and table_name = 'ai_v3_monitor_events';
-- 2. 함수
select count(*) as merge_fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'merge_ai_v3_user_profile';
-- 3. 인덱스
select count(*) as monitor_idx from pg_indexes where schemaname = 'public' and indexname = 'ai_v3_monitor_events_version_created_idx';
-- 4. 역할 (Neon 은 neondb_owner 하나 — Supabase 역할 문장은 건너뛰어야 한다)
select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'neondb_owner') order by 1;
-- 5. 회로가 쓰는 질의와 같은 꼴 (api/_ai-v3-monitor.js check) — 오류 없이 돌아야 한다
select count(*) as v3_events_5m from public.ai_v3_monitor_events
 where version = 'v3' and created_at >= now() - interval '5 minutes';
-- 6. 크기 (보존 정책을 정하기 위한 관찰)
select count(*) as monitor_rows, min(created_at) as oldest from public.ai_v3_monitor_events;

-- 보존 (승인 후 운영자가 주기를 정해 실행 — 회로는 최근 5분만 읽는다)
-- delete from public.ai_v3_monitor_events where created_at < now() - interval '7 days';
