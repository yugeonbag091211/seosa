-- 정정 되돌리기 (2026-11-15). :'batch_id' 배치의 keyword 를 정정 전 값으로 되돌린다.
-- ★ 승인 후에만. 운영 DB 쓰기다.
--
-- 지금도 빈 keyword 인 행만 되돌린다 — 그 사이 수집기가 새 keyword 를 채운 행은 새 값을 지킨다
-- (그 행까지 되돌리려면 아래 update 의 «and p.keyword = ''» 를 빼고 다시 승인을 받는다).

begin;

update public.products p
   set keyword = q.old_keyword
  from public.product_keyword_quarantine q
 where q.batch_id = :'batch_id' and q.restored_at is null
   and p.product_id = q.product_id and p.mall = q.mall and p.keyword = '';

update public.product_keyword_quarantine
   set restored_at = now()
 where batch_id = :'batch_id' and restored_at is null;

select count(*) filter (where restored_at is not null) as restored, count(*) as recorded
  from public.product_keyword_quarantine where batch_id = :'batch_id';

-- 숫자를 확인한 뒤에만:  commit;   (아니면: rollback;)
