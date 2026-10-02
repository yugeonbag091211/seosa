-- ══════════════════════════════════════════════════════════════════
--  2026-10-02-seo-sitemap.sql  적용 후 확인 (전부 SELECT — 아무것도 바꾸지 않는다)
--
--  Supabase 대시보드 > SQL Editor 에서 «한 블록씩» 실행한다.
--  수집 cron 이 도는 시간(KST 00~08시)을 피하면 V-2·V-3 이 빨리 끝난다.
--
--  ── 기대값의 근거 ────────────────────────────────────────────────
--  2026-10-02 운영 DB 를 읽기 전용으로 전수 조회해 이 함수의 규칙을 JS 로 그대로
--  재현한 값(PR #123 레드팀):
--     총 2,012 개 · 범위별 [1632, 242, 14, 41, 83, 0] (40,000 id 폭, max id 222,632)
--  데이터는 매일 바뀌므로 «정확히 같은 수» 를 기대하지 않는다. 같은 자릿수
--  (대략 1,500~3,000)이고 아래 V-4·V-5 가 0 이면 정상이다. 크게 벗어나면 V-6 을 본다.
-- ══════════════════════════════════════════════════════════════════

-- V-1. 함수가 생겼는가 / 누가 부를 수 있는가 (service_role 만 true 여야 한다)
select p.proname,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'seo_sitemap_products';

-- V-2. 파일 하나(id 0 ~ 40,000)의 계산 시간. 함수의 statement_timeout 은 20초다.
--      Execution Time 이 수 초를 넘으면 api/_seo-pages.js 의 범위 폭을 줄이는 것을 검토한다.
explain (analyze, buffers)
select jsonb_array_length(public.seo_sitemap_products(0, 40000));

-- V-3. 총 개수와 범위(파일)별 개수.
--      범위 수는 api/_seo-pages.js productFileCount 와 같다: ceil((max(id)+1) / 40000).
--      0 인 범위는 사이트맵 인덱스에 오르지 않는다.
with s as (
  select g as shard, e ->> 0 as product_id
    from generate_series(1, (select max(id) from public.products) / 40000 + 1) g,
         jsonb_array_elements(public.seo_sitemap_products((g - 1) * 40000, g * 40000)) e
)
select coalesce(shard::text, '합계') as shard, count(*) as urls
  from s
 group by rollup (shard)
 order by shard nulls last;

-- V-4. 중복 product_id — 0 이어야 한다.
--      /p/{product_id} 주소에는 몰이 없으므로, 같은 product_id 가 두 몰에 있으면 URL 이 겹친다.
with s as (
  select e ->> 0 as product_id
    from generate_series(1, (select max(id) from public.products) / 40000 + 1) g,
         jsonb_array_elements(public.seo_sitemap_products((g - 1) * 40000, g * 40000)) e
)
select count(*) - count(distinct product_id) as duplicate_urls from s;

-- V-5. noindex 조건에 걸리는 상품이 결과에 섞였는가 — 모든 칸이 0 이어야 한다.
--      (상품 페이지 index 규칙: api/_product-page.js isIndexableProduct)
with s as (
  select e ->> 0 as product_id
    from generate_series(1, (select max(id) from public.products) / 40000 + 1) g,
         jsonb_array_elements(public.seo_sitemap_products((g - 1) * 40000, g * 40000)) e
)
select count(*) filter (where p.lprice < 100)                                   as nominal_price,
       count(*) filter (where p.title ~ '(렌탈|구독)')                           as rental,
       count(*) filter (where p.collected_at < now() - interval '10 days')      as stale,
       count(*) filter (where p.link !~* '^https?://')                          as no_link,
       count(*) filter (where p.mall not in ('쿠팡', 'ADPICK'))                   as dead_mall
  from s
  join public.products p on p.product_id = s.product_id;

-- V-6. 옵션(vendor_item_id) 규칙이 실제로 적용되는가.
--      «옵션 구분 없이 세면 7일 이상» 인데 «현재 옵션으로 세면 7일 미만» 이라 빠진 상품 수.
--      0 보다 크면 규칙이 동작하는 것이다 (옵션이 바뀐 상품이 없으면 0 일 수도 있다 —
--      그때는 V-6b 표본이 비어 있다). 이 상품들의 /p/ 페이지는 noindex 여야 한다.
with cand as (
  select p.id, p.product_id, p.mall, nullif(btrim(coalesce(p.vendor_item_id, '')), '') as vid
    from public.products p
   where p.mall in ('쿠팡', 'ADPICK') and p.lprice >= 100 and coalesce(p.title, '') !~ '(렌탈|구독)'
     and p.collected_at >= now() - interval '10 days' and p.link ~* '^https?://'
     and p.product_id ~* '^[0-9a-f]{1,64}$'
),
naive as (
  select c.product_id, c.vid,
         count(distinct coalesce((h.recorded_at at time zone 'Asia/Seoul')::date, left(h.recorded_date::text, 10)::date)) as all_days
    from cand c
    join public.price_history h on h.product_id = c.product_id and h.mall = c.mall
   group by c.product_id, c.vid
  having count(distinct coalesce((h.recorded_at at time zone 'Asia/Seoul')::date, left(h.recorded_date::text, 10)::date)) >= 7
),
s as (
  select e ->> 0 as product_id
    from generate_series(1, (select max(id) from public.products) / 40000 + 1) g,
         jsonb_array_elements(public.seo_sitemap_products((g - 1) * 40000, g * 40000)) e
)
select (select count(*) from naive)                                              as naive_7days,
       (select count(*) from s)                                                  as with_vendor_rule,
       (select count(*) from naive n where not exists (select 1 from s where s.product_id = n.product_id)) as dropped_by_vendor_rule;

-- V-6b. 옵션 규칙으로 빠진 상품 표본 5개 — https://seosa.ai.kr/p/{product_id} 가 noindex 인지 눈으로 확인.
with s as (
  select e ->> 0 as product_id
    from generate_series(1, (select max(id) from public.products) / 40000 + 1) g,
         jsonb_array_elements(public.seo_sitemap_products((g - 1) * 40000, g * 40000)) e
)
select p.product_id, p.vendor_item_id,
       count(distinct coalesce((h.recorded_at at time zone 'Asia/Seoul')::date, left(h.recorded_date::text, 10)::date)) as all_days,
       count(distinct coalesce((h.recorded_at at time zone 'Asia/Seoul')::date, left(h.recorded_date::text, 10)::date))
         filter (where nullif(btrim(coalesce(h.vendor_item_id, '')), '') = nullif(btrim(coalesce(p.vendor_item_id, '')), '')) as current_option_days
  from public.products p
  join public.price_history h on h.product_id = p.product_id and h.mall = p.mall
 where p.mall in ('쿠팡', 'ADPICK') and p.lprice >= 100 and p.collected_at >= now() - interval '10 days'
   and coalesce(p.title, '') !~ '(렌탈|구독)' and p.link ~* '^https?://' and p.product_id ~* '^[0-9a-f]{1,64}$'
   and nullif(btrim(coalesce(p.vendor_item_id, '')), '') is not null
   and not exists (select 1 from s where s.product_id = p.product_id)
 group by p.product_id, p.vendor_item_id
having count(distinct coalesce((h.recorded_at at time zone 'Asia/Seoul')::date, left(h.recorded_date::text, 10)::date)) >= 7
 limit 5;

-- V-7. 결과 표본 5개 — 각 https://seosa.ai.kr/p/{product_id} 가 «index,follow» 인지 눈으로 확인.
select e ->> 0 as product_id, e ->> 1 as lastmod_kst
  from jsonb_array_elements(public.seo_sitemap_products(0, 40000)) e
 limit 5;
