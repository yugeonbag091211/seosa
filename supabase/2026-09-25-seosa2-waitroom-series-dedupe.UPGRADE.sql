-- ══════════════════════════════════════════════════════════════════
--  2026-09-25  구매 대기실 발송 기록을 «항목» 이 아니라 «사람·상품» 단위로 (첫 판 적용 환경 전용)
--
--  ★ 운영에는 필요 없다. 운영은 대기실 표가 아직 없으므로 고친
--    supabase/2026-09-24-seosa2-waitroom.sql 을 처음부터 적용하면 된다.
--    이 파일은 첫 판(item_id 기준 UNIQUE · on delete cascade)을 이미 적용한
--    테스트 프로젝트(seosa-pr73-waitroom-test)를 새 모양으로 올릴 때만 쓴다.
--  ★ 행을 지우지 않는다. 컬럼 둘을 더하고 기존 행에 채운 뒤 제약만 바꾼다.
--    여러 번 실행해도 결과가 같다.
--  ★ 같은 사람·같은 상품·같은 날짜 발송 기록이 둘 이상이면(첫 판의 중복 버그가 이미 일어난
--    흔적) 새 UNIQUE 를 만들 수 없어 여기서 멈춘다 — 그 행들을 먼저 확인할 것.
-- ══════════════════════════════════════════════════════════════════

begin;
set local lock_timeout = '2s';

-- 수신 동의 시각 (기존 항목은 NULL = 동의 기록 없음 → 다시 저장해 동의할 때까지 보내지 않는다)
alter table public.waitroom_items add column if not exists consent_at timestamptz;

alter table public.waitroom_notifications add column if not exists product_id text;
alter table public.waitroom_notifications add column if not exists mall text;

update public.waitroom_notifications n
   set product_id = i.product_id, mall = i.mall
  from public.waitroom_items i
 where n.item_id = i.id
   and (n.product_id is null or n.mall is null);

alter table public.waitroom_notifications alter column product_id set not null;
alter table public.waitroom_notifications alter column mall set not null;
alter table public.waitroom_notifications alter column item_id drop not null;

do $$
declare
  r record;
begin
  -- 항목 FK: on delete cascade → on delete set null
  for r in
    select conname from pg_constraint
     where conrelid = 'public.waitroom_notifications'::regclass and contype = 'f' and confdeltype <> 'n'
  loop
    execute format('alter table public.waitroom_notifications drop constraint %I', r.conname);
  end loop;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.waitroom_notifications'::regclass and contype = 'f') then
    alter table public.waitroom_notifications
      add constraint waitroom_notifications_item_id_fkey
      foreign key (item_id) references public.waitroom_items (id) on delete set null;
  end if;

  -- 같은 날 한 통: (item_id, notify_date) → (email, product_id, mall, notify_date)
  if exists (select 1 from pg_constraint
              where conrelid = 'public.waitroom_notifications'::regclass
                and conname = 'waitroom_notifications_once_per_day'
                and pg_get_constraintdef(oid) not like '%(email, product_id, mall, notify_date)%') then
    alter table public.waitroom_notifications drop constraint waitroom_notifications_once_per_day;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.waitroom_notifications'::regclass
                    and conname = 'waitroom_notifications_once_per_day') then
    alter table public.waitroom_notifications
      add constraint waitroom_notifications_once_per_day unique (email, product_id, mall, notify_date);
  end if;
end $$;

create index if not exists waitroom_notifications_series_idx
  on public.waitroom_notifications (email, product_id, mall, created_at desc);

comment on table public.waitroom_notifications is
  'SEOSA 2.0 구매 대기실 발송 기록 겸 선점표. (email, product_id, mall, notify_date) UNIQUE 가 중복 발송을 막는다.';

commit;

notify pgrst, 'reload schema';
