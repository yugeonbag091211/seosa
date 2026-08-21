-- ══════════════════════════════════════════════════════════════════
--  2026-08-17  AI Concierge 유료화 — subscriptions / ai_usage / quota RPC
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 붙여넣고 Run.
--
--  ★ 배포 순서 (price_history 마이그레이션과 반대다) ★
--
--    AI 유료화는 코드가 새 테이블·RPC 에 의존한다. 따라서
--      1) 이 SQL 을 먼저 실행    → 테이블/RPC 생성
--      2) 그 다음 코드 배포
--    순서를 뒤집으면 배포 직후부터 ai_quota_reserve 를 못 찾아
--    api/_plan.js 가 fail-closed 로 동작하고 AI 가 전부 429 가 된다.
--    (반대로 price_history 쪽은 코드가 먼저였다 — 혼동하지 말 것)
--
--  안전성
--    - CREATE 만 한다. DROP / DELETE / UPDATE / TRUNCATE / ALTER 없음.
--    - 기존 테이블(price_history, products, profiles, alerts, user_data,
--      auth_codes …)을 일절 건드리지 않는다.
--    - 전부 IF NOT EXISTS / OR REPLACE 라 몇 번을 실행해도 안전하다.
--    - 기존 사용자 데이터를 만들지도 지우지도 않는다. subscriptions 행이
--      없는 사용자는 코드에서 자동으로 FREE 로 처리된다.
-- ══════════════════════════════════════════════════════════════════


-- ── 1. subscriptions ────────────────────────────────────────────
--
-- 이메일이 곧 사용자 식별자다 (이 프로젝트에는 계정 테이블이 없고
-- profiles.email 이 primary key 다 — supabase/schema.sql 참고).
create table if not exists subscriptions (
  email       text        primary key,
  plan        text        not null default 'free',
  status      text        not null default 'active',
  -- null = 무기한. 결제 연동 전 수동 PRO 지정에도 쓴다.
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint subscriptions_plan_chk   check (plan   in ('free', 'pro')),
  constraint subscriptions_status_chk check (status in ('active', 'inactive'))
);

-- 만료 예정 구독을 훑을 때 쓴다 (향후 결제/알림 배치).
create index if not exists subscriptions_status_expires_idx
  on subscriptions (status, expires_at);


-- ── 2. ai_usage ─────────────────────────────────────────────────
--
-- usage_date 는 반드시 KST 달력 날짜다. 애플리케이션이 api/_kst.js 의
-- kstToday() 로 계산해서 넘긴다.
--
-- ★ DB 의 current_date 를 기본값으로 쓰지 않는다.
--   Supabase 인스턴스 타임존은 UTC 라서 current_date 를 쓰면 한국 사용자의
--   하루 한도가 오전 9시에 초기화된다. 날짜 기준은 애플리케이션 한 곳에서만
--   정한다 (price_history.recorded_date 와 같은 원칙).
create table if not exists ai_usage (
  email       text        not null,
  usage_date  date        not null,
  used        integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ai_usage_used_chk check (used >= 0),
  -- 원자적 예약(ON CONFLICT)의 대상이 되는 키. 반드시 있어야 한다.
  constraint ai_usage_email_date_key unique (email, usage_date)
);

create index if not exists ai_usage_email_date_idx
  on ai_usage (email, usage_date desc);


-- ── 3. RLS ──────────────────────────────────────────────────────
--
-- 이 프로젝트는 서버가 SUPABASE_SECRET_KEY(service_role 상당)로만 DB 에
-- 접근하고, 프론트엔드는 Supabase 키를 들고 있지 않다.
-- 정책을 하나도 만들지 않으면 anon / authenticated 는 전부 차단되고
-- service_role 만 통과한다 — 기존 alerts/profiles/user_data 와 같은 패턴이다.
--
-- 이게 중요한 이유: 사용자가 자기 plan 을 'pro' 로 바꾸거나 used 를 0 으로
-- 되돌리는 것을 DB 레벨에서 원천 차단한다.
alter table subscriptions enable row level security;
alter table ai_usage      enable row level security;


-- ── 4. 사용량 예약 RPC (원자적) ─────────────────────────────────
--
-- 동시에 20개의 요청이 들어와도 한도가 3이면 정확히 3개만 성공해야 한다.
--
-- 핵심은 `on conflict do update ... where` 다. UPDATE 가 행 잠금을 잡으므로
-- 동시 요청이 직렬화되고, used 가 한도에 도달한 뒤부터는 WHERE 가 거짓이라
-- 아무 행도 반환되지 않는다 → 그 요청은 거절.
--
-- returning 이 비었을 때 현재 사용량을 다시 읽어 함께 돌려준다(표시용).
create or replace function ai_quota_reserve(
  p_email text,
  p_date  date,
  p_limit integer
)
returns table (used integer, allowed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  -- 한도가 0 이하면 최초 INSERT(=1) 자체가 새어 나가므로 먼저 막는다.
  if p_limit is null or p_limit <= 0 then
    select au.used into v_used
      from ai_usage au where au.email = p_email and au.usage_date = p_date;
    return query select coalesce(v_used, 0), false;
    return;
  end if;

  insert into ai_usage (email, usage_date, used)
  values (p_email, p_date, 1)
  on conflict (email, usage_date)
  do update set used = ai_usage.used + 1,
                updated_at = now()
    where ai_usage.used < p_limit
  returning ai_usage.used into v_used;

  if v_used is null then
    -- 한도 초과 — 증가시키지 않고 현재 값만 돌려준다.
    select au.used into v_used
      from ai_usage au where au.email = p_email and au.usage_date = p_date;
    return query select coalesce(v_used, 0), false;
  else
    return query select v_used, true;
  end if;
end;
$$;


-- ── 5. 사용량 되돌리기 RPC ──────────────────────────────────────
--
-- 업스트림(OpenRouter) 5xx·타임아웃으로 사용자가 답을 못 받았을 때만 부른다.
-- 0 밑으로는 내려가지 않는다.
create or replace function ai_quota_release(
  p_email text,
  p_date  date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  update ai_usage
     set used = greatest(used - 1, 0),
         updated_at = now()
   where email = p_email and usage_date = p_date
  returning used into v_used;

  return coalesce(v_used, 0);
end;
$$;


-- ── 6. RPC 권한 ─────────────────────────────────────────────────
--
-- ★ 이 블록이 없으면 위 두 함수는 security definer 라서 오히려 위험해진다.
--   PostgREST 는 anon / authenticated 롤로 함수를 노출하므로, 권한을 회수하지
--   않으면 누구나 다음을 할 수 있다.
--     · 남의 이메일로 ai_quota_release 를 반복 호출해 사용량을 0 으로 되돌리기
--     · p_limit 을 원하는 값으로 넘겨 한도를 무력화하기
--   한도를 정하는 주체는 언제나 서버(api/_plan.js)여야 한다.
revoke all on function ai_quota_reserve(text, date, integer) from public;
revoke all on function ai_quota_release(text, date)          from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function ai_quota_reserve(text, date, integer) from anon';
    execute 'revoke all on function ai_quota_release(text, date)          from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function ai_quota_reserve(text, date, integer) from authenticated';
    execute 'revoke all on function ai_quota_release(text, date)          from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function ai_quota_reserve(text, date, integer) to service_role';
    execute 'grant execute on function ai_quota_release(text, date)          to service_role';
  end if;
end $$;


-- ── 7. PostgREST 스키마 캐시 갱신 ───────────────────────────────
notify pgrst, 'reload schema';


-- ── 확인 쿼리 (읽기 전용, 별도 실행) ────────────────────────────
--
--   select table_name from information_schema.tables
--    where table_name in ('subscriptions', 'ai_usage');
--
--   select proname, prosecdef from pg_proc
--    where proname in ('ai_quota_reserve', 'ai_quota_release');
--
--   -- anon/authenticated 가 실행 권한을 갖고 있으면 안 된다:
--   select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute')
--     from pg_proc p
--     cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
--    where p.proname in ('ai_quota_reserve','ai_quota_release');
--   -- 기대: anon=false, authenticated=false, service_role=true
--
--
-- ── 수동 PRO 지정 (결제 연동 전 테스트용, 별도 실행) ─────────────
--
--   insert into subscriptions (email, plan, status, expires_at)
--   values ('tester@example.com', 'pro', 'active', now() + interval '30 days')
--   on conflict (email) do update
--     set plan = 'pro', status = 'active',
--         expires_at = excluded.expires_at, updated_at = now();
