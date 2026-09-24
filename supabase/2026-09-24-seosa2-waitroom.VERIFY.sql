-- 2026-09-24-seosa2-waitroom.sql 적용 확인 — 읽기 전용 (행을 만들지 않는다).

-- 1) 표가 있다
select to_regclass('public.waitroom_items') is not null as items_exists,
       to_regclass('public.waitroom_notifications') is not null as notifications_exists;

-- 2) RLS 가 켜져 있다
select relname, relrowsecurity as rls_enabled
  from pg_class
 where oid in ('public.waitroom_items'::regclass, 'public.waitroom_notifications'::regclass);

-- 3) 권한: anon/authenticated 는 모두 false. service_role 은 items CRUD,
--    notifications 는 DELETE 없이, sequence 는 USAGE/SELECT 만 가능해야 한다.
select r as role,
       has_table_privilege(r, 'public.waitroom_items', 'select') as items_select,
       has_table_privilege(r, 'public.waitroom_items', 'insert') as items_insert,
       has_table_privilege(r, 'public.waitroom_items', 'update') as items_update,
       has_table_privilege(r, 'public.waitroom_items', 'delete') as items_delete,
       has_table_privilege(r, 'public.waitroom_notifications', 'select') as notif_select,
       has_table_privilege(r, 'public.waitroom_notifications', 'insert') as notif_insert,
       has_table_privilege(r, 'public.waitroom_notifications', 'update') as notif_update,
       has_table_privilege(r, 'public.waitroom_notifications', 'delete') as notif_delete,
       has_sequence_privilege(r, 'public.waitroom_items_id_seq', 'usage') as items_seq_usage,
       has_sequence_privilege(r, 'public.waitroom_items_id_seq', 'select') as items_seq_select,
       has_sequence_privilege(r, 'public.waitroom_items_id_seq', 'update') as items_seq_update,
       has_sequence_privilege(r, 'public.waitroom_notifications_id_seq', 'usage') as notif_seq_usage,
       has_sequence_privilege(r, 'public.waitroom_notifications_id_seq', 'select') as notif_seq_select,
       has_sequence_privilege(r, 'public.waitroom_notifications_id_seq', 'update') as notif_seq_update
  from unnest(array['anon', 'authenticated', 'service_role']) as r;

-- 4) RLS policy count — service_role-only tables must have no end-user policies
select count(*) as policies_expected_zero
  from pg_policies
 where schemaname = 'public'
   and tablename in ('waitroom_items', 'waitroom_notifications');

-- 5) 중복 방지 제약이 있다
select conname from pg_constraint
 where conname in ('waitroom_items_series_key', 'waitroom_notifications_once_per_day');

-- 5) 운영 관찰용: 상태별 항목 수와 최근 7일 발송 결과
select status, armed, count(*) from public.waitroom_items group by status, armed order by status, armed;
select status, count(*) from public.waitroom_notifications
 where created_at > now() - interval '7 days' group by status;
