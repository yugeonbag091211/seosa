-- ══════════════════════════════════════════════════════════════════
--  2026-08 출시 전 마이그레이션
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 이 파일을 통째로
--    붙여넣고 Run. (DDL 은 PostgREST API 로 실행할 수 없어서 스크립트가
--    대신 적용해 줄 수 없다. 반드시 SQL Editor 에서 한 번 돌려야 한다.)
--
--  적용 후 확인
--    node scripts/verify-schema.js
--
--  ※ supabase/schema.sql 은 실행하지 마세요.
--    - monthly_curation 7월 keywords 를 하드코딩 값으로 덮어쓰고
--    - keywords 를 jsonb 로 캐스팅하는데 실제 컬럼 타입은 text[] 라 실패합니다.
--    이 파일이 schema.sql 이 하려던 일 중 안전한 것만 담고 있습니다.
--
--  안전성
--    - 전부 add column if not exists / create index if not exists /
--      create or replace. 최상위에 drop / truncate / delete 가 없다.
--    - 2026-08-08 기준 중복 키 0건을 확인하고 unique index 를 넣었다.
--    → 몇 번을 실행해도 안전하다
-- ══════════════════════════════════════════════════════════════════


-- ── 1. alerts: 상품 단위 매칭 + 발송 시각 ────────────────────────
--
-- 프론트는 예전부터 알림 신청 시 productId 를 함께 보내고 있었는데 받는 쪽에
-- 컬럼이 없어서 버려지고 있었다. 그래서 scripts/check-alerts.js 가 상품명만으로
-- 오늘 가격을 찾는다. 상품명은 고유하지 않아서(쿠팡에 같은 이름의 다른 상품이
-- 흔하다) 엉뚱한 상품 가격으로 "목표가 달성" 메일이 나갈 수 있다.
alter table alerts add column if not exists product_id text not null default '';

-- 발송 시각. 이 컬럼이 없으면 check-alerts.js 의 sent 갱신이 실패해서
-- 같은 알림 메일이 매일 다시 발송된다.
alter table alerts add column if not exists sent_at timestamptz;

-- api/alerts.js 의 upsert(onConflict: 'email,title') 가 이 제약을 필요로 한다.
-- 없으면 같은 상품에 알림을 다시 신청할 때 행이 계속 쌓인다.
create unique index if not exists alerts_email_title_key on alerts (email, title);

-- 미발송 알림만 매일 훑는다.
create index if not exists alerts_sent_idx on alerts (sent) where sent = false;


-- ── 2. user_data: 업서트 키 ──────────────────────────────────────
--
-- api/sync.js 가 upsert(onConflict: 'email') 를 쓴다.
-- (컬럼 자체는 wish / viewed / searches 가 이미 있고, 코드를 그 스키마에
--  맞춰 고쳤다. 여기서는 업서트 키만 보장한다)
create unique index if not exists user_data_email_key on user_data (email);


-- ── 3. search_stats: 동시 검색 카운트 유실 방지 ──────────────────
--
-- 지금은 select 후 update 라서 같은 키워드가 동시에 검색되면 카운트가 유실된다.
-- 아래 함수는 단일 statement 라 동시 호출에도 정확하다.
-- (2026-08-08 기준 중복 keyword 0건 확인)
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


-- ── 3-b. 이메일 인증 코드 (api/_auth.js) ─────────────────────────
--
-- /api/sync, /api/profile, /api/alerts 는 ?email= 하나만 보고 데이터를 내주고
-- 있었다. CORS 는 브라우저만 막으므로 curl 한 줄이면 남의 찜 목록·취향·알림을
-- 읽고 덮어쓸 수 있었다. 이메일로 6자리 코드를 보내 소유를 확인하고,
-- 확인되면 서명 토큰을 발급하는 방식으로 막는다.
--
-- 코드는 평문으로 저장하지 않는다 (이 테이블이 새어도 로그인 수단이 되지 않도록).
-- 이메일당 한 행만 두고, 새 코드를 요청하면 덮어쓴다.
create table if not exists auth_codes (
  email      text        primary key,
  code_hash  text        not null,
  expires_at timestamptz not null,
  attempts   int         not null default 0,
  created_at timestamptz not null default now()
);

-- 만료된 코드 정리용
create index if not exists auth_codes_expires_at_idx on auth_codes (expires_at);

-- 서버(service_role)만 만진다.
alter table auth_codes enable row level security;


-- ── 4. 인덱스 ────────────────────────────────────────────────────
--
-- price_history 는 1.1만 행이고 하루 수백 행씩 쌓인다. 지금은 순차 스캔으로도
-- 버티지만 몇 달 뒤에는 차트·알림이 전부 느려진다.

-- /api/history, /api/history-batch 의 상품 단위 조회
create index if not exists price_history_pid_mall_date_idx
  on price_history (product_id, mall, recorded_date desc);

-- 상품명 폴백 조회 (/api/history, check-alerts.js 의 역대최저·30일 통계)
create index if not exists price_history_title_idx
  on price_history (title);

-- check-alerts.js / verify-coverage.js 의 "오늘/어제" 조회
create index if not exists price_history_recorded_date_idx
  on price_history (recorded_date desc);

-- /api/init, /api/rec 의 키워드 조회
create index if not exists products_keyword_idx
  on products (keyword);

-- 홈 섹션이 최신 수집분을 먼저 고른다
create index if not exists products_collected_at_idx
  on products (collected_at desc);


-- ── 5. 개인 데이터 테이블 RLS ────────────────────────────────────
--
-- 서버는 SUPABASE_SECRET_KEY(sb_secret_* = service_role 상당)로 접근하므로
-- RLS 를 켜도 그대로 통과한다. 정책을 하나도 만들지 않으면 anon /
-- authenticated 만 전부 막힌다.
--
-- 지금 프론트엔드는 Supabase 키를 들고 있지 않아 켜도 깨지지 않는다.
-- 나중에 anon 키가 노출되더라도 남의 이메일·찜 목록·알림이 통째로
-- 읽히는 일은 막아준다.
alter table alerts    enable row level security;
alter table profiles  enable row level security;
alter table user_data enable row level security;


-- ── 6. PostgREST 스키마 캐시 갱신 ────────────────────────────────
-- 이걸 빠뜨리면 방금 추가한 alerts.product_id 와 increment_search_stat 을
-- 한동안 못 찾아서 코드가 계속 폴백 경로로 동작한다.
notify pgrst, 'reload schema';


-- ── 7. 확인 ──────────────────────────────────────────────────────
--   node scripts/verify-schema.js   ← 이걸 실행하면 전부 자동으로 확인됩니다.
