-- 2026-09-23-adpick-rate-limiter.sql 되돌리기.
-- 지우면 클라이언트(api/_adpicklimit.js)가 함수 없음을 알아채고 프로세스 안 한도만 쓴다.
-- 예약 행은 호출 기록이 아니다 (호출 기록은 adpick_api_calls) — 지워도 잃는 데이터가 없다.
drop function if exists public.adpick_acquire(text, int, int, int, int, text);
drop table if exists public.adpick_rate_slots;
notify pgrst, 'reload schema';
