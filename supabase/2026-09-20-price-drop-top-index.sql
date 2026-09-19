-- ══════════════════════════════════════════════════════════════════
--  2026-09-20  price_drop_top 이 자주 타임아웃한다 — 인덱스 하나를 더한다
--
--  ★ 데이터를 바꾸지 않는다. CREATE INDEX IF NOT EXISTS 두 줄뿐이다.
--    뷰도, 테이블도, 어떤 행도 건드리지 않는다. 여러 번 실행해도 안전하다.
-- ══════════════════════════════════════════════════════════════════

-- ── 증상 (2026-09-20 운영 실측, 읽기 전용) ────────────────────────
--
--  /api/init 이 홈 첫 화면마다 던지는 바로 그 질의
--
--      select <11 columns> from price_drop_top
--       order by drop_pct desc limit 200
--
--  를 연달아 돌린 결과 (같은 세션, 같은 질의):
--
--      1회차  2,552 ms   200행
--      2회차  8,644 ms   canceling statement due to statement timeout
--      3회차  8,658 ms   canceling statement due to statement timeout
--      (다른 시도)  8,641 ms 타임아웃 → 3,587 ms → 1,637 ms
--
--  즉 성공하는 날과 실패하는 날이 섞인다. 실패하면 화면에는 «오늘 하락한
--  상품이 없어요» 처럼 보인다 — 장애가 «데이터 없음» 으로 둔갑한다.
--  (오류를 삼키던 문제 자체는 api/init.js 에서 따로 고쳤다. 이 파일은
--   «왜 느린가» 쪽이다.)
--
-- ── 왜 느려졌나 ───────────────────────────────────────────────────
--
--  2026-09-18 대량 seed 로 price_history 가 137,301행이 됐다(seed 67,993행).
--  price_drop_top 은 그 위에서 두 가지 무거운 일을 한다.
--
--    ranked : row_number() over (partition by product_id, mall, vendor_item_id
--                                order by recorded_date desc)
--    agg    : group by product_id, mall, vendor_item_id  →  min(price)
--             ★ 여기에는 30일 조건이 없다. 전체 테이블을 훑는다.
--
--  둘 다 «(product_id, mall, vendor_item_id)» 로 묶는데, 지금 있는 인덱스는
--
--    price_history_pid_mall_date_idx  (product_id, mall, recorded_date desc)
--
--  라서 vendor_item_id 가 빠져 있다. 그래서 partition/group 경계를 인덱스로
--  잡지 못하고 매번 정렬·해시를 새로 만든다.
--
-- ── 무엇을 더하는가 ───────────────────────────────────────────────
--
--  뷰가 실제로 쓰는 모양 그대로의 인덱스 하나.
--  기존 인덱스는 그대로 둔다 — /api/history 계열이 (product_id, mall,
--  recorded_date) 로 조회하므로 여전히 쓸모가 있다.
--
--  ★ 적용 시간: price_history 137,301행 기준 수 초 안에 끝난다.
--    그래도 쓰기를 잠깐 막으므로, 가격 수집 cron 이 도는 KST 00~08시는
--    피해서 실행할 것.
--
--  ★ 되돌리기: drop index if exists price_history_pid_mall_vid_date_idx;
--    (인덱스만 사라지고 데이터는 그대로다)

create index if not exists price_history_pid_mall_vid_date_idx
  on price_history (product_id, mall, vendor_item_id, recorded_date desc);

-- agg CTE 의 min(price) 전체 집계를 커버하기 위한 보조 컬럼 포함.
-- (위 인덱스만으로도 group 경계는 잡히지만, price 가 인덱스에 있으면
--  테이블을 다시 읽지 않고 min 을 구할 수 있다 — index-only scan)
create index if not exists price_history_pid_mall_vid_price_idx
  on price_history (product_id, mall, vendor_item_id, price)
  where vendor_item_id <> '__LEGACY__';

-- PostgREST 스키마 캐시 갱신 (인덱스만 바뀌면 필수는 아니지만 관례를 지킨다)
notify pgrst, 'reload schema';

-- ── 적용 뒤 확인 ──────────────────────────────────────────────────
--
--  explain analyze
--  select product_id, mall, mall_label, title, current_price, prev_price,
--         drop_amount, drop_pct, is_all_time_low, link, image
--    from price_drop_top
--   order by drop_pct desc
--   limit 200;
--
--  기대: Seq Scan on price_history 가 Index Scan 으로 바뀌고,
--        총 실행 시간이 statement_timeout 아래로 안정적으로 들어온다.
--        적용 전 실측은 위 «증상» 절의 숫자다 (1.6초 ~ 8.6초 타임아웃).
