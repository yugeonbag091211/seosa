-- products.keyword 오염 정정 — 사람이 승인한 목록만, 되돌릴 수 있게 (2026-11-15).
-- ★ 승인 전에는 실행하지 않는다. 운영 DB 쓰기다.
--
-- 무엇을 하나
--   승인 목록(product_id, mall, keyword)에 있는 행의 products.keyword 를 '' 로 비우고,
--   비우기 전 값을 product_keyword_quarantine 에 batch_id 와 함께 남긴다.
--   행을 지우지 않는다 · price_history 를 건드리지 않는다 · 가격·링크·이미지를 바꾸지 않는다.
--
-- 왜 '' 인가
--   빈 keyword 행은 홈 키워드 섹션(api/init.js roundRobin)에 오르지 않는다. 수집기는 빈 keyword 를
--   상품명에서 만든 검색어로 다시 채운다(scripts/collect-all-prices.js «keyword 가 없던 상품 … 채웠습니다»)
--   — 콜라 행은 «수영복» 대신 자기 상품명에서 나온 검색어를 얻는다.
--
-- 순서 (scripts/db-quality/README.md)
--   1) classify-products.js 가 만든 CSV 를 사람이 검토해 approve=Y 행만 남긴다
--   2) 아래 staging 표에 \copy 로 싣는다
--   3) :'batch_id' 를 정하고 이 파일을 한 트랜잭션으로 실행한다 (기대 건수가 다르면 중단)
--   4) 03-verify.sql 로 확인, 문제가 있으면 04-rollback.sql

begin;

-- 기록 표 (추가 전용)
create table if not exists public.product_keyword_quarantine (
  batch_id     text        not null,
  product_id   text        not null,
  mall         text        not null,
  old_keyword  text        not null,
  reason       text        not null default '',
  quarantined_at timestamptz not null default now(),
  restored_at  timestamptz,
  primary key (batch_id, product_id, mall)
);

-- 승인 목록 (이 세션에서만)
create temp table quarantine_staging (
  product_id text not null,
  mall       text not null,
  keyword    text not null,
  reason     text not null default ''
) on commit drop;
-- \copy quarantine_staging (product_id, mall, keyword, reason) from 'approved.csv' csv header

-- 승인 당시의 keyword 와 지금 값이 같은 행만 바꾼다 (그 사이 수집기가 바꿨으면 건드리지 않는다)
insert into public.product_keyword_quarantine (batch_id, product_id, mall, old_keyword, reason)
select :'batch_id', s.product_id, s.mall, p.keyword, s.reason
  from quarantine_staging s
  join public.products p on p.product_id = s.product_id and p.mall = s.mall and p.keyword = s.keyword
on conflict do nothing;

update public.products p
   set keyword = ''
  from public.product_keyword_quarantine q
 where q.batch_id = :'batch_id' and q.restored_at is null
   and p.product_id = q.product_id and p.mall = q.mall and p.keyword = q.old_keyword;

-- 기대 건수 확인: 기록 수와 바뀐 수가 같아야 한다. 다르면 rollback;
select (select count(*) from public.product_keyword_quarantine where batch_id = :'batch_id') as recorded,
       (select count(*) from public.products p join public.product_keyword_quarantine q
          on q.batch_id = :'batch_id' and p.product_id = q.product_id and p.mall = q.mall
         where p.keyword = '') as emptied;

-- 숫자를 확인한 뒤에만:  commit;   (아니면: rollback;)
