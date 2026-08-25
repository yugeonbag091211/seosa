-- ══════════════════════════════════════════════════════════════════
--  2026-08-25  최소 사용자 계측
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 붙여넣고 Run.
--
--  안전성
--    - 새 테이블 2개와 함수 2개만 만든다. 기존 테이블을 건드리지 않는다.
--    - DROP / TRUNCATE / DELETE / UPDATE 가 한 문장도 없다.
--    - 전부 IF NOT EXISTS / OR REPLACE 라 재실행해도 안전하다.
--    - 이 마이그레이션 전에도 서비스는 그대로 돈다. api/_analytics.js 가
--      테이블이 없으면 한 번 경고하고 계측만 끈다 (기존 폴백과 같은 방식).
--
--  ══════════════════════════════════════════════════════════════════
--  왜 이걸 만드는가
--  ══════════════════════════════════════════════════════════════════
--
--  STATUS.md 「사업 검증에서 부족한 것」의 첫 줄이 "실제 사용자가 있는가 →
--  모른다" 다. 코드 품질이 아무리 좋아도 그 질문에 답할 수 없으면 제품이
--  살아 있는지 죽어 있는지 판단할 근거가 없다.
--
--  ── 왜 분석 도구를 붙이지 않는가 ────────────────────────────────
--
--  GA4 나 별도 분석 SaaS 를 붙이면 스크립트 로딩·동의 배너·개인정보 처리방침이
--  전부 따라온다. 지금 필요한 것은 여섯 개 숫자뿐이다. 그 여섯 개를 위해
--  외부 의존성을 늘리지 않는다.
--
--  ── 왜 원본 이벤트를 쌓지 않는가 ────────────────────────────────
--
--  이벤트 한 줄씩 적재하면 하루 수만 행이 되고, 조회할 때마다 집계 비용이 든다.
--  우리가 볼 것은 "하루에 몇 번" 이므로 처음부터 날짜별 카운터로 접는다.
--  하루에 metric 종류만큼만 행이 늘어난다 (현재 2종 = 하루 2행).
--
--  ── 개인정보를 담지 않는다 ──────────────────────────────────────
--
--  visitor_id 는 브라우저가 만든 난수다 (localStorage). 서버는 그 값이
--  누구인지 알지 못하고, 알 방법도 두지 않는다.
--    · IP 를 저장하지 않는다
--    · User-Agent 를 저장하지 않는다
--    · 이메일·계정과 연결하지 않는다  ★ 이것이 핵심이다
--  즉 이 테이블만으로는 어떤 개인도 특정할 수 없다. 사용자가 저장소를
--  비우면 새 방문자가 되고, 그건 정확도를 조금 잃는 대신 치르는 값이다.
--
--  AI 사용 횟수는 여기에 새로 쌓지 않는다 — ai_usage 에 이미 있다.
--  같은 사실을 두 곳에 적으면 언젠가 두 값이 어긋난다.
-- ══════════════════════════════════════════════════════════════════


-- ── 1. 방문자 ────────────────────────────────────────────────────
--
--  한 방문자당 한 행이다. 방문할 때마다 늘어나지 않는다.
--
--  visit_days 는 "방문한 날의 수" 이지 "방문 횟수" 가 아니다. 같은 날 열 번
--  들어와도 1이다. 재방문율을 볼 때 필요한 것은 "다른 날에 다시 왔는가" 이고,
--  같은 날 새로고침을 재방문으로 세면 숫자가 부풀어 판단을 망친다.
create table if not exists visitors (
  visitor_id  text primary key,
  first_date  date   not null,
  last_date   date   not null,
  visit_days  integer not null default 1,
  constraint visitors_visit_days_chk check (visit_days >= 1)
);

-- "오늘 방문자" 는 last_date 로 세므로 그 컬럼에 인덱스를 준다.
create index if not exists visitors_last_date_idx on visitors (last_date);


-- ── 2. 날짜별 카운터 ─────────────────────────────────────────────
--
--  metric 은 'search' | 'click' 두 종류로 시작한다. 종류를 CHECK 로 묶지
--  않는 이유는, 나중에 항목을 하나 더 세려 할 때 마이그레이션을 다시 돌려야
--  하기 때문이다. 무엇을 셀지는 애플리케이션이 정한다 (api/_analytics.js 의
--  METRICS 화이트리스트가 실제 관문이다 — 아무 문자열이나 쌓이지 않는다).
create table if not exists daily_metrics (
  metric_date date   not null,
  metric      text   not null,
  count       bigint not null default 0,
  primary key (metric_date, metric),
  constraint daily_metrics_count_chk check (count >= 0)
);


-- ── 3. 방문 기록 RPC ─────────────────────────────────────────────
--
--  ★ 왜 한 문장인가
--
--    select → if → update 로 나누면 같은 방문자가 탭 두 개를 동시에 열었을 때
--    양쪽 다 "오늘 처음" 으로 읽고 visit_days 를 두 번 늘린다. 재방문자 수가
--    조용히 부풀어 오른다. INSERT ... ON CONFLICT DO UPDATE 는 한 문장이라
--    행 잠금이 걸리고 두 번째 요청은 갱신된 값을 본다.
--    (api/_plan.js ai_quota_reserve · api/_auth.js auth_code_attempt 와 같은 원칙)
--
--    visit_days 를 늘리는 조건이 CASE 안에 있는 것이 요점이다. 같은 날 두 번째
--    방문이면 visitors.last_date = p_date 라 0 이 더해진다.
--
--  날짜는 서버가 KST 로 계산해 넘긴다 (api/_kst.kstToday). 여기서 now() 를
--  쓰면 DB 시간대에 의존하게 되고, 코드의 다른 날짜 판정과 어긋난다.
create or replace function track_visit(p_vid text, p_date date)
returns void
language sql
as $$
  insert into visitors (visitor_id, first_date, last_date, visit_days)
  values (p_vid, p_date, p_date, 1)
  on conflict (visitor_id) do update
     set last_date  = greatest(visitors.last_date, p_date),
         visit_days = visitors.visit_days
                    + case when visitors.last_date < p_date then 1 else 0 end;
$$;


-- ── 4. 카운터 증가 RPC ───────────────────────────────────────────
--
--  increment_search_stat (supabase/schema.sql) 과 같은 모양이다.
--  같은 이유로 한 문장이어야 한다 — 동시에 들어온 요청에서 카운트가 유실된다.
create or replace function bump_metric(p_metric text, p_date date)
returns void
language sql
as $$
  insert into daily_metrics (metric_date, metric, count)
  values (p_date, p_metric, 1)
  on conflict (metric_date, metric)
  do update set count = daily_metrics.count + 1;
$$;


-- ── 5. RLS ───────────────────────────────────────────────────────
--
--  두 테이블 모두 서버(service_role)만 쓴다. service_role 은 RLS 를 우회하므로
--  정책을 따로 만들지 않는다 — 정책이 없다 = 다른 역할은 아무것도 못 한다.
--  (payments 와 같은 방식)
alter table visitors      enable row level security;
alter table daily_metrics enable row level security;


-- ── PostgREST 스키마 캐시 갱신 ──────────────────────────────────
notify pgrst, 'reload schema';


-- ══════════════════════════════════════════════════════════════════
--  적용 확인 — 결과 그리드에 바로 뜬다
--
--  SQL Editor 는 스크립트를 한 트랜잭션으로 돌린다. 중간에 실패하면 전부
--  롤백되는데 화면만 봐서는 알아채기 어렵다. 마지막에 직접 세어 보여 준다.
--
--  기대값
--    tables_expect_2    2
--    rpcs_expect_2      2
-- ══════════════════════════════════════════════════════════════════
select
  current_database() as db,
  (select count(*) from information_schema.tables
    where table_schema = 'public'
      and table_name in ('visitors', 'daily_metrics'))        as tables_expect_2,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('track_visit', 'bump_metric'))        as rpcs_expect_2;
