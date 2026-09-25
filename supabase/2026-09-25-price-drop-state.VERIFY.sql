-- ══════════════════════════════════════════════════════════════════
--  2026-09-25-price-drop-state.sql 적용 뒤 확인 — 전부 읽기 전용 (SELECT 만)
--
--  ★ §3 은 기존 뷰 price_drop_top 을 한 번 통째로 계산한다(운영에서 8초를 넘기던 그 계산).
--    SQL Editor 에서 가격 수집 시간대(KST 00~09시)를 피해 한 번만 돌릴 것.
-- ══════════════════════════════════════════════════════════════════

-- §1. 객체 · 권한 · 설정
select c.relname, c.relkind, c.relrowsecurity as rls,
       has_table_privilege('anon', c.oid, 'select')          as anon_select,
       has_table_privilege('authenticated', c.oid, 'select') as authenticated_select,
       has_table_privilege('service_role', c.oid, 'select')  as service_select
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('price_drop_state', 'price_drop_state_meta', 'price_drop_top_fast')
 order by c.relname;
-- 기대: 표 둘 rls=true · anon/authenticated false · service true. 뷰는 anon/authenticated false.

select p.proname, p.prosecdef as security_definer, p.proconfig,
       has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'execute')  as service_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'price_drop_state_%'
 order by p.proname;
-- 기대: 3개 · security_definer=false · search_path 고정 · anon/authenticated false.

-- §2. 신선도 (전체 재구성과 증분이 돌았는가)
select m.*, (select count(*) from public.price_drop_state) as state_rows,
       (select count(*) from public.price_drop_top_fast) as fast_rows
  from public.price_drop_state_meta m;

-- §3. 기존 뷰와 전체 결과 대조 (양방향 EXCEPT ALL 이 둘 다 0 이어야 한다)
--   증분 갱신 뒤 새 원장 쓰기가 끼어들면 0 이 아닐 수 있다 — 그때는 증분을 한 번 더
--   돌리고 다시 대조한다. 0 이 아닌 채로 PRICE_DROP_SOURCE=state 를 켜지 않는다.
begin;
set local statement_timeout = '120s';
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
commit;

-- §4. 홈이 실제로 던지는 질의의 계획 (Index Scan using price_drop_state_rank_idx 기대)
explain
select product_id, mall, mall_label, title, current_price, prev_price, drop_amount, drop_pct,
       is_all_time_low, link, image
  from public.price_drop_top_fast
 order by drop_pct desc
 limit 200;
