-- ══════════════════════════════════════════════════════════════════
--  ★★ 테스트 DB 전용 — 운영에서 실행하지 말 것 ★★
--
--  기존 뷰 price_drop_top 을 통째로 계산해 price_drop_top_fast 와 양방향 EXCEPT ALL 로 대조한다.
--  운영에서는 이 계산이 8초 statement_timeout 을 넘긴다(바로 그 문제를 고치는 PR 이다).
--  운영 확인은 2026-09-25-price-drop-state.VERIFY.sql (표본 · 인덱스 조회만)을 쓴다.
-- ══════════════════════════════════════════════════════════════════

with a as (
  select product_id, mall, title, current_price, prev_price, all_time_low, drop_amount, drop_pct,
         is_all_time_low, link, image, mall_label
    from public.price_drop_top
), d as (
  select product_id, mall, title, current_price, prev_price, all_time_low, drop_amount, drop_pct,
         is_all_time_low, link, image, mall_label
    from public.price_drop_top_fast
)
select (select count(*) from a) as view_rows,
       (select count(*) from d) as fast_rows,
       (select count(*) from (select * from a except all select * from d) x) as view_minus_fast,
       (select count(*) from (select * from d except all select * from a) x) as fast_minus_view;
-- 기대: view_minus_fast = 0, fast_minus_view = 0 (마지막 증분 뒤 새 원장 쓰기가 없을 때).
