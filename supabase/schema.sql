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

-- 이달의 큐레이션 키워드. 비어 있으면 프론트가 "이달의 키워드 상품을 준비 중이에요"를 띄운다.
-- 나머지 달은 아직 정하지 않아 비워 둔 상태다.
update monthly_curation
   set keywords = '["노트북","무선 이어폰","스마트워치","텀블러","향수","가방","키보드","스피커"]'::jsonb
 where month = 7;
