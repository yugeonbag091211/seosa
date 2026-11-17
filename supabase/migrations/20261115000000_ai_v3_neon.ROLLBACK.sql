-- 20261115000000_ai_v3_neon.sql 되돌리기 (승인 후에만).
--
-- 먼저 할 일: Vercel Production 의 ENABLE_AI_V3 를 0 으로(또는 AI_V3_ROLLOUT_PERCENT 를 0 으로) 내린다.
-- 그러면 회로 판정 전에 legacy 로 간다(api/_ai-v3-route.js gate='off'/'not_assigned') — 표를 지우기 전에
-- v3 경로가 이 객체를 더는 찾지 않게 하는 것이 순서다.
--
-- ai_v3_profiles 에는 사용자 선호(해시된 user_id)가 쌓인다. 지우면 되돌릴 수 없다 — 필요하면 먼저 내보낸다:
--   \copy (select * from public.ai_v3_profiles) to 'ai_v3_profiles_backup.csv' csv header

begin;
drop function if exists public.merge_ai_v3_user_profile(text, text, text, bigint, bigint);
drop table if exists public.ai_v3_monitor_events;
drop table if exists public.ai_v3_profiles;
commit;
