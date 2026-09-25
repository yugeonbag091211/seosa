-- ══════════════════════════════════════════════════════════════════
--  2026-09-25-price-drop-state.sql 되돌리기
--
--  ★ 먼저 Vercel 의 PRICE_DROP_SOURCE 를 지우고 재배포해 /api/init 이 기존 뷰
--    price_drop_top 을 읽게 한다. 그다음 저장소 변수 PRICE_DROP_STATE_ENABLED 를 지워
--    갱신 워크플로를 멈춘다. 그 뒤에 이 파일을 실행한다.
--  ★ 지우는 것은 원장에서 다시 만들 수 있는 파생 데이터뿐이다.
--    price_history · products · price_drop_top 은 건드리지 않는다.
-- ══════════════════════════════════════════════════════════════════

begin;
set local lock_timeout = '2s';

drop view if exists public.price_drop_top_fast;
drop function if exists public.price_drop_state_rebuild_batch(text, integer);
drop function if exists public.price_drop_state_refresh_recent(integer);
drop function if exists public.price_drop_state_apply(text[]);
drop table if exists public.price_drop_state_meta;
drop table if exists public.price_drop_state;

commit;

notify pgrst, 'reload schema';
