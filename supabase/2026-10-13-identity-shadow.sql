-- ============================================================================
--  2026-10-13  Product Identity — Phase 2 Shadow Matching
--
--  Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run.
--  ★ 애플리케이션 배포는 이 파일을 실행하지 않는다 (수동 적용).
--
--  ── 무엇을 만드는가 ──────────────────────────────────────────────────
--
--  Phase 1(api/_offeridentity.js)의 판정 결과를 «관찰만» 하기 위한 표 네 개.
--  운영 화면·검색·AI·수집기는 이 표를 읽지 않는다. 읽기 시작하는 것은
--  Phase 3 이후이고, 그때는 별도 PR 로 한다.
--
--    identity_shadow_runs           한 번의 계산 실행
--    identity_shadow_groups         그 실행이 만든 canonical group 후보
--    identity_shadow_group_members  어떤 products 행이 어느 group 에 들어갔나
--    identity_shadow_reviews        REVIEW 로 남은 쌍 (Phase 4 큐의 재료)
--    identity_shadow_job_state      동시 실행 방지 singleton (hotdeal_job_state 와 같은 꼴)
--
--  ── 안전성 ───────────────────────────────────────────────────────────
--
--  · additive only — CREATE TABLE / CREATE INDEX / COMMENT 뿐이다.
--  · products · price_history 를 읽지도 바꾸지도 않는다 (이 파일 안에서는 언급조차 없다).
--  · 몇 번을 실행해도 안전하다 (if not exists).
--  · 되돌리기는 맨 아래. 운영 표를 건드리지 않으므로 drop 만으로 끝난다.
--
--  ── 왜 products 로 FK 를 걸지 않는가 ─────────────────────────────────
--
--  external_hotdeals 와 같은 판단이다. 카탈로그 도구가 products 행을 재등록·
--  회수하는데, shadow 스냅숏이 그 작업을 막으면 안 된다. 그래서 (product_id, mall)
--  을 값으로만 들고 간다 — 그 행이 나중에 사라져도 그날의 관측 기록은 남는다.
--  run_id 로 거는 FK 는 shadow 표끼리라서 안전하고, 한 run 을 지우면 딸린 행이
--  같이 사라지는 편이 옳다(cascade).
-- ============================================================================


-- ── 1) 실행 ────────────────────────────────────────────────────────────
create table if not exists identity_shadow_runs (
  id                        bigserial   primary key,

  started_at                timestamptz not null default now(),
  finished_at               timestamptz,
  -- running   계산·저장 진행 중
  -- completed 불변식 검증까지 끝나고 모든 행을 저장했다  ★ 이 상태만 «믿을 수 있는» run 이다
  -- partial   일부만 저장되고 중간에 실패했다 (감사용으로 남긴다)
  -- failed    저장 전에 실패했거나 불변식 위반으로 거부했다
  status                    text        not null default 'running',
  error_reason              text        not null default '',

  /*
   * 어떤 matcher 가 만든 결과인가. matcher 가 바뀐 뒤 run 을 비교하려면 반드시 필요하다.
   *   matcher_id      api/_offeridentity.js 의 계약 이름 (offer_identity_v1)
   *   matcher_version git SHA (CI 에서는 GITHUB_SHA, 로컬에서는 git rev-parse HEAD)
   */
  matcher_id                text        not null default '',
  matcher_version           text        not null default '',

  -- 읽어 온 products 의 최신 collected_at. 같은 스냅숏인지 비교할 때 쓴다.
  source_snapshot_at        timestamptz,
  -- {limit, malls, batchSize, dryRun, ...} — 이 run 이 무엇을 대상으로 돌았는지
  scope                     jsonb       not null default '{}'::jsonb,

  source_product_count      integer     not null default 0,
  parsed_offer_count        integer     not null default 0,
  parse_failed_count        integer     not null default 0,
  comparison_count          integer     not null default 0,
  match_pair_count          integer     not null default 0,
  review_pair_count         integer     not null default 0,
  no_match_pair_count       integer     not null default 0,

  group_count               integer     not null default 0,
  stored_group_count        integer     not null default 0,
  cross_merchant_group_count integer    not null default 0,
  same_merchant_group_count integer     not null default 0,
  largest_group_size        integer     not null default 0,
  avg_group_size            numeric(8,3) not null default 0,

  all_pairs_violation_count integer     not null default 0,
  error_count               integer     not null default 0,
  duration_ms               integer     not null default 0,

  -- 몰별 수치 등 자유 형식 요약
  metadata                  jsonb       not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

alter table identity_shadow_runs drop constraint if exists identity_shadow_runs_status_check;
alter table identity_shadow_runs add constraint identity_shadow_runs_status_check
  check (status in ('running', 'completed', 'partial', 'failed'));

/*
 * ★ 동시 실행 방지의 DB 쪽 보루.
 *
 *   status='running' 인 행은 전체에서 하나뿐이다. 워커의 CAS 잠금이 뚫려도
 *   두 번째 run 은 INSERT 에서 막힌다.
 *
 *   ─ 죽은 run 이 영원히 막지 않는가?
 *     워커는 잠금을 회수할 때(TTL 만료) 남아 있는 running run 을 먼저
 *     failed 로 내린다(scripts/run-offer-identity-shadow.js reclaimStaleRuns).
 *     그래서 이 인덱스가 잠기는 상태는 지속되지 않는다.
 */
create unique index if not exists identity_shadow_runs_single_running_idx
  on identity_shadow_runs ((status)) where status = 'running';

create index if not exists identity_shadow_runs_started_idx
  on identity_shadow_runs (started_at desc);
create index if not exists identity_shadow_runs_completed_idx
  on identity_shadow_runs (finished_at desc) where status = 'completed';


-- ── 2) 그룹 ────────────────────────────────────────────────────────────
create table if not exists identity_shadow_groups (
  id              bigserial   primary key,
  run_id          bigint      not null references identity_shadow_runs(id) on delete cascade,

  /*
   * 구성원 집합의 지문(sha256 앞 32자). Phase 1 의 군집 번호는 «입력 순서에 따른
   * 자리» 라서 run 사이에 비교할 수 없다. 같은 상품 묶음이면 run 이 달라도 같은
   * group_key 가 나오게 해야 scripts/compare-identity-shadow-runs.js 가 일한다.
   */
  group_key       text        not null,
  -- 이 그룹을 만든 증거의 최저 등급 (A: GTIN·제조사 모델번호, B: 브랜드+계열+모델+등급)
  confidence_tier text        not null default '',
  member_count    integer     not null default 0,
  merchant_count  integer     not null default 0,

  -- api/_offeridentity.js canonicalIdentity() 결과
  canonical_identity jsonb    not null default '{}'::jsonb,

  -- 감사용 스냅숏. 어떤 운영 코드도 이 값을 읽지 않는다 (Phase 3 이후의 재료).
  lowest_price    integer     not null default 0,
  lowest_mall     text        not null default '',

  -- Phase 4 운영자 검수용 자리. Phase 2 는 UNVERIFIED 로만 쓴다.
  verification_status text    not null default 'UNVERIFIED',
  created_at      timestamptz not null default now(),

  constraint identity_shadow_groups_member_count_check check (member_count >= 2),
  constraint identity_shadow_groups_tier_check check (confidence_tier in ('', 'A', 'B'))
);

-- 한 run 안에서 같은 구성원 집합은 한 번만 저장된다 (재시도가 행을 두 배로 만들지 않는다).
create unique index if not exists identity_shadow_groups_run_key_idx
  on identity_shadow_groups (run_id, group_key);
-- run 사이 비교: 같은 group_key 가 언제 나타났는지.
create index if not exists identity_shadow_groups_key_idx
  on identity_shadow_groups (group_key, run_id desc);
create index if not exists identity_shadow_groups_run_cross_idx
  on identity_shadow_groups (run_id) where merchant_count > 1;


-- ── 3) 그룹 구성원 ─────────────────────────────────────────────────────
create table if not exists identity_shadow_group_members (
  id               bigserial   primary key,
  run_id           bigint      not null references identity_shadow_runs(id) on delete cascade,
  group_id         bigint      not null references identity_shadow_groups(id) on delete cascade,

  -- products 의 logical key. FK 는 일부러 걸지 않는다 (맨 위 주석).
  product_id       text        not null,
  mall             text        not null,
  vendor_item_id   text        not null default '',
  -- matcher 가 쓰는 오퍼 키 (= "mall|product_id")
  offer_key        text        not null,

  decision         text        not null default 'MATCH',
  confidence       numeric(5,4) not null default 0,
  tier             text        not null default '',
  evidence         jsonb       not null default '[]'::jsonb,
  unknown          jsonb       not null default '[]'::jsonb,
  -- parseOffer 결과에서 식별에 쓰인 값만 (brand/model/variant/storage/color/condition…)
  identity_snapshot jsonb      not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),

  constraint identity_shadow_group_members_decision_check check (decision = 'MATCH')
);

/*
 * ★ Invariant A 를 DB 가 지킨다.
 *   한 run 에서 같은 (product_id, mall, vendor_item_id) 는 한 그룹에만 속한다.
 *   워커가 틀려도 두 번째 INSERT 가 거부된다.
 */
create unique index if not exists identity_shadow_group_members_unique_idx
  on identity_shadow_group_members (run_id, product_id, mall, vendor_item_id);

create index if not exists identity_shadow_group_members_group_idx
  on identity_shadow_group_members (group_id);
create index if not exists identity_shadow_group_members_product_idx
  on identity_shadow_group_members (product_id, mall, run_id desc);


-- ── 4) REVIEW 관측 ─────────────────────────────────────────────────────
--
-- Phase 4 의 승인/거절 컬럼은 아직 만들지 않는다. 지금은 «무엇이 애매했는가» 만 남긴다.
create table if not exists identity_shadow_reviews (
  id                     bigserial   primary key,
  run_id                 bigint      not null references identity_shadow_runs(id) on delete cascade,

  -- 항상 offer_key 오름차순으로 저장한다 (A-B 와 B-A 가 두 행이 되지 않게).
  left_offer_key         text        not null,
  left_product_id        text        not null,
  left_mall              text        not null,
  left_vendor_item_id    text        not null default '',

  right_offer_key        text        not null,
  right_product_id       text        not null,
  right_mall             text        not null,
  right_vendor_item_id   text        not null default '',

  decision               text        not null default 'REVIEW',
  confidence             numeric(5,4) not null default 0,
  tier                   text        not null default '',
  evidence               jsonb       not null default '[]'::jsonb,
  unknown                jsonb       not null default '[]'::jsonb,
  conflicts              jsonb       not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),

  constraint identity_shadow_reviews_decision_check check (decision = 'REVIEW'),
  constraint identity_shadow_reviews_order_check check (left_offer_key < right_offer_key)
);

create unique index if not exists identity_shadow_reviews_pair_idx
  on identity_shadow_reviews (run_id, left_offer_key, right_offer_key);
create index if not exists identity_shadow_reviews_run_idx
  on identity_shadow_reviews (run_id);


-- ── 5) 동시 실행 방지 singleton ────────────────────────────────────────
--
-- hotdeal_job_state 와 같은 구조다. 두 실행이 겹치면 한쪽만 CAS 에 성공한다.
create table if not exists identity_shadow_job_state (
  id          int         primary key default 1,
  status      text        not null default 'idle',   -- idle | running
  lock_token  text        not null default '',       -- 지금 잠금을 쥔 실행
  lock_until  timestamptz,                           -- 이 시각이 지나면 회수 가능
  last_run_id bigint,
  last_run_at timestamptz,
  last_result jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  constraint identity_shadow_job_state_singleton check (id = 1)
);

insert into identity_shadow_job_state (id, status) values (1, 'idle')
on conflict (id) do nothing;


-- ── 6) 설명 ────────────────────────────────────────────────────────────
comment on table identity_shadow_runs is
  'Product Identity Phase 2 shadow run. 관찰 전용 — 검색·AI·가격비교·핫딜이 읽지 않는다.';
comment on column identity_shadow_runs.status is
  'completed 만 «검증을 통과하고 전부 저장된» run 이다. partial 은 일부만 저장된 감사 기록.';
comment on column identity_shadow_runs.matcher_version is
  'git SHA. matcher 가 바뀐 뒤 run 끼리 비교하려면 이 값이 필요하다.';
comment on table identity_shadow_groups is
  'Phase 1 matcher 가 만든 canonical group 후보. member_count >= 2 인 것만 저장한다.';
comment on column identity_shadow_groups.group_key is
  '구성원 offer_key 집합의 지문. run 이 달라도 같은 묶음이면 같은 값이다.';
comment on table identity_shadow_group_members is
  '어떤 products 행이 어느 shadow group 에 들어갔나. products 를 수정하지 않는다.';
comment on table identity_shadow_reviews is
  '같은 상품일 수 있지만 모르는 값이 남은 쌍. Phase 4 검수 큐의 재료.';
comment on table identity_shadow_job_state is
  'shadow 워커 전용 singleton 잠금. hotdeal_job_state / price_job_state 와 섞지 않는다.';


-- ── 7) RLS — server-only 표 ────────────────────────────────────────────
--
-- SEOSA 관례: RLS 를 켜고 정책을 만들지 않는다. 정책이 없으면 anon/authenticated 는
-- 어떤 행도 읽거나 쓸 수 없고, 서버의 service_role 만 RLS 를 우회한다.
alter table identity_shadow_runs          enable row level security;
alter table identity_shadow_groups        enable row level security;
alter table identity_shadow_group_members enable row level security;
alter table identity_shadow_reviews       enable row level security;
alter table identity_shadow_job_state     enable row level security;

revoke all on table identity_shadow_runs          from anon, authenticated;
revoke all on table identity_shadow_groups        from anon, authenticated;
revoke all on table identity_shadow_group_members from anon, authenticated;
revoke all on table identity_shadow_reviews       from anon, authenticated;
revoke all on table identity_shadow_job_state     from anon, authenticated;

revoke all on sequence identity_shadow_runs_id_seq          from anon, authenticated;
revoke all on sequence identity_shadow_groups_id_seq        from anon, authenticated;
revoke all on sequence identity_shadow_group_members_id_seq from anon, authenticated;
revoke all on sequence identity_shadow_reviews_id_seq       from anon, authenticated;

notify pgrst, 'reload schema';


-- ── 검증 (읽기 전용) ───────────────────────────────────────────────────
--
-- select id, status, matcher_version, source_product_count, stored_group_count,
--        cross_merchant_group_count, all_pairs_violation_count, duration_ms
--   from identity_shadow_runs order by started_at desc limit 10;
--
-- select count(*) from identity_shadow_runs where status = 'running';   -- 0 또는 1
--
-- -- Invariant A (같은 상품이 두 그룹에): 0 이어야 한다
-- select run_id, product_id, mall, vendor_item_id, count(*)
--   from identity_shadow_group_members
--  group by 1,2,3,4 having count(*) > 1;
--
-- -- 운영 표가 그대로인지 (shadow 는 이 두 표를 건드리지 않는다)
-- select count(*) from products;
-- select count(*) from price_history;


-- ── 보존 정책 (문서) ───────────────────────────────────────────────────
--
-- shadow 결과는 계속 쌓인다. Phase 2 는 자동 삭제를 «구현하지 않는다» —
-- 감사 추적을 잃는 것이 디스크보다 비싸기 때문이다. 운영자가 필요할 때
-- 최근 30 run 만 남기고 수동으로 지운다 (group/member/review 는 cascade):
--
--   delete from identity_shadow_runs
--    where id not in (select id from identity_shadow_runs order by started_at desc limit 30);


-- ── 되돌리기 (수동) ────────────────────────────────────────────────────
--
-- 운영 표를 만들지 않았으므로 drop 만으로 끝난다. 그전에
-- IDENTITY_SHADOW_ENABLED 를 끄면 워커가 더 쓰지 않는다.
--
--   drop table if exists identity_shadow_group_members;
--   drop table if exists identity_shadow_reviews;
--   drop table if exists identity_shadow_groups;
--   drop table if exists identity_shadow_runs;
--   drop table if exists identity_shadow_job_state;
--   notify pgrst, 'reload schema';
