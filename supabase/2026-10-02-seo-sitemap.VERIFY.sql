-- ══════════════════════════════════════════════════════════════════
--  2026-10-02-seo-sitemap.sql  적용 후 확인 (전부 SELECT — 아무것도 바꾸지 않는다)
--
--  Supabase 대시보드 > SQL Editor 에서 한 블록씩 실행한다.
-- ══════════════════════════════════════════════════════════════════

-- V-1. 함수가 생겼는가 / 누가 부를 수 있는가 (service_role 만 true 여야 한다)
select p.proname,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'seo_sitemap_products';

-- V-2. 파일 하나(id 0 ~ 40,000) 계산 시간과 개수.
--      api/_seo-pages.js PRODUCT_ID_RANGE 와 같은 폭이다.
explain (analyze, buffers)
select jsonb_array_length(public.seo_sitemap_products(0, 40000));

-- V-3. 전체 개수 — 2026-10-02 JS 전수 계산(30일 창 기준) 2,044 와 같은 자릿수여야 한다.
--      이 함수는 «전 기간» 관측일을 센다(상품 페이지 규칙과 같다). 그래서 30일 창
--      값보다 같거나 조금 많다.
select sum(jsonb_array_length(public.seo_sitemap_products(g * 40000, (g + 1) * 40000))) as indexable_total
  from generate_series(0, (select max(id) from public.products) / 40000) g;

-- V-4. 표본 5개 — 각 /p/{product_id} 페이지가 «index,follow» 인지 눈으로 확인한다.
select elem ->> 0 as product_id, elem ->> 1 as lastmod
  from jsonb_array_elements(public.seo_sitemap_products(0, 1000000)) elem
 limit 5;
