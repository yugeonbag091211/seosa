-- AI v3 운영 의존성 — Neon 호환판 (2026-11-15). 승인 전에는 실행하지 않는다.
--
-- 왜 새 파일인가
--   운영 v3 는 한 번도 돌지 않았다. api/_ai-v3-route.js 의 회로가 ai_v3_monitor_events 를 읽지 못하면
--   fail-closed 로 legacy 에 넘기는데, 그 표와 ai_v3_profiles · merge_ai_v3_user_profile 이 운영 DB 에 없다
--   (2026-11-15 읽기 전용 확인). 원래 마이그레이션 20261113000000 · 20261113000001 은 Supabase 용이라
--   `revoke … from anon, authenticated` · `grant … to service_role` 를 담고 있는데, 운영 Neon 에는
--   neondb_owner 역할 하나뿐이다(같은 날 pg_roles 확인). 그대로 실행하면 «role "anon" does not exist» 로
--   트랜잭션 전체가 실패한다. 이 파일은 같은 객체를 만들고, 역할 문장은 그 역할이 있을 때만 실행한다.
--
-- 성질
--   · 멱등: 여러 번 실행해도 같다 (if not exists / create or replace / 역할 존재 확인).
--   · 기존 표·데이터를 바꾸지 않는다. 새 표 2개 · 인덱스 1개 · 함수 1개만 만든다.
--   · 되돌리기: supabase/migrations/20261115000000_ai_v3_neon.ROLLBACK.sql
--   · 확인: supabase/migrations/20261115000000_ai_v3_neon.VERIFY.sql
--   · 보존 정책: ai_v3_monitor_events 는 회로가 최근 5분만 읽는다. 오래된 행 정리는 VERIFY 파일의
--     «보존» 절을 운영자가 정한 주기로 실행한다 (자동 정리는 이 파일에 넣지 않았다 — 지우는 일은 승인 사항).

begin;

create table if not exists public.ai_v3_profiles (
  user_id text primary key check (user_id ~ '^[a-f0-9]{64}$'),
  preferred_brands text[] not null default '{}',
  budget_min bigint check (budget_min > 0),
  budget_max bigint check (budget_max > 0),
  category_interests text[] not null default '{}',
  recent_searches text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (budget_min is null or budget_max is null or budget_min <= budget_max)
);
alter table public.ai_v3_profiles enable row level security;

create table if not exists public.ai_v3_monitor_events (
  created_at timestamptz not null default now(),
  version text not null check (version in ('v3', 'legacy')),
  success boolean not null
);
create index if not exists ai_v3_monitor_events_version_created_idx
  on public.ai_v3_monitor_events (version, created_at desc);
alter table public.ai_v3_monitor_events enable row level security;

-- 원자적 병합(동시 검색이 선호를 잃지 않게). 원래 20261113000000 과 같은 본문이다.
create or replace function public.merge_ai_v3_user_profile(
  p_user_id text, p_brand text, p_category text, p_budget_min bigint, p_budget_max bigint
) returns void language sql security invoker set search_path = '' as $$
  insert into public.ai_v3_profiles as u
    (user_id, preferred_brands, budget_min, budget_max, category_interests, recent_searches)
  values (p_user_id, case when p_brand is null then '{}'::text[] else array[p_brand] end,
    p_budget_min, p_budget_max,
    case when p_category is null then '{}'::text[] else array[p_category] end,
    case when p_category is null then '{}'::text[] else array[p_category] end)
  on conflict (user_id) do update set
    preferred_brands = case when p_brand is null then u.preferred_brands
      else (array[p_brand] || array_remove(u.preferred_brands, p_brand))[1:20] end,
    budget_min = case when p_budget_min is null and p_budget_max is null then u.budget_min else p_budget_min end,
    budget_max = case when p_budget_min is null and p_budget_max is null then u.budget_max else p_budget_max end,
    category_interests = case when p_category is null then u.category_interests
      else (array[p_category] || array_remove(u.category_interests, p_category))[1:20] end,
    recent_searches = case when p_category is null then u.recent_searches
      else (array[p_category] || array_remove(u.recent_searches, p_category))[1:20] end,
    updated_at = now();
$$;

-- 권한: 있는 역할에만. Neon(neondb_owner 하나)에서는 아무것도 하지 않고, Supabase 에서는 원래 파일과 같다.
do $$
declare r text;
begin
  revoke all on public.ai_v3_profiles from public;
  revoke all on public.ai_v3_monitor_events from public;
  revoke all on function public.merge_ai_v3_user_profile(text,text,text,bigint,bigint) from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.ai_v3_profiles from %I', r);
      execute format('revoke all on public.ai_v3_monitor_events from %I', r);
      execute format('revoke all on function public.merge_ai_v3_user_profile(text,text,text,bigint,bigint) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.ai_v3_profiles to service_role;
    grant select, insert on public.ai_v3_monitor_events to service_role;
    grant execute on function public.merge_ai_v3_user_profile(text,text,text,bigint,bigint) to service_role;
  end if;
end $$;

commit;
