-- ══════════════════════════════════════════════════════════════════
--  2026-09-22-collector-target-keyset.sql  적용 절차 (A → I)
--
--  Supabase 대시보드 > SQL Editor 에 **한 블록씩** 붙여넣어 실행한다.
--  전부 한 번에 돌리지 말 것 — 각 단계의 출력이 다음 단계의 판단 근거다.
--
--  ★ A·D·E·F·G·H 는 전부 SELECT 다. 어떤 행도 바꾸지 않는다.
--  ★ 실제로 무언가를 바꾸는 것은 B(스키마 추가)와 C(캐시 채우기) 뿐이다.
--  ★ I 는 «되돌려야 할 때만» 쓴다. 평소에는 실행하지 않는다.
--
--  ── 언제 실행하는가 ────────────────────────────────────────────────
--
--    KST 00~08시는 피할 것. 그 시간대에 daily-prices.yml 이 30분 간격으로
--    수집을 돌리고, B 의 CREATE INDEX 가 인덱스를 만드는 동안 그 표의
--    쓰기를 잠깐 막는다(SHARE 잠금, price_history 144,376행 기준 수 초).
--    읽기는 막지 않으므로 사이트는 그대로 돈다.
--
--    지금 수집이 도는 중인지 먼저 확인하려면 A-4 를 본다.
-- ══════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════
--  A. 적용 전 상태 확인  (SELECT 만 — 아무것도 바꾸지 않는다)
-- ══════════════════════════════════════════════════════════════════

-- A-1. 규모. 이 값들이 뒤 단계의 기대치를 정한다.
select
  (select count(*) from products)                                     as products_total,
  (select count(*) from products where mall in ('쿠팡','ADPICK'))      as products_supported,
  (select count(*) from price_history)                                as price_history_total;
-- 2026-09-22 실측: 69,746 / 69,743 / 144,376

-- A-2. 새 객체가 아직 없어야 한다 (전부 false / 0 이면 «처음 적용» 이다).
select
  to_regclass('public.collector_eligible_cache')          is not null as cache_table_exists,
  to_regproc('public.collector_refresh_eligible(integer)') is not null as refresh_fn_exists,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'collector_target_page')  as target_page_fns;

-- A-3. 인덱스 현황. B 가 무엇을 새로 만들지 미리 본다.
select indexname, tablename
  from pg_indexes
 where schemaname = 'public'
   and indexname in ('products_mall_product_id_idx',
                     'price_history_recorded_at_idx',
                     'price_history_source_idx')
 order by indexname;
-- 여기 안 나오는 이름이 B 에서 새로 만들어진다.

-- A-4. ★ 지금 수집기가 도는 중인가. 돌고 있으면 B 를 미룬다.
--      lock 이 null 이거나 expires_at 이 과거면 «안 돌고 있다».
select job_date, status, processed, total, updated_at,
       last_result -> 'lock' as lock
  from price_job_state
 where id = 1;

-- A-5. 지금 느린 것이 무엇인지 기록해 둔다 (적용 후 비교용).
--      2026-09-22 실측: collector_target_products() 는 30초 한도를 넘겨
--      57014 로 취소됐고, batch 래퍼는 13,823 ms 로 아슬아슬하게 살아 있었다.
explain (analyze, buffers, timing)
select * from collector_eligible_products();
-- 기대: price_history 에 Seq Scan. 실행 시간 6초 안팎.
-- ※ 이 문장이 statement timeout 으로 취소돼도 «상태가 나쁘다» 는 뜻일 뿐,
--   아무것도 망가지지 않는다. 그냥 다음으로 넘어가면 된다.


-- ══════════════════════════════════════════════════════════════════
--  B. migration 실행
-- ══════════════════════════════════════════════════════════════════
--
--  supabase/2026-09-22-collector-target-keyset.sql 의 **전체 내용**을
--  그대로 붙여넣어 실행한다. 이 파일에 복사해 두지 않는 이유는 두 벌이
--  갈라지면 어느 쪽이 실제로 적용된 것인지 알 수 없게 되기 때문이다.
--
--  실행하는 것: CREATE TABLE ×1 / CREATE INDEX ×4 / CREATE OR REPLACE
--  FUNCTION ×2 / REVOKE·GRANT / COMMENT / NOTIFY.
--  DROP·TRUNCATE·ALTER TABLE·UPDATE 는 한 줄도 없고,
--  products·price_history 의 행은 읽기만 한다.
--
--  ※ CREATE INDEX 가 statement timeout 으로 잘리면 그냥 B 를 다시 실행하면
--    된다 — 전부 IF NOT EXISTS / OR REPLACE 라 몇 번을 돌려도 안전하다.


-- ══════════════════════════════════════════════════════════════════
--  C. 캐시를 처음 채운다  (유일하게 데이터를 만드는 단계)
-- ══════════════════════════════════════════════════════════════════

-- 인자 0 = «나이를 따지지 말고 무조건 다시 계산하라».
-- 첫 호출만 6~15초 걸린다. 이후 운영 호출(720분)은 즉시 반환한다.
select * from collector_refresh_eligible(0);
-- 기대: {"refreshed": true, "row_count": <약 3,000>, "refreshed_at": "..."}
--
-- row_count 가 0 이면 멈출 것. 수집기는 캐시가 비면 구형 경로로 폴백하므로
-- 장애는 아니지만, 이 migration 의 효과가 전혀 없다는 뜻이다.


-- ══════════════════════════════════════════════════════════════════
--  D. 캐시 행 수 확인
-- ══════════════════════════════════════════════════════════════════

select count(*)                as cached_rows,
       count(distinct mall)    as malls,
       min(refreshed_at)       as oldest,
       max(refreshed_at)       as newest
  from collector_eligible_cache;
-- 기대: cached_rows ≈ 3,000 / oldest = newest (한 번의 갱신이 전부 같은 시각을 찍는다)

select mall, count(*) from collector_eligible_cache group by mall order by mall;
-- 2026-09-20 실측 참고: 쿠팡 1838 / ADPICK 1127


-- ══════════════════════════════════════════════════════════════════
--  E. ★ 캐시가 원본과 «정확히» 같은가  (규칙을 안 바꿨다는 증거)
-- ══════════════════════════════════════════════════════════════════

-- E-1. 개수 대조
select
  (select count(*) from collector_eligible_cache)      as cached,
  (select count(*) from collector_eligible_products()) as source;
-- ★ 두 값이 같아야 한다. 다르면 아래 E-2 가 어느 쪽이 튀는지 알려준다.

-- E-2. 집합 대조 — 양쪽 모두 0행이어야 한다.
select 'cache에만 있음' as side, c.product_id, c.mall
  from collector_eligible_cache c
  left join collector_eligible_products() e
    on e.product_id = c.product_id and e.mall = c.mall
 where e.product_id is null
union all
select 'source에만 있음', e.product_id, e.mall
  from collector_eligible_products() e
  left join collector_eligible_cache c
    on c.product_id = e.product_id and c.mall = e.mall
 where c.product_id is null
 limit 50;
-- ★ 0행이면 «계산 위치만 옮겼고 규칙은 그대로» 가 증명된 것이다.


-- ══════════════════════════════════════════════════════════════════
--  F. collector_target_page — 첫 / 중간 / 마지막 페이지
-- ══════════════════════════════════════════════════════════════════
--
--  오늘 버킷은 UTC 일수 기준이다. 수집기와 같은 값을 쓰려면:
--    select mod(mod((extract(epoch from now())/86400)::bigint, 7) + 7, 7);
--  아래에서는 버킷을 0 으로 고정해 «구조» 만 본다 (버킷 값은 결과 수만 바꾼다).

-- F-1. 첫 페이지 — 커서 없음
select mall, tier, count(*) over () as page_rows,
       min(product_id) over () as first_pid,
       max(product_id) over () as last_pid
  from collector_target_page(7, 0, null, null, 1000, false)
 limit 3;
-- 기대: page_rows = 1000 (대상이 1,000개 미만이면 그 수), 수십~수백 ms

-- F-2. 중간 페이지 — 첫 페이지의 마지막 행을 커서로 넘긴다
with p1 as (
  select mall, product_id
    from collector_target_page(7, 0, null, null, 1000, false)
   order by mall, product_id
   offset 999 limit 1
)
select count(*) as page_rows
  from p1, lateral collector_target_page(7, 0, p1.mall, p1.product_id, 1000, false);
-- 기대: 1000 (또는 남은 만큼). ★ 첫 페이지와 «같은 시간» 이어야 한다.

-- F-3. 마지막 근처 — 모든 값보다 큰 커서를 주면 0행이 즉시 온다
select count(*) as should_be_zero
  from collector_target_page(7, 0, 'zzzz', 'zzzz', 1000, false);
-- 기대: 0, 수 ms

-- F-4. 전량 모드(PRICE_INCLUDE_BULK_SEED=1 경로)도 페이지 크기가 고정인가
select count(*) as page_rows
  from collector_target_page(7, 0, null, null, 1000, true);
-- 기대: 1000 (카탈로그가 6만이어도 한 페이지는 1,000행이다)

-- F-5. 회전 규칙이 안 바뀌었는가 — 7개 버킷의 합이 카탈로그와 맞아야 한다
select sum(n) as covered_in_7_days,
       (select count(*) from products where mall in ('쿠팡','ADPICK')) as supported
  from (
    select b, (select count(*) from collector_target_page(7, b, null, null, 1000, false)) as n
      from generate_series(0, 6) b
  ) t;
-- ※ 페이지가 1,000 으로 잘리므로 이 값은 «하한» 이다. 정확한 비교는 아래를 쓴다.
--   상시 추적(daily)은 7일 내내 나오므로 단순 합계는 카탈로그보다 크다.


-- ══════════════════════════════════════════════════════════════════
--  G. 성능 확인
-- ══════════════════════════════════════════════════════════════════

-- G-1. ★ 핵심 — 키셋 한 페이지가 인덱스를 타는가
explain (analyze, buffers, timing)
select * from collector_target_page(7, 0, '쿠팡', '5000000000', 1000, false);
-- 기대:
--   · products 에 Index Scan / Index Only Scan using products_mall_product_id_idx
--     (Seq Scan 이 보이면 §4 의 인덱스가 안 만들어진 것이다 — A-3 를 다시 본다)
--   · collector_eligible_cache 에 Index Scan (기본키)
--   · Execution Time 이 «수백 ms» 대. 초 단위면 뭔가 잘못됐다.

-- G-2. 적용 전(A-5)과 같은 질의를 다시 — 인덱스 효과
explain (analyze, buffers, timing)
select * from collector_eligible_products();
-- 기대: price_history 가 Seq Scan 에서 Bitmap/Index Scan 으로 바뀔 수 있다.
--       다만 이 함수는 이제 하루 한 번만 돈다 — 여기가 느려도 수집은 안 죽는다.

-- G-3. 갱신을 건너뛰는 경로가 정말 «즉시» 인가 (운영이 매 실행 부르는 모양)
explain (analyze, timing)
select collector_refresh_eligible(720);
-- 기대: 한 자리 ms. 720분 안에 갱신했으므로 계산을 건너뛴다.

-- G-4. 구형 경로가 얼마나 위험했는지 기록 (참고용, 실행은 선택)
--      2026-09-22 실측: 13,823 ms — 함수 자체 statement_timeout 30s 의 46%.
-- explain (analyze, timing)
-- select collector_target_products_batch(7, 0);


-- ══════════════════════════════════════════════════════════════════
--  H. 중복 key 검사
-- ══════════════════════════════════════════════════════════════════

-- H-1. 캐시에 (product_id, mall) 중복이 없는가  — unique 제약이 있으니 0이어야 한다
select product_id, mall, count(*)
  from collector_eligible_cache
 group by product_id, mall
having count(*) > 1;
-- 기대: 0행

-- H-2. 캐시의 커서 컬럼이 유일한가 (키셋이 행을 건너뛰지 않으려면 필수)
select count(*) as rows, count(distinct id) as distinct_ids
  from collector_eligible_cache;
-- 기대: 두 값이 같다

-- H-3. ★ 한 페이지 안에 (product_id, mall) 중복이 없는가
select product_id, mall, count(*)
  from collector_target_page(7, 0, null, null, 1000, false)
 group by product_id, mall
having count(*) > 1;
-- 기대: 0행

-- H-4. ★ 페이지 경계에서 겹치지 않는가 — 앞뒤 두 페이지의 교집합이 0이어야 한다
with p1 as (
  select * from collector_target_page(7, 0, null, null, 1000, false)
),
cur as (
  select mall, product_id from p1 order by mall, product_id offset 999 limit 1
),
p2 as (
  select t.* from cur, lateral collector_target_page(7, 0, cur.mall, cur.product_id, 1000, false) t
)
select count(*) as overlap
  from p1 join p2 on p1.product_id = p2.product_id and p1.mall = p2.mall;
-- 기대: 0

-- H-5. 캐시가 카탈로그에 없는 상품을 가리키지 않는가 (고아 행)
select count(*) as orphan_cache_rows
  from collector_eligible_cache c
  left join products p on p.product_id = c.product_id and p.mall = c.mall
 where p.product_id is null;
-- 기대: 0
-- ※ 0이 아니어도 수집에는 해가 없다 — collector_target_page 가 products 쪽에서
--   시작하므로 고아 캐시 행은 결과에 나오지 않는다. 다음 갱신에서 사라진다.


-- ══════════════════════════════════════════════════════════════════
--  I. rollback  (필요할 때만 실행 — 평소에는 건드리지 않는다)
-- ══════════════════════════════════════════════════════════════════
--
--  ★ 되돌려도 잃는 데이터가 없다.
--    collector_eligible_cache 는 collector_eligible_products() 로 언제든
--    다시 만들 수 있는 파생 캐시다. products / price_history 는 이
--    migration 이 애초에 쓴 적이 없다.
--
--  ★ 수집기는 새 함수가 사라지면 구형 경로로 «자동» 폴백한다
--    (scripts/collect-all-prices.js 의 fetchCollectorTargetKeys 참고).
--    코드를 되돌리지 않아도 동작한다 — 다만 2026-09-22 에 터졌던
--    타임아웃 위험으로 되돌아간다.

-- I-1. 가장 가벼운 되돌리기 — 함수만 내린다.
--      수집기는 즉시 구형 batch RPC 로 폴백한다. 표와 인덱스는 남는다.
-- drop function if exists public.collector_target_page(integer, integer, text, text, integer, boolean);
-- drop function if exists public.collector_refresh_eligible(integer);
-- notify pgrst, 'reload schema';

-- I-2. 캐시 표까지 지운다 (파생 데이터라 잃는 사실이 없다).
-- drop table if exists collector_eligible_cache;
-- notify pgrst, 'reload schema';

-- I-3. 인덱스까지 되돌린다.
--      ※ price_history_recorded_at_idx 는 이 migration 만의 것이 아니다 —
--        supabase/2026-09-21-price-history-recorded-at-index.sql 이 홈 핫딜
--        «오늘 가격 하락» 을 위해 요구하는 인덱스다. 지우면 그쪽이 느려진다.
--        되돌릴 이유가 없으면 남겨 둘 것.
-- drop index if exists products_mall_product_id_idx;
-- drop index if exists price_history_source_idx;
-- -- drop index if exists price_history_recorded_at_idx;   ← 위 주의사항 참고

-- I-4. 되돌린 뒤 확인 — 구형 경로가 살아 있는가
-- select collector_target_products_batch(7, 0) is not null as old_path_alive;
