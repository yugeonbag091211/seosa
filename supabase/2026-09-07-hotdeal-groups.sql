-- ============================================================================
--  2026-09-07  SEOSA HOT — 같은 상품 묶기 · 현재 최저가 · 설명 가능한 신호
--
--  ── 무엇이 부족했나 ────────────────────────────────────────────────────
--
--  2026-09-06 판 hotdeals 는 «오퍼 하나 = 행 하나» 다. 유일키가
--  (source, source_external_id, mall) 이라, 같은 물건이 다른 product_id 로
--  또 수집되거나 다른 몰에도 있으면 카드가 여러 장 뜬다.
--
--  실측(2026-09-07, 최신 products 2,235건 read-only): 13개 군집 · 16행이
--  실제로 같은 물건이었다. 사용자가 볼 화면에서는 그게 "같은 상품이 4번"
--  으로 보인다.
--
--  또 화면이 "왜 핫딜인가"를 말하려면 reason 문장 한 줄로는 부족하다.
--  하락 금액·하락률·이력 개수·마지막 확인 시각이 값으로 필요하다.
--
--  ── 왜 표를 새로 만들지 않는가 ────────────────────────────────────────
--
--  군집은 «이번 회차의 스냅숏» 이다. 별도 표로 두면 hotdeals 와 군집표가
--  어긋나는 순간이 생기고, 목록 조회가 조인 하나를 더 타야 한다. 목록은
--  한 번의 인덱스 스캔으로 끝나야 하므로 대표 행에 붙여 둔다.
--
--  ── 되돌리기 ──────────────────────────────────────────────────────────
--
--  전부 add column if not exists 다. 2026-09-06-hotdeals.sql 을 아직 적용하지
--  않았다면 그것을 먼저 실행하면 되고, 이미 적용했다면 이 파일만 실행하면
--  된다. 롤백은 맨 아래.
-- ============================================================================

-- ── 1) 군집 (같은 상품 묶기) ────────────────────────────────────────────
--
-- group_key   군집 대표의 source_external_id. 같은 상품이면 같은 값.
-- is_primary  이 군집에서 «보여 줄» 한 행. 목록은 이것만 읽는다.
--
-- ★ group_key 는 회차마다 다시 계산된다. 군집 구성이 바뀌면 값도 바뀐다.
--   영구 식별자가 아니라 «이번 스냅숏에서 어느 카드에 묶였는가» 다.
alter table hotdeals add column if not exists group_key   text    not null default '';
alter table hotdeals add column if not exists is_primary  boolean not null default true;
alter table hotdeals add column if not exists group_size  integer not null default 1;

-- ── 2) 현재 최저가 판매처 ───────────────────────────────────────────────
--
-- ★ «우리가 판정을 통과시킨 오퍼 중» 최저가다. REJECTED(값 자체를 못 믿는
--   오퍼)는 후보에서 빠진다. 그래야 "여기가 제일 싸다"가 근거 있는 말이 된다.
alter table hotdeals add column if not exists group_lowest_price integer not null default 0;
alter table hotdeals add column if not exists group_lowest_mall  text    not null default '';

-- 군집 안의 오퍼 목록 [{mall, price, url, status}]. 상세가 조인 없이 읽는다.
-- ★ 여기에는 «딜이 아닌» 오퍼도 들어간다. 더 싼 곳이 있는데 그것이 우리
--   기준으로 핫딜이 아니라는 이유로 감추면, 사용자에게 더 비싼 곳을 권하게 된다.
--   REJECTED(값을 못 믿는 오퍼)만 빠진다.
alter table hotdeals add column if not exists group_offers jsonb not null default '[]'::jsonb;

-- ── 3) 설명 가능한 신호 (api/_hotdeal.signalsOf) ────────────────────────
--
-- signal_json 에 전부 들어 있지만, 정렬·필터에 쓰는 두 값만 컬럼으로 꺼낸다.
-- jsonb 안을 정렬 키로 쓰면 인덱스를 못 태운다.
alter table hotdeals add column if not exists signal_json jsonb not null default '{}'::jsonb;

-- 기준 가격 대비 하락률(%). 동점일 때의 tie-breaker 이자 "얼마나 싼가"의 값.
alter table hotdeals add column if not exists price_drop_percent numeric(6,2) not null default 0;

-- confidence 를 숫자로. HIGH 3 · MEDIUM 2 · LOW 1 · INSUFFICIENT 0.
-- 점수가 같으면 «근거가 두꺼운 쪽» 이 위로 와야 하는데, 문자열 정렬로는
-- HIGH < INSUFFICIENT < LOW < MEDIUM 이 되어 뜻이 뒤집힌다.
alter table hotdeals add column if not exists confidence_rank smallint not null default 0;

-- ── 4) 인덱스 ───────────────────────────────────────────────────────────
--
-- 목록은 언제나 «대표 행 + 노출 상태 + 점수 내림차순» 이다.
create index if not exists hotdeals_primary_list_idx
  on hotdeals (deal_status, hot_score desc, confidence_rank desc, last_checked_at desc)
  where is_primary;

-- 상세에서 "다른 판매처"를 뽑을 때.
create index if not exists hotdeals_group_idx
  on hotdeals (group_key) where group_key <> '';

comment on column hotdeals.group_key is
  '같은 상품으로 묶인 군집의 대표 키. 회차마다 재계산되는 스냅숏이다.';
comment on column hotdeals.is_primary is
  '군집에서 화면에 보여 줄 한 행. 목록 조회는 이 값이 true 인 행만 읽는다.';
comment on column hotdeals.group_lowest_price is
  '군집 안에서 판정을 통과한 오퍼 중 현재 최저가. REJECTED 는 포함하지 않는다.';
comment on column hotdeals.signal_json is
  'api/_hotdeal.signalsOf 결과. 모르는 값은 0 이 아니라 null 이다.';
comment on column hotdeals.confidence_rank is
  'confidence 의 숫자 표현(HIGH 3 / MEDIUM 2 / LOW 1 / INSUFFICIENT 0). 정렬용.';

notify pgrst, 'reload schema';

-- ── 확인 ────────────────────────────────────────────────────────────────
-- select count(*) filter (where is_primary) as cards,
--        count(*)                          as offers,
--        count(distinct group_key)         as groups
--   from hotdeals where lifecycle in ('NEW','ACTIVE','COOLING');
--
-- -- 군집이 2개 이상인 것들 (같은 상품 여러 오퍼)
-- select group_key, count(*), min(current_price), max(current_price)
--   from hotdeals where group_key <> '' group by 1 having count(*) > 1 order by 2 desc;

-- ── 롤백 ────────────────────────────────────────────────────────────────
-- drop index if exists hotdeals_primary_list_idx;
-- drop index if exists hotdeals_group_idx;
-- alter table hotdeals
--   drop column if exists group_key,
--   drop column if exists is_primary,
--   drop column if exists group_size,
--   drop column if exists group_lowest_price,
--   drop column if exists group_lowest_mall,
--   drop column if exists group_offers,
--   drop column if exists signal_json,
--   drop column if exists price_drop_percent,
--   drop column if exists confidence_rank;
