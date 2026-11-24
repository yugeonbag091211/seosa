-- price_drop_for_products(p_ids) — 검색 결과에 «최근 가격 하락» 을 붙일 때 쓰는 함수 (2026-11-24)
--
-- ★ 적용 전 승인 필요 (운영 DB 에 함수 1개를 만든다. 표·뷰·데이터는 바꾸지 않는다).
--   적용하지 않아도 동작은 그대로다 — api/_facets.js 는 이 함수가 없으면(PGRST202)
--   지금처럼 price_drop_top 뷰를 읽는다.
--
-- 왜: /api/search 는 검색마다 price_drop_top 뷰를 product_id IN (검색 결과) 로 읽는다.
--   뷰 안의 all_time_low 집계(agg)가 LEFT JOIN 의 안쪽이라 그 조건이 내려가지 않아,
--   검색 결과 18개를 위해 price_history 전체(565,002행)를 훑고 83,316개 그룹을
--   해시 집계한다(작업 메모리를 넘어 디스크 임시 파일 7MB). 운영 EXPLAIN ANALYZE
--   (2026-11-24, 읽기 전용): 서버 실행 423~479ms.
--
-- 이 함수는 뷰와 같은 식을 «요청한 상품만» 계산한다. 같은 날 운영 DB 에서 이 파일의 본문
--   그대로(p_ids 자리에 배열 값)를 세 묶음(18 · 100 · 100개 상품)으로 돌려 뷰 결과와 비교했다.
--   행이 완전히 같았고(18 · 101 · 32행), 서버 실행은 2.0 · 13.0 · 5.5ms 였다.
--
-- 식은 운영 DB 의 현재 price_drop_top 정의(pg_get_viewdef, 2026-11-24)의 ranked · latest_prev ·
--   agg 를 그대로 옮기고, product_id = any(p_ids) 조건만 안쪽 두 곳에 넣었다.
--   뷰를 바꾸면 이 함수도 같이 바꿔야 한다 — 홈 시세판과 검색의 하락 기준이 갈라지면 안 된다
--   (api/_facets.js 주석).
--
-- 되돌리기: drop function if exists public.price_drop_for_products(text[]);

create or replace function public.price_drop_for_products(p_ids text[])
returns table (
  product_id text,
  mall text,
  current_price integer,
  prev_price integer,
  all_time_low integer,
  drop_amount integer,
  drop_pct numeric,
  is_all_time_low boolean,
  link text
)
language sql
stable
set search_path = public
set statement_timeout = '5s'
as $$
  with ranked as (
    select h.product_id, h.mall, h.vendor_item_id, h.price, h.recorded_date,
           row_number() over (partition by h.product_id, h.mall, h.vendor_item_id
                              order by h.recorded_date desc) as rn
      from price_history h
     where h.product_id = any(p_ids)
       and h.vendor_item_id <> '__LEGACY__'
       and h.recorded_date >= (current_date - '30 days'::interval)
  ), latest_prev as (
    select ranked.product_id, ranked.mall, ranked.vendor_item_id,
           max(ranked.price) filter (where ranked.rn = 1) as current_price,
           max(ranked.price) filter (where ranked.rn = 2) as prev_price
      from ranked
     group by ranked.product_id, ranked.mall, ranked.vendor_item_id
    having count(*) filter (where ranked.rn = 2) > 0
  ), agg as (
    select h.product_id, h.mall, h.vendor_item_id, min(h.price) as all_time_low
      from price_history h
     where h.product_id = any(p_ids)
       and h.vendor_item_id <> '__LEGACY__'
     group by h.product_id, h.mall, h.vendor_item_id
  )
  select lp.product_id, lp.mall, lp.current_price, lp.prev_price, a.all_time_low,
         coalesce(lp.prev_price - lp.current_price, 0) as drop_amount,
         case when lp.prev_price > 0 and lp.current_price < lp.prev_price
              then round((1.0 - lp.current_price::numeric / lp.prev_price::numeric) * 100::numeric, 1)
              else 0::numeric end as drop_pct,
         lp.current_price <= a.all_time_low as is_all_time_low,
         p2.link
    from latest_prev lp
    left join agg a using (product_id, mall, vendor_item_id)
    join products p2 on p2.product_id = lp.product_id and p2.mall = lp.mall;
$$;

comment on function public.price_drop_for_products(text[]) is
  'price_drop_top 과 같은 식을 요청한 product_id 만 계산한다. /api/search (api/_facets.js) 가 쓴다. 2026-11-24';
