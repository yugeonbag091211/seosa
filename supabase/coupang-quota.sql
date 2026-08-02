-- ══════════════════════════════════════════════════════════════════
--  쿠팡 파트너스 API 호출 통제 (api/_coupang.js 가 사용)
--
--  Supabase 대시보드 > SQL Editor 에서 이 파일만 통째로 한 번 실행하세요.
--  schema.sql 은 다시 실행하지 마세요 — 그쪽에는 monthly_curation 7월
--  키워드를 하드코딩 값으로 덮어쓰는 update 가 들어 있습니다.
--
--  쿠팡 공식 한도: 검색 API 1분당 50회 / 모든 API 1분당 100회.
--  경고 3회면 이용 제한. 서버리스 인스턴스가 몇 개든, GitHub Actions 가
--  동시에 돌든 합계가 상한을 넘지 않도록 카운터를 DB 에 둔다.
--  (인메모리 카운터는 인스턴스마다 따로 놀아서 전역 한도를 못 지킨다)
--
--  안전성
--    - 전부 create if not exists / create or replace / on conflict do nothing
--    - 기존 테이블(products, price_history, search_stats, monthly_curation,
--      price_drop_top, alerts, profiles, user_data)을 읽지도 쓰지도 않는다
--    - 최상위에 drop / truncate / delete 가 없다
--    - 이름이 전부 coupang_ 접두사라 기존 객체와 겹치지 않는다
--    → 몇 번을 실행해도 안전하다
--
--  ※ 이 파일을 실행하지 않아도 사이트는 동작한다. 다만 전역 카운터 없이
--    인스턴스별 한도로만 막게 되므로 반드시 실행할 것.
-- ══════════════════════════════════════════════════════════════════


-- ── 1. 테이블 ────────────────────────────────────────────────────

-- 호출 기록 = 레이트리밋 카운터 + 감사 로그
create table if not exists coupang_api_calls (
  id          bigserial   primary key,
  called_at   timestamptz not null default now(),
  source      text        not null default '',   -- search / cron / collect / diag
  keyword     text        not null default '',
  outcome     text        not null default 'pending',
  http_status int         not null default 0,
  r_code      text        not null default '',
  items       int         not null default 0
);
create index if not exists coupang_api_calls_called_at_idx
  on coupang_api_calls (called_at desc);

-- 차단 상태. 429/403/rCode 차단을 받으면 여기에 재개 시각을 적어두고
-- 모든 인스턴스가 그때까지 쿠팡을 호출하지 않는다.
create table if not exists coupang_api_state (
  id            int primary key default 1,
  blocked_until timestamptz,
  reason        text default '',
  updated_at    timestamptz not null default now()
);
insert into coupang_api_state (id) values (1) on conflict (id) do nothing;

-- 키워드별 검색 결과 캐시. 같은 검색어가 반복돼도 API 는 한 번만 나간다.
create table if not exists coupang_search_cache (
  keyword    text        primary key,
  items      jsonb       not null default '[]'::jsonb,
  req_limit  int         not null default 0,
  fetched_at timestamptz not null default now()
);


-- ── 2. 함수 ──────────────────────────────────────────────────────

-- 호출 허가. 차단 중이거나 최근 1분 호출이 상한이면 false 를 주고,
-- 허가할 때만 로그 행을 만들어 id 를 돌려준다 (허가 = 카운트).
--
-- advisory lock 으로 직렬화한다. 없으면 동시 호출이 같은 카운트를 읽고
-- 둘 다 통과해서 상한을 조금씩 넘긴다. 한도 초과로 제재를 받은 상황이라
-- "대충 20회쯤"이 아니라 정확히 20회여야 한다.
-- 분당 20회 수준에서는 락 경합이 사실상 없다.
create or replace function coupang_acquire(max_per_min int, src text, kw text)
returns table (allowed boolean, call_id bigint, reason text, used int)
language plpgsql
as $$
declare
  v_blocked timestamptz;
  v_reason  text;
  v_used    int;
  v_id      bigint;
begin
  -- 이 함수 전용 락 번호. 다른 advisory lock 과 겹치지만 않으면 값 자체는 무의미하다.
  -- (hashtext() 는 문서화되지 않은 내부 함수라 쓰지 않는다)
  perform pg_advisory_xact_lock(8912042601);

  select s.blocked_until, s.reason into v_blocked, v_reason
    from coupang_api_state s where s.id = 1;

  if v_blocked is not null and v_blocked > now() then
    return query select false, null::bigint,
      '호출 중단 중 (재개 ' || to_char(v_blocked, 'YYYY-MM-DD HH24:MI:SSOF') || ') '
        || coalesce(v_reason, ''),
      0;
    return;
  end if;

  select count(*)::int into v_used
    from coupang_api_calls
   where called_at > now() - interval '1 minute';

  if v_used >= max_per_min then
    return query select false, null::bigint,
      '분당 한도 ' || v_used || '/' || max_per_min, v_used;
    return;
  end if;

  insert into coupang_api_calls (source, keyword, outcome)
  values (left(coalesce(src, ''), 40), left(coalesce(kw, ''), 80), 'pending')
  returning id into v_id;

  return query select true, v_id, ''::text, v_used + 1;
end;
$$;

-- 호출 결과 기록
create or replace function coupang_finish(call_id bigint, res text, http int, rcode text, n_items int)
returns void
language sql
as $$
  update coupang_api_calls
     set outcome     = left(coalesce(res, ''), 40),
         http_status = coalesce(http, 0),
         r_code      = left(coalesce(rcode, ''), 20),
         items       = coalesce(n_items, 0)
   where id = call_id;
$$;

-- 차단 걸기. 이미 더 긴 차단이 걸려 있으면 줄이지 않는다.
create or replace function coupang_block(minutes int, why text)
returns void
language sql
as $$
  update coupang_api_state
     set blocked_until = greatest(coalesce(blocked_until, now()),
                                  now() + make_interval(mins => greatest(minutes, 1))),
         reason        = left(coalesce(why, ''), 300),
         updated_at    = now()
   where id = 1;
$$;

-- 차단 수동 해제 (쿠팡에 소명 완료 후):  select coupang_unblock();
create or replace function coupang_unblock()
returns void
language sql
as $$
  update coupang_api_state
     set blocked_until = null, reason = '', updated_at = now()
   where id = 1;
$$;

-- 호출량 조회 — /api/coupang-diag 가 이걸 읽는다.
create or replace function coupang_usage()
returns table (last_min int, last_hour int, last_day int,
               blocked_until timestamptz, reason text)
language sql
as $$
  select
    (select count(*)::int from coupang_api_calls where called_at > now() - interval '1 minute'),
    (select count(*)::int from coupang_api_calls where called_at > now() - interval '1 hour'),
    (select count(*)::int from coupang_api_calls where called_at > now() - interval '1 day'),
    s.blocked_until,
    s.reason
  from coupang_api_state s
  where s.id = 1;
$$;

-- 오래된 로그 정리 (/api/cron 이 하루 한 번 호출)
create or replace function coupang_prune(keep_days int default 7)
returns int
language plpgsql
as $$
declare n int;
begin
  delete from coupang_api_calls
   where called_at < now() - make_interval(days => greatest(keep_days, 1));
  get diagnostics n = row_count;
  return n;
end;
$$;


-- ── 3. 접근 권한 ─────────────────────────────────────────────────
--
-- 이 세 테이블은 서버(SUPABASE_SECRET_KEY = service_role)만 만진다.
-- RLS 를 켜고 정책을 하나도 만들지 않으면 service_role 은 그대로 통과하고
-- anon / authenticated 는 전부 막힌다.
--
-- 안 막으면 anon key 하나로:
--   coupang_search_cache — 가짜 상품·악성 link 를 주입해 검색 결과를 오염
--   coupang_api_calls    — 20행만 넣으면 쿠팡 연동을 영구 차단시킴
--   coupang_api_state    — blocked_until 을 먼 미래로 설정
-- 이 가능하다.

alter table coupang_api_calls    enable row level security;
alter table coupang_api_state    enable row level security;
alter table coupang_search_cache enable row level security;

-- 함수도 기본적으로 PUBLIC 에 EXECUTE 가 붙는다. 회수하고 service_role 에만 준다.
-- service_role 이 없는 환경(로컬 Postgres 등)에서도 실행되도록 존재 확인 후 grant.
do $$
declare fn text;
begin
  foreach fn in array array[
    'coupang_acquire(int,text,text)',
    'coupang_finish(bigint,text,int,text,int)',
    'coupang_block(int,text)',
    'coupang_unblock()',
    'coupang_usage()',
    'coupang_prune(int)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;
end $$;


-- ── 4. PostgREST 스키마 캐시 갱신 ────────────────────────────────
-- 이걸 빠뜨리면 방금 만든 함수를 한동안 못 찾아서, api/_coupang.js 가
-- 전역 카운터를 끈 채(인스턴스별 한도만으로) 동작한다.
notify pgrst, 'reload schema';


-- ── 5. 확인 (읽기 전용) ──────────────────────────────────────────
-- 아래 두 줄을 실행해서 9개 객체가 모두 보이면 정상이다.
--
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name like 'coupang%' order by 1;
--
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname like 'coupang%' order by 1;
--
-- 기대: 테이블 3개 (coupang_api_calls, coupang_api_state, coupang_search_cache)
--       함수 6개 (acquire, block, finish, prune, unblock, usage)
