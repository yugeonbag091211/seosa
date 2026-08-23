-- ══════════════════════════════════════════════════════════════════
--  2026-08-13 가격 수집 배치 진행 상태
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 이 파일을 통째로
--    붙여넣고 Run.
--
--  안전성
--    - create table if not exists / insert on conflict do nothing 뿐이다.
--    - drop / truncate / delete / update 가 하나도 없다.
--    - 기존 테이블(products, price_history, coupang_*)을 읽지도 쓰지도 않는다.
--    → 몇 번을 실행해도 안전하다.
--
--  ※ supabase/schema.sql 은 실행하지 마세요 (monthly_curation 을 덮어씁니다).
-- ══════════════════════════════════════════════════════════════════


-- ── 가격 수집 진행 상태 ──────────────────────────────────────────
--
--  왜 DB 에 두는가
--    scripts/collect-all-prices.js 는 GitHub Actions 러너에서 돈다.
--    프로세스가 끝나면 메모리는 사라지므로, 진행 위치를 전역변수에 두면
--    다음 실행이 항상 처음부터 다시 시작한다. 하루 한 바퀴를 여러 번의
--    실행에 걸쳐 이어가려면 상태가 프로세스 밖에 있어야 한다.
--
--  coupang_api_state 와 같은 단일 행(id=1) 패턴을 쓴다.
create table if not exists price_job_state (
  id          int  primary key default 1,

  -- 작업 날짜. ★ 한국시간(Asia/Seoul) 기준이다.
  --
  -- price_history.recorded_date 와 같은 달력이라고 생각하면 안 된다.
  -- recorded_date 는 이 DB 가 recorded_at 의 UTC 날짜로 덮어쓰는 라벨이라
  -- (2026-08-23 실측: 보낸 값이 무시되고 15,155행 전부가 UTC 날짜),
  -- KST 새벽에 도는 수집분은 하루 이른 라벨을 단다.
  --
  -- 여기 job_date 는 "오늘 한 바퀴 돌았는가"만 판정하는 값이고, 운영자가
  -- 보는 날짜와 맞아야 하므로 KST 가 옳다. 두 값을 직접 비교하지 말 것 —
  -- 코드에서 "KST 로 며칠 관측분인가" 는 recorded_at 으로만 판정한다
  -- (api/_price.js 의 observedKstDate / kstDayStartUtc).
  job_date    date not null,

  -- 마지막으로 처리를 끝낸 검색어 그룹. 다음 실행은 이 값보다 큰
  -- 검색어부터 이어서 처리한다 (문자열 오름차순).
  --
  -- 숫자 offset 이 아니라 커서를 쓰는 이유: products 에 행이 추가·삭제되면
  -- offset 20/40 은 통째로 밀려서 어떤 상품은 건너뛰고 어떤 상품은 두 번
  -- 처리된다. 커서는 목록이 변해도 "이 검색어 다음"이 항상 정확하다.
  cursor_key  text not null default '',

  -- 오늘 처리한 상품 수 / 오늘 대상 총 상품 수 (진행률 표시용)
  processed   int  not null default 0,
  total       int  not null default 0,

  -- running   — 오늘 작업 진행 중
  -- completed — 오늘 마지막 상품까지 끝냄. 같은 날 다시 실행돼도 아무것도 하지 않는다.
  status      text not null default 'running',

  last_run_at timestamptz,

  -- 마지막 실행 요약 { batches, recorded, saved, failedKeywords: [...] }
  last_result jsonb not null default '{}'::jsonb,

  updated_at  timestamptz not null default now()
);

-- 단일 행을 미리 만들어 둔다. job_date 는 아무 값이나 넣어도 첫 실행이
-- KST 오늘로 갈아끼운다(날짜가 다르면 리셋하는 로직).
insert into price_job_state (id, job_date, status)
values (1, '1970-01-01', 'completed')
on conflict (id) do nothing;

-- 서버(service_role)만 만진다.
alter table price_job_state enable row level security;


-- ── PostgREST 스키마 캐시 갱신 ───────────────────────────────────
--  이걸 빠뜨리면 방금 만든 테이블을 한동안 못 찾는다.
notify pgrst, 'reload schema';


-- ── 확인 (읽기 전용) ─────────────────────────────────────────────
--
--   select * from price_job_state;
--   → 1행이 보이면 정상
--
--  진행 상황을 보고 싶을 때
--   select job_date, status, processed, total, cursor_key, last_run_at
--     from price_job_state;
--
--  오늘 작업을 강제로 다시 돌리고 싶을 때 (수동)
--   update price_job_state
--      set status = 'running', cursor_key = '', processed = 0
--    where id = 1;
