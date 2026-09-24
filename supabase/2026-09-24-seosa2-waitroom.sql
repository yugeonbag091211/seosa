-- ══════════════════════════════════════════════════════════════════
-- SEOSA 2.0 ② 구매 대기실 (2026-09-24) — ★ 아직 운영에 적용하지 않았다. 승인 후 적용.
--
-- 사용자가 관심 상품에 목표가를 걸어 두면, scripts/check-waitroom.js 가 매일 이미
-- 수집된 가격(price_history)을 보고 목표가에 닿은 항목에만 이메일을 한 번 보낸다.
--
-- 왜 기존 alerts 표를 쓰지 않는가
--   · alerts 는 UNIQUE (email, title) 이다 — 같은 이름의 다른 상품·다른 옵션을 가르지 못한다.
--     대기실은 가격 계열 단위 (product_id, mall, vendor_item_id) 로 묶어야 한다.
--   · alerts.sent 는 한 번 true 가 되면 돌아오지 않는다(메일 문구도 그렇게 약속한다).
--     대기실은 가격이 다시 올랐다 내려오면 «다시 무장» 한다 — 의미가 다르다.
--   · 운영 중인 check-alerts.js 와 그 메일 약속을 바꾸지 않으려고 표를 나눈다.
--
-- 중복 알림 방지 (세 겹)
--   1) waitroom_notifications UNIQUE (item_id, notify_date) — 같은 날 두 번 선점할 수 없다.
--      잡이 두 개 겹쳐 돌아도 행을 먼저 넣은 쪽만 메일을 보낸다.
--   2) waitroom_items.armed — 알린 뒤 false. 가격이 목표가 × 1.03 위로 올라갔다가 와야 다시 true.
--   3) notified_at — 같은 항목은 7일에 한 번을 넘지 않는다 (코드 api/_waitroom.js COOLDOWN_DAYS).
--
-- 안전성
--   · 새 표 두 개만 만든다. 기존 표(alerts·products·price_history …)를 읽지도 쓰지도 않는다.
--   · create ... if not exists 뿐이다 — 여러 번 실행해도 된다. DROP/TRUNCATE/DELETE 없음.
--   · 두 표 모두 RLS 를 켜고 anon/authenticated 권한을 모두 뺀다. service_role 만 쓴다
--     (API 는 서버에서 service key 로만 접근하고, 신원은 서명 토큰에서만 꺼낸다).
--   · 되돌리기: supabase/2026-09-24-seosa2-waitroom.ROLLBACK.sql
--   · 적용 확인: supabase/2026-09-24-seosa2-waitroom.VERIFY.sql
--   · 이 파일이 없으면 /api/waitroom 은 503 WAITROOM_NOT_READY 로 닫히고, 알림 잡은 아무것도 하지 않는다.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.waitroom_items (
  id              bigserial   primary key,
  email           text        not null,
  product_id      text        not null,
  mall            text        not null,
  vendor_item_id  text        not null default '',
  title           text        not null default '',
  image           text        not null default '',
  link            text        not null default '',
  target_price    integer     not null check (target_price > 0 and target_price <= 100000000),
  status          text        not null default 'WAITING'
                              check (status in ('WAITING', 'REACHED', 'PAUSED')),
  armed           boolean     not null default true,
  last_price      integer,
  last_price_at   timestamptz,
  notified_at     timestamptz,
  notified_price  integer,
  notify_count    integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint waitroom_items_series_key unique (email, product_id, mall, vendor_item_id)
);

comment on table public.waitroom_items is
  'SEOSA 2.0 구매 대기실. 사용자별 관심 상품과 목표가. api/_waitroom-api.js · scripts/check-waitroom.js 만 쓴다.';

create index if not exists waitroom_items_email_idx on public.waitroom_items (email);
create index if not exists waitroom_items_active_idx on public.waitroom_items (status, id);

create table if not exists public.waitroom_notifications (
  id            bigserial   primary key,
  item_id       bigint      not null references public.waitroom_items (id) on delete cascade,
  email         text        not null,
  notify_date   date        not null,
  price         integer     not null,
  target_price  integer     not null,
  status        text        not null default 'claimed'
                            check (status in ('claimed', 'sent', 'failed')),
  attempts      integer     not null default 1,
  error         text        not null default '',
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  constraint waitroom_notifications_once_per_day unique (item_id, notify_date)
);

comment on table public.waitroom_notifications is
  'SEOSA 2.0 구매 대기실 발송 기록 겸 선점표. (item_id, notify_date) UNIQUE 가 중복 발송을 막는다.';

create index if not exists waitroom_notifications_email_idx on public.waitroom_notifications (email, created_at desc);

alter table public.waitroom_items enable row level security;
alter table public.waitroom_notifications enable row level security;

revoke all on table public.waitroom_items from public, anon, authenticated, service_role;
revoke all on table public.waitroom_notifications from public, anon, authenticated, service_role;
revoke all on sequence public.waitroom_items_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.waitroom_notifications_id_seq from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.waitroom_items to service_role;
grant select, insert, update on table public.waitroom_notifications to service_role;
grant usage, select on sequence public.waitroom_items_id_seq to service_role;
grant usage, select on sequence public.waitroom_notifications_id_seq to service_role;

notify pgrst, 'reload schema';
