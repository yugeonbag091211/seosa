-- ══════════════════════════════════════════════════════════════════
--  2026-09-01  price_history.source — 가격 행의 기록 경로를 남긴다
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 붙여넣고 Run.
--
--  ★ 이 파일은 아직 운영에 적용되지 않았다. 적용은 사람이 판단해서 한다.
--    코드는 이 컬럼이 없어도 정상 동작한다 (아래 "배포 순서" 참고).
--
--  ══════════════════════════════════════════════════════════════════
--  왜 필요한가
--  ══════════════════════════════════════════════════════════════════
--
--  price_history 에 가격을 쓰는 경로는 하나가 아니다. 전부
--  api/_shop.js recordPrices() 한 곳을 지나지만, 그 위의 호출부는 다섯 가지다.
--
--    scripts/collect-all-prices.js   GitHub Actions 일일 수집기   'collect'
--    api/cron.js                     Vercel cron (KST 03:00)      'cron'
--    api/search.js                   사용자 검색                   'search'
--    api/ai.js                       AI 추천                       'ai'
--    scripts/import-history.js       수동 임포트                   'import'
--
--  Daily Price Collection Report 의 "수집 성공률" 은 이 중 collect 만 세어야
--  한다. 그런데 지금은 행에 출처가 없어서, 사용자가 검색한 상품까지 수집기의
--  성과로 세어진다. 실측(2026-09-01 KST): 그날 오늘 가격을 가진 쿠팡 상품
--  740개 중 9개는 Vercel cron 이 KST 03:11 에 쓴 것이었다.
--
--  ══════════════════════════════════════════════════════════════════
--  ★ 이 컬럼만으로는 출처 추적이 완전하지 않다 (반드시 읽을 것)
--  ══════════════════════════════════════════════════════════════════
--
--  활성 UNIQUE 는 (product_id, mall, vendor_item_id, recorded_date) 이고
--  모든 쓰기가 그 키로 UPSERT 한다. 그래서 같은 상품이 같은 날 두 경로에서
--  기록되면 **나중 쓰기가 앞 행을 덮는다**. source 도 함께 덮인다.
--
--    09:00 사용자 검색  → source='search'
--    21:30 수집기       → source='collect'   (같은 행을 덮음)
--    22:10 사용자 검색  → source='search'    (수집기 흔적이 사라짐)
--
--  실측: 2026-09-01 수집기 두 실행이 767행을 upsert 했는데 그 시간대에 남은
--  행은 731개다 — 36행이 같은 날 재수집으로 덮였다.
--
--  따라서 이 컬럼의 의미는 정확히 이것이다:
--
--    source = "이 행을 **마지막으로** 기록한 경로"
--
--  "수집기가 오늘 이 상품을 확보했는가" 의 근거로 쓰면 안 된다. 그 질문의
--  근거는 price_job_state.last_result.malls[몰].collectorCovered 다
--  (수집기가 자기가 덮은 상품을 직접 누적 기록한다. 마이그레이션 없음).
--
--  source 를 UNIQUE 에 넣으면 경로별로 행이 갈라져 정확해지지만,
--    · 한 상품이 하루에 여러 행을 갖게 되어 "하루 한 관측" 을 전제한
--      loadPrevObservations / api/history.js / _pricestat.js / _trust.js /
--      check-alerts.js 가 전부 영향을 받는다
--    · legacy UNIQUE (mall, product_id, recorded_date) 가 아직 살아 있을
--      가능성이 있다 (2026-08-27-price-history-integrity-final.sql 의 A 블록이
--      적용됐다는 증거가 없다). 그게 살아 있으면 source 를 키에 넣어도
--      같은 날 2행째가 그 제약에 막힌다.
--  그래서 UNIQUE 는 건드리지 않는다.
--
--  ══════════════════════════════════════════════════════════════════
--  기존 행을 어떻게 둘 것인가 — NULL
--  ══════════════════════════════════════════════════════════════════
--
--  기존 행에는 출처 정보가 존재하지 않는다. 시각으로 추정해 collect/search 로
--  분류하면 그건 사실이 아니라 추측이고, 나중에 아무도 구분할 수 없게 된다.
--
--    NULL      = "이 행이 쓰일 때 출처를 기록하지 않았다" (사실)
--    ''        = 위와 "코드가 출처를 안 넘겼다" 가 섞인다 (구분 불가)
--    'legacy'  = 뜻은 맞지만 기존 20,000여 행 전부 UPDATE 가 필요하다
--
--  그래서 NOT NULL 도 DEFAULT 도 걸지 않는다. 기존 행은 NULL 로 남고,
--  UPDATE 가 한 줄도 나가지 않는다. 새 행은 코드가 항상 값을 채운다.
--
--  (이 테이블의 vendor_item_id / item_id 는 not null default '' 이지만,
--   그 둘은 UNIQUE 키의 일부라 NULL 이면 안 되는 사정이 있었다. source 는
--   키에 들어가지 않으므로 같은 제약을 따를 이유가 없다.)
--
--  ══════════════════════════════════════════════════════════════════
--  안전 장치
--  ══════════════════════════════════════════════════════════════════
--
--   · ADD COLUMN ... (NULL, DEFAULT 없음) 은 PostgreSQL 11+ 에서 메타데이터
--     변경이다. 테이블 재작성도, 행 잠금도 없다.
--   · UPDATE / DELETE / TRUNCATE 없음. 기존 행을 한 줄도 건드리지 않는다.
--   · UNIQUE / PRIMARY KEY / 기존 인덱스를 건드리지 않는다.
--   · 트리거를 추가하지 않는다 (기존 trg_recorded_date 만 남는다).
--   · IF NOT EXISTS 라서 두 번 실행해도 안전하다.
--
--  ══════════════════════════════════════════════════════════════════
--  배포 순서 — 아무 순서나 괜찮다
--  ══════════════════════════════════════════════════════════════════
--
--  api/_shop.js 는 source 컬럼이 없으면 42703(column does not exist)을 보고
--  그 뒤로는 source 를 빼고 보낸다 (mall_label / item_id 와 같은 방식).
--  그래서
--    · 코드 먼저 배포 → 가격 저장 정상, source 는 기록되지 않음
--    · 이 SQL 먼저 실행 → 기존 코드도 정상 (컬럼이 늘어날 뿐)
--  어느 쪽이든 사고가 나지 않는다. 리포트의 collector 성공률은 source 가
--  아니라 price_job_state 를 근거로 하므로 이 SQL 없이도 정확하다.
--
--  ══════════════════════════════════════════════════════════════════
--  ROLLBACK
--  ══════════════════════════════════════════════════════════════════
--
--    drop index if exists idx_ph_source_date;
--    alter table price_history drop column if exists source;
--
--  되돌려도 가격 데이터는 그대로다 (source 는 파생 정보이고 다른 코드가
--  읽지 않는다). 코드는 컬럼이 사라지면 위 폴백으로 다시 빠진다.
-- ══════════════════════════════════════════════════════════════════

alter table price_history
  add column if not exists source text;

comment on column price_history.source is
  '이 행을 마지막으로 기록한 경로: collect | cron | search | ai | import. '
  'NULL 은 source 도입(2026-09-01) 이전 행. 같은 날 다른 경로가 같은 행을 '
  'UPSERT 하면 덮이므로, "수집기가 확보했는가" 의 근거로 쓰지 말 것 '
  '(그 근거는 price_job_state.last_result.malls[몰].collectorCovered).';

-- 출처별 일자 집계용. 행 수가 2만 단위라 일반 CREATE INDEX 로 충분하다
-- (CONCURRENTLY 는 트랜잭션 안에서 못 돈다 — SQL Editor 의 Run 은 한 트랜잭션이다).
create index if not exists idx_ph_source_date
  on price_history (source, recorded_date);

notify pgrst, 'reload schema';

-- ── 적용 후 확인 (SELECT 만) ──────────────────────────────────────
--
--   select source, count(*)
--     from price_history
--    where recorded_at >= now() - interval '2 days'
--    group by source order by 2 desc;
--
--   → 적용 직후에는 전부 NULL 이고, 다음 수집/검색부터 값이 채워진다.
