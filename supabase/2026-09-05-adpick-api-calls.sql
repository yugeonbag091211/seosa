-- ══════════════════════════════════════════════════════════════════
--  ADPICK 외부 API 호출 계측 (api/_adpick.js 가 기록)
--
--  Supabase 대시보드 > SQL Editor 에서 이 파일만 통째로 한 번 실행하세요.
--
--  ── 왜 필요한가 ────────────────────────────────────────────────
--  2026-09-05, ADPICK 이 HTTP 429 "사용 횟수를 초과하였습니다" 를 돌려줬다.
--  그런데 우리는 "그날 실제로 몇 번 불렀는가" 를 댈 수 없었다. 쿠팡은
--  coupang_api_calls 로 매 호출을 남기지만 ADPICK 에는 그런 테이블이 없어서,
--  GitHub Actions 로그를 사람이 긁어 모아 35회라는 하한값만 세웠다.
--  (Vercel 크론과 사이트 실시간 검색분은 로그가 흩어져 세지 못했다)
--
--  이 테이블은 그 질문에 SQL 한 번으로 답하기 위한 것이다. 수집 전략도,
--  호출 간격도, 재시도도, 캐시 수명도, 서킷 브레이커도 바꾸지 않는다.
--
--  ── 1행 = 실제 외부 요청 1회 ───────────────────────────────────
--  ★ 이 불변식이 이 테이블의 전부다.
--    기록하는 곳은 api/_adpick.js 의 fetch() 시도 지점 단 한 곳이고,
--    그 앞에서 끝난 경로는 절대 행을 만들지 않는다:
--      · 캐시 적중 (adpick_search_cache TTL 안)
--      · 서킷 브레이커가 네트워크 전에 막은 요청
--      · 분당 상한 / 최소 간격에 걸려 포기한 요청
--      · API 키 없음 / 빈 키워드
--    그런 경로까지 세면 "우리가 몇 번 불렀나" 라는 질문의 답이 부풀어서,
--    공급자에게 대는 숫자가 거짓이 된다.
--    external_call 컬럼은 그 불변식을 스키마에 적어 둔 것이다 — 지금은
--    항상 true 이고, 나중에 비호출 진단을 같은 테이블에 남기게 되더라도
--    집계 SQL 이 조용히 오염되지 않도록 자리를 미리 못 박아 둔다.
--
--  ── 비밀값 ─────────────────────────────────────────────────────
--  ADPICK 은 API 키가 URL 경로에 들어간다 (/api/{apikey}/search).
--  그래서 이 테이블에는 URL 을 통째로 저장하지 않는다. operation('search')
--  과 query(검색어)만 남기고, detail 은 api/_adpick.js redact() 를 거친
--  뒤 잘라서 넣는다. Authorization 헤더는 애초에 없다.
--
--  ── 안전성 ─────────────────────────────────────────────────────
--    - create table if not exists / create index if not exists 뿐이다
--    - 기존 테이블을 읽지도 쓰지도 않는다 (products, price_history,
--      adpick_search_cache, coupang_* 전부 무관)
--    - 최상위에 drop / truncate / delete 가 없다
--    - 이름이 adpick_api_calls 하나뿐이라 기존 객체와 겹치지 않는다
--    → 몇 번을 실행해도 안전하다
--
--  ※ 이 파일을 실행하지 않아도 서비스와 수집은 그대로 동작한다.
--    api/_adpick.js 는 테이블이 없으면 계측만 조용히 끄고 진행한다
--    (recordExternalCall 의 permanent-failure 처리).
-- ══════════════════════════════════════════════════════════════════

create table if not exists adpick_api_calls (
  id            bigserial   primary key,
  called_at     timestamptz not null default now(),

  -- 집계 기준일. KST(Asia/Seoul) 로 자른 날짜를 기록 시점에 박아 둔다.
  --
  -- ★ 생성 컬럼(generated always as)으로 만들지 않는다.
  --   `called_at at time zone 'Asia/Seoul'` 은 IMMUTABLE 이 아니라 STABLE 이라
  --   생성 컬럼에 쓸 수 없다 (Postgres 가 거부한다). 애플리케이션이 KST
  --   날짜를 계산해 넣는다 — api/_price.kstToday 와 같은 기준이다.
  kst_date      date        not null,

  operation     text        not null default 'search',  -- search 등
  source        text        not null default '',        -- collect / search / cron / diag …
  query         text        not null default '',        -- 검색어 (비밀값 아님)
  req_limit     int         not null default 0,

  -- 응답이 오지 않은 경우(timeout / network_error)는 0.
  http_status   int         not null default 0,

  -- ok | 403 | 429 | timeout | network_error | invalid_response | other
  --   403 / 429            HTTP 상태 그대로
  --   timeout              AbortController 로 끊은 요청
  --   network_error        fetch 자체가 실패
  --   invalid_response     200 인데 JSON 이 아님
  --   other                그 밖의 HTTP 오류 + HTTP 200 success=false
  --                        (http_status 로 구분한다)
  outcome       text        not null,

  items         int         not null default 0,
  latency_ms    int         not null default 0,

  -- 이 행이 실제 외부 네트워크 요청 1회인가. 위 불변식 주석 참고.
  external_call boolean     not null default true,

  -- 진단용 짧은 문구. redact() 로 API 키를 지운 뒤 잘라 넣는다.
  detail        text        not null default ''
);

create index if not exists adpick_api_calls_called_at_idx
  on adpick_api_calls (called_at desc);

-- "오늘(KST) 몇 회" / "오늘 outcome 별 몇 건" 을 인덱스만으로 답한다.
create index if not exists adpick_api_calls_kst_date_idx
  on adpick_api_calls (kst_date, outcome);

-- "어느 실행이 쿼터를 가장 많이 썼나"
create index if not exists adpick_api_calls_kst_date_source_idx
  on adpick_api_calls (kst_date, source);

notify pgrst, 'reload schema';
