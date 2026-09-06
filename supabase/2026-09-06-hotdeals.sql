-- ============================================================================
--  2026-09-06  SEOSA HOT v1 — 검증된 핫딜
--
--  ── 설계 원칙 ──────────────────────────────────────────────────────────
--
--  1) price_history 를 복사하지 않는다.
--     핫딜 판정의 source of truth 는 언제나 price_history 다. 이 표는 "그
--     판정의 결과"만 들고 있는다. 30일 중앙값 같은 값은 화면이 매번 재계산하지
--     않도록 스냅숏으로 두되, 어긋나면 price_history 가 옳다.
--
--  2) 같은 딜을 다시 발견해도 INSERT 하지 않는다.
--     (source, source_external_id, mall) 이 유일키다. 수집기는 upsert 한다.
--     이게 없으면 하루 몇 번 도는 수집기가 같은 딜을 매번 새 행으로 쌓아
--     목록이 중복으로 뒤덮인다.
--
--  3) REJECTED 는 저장하되 노출하지 않는다.
--     왜 걸렀는지 되짚을 수 있어야 threshold 를 고칠 수 있다. 노출 필터는
--     API 쪽(api/hotdeals.js)이 건다.
--
--  4) 이 파일은 되돌릴 수 있다. 맨 아래 롤백 주석 참고.
-- ============================================================================

create table if not exists hotdeals (
  id                     bigserial   primary key,

  -- 어디서 발견했나
  source                 text        not null,          -- internal-history | adpick-hotdeal | ...
  source_external_id     text        not null,          -- source 안에서의 상품 식별자
  mall                   text        not null default '',

  -- 우리 카탈로그의 어느 상품인가 (없을 수 있다 — 외부 source 신규 상품)
  product_id             text        not null default '',
  vendor_item_id         text        not null default '',

  -- 표시용 (판매자 문자열이므로 노출 시 반드시 escape)
  title                  text        not null default '',
  image                  text        not null default '',
  affiliate_url          text        not null default '',

  -- 가격. source_reference_price 는 쇼핑몰이 말하는 "정가"이며 판정에 쓰지 않는다.
  current_price          integer     not null,
  source_reference_price integer     not null default 0,

  -- 판정 결과 (api/_hotdeal.js)
  deal_status            text        not null,          -- VERIFIED_HOT | GOOD_DEAL | POTENTIAL_DEAL | NORMAL | REJECTED
  hot_score              integer     not null default 0,
  confidence             text        not null default 'INSUFFICIENT',
  identity_confidence    text        not null default 'WEAK',

  -- 근거 스냅숏. 원본은 price_history 다.
  observation_count      integer     not null default 0,
  observation_span_days  integer     not null default 0,
  median_30d             integer     not null default 0,
  observed_low           integer     not null default 0,
  reason_json            jsonb       not null default '[]'::jsonb,
  gate_json              jsonb       not null default '[]'::jsonb,

  -- 생애주기
  lifecycle              text        not null default 'NEW',   -- NEW | ACTIVE | COOLING | EXPIRED
  detected_at            timestamptz not null default now(),
  last_checked_at        timestamptz not null default now(),
  expires_at             timestamptz,

  -- 같은 payload 로 다시 왔는지 (불필요한 update 를 줄인다)
  source_payload_hash    text        not null default ''
);

-- 재발견 시 upsert 되도록. 이 키가 이 표의 핵심이다.
create unique index if not exists hotdeals_source_key
  on hotdeals (source, source_external_id, mall);

-- 목록 조회: 노출 상태 + 점수순
create index if not exists hotdeals_list_idx
  on hotdeals (deal_status, hot_score desc, last_checked_at desc);

-- 생애주기 스윕
create index if not exists hotdeals_lifecycle_idx
  on hotdeals (lifecycle, last_checked_at);

-- 상품 단위 조회 (같은 상품이 여러 몰에서 발견됐을 때 묶기 — PHASE 12)
create index if not exists hotdeals_product_idx
  on hotdeals (product_id) where product_id <> '';

comment on table hotdeals is
  'SEOSA HOT v1 — 검증된 핫딜 판정 결과. 가격 근거의 원본은 price_history 다.';
comment on column hotdeals.source_reference_price is
  '쇼핑몰이 표시하는 정가. 참고 표시 전용이며 hot_score 계산에 쓰지 않는다.';
comment on column hotdeals.deal_status is
  'REJECTED 는 되짚기 위해 저장만 하고 사용자에게 노출하지 않는다.';

-- ============================================================================
--  핫딜 수집기 잠금 — hotdeal_job_state
--
--  ── 왜 price_job_state 를 쓰지 않는가 ──────────────────────────────────
--
--  price_job_state 는 `id int primary key default 1` 인 singleton 이고
--  job_date 는 `date` 타입이다. 핫딜 수집기가 job_date 에
--  'hotdeal-2026-09-06' 같은 문자열을 넣으려 했는데 그건 date 로 캐스팅되지
--  않아 insert 자체가 실패한다. 게다가 그 표는 가격 수집 한 바퀴의 커서·재시도
--  목록을 들고 있어서, 남의 작업 상태를 같은 행에 끼워 넣으면 안 된다.
--
--  그래서 아주 작은 전용 singleton 을 따로 둔다. 구조는 기존 CAS 잠금
--  (scripts/collect-all-prices.js acquireLock)과 같은 생각이되, 토큰과 만료를
--  별도 컬럼으로 꺼내 소유권 검사를 명시적으로 만든다.
-- ============================================================================

create table if not exists hotdeal_job_state (
  id           int         primary key default 1,
  status       text        not null default 'idle',      -- idle | running | done | failed
  lock_token   text        not null default '',          -- 지금 잠금을 쥔 실행의 토큰
  lock_until   timestamptz,                              -- 이 시각이 지나면 회수 가능
  last_run_at  timestamptz,
  last_result  jsonb       not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  constraint hotdeal_job_state_singleton check (id = 1)
);

insert into hotdeal_job_state (id, status) values (1, 'idle')
on conflict (id) do nothing;

comment on table hotdeal_job_state is
  '핫딜 수집기 전용 singleton 잠금. price_job_state(가격 수집)와 섞지 않는다.';
comment on column hotdeal_job_state.lock_token is
  '잠금 소유자. release 는 자기 토큰일 때만 성공해야 한다(남의 잠금 해제 금지).';

-- ============================================================================
--  RLS — server-only 표
--
--  SEOSA 의 모든 표는 RLS 를 켜고 정책을 만들지 않는다. 정책이 없으면
--  anon / authenticated 는 어떤 행도 읽거나 쓸 수 없고, 서버가 쓰는
--  service_role 만 RLS 를 우회한다. 이 두 표는 전부 서버가 만들고 서버가
--  읽는 값이라 클라이언트가 직접 만질 이유가 없다.
--  (기존 관례: price_job_state · adpick_search_cache · payments · alerts …)
--
--  ★ 적용 전/후 접근 계약 — 리뷰어가 직접 확인할 것
--
--    적용 전 : 표가 없다. /api/hotdeals 는 pending:true 로 빈 목록을 준다
--              (api/hotdeals.js 의 relation-does-not-exist 처리).
--
--    적용 후 : anon key 로 아래를 실행하면 «행 0개» 여야 한다. 오류가 아니라
--              0행이 정상이다 — RLS 가 정책 없는 표를 그렇게 다룬다.
--
--                select * from hotdeals limit 1;            -- anon → 0행
--                insert into hotdeals (source, source_external_id, mall,
--                  current_price, deal_status) values ('x','y','z',1,'NORMAL');
--                                                           -- anon → 거부
--                select * from hotdeal_job_state;           -- anon → 0행
--
--              service_role 로는 위 셋 다 정상 동작해야 한다.
--    (scripts/test-hotdeal.js 가 이 마이그레이션에 RLS 구문이 있는지 자체를
--     고정한다 — SQL 을 실행하지 않고 파일로 검증한다)
-- ============================================================================

alter table hotdeals          enable row level security;
alter table hotdeal_job_state enable row level security;

-- PostgREST 가 새 표를 바로 알아보게 한다 (기존 마이그레이션과 같은 마무리).
notify pgrst, 'reload schema';

-- ── 확인 ────────────────────────────────────────────────────────────────
-- select count(*) as rows, count(distinct source) as sources from hotdeals;
-- select relname, relrowsecurity from pg_class
--   where relname in ('hotdeals','hotdeal_job_state');   -- 둘 다 true 여야 한다

-- ── 롤백 ────────────────────────────────────────────────────────────────
-- drop table if exists hotdeals;
-- drop table if exists hotdeal_job_state;
