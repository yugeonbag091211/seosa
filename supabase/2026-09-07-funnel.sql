-- ============================================================================
--  2026-09-07  구매 퍼널 계측 · 전환(GMV) 골격
--
--  ── 왜 daily_metrics 로 부족한가 ───────────────────────────────────────
--
--  2026-08-25-analytics.sql 의 daily_metrics 는 (날짜, 지표) → 카운트다.
--  "어제 제휴 링크가 40번 눌렸다" 까지는 답하지만
--  "무엇이, 어느 몰에서, 얼마에 눌렸는가" 에는 답하지 못한다.
--
--  SEOSA 의 목표가 방문자 수가 아니라 «SEOSA 를 거쳐 산 금액» 이라면 그
--  질문에 답할 수 있어야 한다. 어떤 상품이 돈이 되는지 모르면 무엇을 더
--  수집할지, 어떤 핫딜을 위로 올릴지 정할 근거가 없다.
--
--  ── 그런데 원본 이벤트를 쌓지 말라고 하지 않았나 ───────────────────────
--
--  그 판단(2026-08-25 주석)은 지금도 옳다. 그래서 **전부** 쌓지 않는다.
--
--    조회·검색·노출 같은 대량 이벤트  → daily_metrics 에 그대로 (카운터)
--    구매에 닿는 소수의 이벤트        → funnel_events 에 행으로
--
--  제휴 클릭은 하루 수백 건 규모다. 그 정도는 행으로 남겨도 되고, 남겨야
--  상품·몰·가격을 붙일 수 있다. 검색·조회까지 행으로 쌓으면 예전 판단대로
--  하루 수만 행이 되므로 그쪽은 건드리지 않는다.
--
--  ── 개인정보 ───────────────────────────────────────────────────────────
--
--  2026-08-25 의 원칙을 그대로 잇는다.
--    · IP 를 저장하지 않는다
--    · User-Agent 를 저장하지 않는다
--    · 이메일·계정과 연결하지 않는다          ★ 이것이 핵심이다
--    · visitor_id 는 브라우저가 만든 난수다 (localStorage)
--  즉 이 표만으로는 어떤 개인도 특정할 수 없다. 핑거프린팅을 하지 않는다.
--
--  ── 안전성 ─────────────────────────────────────────────────────────────
--  새 표 2개와 인덱스만 만든다. 기존 표를 건드리지 않는다.
--  DROP / TRUNCATE / DELETE / UPDATE 가 한 문장도 없다.
--  전부 if not exists 라 재실행해도 안전하다.
--  적용 전에도 서비스는 그대로 돈다 — api/_funnel.js 가 표가 없으면 한 번
--  경고하고 계측만 끈다 (기존 _analytics.js 와 같은 폴백).
-- ============================================================================

-- ── 1. 구매에 닿는 이벤트 ────────────────────────────────────────────────
create table if not exists funnel_events (
  id          bigserial   primary key,
  event_date  date        not null,
  event       text        not null,   -- affiliate_click | radar_save | target_price_set | ...
  product_id  text        not null default '',
  mall        text        not null default '',
  price       integer     not null default 0,
  -- 어디서 눌렸는가: hotdeal | search | product | radar | ai | compare
  source      text        not null default '',
  -- 브라우저 난수. 계정과 연결하지 않는다.
  visitor_id  text        not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists funnel_events_date_idx    on funnel_events (event_date, event);
create index if not exists funnel_events_product_idx on funnel_events (product_id) where product_id <> '';

comment on table funnel_events is
  '구매에 닿는 소수 이벤트만 상품 단위로 남긴다. 대량 이벤트는 daily_metrics 카운터로 유지한다.';
comment on column funnel_events.visitor_id is
  '브라우저가 만든 난수. IP·UA·이메일과 연결하지 않는다.';


-- ── 2. 확정 전환 ─────────────────────────────────────────────────────────
--
--  ★★ 이 표는 지금 «비어 있는 것이 정상» 이다. ★★
--
--  2026-09-07 조사: 쿠팡 파트너스·ADPICK 어느 쪽도 이 저장소에 전환/정산
--  리포트 API 가 연결돼 있지 않다. api/_adpick.js 의 commissionlink 는 링크일
--  뿐이고 commission 은 «수수료율» 이지 «발생한 수수료» 가 아니다.
--
--  그래서 확정 전환을 채울 데이터 출처가 아직 없다. 그럼에도 표를 미리 두는
--  이유는 하나다 — **클릭을 구매라고 부르지 않기 위해서다.**
--
--      funnel_events.event = 'affiliate_click'   눌렀다
--      conversions                                 샀다
--
--  이 둘을 한 표에 두면 언젠가 "클릭 × 평균단가 = GMV" 같은 계산이 슬며시
--  들어온다. 그건 매출이 아니라 희망이다. 표를 갈라 두면 그 계산을 쓰려는
--  순간 조인할 데이터가 없다는 사실이 먼저 드러난다.
--
--  채우는 방법은 둘 중 하나여야 한다 (둘 다 사람이 승인한 값이다).
--    1) 파트너스 정산 리포트 CSV 를 사람이 올려 적재
--    2) 파트너스가 전환 API 를 열어 주면 그것을 수집
--  어느 쪽도 클릭에서 «추정» 하지 않는다.
create table if not exists conversions (
  id            bigserial   primary key,
  -- 어디서 확인한 값인가. 'coupang-report' | 'adpick-report' | 'manual'
  source        text        not null,
  -- 그 출처가 준 주문/전환 식별자. 같은 건을 두 번 넣지 않기 위한 키다.
  external_id   text        not null,
  order_date    date        not null,
  product_id    text        not null default '',
  mall          text        not null default '',
  -- 실제 결제 금액(GMV)과 우리가 받은 수수료. 추정값을 넣지 않는다.
  gmv           integer     not null default 0,
  commission    integer     not null default 0,
  quantity      integer     not null default 1,
  created_at    timestamptz not null default now()
);

create unique index if not exists conversions_source_key on conversions (source, external_id);
create index if not exists conversions_date_idx on conversions (order_date);

comment on table conversions is
  '확정 전환만. 클릭에서 추정한 값을 넣지 않는다. 출처는 정산 리포트뿐이다.';
comment on column conversions.gmv is
  '실제 결제 금액. 클릭 수 × 단가 같은 추정치를 절대 넣지 않는다.';


-- ── 3. RLS — server-only ─────────────────────────────────────────────────
--  SEOSA 관례: RLS 를 켜고 정책을 만들지 않는다. 정책이 없으면 anon /
--  authenticated 는 어떤 행도 읽거나 쓸 수 없고 service_role 만 우회한다.
alter table funnel_events enable row level security;
alter table conversions   enable row level security;

notify pgrst, 'reload schema';

-- ── 확인 ────────────────────────────────────────────────────────────────
-- select event, count(*) from funnel_events group by 1 order by 2 desc;
-- select count(*) as should_be_zero_until_report_ingested from conversions;
-- select relname, relrowsecurity from pg_class
--   where relname in ('funnel_events','conversions');   -- 둘 다 true

-- ── 롤백 ────────────────────────────────────────────────────────────────
-- drop table if exists funnel_events;
-- drop table if exists conversions;
