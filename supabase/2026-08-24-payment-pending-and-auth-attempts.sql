-- ══════════════════════════════════════════════════════════════════
--  2026-08-24  결제 pending 원장 + 인증코드 시도 원자화 + 갱신 추적
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 통째로 붙여넣고 Run.
--
--  안전성
--    - DROP / TRUNCATE / DELETE 가 하나도 없다.
--    - 기존 컬럼의 타입·기본값을 바꾸지 않는다.
--    - ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--      CREATE OR REPLACE FUNCTION 뿐이라 몇 번을 실행해도 안전하다.
--    - 기존 payments / subscriptions 행의 값을 건드리지 않는다.
--
--  선행 조건
--    supabase/2026-08-17-payments.sql 이 먼저 적용되어 있어야 한다
--    (payments 테이블과 subscriptions 의 billing_key 컬럼).
-- ══════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════
--  1. payments — pending / charging 상태
--
--  ── 무엇을 고치는가 ────────────────────────────────────────────
--  예전 흐름은 결제 승인이 끝난 뒤에야 payments 에 행을 만들었다.
--
--    issueBillingKey(≤15s) → chargeBilling(≤60s) → recordPayment → activatePro
--
--  최악 75초인데 Vercel 함수 상한은 60초다. 상한에서 잘리면
--    · 토스에서는 승인이 끝나 카드에 청구됨
--    · 우리 DB 에는 흔적이 하나도 없음  ← 여기가 문제다
--    · 사용자는 "결제 실패" 를 보고 다시 시도 → 새 orderId → 이중 청구
--
--  주문을 "만들 때" 행을 먼저 남기면, 함수가 어디서 죽든 orderId 로
--  무슨 일이 있었는지 되짚을 수 있다. 토스에도 orderId 로 결제를 조회하는
--  API 가 있어서(GET /v1/payments/orders/{orderId}) 대조가 가능하다.
--
--  ── 상태 전이 ──────────────────────────────────────────────────
--    pending   주문만 만들어졌다. 아직 아무 청구도 하지 않았다.
--    charging  토스에 승인을 요청했다. 청구가 됐는지 아직 모른다.
--    paid      승인·검증까지 끝났다. PRO 가 활성화된 상태.
--    failed    승인이 거절됐거나 검증에 실패했다.
--    canceled  결제가 취소·환불됐다 (웹훅).
--
--    pending → charging → paid
--                      → failed
--    paid → canceled
--    그 밖의 전이는 코드에서 거부한다 (api/_billing.js canTransition).
--
--  status 컬럼은 text 라 값 추가에 마이그레이션이 필요 없다. 다만 어떤 값이
--  쓰이는지 스키마에도 남겨 둔다 — 나중에 이 표를 보는 사람이 코드를 뒤지지
--  않아도 되게.
-- ══════════════════════════════════════════════════════════════════

comment on column payments.status is
  'pending | charging | paid | failed | canceled — 전이 규칙은 api/_billing.js canTransition 참고';

-- 미결 주문을 찾는 조회. 복구 배치와 confirm 재시도가 쓴다.
create index if not exists payments_pending_idx
  on payments (order_id)
  where status in ('pending', 'charging');

-- 오래 매달려 있는 미결 주문을 시간순으로 훑을 때.
create index if not exists payments_unsettled_created_idx
  on payments (created_at)
  where status in ('pending', 'charging');


-- ══════════════════════════════════════════════════════════════════
--  2. subscriptions — 자동결제 재시도 추적
--
--  결제가 실패했을 때 매 실행마다 무한히 다시 긁으면 카드사 거절이 쌓이고
--  사용자에게도 결제 시도 알림이 반복해서 간다. 실패 횟수와 마지막 시도
--  시각을 남겨 백오프를 걸 수 있게 한다.
-- ══════════════════════════════════════════════════════════════════

alter table subscriptions add column if not exists last_renew_at    timestamptz;
alter table subscriptions add column if not exists renew_failures   int not null default 0;

comment on column subscriptions.renew_failures is
  '연속 자동결제 실패 횟수. 성공하면 0 으로 돌아간다. 상한에 닿으면 갱신을 포기하고 만료시킨다.';


-- ══════════════════════════════════════════════════════════════════
--  3. auth_codes — 시도 횟수 증가를 원자적으로
--
--  ── 무엇이 문제였나 ────────────────────────────────────────────
--  api/_auth.js consumeCode 가 이렇게 돼 있었다.
--
--    select attempts        -- 읽고
--    if (attempts >= 5) ... -- 비교하고
--    update attempts + 1    -- 쓴다
--
--  요청 100개가 동시에 들어오면 100개 전부 attempts=0 을 읽고 전부 통과한 뒤
--  전부 1 을 쓴다. MAX_ATTEMPTS(5)가 사실상 없는 것과 같다. 6자리 코드를
--  병렬로 긁으면 뚫린다 — 그 토큰은 찜/취향/알림과 PRO 권한까지 준다.
--
--  api/_plan.js 의 ai_quota_reserve 가 같은 함정을 한 문장으로 풀었다.
--  같은 방식을 쓴다.
--
--  ── 왜 이 한 문장이 안전한가 ──────────────────────────────────
--  UPDATE ... WHERE 가 행 잠금을 잡으므로 동시 요청은 직렬화된다. 한도를
--  넘는 순간부터 WHERE 가 거짓이 되어 아무 행도 반환되지 않는다.
--  반환 행이 없으면 그 요청은 거절이다.
--
--  코드 비교(해시 일치 여부)도 이 안에서 한다. 밖에서 하면 "증가"와 "판정"이
--  다시 갈라져 같은 문제가 생긴다.
-- ══════════════════════════════════════════════════════════════════

-- ★ OUT 컬럼을 attempt_count 로 둔 이유 (attempts 가 아니다)
--
--   auth_codes 에 attempts 라는 컬럼이 이미 있다. RETURNS TABLE 의 컬럼명은
--   PL/pgSQL 안에서 변수가 되므로, 같은 이름을 쓰면 함수 본문의
--   attempts 참조가 "column reference is ambiguous" 로 튈 수 있다.
--   이름을 겹치지 않게 두면 그 위험 자체가 사라진다.
--   (호출부 api/_auth.js 는 allowed / matched / expired 만 읽는다)
create or replace function auth_code_attempt(
  p_email text,
  p_hash  text,
  p_max   integer
)
returns table (allowed boolean, matched boolean, attempt_count integer, expired boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash    text;
  v_expires timestamptz;
  v_count   integer;
begin
  -- 시도 횟수를 원자적으로 하나 올린다. 한도를 넘었으면 아무 행도 안 잡힌다.
  update auth_codes a
     set attempts = a.attempts + 1
   where a.email = p_email
     and a.attempts < p_max
  returning a.code_hash, a.expires_at, a.attempts
       into v_hash, v_expires, v_count;

  if not found then
    -- 행이 없거나(코드 미발급) 한도를 넘었다. 둘을 구분해 줄 필요는 없다 —
    -- 호출부는 어느 쪽이든 거절해야 하고, 구분해 알려주면 공격자에게
    -- "이 이메일에 코드가 있다" 는 정보를 준다.
    return query select false, false, p_max, false;
    return;
  end if;

  if v_expires < now() then
    return query select false, false, v_count, true;
    return;
  end if;

  -- 해시 비교. 일치하면 코드를 즉시 폐기해 재사용을 막는다.
  if v_hash = p_hash then
    delete from auth_codes where email = p_email;
    return query select true, true, v_count, false;
    return;
  end if;

  return query select true, false, v_count, false;
end;
$$;

-- ★ security definer 함수는 반드시 실행 권한을 좁혀야 한다.
--   열어 두면 anon 이 직접 호출해 시도 횟수를 마음대로 올리거나
--   (= 남의 코드를 무효화) 코드를 대조해 볼 수 있다.
revoke all on function auth_code_attempt(text, text, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function auth_code_attempt(text, text, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function auth_code_attempt(text, text, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function auth_code_attempt(text, text, integer) to service_role';
  end if;
end $$;


-- ══════════════════════════════════════════════════════════════════
--  4. PostgREST 스키마 캐시 갱신
-- ══════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';


-- ══════════════════════════════════════════════════════════════════
--  5. 적용 확인 — 결과 그리드에 바로 뜬다
--
--  ★ 이 SELECT 가 여기 있는 이유
--
--  Supabase SQL Editor 는 스크립트 전체를 한 트랜잭션으로 실행한다.
--  중간 한 문장이라도 실패하면 앞의 성공분까지 통째로 롤백되고 DB 에는
--  아무것도 남지 않는다. 그런데 편집기 상단에는 "Success" 처럼 보이는
--  메시지가 스쳐 지나갈 수 있어서, 적용됐다고 착각하기 쉽다.
--
--  마지막에 상태를 직접 세어 보여 주면 그 착각이 불가능해진다.
--  아래 세 숫자가 기대값과 다르면 적용되지 않은 것이다.
-- ══════════════════════════════════════════════════════════════════
select
  current_database()                                                as db,
  current_user                                                      as run_as,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'subscriptions'
       and column_name in ('last_renew_at', 'renew_failures'))      as sub_columns_expect_2,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'auth_code_attempt')  as auth_rpc_expect_1,
  (select count(*) from pg_indexes
     where schemaname = 'public' and tablename = 'payments'
       and indexname in ('payments_pending_idx',
                         'payments_unsettled_created_idx'))         as payment_indexes_expect_2;


-- ══════════════════════════════════════════════════════════════════
--  확인 (읽기 전용, 별도로 실행)
--
--   -- 인덱스
--   select indexname from pg_indexes
--    where tablename = 'payments' and indexname like 'payments_%';
--
--   -- 새 컬럼
--   select column_name from information_schema.columns
--    where table_name = 'subscriptions'
--      and column_name in ('last_renew_at', 'renew_failures');
--
--   -- 함수 권한 (anon/authenticated 에 EXECUTE 가 없어야 한다)
--   select p.proname, a.rolname, has_function_privilege(a.rolname, p.oid, 'EXECUTE')
--     from pg_proc p, pg_roles a
--    where p.proname = 'auth_code_attempt'
--      and a.rolname in ('anon','authenticated','service_role');
--
--   -- 미결 주문 (운영 점검용)
--   select order_id, email, amount, status, created_at
--     from payments where status in ('pending','charging')
--    order by created_at;
-- ══════════════════════════════════════════════════════════════════
