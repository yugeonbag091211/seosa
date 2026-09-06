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

-- ── 확인 ────────────────────────────────────────────────────────────────
-- select count(*) as rows, count(distinct source) as sources from hotdeals;

-- ── 롤백 ────────────────────────────────────────────────────────────────
-- drop table if exists hotdeals;
