-- ══════════════════════════════════════════════════════════════════
--  2026-08-16  price_history: idx_ph_unique 롤백 복원
--
--  왜 이 파일이 존재하나
--    같은 날 앞서 실행한 2026-08-16-price-history-drop-legacy-unique.sql
--    이 idx_ph_unique (product_id, mall, recorded_date) UNIQUE 인덱스를
--    지웠다. 그러나 프로덕션에 배포된 api/_shop.js 의 price_history
--    upsert 는 여전히 onConflict='product_id,mall,recorded_date' 를
--    쓴다 (origin/main 기준). 대응하는 UNIQUE 가 없어졌으니 Postgres 가
--      42P10  there is no unique or exclusion constraint matching
--             the ON CONFLICT specification
--    로 거부한다 → 모든 가격 기록 저장이 실패한다 (search / cron / GH Actions
--    수집기).
--
--  이 파일은 그 UNIQUE 를 복원한다. 데이터 손실 없음.
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 붙여넣고 Run.
--
--  안전성
--    - DELETE / TRUNCATE / UPDATE 없음.
--    - IF NOT EXISTS 로 감싸 몇 번을 실행해도 안전하다.
--    - 사전 확인 (2026-08-16 진단, 읽기 전용):
--        price_history 11,829행 중
--        (product_id, mall, recorded_date) 중복 0건
--        → UNIQUE 를 다시 만들어도 위반 없다.
--    - 새 UNIQUE `price_history_pid_mall_vid_date_key` (pid,mall,vid,date)
--      는 그대로 유지된다. 두 UNIQUE 가 다시 공존한다 — 이건 마이그레이션
--      이전(=수 년간 안정적으로 돌던) 상태로 정확히 되돌리는 것이다.
--
--  ── 이후 계획 (이 파일과 무관) ──────────────────────────────────
--    옵션별 다중 vid 이력 기능(같은 (pid,mall,date) 에 vid 두 개 이상 저장)
--    을 실제로 켜려면 다음이 함께 배포돼야 한다:
--      1) api/_shop.js 를 vid 기반 onConflict 로 전환한 버전
--         (해당 코드가 참조하는 _search.js 등 관련 WIP 모듈 포함)
--      2) 이 파일의 반대 마이그레이션 (다시 idx_ph_unique 를 지우는 것)
--    한 트랜잭션처럼 묶어 진행해야 프로덕션이 다시 깨지지 않는다.
-- ══════════════════════════════════════════════════════════════════


-- ── 옛 (pid, mall, recorded_date) UNIQUE INDEX 복원 ─────────────
create unique index if not exists idx_ph_unique
  on price_history (product_id, mall, recorded_date);


-- ── PostgREST 스키마 캐시 갱신 ──────────────────────────────────
-- 이걸 안 하면 supabase API 층이 옛 스키마 캐시를 붙들고 있어서
-- 방금 만든 UNIQUE 를 onConflict 대상으로 잠시 인식하지 못한다.
notify pgrst, 'reload schema';


-- ── 확인 쿼리 (읽기 전용, 별도 실행) ────────────────────────────
--
--   select indexname, indexdef
--     from pg_indexes
--    where tablename = 'price_history'
--    order by indexname;
--
--   -- 있어야 할 것 (총 3~4개):
--   --   idx_ph_unique                                (pid, mall, date)     ← 방금 복원
--   --   price_history_pid_mall_vid_date_key          (pid, mall, vid, date)
--   --   price_history_pkey                           (id)
--   --   price_history_vid_idx                        (vid) — 부분 인덱스
