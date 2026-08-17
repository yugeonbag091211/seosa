-- ══════════════════════════════════════════════════════════════════
--  2026-08-17  PRO 구독 결제 (토스페이먼츠) — payments + subscriptions 확장
--
--  ★ 실행 순서 ★
--    1) supabase/2026-08-17-ai-monetization.sql   ← subscriptions 를 만든다
--    2) 이 파일                                    ← subscriptions 에 컬럼을 더한다
--    3) 코드 배포
--    순서를 지키지 않으면 아래 alter table 이 "relation does not exist" 로 실패한다.
--
--  안전성
--    - CREATE / ADD COLUMN 만 한다. DROP / DELETE / TRUNCATE 없음.
--    - 기존 컬럼의 타입·기본값을 바꾸지 않는다.
--    - price_history / products / profiles 등 기존 테이블을 건드리지 않는다.
--    - 전부 IF NOT EXISTS 라 몇 번을 실행해도 안전하다.
--
--  ── 카드 정보에 대하여 ──────────────────────────────────────────
--    카드번호·유효기간·CVC 는 우리 DB 에 저장하지 않는다. 저장할 수도 없다 —
--    결제창이 카드 정보를 토스로 직접 보내고, 우리는 그 결과로 billingKey 만
--    받는다. billingKey 는 "이 고객에게 청구해도 된다"는 토큰이지 카드 정보가
--    아니다. 그래도 유출되면 청구가 가능하므로 서버 전용으로 다룬다(RLS).
-- ══════════════════════════════════════════════════════════════════


-- ── 1. payments — 결제 원장 ─────────────────────────────────────
--
-- 결제는 되돌리기가 비싼 도메인이라 "무슨 일이 있었는지"를 남긴다.
-- 이 표가 있어야 나중에 정산 대조와 환불 처리가 가능하다.
create table if not exists payments (
  id          bigserial   primary key,
  email       text        not null,
  -- 우리가 만든 주문번호. 같은 주문으로 두 번 결제되지 않게 UNIQUE.
  order_id    text        not null,
  -- 결제사(토스)가 만든 결제 식별자. 웹훅 재전송 멱등성의 핵심.
  payment_key text        not null,
  amount      integer     not null,
  currency    text        not null default 'KRW',
  -- paid / failed / canceled  (애플리케이션 정의)
  status      text        not null,
  provider    text        not null default 'toss',
  -- 결제사 원본 상태값(DONE / CANCELED / ...) 을 그대로 보관해 대조에 쓴다.
  raw_status  text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint payments_amount_chk check (amount >= 0),
  -- ★ 멱등성의 근거. 웹훅이 두 번 와도 두 번째 insert 가 여기서 튕긴다.
  constraint payments_order_id_key    unique (order_id),
  constraint payments_payment_key_key unique (payment_key)
);

create index if not exists payments_email_created_idx on payments (email, created_at desc);
create index if not exists payments_status_idx        on payments (status);


-- ── 2. subscriptions 확장 ───────────────────────────────────────
--
-- 2026-08-17-ai-monetization.sql 이 만든 표에 결제 관련 컬럼만 더한다.
-- 기존 컬럼(email/plan/status/expires_at)은 그대로 둔다.
alter table subscriptions add column if not exists provider     text;
-- 결제사에 보내는 고객 식별자. 이메일에서 파생한 값이라 이메일이 새지 않는다.
alter table subscriptions add column if not exists customer_key text;
/*
 * ★ billing_key — 서버 전용.
 *   이 값이면 카드 없이 청구가 된다. 어떤 API 응답에도 실리지 않는다
 *   (api/_billing.publicSubscription 이 걷어낸다). RLS 로 service_role 만
 *   읽을 수 있게 막혀 있다.
 *   구독 취소 시 이 값을 null 로 만들어 다음 자동결제를 끊는다.
 */
alter table subscriptions add column if not exists billing_key  text;
alter table subscriptions add column if not exists canceled_at  timestamptz;

-- 자동결제 갱신 대상을 찾을 때 쓴다 (스케줄러는 계약 완료 후 도입).
create index if not exists subscriptions_billing_expires_idx
  on subscriptions (expires_at)
  where billing_key is not null;


-- ── 3. RLS ──────────────────────────────────────────────────────
--
-- subscriptions 는 앞선 마이그레이션에서 이미 켰다. payments 도 같은 패턴 —
-- 정책을 하나도 만들지 않으면 anon / authenticated 는 전부 막히고
-- service_role(서버)만 통과한다.
--
-- 이게 중요한 이유: 사용자가 자기 결제 상태를 'paid' 로 써넣거나 남의 결제
-- 내역을 읽는 것을 DB 레벨에서 막는다.
alter table payments enable row level security;


-- ── 4. PostgREST 스키마 캐시 갱신 ───────────────────────────────
notify pgrst, 'reload schema';


-- ── 확인 쿼리 (읽기 전용, 별도 실행) ────────────────────────────
--
--   select column_name, data_type from information_schema.columns
--    where table_name = 'subscriptions' order by ordinal_position;
--   -- provider / customer_key / billing_key / canceled_at 가 보여야 한다.
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'payments'::regclass and contype = 'u';
--   -- payments_order_id_key / payments_payment_key_key 두 개
--
--   -- anon/authenticated 가 payments 를 읽을 수 없어야 한다:
--   select relname, relrowsecurity from pg_class where relname in ('payments','subscriptions');
--   -- 기대: 둘 다 relrowsecurity = true
