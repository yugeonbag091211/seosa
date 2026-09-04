#!/usr/bin/env node
/*
 * GitHub Actions에서 매일 실행 — products 전체 상품 가격 수집
 * node scripts/collect-all-prices.js
 *
 * 수집 전략:
 *   1차) 몰별로 독립 수집 — 쿠팡 / ADPICK 을 각각 키워드 검색으로 훑는다
 *   마지막) 몰별 커버리지 리포트 출력 + 이메일 발송
 *
 * ── 몰별 독립 수집 (2026-08-29) ─────────────────────────────────
 * 예전에는 이 스크립트가 mall === '쿠팡' 인 행만 상대했다. ADPICK
 * (알리·SSG·GS SHOP·Hmall·롯데홈쇼핑 등 제휴몰, api/_adpick.js 로 재조회
 * 가능 — api/_price.js isRefreshableMall 참고)은 "연동 없음"으로 뭉뚱그려
 * 분모에서 통째로 빠졌다. 실측(2026-08-29): products 1,500행 중 ADPICK
 * 282행 전부가 keyword 를 갖고 있는데도 단 한 번도 이 스크립트로 조회되지
 * 않았다 — API 가 없어서가 아니라 이 스크립트가 아예 부르지 않아서였다.
 *
 * 이제 쿠팡·ADPICK을 완전히 독립된 파이프라인으로 돌린다.
 *   - 각자 자기 검색어 그룹·커서·재시도 목록을 갖는다 (price_job_state.last_result.malls)
 *   - 각자 자기 시간 예산을 갖는다 — 한 몰이 차단되거나 예산을 다 써도
 *     남은 몰의 처리 시간을 빼앗지 않는다 (runMallCollection 의 deadlineTs)
 *   - 한 몰의 실패(예외/차단/예산 소진)가 다른 몰의 배치 루프를 멈추지 않는다
 *   - "수집 대상"과 "저장된 상품"을 같은 숫자로 섞지 않는다 — 몰마다
 *     target(대상) / attempted(시도) / success(성공) / saved(저장) / failed(실패)
 *     를 따로 집계해서 리포트·이메일에 그대로 낸다.
 *
 * mall 값이 쿠팡도 ADPICK도 아닌 행(과거 네이버 등 연동이 끊긴 몰)은
 * 여전히 수집 대상이 아니다 — 재조회할 API 자체가 없다. 이름을 숨기지
 * 않고 "기타(연동 없음)"으로 몰별 결과에 그대로 노출한다.
 *
 * ── 쿠팡 호출 정책 ───────────────────────────────────────────
 * 이 스크립트가 쿠팡 이용제한 경고의 주범이었다. 예전 동작:
 *   - 상품 단위 개별 호출 → 상품 수백 개면 분당 수백 회 (공식 한도 50회/분)
 *   - HTTP 429/403은 차단으로 치지 않아서, 제한 응답을 받고도 계속 호출
 *
 * 지금은
 *   - 모든 쿠팡 호출이 api/_coupang.js 한 곳을 지난다 (분당 상한·캐시·차단 감지)
 *   - 쿠팡에는 retry를 걸지 않는다
 *   - 1차 키워드 검색에서만 호출하고, 상품 단위 개별 호출은 없앴다
 *   - 실행당 총 호출 상한(COUPANG_RUN_BUDGET)을 따로 둔다
 *   - ADPICK도 같은 원칙(api/_adpick.js 한 곳만 지남, retry 없음, 실행당 호출 상한)을 따른다
 */

require('./_env');
const supabase = require('../api/_supabase');
const { searchCoupang, isBlocked: isCoupangBlockedGlobal, localStats: coupangLocalStats } = require('../api/_coupang');
const { searchAdpick, isBlocked: isAdpickBlockedGlobal, localStats: adpickLocalStats, hasKey: adpickHasKey } = require('../api/_adpick');
const { recordPrices, searchPhraseFromTitle, adpickProductId } = require('../api/_shop');
/*
 * 검색어 후보 생성 — 규칙과 그 근거(실측 적중률)는 api/_query.js 주석에 있다.
 * 수집 스크립트는 "어떤 검색어를 쓸까"를 직접 정하지 않는다. 규칙이 두 벌로
 * 갈라지면 테스트가 고정하는 규칙과 실제로 도는 규칙이 달라진다.
 */
const { generateSecondPassQueries, buildFacetQueries } = require('../api/_query');
// kstDayStartUtc: KST 하루의 시작을 절대 시각으로 잡는다 (collectedTodayKeys 주석 참고).
const { kstToday, kstDayStartUtc, vendorIdOf } = require('../api/_price');

// 헤더 로그용. price_history.recorded_date / price_job_state.job_date 와 같은 KST 기준.
const TODAY = kstToday();
const CONCURRENCY   = 4;
const PAGE          = 1000;

/*
 * ★ 1회성 시드 모드 (2026-09-01).
 *
 *   목표는 하나뿐이다 — price_history 에 단 한 번도 기록이 없는 상품을
 *   최초 수집 시도 대상으로 삼는다. 이 플래그가 꺼져 있으면(기본값) 정기
 *   수집 동작은 이 커밋 이전과 한 줄도 다르지 않다.
 *
 *   PRICE_SEED_ONLY=1 일 때만 coupangRows/adpickRows 를 "전체 기간 이력이
 *   0건인 상품"으로 좁힌다. 좁힌 뒤에는 기존 runMallCollection 에 그대로
 *   넘긴다 — 회수 패스·CAS 잠금·price_job_state·UPSERT·매칭 규칙은 이
 *   필터의 존재를 전혀 모른다. 21개를 억지로 맞추는 별도 로직은 없다:
 *   검색 결과에 없으면 여느 상품과 똑같이 미수집으로 남는다.
 */
const SEED_ONLY = process.env.PRICE_SEED_ONLY === '1';
const UPSERT_CHUNK  = 200;
/*
 * 키워드당 가져올 상품 수.
 *
 * 50 이었는데, 쿠팡이 이 값을 rCode=400 으로 거부한다. 그래서 이 스크립트는
 * 2026-07-30 이후로 한 행도 저장하지 못하고 있었다 (41회 시도 전부 실패).
 * 같은 시기 cron·search 는 limit=6 이라 멀쩡히 성공했다.
 * 자세한 근거는 api/_coupang.js 의 FETCH_LIMIT 주석 참고.
 *
 * 쿠팡 검색 API 의 limit 상한이 10 이라 키워드당 상위 10개만 훑는다.
 * 커버리지는 낮지만 0건보다는 훨씬 낫다.
 */
const COUPANG_LIMIT = Number(process.env.COUPANG_FETCH_LIMIT) || 10;
/** ADPICK 검색 API limit 상한은 20 (api/_adpick.js ADPICK_MAX_LIMIT). */
const ADPICK_LIMIT  = Number(process.env.ADPICK_FETCH_LIMIT) || 20;

// 배치 실행이라 사용자 대기 시간이 없다. 호출 간격을 넉넉히 벌려
// 라이브 검색(/api/search)이 쓸 몫을 분당 절반 이상 남겨둔다.
const COUPANG_MIN_GAP_MS  = 6000;    // → 이 스크립트만으로는 분당 최대 10회
const COUPANG_MAX_WAIT_MS = 120000;
// ADPICK은 api/_adpick.js 자체 상한(분당 20회, 기본 간격 1초)이 쿠팡보다 느슨하다.
// 이 스크립트는 그보다 더 보수적으로 잡아 라이브 검색(/api/search) 몫을 남긴다.
const ADPICK_MIN_GAP_MS   = Number(process.env.ADPICK_COLLECT_MIN_GAP_MS) || 1500;
const ADPICK_MAX_WAIT_MS  = 60000;
/*
 * 실행당 쿠팡 호출 상한.
 *
 * 2026-08-13 운영 DB 실측:
 *   products 1,479행
 *     ├ 쿠팡    770 (keyword 있음 487 / 제목에서 유도 283, 유도 실패 0)
 *     └ 비쿠팡  709 → 연동이 없어 수집 대상이 아니다
 *   고유 검색어 316종 = 하루 한 바퀴에 필요한 호출 수
 *
 * ★ 예산을 120 → 400 으로 올렸다.
 *   예전에는 이 값이 "한 실행이 얼마나 도는가"를 결정했다(며칠에 걸쳐 한 바퀴).
 *   이제는 배치 루프가 1분 간격으로 페이스를 잡고 진행 위치를 DB 에 남기므로,
 *   속도를 정하는 것은 이 예산이 아니라 BATCH_INTERVAL_MS 다. 예산은
 *   "폭주 시 안전판" 역할만 한다. 316종을 하루에 한 바퀴 돌리려면 316 이상이어야 한다.
 *
 *   호출 속도는 이 값과 무관하게 세 겹으로 막혀 있다:
 *     COUPANG_MIN_GAP_MS(6초)  → 이 스크립트만으로 분당 최대 10회
 *     _coupang.MAX_PER_MIN(20) → 모든 인스턴스 합산 분당 20회
 *     쿠팡 공식 한도            → 분당 50회
 *
 *   ★ 400 → 500 (2026-09-03). 시간이 먼저 멈추게 하기 위해서다.
 *
 *     쿠팡 몫이 42분(COUPANG_BUDGET_MS)이 되면서 한 실행이 쓸 수 있는 호출이
 *     42분 ÷ 6초 = 420회가 됐다. 400 을 그대로 두면 시간이 남았는데도 예산이
 *     먼저 걸려 20회를 버린다. 이 값은 "폭주 시 안전판" 이지 페이스 조절
 *     장치가 아니므로, 정상 실행에서 닿지 않는 자리(500)로 올린다.
 *
 *     ★ 분당 속도는 한 자리도 바뀌지 않는다. 위 세 겹은 그대로다.
 *       달라지는 것은 하루 총량이고, 그 값은 아래와 같다:
 *         현재(1차 패스만)    실측 ~380회/일
 *         목표(1차+회수 패스) 계산 ~1,300회/일
 *       쿠팡 공식 문서의 한도는 분당(검색 50회/분)이고 일일 상한은 공표된 바
 *       없다. 우리 최고 속도는 그 한도의 20%(10회/분)로 변함이 없다.
 */
const COUPANG_RUN_BUDGET  = Number(process.env.COUPANG_RUN_BUDGET) || 500;
/*
 * ── 하루 총량 상한 (2026-09-03 신설) ─────────────────────────────
 *
 * ★ 왜 실행당 예산만으로는 부족한가.
 *
 *   같은 감사에서 cron 칸을 3개 → 8개로 늘렸다(.github/workflows/daily-prices.yml).
 *   실행 횟수가 늘면 "실행당 500회" 는 하루 총량을 더 이상 묶어 주지 못한다.
 *   최악의 경우 8 × 500 = 4,000회가 되는데, 그 값을 아무도 의도한 적이 없다.
 *
 * ★ 2,200 인 근거 (실측 기반 계산).
 *
 *     1차 패스        399회   (고유 검색어 399종)
 *     회수 패스   ~1,330회   (미수집 792개 × 회수 1개당 2.17회 ÷ 회수율 77.8%
 *                            — 미수집 실상품 45개 표본의 실측값)
 *     합계        ~1,730회   ← 90% 도달에 필요한 양
 *     여유          +470회   ← 재시도·부분 실패분
 *
 *   즉 "필요한 만큼 + 여유" 이지 "쓸 수 있는 만큼" 이 아니다.
 *
 * ★ 분당 속도와는 무관하다. 속도는 COUPANG_MIN_GAP_MS(6초, 분당 10회)와
 *   _coupang.MAX_PER_MIN(20), 쿠팡 공식 한도(검색 50회/분)가 정하고 그대로다.
 *   이 값은 하루 총량의 천장일 뿐이다.
 *
 * 오늘 이미 쓴 양은 coupang_api_calls 에서 실행 시작 때 한 번 읽는다
 * (loadCoupangDayUsage). 조회에 실패하면 0 으로 두고 진행한다 — 이 상한
 * 때문에 수집이 멈추는 것이 실패보다 나쁘기 때문이다.
 */
const COUPANG_DAY_BUDGET = Number(process.env.COUPANG_DAY_BUDGET) || 2200;

/** ADPICK 도 같은 안전판. ADPICK 수집 대상 712개 / 검색어 75종(2026-09-03 실측)이라
 *  이 값을 넘길 일이 당분간 없지만, 폭주 방지용으로 똑같이 둔다. */
const ADPICK_RUN_BUDGET   = Number(process.env.ADPICK_RUN_BUDGET) || 400;

/* ── 배치 진행 설정 ────────────────────────────────────────────────
 *
 * 한 배치가 덮는 상품 수와 배치 간격.
 *
 * ★ "상품 20개 = API 호출 20회" 가 아니다.
 *   쿠팡 파트너스에는 상품 단건 조회 API 가 없다. ADPICK 도 마찬가지다.
 *   검색 API 하나뿐이라 검색어로 찾아서 productId 를 맞춰보는 방식이고,
 *   검색 1회가 여러 건을 돌려주므로 여러 상품이 한 번에 덮인다.
 *
 *   2026-08-13 운영 DB 실측(쿠팡, scripts 로 계산):
 *     수집 대상 쿠팡 상품 770개 / 고유 검색어 316종  → 검색어당 평균 2.4개
 *     · product_id 순으로 20개씩 자르면    검색어 평균 17.5종 필요
 *     · 검색어 그룹째로 20개를 채우면      검색어 평균  8종 필요
 *   그래서 아래 루프는 상품이 아니라 "검색어 그룹" 을 단위로 걷는다.
 *   그룹을 배치 경계에서 쪼개지 않으므로 한 배치가 20개를 조금 넘길 수 있다.
 */
const BATCH_PRODUCTS    = Number(process.env.PRICE_BATCH_PRODUCTS) || 20;

/*
 * 배치 사이 대기 (P0-2, 2026-08-31 감사에서 60초 → 15초).
 *
 * ── 왜 60초가 문제였나 ──────────────────────────────────────────
 * 쿠팡 1,401개 / 배치당 20개 ≈ 70배치. 배치 간격 60초면 **대기만 70분**인데
 * 몰별 시간 예산(MALL_BUDGET_MS)은 25분이다. 그래서 한 실행이 25분 안에
 * 도는 배치는 8개 남짓이었고(운영 job_state 실측: batches=8, covered=102),
 * 하루 3회 실행으로도 전량을 못 돌아 일 커버리지가 48.6%에 머물렀다.
 *
 * ── 왜 줄여도 안전한가 ──────────────────────────────────────────
 * 실제 API 호출 속도를 정하는 것은 이 값이 아니라 호출 간격이다.
 *   · 쿠팡  COUPANG_MIN_GAP_MS = 6000  (분당 10회)  ← 그대로 둔다
 *   · 전역  coupang_acquire(max_per_min)             ← 그대로 둔다
 *   · 서킷 브레이커 / 실행당 호출 예산                ← 그대로 둔다
 * 배치 간격은 그 위에 얹힌 **이중 규제**라, 줄여도 분당 호출 수는 변하지
 * 않는다. 줄어드는 것은 "아무 호출도 하지 않고 흘려보내는 시간"뿐이다.
 *
 * rate limit 을 우회하는 변경이 아니다 — 우회할 대상(minGap·전역 카운터)은
 * 손대지 않았고, 이 값을 0 으로 해도 호출은 여전히 6초에 한 번만 나간다.
 */
const BATCH_INTERVAL_MS = Number(process.env.PRICE_BATCH_INTERVAL_MS) || 15000;

/*
 * ── 2차 패스 (P0-1) ────────────────────────────────────────────
 * 1차에서 못 잡은 상품만 좁은 검색어로 다시 찾는다. 자세한 근거는
 * runMallCollection 안의 "2차 패스" 주석 참고.
 *
 *   SECOND_PASS_ENABLED    끄고 싶으면 PRICE_SECOND_PASS=0
 *   SECOND_PASS_MAX_CALLS  이 패스가 쓸 수 있는 최대 호출 수.
 *
 *     ★ 이것은 실행 예산 자체가 아니라 **회수 패스의 하위 상한**이다.
 *       호출 예산 hard stop 은 COUPANG_RUN_BUDGET(400) 이고,
 *       모든 쿠팡 호출이 fetchCoupangAll 을 지나면서 그 검사를 받는다
 *       (1차 processGroup · facet · 회수 라운드 전부 fetchAllFn 경유).
 *
 *     ★ 먼저 걸려야 하는 것은 이 하위 상한이 아니라 **시간**이다.
 *       쿠팡 몫 42분(COUPANG_BUDGET_MS) ÷ 호출 간격 6초
 *         = 실행당 실제 API 호출 420회
 *       canCall() 이 deadlineTs 를 매 호출마다 검사하므로, 시간이 다하면
 *       이 값과 무관하게 회수 패스는 그 자리에서 멈춘다.
 *       (캐시 적중은 간격을 먹지 않으므로 이 계산에서 빠진다)
 *
 *     ── 240 → 420 (2026-09-03) ────────────────────────────────
 *
 *       240 은 "몰당 25분 = 250회" 를 전제로 고른 값이었다. 그 전제가
 *       바뀌었다 — ADPICK_RESERVE_MS 주석 참고. 쿠팡 몫이 42분으로 늘어
 *       한 실행이 시간 안에 낼 수 있는 호출이 42분 ÷ 6초 = 420회가 됐다.
 *
 *       그리고 하루의 **두 번째 이후 실행은 1차 패스가 이미 끝나 있다**
 *       (커서가 끝에 있어 1차는 호출 0회로 지나간다). 즉 그 실행의 시간은
 *       거의 전부 회수 패스 몫인데, 240 이 그 절반을 잘라내고 있었다.
 *
 *         하루 회수 호출 = 실행1(420 - 399 1차) + 이후 실행들
 *           상한 240 →  21 + 240 + 240 + …
 *           상한 420 →  21 + 420 + 420 + …   ← 시간이 상한이 된다
 *
 *       ★ 420 을 넘기지 않는다. 시간이 허용하는 것보다 큰 상한은 안전판
 *         노릇을 못 한다 — 값을 올려도 실제 호출은 늘지 않으면서, 시간
 *         계산이 틀렸을 때 막아 줄 벽만 사라진다.
 *         scripts/test-second-pass.js 가 이 관계(상한 ≤ 시간이 허용하는 호출 수,
 *         상한 < COUPANG_RUN_BUDGET)를 소스에서 직접 계산해 고정한다.
 *
 *       분당 속도는 한 자리도 바뀌지 않는다 — COUPANG_MIN_GAP_MS(6초)와
 *       전역 분당 상한이 그대로 정한다.
 *
 *   SECOND_PASS_TOKENS     (구) 제목에서 뽑을 토큰 수. 검색어 생성이
 *                          api/_query.js 로 옮겨간 뒤로는 쓰이지 않는다.
 *                          지우지 않는 이유는 env 로 값을 넣어 둔 배포가
 *                          있을 수 있어서다 — 읽되 동작에 영향은 없다.
 */
const SECOND_PASS_ENABLED   = process.env.PRICE_SECOND_PASS !== '0';
const SECOND_PASS_MAX_CALLS = Number(process.env.PRICE_SECOND_PASS_MAX_CALLS) || 420;
const SECOND_PASS_TOKENS    = Number(process.env.PRICE_SECOND_PASS_TOKENS) || 5;

/*
 * 상품별 회수 라운드 수 = 상품당 최대 호출 수.
 *
 * api/_query.js 의 MAX_CANDIDATES(9) 와 같은 값이어야 한다. 라운드가 더
 * 적으면 만들어 둔 후보를 못 쓰고, 더 많으면 빈 라운드를 돈다.
 * (scripts/test-round-index.js 가 두 값이 같은지 소스에서 확인한다)
 *
 * ── 3 → 5 로 올린 근거 (2026-08-31 PHASE 10) ──────────────────
 * 실측(n=14, 8검색어 전수): 1라운드 78.6% → 2 85.7% → 3 92.9% → 이후 제자리.
 * 그런데 그 8가지에는 T4(제목 압축)·T7(특수문자 정규화)가 **없었다.**
 * 유일하게 실패한 상품이 하이픈 들어간 모델코드를 가진 것이었는데,
 * 하이픈을 띄운 표기는 한 번도 시도하지 않았다. 그래서 92.9% 는
 * "그 8가지의 상한"이지 검색으로 도달 가능한 상한이 아니다.
 *
 * ★ 4·5라운드(T4·T7)의 효과는 아직 실제 API 로 측정하지 않았다.
 *   측정 전까지 개선폭을 숫자로 주장하지 않는다.
 *
 * ★ "최대 5회"이지 "무조건 5회"가 아니다. 적중한 상품은 uncovered 에서
 *   빠져 다음 라운드 대상에서 제외된다.
 */
const SECOND_PASS_ROUNDS = Number(process.env.PRICE_SECOND_PASS_ROUNDS) || 10;

/*
 * facet 패스 — 큰 그룹을 "검색어 + 구분 토큰"으로 쪼갠다.
 *
 *   FACET_MIN_GROUP    이 수를 넘는 그룹만 대상. 쿠팡 limit 이 10이므로
 *                      10 이하 그룹은 1차 한 번으로 이미 다 덮인다.
 *   FACET_MAX_PER_GROUP  한 실행에서 한 그룹에 쓸 facet 수.
 *   FACET_POOL_PER_GROUP 만들어 둘 후보 수. 여기서 "오늘 이미 부른 것"을 뺀 뒤
 *                      앞에서 MAX 개를 쓴다. 풀이 상한보다 커야 다음 실행이
 *                      다음 토큰으로 이어서 판다 (facet 패스 안의 2026-09-03 주석).
 *   FACET_DRY_STOP     신규 회수 0이 연속 몇 번이면 그 그룹을 끝낼지.
 */
/*
 * 캐시 힌트 패스 — cacheHintQueries 주석 참고.
 *   상품당 최대 몇 개의 옛 검색어를 다시 부를지. 3개면 실측 사례를 전부 덮는다.
 *   끄고 싶으면 PRICE_CACHE_HINT=0.
 */
const CACHE_HINT_ENABLED = process.env.PRICE_CACHE_HINT !== '0';
const CACHE_HINT_MAX_PER_PRODUCT = Number(process.env.PRICE_CACHE_HINT_MAX) || 3;

const FACET_MIN_GROUP     = Number(process.env.PRICE_FACET_MIN_GROUP) || 10;
const FACET_MAX_PER_GROUP  = Number(process.env.PRICE_FACET_MAX_PER_GROUP) || 6;
const FACET_POOL_PER_GROUP = Number(process.env.PRICE_FACET_POOL_PER_GROUP) || 24;
const FACET_DRY_STOP      = Number(process.env.PRICE_FACET_DRY_STOP) || 2;

/*
 * 이 실행이 쓸 수 있는 시간. GitHub Actions 의 timeout-minutes 보다 넉넉히 짧게.
 * 예산을 넘기면 진행 상태를 저장하고 정상 종료한다 — 다음 실행이 이어받는다.
 */
const RUN_TIME_BUDGET_MS = Number(process.env.PRICE_RUN_BUDGET_MS) || 50 * 60 * 1000;

/*
 * ── 몰별 시간 배분 (2026-09-03 감사에서 "절반씩"을 버렸다) ──────────
 *
 * ★ 절반씩 나누는 것이 왜 틀렸나 — 두 몰의 일이 같은 크기가 아니다.
 *
 *   실측 (2026-09-03 운영 DB):
 *     쿠팡    수집 대상 1,548개 / 고유 검색어 399종
 *             호출 간격 6초  → 1차 패스만으로 399 × 6s = 39.9분
 *     ADPICK  수집 대상   712개 / 고유 검색어  75종
 *             호출 간격 1.5초 → 1차 패스 전체가 75 × 1.5s = 1.9분
 *
 *   그런데 예전 배분은 RUN_TIME_BUDGET_MS(50분)의 절반인 25분을 ADPICK 몫으로
 *   묶어 두고 쿠팡에 25분만 줬다. 쿠팡은 **1차 패스조차** 25분 안에 끝낼 수
 *   없고(39.9분 필요), ADPICK 은 2분이면 끝날 일에 25분을 배정받았다.
 *   즉 매 실행마다 23분이 아무 일도 하지 않는 쪽에 묶여 있었다.
 *
 *   (운영 로그도 같은 결론이다 — 2026-09-02T19:14Z 실행은 쿠팡 전용으로
 *    50분을 다 쓰고도 61배치 중 50배치, 1,262/1,548 에서 시간이 끊겼다.)
 *
 * ★ 그래서 "ADPICK 이 실제로 필요한 만큼만" 떼어 두고 나머지를 쿠팡에 준다.
 *
 *   ADPICK_RESERVE_MS 8분 = 1.5초 간격으로 320회. 1차 패스(75회)의 네 배가
 *   넘으므로 회수 패스까지 충분하다. 쿠팡이 이 시각에 멈추므로 ADPICK 은
 *   최소 8분을 보장받고, 쿠팡이 일찍 끝나면 그만큼 더 받는다(예전과 같다).
 *
 * ★ 호출 속도는 이 배분과 무관하다. 간격(COUPANG_MIN_GAP_MS 6초 /
 *   ADPICK_MIN_GAP_MS 1.5초)·전역 분당 상한·서킷 브레이커는 그대로다.
 *   달라지는 것은 "쓰지도 않을 시간을 붙잡고 있는가" 뿐이다.
 */
const ADPICK_RESERVE_MS = Number(process.env.PRICE_ADPICK_RESERVE_MS) || 8 * 60 * 1000;
/** 쿠팡 몫 — 전체에서 ADPICK 예약분을 뺀 나머지. 최소한 절반은 보장한다. */
const COUPANG_BUDGET_MS = Math.max(
  RUN_TIME_BUDGET_MS - ADPICK_RESERVE_MS,
  Math.floor(RUN_TIME_BUDGET_MS / 2)
);

/*
 * 한국시간(Asia/Seoul) 기준 오늘 날짜는 api/_price.kstToday 하나만 쓴다.
 * price_history.recorded_date 도, price_job_state.job_date 도, 여기서 하루
 * 경계를 판정하는 자리도 모두 같은 함수를 거친다 — 예전에는 저장은 UTC 로
 * 하고 판정은 KST 로 해서 하루가 어긋났다.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 로그·이메일에 찍을 "지금" — KST, 분 단위. */
function kstNowStamp() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' KST';
}

// ─── 환경변수 ────────────────────────────────────────────────
const COUP_ACCESS  = process.env.COUPANG_ACCESS_KEY;
const COUP_SECRET  = process.env.COUPANG_SECRET_KEY;

console.log('[환경변수 진단]');
console.log('  COUPANG_ACCESS_KEY :', COUP_ACCESS  ? `설정됨 (${COUP_ACCESS.length}자)` : '❌ 없음');
console.log('  COUPANG_SECRET_KEY :', COUP_SECRET  ? `설정됨 (${COUP_SECRET.length}자)` : '❌ 없음');
console.log('  ADPICK_API_KEY     :', adpickHasKey() ? '설정됨' : '❌ 없음 (ADPICK 수집을 건너뜁니다)');
console.log('  SUPABASE_URL       :', process.env.SUPABASE_URL       ? '설정됨' : '❌ 없음');
console.log('  SUPABASE_SECRET_KEY:', process.env.SUPABASE_SECRET_KEY ? '설정됨' : '❌ 없음');
console.log('  RESEND_API_KEY     :', process.env.RESEND_API_KEY ? '설정됨' : '❌ 없음 (수집 결과 이메일을 보내지 않습니다)');
console.log('');

// ─── 유틸 ────────────────────────────────────────────────────
function isCoupangRow(p) {
  return p.mall === '쿠팡' || (p.link && p.link.includes('coupang'));
}
function isAdpickRow(p) {
  return p.mall === 'ADPICK';
}

/* ── 판매 단위(옵션) 게이트 ─────────────────────────────────────────
 *
 * ★ 무엇이 잘못돼 있었나 (2026-09-03, 운영 데이터로 확인)
 *
 *   쿠팡의 productId 는 "노출 상품" 이고, 실제로 팔리는 단위는 그 아래의
 *   vendorItemId(옵션)다. 한 productId 아래 옵션이 여럿인 경우가 흔하다 —
 *   운영 캐시에 응답이 남아 있는 쿠팡 상품 1,418개 중 632개가 다옵션이었다.
 *
 *   검색 응답은 그때그때 다른 옵션을 대표로 싣는다. 게다가 collapseOptions
 *   가 같은 productId 를 최저가 한 건으로 접는다. 그런데 매칭은
 *   `byId.get(item.productId)` 하나뿐이었다 — 응답 항목의 vendorItemId 를
 *   우리 상품의 vendor_item_id 와 대조하는 곳이 어디에도 없었다.
 *
 *   그래서 우리가 추적하지 않는 옵션의 가격이 그 상품의 오늘 가격이 됐다.
 *
 *   실제 피해(운영 price_history 실측):
 *     vid 이력이 있는 쿠팡 상품 1,876개 중 605개가 두 개 이상의 vid 로
 *     가격이 기록돼 있다. 그중 200개는 최저·최고 격차 50% 이상,
 *     113개는 2배 이상이다. 최악은 productId 6181159723 으로 네 개 옵션에
 *     걸쳐 1,300~30,860원이 한 상품의 이력에 섞여 있다.
 *     같은 상품의 이력인데 날짜 간 비교가 성립하지 않는다.
 *
 * ★ 판정 기준
 *
 *   1순위  응답 vendorItemId === 타겟 vendorItemId  → 같은 판매 단위. 채택.
 *   2순위  vendorItemId 개념이 없는 몰은 product_id 자체가 판매 단위다.
 *          ADPICK 은 commissionlink 해시가 product_id 이므로 여기 해당한다
 *          (운영 737행 전부 vid 없음 — 게이트를 걸면 전멸한다).
 *   3순위  그 외에는 채택하지 않는다. productId 가 같다는 것은 근거가 아니다.
 *
 *   ★ itemId 는 게이트에 넣지 않는다. 근거:
 *     · UNIQUE 가 (product_id, mall, vendor_item_id[, recorded_date]) 다
 *       (supabase/2026-08-vendor-identity.sql:110,151). itemId 는 키가 아니다.
 *     · 캐시 21,762 항목 실측에서 vid→itemId 는 사실상 1:1(예외 11건),
 *       itemId→vid 는 1:다(151건)였다. vid 가 itemId 보다 세밀하다.
 *     · 그 예외 11건은 쿠팡이 **같은 옵션에 itemId 를 새로 발급한** 경우다.
 *       itemId 를 필수로 걸면 이 11건을 근거 없이 거부하게 된다.
 *     itemId 는 계속 기록하되(이력 추적용) 채택 조건으로는 쓰지 않는다.
 *
 * ★ 게이트 비용은 미리 쟀다. 운영 캐시 기준 통과율 98.45%(1,396/1,418).
 *   거부되는 22건은 "우리 옵션이 응답에 아예 없는" 경우이고, 그때 우리는
 *   그 옵션의 오늘 가격을 실제로 모른다. 다른 옵션 값을 대신 쓰는 것은
 *   수집이 아니라 날조다. 캐시는 검색어당 마지막 응답 1건만 남으므로
 *   이 통과율은 하한이다 — 실제 실행은 상품당 여러 검색어를 시도한다.
 *
 * @param {object} target  products 행 (product_id, mall, link, vendor_item_id …)
 * @param {Array}  items   검색 응답 항목 — **반드시 접히지 않은 allItems** 를 넘긴다
 * @returns {{item: object|null, reason: string, options: number, want?: string, got?: string[]}}
 */
function pickOption(target, items) {
  const pid = String((target && target.product_id) != null ? target.product_id : '');
  if (!pid) return { item: null, reason: 'NO_TARGET_ID', options: 0 };

  const cands = (items || []).filter(it => String(it.productId) === pid);
  if (!cands.length) return { item: null, reason: 'NO_PRODUCT_MATCH', options: 0 };

  // vendorItemId 개념이 없는 몰 — product_id 가 곧 판매 단위다.
  if (!isCoupangRow(target)) {
    return { item: cands[0], reason: 'MALL_ID_IS_UNIT', options: cands.length };
  }

  const want = vendorIdOf(target);
  if (!want) return { item: null, reason: 'TARGET_VID_UNKNOWN', options: cands.length };

  const exact = cands.find(it => String(it.vendorItemId || '') === want);
  if (exact) return { item: exact, reason: 'VID_EXACT', options: cands.length, want };

  const got = [...new Set(cands.map(it => String(it.vendorItemId || '')).filter(Boolean))];
  if (!got.length) {
    return { item: null, reason: 'RESPONSE_VID_MISSING', options: cands.length, want, got };
  }
  return { item: null, reason: 'OPTION_MISMATCH', options: cands.length, want, got };
}

// ─── 몰별 API 호출 상태 (쿠팡) ─────────────────────────────
let _coupangBlocked = false;
let _coupangBlockMsg = '';
let _coupangCalls = 0;      // 실제로 나간 호출 수 (캐시 적중은 제외)
let _coupangSkipped = 0;    // 예산/상한/차단으로 건너뛴 횟수
let _coupangBudgetWarned = false;
let _coupangDayUsed = 0;        // 오늘(KST) 이 수집기가 이미 쓴 호출 수
let _coupangDayWarned = false;

/**
 * 오늘(KST) collect 소스로 나간 쿠팡 호출 수를 읽는다. 읽기 전용, 실행당 1회.
 * 실패하면 0 을 준다 — 상한 때문에 수집이 멈추는 것보다 낫다.
 */
async function loadCoupangDayUsage() {
  try {
    const dayStart = kstDayStartUtc(TODAY);
    const dayEnd = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from('coupang_api_calls')
      .select('*', { count: 'exact', head: true })
      .gte('called_at', dayStart).lt('called_at', dayEnd)
      .eq('source', 'collect');
    if (error) throw new Error(error.message);
    _coupangDayUsed = Number(count) || 0;
  } catch (e) {
    _coupangDayUsed = 0;
    console.warn(`[쿠팡] 오늘 호출량 조회 실패(0 으로 두고 진행): ${e.message}`);
  }
  return _coupangDayUsed;
}

/**
 * 쿠팡 검색. api/_coupang.js를 통해서만 나간다.
 *
 * 여기서 직접 fetch/HMAC을 만들면 분당 상한도 차단 감지도 캐시도 전부 우회한다.
 * 절대 retry로 감싸지 말 것.
 *
 * 반환값 { ok, items, reason }.
 *   ok=false 는 "호출이 나가지 못했다"는 뜻이고 재시도 대상이다.
 *   ok=true + items=[] 는 "호출은 성공했는데 결과가 비었다"는 뜻이라
 *   재시도해도 같다. 호출부가 이 둘을 구분해야 차단 때문에 못 받은 상품을
 *   "원래 없는 상품"으로 오해해 영원히 누락시키지 않는다.
 */
async function fetchCoupangAll(keyword, limit = COUPANG_LIMIT) {
  if (!COUP_ACCESS || !COUP_SECRET) return { ok: false, items: [], reason: '쿠팡 키 미설정' };
  if (_coupangBlocked || isCoupangBlockedGlobal()) return { ok: false, items: [], reason: '쿠팡 차단 상태' };

  if (_coupangCalls >= COUPANG_RUN_BUDGET) {
    _coupangSkipped++;
    if (!_coupangBudgetWarned) {
      _coupangBudgetWarned = true;
      console.warn(`\n⚠️  쿠팡 호출 예산 ${COUPANG_RUN_BUDGET}회 소진 — 남은 검색어는 건너뜁니다.\n`);
    }
    return { ok: false, items: [], reason: `실행당 호출 예산 ${COUPANG_RUN_BUDGET}회 소진` };
  }

  // 하루 총량 상한 (COUPANG_DAY_BUDGET 주석 참고). 실행당 상한과 별개의 천장이다.
  if (_coupangDayUsed + _coupangCalls >= COUPANG_DAY_BUDGET) {
    _coupangSkipped++;
    if (!_coupangDayWarned) {
      _coupangDayWarned = true;
      console.warn(`⚠️  쿠팡 하루 호출 예산 ${COUPANG_DAY_BUDGET}회 소진`
        + ` (오늘 앞선 실행 ${_coupangDayUsed}회 + 이번 실행 ${_coupangCalls}회)`
        + ` — 남은 검색어는 내일 이어갑니다.`);
    }
    return { ok: false, items: [], reason: `하루 호출 예산 ${COUPANG_DAY_BUDGET}회 소진` };
  }

  // forceRefresh를 쓰지 않는다. 최근 6시간 안에 받아둔 값이면 그것도 "오늘 가격"이라
  // 하루 한 번 스냅샷을 남기는 이 스크립트에는 충분하고, 그만큼 호출이 줄어든다.
  const r = await searchCoupang(keyword, {
    limit,
    source: 'collect',
    minGapMs: COUPANG_MIN_GAP_MS,
    maxWaitMs: COUPANG_MAX_WAIT_MS
  });

  if (r.from === 'api') _coupangCalls++;
  else if (r.from === 'none') _coupangSkipped++;

  /*
   * 오래된 캐시는 "오늘 가격"이 아니다.
   *
   * 쿠팡이 차단된 동안에도 stale-cache 로 상품이 돌아오기 때문에, 이걸 그대로
   * 쓰면 며칠 전 가격이 매일 오늘 날짜로 price_history 에 쌓인다. 차트는
   * 값이 안 변한 것처럼 평평해지고, 그 위에서 역대 최저가·30일 평균·알림
   * 판정이 전부 잘못 굴러간다. 확인하지 못한 날은 기록을 남기지 않는 게 맞다.
   */
  if (r.from === 'stale-cache') {
    _coupangSkipped++;
    return { ok: false, items: [], reason: '오래된 캐시 — 오늘 가격으로 쓸 수 없음' };
  }

  if (r.blocked && !_coupangBlocked) {
    _coupangBlocked = true;
    _coupangBlockMsg = r.error || '차단';
    console.error(`\n⚠️  쿠팡 API 차단 감지: ${_coupangBlockMsg}`);
    console.error('    → 이번 실행에서는 쿠팡 호출을 멈춥니다.\n');
  }
  if (r.blocked) return { ok: false, items: [], reason: `쿠팡 차단: ${String(r.error || '').slice(0, 60)}` };

  // 호출이 아예 나가지 못한 경우(분당 상한 등)도 재시도 대상이다.
  if (r.from === 'none') {
    return { ok: false, items: [], reason: `호출 생략: ${String(r.error || '분당 상한/대기 초과').slice(0, 60)}` };
  }

  /*
   * ★ items 와 allItems 를 둘 다 넘긴다 (2026-09-03).
   *
   *   api/_coupang.js 의 collapseOptions 는 같은 productId 의 옵션 행을
   *   **최저가 한 건으로 접는다.** 그건 검색 화면에는 옳다 — 사용자에게
   *   같은 상품을 옵션 수만큼 늘어놓을 이유가 없다.
   *
   *   그런데 수집기에는 치명적이다. 우리가 추적하는 옵션이 최저가가
   *   아니면, 매칭이 시작되기도 전에 그 옵션이 사라진다. 그러면 남은
   *   대표 항목(다른 옵션)의 가격이 우리 상품의 오늘 가격으로 들어간다.
   *
   *   그래서 역할을 분리한다.
   *     items     화면·집계용 대표 항목 (collapseOptions 결과, 기존 그대로)
   *     allItems  옵션이 살아 있는 원본 — 매칭은 반드시 이걸 쓴다
   *
   *   searchCoupang 은 원래부터 둘 다 돌려주고 있었다(api/_coupang.js:661).
   *   여기서 allItems 를 버리고 있었을 뿐이다.
   */
  const shape = it => ({
    productId: it.productId,
    title: it.title,
    lprice: it.lprice,
    oprice: it.oprice,
    link: it.link,
    image: it.image,
    mall: '쿠팡',
    itemId: it.itemId || '',
    vendorItemId: it.vendorItemId || '',
  });

  return {
    ok: true,
    reason: '',
    items: r.items.map(shape),
    allItems: (r.allItems && r.allItems.length ? r.allItems : r.items).map(shape)
  };
}

// ─── 몰별 API 호출 상태 (ADPICK) ───────────────────────────
let _adpickBlocked = false;
let _adpickBlockMsg = '';
let _adpickCalls = 0;
let _adpickSkipped = 0;
let _adpickBudgetWarned = false;

/**
 * ADPICK 검색. api/_adpick.js를 통해서만 나간다 — 캐시/분당 상한/서킷
 * 브레이커가 거기 있다. 쿠팡과 마찬가지로 retry로 감싸지 않는다.
 *
 * ADPICK 응답에는 productId 가 없다. commissionlink 를 해시한 값(api/_shop.js
 * adpickProductId, products.product_id 와 같은 규칙)으로 매칭한다.
 */
async function fetchAdpickAll(keyword, limit = ADPICK_LIMIT) {
  if (!adpickHasKey()) return { ok: false, items: [], reason: 'ADPICK 키 미설정' };
  if (_adpickBlocked || isAdpickBlockedGlobal()) return { ok: false, items: [], reason: 'ADPICK 차단 상태' };

  if (_adpickCalls >= ADPICK_RUN_BUDGET) {
    _adpickSkipped++;
    if (!_adpickBudgetWarned) {
      _adpickBudgetWarned = true;
      console.warn(`\n⚠️  ADPICK 호출 예산 ${ADPICK_RUN_BUDGET}회 소진 — 남은 검색어는 건너뜁니다.\n`);
    }
    return { ok: false, items: [], reason: `실행당 호출 예산 ${ADPICK_RUN_BUDGET}회 소진` };
  }

  const r = await searchAdpick(keyword, {
    limit,
    source: 'collect',
    minGapMs: ADPICK_MIN_GAP_MS,
    maxWaitMs: ADPICK_MAX_WAIT_MS
  });

  if (r.from === 'api') _adpickCalls++;
  else if (r.from === 'none') _adpickSkipped++;

  // 쿠팡과 같은 이유 — 오래된 캐시를 "오늘 가격"으로 기록하지 않는다.
  if (r.from === 'stale-cache') {
    _adpickSkipped++;
    return { ok: false, items: [], reason: '오래된 캐시 — 오늘 가격으로 쓸 수 없음' };
  }

  if (r.blocked && !_adpickBlocked) {
    _adpickBlocked = true;
    _adpickBlockMsg = r.error || '차단';
    console.error(`\n⚠️  ADPICK API 차단/오류 감지: ${_adpickBlockMsg}`);
    console.error('    → 이번 실행에서는 ADPICK 호출을 멈춥니다. (쿠팡 수집은 계속됩니다)\n');
  }
  if (r.blocked) return { ok: false, items: [], reason: `ADPICK 차단: ${String(r.error || '').slice(0, 60)}` };

  if (r.from === 'none') {
    return { ok: false, items: [], reason: `호출 생략: ${String(r.error || '분당 상한/대기 초과').slice(0, 60)}` };
  }

  return {
    ok: true,
    reason: '',
    items: r.items.map(it => ({
      productId: adpickProductId(it.commissionlink),
      title: it.title,
      lprice: it.price,
      // ADPICK 응답에는 정가/할인 정보가 없다 — 판매가와 같게 두어 근거 없는
      // 할인율을 만들지 않는다 (api/_shop.js fetchAdpick 과 같은 판단).
      oprice: it.price,
      link: it.commissionlink,
      image: it.photo,
      mall: 'ADPICK',
      itemId: '',
      vendorItemId: '', // ADPICK에는 쿠팡 같은 옵션(vendorItemId) 개념이 없다
    }))
  };
}

// ─── DB 조회 ──────────────────────────────────────────────────
async function fetchAllProducts() {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products')
      /*
       * vendor_item_id / item_id 를 반드시 같이 읽는다 (2026-09-03).
       *
       * 이 두 컬럼이 없으면 수집기는 "우리가 어떤 옵션을 추적하고 있는지"를
       * 모른 채 응답을 채택하게 된다. 실제로 그랬고, 그래서 다른 옵션의
       * 가격이 기록됐다 (pickOption 주석의 실측 참고).
       *
       * 값이 비어 있어도 _price.vendorIdOf 가 link 에서 뽑아내므로 폴백이
       * 있다 — 운영 쿠팡 상품 1,554개 전부에서 vid 확보를 확인했다.
       */
      .select('product_id, mall, title, keyword, link, image, vendor_item_id, item_id')
      .order('product_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error('products 조회 실패: ' + error.message);
    all.push(...(data || []));
    if (!data || data.length < PAGE) return all;
  }
}

/**
 * PRICE_SEED_ONLY 전용 — price_history 에 한 번도 기록되지 않은 (product_id, mall) 을 가려낸다.
 *
 * "이력이 있다"의 판정 기준은 오늘 날짜도 recorded_date 라벨도 아니다. 전체
 * 기간을 통틀어 행이 한 줄이라도 있으면 이력이 있는 것이다 — 그래서
 * collectedTodayKeys 와 달리 KST/UTC 날짜 경계를 고려할 필요가 없다.
 * 페이지네이션은 fetchAllProducts 와 같은 방식(PAGE 단위 range)을 쓴다.
 * 읽기 전용이며, 이 함수의 결과는 시드 모드의 필터에만 쓰인다.
 */
async function fetchEverCollectedKeys() {
  const seen = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('price_history')
      .select('product_id, mall')
      .range(from, from + PAGE - 1);
    if (error) throw new Error('price_history 조회 실패(시드 모드): ' + error.message);
    (data || []).forEach(r => seen.add(`${r.product_id}|${r.mall}`));
    if (!data || data.length < PAGE) return seen;
  }
}

/* ─── 진행 상태 (price_job_state) ─────────────────────────────
 *
 * 프로세스가 끝나도 남아야 하는 값이라 DB 에 둔다. 전역변수에 두면
 * GitHub Actions 러너가 종료되는 순간 사라져서 다음 실행이 늘 1번부터 돈다.
 * 테이블 정의: supabase/2026-08-price-job-state.sql
 *
 * ★ 몰별 독립 상태는 스키마를 바꾸지 않고 기존 last_result(jsonb) 안에
 *   last_result.malls = { "쿠팡": {...}, "ADPICK": {...} } 로 넣는다.
 *   최상위 job_date/status/processed/total/cursor_key 는 하위호환을 위해
 *   계속 "쿠팡" 진행 상태를 그대로 담는다 (scripts/verify-today.js 등
 *   기존 조회가 그대로 동작한다) — 전체 완료 판정만 두 몰을 모두 본다.
 * ------------------------------------------------------------------ */
const STATE_MISSING_HINT =
  'price_job_state 테이블이 없습니다. Supabase SQL Editor 에서 '
  + 'supabase/2026-08-price-job-state.sql 을 한 번 실행하세요.';

async function loadState() {
  const { data, error } = await supabase
    .from('price_job_state')
    .select('job_date, cursor_key, processed, total, status, last_result, last_run_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    // 테이블 자체가 없으면 진행 상태를 이어갈 수 없다. 조용히 처음부터
    // 도는 것이 최악이다(매 실행이 1번부터 → 앞쪽 상품만 반복 수집).
    throw new Error(`${STATE_MISSING_HINT} (원인: ${error.message})`);
  }
  return data || null;
}

async function saveState(patch) {
  const row = { id: 1, ...patch, updated_at: new Date().toISOString() };
  const { error } = await supabase
    .from('price_job_state')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error(`  [상태 저장 실패] ${error.message}`);
  return !error;
}

/* ─── 실행 잠금 (동시 실행 방지) ────────────────────────────────
 *
 * ★ 왜 필요한가 — 실측으로 겹쳤다 (2026-09-01).
 *
 *   GitHub Actions 는 cron 시각을 보장하지 않고 밀린다. 그날
 *     실행 A  2026-08-31T21:19:35Z ~ 22:09:44Z
 *     실행 B  2026-08-31T22:08:19Z ~ 22:21:59Z
 *   두 실행이 85초 겹쳤다. 겹치는 동안 두 프로세스가 같은
 *   price_job_state 를 읽고 쓰므로
 *     · 커서를 서로 되돌려 같은 구간을 두 번 수집하고
 *     · collectorCovered / failedKeywords 가 서로를 덮어쓰며
 *     · 쿠팡 호출 예산을 두 배로 태운다.
 *
 * ★ 마이그레이션 없이 한다 — last_run_at 하나로 compare-and-swap.
 *
 *   PostgREST 의 update ... eq(last_run_at, 읽은값) 은 값이 그대로일 때만
 *   행을 잡는다. 먼저 도착한 쪽이 값을 바꾸면 뒤쪽은 0행을 받는다.
 *   select() 로 실제 갱신된 행 수를 확인해 승패를 가린다.
 *   (컬럼을 새로 만들지 않으므로 배포 순서를 맞출 필요가 없다)
 *
 * ★ 잠금이 영구히 남지 않는다.
 *   프로세스가 죽어 해제를 못 해도 LOCK_TTL_MS 가 지나면 만료로 본다.
 *   TTL 은 한 실행의 최대 시간(RUN_TIME_BUDGET_MS=50분)보다 넉넉히 크고,
 *   cron 최소 간격(UTC 16→18시 = 120분)보다는 작아야 한다. 80분으로 둔다.
 */
const LOCK_TTL_MS = Number(process.env.PRICE_LOCK_TTL_MS) || 80 * 60 * 1000;

/**
 * 잠금을 잡는다.
 * @returns {{ok:true, token:string} | {ok:false, reason:string}}
 */
async function acquireLock(state) {
  const prev = (state && state.last_run_at) || null;
  const lock = (state && state.last_result && state.last_result.lock) || null;

  if (lock && lock.until && Date.parse(lock.until) > Date.now()) {
    const left = Math.round((Date.parse(lock.until) - Date.now()) / 60000);
    return { ok: false, reason: `다른 실행이 진행 중입니다 (${lock.runId || '?'}, 만료까지 ${left}분)` };
  }
  if (lock && lock.until) {
    console.warn(`[잠금] 만료된 잠금을 회수합니다 (이전 실행 ${lock.runId || '?'} 가 정상 종료하지 못했습니다).`);
  }

  const now = new Date();
  const token = `${process.env.GITHUB_RUN_ID || 'local'}-${now.getTime()}`;
  const nextLast = now.toISOString();
  const q = supabase.from('price_job_state').update({
    last_run_at: nextLast,
    last_result: { ...((state && state.last_result) || {}),
      lock: { runId: token, at: nextLast, until: new Date(now.getTime() + LOCK_TTL_MS).toISOString() } }
  }).eq('id', 1);

  // ★ CAS — 우리가 읽은 last_run_at 이 그대로일 때만 잡는다.
  const { data, error } = await (prev === null ? q.is('last_run_at', null) : q.eq('last_run_at', prev)).select('id');
  if (error) return { ok: false, reason: `잠금 획득 실패: ${error.message}` };
  if (!data || data.length === 0) {
    return { ok: false, reason: '다른 실행이 같은 순간에 잠금을 가져갔습니다 (CAS 실패)' };
  }
  return { ok: true, token };
}

/** 잠금을 푼다. 실패해도 TTL 이 만료시키므로 던지지 않는다. */
async function releaseLock(token) {
  if (!token) return;
  try {
    const { data } = await supabase.from('price_job_state')
      .select('last_result').eq('id', 1).maybeSingle();
    const lr = (data && data.last_result) || {};
    if (lr.lock && lr.lock.runId !== token) {
      // 우리 잠금이 아니다(만료 후 남이 가져감). 남의 잠금을 풀지 않는다.
      console.warn('[잠금] 우리 잠금이 아니어서 해제하지 않습니다.');
      return;
    }
    const { lock, ...rest } = lr;   // eslint-disable-line no-unused-vars
    await supabase.from('price_job_state').update({ last_result: rest }).eq('id', 1);
  } catch (e) {
    console.warn(`[잠금] 해제 실패(무시 — TTL 이 만료시킵니다): ${e.message}`);
  }
}

/* ─── 배치 계획 (순수 함수 — 쿠팡/DB 접근 없음) ────────────────
 *
 * 테스트가 이 세 함수만 가지고 배치·커서·완료 판정을 전부 검증한다.
 * (scripts/test-price-batch.js) 몰과 무관한 순수 함수라 몰별로 각각
 * 호출해서 쓴다.
 * ------------------------------------------------------------------ */

/**
 * 검색어 그룹 목록을 만든다. 검색어 문자열 오름차순 — 실행 사이에 순서가
 * 절대 변하지 않아야 커서로 이어받을 수 있다.
 *
 * @param {Array} withKeyword  DB 에 keyword 가 있는 행
 * @param {Map}   derivedGroups 제목에서 유도한 검색어 → 행 목록
 */
function buildPlan(withKeyword, derivedGroups) {
  const groups = new Map();
  const add = (kw, p) => {
    if (!groups.has(kw)) groups.set(kw, []);
    groups.get(kw).push(p);
  };
  withKeyword.forEach(p => add(p.keyword, p));
  derivedGroups.forEach((rows, kw) => rows.forEach(p => add(kw, p)));

  return [...groups.entries()]
    .map(([kw, rows]) => ({ kw, rows }))
    .sort((a, b) => (a.kw < b.kw ? -1 : a.kw > b.kw ? 1 : 0));
}

/** 커서보다 뒤에 있는 그룹만 남긴다. 목록이 변해도 위치가 밀리지 않는다. */
function resumeFrom(plan, cursor) {
  return cursor ? plan.filter(g => g.kw > cursor) : plan;
}

/**
 * 그룹을 배치로 나눈다. 한 배치가 상품 size 개를 채우면 끊는다.
 * 그룹은 경계에서 쪼개지 않는다 — 쪼개면 같은 검색어를 두 배치에서
 * 각각 호출하게 되어 쿠팡 호출이 낭비된다. 그래서 배치가 size 를 조금 넘길 수 있다.
 */
function splitBatches(groups, size = BATCH_PRODUCTS) {
  const batches = [];
  let cur = [], n = 0;
  for (const g of groups) {
    cur.push(g);
    n += g.rows.length;
    if (n >= size) { batches.push(cur); cur = []; n = 0; }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * 몰별 패스 성적을 합친다. 두 몰이 같은 패스 이름을 쓰므로 이름으로 더한다.
 * (몰별 값은 report.malls[] 안에 그대로 남아 있다)
 */
function mergePassStats(results) {
  const by = new Map();
  (results || []).forEach(r => (r.passStats || []).forEach(s => {
    const got = by.get(s.pass) || { pass: s.pass, calls: 0, ok: 0, success: 0, recovered: 0 };
    got.calls += s.calls; got.ok += s.ok; got.success += s.success; got.recovered += s.recovered;
    by.set(s.pass, got);
  }));
  return [...by.values()].sort((a, b) => passOrder(a.pass) - passOrder(b.pass));
}

/** 패스 이름의 실행 순서. 리포트·로그가 항상 같은 순서로 나오게 한다. */
function passOrder(name) {
  if (name === 'pass1') return 0;
  if (name === 'hint') return 1;
  if (name === 'facet') return 2;
  const m = /^r(d+)$/.exec(String(name));
  return m ? 2 + Number(m[1]) : 99;
}

const failureCategoriesTemplate = () => ({
  blocked: 0, budget: 0, staleCache: 0, network: 0,
  noMatch: 0, noKeys: 0, rateLimit: 0, other: 0
});

/**
 * 오늘(KST) 이 몰에서 이미 유효한 가격을 확보한 상품 키 집합.
 *
 * 상품 단위 지표(성공 상품 / 미수집 상품)의 유일한 근거다. price_history 에
 * 오늘 행이 있으면 "오늘 가격을 확보한 상품" 이다 — 그 판정을 실행 안의
 * 카운터로 흉내내지 않고 DB 에 직접 묻는다. 하루에 세 번 도는 잡이라
 * 앞선 실행이 잡은 상품을 뒤 실행이 "미수집" 으로 되돌리면 안 되기 때문이다.
 *
 * 읽기 전용이고, 실패하면 빈 집합을 준다(수집을 막을 이유가 없다).
 *
 * ── ★ 날짜 경계는 recorded_date 라벨이 아니라 recorded_at 으로 잡는다 ──
 *
 *   운영 price_history 에는 트리거 set_recorded_date() 가 걸려 있고, 그 함수가
 *   아직 `NEW.recorded_at::DATE` 다 (KST 로 바꾸는
 *   supabase/2026-08-27-price-history-integrity-final.sql B블록이 미적용).
 *   recorded_at 은 timestamptz 라 ::date 가 세션 TimeZone(UTC)을 따르므로,
 *   우리가 KST 날짜를 보내도 DB 가 UTC 날짜로 덮어쓴다.
 *
 *   이 잡의 cron 은 UTC 16·18·21시(=KST 01·03·06시)라 **수집기가 쓴 행에는
 *   항상 전날 라벨이 붙는다**. 그래서 .eq('recorded_date', kstToday()) 는
 *   자기가 방금 쓴 행을 절대 찾지 못한다.
 *
 *   실측(2026-09-01 KST, 운영 DB):
 *     .eq(recorded_date,'2026-09-01')          → 쿠팡   7행
 *     recorded_at 이 KST 하루 범위             → 쿠팡 747행
 *     → 740행이 통째로 안 보였다.
 *
 *   그 결과 2·3차 실행이 "오늘 이미 기록된 상품" 을 0개로 보고, 오늘 가격
 *   보유 상품이 그 실행 몫으로 축소돼 collectorSuccess > todayPrice 라는
 *   모순(불변조건 위반)이 매일 발생했다.
 *
 *   ★ 같은 버그를 이 저장소가 이미 한 번 겪고 같은 방법으로 고쳤다 —
 *     scripts/check-alerts.js 머리말(2026-08-23) 참고. 라벨이 어느 시간대로
 *     잘리든 결과가 달라지지 않도록 절대 시각으로 자른다.
 *     트리거는 여기서 건드리지 않는다(운영 write 경로 전체가 걸려 있다).
 */
async function collectedTodayKeys(mallName, collectible) {
  const found = new Set();
  // KST 는 서머타임이 없어 하루가 정확히 24시간이다.
  const dayStart = kstDayStartUtc(TODAY);
  const dayEnd = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  try {
    const ids = collectible.map(p => p.product_id);
    for (let i = 0; i < ids.length; i += 400) {
      const { data } = await supabase
        .from('price_history')
        .select('product_id, mall')
        .gte('recorded_at', dayStart)
        .lt('recorded_at', dayEnd)
        .eq('mall', mallName)
        .in('product_id', ids.slice(i, i + 400));
      (data || []).forEach(r => found.add(`${r.product_id}|${r.mall}`));
    }
  } catch (e) {
    console.warn(`  [${mallName}] 오늘 기록 조회 실패(무시하고 진행): ${e.message}`);
  }
  return found;
}

/**
 * 검색 캐시에서 "이 상품을 실제로 돌려줬던 검색어" 를 뽑는다.
 *
 * ── 왜 이게 가장 강한 단서인가 (2026-09-03) ─────────────────────
 *
 *   미수집 상품의 검색어를 새로 지어내는 것보다, **예전에 그 상품을 돌려준
 *   적이 있는 검색어를 다시 부르는 것**이 훨씬 확실하다. 우리가 만든 후보가
 *   아니라 쿠팡 색인이 실제로 답한 기록이기 때문이다.
 *
 *   실측: 미수집 151개 중 13개가 "다른 상품의 검색어" 응답 안에 남아 있었다.
 *     pid 9574923427 (ASUS TUF F16)  ← "에이수스 비보북 코어Ultra5 인텔 14세대"
 *     pid 9483527655 (LG 그램 Pro 16) ← "LG 그램 화이트 WIN11 Pro"
 *     pid 9709957210 (존바바토스)     ← "존바바토스 뚜왈렛 아티산"
 *   어느 것도 그 상품의 후보 사다리에서는 나올 수 없는 문구다.
 *
 * ★ 캐시에 있는 **가격을 쓰지 않는다.** 검색어만 가져온다.
 *   캐시 항목은 며칠 전 것일 수 있고, 오래된 가격을 오늘 가격으로 기록하는 것은
 *   이 스크립트가 곳곳에서 막고 있는 바로 그 일이다(fetchCoupangAll 의
 *   stale-cache 처리 참고). 여기서 얻는 것은 "무엇으로 물어보면 되는가" 뿐이고,
 *   가격은 그 검색어를 지금 다시 불러서 받는다.
 *
 * 읽기 전용이고, 실패하면 빈 Map 을 준다(수집을 막을 이유가 없다).
 *
 * @param {Set<string>} wantIds 찾고 싶은 product_id 문자열 집합
 * @returns {Map<string, string[]>} product_id → 그 상품을 돌려준 적 있는 검색어들
 */
async function cacheHintQueries(wantIds) {
  const out = new Map();
  if (!wantIds || wantIds.size === 0) return out;
  try {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('coupang_search_cache')
        .select('keyword, items')
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      (data || []).forEach(row => {
        const items = Array.isArray(row.items) ? row.items : [];
        items.forEach(it => {
          const pid = String(it && it.productId);
          if (!wantIds.has(pid)) return;
          if (!out.has(pid)) out.set(pid, []);
          const list = out.get(pid);
          if (list.indexOf(row.keyword) < 0) list.push(row.keyword);
        });
      });
      if (!data || data.length < PAGE) break;
    }
  } catch (e) {
    console.warn(`  [캐시 힌트] 조회 실패(무시하고 진행): ${e.message}`);
    return new Map();
  }
  return out;
}

function categorizeFailure(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('차단') || r.includes('중단')) return 'blocked';
  if (r.includes('예산') || r.includes('budget')) return 'budget';
  if (r.includes('캐시') || r.includes('cache')) return 'staleCache';
  if (r.includes('네트워크') || r.includes('network')) return 'network';
  if (r.includes('키 미설정') || r.includes('환경변수')) return 'noKeys';
  if (r.includes('상한') || r.includes('한도') || r.includes('간격') || r.includes('대기')) return 'rateLimit';
  return 'other';
}

/* ─── 몰 하나를 독립적으로 수집한다 ──────────────────────────────
 *
 * 쿠팡·ADPICK 모두 이 함수 하나로 돈다 — fetchAllFn 만 다르다.
 * 여기서 던지는 예외는 없다(내부에서 전부 잡는다). 한 몰이 여기서 죽어도
 * 호출부(collectAll)가 다른 몰을 계속 돌릴 수 있어야 하기 때문이다.
 *
 * @param {object} opts
 *   mallName   '쿠팡' | 'ADPICK'
 *   rows       이 몰의 products 행
 *   fetchAllFn (keyword) => Promise<{ok, items, reason}>
 *   savedState 어제/오늘 저장된 이 몰의 진행 상태 (last_result.malls[mallName] 또는
 *              쿠팡이면 top-level 필드에서 조립한 값). 없으면 null.
 *   deadlineTs 이 몰이 절대 넘길 수 없는 종료 시각(Date.now() 기준 ms)
 *   collectedTodayFn  (mallName, collectible) => Promise<Set<'pid|mall'>>
 *              오늘 이미 가격을 확보한 상품 키. 기본값은 price_history 를 읽는
 *              collectedTodayKeys 다. 테스트가 운영 DB 없이 이어받기 실행을
 *              재현할 수 있도록 주입 가능하게 열어 둔다(수집 동작은 바뀌지 않는다).
 *   cacheHintFn  (Set<product_id>) => Promise<Map<product_id, string[]>>
 *              그 상품을 돌려준 적 있는 검색어. 기본값은 coupang_search_cache 를
 *              통째로 읽는 cacheHintQueries 다. 전체 스캔이라 수 초가 걸릴 수 있어,
 *              테스트는 스텁을 넘겨 시간 예산을 잡아먹지 않게 한다.
 *   recordPricesFn  (observations, opts) => Promise<{saved, recorded, recordedKeys, ...}>
 *              저장 경로. 기본값은 api/_shop.js 의 recordPrices 다.
 *
 *              ★ 왜 주입 가능해야 하는가 (2026-09-03).
 *                이 함수를 테스트가 직접 부를 때, 픽스처 상품이 fetchAllFn 응답에
 *                섞이면 그대로 **운영 price_history / products 에 기록된다.**
 *                실제로 그 사고가 났다 — 픽스처 product_id P1·P2·P3·X1 4행이
 *                운영에 들어갔고(2026-09-03), 발견 즉시 지웠다.
 *                테스트는 반드시 이 인자로 저장을 가로채야 한다.
 *                (scripts/verify-collection-no-write.js 가 잔여 픽스처를 검사한다)
 */
async function runMallCollection({ mallName, rows, fetchAllFn, savedState, deadlineTs,
                                   collectedTodayFn = collectedTodayKeys,
                                   recordPricesFn = recordPrices,
                                   cacheHintFn = cacheHintQueries }) {
  const withKeyword = rows.filter(p => p.keyword);
  const noKeyword   = rows.filter(p => !p.keyword);

  const derivedGroups = new Map();
  noKeyword.forEach(p => {
    const phrase = searchPhraseFromTitle(p.title);
    if (!phrase) return;
    if (!derivedGroups.has(phrase)) derivedGroups.set(phrase, []);
    derivedGroups.get(phrase).push(p);
  });
  const noPhrase = noKeyword.length - [...derivedGroups.values()].reduce((n, a) => n + a.length, 0);

  const collectible = [...withKeyword, ...[...derivedGroups.values()].flat()];
  const plan = buildPlan(withKeyword, derivedGroups);
  const planTotal = plan.reduce((n, g) => n + g.rows.length, 0);

  console.log(`\n[${mallName}] 수집 대상 ${collectible.length}개`
    + ` (keyword 있음 ${withKeyword.length} / 제목에서 유도 ${collectible.length - withKeyword.length}`
    + `(검색어 ${derivedGroups.size}종) / 유도 실패 ${noPhrase})  전체 ${rows.length}개 중`);

  const base = {
    mallName, targetProducts: collectible.length, productsTotal: rows.length, noPhraseTotal: noPhrase
  };

  /*
   * 이번 실행이 호출을 한 번도 하지 않고 끝나는 경로(이미 완료된 날, 남은
   * 검색어 없음)의 공통 결과.
   *
   * ★ 상품 단위 지표는 그래도 사실대로 채운다. 예전에는 이 경로들이
   *   uncoveredProducts: 0 을 돌려줬고, 그러면 "미수집 0" = 전량 수집 완료처럼
   *   보였다. 이번 실행이 아무 일도 안 했다는 것과 오늘 전량이 수집됐다는
   *   것은 전혀 다른 사실이다. 오늘 price_history 를 읽어 실제 값을 낸다.
   */
  async function idleResult(extra) {
    const done = await collectedTodayFn(mallName, collectible);
    const todayPriceProducts = collectible.filter(p => done.has(`${p.product_id}|${p.mall}`)).length;
    /*
     * 이번 실행은 아무것도 수집하지 않았지만, 오늘 앞선 실행이 확보한 목록은
     * 그대로 살아 있어야 한다 (저장된 상태에서 이어받는다).
     */
    const carried = (savedState && savedState.last_result && savedState.last_result.collectorCovered) || [];
    const carriedAttempt = (savedState && savedState.last_result && savedState.last_result.collectorAttempted) || [];
    const collectibleKeys = new Set(collectible.map(p => `${p.product_id}|${p.mall}`));
    const collectorCoveredIds = carried.filter(k => collectibleKeys.has(k));
    // 확보 ⊆ 시도 (위 collectorAttempted 주석과 같은 이유)
    const collectorAttemptedIds = [...new Set([...carriedAttempt, ...carried])]
      .filter(k => collectibleKeys.has(k));
    return {
      ...base,
      skipped: false, status: 'completed',
      cursorKey: '', processed: 0, total: planTotal, failedKeywords: [],
      processedProducts: 0, processedProductsCovered: 0, recorded: 0, saved: 0, rejected: 0, suspect: 0,
      attemptCalls: 0, attemptSuccess: 0, attemptFailed: 0,
      collectorSuccessProducts: collectorCoveredIds.length,
      collectorMissingProducts: collectible.length - collectorCoveredIds.length,
      collectorCovered: collectorCoveredIds,
      attemptedProducts: collectorAttemptedIds.length,
      skippedProducts: collectible.length - collectorAttemptedIds.length,
      noMatchProducts: Math.max(0, collectorAttemptedIds.length - collectorCoveredIds.length),
      collectorAttempted: collectorAttemptedIds,
      todayPriceProducts, uncoveredProducts: collectible.length - todayPriceProducts,
      failureCategories: failureCategoriesTemplate(), doneBatches: 0, stoppedEarly: false,
      passStats: [], crossRecovered: 0, optionRejects: {},
      facetDryGroups: (savedState && savedState.last_result && savedState.last_result.facetDryGroups) || [],
      notFoundCount: 0,
      secondPassCalls: 0, secondPassRecovered: 0, secondPassGroups: 0, secondPassRemaining: 0,
      secondPassDone: [],
      ...extra
    };
  }

  if (savedState && savedState.job_date === TODAY && savedState.status === 'completed') {
    console.log(`[${mallName}] ${TODAY} (KST) 작업은 이미 완료되었습니다 — 이번 실행은 처리하지 않습니다.`);
    return idleResult({
      skipped: true,
      cursorKey: savedState.cursor_key || '', processed: savedState.processed || 0,
      total: savedState.total || planTotal, status: 'completed',
      secondPassDone: (savedState.last_result && savedState.last_result.secondPassDone) || []
    });
  }

  /*
   * 오늘 이미 시도한 2차 검색어. 같은 날 후속 실행이 같은 검색어를 다시
   * 부르지 않게 한다 — 결과가 같을 뿐 아니라 호출 예산을 갉아먹는다.
   * price_job_state.last_result(JSONB) 안에 키 하나로 들어간다(마이그레이션 없음).
   */
  let priorSecondDone = [];
  /*
   * 오늘 facet 을 캐다가 연속 무수확으로 끊은 그룹. 다음 실행이 같은 그룹을
   * 다시 두드리지 않게 이어 간다 (facet 패스 안의 2026-09-03 실측 참고).
   */
  let priorFacetDry = [];
  /*
   * 오늘 앞선 실행이 이미 확보한 상품. 이어받기 실행이 자기 몫만 세어
   * 성공률을 축소하지 않도록 합집합으로 이어 간다 (markCovered 주석 참고).
   */
  let priorCollectorCovered = [];
  /*
   * 오늘 앞선 실행이 "실제로 찾아본" 상품. collectorCovered 와 같은 방식으로
   * 하루 누적 합집합을 이어 간다 (collectorAttempted 주석 참고).
   */
  let priorCollectorAttempted = [];
  let cursorKey = '', processed = 0, priorFailedKeywords = [];
  const isNewDay = !savedState || savedState.job_date !== TODAY;
  if (!isNewDay) {
    cursorKey = savedState.cursor_key || '';
    processed = savedState.processed || 0;
    priorSecondDone = (savedState.last_result && savedState.last_result.secondPassDone) || [];
    priorFacetDry = (savedState.last_result && savedState.last_result.facetDryGroups) || [];
    priorCollectorCovered = (savedState.last_result && savedState.last_result.collectorCovered) || [];
    priorCollectorAttempted = (savedState.last_result && savedState.last_result.collectorAttempted) || [];
    priorFailedKeywords = (savedState.last_result && savedState.last_result.failedKeywords) || [];
    console.log(`[${mallName}] ${TODAY} (KST) 이어서 진행 — ${processed}/${savedState.total || planTotal}개 완료,`
      + ` 커서 "${cursorKey}" 다음부터`);
  } else {
    console.log(`[${mallName}] 새 작업일 ${TODAY} (KST) — 처음부터 시작합니다.`
      + (savedState ? `  (직전 작업일 ${savedState.job_date} / ${savedState.status})` : ''));
  }

  const remaining = resumeFrom(plan, cursorKey);
  const failedKeywords = new Map(priorFailedKeywords.map(kw => [kw, '직전 실행에서 실패']));
  const retryGroups = failedKeywords.size
    ? plan.filter(g => failedKeywords.has(g.kw) && !remaining.some(x => x.kw === g.kw))
    : [];

  /*
   * ★ 1차가 다 끝났다고 곧바로 돌아가지 않는다 (2026-08-31).
   *
   *   예전에는 여기서 status='completed' 로 즉시 반환했다. 그런데 1차가
   *   끝난 시점에 2차 패스는 대부분 손도 못 댄 상태다 — 실측으로 1차가
   *   실행 예산 400 중 383 을 쓰고, 2차는 17회만 나갔다(대상 686종).
   *   여기서 돌아가 버리면 같은 날 후속 실행(KST 03·06시)도 이 자리에서
   *   똑같이 돌아가므로, 2차 패스는 **영원히 남는 예산만** 쓰게 된다.
   *
   *   이제는 아래로 계속 내려간다. 1차 배치 루프는 remaining 이 비어 있어
   *   호출 0회로 지나가고, 남은 예산 전부가 2차 패스로 간다.
   *   2차까지 다 돌면 그때 status='completed' 가 된다(아래 status 판정).
   */
  if (!remaining.length && !retryGroups.length && !isNewDay && !SECOND_PASS_ENABLED) {
    console.log(`[${mallName}] 남은 검색어가 없습니다 — 오늘 작업을 완료로 표시합니다.`);
    return idleResult({ cursorKey, processed, secondPassDone: priorSecondDone });
  }
  if (!remaining.length && !retryGroups.length && isNewDay) {
    // 이 몰에 오늘 처리할 검색어 자체가 없다(상품 0개 등) — 바로 완료.
    return idleResult({
      total: 0,
      secondPassDone: (savedState && savedState.last_result && savedState.last_result.secondPassDone) || []
    });
  }

  console.log(`── [${mallName}] 검색 (남은 검색어 ${remaining.length}종 / 전체 ${plan.length}종,`
    + ` 배치당 ${BATCH_PRODUCTS}개 상품, 간격 ${Math.round(BATCH_INTERVAL_MS / 1000)}초) ──`);

  const uncovered = new Map();
  /* 1차 호출이 실제로 성공(ok)한 상품. 2차 패스의 자격 조건이다 — processGroup 주석 참고. */
  const pass1Succeeded = new Set();
  collectible.forEach(p => uncovered.set(`${p.product_id}|${p.mall}`, p));
  /*
   * ── 수집기가 오늘 직접 확보한 상품 (Daily Collection 성공률의 유일한 근거) ──
   *
   * ★ price_history 를 세면 안 된다. 그 테이블에는 다섯 경로가 쓴다
   *   (수집기 / Vercel cron / 사용자 검색 / AI / 수동 임포트). 실측:
   *   2026-09-01 KST 에 오늘 가격을 가진 쿠팡 상품 740개 중 9개는 Vercel cron 이
   *   KST 03:11 에 쓴 것이었다. 그걸 수집기 성과로 세면, 수집기가 통째로
   *   실패한 날에도 사용자 트래픽이 성공률을 끌어올려 장애를 가린다.
   *
   * ★ price_history.source 로도 안 된다. 활성 UNIQUE
   *   (pid, mall, vid, recorded_date) 때문에 같은 날 다른 경로가 같은 행을
   *   덮으면 source 도 덮인다 — 그 컬럼은 "마지막 기록자" 일 뿐이다
   *   (supabase/2026-09-01-price-history-source.sql 참고).
   *
   * 그래서 수집기가 자기가 덮은 상품을 직접 적는다. 하루에 여러 번 도는
   * 잡이므로 앞 실행의 목록을 이어받아 합집합으로 누적한다 —
   * price_job_state.last_result 안의 JSONB 키 하나라 마이그레이션이 없다.
   */
  const collectorCovered = new Set(priorCollectorCovered);

  /*
   * ── 수집기가 오늘 실제로 "찾아본" 상품 (시도율의 유일한 근거) ──────
   *
   * ★ 왜 필요한가 — 39.6% 가 시도율 문제인지 매칭률 문제인지 리포트만 보고는
   *   알 수 없었다 (2026-09-03 감사).
   *
   *   예전 리포트의 "가격 수집 시도" 는 processedProducts, 즉 **이번 실행이
   *   배치에 담아 돌린 상품 수**였다. 하루에 세 번 이어 도는 잡에서 그 값을
   *   하루치 분모(1,548)와 나란히 놓으면 "1,548 중 1,262 만 시도했다" 로
   *   읽힌다. 실제로는 앞 실행이 나머지 286 을 이미 돌았다.
   *   (실측: 2026-09-02T19:14Z 실행 1,262 + 20:13Z 실행 286 = 1,548, 하루 시도율 100%)
   *
   * ★ 무엇을 "시도" 로 세는가 — **호출이 실제로 나가 결과를 받은 것만.**
   *   차단·예산 소진·분당 상한으로 호출이 나가지도 못한 상품은 시도가 아니다
   *   (그건 skipped 이고, 다음 실행의 재시도 대상이다). 이 구분이 있어야
   *   "찾아봤는데 없었다(noMatch)" 와 "아예 못 찾아봤다(skipped)" 가 갈린다.
   *
   * collectorCovered 와 똑같이 하루 누적 합집합이고, 같은 JSONB 키 옆에
   * 저장된다 — 마이그레이션이 없다.
   */
  const collectorAttempted = new Set(priorCollectorAttempted);
  /*
   * 확보한 상품은 정의상 시도한 상품이다. 이어받은 목록에서도 그 포함관계를
   * 강제해 둔다 — collectorAttempted 키가 없던 시절의 상태를 이어받아도
   * "성공 > 시도" 같은 모순이 리포트에 나가지 않는다.
   */
  priorCollectorCovered.forEach(k => collectorAttempted.add(k));

  /*
   * ★ markCovered 와 collectorCovered 는 시점이 다르다 — 섞으면 안 된다.
   *
   *   markCovered(uncovered 에서 제거)  = "이번 실행에서 이 상품을 찾았다"
   *     검색 응답에 상품이 나온 즉시 부른다. 같은 상품을 2차·facet 패스가
   *     다시 찾아 호출을 낭비하지 않게 하는 것이 목적이다(수집 동작).
   *
   *   collectorCovered                  = "오늘 이 상품의 가격을 확보했다"
   *     저장이 끝난 뒤 price_history 에 실제로 남은 것만 넣는다(saveAll).
   *
   *   이 둘이 갈리는 경우가 실제로 있다.
   *     · classifyPrice 가 값을 거부(rejected) → 원장에 행이 없다
   *     · price_history upsert 자체가 실패      → 원장에 행이 없다
   *   응답에 나왔다는 이유로 성공률에 세면 "확보했다" 가 거짓이 된다.
   *   (suspect 는 원장에 기록되므로 확보가 맞다 — recordPrices 주석 참고)
   */
  const markCovered = (pid, mall) => uncovered.delete(`${pid}|${mall}`);

  /* ── 응답 전체 대조 (교차 매칭, 2026-09-03) ────────────────────
   *
   * ★ 무엇이 잘못돼 있었나.
   *
   *   검색 응답을 **그 검색어를 만든 상품하고만** 대조하고 있었다.
   *     1차 processGroup  → byId 는 그 검색어 그룹의 상품만
   *     회수 callAndMatch → byId 는 그 문구를 공유한 상품만
   *   그런데 쿠팡 응답 한 건에는 우리 카탈로그의 **다른** 미수집 상품이 함께
   *   들어오는 일이 흔하다. 같은 브랜드·같은 카테고리를 훑는 검색이니 당연하다.
   *   그것들을 통째로 버리고 있었다.
   *
   *   실측(2026-09-03, 운영 캐시 2,228종을 미수집 151개와 대조):
   *     13개가 "다른 상품의 검색어" 응답 안에 들어 있었다 (총 31회 등장).
   *   캐시는 검색어당 마지막 응답만 남기므로 이건 하한이다 — 실제 실행에서
   *   흘러간 응답은 그보다 훨씬 많다.
   *
   * ★ 정밀도는 1도 낮아지지 않는다.
   *
   *   채택 기준은 여전히 product_id 완전 일치 하나뿐이다. 제목 유사도도,
   *   가격 근사도, 1위 상품 채택도 쓰지 않는다. 대조 대상 집합만 넓어진다 —
   *   "이 응답에 우리 상품이 들어 있는가" 를 우리 상품 전체에 대해 묻는 것이다.
   *   vendor_item_id 는 addRow 가 응답 항목에서 그대로 가져오므로 옵션 정체성도 그대로다.
   */
  const collectibleById = new Map();
  collectible.forEach(p => collectibleById.set(String(p.product_id), p));

  /** 이 실행에서 교차 매칭으로 건진 상품 수 (리포트용). */
  let crossRecovered = 0;

  /**
   * 응답 항목을 전체 미수집 집합과 대조해서 새로 잡히는 것을 흡수한다.
   * @param {Array} items      검색 응답 항목
   * @param {string} foundVia  이 응답을 만든 검색어 (기록용)
   * @param {Set} handled      1차 대조에서 이미 처리한 product_id (중복 계산 방지)
   * @returns {number} 새로 확보한 상품 수
   */
  function absorbCrossMatches(items, foundVia, handled) {
    let n = 0;
    /*
     * 항목 단위가 아니라 **productId 단위**로 돈다 (2026-09-03).
     *
     * 다옵션 상품은 같은 productId 항목이 응답에 여러 개 들어온다. 예전처럼
     * 항목마다 addRow 를 부르면 마지막(또는 최저가) 옵션이 이겨서, 우리가
     * 추적하는 옵션과 무관한 가격이 남았다. 이제 productId 마다 한 번만
     * 판정하고, 그 판정은 pickOption 이 vendorItemId 로 한다.
     */
    const pids = new Set((items || []).map(it => String(it.productId)));
    pids.forEach(pid => {
      if (handled && handled.has(pid)) return;         // 그 검색어의 자기 몫은 이미 봤다
      const p = collectibleById.get(pid);
      if (!p) return;                                   // 우리 상품이 아니다
      const key = `${p.product_id}|${p.mall}`;
      if (!uncovered.has(key)) return;                  // 이미 확보했다
      if (!adoptOne(p, items, foundVia)) return;        // 옵션이 다르거나 가격이 없다
      markCovered(p.product_id, p.mall);
      collectorAttempted.add(key);                      // 호출이 나가 이 상품을 찾아냈다
      n++;
    });
    crossRecovered += n;
    return n;
  }

  /*
   * ★ 오늘 이미 기록된 상품은 처음부터 '수집됨'으로 둔다 (2026-08-31).
   *
   *   하루에 세 번 도는데(KST 01·03·06시) 각 실행은 자기가 무엇을 저장했는지만
   *   안다. 그래서 후속 실행이 2차 패스를 돌 때 앞 실행이 이미 잡은 상품까지
   *   다시 찾으려 들어 호출 예산을 헛되이 썼다.
   *
   *   price_history 가 오늘 무엇을 갖고 있는지 한 번 읽어 맞춘다 —
   *   읽기 몇 번이 잘못된 API 호출 수백 회보다 싸다. 실패하면 그냥 넘어간다
   *   (수집을 막을 이유가 없다).
   */
  if (!isNewDay) {
    const already = await collectedTodayFn(mallName, collectible);
    already.forEach(k => uncovered.delete(k));
    if (already.size) console.log(`  [${mallName}] 오늘 이미 기록된 ${already.size}개는 건너뜁니다.`);
  }

  const obsMap = new Map();
  const failureCategories = failureCategoriesTemplate();
  let recovered = 0;
  const notFoundKeywords = [];
  let totalRecorded = 0, totalSaved = 0, totalRejected = 0, totalSuspect = 0;
  let doneBatches = 0;
  let stoppedEarly = false;

  /* ── attempt(수집 시도) 카운터 ──────────────────────────────────
   *
   * ★ 여기서 말하는 attempt 는 "collector 가 실제로 실행한 수집 호출 1회"다.
   *   상품 수도, 검색어 종수도 아니다. 1차 그룹 호출과 회수(2차·facet) 호출이
   *   전부 여기로 들어온다 — 둘 다 진짜로 나간 호출이기 때문이다.
   *
   *   attemptCalls = attemptSuccess + Σ failureCategories
   *
   *   이 항등식이 리포트의 "실패 attempt = 모든 실패 원인의 합" 을 만든다.
   *   그래서 모든 호출은 반드시 아래 noteAttempt* 중 정확히 하나를 지난다.
   *
   *   ── 예전에 왜 틀렸나 (2026-09-01 리포트 사고) ────────────────
   *   failureCategories 는 대부분 호출 1회당 1을 더했는데, noMatch 만
   *   `+= groupRows.length` 로 **상품 수**를 더했다. 그래서 메일의
   *   "실패 26" 과 "실패 원인 합계 151" 이 서로 다른 단위가 되어 모순됐다
   *   (실측: 2026-09-01 21:19Z 실행 — 무매칭 호출 94회 / 그 호출이 덮던
   *   상품 125개. 메일에는 125가 찍혔다). 이제 noMatch 도 호출 1회당 1이다.
   *   상품 단위 결과는 collectorSuccessProducts / todayPriceProducts 가 따로 낸다.
   */
  let attemptCalls = 0;
  let attemptSuccess = 0;

  /* ── 패스별 계측 (2026-09-03) ────────────────────────────────────
   *
   * ★ 왜 필요한가 — "회수 패스가 듣는다" 는 말은 전체 합계로는 증명되지 않는다.
   *   어떤 검색 전략이 몇 번의 호출로 몇 개를 건졌는지 패스별로 나눠야
   *   다음에 무엇을 늘리고 무엇을 접을지 정할 수 있다.
   *
   *   pass          이름. 'pass1' | 'facet' | 'r1'..'r9'
   *   calls         그 패스가 실제로 시도한 호출 수 (나가지 못한 것 포함)
   *   ok            응답을 받은 호출 수
   *   success       상품을 하나라도 새로 잡은 호출 수
   *   recovered     그 패스가 새로 확보한 상품 수
   *
   * 호출당 회수 = recovered / calls 가 전략 사이의 유일한 공정한 비교다
   * (한 호출이 여러 상품을 덮으므로 상품 수만으로는 비교가 안 된다).
   */
  const passStats = new Map();
  const notePass = (pass, { ok = false, hit = 0 }) => {
    let s = passStats.get(pass);
    if (!s) { s = { pass, calls: 0, ok: 0, success: 0, recovered: 0 }; passStats.set(pass, s); }
    s.calls++;
    if (ok) s.ok++;
    if (hit > 0) { s.success++; s.recovered += hit; }
  };
  const noteAttemptFailure = (reason) => { failureCategories[categorizeFailure(reason)]++; };
  const noteAttemptNoMatch = () => { failureCategories.noMatch++; };

  function addRow(target, item, foundVia) {
    const price = parseInt(item.lprice, 10) || 0;
    if (price <= 0) return false;
    obsMap.set(`${target.product_id}|${target.mall}|${item.vendorItemId || ''}`, {
      productId: target.product_id,
      mall: target.mall,
      title: target.title,
      keyword: target.keyword || foundVia || '',
      price,
      oprice: item.oprice || 0,
      link: item.link || target.link || '',
      image: target.image || item.image || '',
      itemId: item.itemId || '',
      vendorItemId: item.vendorItemId || '',
      /*
       * ★ 저장 직전 방어막의 재료 (2026-09-03).
       *
       *   "우리가 추적하기로 한 옵션" 을 관측치에 같이 실어 보낸다.
       *   api/_shop.js 의 recordPrices 가 이 값과 실제 vendorItemId 를
       *   다시 대조해서 다르면 저장하지 않는다(OPTION_MISMATCH).
       *
       *   pickOption 이 이미 걸렀는데 왜 또 보는가 — 위쪽 매칭에 나중에
       *   버그가 생겨도 운영 이력이 오염되지 않게 하기 위해서다. 방어막은
       *   가장 안쪽, 쓰기 직전에 하나 더 있어야 한다.
       *
       *   vid 개념이 없는 몰은 빈 문자열이고, 그때 방어막은 작동하지 않는다.
       */
      targetVendorItemId: vendorIdOf(target),
    });
    return true;
  }

  /* ── 옵션 게이트 통계 (리포트/진단용) ────────────────────────────
   * 채택을 거부한 이유별 건수. 거부는 실패가 아니라 "오늘 그 옵션의 가격을
   * 확인하지 못했다" 는 사실의 기록이다 — 다른 옵션 값으로 메우지 않는다.
   */
  const optionRejects = new Map();
  let optionRejectLogged = 0;
  const OPTION_REJECT_LOG_MAX = 20;

  /**
   * 응답에서 이 타겟의 옵션을 골라 채택한다. 옵션이 다르면 채택하지 않는다.
   * @param {object} target
   * @param {Array}  items    접히지 않은 응답 항목(allItems)
   * @param {string} foundVia 이 응답을 만든 검색어
   * @returns {boolean} 채택 여부
   */
  function adoptOne(target, items, foundVia) {
    const pick = pickOption(target, items);
    if (!pick.item) {
      optionRejects.set(pick.reason, (optionRejects.get(pick.reason) || 0) + 1);
      if (pick.reason === 'OPTION_MISMATCH' && optionRejectLogged < OPTION_REJECT_LOG_MAX) {
        optionRejectLogged++;
        console.warn(`  [${mallName}] OPTION_MISMATCH productId=${target.product_id}`
          + ` targetVendorItemId=${pick.want} responseVendorItemId=[${(pick.got || []).join(', ')}]`
          + ` 검색어="${String(foundVia).slice(0, 40)}" — 다른 옵션이라 채택하지 않습니다.`);
      }
      return false;
    }
    return addRow(target, pick.item, foundVia);
  }

  async function saveAll() {
    const savedRows = [...obsMap.values()];
    if (savedRows.length === 0) return { saved: 0, recorded: 0, total: 0, rejected: 0, suspect: 0 };
    let recorded = 0, saved = 0, rejected = 0, suspect = 0;
    const errors = [];
    for (let i = 0; i < savedRows.length; i += UPSERT_CHUNK) {
      const r = await recordPricesFn(savedRows.slice(i, i + UPSERT_CHUNK), { label: `collect:${mallName}`, source: 'collect' });
      recorded += r.recorded; saved += r.saved; rejected += r.rejected; suspect += r.suspect;
      /*
       * ★ 여기가 "가격을 확보했다" 의 유일한 판정 지점이다.
       *   원장(price_history)에 실제로 남은 상품만 들어간다. Set 이므로
       *   같은 상품을 하루에 여러 번 저장해도 한 번만 센다.
       */
      (r.recordedKeys || []).forEach(k => collectorCovered.add(k));
      if (r.errors.length) errors.push(...r.errors);
    }
    if (errors.length) console.error(`  [${mallName}] [DB 오류 원문]`, errors.slice(0, 3).join(' | '));
    return { saved, recorded, total: savedRows.length, rejected, suspect };
  }

  /** 검색어 그룹 하나를 처리한다. 실패해도 던지지 않는다 — 호출부가 계속 돈다. */
  async function processGroup({ kw, rows: groupRows }) {
    const byId = new Map();
    // 키는 반드시 문자열로 맞춘다 — 응답의 productId 는 normalize 가 String() 한 값이다.
    groupRows.forEach(p => byId.set(String(p.product_id), p));

    let r;
    attemptCalls++;
    try {
      r = await fetchAllFn(kw);
    } catch (e) {
      notePass('pass1', { ok: false, hit: 0 });
      failedKeywords.set(kw, e.message);
      /*
       * ★ 예외로 끝난 호출도 실패 원인에 넣는다.
       *   예전에는 여기서만 분류를 건너뛰어서, 예외가 난 만큼
       *   "실패 attempt 수 > 실패 원인 합계" 가 되었다.
       */
      noteAttemptFailure(e.message);
      console.log(`  [${mallName}] [실패] [${kw}] ${e.message} — 나머지는 계속 진행합니다.`);
      return;
    }

    if (!r.ok) {
      notePass('pass1', { ok: false, hit: 0 });
      failedKeywords.set(kw, r.reason);
      noteAttemptFailure(r.reason);
      console.log(`  [${mallName}] [보류] [${kw}] ${r.reason} — 재시도 대상`);
      return;
    }

    /*
     * ★ 1차 호출이 실제로 성공한 상품만 표시해 둔다 (2026-08-31).
     *
     *   2차 패스는 "1차가 성공했는데도 응답에 없던" 상품만 노려야 한다.
     *   1차가 차단·예산·상한으로 **나가지도 못한** 상품은 검색어를 좁혀 봐야
     *   똑같이 막힌다 — 그건 다음 실행의 재시도 패스(failedKeywords)가 할 일이다.
     *
     *   실측(2026-08-31 dry-run): ADPICK 1차가 서킷 브레이커로 전부 막힌
     *   상태에서 2차가 120회를 더 태웠고 회수는 0이었다. 그 호출이 ADPICK
     *   일일 쿼터를 갉아먹어 HTTP 429 까지 갔다. 낭비일 뿐 아니라 유해하다.
     */
    groupRows.forEach(p => {
      const k = `${p.product_id}|${p.mall}`;
      pass1Succeeded.add(k);
      collectorAttempted.add(k);          // 호출이 나가 결과를 받았다 = 시도
    });

    let hit = 0;
    /*
     * handled 에는 **이 그룹이 판정을 끝낸** productId 를 담는다.
     *
     * 예전에는 채택에 성공한 것만 담았다. 그 이유는 "응답에 있었다는 이유로
     * 담으면 교차 매칭이 그 상품을 건너뛴다" 였는데, 그건 **이 그룹 밖의**
     * 상품 이야기다. byId 에 있는 상품은 이 그룹의 몫이고, 여기서 거부됐으면
     * 교차 매칭이 같은 타겟을 다시 판정해도 같은 결과가 나온다(같은 응답,
     * 같은 pickOption). 두 번 세고 두 번 로그를 남길 뿐이다.
     * byId 에 없는 productId 는 여전히 handled 에 안 들어가고 교차 매칭으로 간다.
     */
    const handled = new Set();
    // ★ 매칭은 접히지 않은 allItems 로 한다 — collapseOptions 가 우리 옵션을
    //   버렸을 수 있다(fetchCoupangAll 의 items/allItems 주석 참고).
    const respItems = (r.allItems && r.allItems.length) ? r.allItems : (r.items || []);
    new Set(respItems.map(it => String(it.productId))).forEach(pid => {
      const target = byId.get(pid);
      if (!target) return;                              // 이 그룹 밖 → 교차 매칭이 본다
      handled.add(pid);
      if (!adoptOne(target, respItems, kw)) return;     // 옵션이 다르면 채택하지 않는다
      markCovered(target.product_id, target.mall);
      hit++;
      if (!target.keyword) recovered++;
    });
    // 이 응답에 우리 카탈로그의 다른 미수집 상품이 들어 있으면 함께 가져간다.
    hit += absorbCrossMatches(respItems, kw, handled);

    failedKeywords.delete(kw);

    /*
     * ★ 단위 주의: 여기는 attempt(호출) 단위다.
     *   이 호출이 상품을 하나도 못 잡았으면 실패 attempt 1회(noMatch),
     *   하나라도 잡았으면 성공 attempt 1회다. 그 호출이 몇 개의 상품을
     *   덮고 있었는지(groupRows.length)는 상품 단위 지표(collectorSuccessProducts /
     *   uncoveredProducts)가 따로 센다 — 두 단위를 절대 한 칸에 합치지 않는다.
     */
    notePass('pass1', { ok: true, hit });
    if (hit === 0) {
      notFoundKeywords.push(kw);
      noteAttemptNoMatch();
    } else {
      attemptSuccess++;
    }
    const pct = groupRows.length > 0 ? Math.round(hit / groupRows.length * 100) : 0;
    console.log(`  [${mallName}] [${kw}] ${hit}/${groupRows.length} (${pct}%) — ${r.items.length}건`);
  }

  /** 배치 하나(그룹 여러 개)를 처리하고 저장한다. */
  async function runBatch(batch) {
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      await Promise.all(batch.slice(i, i + CONCURRENCY).map(processGroup));
    }
    const s = await saveAll();
    obsMap.clear();
    totalRecorded += s.recorded; totalSaved += s.saved; totalRejected += s.rejected; totalSuspect += s.suspect;
    return s;
  }

  const attemptedGroups = [];

  // ── 0) 재시도 패스 — 직전 실행에서 호출이 못 나갔던 검색어를 먼저 다시 시도한다.
  if (retryGroups.length) {
    console.log(`── [${mallName}] 재시도: 직전 실행에서 못 받은 검색어 ${retryGroups.length}종 ──`);
    const retryBatches = splitBatches(retryGroups, BATCH_PRODUCTS);
    for (let rbi = 0; rbi < retryBatches.length; rbi++) {
      const rb = retryBatches[rbi];
      const bs = Date.now();
      const s = await runBatch(rb);
      console.log(`  [${mallName}] └ 재시도 배치 완료 — 기록 ${s.recorded}행 (남은 재시도 ${failedKeywords.size}종)`);
      // 마지막 재시도 배치면 다음 배치를 기다릴 필요가 없다 — 여기서 멈추면
      // 실제로는 다 끝났는데도 deadline 근처라는 이유만으로 stoppedEarly 가
      // 되어 본 배치 루프까지 통째로 건너뛰는(=완료를 running 으로 오판하는) 문제가 있었다.
      if (rbi === retryBatches.length - 1) break;
      if (Date.now() >= deadlineTs) { stoppedEarly = true; break; }
      const w = BATCH_INTERVAL_MS - (Date.now() - bs);
      if (w > 0) {
        if (Date.now() + w >= deadlineTs) { stoppedEarly = true; break; }
        await sleep(w);
      }
    }
  }

  // ── 1) 본 배치 루프 ───────────────────────────────────────
  const batches = stoppedEarly ? [] : splitBatches(remaining, BATCH_PRODUCTS);
  for (let b = 0; b < batches.length && !stoppedEarly; b++) {
    const batch = batches[b];
    attemptedGroups.push(...batch);
    const batchProducts = batch.reduce((n, g) => n + g.rows.length, 0);
    const batchStart = Date.now();

    const s = await runBatch(batch);

    cursorKey = batch[batch.length - 1].kw;
    processed += batchProducts;
    doneBatches++;

    const elapsedS = Math.round((Date.now() - batchStart) / 1000);
    console.log(`  [${mallName}] └ 배치 ${b + 1}/${batches.length} 완료 — 상품 ${batchProducts}개,`
      + ` 기록 ${s.recorded}행, ${elapsedS}초  [누적 ${processed}/${planTotal}]`);

    const usedUp = Date.now() >= deadlineTs;
    if (usedUp && b < batches.length - 1) {
      stoppedEarly = true;
      console.log(`⏱  [${mallName}] 시간 예산 도달 — 여기까지 저장하고 종료합니다.`
        + ` 다음 실행이 "${cursorKey}" 다음부터 이어갑니다.`);
      break;
    }
    if (b === batches.length - 1) break;

    const waitMs = BATCH_INTERVAL_MS - (Date.now() - batchStart);
    if (waitMs > 0) {
      if (Date.now() + waitMs >= deadlineTs) { stoppedEarly = true; break; }
      await sleep(waitMs);
    }
  }

  /* ── 2) 2차 패스 — 1차에서 못 잡은 상품만 좁은 검색어로 다시 찾는다 ──
   *
   * ── 왜 필요한가 (2026-08-31 감사, P0-1) ──────────────────────
   *
   * 1차 패스는 검색어 그룹당 API 를 **한 번** 부른다. 그런데 쿠팡 검색 API 는
   * 한 번에 최대 10건만 주고(api/_coupang.js COUPANG_MAX_LIMIT) offset 도 없다.
   * 그래서 한 검색어에 상품이 10개보다 많이 묶여 있으면, 나머지는 매일
   * 100% 누락된다 — 재시도로도 backoff 로도 절대 복구되지 않는 구조적 결손이다.
   *
   * 운영 DB 실측 (2026-08-31):
   *   · limit 초과 그룹 25종 → 구조적으로 못 받는 쿠팡 상품 266개 (19.0%)
   *   · "수영복" 32개 → 3일간 0개 수집
   *   · "여행용 캐리어" 43개 → 17개(39.5%)
   *   · 그룹 크기가 1인 상품조차 3일 내 수집률 62.6% — 검색어가 너무 일반적이라
   *     우리 상품이 상위 10건 안에 못 든다
   *
   * ── 왜 오매칭이 늘지 않는가 ─────────────────────────────────
   *
   * 이 스크립트의 채택 기준은 processGroup 과 **똑같이** 유지한다.
   *
   *     byId.get(item.productId)   // product_id 완전 일치만 채택
   *
   * 검색어를 무엇으로 바꾸든 응답에 우리 product_id 가 없으면 아무것도
   * 저장하지 않는다. fuzzy 매칭도, 제목 유사도도, 가격 근사도 쓰지 않는다.
   * 즉 이 패스는 **recall 만 올리고 precision 은 건드리지 않는다.**
   * 못 찾으면 그대로 NOT FOUND 로 남는다 (uncovered 에 그대로 있다).
   *
   * ── 안전장치 ───────────────────────────────────────────────
   *   · 이번 실행에서 실제로 1차를 돈 상품만 대상 (아직 커서가 닿지 않은
   *     상품을 앞당겨 부르지 않는다 — 그건 다음 실행의 몫이다)
   *   · 1차 검색어와 같은 문구가 나오면 건너뛴다 (같은 호출을 두 번 하지 않는다)
   *   · 호출 상한(SECOND_PASS_MAX_CALLS)과 deadline 을 둘 다 지킨다
   *   · fetchAllFn 을 그대로 쓴다 = 기존 rate limit · 예산 · 서킷 브레이커가
   *     그대로 적용된다. 우회하는 경로를 새로 만들지 않는다.
   */
  /*
   * ── 회수 패스 상태 ────────────────────────────────────────────
   *   secondPassCalls      이번 실행에서 회수 패스가 쓴 호출 수
   *   secondPassRecovered  회수한 상품 수
   *   secondPassRemaining  오늘 아직 안 부른 검색어 수 (>0 이면 status='running')
   *   secondPassTried      이번 실행에서 부른 검색어 (다음 실행이 건너뛰도록 저장)
   */
  /* 회수 블록 밖에서도 읽어야 해서 여기서 선언한다 (2차 패스가 꺼져 있으면 그대로 이어받는다). */
  let facetDryOut = [...priorFacetDry];
  let secondPassCalls = 0, secondPassRecovered = 0, secondPassGroups = 0;
  let secondPassRemaining = 0;
  const secondPassTried = [];
  let facetCalls = 0, facetRecovered = 0;

  if (SECOND_PASS_ENABLED && !stoppedEarly) {
    const attemptedNow = [...retryGroups, ...attemptedGroups].flatMap(g => g.rows);
    const attemptedNowKeys = new Set(attemptedNow.map(p => `${p.product_id}|${p.mall}`));
    const alreadyTried = new Set(priorSecondDone);

    /** 이 상품이 회수 패스 대상인가 — 1차가 "성공적으로" 지나간 것만. */
    const eligible = (p) => {
      const k = `${p.product_id}|${p.mall}`;
      if (pass1Succeeded.has(k)) return true;                  // 이번 실행에서 1차 성공
      const kw = p.keyword || searchPhraseFromTitle(p.title);  // 오늘 앞선 실행이 1차를 돈 것
      if (!kw || !cursorKey || kw > cursorKey) return false;
      return !failedKeywords.has(kw);
    };

    /** 예산·시간이 남았는가. rate limit 은 fetchAllFn 이 지킨다. */
    const canCall = () =>
      secondPassCalls + facetCalls < SECOND_PASS_MAX_CALLS && Date.now() < deadlineTs;

    /**
     * 검색어 하나를 부르고 product_id 완전 일치만 채택한다.
     *
     * ★ 채택 기준은 1차(processGroup)와 글자 그대로 같다. 검색어를 무엇으로
     *   바꾸든 응답에 우리 product_id 가 없으면 아무것도 저장하지 않는다.
     *   제목 유사도도, 가격 근사도, 1위 상품 채택도 하지 않는다.
     */
    async function callAndMatch(query, rows, pass) {
      let r;
      /*
       * ★ 회수 패스 호출도 attempt 다 (2026-09-01).
       *   실제로 나간 수집 호출이므로 1차와 같은 카운터로 센다. 여기를 빼면
       *   메일의 "수집 attempt" 가 실제 호출 수보다 작아지고, 회수 패스에서
       *   난 차단·무매칭이 실패 원인에만 잡혀 다시 단위가 어긋난다.
       */
      attemptCalls++;
      try { r = await fetchAllFn(query); }
      catch (e) { notePass(pass, { ok: false, hit: 0 }); noteAttemptFailure(e.message); return { ok: false, items: -1, hit: 0 }; }
      if (!r.ok) { notePass(pass, { ok: false, hit: 0 }); noteAttemptFailure(r.reason); return { ok: false, items: -1, hit: 0 }; }

      const byId = new Map();
      rows.forEach(p => {
        byId.set(String(p.product_id), p);
        // 회수 호출도 나갔으면 시도다 — 1차와 같은 기준(1차 패스 표시부 참고).
        collectorAttempted.add(`${p.product_id}|${p.mall}`);
      });
      let hit = 0;
      // 판정을 끝낸 productId (위 processGroup 의 handled 주석 참고).
      const handled = new Set();
      // ★ 접히지 않은 allItems 로 매칭한다 (processGroup 의 같은 주석 참고).
      const respItems = (r.allItems && r.allItems.length) ? r.allItems : (r.items || []);
      new Set(respItems.map(it => String(it.productId))).forEach(pid => {
        const target = byId.get(pid);                   // ← product_id 완전 일치 (불변)
        if (!target) return;
        handled.add(pid);
        // ← 옵션 게이트: vendorItemId 까지 같아야 채택한다 (pickOption 주석 참고)
        if (!adoptOne(target, respItems, query)) return;
        markCovered(target.product_id, target.mall);
        hit++;
      });
      // 같은 응답 안의 다른 미수집 상품도 가져간다 (absorbCrossMatches 주석 참고).
      hit += absorbCrossMatches(respItems, query, handled);
      notePass(pass, { ok: true, hit });
      if (hit > 0) attemptSuccess++; else noteAttemptNoMatch();
      secondPassTried.push(query);
      alreadyTried.add(query);
      return { ok: true, items: (r.items || []).length, hit };
    }

    /* ── 1.5) 캐시 힌트 패스 — 예전에 그 상품을 돌려준 검색어를 다시 부른다 ──
     *
     * 가장 확실한 단서부터 쓴다 (cacheHintQueries 주석 참고). 상품당 최대
     * CACHE_HINT_MAX_PER_PRODUCT 개, 오늘 이미 부른 문구는 건너뛴다.
     * 같은 문구를 여러 상품이 공유하면 한 번만 부른다 — 교차 매칭이 나머지를 흡수한다.
     */
    if (CACHE_HINT_ENABLED && canCall() && uncovered.size) {
      const want = new Set([...uncovered.values()].filter(eligible).map(p => String(p.product_id)));
      const hints = await cacheHintFn(want);
      const byQuery = new Map();
      hints.forEach((queries, pid) => {
        queries.slice(0, CACHE_HINT_MAX_PER_PRODUCT).forEach(q => {
          const nq = String(q || '').trim();
          if (!nq || alreadyTried.has(nq)) return;
          if (!byQuery.has(nq)) byQuery.set(nq, []);
          byQuery.get(nq).push(pid);
        });
      });
      if (byQuery.size) {
        console.log(`── [${mallName}] 캐시 힌트 패스: 상품 ${hints.size}개 / 검색어 ${byQuery.size}종 ──`);
        let hintCalls = 0, hintHit = 0;
        for (const [q, pids] of byQuery) {
          if (!canCall()) break;
          const targets = [...uncovered.values()].filter(p => pids.indexOf(String(p.product_id)) > -1);
          if (!targets.length) continue;        // 앞선 호출이 이미 잡았다
          hintCalls++;
          const res = await callAndMatch(q, targets, 'hint');
          if (!res.ok) continue;
          hintHit += res.hit;
          if (res.hit) console.log(`  [${mallName}] [hint] "${q}" +${res.hit}`);
        }
        console.log(`  [${mallName}] 캐시 힌트 완료 — 호출 ${hintCalls}회, 회수 ${hintHit}개`);
        secondPassCalls += hintCalls;
        secondPassRecovered += hintHit;
      }
    }

    /* ── 2) facet 패스 — 큰 그룹부터 (호출당 회수가 가장 높다) ──────
     *
     * 실측(2026-08-31, "여행용 캐리어" 43개):
     *   facet 분할  8호출 → 23개 회수 = 호출당 2.88개
     *   상품별 검색 6호출 →  4개 회수 = 호출당 0.67개
     * 그래서 남은 예산은 facet 에 먼저 쓴다.
     *
     * 신규 회수 0인 호출이 2회 연속이면 그 그룹은 더 캐도 안 나온다
     * (실측 한계효용 +9,+6,+3,+3,+1,+1,+0,+0 → 6회에서 포화).
     */
    /*
     * ★ 오늘 이미 마른 그룹은 다시 두드리지 않는다 (2026-09-03 실측).
     *
     *   facet 은 그룹에 처음 닿을 때 효율이 가장 높고, 한 번 훑고 나면 급격히
     *   마른다. 운영 실측(같은 날 연속 실행):
     *     1회차(이전 세션)  호출 102 → 회수 74  (0.73/호출)
     *     2회차             호출  64 → 회수  4  (0.06/호출)
     *     3회차             호출  28 → 회수 10  (0.36/호출)
     *   같은 시간에 상품별 사다리 r1 은 0.71/호출이었다. 즉 마른 그룹을 계속
     *   두드리는 것은 사다리에서 그만큼의 회수를 빼앗는 것과 같다.
     *
     *   DRY_STOP 은 한 실행 안에서만 작동해서, 다음 실행이 또 처음부터 두 번씩
     *   두드렸다(30그룹 × 2회 = 실행당 60호출). 이제 마른 그룹을 하루 단위로
     *   기억해 건너뛴다. 하루가 바뀌면 isNewDay 가 리셋한다.
     */
    const facetDry = new Set(priorFacetDry);
    const bigGroups = plan
      .filter(g => g.rows.length > FACET_MIN_GROUP && !facetDry.has(g.kw) && g.rows.some(eligible))
      .sort((x, y) => y.rows.length - x.rows.length);

    if (bigGroups.length && canCall()) {
      console.log(`── [${mallName}] facet 패스: ${FACET_MIN_GROUP}개 초과 그룹 ${bigGroups.length}종 ──`);
      for (const g of bigGroups) {
        if (!canCall()) break;
        const coveredIds = new Set(
          g.rows.filter(p => !uncovered.has(`${p.product_id}|${p.mall}`)).map(p => String(p.product_id))
        );
        /*
         * ★ 상한을 먼저 걸고 거른 것이 버그였다 (2026-09-03).
         *
         *   예전 코드는 facet 을 FACET_MAX_PER_GROUP(6)개만 만든 뒤 "오늘 이미
         *   부른 것"을 걸러냈다. buildFacetQueries 는 결정론적이라 같은 그룹에
         *   대해 늘 같은 상위 토큰을 돌려준다. 그래서 하루의 두 번째 실행부터는
         *   만들어진 6개가 전부 alreadyTried 에 들어 있어 **facet 이 0개**가 됐다.
         *
         *   즉 응답창을 넘쳐 매일 탈락하는 상품(실측 295개)에 대해 facet 패스는
         *   하루에 딱 한 번 6칸만 파고 그 뒤로는 아무 일도 하지 않았다.
         *   운영 실측(2026-09-03): "여행용 캐리어" 는 6회에서 멈췄고 그 그룹에는
         *   아직 21개가 미확보로 남아 있었다. 재측정을 시도했을 때 같은 검색어가
         *   다시 생성돼 +0 이 나온 것도 이 때문이다.
         *
         *   이제는 **깊은 후보 풀을 먼저 만들고, 안 부른 것 중 앞에서 N개**를 쓴다.
         *   다음 실행은 7·8·9번째 토큰으로 이어서 판다. 낭비는 늘지 않는다 —
         *   FACET_DRY_STOP(연속 무수확 2회)이 그대로 그룹을 끊고 canCall() 이
         *   시간·예산을 지킨다.
         */
        const facets = buildFacetQueries(g.kw, g.rows, coveredIds, FACET_POOL_PER_GROUP)
          .filter(f => !alreadyTried.has(f.query))
          .slice(0, FACET_MAX_PER_GROUP);
        let dry = 0;
        for (const f of facets) {
          if (!canCall()) break;
          const targets = g.rows.filter(p => uncovered.has(`${p.product_id}|${p.mall}`));
          if (!targets.length) break;
          facetCalls++;
          const res = await callAndMatch(f.query, targets, 'facet');
          if (!res.ok) continue;
          facetRecovered += res.hit;
          dry = res.hit ? 0 : dry + 1;
          if (res.hit) {
            console.log(`  [${mallName}] [facet] "${f.query}" +${res.hit} (items=${res.items})`);
          }
          if (dry >= FACET_DRY_STOP) {           // 연속 무수확 → 이 그룹은 오늘 끝
            facetDry.add(g.kw);
            break;
          }
        }
        // 후보를 다 썼는데도 남은 상품이 있으면, 이 그룹은 facet 으로 더 캘 것이 없다.
        if (!facetDry.has(g.kw) && facets.length === 0) facetDry.add(g.kw);
      }
      console.log(`  [${mallName}] facet 패스 완료 — 호출 ${facetCalls}회, 회수 ${facetRecovered}개`);
    }

    /* ── 3) 상품별 회수 패스 — 최대 3라운드 ───────────────────────
     *
     * 후보는 api/_query.js 가 만든다(근거는 그 파일 주석 참고).
     *   R1 제목 48자        단독 78.6~79.2%
     *   R2 브랜드+마지막명사  누적 85.7%
     *   R3 브랜드+명사2·3    누적 92.9%  ← 상한. 4라운드부터는 호출만 는다
     *
     * 라운드 단위로 도는 이유: 같은 검색어를 여러 상품이 공유하면 한 번만
     * 부르면 된다. 상품마다 3번씩 부르면 그 공유가 사라진다.
     *
     * 적중하면 그 상품은 다음 라운드에서 빠진다(즉시 중단과 같은 효과).
     */
    /* ── 검색어 후보를 라운드 시작 **전에** 한 번만 만든다 ──────────
     *
     * ★ 이 자리가 중요하다. 라운드 안에서 만들면 안 된다.
     *
     *   후보는 [제목48, 브랜드+꼬리, 브랜드+명사2] 순서고, 라운드 N 은
     *   qs[N] 을 쓴다. 그런데 라운드마다 "이미 부른 검색어"를 exclude 로
     *   넘겨 후보를 **다시 만들면** 배열이 앞으로 밀린다.
     *
     *     R0  [제목48, 브랜드+꼬리, 브랜드+명사2]  → qs[0] = 제목48
     *     R1  제목48 을 빼고 다시 생성
     *         [브랜드+꼬리, 브랜드+명사2]          → qs[1] = 브랜드+명사2
     *                                              ↑ 브랜드+꼬리를 영영 안 부른다
     *
     *   실측 단독 적중률 78.6% 짜리 후보 하나가 통째로 사라진다. 구현 중
     *   실제로 이 상태였고 scripts/test-second-pass.js §9 가 이걸 고정한다.
     *
     * 그래서 후보 배열은 **여기서 한 번만** 만들어 고정하고, 라운드는
     * 인덱스로만 읽는다. 이미 부른 검색어는 아래에서 건너뛰기만 하고
     * 배열 자체는 절대 건드리지 않는다.
     *
     * 키는 product_id|mall — 상품을 고유하게 식별하는 안정적인 값이다.
     * facet 패스가 이미 잡은 상품은 uncovered 에서 빠졌으므로 계획에도 없다.
     */
    const queryPlan = new Map();
    [...uncovered.values()].filter(eligible).forEach(p => {
      const key = `${p.product_id}|${p.mall}`;
      if (queryPlan.has(key)) return;
      queryPlan.set(key, generateSecondPassQueries(p, { exclude: [...priorSecondDone] }));
    });

    const rounds = SECOND_PASS_ROUNDS;
    for (let round = 0; round < rounds; round++) {
      if (!canCall()) break;

      const missed = [...uncovered.values()].filter(eligible);
      if (!missed.length) break;

      /*
       * 이 라운드에서 쓸 검색어로 상품을 묶는다 (같은 문구는 한 번만 호출).
       * 후보 배열은 위에서 이미 고정됐다 — 여기서는 인덱스로 읽기만 한다.
       */
      const byQuery = new Map();
      missed.forEach(p => {
        const qs = queryPlan.get(`${p.product_id}|${p.mall}`);
        if (!qs) return;
        const q = qs[round];                    // ← 배열은 절대 다시 만들지 않는다
        if (!q) return;
        if (alreadyTried.has(q)) return;        // 오늘 이미 부른 검색어는 건너뛰기만
        if (!byQuery.has(q)) byQuery.set(q, []);
        byQuery.get(q).push(p);
      });
      if (!byQuery.size) continue;

      /*
       * 호출 순서 = 기대 회수량 내림차순.
       * 한 검색어가 여러 상품을 덮으면 그만큼 기대값이 크다. 과거 성공률
       * 데이터가 없으므로 통계를 지어내지 않고 이 결정론적 값만 쓴다.
       */
      const queue = [...byQuery.entries()]
        .map(([q, rows]) => ({ q, rows }))
        .sort((a, b) => b.rows.length - a.rows.length);

      let roundCalls = 0, roundHit = 0;
      for (const { q, rows } of queue) {
        if (!canCall()) break;
        const targets = rows.filter(p => uncovered.has(`${p.product_id}|${p.mall}`));
        if (!targets.length) continue;          // 앞선 호출이 이미 잡았다
        secondPassCalls++; secondPassGroups++; roundCalls++;
        const res = await callAndMatch(q, targets, `r${round + 1}`);
        if (!res.ok) continue;
        secondPassRecovered += res.hit; roundHit += res.hit;
      }
      console.log(`  [${mallName}] 회수 R${round + 1} — 검색어 ${byQuery.size}종 중 ${roundCalls}회 호출, +${roundHit}개`);

      // 이 라운드를 다 돌지 못했으면 남은 만큼을 다음 실행으로 넘긴다.
      secondPassRemaining += Math.max(0, byQuery.size - roundCalls);
    }

    if (obsMap.size) {
      const s = await saveAll();
      obsMap.clear();
      totalRecorded += s.recorded; totalSaved += s.saved;
      totalRejected += s.rejected; totalSuspect += s.suspect;
    }
    if (secondPassCalls || facetCalls) {
      console.log(`  [${mallName}] 회수 패스 합계 — 호출 ${secondPassCalls + facetCalls}회`
        + ` (facet ${facetCalls}), 회수 ${secondPassRecovered + facetRecovered}개,`
        + ` 남은 검색어 ${secondPassRemaining}종`);
    }
    secondPassRecovered += facetRecovered;
    secondPassCalls += facetCalls;
    facetDryOut = [...facetDry];
  }

  if (recovered) {
    console.log(`  [${mallName}] ✅ keyword 가 없던 상품 ${recovered}개를 찾아 검색어를 채웠습니다.`);
  }

  /*
   * ★ 2차 미시도가 남아 있으면 아직 '완료'가 아니다 (2026-08-31).
   *
   *   실측: 1차에 383회를 쓰면 실행 예산(400) 중 17회만 남는다. 그런데
   *   2차 대상은 686종이라, 1차가 끝나는 순간 status='completed' 가 되어
   *   같은 날 후속 실행(KST 03:00·06:00)이 통째로 스킵됐다. 즉 2차 패스는
   *   **한 실행의 남는 예산만** 쓸 수 있었다.
   *
   *   'running' 으로 남겨 두면 후속 실행이 들어와서, 커서가 이미 끝에
   *   있으므로 1차는 사실상 0회로 지나가고 남은 예산 전부를 2차에 쓴다.
   *   같은 검색어를 다시 부르지 않도록 시도 목록(secondPassDone)을
   *   price_job_state.last_result 에 이어 적는다 — JSONB 키 추가이므로
   *   스키마 변경이 아니다.
   *
   *   무한 반복 위험은 없다: 미시도 목록은 줄어들기만 하고, 다 부르면
   *   secondPassRemaining 이 0 이 되어 completed 로 끝난다. 하루가 바뀌면
   *   isNewDay 가 전부 리셋한다.
   */
  const isFullyDone = !stoppedEarly && batches.length === doneBatches;
  const status = isFullyDone && !failedKeywords.size && secondPassRemaining === 0
    ? 'completed' : 'running';

  if (status === 'completed') {
    console.log(`✅ [${mallName}] ${TODAY} (KST) 전체 ${processed}/${planTotal}개 처리 완료.`);
  } else if (failedKeywords.size) {
    console.log(`⚠️  [${mallName}] 못 받은 검색어 ${failedKeywords.size}종이 남았습니다 — 같은 날 보충 실행이 이어받습니다.`);
  }

  /*
   * ★ 이번 실행이 "시도"했다고 부를 수 있는 건 이번에 실제로 돈 그룹뿐이다.
   *   (재시도 그룹도 포함 — 실제로 API를 다시 호출했으므로 시도가 맞다)
   *   전체(collectible)를 분모로 두면 절반만 돈 정상 실행이 낮은 커버리지로
   *   찍혀서 진짜로 망가진 실행과 구분이 안 된다.
   */
  const attempted = [...retryGroups, ...attemptedGroups].flatMap(g => g.rows);
  const attemptedKeys = new Set(attempted.map(p => `${p.product_id}|${p.mall}`));
  const failedRows = [...uncovered.values()].filter(p => attemptedKeys.has(`${p.product_id}|${p.mall}`));
  const success = attempted.length - failedRows.length;

  /*
   * ── 상품 단위 최종 상태 ────────────────────────────────────────
   *
   *   uncovered 는 "오늘 아직 가격이 없는 대상 상품" 이다. 시작할 때
   *   collectible 전부로 채우고, 오늘 이미 price_history 에 있는 상품과
   *   이번 실행이 새로 잡은 상품을 빼 왔다. 그래서 하루 누적 기준이다.
   *
   *   성공 상품 + 미수집 상품 = 대상 상품  ← 정의상 항상 성립한다.
   *   (attempt 단위 숫자와는 절대 섞지 않는다. 한 상품이 1차·회수 패스로
   *    여러 번 시도될 수 있고, 한 번의 attempt 가 여러 상품을 덮기도 한다)
   */
  const todayPriceProducts = collectible.length - uncovered.size;

  /*
   * ── collector 성과 (Daily Collection Report 의 대표 지표) ─────────
   *   수집기가 오늘 직접 확보한 상품만 센다. collectible 로 교집합을 잡아
   *   대상 밖 상품이 섞이지 않게 한다 (markCovered 주석의 근거 참고).
   */
  const collectibleKeys = new Set(collectible.map(p => `${p.product_id}|${p.mall}`));
  const collectorCoveredIds = [...collectorCovered].filter(k => collectibleKeys.has(k));
  const collectorSuccessProducts = collectorCoveredIds.length;
  const collectorAttemptedIds = [...collectorAttempted].filter(k => collectibleKeys.has(k));

  return {
    ...base,
    skipped: false,
    cursorKey, processed, total: planTotal, status,
    failedKeywords: [...failedKeywords.keys()],
    // ── 상품 단위 · collector 성과 (대표 지표) ──
    collectorSuccessProducts,
    collectorMissingProducts: collectible.length - collectorSuccessProducts,
    collectorCovered: collectorCoveredIds,
    /*
     * ── 시도 단위(상품) — 하루 누적 ──
     *   attemptedProducts  실제로 호출이 나가 결과를 받아 본 상품
     *   skippedProducts    대상이지만 오늘 한 번도 못 찾아본 상품
     *   noMatchProducts    찾아봤지만 응답에 우리 product_id 가 없던 상품
     */
    attemptedProducts: collectorAttemptedIds.length,
    skippedProducts: collectible.length - collectorAttemptedIds.length,
    noMatchProducts: Math.max(0, collectorAttemptedIds.length - collectorSuccessProducts),
    collectorAttempted: collectorAttemptedIds,
    // ── 상품 단위 · 모든 기록 경로 (데이터 신선도 참고) ──
    todayPriceProducts,
    uncoveredProducts: uncovered.size,
    // ── attempt(호출) 단위 ──
    attemptCalls,
    attemptSuccess,
    attemptFailed: attemptCalls - attemptSuccess,
    /*
     * 회수(2차·facet) 패스가 쓴 attempt. attemptCalls 의 부분집합이다.
     * 1차 attempt = attemptCalls - attemptCallsRecovery.
     */
    attemptCallsRecovery: secondPassCalls,
    failureCategories,
    // ── 행 단위 (DB 저장 결과) ──
    recorded: totalRecorded, saved: totalSaved, rejected: totalRejected, suspect: totalSuspect,
    /*
     * 참고용 상품 단위 값 — 이번 실행이 검색 그룹에 담아 돌린 상품 수와,
     * 그중 가격을 확보한 수. 메일 헤드라인에는 쓰지 않는다(하루 누적이 아니라
     * 실행 단위라 1455 를 분모로 두면 오해를 부른다).
     */
    processedProducts: attempted.length,
    processedProductsCovered: success,
    doneBatches, stoppedEarly,
    notFoundCount: notFoundKeywords.length,
    // 2차 패스 성과 — 리포트에서 1차/2차 회수율을 나눠 볼 수 있게 남긴다.
    secondPassCalls, secondPassRecovered, secondPassGroups, secondPassRemaining,
    /*
     * 패스별 계측. 하루 누적이 아니라 **이번 실행** 값이다 — 전략 비교는
     * 한 실행 안에서 같은 조건으로 이뤄져야 공정하기 때문이다.
     * 순서는 실제 실행 순서(pass1 → facet → r1..r9)로 고정한다.
     */
    passStats: [...passStats.values()].sort((a, b) => passOrder(a.pass) - passOrder(b.pass)),
    /* 교차 매칭으로 건진 상품 수 — 응답 전체 대조가 실제로 얼마를 벌었는지. */
    crossRecovered,
    /*
     * 옵션 게이트가 채택을 거부한 이유별 건수 (pickOption 주석 참고).
     *
     * ★ 이 숫자는 실패가 아니라 **정직함의 비용**이다. OPTION_MISMATCH 는
     *   "그 상품 페이지는 찾았는데 우리가 추적하는 옵션이 응답에 없었다"
     *   는 뜻이고, 그때 오늘 그 옵션의 가격은 우리가 모르는 값이다.
     *   예전에는 이 자리에서 다른 옵션 가격을 대신 기록했다.
     */
    optionRejects: Object.fromEntries(optionRejects),
    // 오늘 facet 이 마른 그룹. 다음 실행이 헛되이 두드리지 않게 이어 간다.
    facetDryGroups: facetDryOut,
    // 오늘 누적 시도 목록. 무한히 커지지 않도록 상한을 둔다.
    secondPassDone: [...priorSecondDone, ...secondPassTried].slice(-3000)
  };
}

// ─── 메인 ─────────────────────────────────────────────────────
async function run() {
  const state = await loadState();

  /*
   * ★ 잠금을 먼저 잡는다 (acquireLock 주석의 실측 겹침 참고).
   *   못 잡으면 아무것도 하지 않고 정상 종료한다 — 실패가 아니라
   *   "다른 실행이 하고 있다" 이므로 exit 0 이어야 Actions 가 빨간불이 되지 않는다.
   */
  const lock = await acquireLock(state);
  if (!lock.ok) {
    console.log(`[잠금] 이번 실행은 건너뜁니다 — ${lock.reason}`);
    return;
  }
  console.log(`[잠금] 획득 (${lock.token}) — TTL ${Math.round(LOCK_TTL_MS / 60000)}분`);
  try {
    await runLocked(state, lock.token);
  } finally {
    await releaseLock(lock.token);
    console.log('[잠금] 해제');
  }
}

/** 잠금을 쥔 상태에서 도는 본체. 예외는 호출부(run)가 finally 로 받는다. */
async function runLocked(state, lockToken) {
  const savedMalls = (state && state.last_result && state.last_result.malls) || {};
  const coupangSaved = state
    ? { job_date: state.job_date, cursor_key: state.cursor_key, processed: state.processed, total: state.total,
        status: state.status,
        last_result: {
          failedKeywords: (state.last_result || {}).failedKeywords || [],
          /*
           * 오늘 앞선 실행이 확보한 상품 목록. 이걸 안 넘기면 이어받기 실행이
           * 빈 집합에서 시작해 성공률이 자기 몫으로 축소된다 —
           * 2026-09-01 에 실제로 났던 사고(13.7%)와 같은 형태다.
           */
          collectorCovered: (savedMalls['쿠팡'] && savedMalls['쿠팡'].collectorCovered) || [],
          collectorAttempted: (savedMalls['쿠팡'] && savedMalls['쿠팡'].collectorAttempted) || [],
          facetDryGroups: (savedMalls['쿠팡'] && savedMalls['쿠팡'].last_result
            && savedMalls['쿠팡'].last_result.facetDryGroups) || []
        } }
    : null;
  /*
   * ★ ADPICK 도 하루 누적 목록을 이어받아야 한다 (2026-09-03 실측 버그).
   *
   *   여기서 last_result 를 새로 만들면서 failedKeywords 만 담고 있었다.
   *   그래서 runMallCollection 이 priorCollectorCovered 를 빈 배열로 시작했고,
   *   ADPICK 성공 상품 수가 매 실행 그 실행 몫으로 축소됐다.
   *
   *   실측: 2026-09-03 한 실행이 231개를 확보해 저장했는데, 곧이은 다음 실행이
   *   7개만 확보하자 상태의 collectorCovered 가 231 → 7 로 덮였다.
   *   쿠팡 경로(coupangSaved)는 이미 세 키를 다 넘기고 있었다 — 같은 모양으로 맞춘다.
   *   (원장 자체는 멀쩡하다. 잘못되는 것은 성공률 보고다.)
   */
  const adpickSaved = savedMalls['ADPICK']
    ? {
        job_date: state.job_date, ...savedMalls['ADPICK'],
        last_result: {
          failedKeywords: savedMalls['ADPICK'].failedKeywords || [],
          collectorCovered: savedMalls['ADPICK'].collectorCovered || [],
          collectorAttempted: savedMalls['ADPICK'].collectorAttempted || [],
          secondPassDone: (savedMalls['ADPICK'].last_result || {}).secondPassDone || [],
          facetDryGroups: (savedMalls['ADPICK'].last_result || {}).facetDryGroups || []
        }
      }
    : null;

  /*
   * ★ 두 몰이 모두 오늘 완료 상태여야만 "이미 완료"로 아무것도 하지 않는다.
   *   쿠팡만 완료고 ADPICK이 아직이면(또는 그 반대면) 계속 진행해야 한다 —
   *   예전처럼 top-level status 하나만 보면 쿠팡이 끝나는 순간 ADPICK 은
   *   같은 날 다시는 시도되지 않는다.
   */
  const coupangDoneToday = state && state.job_date === TODAY && state.status === 'completed';
  const adpickDoneToday  = state && state.job_date === TODAY
    && savedMalls['ADPICK'] && savedMalls['ADPICK'].status === 'completed';

  if (coupangDoneToday && adpickDoneToday) {
    console.log(`\n[진행] ${TODAY} (KST) 작업은 두 몰 모두 이미 완료되었습니다`
      + ` — 쿠팡 ${state.processed}/${state.total}, ADPICK ${savedMalls['ADPICK'].processed}/${savedMalls['ADPICK'].total}.`
      + ` 이번 실행은 아무 상품도 처리하지 않습니다.`);
    console.log('       (다음 작업은 KST 자정 이후 실행부터 시작합니다)');
    return;
  }

  const products = await fetchAllProducts();
  let coupangRows = products.filter(isCoupangRow);
  let adpickRows  = products.filter(isAdpickRow);
  const otherRows   = products.filter(p => !isCoupangRow(p) && !isAdpickRow(p));

  const otherByMall = new Map();
  otherRows.forEach(p => otherByMall.set(p.mall, (otherByMall.get(p.mall) || 0) + 1));

  /*
   * ★ 시드 모드 필터 — SEED_ONLY 주석 참고.
   *   여기서 좁힌 rows 를 그대로 runMallCollection 에 넘길 뿐이라, 이 블록을
   *   지우면(또는 PRICE_SEED_ONLY 를 켜지 않으면) 위 두 줄과 완전히 동일하게 동작한다.
   */
  if (SEED_ONLY) {
    const everCollected = await fetchEverCollectedKeys();
    const beforeC = coupangRows.length, beforeA = adpickRows.length;
    coupangRows = coupangRows.filter(p => !everCollected.has(`${p.product_id}|${p.mall}`));
    adpickRows  = adpickRows.filter(p => !everCollected.has(`${p.product_id}|${p.mall}`));
    console.log(`\n[시드 모드] PRICE_SEED_ONLY=1 — 전체 기간 이력이 0건인 상품만 대상으로 좁힙니다.`);
    console.log(`  쿠팡   ${beforeC}개 → ${coupangRows.length}개`);
    console.log(`  ADPICK ${beforeA}개 → ${adpickRows.length}개`);
  }

  console.log(`\n가격 수집 시작 (${TODAY}, ${kstNowStamp()})`);
  console.log(`  products 전체        ${products.length}개${SEED_ONLY ? ' (시드 모드 — 실제 대상은 위 필터 참고)' : ''}`);
  console.log(`  ├ 쿠팡               ${coupangRows.length}개`);
  console.log(`  ├ ADPICK             ${adpickRows.length}개`);
  console.log(`  └ 기타(연동 없음)     ${otherRows.length}개`
    + (otherByMall.size ? `  (${[...otherByMall.entries()].map(([m, n]) => `${m} ${n}`).join(', ')})` : ''));

  /** "n/d (x.x%)" — 분모 0 이면 비율을 지어내지 않는다. */
  const rateStr = (n, d) => (Number(d) > 0 ? `${(Number(n) / Number(d) * 100).toFixed(1)}%` : '-');

  await loadCoupangDayUsage();
  console.log(`쿠팡 오늘 호출량: ${_coupangDayUsed}회 / 하루 상한 ${COUPANG_DAY_BUDGET}회`
    + ` (이번 실행 상한 ${COUPANG_RUN_BUDGET}회)`);

  const started = Date.now();

  // ── 쿠팡 먼저 — 자기 몫(절반)이 다 되면 남은 시간을 ADPICK 에게 넘긴다.
  const coupangResult = await runMallCollection({
    mallName: '쿠팡', rows: coupangRows, fetchAllFn: fetchCoupangAll,
    savedState: coupangSaved, deadlineTs: started + COUPANG_BUDGET_MS
  });

  // ── ADPICK — 쿠팡이 일찍 끝났으면 남은 시간을 전부 받는다(최소 절반 보장).
  const adpickResult = await runMallCollection({
    mallName: 'ADPICK', rows: adpickRows, fetchAllFn: fetchAdpickAll,
    savedState: adpickSaved, deadlineTs: started + RUN_TIME_BUDGET_MS
  });

  // ── 콘솔 리포트 (몰별 트리) ──────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`가격 수집 결과 (${TODAY}, ${kstNowStamp()})`);
  console.log('─'.repeat(60));
  /*
   * ★ 콘솔도 메일과 똑같이 단위를 나눠 찍는다. 한 줄에 상품 단위와 attempt
   *   단위를 섞으면 로그만 보고도 같은 모순을 다시 만들게 된다.
   */
  [coupangResult, adpickResult].forEach(r => {
    const cats = Object.entries(r.failureCategories || {}).filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} ${v}`).join(' / ') || '없음';
    console.log(`${r.mallName}  [${r.status}]`);
    console.log(`  상품   대상 ${r.targetProducts} / 수집성공 ${r.collectorSuccessProducts}`
      + ` / 수집미확보 ${r.collectorMissingProducts} / 오늘가격보유(모든경로) ${r.todayPriceProducts}`);
    console.log(`  분해   시도 ${r.attemptedProducts} / 미시도 ${r.skippedProducts}`
      + ` / 시도했으나 무매칭 ${r.noMatchProducts}`
      + `   (시도율 ${rateStr(r.attemptedProducts, r.targetProducts)},`
      + ` 시도대비 성공률 ${rateStr(r.collectorSuccessProducts, r.attemptedProducts)})`);
    console.log(`  attempt 총 ${r.attemptCalls} / 성공 ${r.attemptSuccess} / 실패 ${r.attemptFailed}  (${cats})`);
    console.log(`  저장   price_history ${r.recorded}행 / products ${r.saved}행`
      + ` / 급변 보류 ${r.suspect} / 값 이상 거부 ${r.rejected}`);
    console.log(`  진행   오늘 ${r.processed}/${r.total} (검색 그룹에 담긴 상품 ${r.processedProducts}개)`);
    /*
     * 패스별 성적. "호출당 회수" 가 전략 사이의 유일한 공정한 비교값이다
     * (한 호출이 여러 상품을 덮으므로 상품 수만으로는 비교가 안 된다).
     */
    const ps = r.passStats || [];
    if (ps.length) {
      console.log('  패스   pass      호출  응답  적중  회수  호출당회수');
      ps.forEach(s => {
        const per = s.calls > 0 ? (s.recovered / s.calls).toFixed(2) : '-';
        console.log(`         ${String(s.pass).padEnd(8)} ${String(s.calls).padStart(5)}`
          + `${String(s.ok).padStart(6)}${String(s.success).padStart(6)}${String(s.recovered).padStart(6)}`
          + `${String(per).padStart(11)}`);
      });
    }
  });
  if (otherRows.length) {
    console.log(`기타(연동 없음) — 상품 대상 ${otherRows.length} / attempt 0 (재조회 API 없음)`);
  }
  console.log('═'.repeat(60) + '\n');

  const cs = coupangLocalStats();
  const as = adpickLocalStats();
  console.log(`쿠팡 API 호출: ${cs.calls}회 (실행 예산 ${COUPANG_RUN_BUDGET}회) / 캐시 ${cs.cacheHits} / 생략 ${cs.denied + _coupangSkipped}`);
  console.log(`  └ 오늘 누적: ${_coupangDayUsed + _coupangCalls}회 / 하루 상한 ${COUPANG_DAY_BUDGET}회`);
  console.log(`ADPICK API 호출: ${as.calls}회 (예산 ${ADPICK_RUN_BUDGET}회) / 캐시 ${as.cacheHits} / 생략 ${as.denied + _adpickSkipped}`);
  if (_coupangBlocked || cs.blocked) {
    console.log(`⚠️  쿠팡 API: 차단 상태 — ${String(_coupangBlockMsg || cs.blockReason).replace(/<[^>]*>/g, '').slice(0, 150)}`);
  }
  if (_adpickBlocked || as.blocked) {
    console.log(`⚠️  ADPICK API: 차단/오류 상태 — ${String(_adpickBlockMsg || as.blockReason).replace(/<[^>]*>/g, '').slice(0, 150)}`);
  }

  // ── 상태 저장 ────────────────────────────────────────────
  const mergedFailureCategories = failureCategoriesTemplate();
  Object.keys(mergedFailureCategories).forEach(k => {
    mergedFailureCategories[k] = (coupangResult.failureCategories[k] || 0) + (adpickResult.failureCategories[k] || 0);
  });

  await saveState({
    /*
     * 하위호환: top-level 은 "쿠팡" 진행 상태를 그대로 담는다 — 두 몰 모두 완료된
     * 경우의 종합 상태를 넣으면 안 된다. runMallCollection('쿠팡', ...) 이 다음 실행에서
     * savedState.status === 'completed' 를 보고 즉시 스킵하는 판정이 바로 이 필드를
     * 읽는데, 여기 overallStatus 를 넣으면 ADPICK 이 안 끝난 날은 쿠팡이 이미 다
     * 끝났어도 매번 다시 "완료됐다" 를 처음부터 재계산해야 한다(결과는 같지만
     * 헛되이 plan 을 다시 만든다). "이미 완료" 여부의 전체 판정은 run() 위쪽의
     * coupangDoneToday && adpickDoneToday 가 이미 두 몰을 각각 본다.
     */
    job_date: TODAY,
    cursor_key: coupangResult.cursorKey,
    processed: coupangResult.processed,
    total: coupangResult.total,
    status: coupangResult.status,
    last_run_at: new Date().toISOString(),
    last_result: {
      /*
       * ★ 잠금을 여기서 되살려 넣는다. 이 saveState 는 last_result 를 통째로
       *   교체하므로, 넣지 않으면 실행 도중에 잠금이 사라져 뒤따라온 실행이
       *   그대로 들어온다 (동시 실행 방지가 무력화된다).
       */
      lock: { runId: lockToken, at: new Date().toISOString(),
              until: new Date(Date.now() + LOCK_TTL_MS).toISOString() },
      recorded: coupangResult.recorded + adpickResult.recorded,
      saved: coupangResult.saved + adpickResult.saved,
      rejected: coupangResult.rejected + adpickResult.rejected,
      suspect: coupangResult.suspect + adpickResult.suspect,
      failedKeywords: coupangResult.failedKeywords, // 쿠팡 몫(하위호환)
      secondPassDone: coupangResult.secondPassDone || [],   // 쿠팡 2차 진행(하위호환 경로)
      failureCategories: mergedFailureCategories,
      productsTotal: products.length,
      coupangTotal: coupangRows.length,
      adpickTotal: adpickRows.length,
      otherTotal: otherRows.length,
      otherByMall: Object.fromEntries(otherByMall),
      malls: {
        '쿠팡': {
          cursor_key: coupangResult.cursorKey, processed: coupangResult.processed, total: coupangResult.total,
          status: coupangResult.status, failedKeywords: coupangResult.failedKeywords,
          // 2차 패스 진행 — 같은 날 후속 실행이 이어받는다(status 판정 주석 참고)
          last_result: {
            secondPassDone: coupangResult.secondPassDone || [],
            facetDryGroups: coupangResult.facetDryGroups || []
          },
          secondPassRecovered: coupangResult.secondPassRecovered,
          secondPassRemaining: coupangResult.secondPassRemaining,
          // 상품 단위 — collectorCovered 가 내일 성공률의 근거다(하루 누적, 합집합)
          collectorCovered: coupangResult.collectorCovered || [],
          collectorAttempted: coupangResult.collectorAttempted || [],
          attemptedProducts: coupangResult.attemptedProducts,
          skippedProducts: coupangResult.skippedProducts,
          noMatchProducts: coupangResult.noMatchProducts,
          passStats: coupangResult.passStats || [],
          targetProducts: coupangResult.targetProducts,
          collectorSuccessProducts: coupangResult.collectorSuccessProducts,
          todayPriceProducts: coupangResult.todayPriceProducts,
          uncoveredProducts: coupangResult.uncoveredProducts,
          // attempt 단위
          attemptCalls: coupangResult.attemptCalls, attemptSuccess: coupangResult.attemptSuccess,
          attemptFailed: coupangResult.attemptFailed, failureCategories: coupangResult.failureCategories,
          // 행 단위 + 참고(실행 단위 상품 수)
          processedProducts: coupangResult.processedProducts, processedProductsCovered: coupangResult.processedProductsCovered,
          recorded: coupangResult.recorded, saved: coupangResult.saved
        },
        'ADPICK': {
          cursor_key: adpickResult.cursorKey, processed: adpickResult.processed, total: adpickResult.total,
          status: adpickResult.status, failedKeywords: adpickResult.failedKeywords,
          last_result: {
            secondPassDone: adpickResult.secondPassDone || [],
            facetDryGroups: adpickResult.facetDryGroups || []
          },
          secondPassRecovered: adpickResult.secondPassRecovered,
          secondPassRemaining: adpickResult.secondPassRemaining,
          collectorCovered: adpickResult.collectorCovered || [],
          collectorAttempted: adpickResult.collectorAttempted || [],
          attemptedProducts: adpickResult.attemptedProducts,
          skippedProducts: adpickResult.skippedProducts,
          noMatchProducts: adpickResult.noMatchProducts,
          passStats: adpickResult.passStats || [],
          targetProducts: adpickResult.targetProducts,
          collectorSuccessProducts: adpickResult.collectorSuccessProducts,
          todayPriceProducts: adpickResult.todayPriceProducts,
          uncoveredProducts: adpickResult.uncoveredProducts,
          attemptCalls: adpickResult.attemptCalls, attemptSuccess: adpickResult.attemptSuccess,
          attemptFailed: adpickResult.attemptFailed, failureCategories: adpickResult.failureCategories,
          processedProducts: adpickResult.processedProducts, processedProductsCovered: adpickResult.processedProductsCovered,
          recorded: adpickResult.recorded, saved: adpickResult.saved
        }
      }
    }
  });

  // ── 수집 결과 이메일 발송 (실패해도 수집 결과에 영향 없음, 여기서 절대 throw 하지 않는다) ──
  const sum = (f) => (Number(coupangResult[f]) || 0) + (Number(adpickResult[f]) || 0);
  const report = {
    execAt: kstNowStamp(),
    date: TODAY,
    productsTotal: products.length,
    otherTotal: otherRows.length,
    otherByMall: Object.fromEntries(otherByMall),
    malls: [coupangResult, adpickResult],

    /* ── 상품 단위 · collector 성과 (대표 지표) ── */
    targetProducts: sum('targetProducts'),
    collectorSuccessProducts: sum('collectorSuccessProducts'),
    collectorMissingProducts: sum('collectorMissingProducts'),

    /* ── 상품 단위 · 시도/매칭 분해 (하루 누적) ──
     *   39.6% 같은 낮은 값이 "못 찾아봐서" 인지 "찾아봤는데 없어서" 인지를
     *   이 세 줄이 갈라 준다 (collectorAttempted 주석 참고).
     *     attemptedProducts + skippedProducts        = targetProducts
     *     collectorSuccessProducts + noMatchProducts = attemptedProducts
     */
    attemptedProducts: sum('attemptedProducts'),
    skippedProducts: sum('skippedProducts'),
    noMatchProducts: sum('noMatchProducts'),

    /* ── 상품 단위 · 모든 기록 경로 (데이터 신선도) ── */
    todayPriceProducts: sum('todayPriceProducts'),
    uncoveredProducts: sum('uncoveredProducts'),

    /* ── attempt(수집 호출) 단위 ── */
    attemptCalls: sum('attemptCalls'),
    attemptSuccess: sum('attemptSuccess'),
    attemptFailed: sum('attemptFailed'),
    attemptCallsRecovery: sum('attemptCallsRecovery'),
    failCats: mergedFailureCategories,

    /* ── 행 단위 (DB 저장 결과) ── */
    recorded: sum('recorded'),
    saved: sum('saved'),
    suspect: sum('suspect'),
    rejected: sum('rejected'),

    /* ── 참고(실행 단위 상품 수) ── */
    processedProducts: sum('processedProducts'),

    /*
     * 남은 회수 큐 — 오늘 아직 부르지 않은 회수 검색어 수.
     * "미수집" 과 다르다: 미수집은 상품 수이고, 이것은 아직 남은 **시도 수단**이다.
     * 0 이면 오늘 쓸 수 있는 검색 전략을 다 쓴 것이고, 그래도 남은 미확보 상품은
     * 검색으로는 더 손댈 수 없다는 뜻이다.
     */
    recoveryQueueRemaining: sum('secondPassRemaining'),

    /* ── 패스별 성적 (전략 비교의 근거) ── */
    passStats: mergePassStats([coupangResult, adpickResult])
  };

  /*
   * ★ 모순된 숫자를 조용히 메일로 내보내지 않는다.
   *   여기서 걸리면 코드가 틀린 것이다 — 숫자를 맞추지 말고 원인을 고쳐야 한다.
   */
  const violations = reportInvariantErrors(report);
  const catTotal = Object.values(mergedFailureCategories).reduce((s, v) => s + v, 0);
  console.log('\n── 집계 검증 ──');
  console.log(`  수집성공 + 수집미확보 = 대상            ${report.collectorSuccessProducts} + ${report.collectorMissingProducts} = ${report.targetProducts}`);
  console.log(`  시도 + 미시도 = 대상                    ${report.attemptedProducts} + ${report.skippedProducts} = ${report.targetProducts}`);
  console.log(`  수집성공 + 무매칭 = 시도                ${report.collectorSuccessProducts} + ${report.noMatchProducts} = ${report.attemptedProducts}`);
  console.log(`  가격보유 + 미보유 = 대상 (모든 경로)     ${report.todayPriceProducts} + ${report.uncoveredProducts} = ${report.targetProducts}`);
  console.log(`  수집성공 ≤ 가격보유                      ${report.collectorSuccessProducts} ≤ ${report.todayPriceProducts}`);
  console.log(`  성공 attempt + 실패 attempt = 전체     ${report.attemptSuccess} + ${report.attemptFailed} = ${report.attemptCalls}`);
  console.log(`  failure reason 합계 = 실패 attempt      ${catTotal} = ${report.attemptFailed}`);
  if (violations.length) {
    console.error('★ 리포트 불변조건 위반 — 집계 코드가 틀렸습니다:');
    violations.forEach(v => console.error(`  - ${v}`));
  } else {
    console.log('  → 전부 OK');
  }
  report.invariantErrors = violations;

  await sendReport(report);

  /*
   * 실패는 반드시 빨갛게 끝내야 한다.
   *
   * 예전에는 무슨 일이 있어도 exit 0 이었다. 그래서 이 잡이 2026-07-30 이후로
   * 단 한 행도 저장하지 못하고 있었는데 GitHub Actions 는 계속 초록불이었고,
   * 아무도 몰랐다. (price_history 에 15:00 UTC 대 기록이 하루도 없다)
   *
   * 이제 아래 경우에는 exit 1 로 끝내서 Actions 가 실패 알림을 보내게 한다.
   *   - 두 몰 다 차단됨(둘 중 하나만 차단이면 절반은 정상 수집됐으므로 실패로 안 본다)
   *   - 시도한 상품이 있는데 두 몰 합쳐 한 행도 저장 못함
   */
  const coupangBlocked = _coupangBlocked || cs.blocked;
  const adpickBlocked = (_adpickBlocked || as.blocked) && adpickRows.length > 0;
  const bothBlocked = coupangBlocked && (adpickBlocked || adpickRows.length === 0);
  /*
   * ★ 판정 기준은 attempt 단위다 — 호출이 실제로 나갔는데 한 행도 못 남겼다면 실패다.
   *   (상품 수로 판정하면 "호출은 0회인데 상품은 많다" 같은 경로에서 오판한다)
   */
  const collectedNothing = report.attemptCalls > 0 && report.recorded === 0;

  if (bothBlocked || collectedNothing) {
    console.error('\n수집 실패로 처리합니다 (exit 1)');
    if (coupangBlocked) console.error('  - 쿠팡 API 차단 상태');
    if (adpickBlocked) console.error('  - ADPICK API 차단 상태');
    if (collectedNothing) console.error(`  - 이번 실행 수집 attempt ${report.attemptCalls}회 중 저장 0행`);
    console.error('  → 원인 확인:  node scripts/coupang-probe.js');
    process.exitCode = 1;
    return;
  }

  // 경고도 메일 헤드라인과 같은 지표를 쓴다 — 로그와 메일이 다른 말을 하면 안 된다.
  const rate = productSuccessRate(report);
  if (rate < 50) {
    console.warn(`경고: 상품 기준 수집 성공률 ${rate.toFixed(1)}%`
      + ` (${report.collectorSuccessProducts}/${report.targetProducts}) — 대상 상품 상당수를 이 수집기가 확보하지 못했습니다.`);
  } else if (rate < 80) {
    console.warn(`경고: 상품 기준 수집 성공률 ${rate.toFixed(1)}% < 80%`
      + ` (${report.collectorSuccessProducts}/${report.targetProducts})`);
  }
  if (coupangBlocked) console.warn('경고: 쿠팡 API 차단 상태 (ADPICK 은 영향받지 않음)');
  if (adpickBlocked) console.warn('경고: ADPICK API 차단 상태 (쿠팡은 영향받지 않음)');
}

// ─── 수집 결과 이메일 ────────────────────────────────────────────
const REPORT_EMAIL = process.env.PRICE_REPORT_EMAIL || 'yugeonbag091211@gmail.com';

/**
 * 리포트 숫자의 불변조건 검사.
 *
 * 이 함수가 리포트의 계약이다. 위반이 하나라도 있으면 그 메일은 서로
 * 모순되는 숫자를 담고 있다는 뜻이고, 원인은 언제나 집계 코드다.
 *
 *   1) 수집 성공 상품 + 수집 미확보 상품 = 대상 상품   (상품 단위 · collector)
 *   1-b) 시도 상품 + 미시도 상품 = 대상 상품           (상품 단위 · 시도 분해)
 *   1-c) 수집 성공 상품 + 무매칭 상품 = 시도 상품      (상품 단위 · 시도 분해)
 *   2) 오늘 가격 보유 + 미보유 = 대상 상품             (상품 단위 · 모든 경로)
 *   3) 실패 attempt = 모든 실패 원인의 합              (attempt 단위)
 *   4) 성공 attempt + 실패 attempt = 총 attempt        (attempt 단위)
 *   5) products 현재가 갱신 ≤ price_history upsert 행  (행 단위)
 *   6) 수집 성공 상품 ≤ 오늘 가격 보유 상품            (두 축의 포함관계)
 *      수집기가 확보한 상품은 반드시 오늘 가격이 있는 상품의 부분집합이다.
 *
 * @returns {string[]} 위반 설명. 비어 있으면 정상.
 */
function reportInvariantErrors(report) {
  const n = (v) => Number(v) || 0;
  const out = [];
  const target = n(report.targetProducts);
  const cOk = n(report.collectorSuccessProducts), cMiss = n(report.collectorMissingProducts);
  if (cOk + cMiss !== target) {
    out.push(`상품 단위(collector): 성공 ${cOk} + 미확보 ${cMiss} = ${cOk + cMiss} ≠ 대상 ${target}`);
  }
  /*
   *   1-b) 시도 + 미시도 = 대상            (상품 단위 · 시도 분해)
   *   1-c) 수집 성공 + 무매칭 = 시도       (상품 단위 · 시도 분해)
   * 이 둘이 깨지면 "시도율이 문제냐 매칭률이 문제냐" 라는 질문 자체가
   * 성립하지 않는다 — 두 축이 같은 모집단을 나누고 있지 않다는 뜻이다.
   */
  const att = n(report.attemptedProducts), skp = n(report.skippedProducts), nm = n(report.noMatchProducts);
  if (att + skp !== target) {
    out.push(`상품 단위(시도): 시도 ${att} + 미시도 ${skp} = ${att + skp} ≠ 대상 ${target}`);
  }
  if (cOk + nm !== att) {
    out.push(`상품 단위(시도): 수집 성공 ${cOk} + 무매칭 ${nm} = ${cOk + nm} ≠ 시도 ${att}`);
  }
  const ok = n(report.todayPriceProducts), unc = n(report.uncoveredProducts);
  if (ok + unc !== target) {
    out.push(`상품 단위(모든 경로): 보유 ${ok} + 미보유 ${unc} = ${ok + unc} ≠ 대상 ${target}`);
  }
  if (cOk > ok) {
    out.push(`포함관계: 수집 성공 ${cOk} > 오늘 가격 보유 ${ok} — 수집기가 확보한 상품은`
      + ` 오늘 가격이 있는 상품의 부분집합이어야 한다`);
  }
  const catSum = Object.values(report.failCats || {}).reduce((s, v) => s + n(v), 0);
  if (catSum !== n(report.attemptFailed)) {
    out.push(`attempt 단위: 실패 ${n(report.attemptFailed)} ≠ 실패 원인 합계 ${catSum}`);
  }
  if (n(report.attemptSuccess) + n(report.attemptFailed) !== n(report.attemptCalls)) {
    out.push(`attempt 단위: 성공 ${n(report.attemptSuccess)} + 실패 ${n(report.attemptFailed)}`
      + ` ≠ 총 attempt ${n(report.attemptCalls)}`);
  }
  if (n(report.saved) > n(report.recorded)) {
    out.push(`행 단위: products 갱신 ${n(report.saved)} > price_history 저장 ${n(report.recorded)}`);
  }
  return out;
}

/**
 * 상품 기준 수집 성공률 — Daily Collection Report 의 대표 지표.
 *
 * ★ 분자는 **수집기가 오늘 직접 확보한 상품** 이다. price_history 에 오늘
 *   행이 있는 상품(=todayPriceProducts)이 아니다. 그 값을 쓰면 사용자 검색이나
 *   Vercel cron 이 남긴 가격까지 수집기 성과로 세어져, 수집기가 죽은 날에도
 *   성공률이 올라가 장애를 가린다. 분모는 언제나 수집 대상 상품 수다.
 */
function productSuccessRate(report) {
  const target = Number(report.targetProducts) || 0;
  if (target <= 0) return 100;
  return (Number(report.collectorSuccessProducts) || 0) / target * 100;
}

/**
 * 오늘 가격 보유율 — 데이터 신선도 참고 지표.
 * 기록 경로를 가리지 않고 "오늘 가격이 있는 대상 상품" 의 비율이다.
 * 절대 위 수집 성공률과 같은 이름으로 표시하지 않는다.
 */
function todayPriceRate(report) {
  const target = Number(report.targetProducts) || 0;
  if (target <= 0) return 100;
  return (Number(report.todayPriceProducts) || 0) / target * 100;
}

/*
 * 수집 결과 메일.
 *
 * ★ 이 메일의 규칙 하나: 한 칸에는 한 단위만 담는다.
 *
 *   상품 단위    대상 / 성공 상품 / 미수집 상품        (하루 누적, 분모 = 대상)
 *   attempt 단위 수집 attempt / 성공·실패 / 실패 원인  (collector 호출 1회 = 1)
 *   행 단위      price_history 저장 / products 갱신 / 급변 보류 / 값 이상 거부
 *
 *   2026-09-01 리포트가 "실패 26 인데 실패 원인 합계 151" 로 나온 것은
 *   실패 개수는 검색어 단위, noMatch 는 상품 단위였기 때문이다. 그래서
 *   섹션 제목에까지 단위를 적는다 — 읽는 사람이 단위를 추측할 일이 없어야 한다.
 */
function buildReportHtml(report) {
  const {
    execAt, date, productsTotal, otherTotal, otherByMall, malls, failCats,
    targetProducts, collectorSuccessProducts, collectorMissingProducts,
    attemptedProducts, skippedProducts, noMatchProducts,
    todayPriceProducts, uncoveredProducts,
    attemptCalls, attemptSuccess, attemptFailed, attemptCallsRecovery,
    recorded, saved, suspect, rejected, processedProducts,
    passStats, recoveryQueueRemaining
  } = report;

  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function pct(v) { return v != null ? v.toFixed(1) + '%' : '-'; }
  /** 분모가 0 이면 비율을 지어내지 않고 '-' 로 남긴다. */
  function rateOf(n0, d0) { const d = Number(d0) || 0; return d > 0 ? (Number(n0) || 0) / d * 100 : null; }
  const num = (v) => Number(v) || 0;

  const rate = productSuccessRate(report);
  const freshRate = todayPriceRate(report);
  const statusColor = rate >= 80 ? '#0b7a4b' : rate >= 50 ? '#b5850b' : '#c9362b';

  const row = (label, value, opts = {}) => `
      <tr><td style="padding:5px 0;color:#666;font-size:13px">${label}</td>
          <td style="padding:5px 0;text-align:right;font-weight:${opts.bold ? 700 : 500};color:${opts.color || '#111'}">${value}</td></tr>`;

  const mallRows = (malls || []).map(m => `
    <tr>
      <td style="padding:8px 12px;font-weight:700;color:#111;border-top:1px solid #eee">${esc(m.mallName)}</td>
      <td style="padding:8px 12px;text-align:right;border-top:1px solid #eee">${num(m.targetProducts)}</td>
      <td style="padding:8px 12px;text-align:right;color:#0b7a4b;border-top:1px solid #eee">${num(m.collectorSuccessProducts)}</td>
      <td style="padding:8px 12px;text-align:right;border-top:1px solid #eee">${num(m.todayPriceProducts)}</td>
      <td style="padding:8px 12px;text-align:right;border-top:1px solid #eee">${num(m.attemptCalls)}</td>
      <td style="padding:8px 12px;text-align:right;color:#c9362b;border-top:1px solid #eee">${num(m.attemptFailed)}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;border-top:1px solid #eee">${num(m.recorded)}</td>
    </tr>`).join('');

  const otherRow = otherTotal > 0 ? `
    <tr>
      <td style="padding:8px 12px;color:#888;border-top:1px solid #eee">기타 (${esc(Object.keys(otherByMall || {}).join(', ') || '연동 없음')})</td>
      <td style="padding:8px 12px;text-align:right;color:#888;border-top:1px solid #eee">${otherTotal}</td>
      <td colspan="5" style="padding:8px 12px;text-align:right;color:#888;border-top:1px solid #eee">재조회 API 없음 — 대상 제외</td>
    </tr>` : '';

  /*
   * 실패 원인은 값이 0이어도 전부 적는다. 0인 줄을 지우면 "이번엔 왜 안 보이지"
   * 를 매번 다시 따져야 하고, 합계가 맞는지도 눈으로 확인할 수 없다.
   */
  const passRows = (passStats || []).length
    ? passStats.map(s => {
        const per = s.calls > 0 ? (s.recovered / s.calls).toFixed(2) : '-';
        return `<tr>
          <td style="padding:6px 12px;border-top:1px solid #eee;font-weight:600">${esc(s.pass)}</td>
          <td style="padding:6px 12px;text-align:right;border-top:1px solid #eee">${num(s.calls)}</td>
          <td style="padding:6px 12px;text-align:right;border-top:1px solid #eee">${num(s.ok)}</td>
          <td style="padding:6px 12px;text-align:right;border-top:1px solid #eee">${num(s.success)}</td>
          <td style="padding:6px 12px;text-align:right;border-top:1px solid #eee;color:#0b7a4b;font-weight:600">${num(s.recovered)}</td>
          <td style="padding:6px 12px;text-align:right;border-top:1px solid #eee">${esc(per)}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="6" style="padding:6px 12px;color:#888;border-top:1px solid #eee">이번 실행은 수집 호출이 없었습니다</td></tr>';

  const catEntries = Object.entries(failCats || {});
  const catSum = catEntries.reduce((s, [, v]) => s + num(v), 0);
  const catRows = catEntries.length
    ? catEntries.map(([k, v]) => `<tr><td style="padding:4px 0;color:#666;font-size:13px">${esc(k)}</td>`
        + `<td style="padding:4px 0;text-align:right;font-weight:${num(v) ? 600 : 400};color:${num(v) ? '#c9362b' : '#bbb'}">${num(v)}</td></tr>`).join('')
    : '<tr><td style="padding:4px 0;color:#888;font-size:13px" colspan="2">실패 attempt 없음</td></tr>';

  /*
   * 집계 검증 블록 — 세 단위의 항등식을 숫자와 함께 그대로 보여 준다.
   * 읽는 사람이 "이 메일의 숫자끼리 앞뒤가 맞는가"를 계산기 없이 확인할 수 있어야 한다.
   */
  const checks = [
    ['수집 성공 상품 + 수집 미확보 상품 = 대상 상품',
      `${num(collectorSuccessProducts)} + ${num(collectorMissingProducts)} = ${num(targetProducts)}`,
      num(collectorSuccessProducts) + num(collectorMissingProducts) === num(targetProducts)],
    ['시도 상품 + 미시도 상품 = 대상 상품',
      `${num(attemptedProducts)} + ${num(skippedProducts)} = ${num(targetProducts)}`,
      num(attemptedProducts) + num(skippedProducts) === num(targetProducts)],
    ['수집 성공 상품 + 무매칭 상품 = 시도 상품',
      `${num(collectorSuccessProducts)} + ${num(noMatchProducts)} = ${num(attemptedProducts)}`,
      num(collectorSuccessProducts) + num(noMatchProducts) === num(attemptedProducts)],
    ['오늘 가격 보유 + 미보유 = 대상 상품',
      `${num(todayPriceProducts)} + ${num(uncoveredProducts)} = ${num(targetProducts)}`,
      num(todayPriceProducts) + num(uncoveredProducts) === num(targetProducts)],
    ['수집 성공 상품 ≤ 오늘 가격 보유 상품',
      `${num(collectorSuccessProducts)} ≤ ${num(todayPriceProducts)}`,
      num(collectorSuccessProducts) <= num(todayPriceProducts)],
    ['성공 attempt + 실패 attempt = 전체 attempt',
      `${num(attemptSuccess)} + ${num(attemptFailed)} = ${num(attemptCalls)}`,
      num(attemptSuccess) + num(attemptFailed) === num(attemptCalls)],
    ['모든 failure reason 합계 = 실패 attempt',
      `${catSum} = ${num(attemptFailed)}`,
      catSum === num(attemptFailed)]
  ];
  const checkRows = checks.map(([label, expr, okFlag]) => `
      <tr><td style="padding:4px 0;color:#666">${label}</td>
          <td style="padding:4px 0;text-align:right;color:#888">${esc(expr)}</td>
          <td style="padding:4px 0 4px 12px;text-align:right;font-weight:700;color:${okFlag ? '#0b7a4b' : '#c9362b'}">${okFlag ? 'OK' : 'NG'}</td></tr>`).join('');

  const errors = report.invariantErrors || [];
  const warnBanner = errors.length ? `
  <tr><td style="padding:16px 32px 0">
    <div style="background:#fdf2f2;border:1px solid #f3c9c5;border-radius:8px;padding:12px 16px;font-size:12px;color:#c9362b">
      <b>⚠️ 집계 불변조건 위반</b><br>${errors.map(esc).join('<br>')}
      <div style="color:#a06">이 메일의 숫자를 신뢰하지 마세요 — 집계 코드를 고쳐야 합니다.</div>
    </div>
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEOSA 가격 수집 리포트</title></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 0">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:620px;width:100%">
  <tr><td style="background:#111;padding:24px 32px">
    <div style="font-size:20px;font-weight:800;letter-spacing:.12em;color:#fff">SEOSA</div>
    <div style="font-size:10px;color:#888;letter-spacing:.15em;margin-top:2px">DAILY PRICE COLLECTION REPORT</div>
  </td></tr>
  <tr><td style="padding:24px 32px 8px">
    <div style="font-size:14px;color:#888;margin-bottom:8px">기준 날짜 (KST)</div>
    <div style="font-size:28px;font-weight:800;color:#111;letter-spacing:-.02em">${esc(date)}</div>
    <div style="font-size:12px;color:#aaa;margin-top:4px">실행 시각: ${esc(execAt)}</div>
  </td></tr>
  ${warnBanner}
  <tr><td style="padding:8px 32px 0">
    <div style="font-size:12px;color:#888;margin-bottom:6px">상품 기준 수집 성공률 <span style="color:#bbb">(collector 전용)</span></div>
    <div style="display:inline-block;background:${statusColor};color:#fff;font-size:15px;font-weight:800;padding:6px 18px;border-radius:20px">
      ${pct(rate)} (${num(collectorSuccessProducts)}/${num(targetProducts)})
    </div>
    <div style="font-size:11px;color:#aaa;margin-top:6px">
      이 수집기가 오늘 직접 확보한 상품 ÷ 수집 대상 상품 (오늘 KST 누적).<br>
      사용자 검색 · Vercel cron · AI 가 남긴 가격은 포함하지 않는다.
    </div>
    <div style="margin-top:10px;font-size:12px;color:#666">
      오늘 가격 보유율 <span style="color:#bbb">(모든 기록 경로)</span>
      <b style="color:#111">${pct(freshRate)} (${num(todayPriceProducts)}/${num(targetProducts)})</b>
    </div>
    <div style="font-size:11px;color:#aaa;margin-top:2px">데이터 신선도 참고 지표 — 수집 성공률과 다른 값이다.</div>
  </td></tr>

  <tr><td style="padding:20px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:4px">상품 현황 <span style="color:#bbb;font-weight:400">(단위: 상품)</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">
      ${row('쿠팡·ADPICK 수집 대상', num(targetProducts), { bold: true })}
      ${row('수집 성공 상품 <span style="color:#bbb">(collector)</span>', num(collectorSuccessProducts), { bold: true, color: '#0b7a4b' })}
      ${row('수집 미확보 상품 <span style="color:#bbb">(collector)</span>', num(collectorMissingProducts), { bold: true })}
      ${row('오늘 가격 보유 상품 <span style="color:#bbb">(모든 경로)</span>', num(todayPriceProducts))}
      ${row('오늘 가격 미보유 상품 <span style="color:#bbb">(모든 경로)</span>', num(uncoveredProducts))}
    </table>
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin:14px 0 4px">병목 분해 <span style="color:#bbb;font-weight:400">(단위: 상품 · 하루 누적)</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">
      ${row('시도한 상품 <span style="color:#bbb">(호출이 실제로 나감)</span>', num(attemptedProducts))}
      ${row('미시도 상품 <span style="color:#bbb">(차단·예산·상한으로 못 부름)</span>', num(skippedProducts))}
      ${row('시도했으나 무매칭 <span style="color:#bbb">(응답에 우리 product_id 없음)</span>', num(noMatchProducts))}
      ${row('시도율 <span style="color:#bbb">attempted ÷ eligible</span>', pct(rateOf(attemptedProducts, targetProducts)), { bold: true })}
      ${row('시도 대비 성공률 <span style="color:#bbb">success ÷ attempted</span>', pct(rateOf(collectorSuccessProducts, attemptedProducts)), { bold: true })}
      ${row('전체 수집 성공률 <span style="color:#bbb">success ÷ eligible</span>', pct(rateOf(collectorSuccessProducts, targetProducts)), { bold: true })}
    </table>
    <div style="font-size:11px;color:#bbb;margin-top:4px">
      시도 ${num(attemptedProducts)} + 미시도 ${num(skippedProducts)} = 대상 ${num(targetProducts)}<br>
      수집 성공 ${num(collectorSuccessProducts)} + 무매칭 ${num(noMatchProducts)} = 시도 ${num(attemptedProducts)}<br>
      ※ 시도율이 낮으면 시간·호출 예산 문제이고, 시도 대비 성공률이 낮으면 검색어·매칭 문제다.
    </div>
    <div style="font-size:11px;color:#bbb;margin-top:4px">
      수집 성공 ${num(collectorSuccessProducts)} + 수집 미확보 ${num(collectorMissingProducts)} = 대상 ${num(targetProducts)}<br>
      가격 보유 ${num(todayPriceProducts)} + 미보유 ${num(uncoveredProducts)} = 대상 ${num(targetProducts)}<br>
      ※ 두 축의 차이 ${Math.max(0, num(todayPriceProducts) - num(collectorSuccessProducts))}개는 이 수집기가 아닌 경로(사용자 검색 · Vercel cron · AI)가 남긴 가격이다.
    </div>
  </td></tr>

  <tr><td style="padding:20px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:4px">수집 실행 <span style="color:#bbb;font-weight:400">(단위: attempt = 실제 API 호출 1회 / 저장은 행)</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">
      ${row('수집 attempt (실제 API 호출)', num(attemptCalls), { bold: true })}
      ${row('&nbsp;&nbsp;└ 1차 검색 / 회수 패스',
            `${num(attemptCalls) - num(attemptCallsRecovery)} / ${num(attemptCallsRecovery)}`)}
      ${row('성공 attempt', num(attemptSuccess), { color: '#0b7a4b' })}
      ${row('실패 attempt', num(attemptFailed), { color: '#c9362b' })}
      ${row('처리 상품 수 (검색 그룹에 담아 돌린 상품)', num(processedProducts))}
      ${row('price_history upsert 행 (신규+갱신)', num(recorded), { bold: true, color: '#0b7a4b' })}
      ${row('products 현재가 갱신 (행)', num(saved))}
      ${row('급변 보류 (행)', num(suspect))}
      ${row('값 이상 거부 (행)', num(rejected))}
    </table>
    <div style="font-size:11px;color:#bbb;margin-top:4px">
      성공 attempt ${num(attemptSuccess)} + 실패 attempt ${num(attemptFailed)} = 수집 attempt ${num(attemptCalls)}<br>
      ※ 처리 상품 수는 호출 횟수가 아니다 — 한 attempt(검색어 1회 호출)가 여러 상품을 덮는다.<br>
      ※ price_history 값은 upsert 로 보낸 행 수다. 같은 날 같은 (상품·몰·vendor)을 다시
      수집하면 UNIQUE 제약으로 기존 행을 덮으므로, DB 에 새로 생긴 행 수는 이보다 적을 수 있다.
    </div>
  </td></tr>

  <tr><td style="padding:20px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:4px">패스별 성적 <span style="color:#bbb;font-weight:400">(어느 검색 전략이 얼마에 얼마를 건졌나)</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border:1px solid #eee;border-radius:6px">
      <tr style="background:#f8f8f7">
        <td style="padding:6px 12px;color:#888;font-size:11px">패스</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">호출</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">응답</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">적중 호출</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">회수 상품</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">호출당 회수</td>
      </tr>
      ${passRows}
    </table>
    <div style="font-size:11px;color:#bbb;margin-top:4px">
      pass1 = 1차 키워드 검색 · facet = 큰 그룹 분할 · r1~r9 = 상품별 검색어 사다리(라운드).<br>
      ※ 비교 기준은 "호출당 회수" 다 — 한 호출이 여러 상품을 덮으므로 회수 상품 수만으로는 전략을 비교할 수 없다.<br>
      남은 회수 큐(오늘 아직 안 부른 검색어): <b>${num(recoveryQueueRemaining)}</b>종
    </div>
  </td></tr>

  <tr><td style="padding:20px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:4px">실패 attempt <span style="color:#bbb;font-weight:400">(단위: attempt)</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">
      ${row('총 실패 attempt', num(attemptFailed), { bold: true, color: '#c9362b' })}
      ${catRows}
    </table>
    <div style="font-size:11px;color:${catSum === num(attemptFailed) ? '#bbb' : '#c9362b'};margin-top:4px">
      실패 원인 합계 ${catSum} = 총 실패 attempt ${num(attemptFailed)}
    </div>
  </td></tr>

  <tr><td style="padding:20px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:8px">몰별 결과</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border:1px solid #eee;border-radius:6px">
      <tr style="background:#f8f8f7">
        <td style="padding:6px 12px;color:#888;font-size:11px">몰</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">대상<br>(상품)</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">수집성공<br>(상품)</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">가격보유<br>(상품)</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">attempt</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">실패<br>(attempt)</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">저장<br>(행)</td>
      </tr>
      ${mallRows}${otherRow}
    </table>
  </td></tr>

  <tr><td style="padding:20px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:8px">전체 products (참고)</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">
      ${row('products 전체', num(productsTotal))}
    </table>
  </td></tr>

  <tr><td style="padding:20px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:6px">집계 검증</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-top:1px solid #eee">
      ${checkRows}
    </table>
  </td></tr>

  <tr><td style="background:#f8f8f7;padding:16px 32px;text-align:center;margin-top:24px">
    <div style="font-size:11px;color:#aaa">SEOSA Daily Price Collection Report</div>
    <div style="font-size:11px;color:#ccc;margin-top:4px">이 메일은 매일 자동 발송됩니다.</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}


async function sendReport(report) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[리포트] RESEND_API_KEY 없음 — 수집 결과 이메일을 보내지 않습니다.');
    return;
  }
  try {
    const email = require('../api/_channel/email');
    // 제목도 본문 헤드라인과 같은 지표·같은 분모를 쓴다 (상품 단위).
    const rate = productSuccessRate(report);
    const result = await email.send({
      to: REPORT_EMAIL,
      subject: `[SEOSA] ${report.date} 가격 수집 리포트 — 수집 성공률 ${rate.toFixed(1)}%`
        + ` (${report.collectorSuccessProducts || 0}/${report.targetProducts || 0})`,
      html: buildReportHtml(report)
    });
    if (result.ok) {
      console.log(`[리포트] 수집 결과 이메일 발송 완료 → ${REPORT_EMAIL} (id=${result.id || '?'})`);
    } else {
      console.error(`[리포트] 이메일 발송 실패: ${result.error}`);
    }
  } catch (e) {
    console.error(`[리포트] 이메일 발송 중 오류 (수집 결과에는 영향 없음): ${e.message}`);
  }
}

/**
 * run() 이 이메일 코드에 닿기도 전에 죽었을 때(예: products 조회 실패,
 * price_job_state 테이블 없음, 그 밖의 예상 못 한 예외) 그래도 "오늘 수집이
 * 실패했다"는 사실만은 이메일로 알린다.
 *
 * ★ 이게 없으면 예외가 조기에 터진 날은 이메일 자체가 통째로 안 온다 —
 *   운영자는 "메일이 안 왔다 = 별일 없었나 보다"로 오해하게 된다. 반드시
 *   와야 할 신호가 조용히 사라지는 것이 가장 나쁜 실패 모드다.
 */
async function sendFailureNotice(err) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const email = require('../api/_channel/email');
    const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head>
<body style="font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;padding:32px;background:#f5f5f4">
<div style="background:#fff;border-radius:12px;padding:32px;max-width:560px;margin:0 auto">
  <div style="font-size:18px;font-weight:800;color:#c9362b">⚠️ SEOSA 가격 수집 — 실행 자체가 실패했습니다</div>
  <div style="font-size:13px;color:#888;margin-top:8px">기준 날짜(KST): ${TODAY} / 실행 시각: ${kstNowStamp()}</div>
  <div style="margin-top:20px;padding:16px;background:#fdf2f2;border-radius:8px;font-size:13px;color:#c9362b;white-space:pre-wrap;word-break:break-word">${
    String((err && err.message) || err).replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 2000)
  }</div>
  <div style="margin-top:16px;font-size:12px;color:#aaa">몰별 수집 로직에 도달하기 전에 예외가 발생해, 몰별 결과 집계 없이 이 알림만 보냅니다. GitHub Actions 로그를 확인하세요.</div>
</div>
</body></html>`;
    const result = await email.send({
      to: REPORT_EMAIL,
      subject: `[SEOSA] ${TODAY} 가격 수집 실패 — 실행 자체가 중단됨`,
      html
    });
    console.log(result.ok
      ? `[리포트] 실패 알림 이메일 발송 완료 → ${REPORT_EMAIL}`
      : `[리포트] 실패 알림 이메일 발송도 실패: ${result.error}`);
  } catch (e) {
    console.error(`[리포트] 실패 알림 이메일 발송 중 오류: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ *
 *  테스트용 노출.
 *
 *  scripts/test-price-batch.js 가 쿠팡 호출 없이 배치·커서·날짜 로직만
 *  검증한다. require 해도 run() 이 돌지 않도록 아래에서 가드한다.
 * ------------------------------------------------------------------ */
module.exports = {
  kstToday, buildPlan, splitBatches, resumeFrom, BATCH_PRODUCTS, buildReportHtml,
  runMallCollection, categorizeFailure, isCoupangRow, isAdpickRow,
  // 판매 단위(옵션) 게이트 — test-option-identity 가 이 계약을 고정한다.
  pickOption,
  /*
   * 몰별 검색 경로. 운영 실행(run)이 쓰는 것과 **같은 함수**다.
   *
   * 소량 스모크 테스트가 대상 상품만 골라 돌릴 때 이걸 그대로 넘긴다 —
   * 검증용으로 비슷한 경로를 새로 만들면 정작 운영에서 도는 코드를
   * 검증하지 못한다. 노출만 하고 동작은 손대지 않는다.
   */
  fetchCoupangAll, fetchAdpickAll,
  // 리포트 집계의 계약 — 테스트가 이 둘로 불변조건을 고정한다.
  reportInvariantErrors, productSuccessRate, todayPriceRate,
  // 동시 실행 방지 — test-price-mall-collection 이 CAS/만료/보존을 고정한다.
  acquireLock, releaseLock, LOCK_TTL_MS
};

if (require.main === module) {
  run().catch(async e => {
    console.error('치명적 오류:', e.message, e.stack);
    /*
     * 메일과 별개로 오류 추적에도 보낸다. 메일은 사람이 읽어야 알고,
     * 여기는 스택까지 남아 원인을 바로 짚을 수 있다.
     * SENTRY_DSN 이 없으면 조용히 no-op 이라 로컬/CI 에 영향이 없다.
     */
    try {
      await require('../api/_errors').captureException(e, {
        where: 'collector', route: 'scripts/collect-all-prices.js',
        extra: { jobDate: TODAY, runId: process.env.GITHUB_RUN_ID || 'local' }
      });
    } catch (_) { /* 보고 실패가 종료를 막지 않는다 */ }
    await sendFailureNotice(e);
    process.exit(1);
  });
}
