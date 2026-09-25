-- ══════════════════════════════════════════════════════════════════
--  2026-09-25-price-drop-state.sql 확인 — 운영에서 돌려도 되는 것만
--
--  ★ 기존 뷰 price_drop_top 을 부르지 않는다 (운영에서 8초를 넘기던 그 계산).
--    statement_timeout 도 올리지 않는다. 전부 표본 키 · 인덱스 조회 · 카탈로그 조회다.
--  ★ 아무것도 쓰지 않는다 (price_drop_state_verify 를 p_record => false 로 부른다).
--  ★ 기존 뷰와의 전체 대조는 테스트 DB 전용 파일
--    2026-09-25-price-drop-state.TESTDB-PARITY.sql 에 있다. 운영에서 돌리지 않는다.
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
-- 기대: 9개 · security_definer=false · search_path 고정 · anon/authenticated false.

-- §2. 공개 상태 · 신선도
select published_gen, previous_gen, building_gen, building_cursor, building_done, building_heartbeat,
       needs_rebuild, needs_rebuild_reason, last_recent_at, last_recent_ms, last_recent_products,
       last_publish_at, last_publish->'rows' as published_rows, last_verify_at, last_verify->'ok' as last_verify_ok
  from public.price_drop_state_meta;
-- 기대: published_gen 이 있고 needs_rebuild=false, last_recent_at 이 마지막 수집 뒤.

-- §3. 표본 독립 검증 (기록 없음) — 상위 노출 · 무작위 · 30일 경계 · 최근 원장 기록 키를
--     price_history 에서 그 키의 행만 다시 읽어 최신가 · 직전가 · 전체 최저가 · 하락률 ·
--     누락(missing) · 잉여(extra) · products 조인 중복을 대조한다.
select public.price_drop_state_verify(null, 200, false) as verify;
-- 기대: ok=true, mismatches=0, duplicates=0. pending 은 마지막 증분 뒤 새 기록이라 0 이 아니어도 된다.

-- §4. 특정 상품 하나를 손으로 대조할 때 (값을 바꿔 넣는다)
-- select s.*, (select jsonb_agg(jsonb_build_array(h.recorded_date, h.price) order by h.recorded_date desc)
--                from public.price_history h
--               where h.product_id = s.product_id and h.mall = s.mall and h.vendor_item_id = s.vendor_item_id) as ledger
--   from public.price_drop_state s
--  where s.gen = (select published_gen from public.price_drop_state_meta) and s.product_id = '9584791839';

-- §5. 홈이 던지는 질의의 계획 (EXPLAIN 만 — 실행하지 않는다)
--     기대: Index Scan using price_drop_state_rank_idx, Sort 없음, Limit 200.
explain
select product_id, mall, mall_label, title, current_price, prev_price, drop_amount, drop_pct,
       is_all_time_low, link, image
  from public.price_drop_top_fast
 order by drop_pct desc
 limit 200;

-- §6. 저장공간 (세대가 공개·직전·재구성 중 최대 셋)
select gen, count(*) as rows from public.price_drop_state group by gen order by gen;
select pg_size_pretty(pg_table_size('public.price_drop_state'))   as table_size,
       pg_size_pretty(pg_indexes_size('public.price_drop_state')) as indexes_size,
       pg_size_pretty(pg_total_relation_size('public.price_drop_state')) as total_size;
