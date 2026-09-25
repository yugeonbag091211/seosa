-- ══════════════════════════════════════════════════════════════════
--  2026-09-25-price-drop-state.sql 되돌리기
--
--  ★ 순서: (1) Vercel PRICE_DROP_SOURCE 삭제 후 재배포 → /api/init 이 기존 뷰로 돌아간다
--          (2) 저장소 변수 PRICE_DROP_STATE_ENABLED 삭제 → 갱신 워크플로 정지
--          (3) 이 파일
--  ★ 지우는 것은 원장에서 다시 만들 수 있는 파생 데이터뿐이다.
--    price_history · products · price_drop_top 은 건드리지 않는다.
--  ★ 첫 판(세대 없는 상태표)을 적용했던 테스트 환경도 이 파일로 치운 뒤 새 판을 적용한다.
-- ══════════════════════════════════════════════════════════════════

begin;
set local lock_timeout = '2s';

drop view if exists public.price_drop_top_fast;

-- 새 판 (세대)
drop function if exists public.price_drop_state_abort_build();
drop function if exists public.price_drop_state_rollback_publish();
drop function if exists public.price_drop_state_publish(bigint, text, numeric, integer);
drop function if exists public.price_drop_state_rebuild_step(bigint, text, integer);
drop function if exists public.price_drop_state_rebuild_start(text);
drop function if exists public.price_drop_state_refresh_recent(integer, integer);
drop function if exists public.price_drop_state_verify(bigint, integer, boolean);
drop function if exists public.price_drop_state_del_count();
drop function if exists public.price_drop_state_apply(bigint, text[]);

-- 첫 판
drop function if exists public.price_drop_state_refresh_recent(integer);
drop function if exists public.price_drop_state_rebuild_batch(text, integer);
drop function if exists public.price_drop_state_apply(text[]);

drop table if exists public.price_drop_state_meta;
drop table if exists public.price_drop_state;
drop sequence if exists public.price_drop_state_gen_seq;

commit;

notify pgrst, 'reload schema';
