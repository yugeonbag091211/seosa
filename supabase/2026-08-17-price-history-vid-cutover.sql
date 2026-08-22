-- ══════════════════════════════════════════════════════════════════
--  2026-08-17  price_history: 옛 (pid, mall, recorded_date) UNIQUE 제거
--                              (vid 기반 UNIQUE 로 최종 컷오버)
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 붙여넣고 Run.
--
--  ★ 반드시 코드 배포가 먼저다 ★
--
--    이 파일은 api/_shop.js 의 onConflict 가
--      product_id,mall,vendor_item_id,recorded_date
--    로 바뀐 뒤에 실행해야 한다. 순서를 뒤집으면 (SQL 먼저) 옛 코드가
--    아직 product_id,mall,recorded_date 를 conflict target 으로 삼는데
--    그 UNIQUE 가 방금 사라져서 Postgres 가
--      42P10  there is no unique or exclusion constraint matching
--             the ON CONFLICT specification
--    로 거부한다. 그러면 search / cron / GH Actions 수집기의 모든
--    가격 쓰기가 통째로 실패한다. 2026-08-14 사고와 같은 원인이다.
--
--    올바른 순서:
--      1) 코드 배포 (Vercel)  →  onConflict 가 vid 기반이 됨
--      2) 수집이 정상 저장되는지 확인 (수동 실행 or 다음 크론)
--      3) 이 SQL 실행  →  옛 UNIQUE 제거, 옵션별 이력이 실제로 분리됨
--      4) 확인 쿼리 (파일 하단)
--
--  안전성
--    - DELETE / TRUNCATE / UPDATE 없음. 인덱스 하나만 지운다.
--    - IF EXISTS 로 감싸 몇 번을 실행해도 안전하다.
--    - 기존 price_history 데이터를 손대지 않는다 (recorded_date, vendor_item_id,
--      price, __LEGACY__ 표식 전부 그대로).
--    - vendor_item_id 컬럼 정의를 바꾸지 않는다 (text not null default '').
--    - products 를 손대지 않는다.
--    - 사전 확인 (2026-08-17, 운영 Supabase 읽기 전용 진단):
--        price_history 12,280 행
--        같은 (pid, mall, vid, recorded_date) 중복 0건
--        → 이 인덱스를 지워도 새 UNIQUE 를 위반하는 데이터가 없다.
--
--  ── 이 파일이 다시 있는 이유 ────────────────────────────────────
--
--  2026-08-16 에 같은 목적의 drop 파일을 한 번 실행했다가, 배포된
--  api/_shop.js 가 아직 옛 conflict target 을 쓰고 있어서 모든 가격 쓰기가
--  실패했다. 즉시 restore 파일을 돌려 옛 UNIQUE 를 되살렸고, 지금까지
--  두 UNIQUE 가 공존한다:
--
--    idx_ph_unique                              (pid, mall, recorded_date)
--    price_history_pid_mall_vid_date_key        (pid, mall, vid, recorded_date)
--
--  Postgres 가 upsert 시 더 좁은 옛 인덱스를 매치해서 옵션이 다른 관측을
--  한 행으로 접어 버렸다. 실측 결과 같은 (pid, mall, date) 에 vid 가 두
--  종류 이상 남은 사례가 0건이었다. 옵션별 독립 이력이라는 새 모델의 목적이
--  실현되지 않고 있었다는 뜻이다.
--
--  이번에는 코드 배포와 이 SQL 을 짝지어 진행하므로 같은 사고가 재발하지
--  않는다. 배포 순서를 지키는 것이 중요하다.
--
--  ── 관련 파일 (변경/실행 금지) ──────────────────────────────────
--    supabase/2026-08-16-price-history-restore-legacy-unique.sql
--      → 롤백 참고용으로 보관. 정상 배포 흐름에서는 실행하지 않는다.
--        이 SQL 이 성공한 뒤에는 restore 를 다시 돌리면 옵션 접기가 다시
--        시작되니 주의.
-- ══════════════════════════════════════════════════════════════════


-- ── 옛 (pid, mall, recorded_date) UNIQUE INDEX 제거 ─────────────
-- 이름은 2026-08-16 restore 파일이 만든 그대로 idx_ph_unique 이다.
drop index if exists idx_ph_unique;

-- (이름이 다른 경우를 대비한 안전망 — 컬럼 집합으로 찾아 지운다.
--  price_history_pid_mall_vid_date_key 는 절대 건드리지 않는다)
do $$
declare
  r record;
begin
  for r in
    select i.indexrelid::regclass::text as name
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'price_history'::regclass
      and i.indisunique
      and not i.indisprimary
      and (
        select array_agg(a.attname::text order by a.attname)
        from pg_attribute a
        where a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      ) = array['mall','product_id','recorded_date']::text[]
      and c.relname <> 'price_history_pid_mall_vid_date_key'
  loop
    raise notice 'price_history: dropping leftover legacy unique index %', r.name;
    execute format('drop index if exists %s', r.name);
  end loop;
end $$;


-- ── PostgREST 스키마 캐시 갱신 ──────────────────────────────────
-- 이걸 안 하면 PostgREST 가 옛 인덱스가 아직 있다고 믿고 onConflict 매칭을
-- 옛 것으로 잡을 수 있다.
notify pgrst, 'reload schema';


-- ── 확인 쿼리 (읽기 전용, 별도 실행) ────────────────────────────
--
--   select indexname, indexdef
--     from pg_indexes
--    where tablename = 'price_history'
--    order by indexname;
--
--   -- 남아 있어야 할 것:
--   --   price_history_pkey                             (id)
--   --   price_history_pid_mall_vid_date_key            (pid, mall, vid, date)
--   --   price_history_vid_idx                          (vid) — 부분 인덱스
--   -- 사라져야 할 것:
--   --   idx_ph_unique                                  (pid, mall, date)
--
--
--   -- 옵션별 독립 이력이 실제로 남기 시작하는지 확인
--   -- (배포 후 첫 수집이 돌고 나서 실행):
--   select product_id, mall, recorded_date, count(distinct vendor_item_id) as vids
--     from price_history
--    where recorded_date >= current_date - interval '2 days'
--      and vendor_item_id not in ('', '__LEGACY__')
--    group by 1, 2, 3
--   having count(distinct vendor_item_id) > 1
--    limit 20;
--   -- 이전에는 0건. 옵션이 두 개 이상 잡히는 상품이 있다면 이제부터 여러 행이 남는다.
