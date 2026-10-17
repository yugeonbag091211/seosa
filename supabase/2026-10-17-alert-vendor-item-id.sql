-- 가격 알림을 정확한 상품 옵션에 묶는다.
-- 기존 웹 알림은 vendor_item_id='' 로 남아 기존 product_id + mall 동작을 유지한다.
-- 새 모바일 알림은 vendor_item_id 를 반드시 저장하고 check-alerts.js 가 exact match 한다.

alter table public.alerts
  add column if not exists vendor_item_id text not null default '';

comment on column public.alerts.vendor_item_id is
  'Exact offer option identity for price alerts. Empty string means legacy product-level alert.';
