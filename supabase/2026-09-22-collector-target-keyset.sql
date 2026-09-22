-- ══════════════════════════════════════════════════════════════════
--  2026-09-22  수집 대상 조회를 «매 실행 재계산» 에서 «키셋 페이지» 로
--
--  ★ 데이터를 지우지 않는다. 새 표 하나(collector_eligible_cache)와
--    함수 둘, 인덱스 셋을 더할 뿐이다. 기존 함수
--    collector_eligible_products() / collector_target_products() /
--    collector_target_products_batch() 는 한 줄도 바꾸지 않는다 —
--    구버전 수집기가 그대로 돌아야 하기 때문이다.
--    전부 create ... if not exists / or replace 라 몇 번을 실행해도 안전하다.
-- ══════════════════════════════════════════════════════════════════

-- ── 무엇이 터졌나 (2026-09-22 KST 07:41, 운영 실측) ─────────────────
--
--   치명적 오류: collector_target_products 조회 실패:
--     canceling statement due to statement timeout
--   (gh run 35662376120 / 35663976131 — Daily Price Collection 연속 2회 실패)
--
--   같은 오류를 읽기 전용으로 재현했다 (2026-09-22 10:19 KST):
--     rpc('collector_target_products', {7, 0}).limit(3)
--       → 57014 canceling statement due to statement timeout   30,362 ms
--
--   30초에서 잘린다. 즉 하루 전(2026-09-22-collector-target-timeout-batch.sql)
--   에 8초 → 30초로 올려 둔 함수 단위 statement_timeout 을 **하루 만에 다시
--   넘겼다.** 한도를 올리는 처방은 이미 수명이 끝났다.
--
-- ── 왜 느린가 (구조) ───────────────────────────────────────────────
--
--   collector_target_products() 한 번의 비용은 카탈로그와 원장에 함께 비례한다.
--
--   ① collector_eligible_products() 가 price_history 전체를 훑는다.
--        where h.recorded_at < '2026-09-17'  or  h.source in (...)
--      두 컬럼에 걸친 OR 라 어느 인덱스도 못 쓴다 → Seq Scan.
--      거기에 products 조인 + select distinct (해시 집계) 가 얹힌다.
--      읽기 전용 실측: 이 함수 하나가 6,034 ms.
--      price_history 는 143,282행이고 2026-09-18 하루에만 66,740행이 늘었다.
--
--   ② 그 결과를 daily CTE 로 받아 **두 번** 참조한다
--      (rotation 의 left join, 그리고 최종 union all).
--
--   ③ rotation 이 products 69,743행을 전부 읽으면서 행마다
--      hashtextextended(product_id || '|' || mall, 0) 을 계산한다.
--
--   ①+②+③ 이 **매 실행** 다시 돈다. 하루 18칸(daily-prices.yml)이면
--   같은 계산을 하루 18번 한다. 게다가 batch RPC 가 없던 시절에는
--   PostgREST max-rows=1000 때문에 페이지마다 다시 돌아 하루 200번을 넘겼다.
--
--   ★ 핵심: 이 함수의 비용은 «오늘 대상이 몇 개인가» 가 아니라
--     «원장과 카탈로그가 얼마나 큰가» 로 정해진다. 그래서 카탈로그가
--     69,743 → 100,000 으로 가면 실패는 더 빨라진다. 한도를 60초로 올려도
--     같은 자리에서 다시 죽는다.
--
-- ── 무엇으로 바꾸는가 ──────────────────────────────────────────────
--
--   비싼 부분(①)을 «하루 한 번 계산해서 표에 적어 두는 것» 으로 분리하고,
--   수집기는 그 표를 인덱스로 훑는다.
--
--     collector_eligible_cache      ①의 결과를 담는 표 (2,965행 규모)
--     collector_refresh_eligible()  ①을 다시 계산해 표에 반영 (하루 1회)
--     collector_target_page()       (mall, product_id) 키셋 한 페이지
--
--   collector_target_page() 한 번의 비용은 **페이지 크기에만** 비례한다.
--   offset 이 없으므로 6만 번째 페이지도 첫 페이지와 같은 값이다.
--   카탈로그가 10만, 100만이 되어도 한 문장의 시간은 그대로다.

-- ── 1. 상시 추적 대상 캐시 ────────────────────────────────────────
--
--   내용은 collector_eligible_products() 의 출력 그대로다. 규칙을 바꾸지
--   않는다 — 어디서 무엇을 계산하는가만 옮긴다.
create table if not exists collector_eligible_cache (
  -- ★ id 가 왜 필요한가.
  --   수집기는 이 표를 키셋으로 훑는다. 그런데 커서 컬럼은 «유일하고 단조»
  --   여야 한다. product_id 하나만으로는 유일하지 않다 — 같은 product_id 가
  --   쿠팡과 ADPICK 에 둘 다 있을 수 있고(기본키가 두 컬럼인 이유가 그것이다),
  --   그 두 행이 페이지 경계에 걸리면 뒤엣것을 통째로 건너뛴다.
  --   PostgREST 에는 (a,b) > (c,d) 행 비교 문법이 없으므로 단일 키를 둔다.
  id           bigserial   primary key,
  product_id   text        not null,
  mall         text        not null,
  refreshed_at timestamptz not null default now(),
  unique (product_id, mall)
);

comment on table collector_eligible_cache is
  'collector_eligible_products() 의 결과를 하루 한 번 굳혀 둔 캐시. '
  '수집기(collector_target_page)가 매 실행 price_history 전체를 다시 훑지 '
  '않게 한다. 진실의 원본은 여전히 collector_eligible_products() 이고, '
  '이 표는 collector_refresh_eligible() 로만 갱신한다.';

-- 갱신 시각으로 «얼마나 오래된 캐시인가» 를 묻는다.
create index if not exists collector_eligible_cache_refreshed_idx
  on collector_eligible_cache (refreshed_at desc);

-- ── 2. 캐시 갱신 ──────────────────────────────────────────────────
--
--   ★ 조건부다. 캐시가 p_max_age_minutes 보다 새것이면 아무 일도 하지 않고
--     (false, 행수, 갱신시각) 을 돌려준다. 하루 18칸이 전부 이 함수를 불러도
--     실제 재계산은 하루 한 번만 일어난다.
--
--   ★ 지운 뒤 넣지 않는다. upsert 로 채우고 «이번 갱신에 안 나온 행» 만
--     지운다. 중간에 실패해도 캐시가 통째로 비는 순간이 없다 —
--     빈 캐시는 "상시 추적 대상 0개" 로 읽혀서 수집 대상을 조용히
--     회전 버킷만으로 좁혀 버린다(가장 위험한 실패 모양이다).
--
--   ★ statement_timeout 을 120초로 둔다. 재계산 본체(6초)가 원장 증가로
--     느려져도 견디게 하되, 무한정 물고 있지는 않게 한다.
create or replace function public.collector_refresh_eligible(
  p_max_age_minutes integer default 720
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
set statement_timeout = '120s'
as $$
-- ★ jsonb 로 돌려주는 이유: RETURNS TABLE 의 OUT 이름(refreshed_at 등)이
--   plpgsql 안에서 같은 이름의 «컬럼» 을 가려 "column reference is ambiguous"
--   를 낸다. 이름 충돌을 원천적으로 없애려고 한 덩어리로 돌려준다.
declare
  v_newest  timestamptz;
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
begin
  select max(c.refreshed_at) into v_newest from collector_eligible_cache c;

  -- 아직 새것이면 아무 일도 하지 않는다. 하루 18칸이 전부 불러도
  -- 실제 재계산은 하루 한 번이다.
  if v_newest is not null
     and v_newest > now() - make_interval(mins => greatest(coalesce(p_max_age_minutes, 720), 0))
  then
    select count(*)::integer into v_rows from collector_eligible_cache;
    return jsonb_build_object('refreshed', false, 'row_count', v_rows, 'refreshed_at', v_newest);
  end if;

  insert into collector_eligible_cache (product_id, mall, refreshed_at)
  select e.product_id, e.mall, v_started
    from public.collector_eligible_products() e
  on conflict (product_id, mall)
  do update set refreshed_at = excluded.refreshed_at;

  -- 이번 계산에 나오지 않은 행 = 더 이상 상시 추적 대상이 아니다
  -- (카탈로그에서 빠졌거나 조건에서 벗어났다).
  delete from collector_eligible_cache c where c.refreshed_at < v_started;

  select count(*)::integer into v_rows from collector_eligible_cache;
  return jsonb_build_object('refreshed', true, 'row_count', v_rows, 'refreshed_at', v_started);
end;
$$;

revoke execute on function public.collector_refresh_eligible(integer)
  from public, anon, authenticated;
grant execute on function public.collector_refresh_eligible(integer)
  to service_role;

-- ── 3. 대상 한 페이지 (키셋) ──────────────────────────────────────
--
--   (mall, product_id) 오름차순으로 «커서 뒤» 만 limit 개 돌려준다.
--   offset 이 없으므로 뒤로 갈수록 느려지지 않는다.
--
--   tier 판정은 캐시 조인 한 번이다. 상시 추적(daily)은 회전 버킷과
--   무관하게 매일 나오고, 나머지는 해시 버킷이 오늘과 맞을 때만 나온다 —
--   2026-09-21-collector-full-catalog-rotation.sql 의 규칙 그대로다.
--
--   p_include_all=true 는 회전을 끄고 카탈로그 전체를 대상으로 삼는다
--   (PRICE_INCLUDE_BULK_SEED=1 의 «오늘 6만개 전량 재수집» 경로).
--   그때도 한 문장이 읽는 양은 limit 개로 고정이다.
create or replace function public.collector_target_page(
  p_rotation_days    integer default 7,
  p_rotation_bucket  integer default 0,
  p_after_mall       text    default null,
  p_after_product_id text    default null,
  -- ★ 1,000 을 넘겨 봐야 소용없다 — PostgREST 의 db-max-rows 가 1,000 이라
  --   그보다 많이 요청해도 1,000행만 온다 (2026-09-22 읽기 전용 실측).
  p_limit            integer default 1000,
  p_include_all      boolean default false
)
returns table (product_id text, mall text, tier text)
language sql
stable
security invoker
set search_path = public
set statement_timeout = '30s'
as $$
  with params as (
    select greatest(coalesce(p_rotation_days, 7), 1) as days,
           least(greatest(coalesce(p_limit, 1000), 1), 1000) as lim
  ),
  b as (
    select days, lim,
           mod(mod(coalesce(p_rotation_bucket, 0), days) + days, days) as bucket
      from params
  )
  select p.product_id,
         p.mall,
         case when e.product_id is null then 'rotation' else 'daily' end as tier
    from public.products p
    cross join b
    left join public.collector_eligible_cache e
      on e.product_id = p.product_id
     and e.mall = p.mall
   where p.mall in ('쿠팡', 'ADPICK')
     and (p_after_mall is null
          or (p.mall, p.product_id) > (p_after_mall, coalesce(p_after_product_id, '')))
     and (coalesce(p_include_all, false)
          or e.product_id is not null
          or mod(
               mod(hashtextextended(p.product_id || '|' || p.mall, 0), b.days) + b.days,
               b.days
             ) = b.bucket)
   order by p.mall, p.product_id
   limit (select lim from b)
$$;

revoke execute on function public.collector_target_page(integer, integer, text, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.collector_target_page(integer, integer, text, text, integer, boolean)
  to service_role;

-- ── 4. 인덱스 ─────────────────────────────────────────────────────
--
--   ① 키셋의 정렬·범위 키 그대로. 이게 없으면 페이지마다 products 전체를
--     정렬하므로 키셋으로 바꾼 의미가 사라진다.
create index if not exists products_mall_product_id_idx
  on products (mall, product_id);

--   ② collector_refresh_eligible() 본체가 쓰는 두 조건.
--     recorded_at 쪽은 2026-09-21-price-history-recorded-at-index.sql 과
--     같은 인덱스다 (if not exists 라 중복 적용해도 무해하다).
create index if not exists price_history_recorded_at_idx
  on price_history (recorded_at desc);

create index if not exists price_history_source_idx
  on price_history (source);

-- PostgREST 스키마 캐시 갱신 (없으면 .rpc() 가 404 를 돌려준다)
notify pgrst, 'reload schema';

-- ── 적용 뒤 확인 (전부 읽기 전용) ─────────────────────────────────
--
--  -- 캐시를 처음 채운다 (첫 호출만 6~10초, 이후는 즉시 반환)
--  select * from collector_refresh_eligible(0);
--      -- 기대: refreshed=true, row_count ≈ 2,965
--
--  -- 첫 페이지
--  select * from collector_target_page(7, 4, null, null, 1000, false);
--      -- 기대: 1,000행, 수십 ms
--
--  -- 마지막 근처 페이지도 같은 시간이어야 한다 (offset 이 없으므로)
--  select count(*) from collector_target_page(7, 4, '쿠팡', '9999999999', 1000, false);
--
--  -- 캐시와 원본이 같은지 (규칙을 안 바꿨다는 증거)
--  select
--    (select count(*) from collector_eligible_cache)       as cached,
--    (select count(*) from collector_eligible_products())  as source;
--      -- 두 값이 같아야 한다
--
-- ── 되돌리기 ──────────────────────────────────────────────────────
--
--  drop function if exists public.collector_target_page(integer, integer, text, text, integer, boolean);
--  drop function if exists public.collector_refresh_eligible(integer);
--  drop table if exists collector_eligible_cache;
--  (수집기는 collector_target_products_batch 로 자동 폴백한다 —
--   scripts/collect-all-prices.js fetchCollectorTargetKeys 참고)
