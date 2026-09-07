-- ============================================================================
--  2026-09-08  전환(conversion) 상태 · 파트너 원본 보존
--
--  ── 왜 필요한가 ────────────────────────────────────────────────────────
--
--  2026-09-07-funnel.sql 의 conversions 는 «확정 전환» 만 들어온다는 전제로
--  만들어져서 상태 컬럼이 없다. 그런데 실제 파트너 전환 API 는 한 주문의
--  상태가 시간에 따라 바뀐다.
--
--      ADPICK  정상 → 확인중 → 확정        (또는 → 취소)
--
--  상태 없이 행을 넣으면 «아직 확정되지 않은 주문» 과 «취소된 주문» 이
--  확정 매출과 한 덩어리로 합산된다. 그건 GMV 가 아니라 희망이다.
--  api/_funnel.report() 가 지금 conversions 를 통째로 sum 하고 있어서,
--  상태 컬럼 없이 importer 를 붙이는 순간 그 합계가 곧바로 틀려진다.
--
--  ── 안전성 ─────────────────────────────────────────────────────────────
--
--  전부 add column if not exists / create index if not exists 다.
--  DROP · TRUNCATE · DELETE · UPDATE 가 한 문장도 없다.
--  기존 컬럼(source · external_id · order_date · product_id · mall · gmv ·
--  commission · quantity)은 이름도 타입도 건드리지 않는다 — 기존 unique
--  index conversions_source_key (source, external_id) 도 그대로 둔다.
--
--  ★ 파트너에서 «얻을 수 없는» 값은 NOT NULL 로 만들지 않는다.
--    confirmed_at 은 확정 전에는 존재하지 않고, cancelled_at 은 취소가
--    없으면 영원히 없다. 그걸 NOT NULL DEFAULT now() 로 채우면 "언제
--    확정됐나" 라는 질문에 거짓으로 답하게 된다.
-- ============================================================================

-- ── 1. 내부 표준 상태 ───────────────────────────────────────────────────
--
--  ORDERED    주문이 잡혔다 (아직 확정 아님)
--  PENDING    파트너가 검수 중
--  CONFIRMED  확정 — 이것만 매출로 센다
--  CANCELLED  취소
--  UNKNOWN    파트너가 우리가 모르는 값을 줬다 (버리지 않고 남긴다)
--
--  ★ CHECK 제약을 걸지 않는다. 파트너가 새 상태를 추가하면 적재 자체가
--    실패해서 그날 전환이 통째로 유실된다. 매핑은 애플리케이션이 하고
--    (api/_conversion.js CANON), 모르는 값은 UNKNOWN 으로 들어온다.
alter table conversions add column if not exists status text not null default 'UNKNOWN';

-- 파트너가 준 원문 상태. 매핑이 틀렸을 때 되짚을 수 있는 유일한 근거다.
alter table conversions add column if not exists partner_status text not null default '';

-- ── 2. 파트너 식별자 ────────────────────────────────────────────────────
--
--  기존 external_id 는 «중복 방지 키» 로 계속 쓴다. 아래는 그와 별개로
--  파트너가 준 식별자를 «있는 그대로» 남기는 자리다. 하나로 합치지 않는
--  이유는, 어느 필드가 안정적인 키인지 확인되기 전에 합성 키를 만들면
--  나중에 되돌릴 수 없기 때문이다.
alter table conversions add column if not exists partner text not null default '';
alter table conversions add column if not exists partner_order_id text not null default '';
alter table conversions add column if not exists partner_conversion_id text not null default '';
alter table conversions add column if not exists partner_product_id text not null default '';

-- ── 3. 시각 ─────────────────────────────────────────────────────────────
--
--  ★ 전부 nullable 이다. 확정되지 않았으면 confirmed_at 은 없는 것이 사실이다.
alter table conversions add column if not exists ordered_at   timestamptz;
alter table conversions add column if not exists confirmed_at timestamptz;
alter table conversions add column if not exists cancelled_at timestamptz;
alter table conversions add column if not exists imported_at  timestamptz not null default now();
alter table conversions add column if not exists updated_at   timestamptz not null default now();

-- ── 4. attribution ──────────────────────────────────────────────────────
--
--  ADPICK p_data / 쿠팡 subId 로 되돌아오는 값. 우리가 링크에 심은 토큰이다.
--
--  ★ 개인정보를 넣지 않는다. 이메일·계정·상품명·원본 visitor_id 를 넣지
--    않고, 불투명 난수 또는 비개인 캠페인 코드만 넣는다
--    (api/_conversion.js ATTRIBUTION 주석에 길이·수명·용도를 적어 두었다).
alter table conversions add column if not exists sub_id text not null default '';

-- 파트너 원본 응답 일부. 매핑 오류를 사후에 되짚기 위한 것이다.
alter table conversions add column if not exists raw_json jsonb not null default '{}'::jsonb;

-- ── 5. 인덱스 ───────────────────────────────────────────────────────────
--
--  ★ 기존 conversions_source_key (source, external_id) 는 그대로 둔다.
--    importer 의 upsert 가 그 키를 쓴다.
create index if not exists conversions_status_idx  on conversions (status, order_date);
create index if not exists conversions_partner_idx on conversions (partner, partner_order_id)
  where partner <> '';

comment on column conversions.status is
  '내부 표준 상태 ORDERED|PENDING|CONFIRMED|CANCELLED|UNKNOWN. CONFIRMED 만 매출로 센다.';
comment on column conversions.partner_status is
  '파트너가 준 원문 상태. 매핑을 사후 검증하는 유일한 근거라 반드시 보존한다.';
comment on column conversions.sub_id is
  'attribution 토큰. 개인정보를 담지 않는다 — 불투명 난수 또는 캠페인 코드만.';

notify pgrst, 'reload schema';

-- ── 확인 ────────────────────────────────────────────────────────────────
-- select status, count(*), sum(gmv) from conversions group by 1 order by 2 desc;
-- select partner, status, count(*) from conversions group by 1,2;

-- ── 롤백 ────────────────────────────────────────────────────────────────
-- drop index if exists conversions_status_idx;
-- drop index if exists conversions_partner_idx;
-- alter table conversions
--   drop column if exists status, drop column if exists partner_status,
--   drop column if exists partner, drop column if exists partner_order_id,
--   drop column if exists partner_conversion_id, drop column if exists partner_product_id,
--   drop column if exists ordered_at, drop column if exists confirmed_at,
--   drop column if exists cancelled_at, drop column if exists imported_at,
--   drop column if exists updated_at, drop column if exists sub_id,
--   drop column if exists raw_json;
