-- 아직 없는 테이블 3개. Supabase 대시보드 > SQL Editor에서 한 번 실행하세요.
-- products / price_history / search_stats / monthly_curation / price_drop_top 는 이미 존재합니다.
--
-- ※ 이 파일은 전부 create if not exists / update 라서 몇 번을 실행해도 안전합니다.
--   기존 데이터를 지우지 않습니다.
--
-- ※ 경고: drop table 이나 truncate 가 들어 있는 옛날 초기 설치 스크립트를 다시 실행하지 마세요.
--   2026-07-27 에 products / price_history / search_stats 가 통째로 비워지고
--   id 시퀀스가 1로 되돌아간 적이 있습니다 (수집분 + 이관분 7000여 행 유실).
--   초기화됐다면 node scripts/restore.js "<가격히스토리 CSV>" 로 복구하세요.

-- /api/alerts — 가격 알림 신청
-- ※ scripts/check-alerts.js 도 반드시 이 테이블(alerts)을 봐야 한다.
--   예전에 price_alerts 라는 존재하지 않는 이름을 보고 있어서 알림이 한 번도 발송되지 않았다.
create table if not exists alerts (
  id            bigserial primary key,
  email         text        not null,
  title         text        not null,
  target_price  integer     not null default 0,
  current_price integer     not null default 0,
  link          text        default '',
  image         text        default '',
  mall          text        default '',
  sent          boolean     not null default false,
  created_at    timestamptz not null default now(),
  unique (email, title)
);
create index if not exists alerts_email_idx on alerts (email);

-- 발송 시각. 이 컬럼이 없으면 check-alerts.js 의 sent 갱신이 실패해서
-- 같은 알림 메일이 매일 다시 발송된다.
alter table alerts add column if not exists sent_at timestamptz;

-- 정가 / 할인율. 없으면 DB에서 읽어오는 섹션(오늘의 셀렉션, 이달의 추천, 당신을 위한 추천)에서만
-- 할인 배지가 사라져 검색 결과와 표시가 달라진다.
alter table products add column if not exists oprice   integer not null default 0;
alter table products add column if not exists save_pct integer not null default 0;

-- /api/profile — 사용자 취향 프로필
create table if not exists profiles (
  email      text        primary key,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- /api/sync — 위시리스트 / 조회기록 / 검색기록 백업
create table if not exists user_data (
  email      text        primary key,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- /api/stats — 검색 횟수 집계
-- 기존 방식(select 후 update)은 동시에 같은 키워드를 검색하면 카운트가 유실된다.
-- 아래 함수는 단일 statement라 동시 호출에도 정확하다.
-- 중복 keyword 행이 이미 있으면 unique index 생성이 실패한다.
-- 먼저 카운트를 가장 오래된 행에 합산한 뒤 나머지를 지운다 (기록 유실 없음).
update search_stats s
   set count = agg.total
  from (select keyword, sum(count) as total, min(id) as keep
          from search_stats group by keyword) agg
 where s.keyword = agg.keyword and s.id = agg.keep;

delete from search_stats a
 using search_stats b
 where a.keyword = b.keyword
   and a.id > b.id;

create unique index if not exists search_stats_keyword_key on search_stats (keyword);

create or replace function increment_search_stat(kw text)
returns void
language sql
as $$
  insert into search_stats (keyword, count)
  values (kw, 1)
  on conflict (keyword)
  do update set count = search_stats.count + 1;
$$;

-- 이달의 큐레이션 키워드. 비어 있으면 프론트가 "이달의 키워드 상품을 준비 중이에요"를 띄운다.
-- 나머지 달은 아직 정하지 않아 비워 둔 상태다.
update monthly_curation
   set keywords = '["노트북","무선 이어폰","스마트워치","텀블러","향수","가방","키보드","스피커"]'::jsonb
 where month = 7;


-- ── 쿠팡 API 호출 통제 ────────────────────────────────────────────
--  쿠팡 분당 호출 상한 / 캐시 / 차단 상태 테이블과 함수는
--  supabase/coupang-quota.sql 로 분리했다. 그 파일을 따로 실행할 것.
--
--  같이 두지 않은 이유: 이 파일은 다시 실행하면 안 된다.
--  바로 위 update 가 monthly_curation 7월 keywords 를 하드코딩 값으로
--  덮어쓰기 때문에, 쿠팡 블록이 여기 있으면 그걸 적용하려고 전체를
--  다시 돌려야 하고 그 과정에서 7월 큐레이션이 되돌아간다.
-- ──────────────────────────────────────────────────────────────────
