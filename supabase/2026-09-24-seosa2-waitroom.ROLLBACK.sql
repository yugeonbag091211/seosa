-- 2026-09-24-seosa2-waitroom.sql 되돌리기.
--
-- ⚠️ 사용자가 등록한 대기실 항목과 발송 기록이 함께 사라진다 (다른 표에는 영향 없음).
--    되돌리기 전에 필요하면 내보내 둘 것:
--      copy (select * from public.waitroom_items) to stdout with csv header;
-- 표가 없어지면 /api/waitroom 은 503 WAITROOM_NOT_READY 로 닫히고 알림 잡은 아무것도 하지 않는다.
drop table if exists public.waitroom_notifications;
drop table if exists public.waitroom_items;
notify pgrst, 'reload schema';
