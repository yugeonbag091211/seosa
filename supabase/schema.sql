-- 아직 없는 테이블 3개. Supabase 대시보드 > SQL Editor에서 한 번 실행하세요.
-- products / price_history / search_stats / monthly_curation / price_drop_top 는 이미 존재합니다.

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
