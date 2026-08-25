-- ══════════════════════════════════════════════════════════════════
--  2026-08-24  price_drop_top — 고아 이력 정책
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 붙여넣고 Run.
--
--  안전성
--    - price_history 를 한 행도 지우지 않는다. UPDATE 도 없다.
--    - products 를 건드리지 않는다.
--    - CREATE OR REPLACE VIEW 하나뿐이다. 컬럼 구성이 이전과 완전히 같아서
--      api/init.js · api/_facets.js 의 select 를 고칠 필요가 없다.
--    - 되돌리려면 supabase/2026-08-vendor-identity.sql 의 Phase 6 블록을
--      다시 실행하면 된다.
--
--  ══════════════════════════════════════════════════════════════════
--  정책: 이력은 남기고, 카탈로그에 없는 상품은 "현재 상품" 으로 취급하지 않는다
--  ══════════════════════════════════════════════════════════════════
--
--  ── 무엇을 관측했나 (2026-08-24 운영 DB) ───────────────────────
--
--    price_drop_top          2,272행
--      link IS NULL          1,549행 (68.2%)
--        · products 에 (pid, mall) 이 있는데 vid 만 어긋남 ....   386
--        · products 에 pid 자체가 없음 (고아 이력) ...........  1,163
--    price_history 비쿠팡     5,017행
--    products     비쿠팡         0행
--
--  고아가 생긴 경위는 분명하다. scripts/purge-noncoupang.js 가 카탈로그에서만
--  비쿠팡 행을 정리했고 이력은 남겼다. 그 판단 자체는 옳다 — 지난 가격은
--  지워질 이유가 없는 자산이고, 지우면 그 상품의 과거를 영영 못 본다.
--  (supabase/schema.sql 머리말의 2026-07-27 데이터 유실 사고 기록 참고)
--
--  문제는 그 이력이 "현재 팔리는 상품" 인 척 뷰에 올라온다는 것이다.
--
--  ── 지금은 왜 사고가 안 났나 ───────────────────────────────────
--
--  api/_price.js plausibleDrop 이 세 겹으로 막고 있다.
--    · isRefreshableMall(쿠팡만)
--    · product_id 가 숫자인가 (상품명이 들어간 옛 이관분 차단)
--    · link 가 있는가        (조인 실패 행 차단)
--  그래서 사용자에게 틀린 가격이 나간 적은 없다. 실측으로도 뷰 전체를 훑든
--  상위 200행만 보든 통과 행은 28행으로 같았다 — 지금 놓치는 후보는 0건이다.
--
--  ── 그럼 왜 고치는가 ───────────────────────────────────────────
--
--  방어가 노출 단계에만 있기 때문이다. 뷰의 97%가 영구 쓰레기인 상태에서
--  api/init.js 는 drop_pct 내림차순 상위 200행(DROP_FETCH)만 읽는다.
--  고아 행이 계속 늘면 언젠가 그 창이 진짜 후보를 밀어내고, 그때 홈의
--  "오늘의 가격 하락" 섹션은 아무 오류 없이 조용히 사라진다.
--
--  근원에서 거르면 그 위험이 없어진다. 이력은 그대로 남는다.
--
--  ── 두 가지를 함께 바꾼다 ──────────────────────────────────────
--
--  ① left join → inner join
--     카탈로그에 없는 상품은 뷰에 나오지 않는다. 이력 테이블은 그대로다.
--
--  ② products 조인에서 vendor_item_id 를 뺀다
--     price_history 는 옵션(vid)별로 계열을 남기고 products 는 (pid, mall) 당
--     1행에 그때그때 대표 옵션만 들고 있다. vid 까지 물리면 옵션이 한 번이라도
--     바뀐 상품은 과거 계열이 통째로 NULL 이 된다 (위 386행).
--
--     안전한가 — products 에는 products_pid_mall_key UNIQUE (product_id, mall)
--     가 있으므로 매칭되는 행은 정의상 0개 아니면 1개다. 다른 상품의 이름이나
--     링크가 붙을 수 없다.
--
--     옛 옵션의 가격에 현재 옵션의 링크가 붙는 것은 여전히 가능하다. 그건
--     api/_price.js todayDropConfirmed 가 막는다 — 화면에 찍을 current_price 가
--     "오늘 원장에 실제로 있는 최신 관측가" 와 같아야만 통과시킨다.
--     (scripts/test-regression.js 의 O1-4 케이스가 이 성질을 고정한다)
--
--  ③ 오래 멈춘 계열은 뺀다 (최근 30일)
--     수집이 끊긴 옵션 계열은 latest/prev 가 몇 달 전 값 두 개다. 하락으로
--     보이더라도 "오늘의 가격 하락" 과 무관하다. DROP_MAX_AGE_DAYS(7) 보다
--     훨씬 넉넉하게 잡아 정상 상품이 걸리지 않게 한다.
--
--  ── 가격 알림에는 영향이 없다 ──────────────────────────────────
--  scripts/check-alerts.js 는 이 뷰를 보지 않는다. price_history 를 직접 읽고,
--  "오늘 수집된 가격" 이 있어야만 판정한다. 고아 상품은 더 이상 수집되지 않아
--  오늘 행이 없으므로 애초에 알림 대상이 아니다.
-- ══════════════════════════════════════════════════════════════════

create or replace view price_drop_top as
with ranked as (
  select
    product_id,
    mall,
    vendor_item_id,
    price,
    recorded_date,
    row_number() over (
      partition by product_id, mall, vendor_item_id
      order by recorded_date desc
    ) as rn
  from price_history
  where vendor_item_id <> '__LEGACY__'
    -- ③ 멈춘 계열 제외. 이력은 남고 이 뷰에만 안 나온다.
    and recorded_date >= current_date - interval '30 days'
),
latest as (
  select product_id, mall, vendor_item_id, price as current_price, recorded_date as latest_date
  from ranked where rn = 1
),
prev as (
  select product_id, mall, vendor_item_id, price as prev_price
  from ranked where rn = 2
),
agg as (
  select product_id, mall, vendor_item_id, min(price) as all_time_low
  from price_history
  where vendor_item_id <> '__LEGACY__'
  group by product_id, mall, vendor_item_id
)
select
  l.product_id,
  l.mall,
  p2.title,
  l.current_price,
  pv.prev_price,
  a.all_time_low,
  coalesce(pv.prev_price - l.current_price, 0) as drop_amount,
  case
    when pv.prev_price > 0 and l.current_price < pv.prev_price
    then round((1.0 - l.current_price::numeric / pv.prev_price) * 100, 1)
    else 0
  end as drop_pct,
  (l.current_price <= a.all_time_low) as is_all_time_low,
  p2.link,
  p2.image
from latest l
join prev pv using (product_id, mall, vendor_item_id)
left join agg a using (product_id, mall, vendor_item_id)
-- ① inner join + ② vid 제외: 카탈로그에 있는 상품만, 옵션과 무관하게 연결한다.
join products p2 on p2.product_id = l.product_id and p2.mall = l.mall;


-- ── PostgREST 스키마 캐시 갱신 ──────────────────────────────────
notify pgrst, 'reload schema';


-- ══════════════════════════════════════════════════════════════════
--  적용 확인 — 결과 그리드에 바로 뜬다
--
--  SQL Editor 는 스크립트를 한 트랜잭션으로 돌린다. 중간에 실패하면 전부
--  롤백되는데 화면만 봐서는 알아채기 어렵다. 마지막에 직접 세어 보여 준다.
--
--  기대값
--    null_link_expect_0        0      (inner join 이라 NULL 이 생길 수 없다)
--    has_left_join_expect_0    0      (뷰 정의에 'left join products' 가 없어야 한다)
--    price_history_rows        15707  (적용 전과 같아야 한다 — 이력은 안 건드린다)
--    view_rows                        (적용 전 2,277 에서 크게 줄어든다)
-- ══════════════════════════════════════════════════════════════════
select
  current_database()                                          as db,
  (select count(*) from price_drop_top)                       as view_rows,
  (select count(*) from price_drop_top where link is null)    as null_link_expect_0,
  (select count(*) from price_history)                        as price_history_rows,
  position('left join products' in
           lower(pg_get_viewdef('price_drop_top'::regclass, true))) as has_left_join_expect_0;


-- ══════════════════════════════════════════════════════════════════
--  확인 (읽기 전용, 별도로 실행)
--
--   -- 적용 전 2,272행 / link NULL 1,549행 이었다.
--   select count(*) as total,
--          count(*) filter (where link is null) as null_link
--     from price_drop_top;
--   -- 기대: null_link = 0 (inner join 이라 NULL 자체가 생기지 않는다)
--
--   -- 이력은 그대로인지
--   select count(*) from price_history;              -- 15,647행 그대로여야 한다
--   select count(*) from price_history where mall <> '쿠팡';  -- 5,017행 그대로
--
--   -- 같은 상품이 여러 옵션으로 중복될 수 있다. 몇 건인지 본다.
--   select product_id, mall, count(*)
--     from price_drop_top group by product_id, mall having count(*) > 1;
--   -- (api/init.js 가 노출 단계에서 상품당 1장으로 접는다)
-- ══════════════════════════════════════════════════════════════════
