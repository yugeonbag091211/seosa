-- ══════════════════════════════════════════════════════════════════
--  2026-08-16  price_history: 옛 (pid, mall, recorded_date) UNIQUE 제거
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 붙여넣고 Run.
--
--  안전성
--    - DELETE / TRUNCATE / UPDATE 없음. 인덱스 하나만 지운다.
--    - IF EXISTS 로 감싸 몇 번을 실행해도 안전하다.
--    - 사전 확인 (2026-08-16, 운영 Supabase 읽기 전용 진단):
--        price_history 11,829행 중
--        (pid, mall, vid, recorded_date) 중복 0건
--        → 이 인덱스를 지워도 새 UNIQUE 를 위반하는 데이터가 없다.
--
--  ── 무엇이 문제였나 ────────────────────────────────────────────
--
--  2026-08-14 의 2026-08-vendor-identity.sql 은 price_history 의 UNIQUE 를
--  (product_id, mall, recorded_date) 에서
--  (product_id, mall, vendor_item_id, recorded_date) 로 바꾸려 했다.
--  Phase 2 의 DO 블록이 옛 제약을 이름 대신 컬럼 집합으로 찾아 지우는데,
--  pg_constraint 만 봤다. 실제 옛 UNIQUE 는 UNIQUE INDEX (idx_ph_unique) 로
--  만들어져 있어 pg_constraint 에는 없고 pg_index 에만 있었다. 그래서
--  옛 인덱스는 조용히 살아남았고, 지금까지 UNIQUE 가 두 개다.
--
--    idx_ph_unique                              (pid, mall, recorded_date)
--    price_history_pid_mall_vid_date_key        (pid, mall, vid, recorded_date)
--
--  실측 확인 (2026-08-16):
--    임의 pid 로 같은 날 두 개의 다른 vid 를 upsert 시도 →
--    두 번째가 idx_ph_unique 를 어겨 실패.
--      duplicate key value violates unique constraint "idx_ph_unique"
--    → vendor-identity 마이그레이션의 목적(옵션별 독립 이력)이 아직 실현
--      안 된 상태다. api/_shop.js 는
--      onConflict='product_id,mall,vendor_item_id,recorded_date' 로 upsert 하지만,
--      Postgres 는 지정한 대상 제약에서만 DO UPDATE 로 접는다. 다른 UNIQUE 를
--      어기는 INSERT 는 그대로 오류가 되어 배치 전체를 실패시킨다.
--
--  ── 왜 지금 지워도 되나 ────────────────────────────────────────
--
--    products_pid_mall_key   ← 상품 카탈로그의 UNIQUE (RESTORE 로 복원됨)
--    price_history_pid_mall_vid_date_key   ← 이력의 새 UNIQUE
--
--  둘 다 이미 활성이고, api/_shop.js 도 (pid,mall) 을 conflict target 으로
--  쓰도록 같이 고쳤다. 옛 idx_ph_unique 만 남아서 새 모델의 목적을 막고 있다.
-- ══════════════════════════════════════════════════════════════════


-- ── 옛 (pid, mall, recorded_date) UNIQUE INDEX 제거 ─────────────
-- 이름은 idx_ph_unique 로 확인되었다. 다른 환경에서 이름이 다르면
-- 아래 두 번째 블록이 컬럼 집합으로 찾아 지운다.
drop index if exists idx_ph_unique;

-- (이름이 다른 경우를 대비한 안전망 — 있어도 없어도 결과는 같다)
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
notify pgrst, 'reload schema';


-- ── 확인 쿼리 (읽기 전용, 별도 실행) ────────────────────────────
--
--   select indexrelid::regclass, indexdef
--     from pg_indexes
--    where tablename = 'price_history';
--
--   -- 남아 있어야 할 것:
--   --   price_history_pkey                             (id)
--   --   price_history_pid_mall_vid_date_key            (pid, mall, vid, date)
--   --   price_history_vid_idx                          (vid) — 부분 인덱스
--   -- 사라져야 할 것:
--   --   idx_ph_unique                                  (pid, mall, date)
