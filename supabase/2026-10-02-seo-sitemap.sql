-- ══════════════════════════════════════════════════════════════════
--  2026-10-02  상품 사이트맵을 DB 에서 한 번에 계산한다 (읽기 전용 함수 1개)
--
--  ★ 데이터를 바꾸지 않는다. 표·인덱스·행을 만들거나 지우지 않는다.
--    STABLE 함수 하나를 더할 뿐이다. create or replace 라 몇 번 실행해도 안전하다.
--  ★ 적용 전에도 사이트는 그대로 돈다. 함수가 없으면 api/_seo-pages.js 가
--    예전 방식(api/_product-page.js indexableProducts, 상한 5,000개)으로 폴백한다.
--  ★ 쓰기 잠금이 없다 — 수집 cron 시간대(KST 00~08시)에 실행해도 된다.
-- ══════════════════════════════════════════════════════════════════

-- ── 왜 필요한가 (2026-10-02 운영 실측, 읽기 전용) ────────────────────
--
--   GET https://seosa.ai.kr/sitemap-products.xml   (캐시 MISS)
--     10.9초 · URL 1,146개
--
--   같은 규칙(live · 링크 있음 · 관측 7일 이상)으로 products 70,357행과
--   price_history 30일치 178,938행을 전부 읽어 다시 세면 2,044개다.
--   예전 코드는 이력 40페이지(4만 행)·상품 10페이지(1만 행)에서 멈추므로
--   카탈로그가 클수록 사이트맵이 더 많이 빠지고 더 느려진다.
--   그 계산을 JS 에서 하면 행을 전부 네트워크로 옮겨야 한다 (실측 146초).
--
--   이 함수는 같은 판정을 DB 안에서 한 번에 하고 결과만 돌려준다.
--
-- ── 판정 규칙 (api/_product-page.js buildView 의 indexable 과 같다) ──
--
--   1) mall 이 수집 가능한 몰 (쿠팡 · ADPICK)                — isRefreshableMall
--   2) lprice > 0, collected_at 이 p_max_age_days 이내       — productLifecycle LIVE
--      + lprice ≥ 100, 제목에 렌탈·구독 없음                 — _seo.isNonPurchaseListing
--   3) link 가 http(s)                                        — safeUrl
--   4) product_id 가 /p/ 주소로 쓸 수 있는 모양              — cleanPid
--   5) 관측한 KST 날짜 수 ≥ p_min_days                       — points.length
--      옵션(vendor_item_id) 규칙은 _price.sameVendorRows 와 같다:
--        ① 우리 옵션 행이 있으면 그것만 센다
--        ② 없는데 다른 옵션 행이 있으면 0
--        ③ 아무 행에도 옵션 표시가 없으면 전부 센다
--
--   ★ 여기 규칙이 페이지와 다르면 «사이트맵에 올렸는데 noindex» 인 URL 이
--     생긴다(Search Console 경고). 한쪽을 고치면 다른 쪽도 고친다.
--
-- ── 왜 jsonb 하나로 돌려주나 ──────────────────────────────────────
--
--   PostgREST 는 행 집합 결과를 1,000행에서 자른다(db-max-rows). 페이지를
--   나눠 받으면 함수가 페이지마다 다시 돈다. 배열 하나(한 행)로 돌려주면
--   한 번 계산하고 한 번 받는다. 범위(p_id_from ~ p_id_to)는 사이트맵 파일
--   하나에 해당하므로 결과 크기도 파일 하나로 묶인다.

create or replace function public.seo_sitemap_products(
  p_id_from       bigint,
  p_id_to         bigint,
  p_min_days      integer default 7,
  p_max_age_days  numeric default 10
)
returns jsonb
language sql
stable
security invoker
set search_path = public
set statement_timeout = '20s'
as $$
  with cand as (
    select p.id,
           p.product_id,
           p.mall,
           p.collected_at,
           nullif(btrim(coalesce(p.vendor_item_id, '')), '') as vid
      from public.products p
     where p.id >= p_id_from
       and p.id <  p_id_to
       and p.mall in ('쿠팡', 'ADPICK')
       -- 렌탈 월 요금·명목가(1원 등)는 구매 가격이 아니다 — api/_seo.js isNonPurchaseListing
       and p.lprice >= 100
       and coalesce(p.title, '') !~ '(렌탈|구독)'
       and p.collected_at >= now() - make_interval(secs => (coalesce(p_max_age_days, 10) * 86400)::double precision)
       and p.link ~* '^https?://'
       and p.product_id ~* '^[0-9a-f]{1,64}$'
  ),
  obs as (
    select c.id,
           coalesce((h.recorded_at at time zone 'Asia/Seoul')::date,
                    left(h.recorded_date::text, 10)::date) as d,
           nullif(btrim(coalesce(h.vendor_item_id, '')), '') as hv
      from cand c
      join public.price_history h
        on h.product_id = c.product_id
       and h.mall = c.mall
  ),
  per as (
    select c.id,
           c.product_id,
           c.collected_at,
           c.vid,
           count(distinct o.d)                                   as all_days,
           count(distinct o.d) filter (where o.hv = c.vid)       as mine_days,
           count(*)            filter (where o.hv = c.vid)       as mine_rows,
           coalesce(bool_or(o.hv is not null and o.hv <> '__LEGACY__'), false) as attributed
      from cand c
      join obs o on o.id = c.id
     group by c.id, c.product_id, c.collected_at, c.vid
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_array(product_id, to_char(collected_at at time zone 'Asia/Seoul', 'YYYY-MM-DD'))
             order by id),
           '[]'::jsonb)
    from per
   where (case
            when vid is null   then all_days
            when mine_rows > 0 then mine_days
            when attributed    then 0
            else all_days
          end) >= greatest(coalesce(p_min_days, 7), 1)
$$;

revoke execute on function public.seo_sitemap_products(bigint, bigint, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.seo_sitemap_products(bigint, bigint, integer, numeric)
  to service_role;

-- PostgREST 가 새 함수를 바로 보게 한다 (없으면 수 분 뒤에 반영된다).
notify pgrst, 'reload schema';

-- ── 되돌리기 ──────────────────────────────────────────────────────
--   drop function if exists public.seo_sitemap_products(bigint, bigint, integer, numeric);
--   notify pgrst, 'reload schema';
--   (함수만 사라진다. 사이트맵은 자동으로 예전 방식으로 돌아간다.)
