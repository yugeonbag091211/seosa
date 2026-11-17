-- 정정 전·후 확인 — 읽기 전용 (2026-11-15). :'batch_id' 는 02-quarantine.sql 과 같은 값.

-- 1. 이번 배치 기록 수 · 되돌린 수
select count(*) as recorded, count(*) filter (where restored_at is not null) as restored
  from public.product_keyword_quarantine where batch_id = :'batch_id';

-- 2. 정정된 행이 지금 빈 keyword 인가 (수집기가 다시 채웠으면 새 keyword 가 보인다 — 정상)
select p.keyword = '' as still_empty, count(*)
  from public.products p join public.product_keyword_quarantine q
    on q.batch_id = :'batch_id' and p.product_id = q.product_id and p.mall = q.mall
 group by 1;

-- 3. 원장(price_history)은 그대로인가 — 정정 전에 같은 질의로 숫자를 적어 두고 비교한다
select count(*) as history_rows_of_batch
  from public.price_history h join public.product_keyword_quarantine q
    on q.batch_id = :'batch_id' and h.product_id = q.product_id and h.mall = q.mall;

-- 4. 키워드별 남은 행 (홈 섹션이 비지 않는가)
select q.old_keyword, count(*) as quarantined,
       (select count(*) from public.products p2 where p2.keyword = q.old_keyword) as remaining
  from public.product_keyword_quarantine q where q.batch_id = :'batch_id'
 group by q.old_keyword order by quarantined desc limit 30;
