-- products.keyword 오염 진단 — 읽기 전용 (2026-11-15).
-- 실행 전: SET default_transaction_read_only = on;  (scripts/db-quality/README.md)
--
-- 이 SQL 은 «토큰이 하나도 안 맞는 행» 같은 확실한 경우만 SQL 로 센다. 부속·다른 모델·다른 세대처럼
-- 상품명을 읽어야 하는 판정은 scripts/db-quality/classify-products.js(같은 관문)로 한다.

-- 1. 규모
select mall, count(*) as rows, count(*) filter (where coalesce(keyword, '') = '') as no_keyword,
       count(distinct keyword) as keywords,
       count(*) filter (where collected_at > now() - interval '3 days') as live_3d
  from products group by mall order by mall;

-- 2. 키워드 낱말이 상품명에 하나도 없는 행 (옛 _shop.matchesKeyword 하한과 같은 뜻: 2글자 이상 낱말 기준)
with kw as (
  select product_id, mall, keyword, title, collected_at,
         regexp_split_to_array(lower(regexp_replace(keyword, '[^0-9A-Za-z가-힣 ]', ' ', 'g')), '\s+') as words,
         lower(regexp_replace(title, '[^0-9A-Za-z가-힣]', '', 'g')) as flat_title
    from products where coalesce(keyword, '') <> '' and keyword not like '\_\_%'
)
select count(*) as no_word_rows,
       count(*) filter (where collected_at > now() - interval '3 days') as no_word_live_3d
  from kw
 where not exists (select 1 from unnest(words) w where length(w) >= 2 and position(w in flat_title) > 0);

-- 3. 그 행이 몰린 키워드 상위 30
with kw as (
  select keyword, title, regexp_split_to_array(lower(regexp_replace(keyword, '[^0-9A-Za-z가-힣 ]', ' ', 'g')), '\s+') as words,
         lower(regexp_replace(title, '[^0-9A-Za-z가-힣]', '', 'g')) as flat_title
    from products where coalesce(keyword, '') <> '' and keyword not like '\_\_%'
)
select keyword, count(*) as no_word_rows
  from kw
 where not exists (select 1 from unnest(words) w where length(w) >= 2 and position(w in flat_title) > 0)
 group by keyword order by no_word_rows desc limit 30;

-- 4. 같은 상품이 오늘도 수집되고 있는가 (수집기가 틀린 분류를 «살려 두는» 규모 — 문제 E)
with kw as (
  select product_id, mall, keyword, title, regexp_split_to_array(lower(regexp_replace(keyword, '[^0-9A-Za-z가-힣 ]', ' ', 'g')), '\s+') as words,
         lower(regexp_replace(title, '[^0-9A-Za-z가-힣]', '', 'g')) as flat_title
    from products where coalesce(keyword, '') <> '' and keyword not like '\_\_%'
), bad as (
  select product_id, mall from kw
   where not exists (select 1 from unnest(words) w where length(w) >= 2 and position(w in flat_title) > 0)
)
select count(distinct (h.product_id, h.mall)) as bad_rows_with_price_today
  from price_history h join bad b on b.product_id = h.product_id and b.mall = h.mall
 where h.recorded_at >= now() - interval '1 day';
