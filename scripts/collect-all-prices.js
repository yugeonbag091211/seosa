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

/*
 * ★ 전체 카탈로그 회전 수집 (2026-09-21).
 *
 * 상시 추적 대상(collector_eligible_products)은 매일 그대로 수집하고,
 * bulk seed 전용 상품은 고정 해시 버킷으로 나눠 하루에 한 버킷씩 추가한다.
 * 기본 7버킷이라 정상적으로 한 바퀴가 끝나면 모든 지원 몰 상품이 7일 안에
 * 최소 한 번은 collector 대상이 된다.
 *
 * 중요한 점:
 *   - PRICE_INCLUDE_BULK_SEED=1 처럼 7만 행을 매 실행 전부 읽지 않는다.
 *   - 같은 상품은 product_id|mall 해시로 항상 같은 버킷에 들어간다.
 *   - 상시 추적 상품은 회전 버킷에서 제외하므로 중복 대상이 없다.
 *   - API 분당 제한/실행 예산/하루 예산은 전혀 올리지 않는다.
 */
const BULK_ROTATION_ENABLED = process.env.PRICE_BULK_ROTATION !== '0';
const BULK_ROTATION_DAYS = Math.max(1, Number(process.env.PRICE_BULK_ROTATION_DAYS) || 7);
const COLLECTOR_TARGET_VERSION = 'rotation-v1';

/*
 * ★ 수집기 V3 (2026-09-23) — PRICE_COLLECTOR_V3=1 일 때만 켜진다. 꺼져 있으면
 *   아래 네 값이 전부 false 이고 레거시 동작은 한 줄도 달라지지 않는다.
 *
 *   PLANNER     1차 그룹을 가나다순 대신 기대 회수량 순으로 부른다 (api/_collectplan.js)
 *   PARALLEL    쿠팡·ADPICK 을 한 실행 안에서 동시에 돌린다. 두 제공자의 분당 한도는
 *               서로 독립이라 병렬로 돌려도 어느 쪽의 호출 속도도 바뀌지 않는다.
 *               바뀌는 것은 ADPICK 이 받는 «시간» 이다 — 실측(2026-09-16~23 로그)으로
 *               정상일 작업 실행 8회×50분 중 ADPICK 몫은 64~148분뿐이었다.
 *   CHECKPOINT  배치마다(최소 간격 CHECKPOINT_MIN_INTERVAL_MS) 진행 상태를 저장하고,
 *               모든 상태 쓰기를 «우리 잠금일 때만» 한다. 예전에는 실행 끝에 한 번만
 *               저장해서 프로세스가 죽으면 그 실행의 진행을 통째로 잃었다.
 *   하위 플래그로 하나씩 끌 수 있다: PRICE_V3_PLANNER=0 / PRICE_V3_PARALLEL=0 / PRICE_V3_CHECKPOINT=0
 */
const V3 = process.env.PRICE_COLLECTOR_V3 === '1' && !SEED_ONLY;
const V3_PLANNER = V3 && process.env.PRICE_V3_PLANNER !== '0';
const V3_PARALLEL = V3 && process.env.PRICE_V3_PARALLEL !== '0';
const V3_CHECKPOINT = V3 && process.env.PRICE_V3_CHECKPOINT !== '0';
const CHECKPOINT_MIN_INTERVAL_MS = Number(process.env.PRICE_CHECKPOINT_INTERVAL_MS) || 90 * 1000;
/*
 * ADPICK 하루 호출 상한 (V3 전용). 레거시는 하루 268~738회(2026-09-16~23, 장애일 제외)라
 * 이 벽이 필요 없었다. 병렬 실행은 하루 ADPICK 호출을 약 1,960회까지 늘릴 수 있다(추정).
 *
 * ★ 2026-09-23 공식 가이드 확인: 상품 검색은 «분당 10회(API 키 기준)» 이고 일일 한도는
 *   적혀 있지 않다. 09-01 이후 429 22건도 전부 분당 초과(직전 60초 11·12번째)였다.
 *   그래도 «일일 한도 없음» 을 공급자에게 확인받은 것은 아니므로, 기본값은 최근 레거시
 *   사용량 범위(최대 738) 안인 740 으로 둔다. 늘리려면 카나리 실측 뒤 env 로 올린다.
 */
const ADPICK_DAY_BUDGET = Number(process.env.ADPICK_DAY_BUDGET) || 740;
const Planner = require('../api/_collectplan');

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
/*
 * ★ 2,200 → 2,800 (2026-09-08 감사). 근거는 «한계수익이 아직 안 꺾였다» 는 실측이다.
 *
 *   일별 실측 (coupang_api_calls × price_history, 읽기 전용 조회):
 *     KST 09-03   호출 2,128 → 쿠팡 1,369/1,648 (83.1%)
 *     KST 09-06   호출 2,200 ← 상한 소진 → 1,379 (83.7%)
 *     KST 09-07   호출 2,200 ← 상한 소진 → 1,346 (81.7%)
 *   즉 좋은 날의 천장을 만든 것은 시간도 검색 품질도 아니고 이 상수였다.
 *
 *   그리고 호출을 더 해도 수익이 떨어지지 않는다. 같은 날 회수 패스의
 *   100호출 구간별 회수량(2026-09-08 실행 로그 34161068885·34164621465 에서 계산):
 *     1-100  0.40/호출   151-250  0.64   301-400  0.62   401-500  0.64
 *   887회까지 평평하다. 포화 곡선이 아니라 직선이라, 상한을 올린 만큼
 *   그대로 회수로 돌아온다 (실측 기울기 0.6개/호출).
 *
 *   2,800 인 근거: 남은 미수집 중 «도달 가능이 증명된» 상품(최근 14일 안에
 *   최소 한 번 수집된 적 있는 상품)을 0.6개/호출로 덮는 데 필요한 양이
 *   +600회다. 그 위로는 구조적 불가 87개(14일간 전무 = 색인 이탈/판매 종료)
 *   뿐이라 호출을 더 줘도 살 것이 없다. "쓸 수 있는 만큼" 이 아니라
 *   "살 것이 남아 있는 만큼" 이다.
 *
 * ★ 분당 호출 속도는 한 자리도 바뀌지 않는다. 세 겹 그대로다 —
 *   COUPANG_MIN_GAP_MS(6초, 분당 10회) / _coupang.MAX_PER_MIN(전역 분당 20회)
 *   / 쿠팡 공식 한도(검색 50회/분). 이 값은 하루 총량의 천장일 뿐이고,
 *   scripts/test-second-pass.js 가 간격 6000ms 를 소스에서 그대로 고정한다.
 */
/*
 * ★ 2,800 → 3,400 (2026-09-19).
 *
 * bulk seed 카탈로그를 일일 대상에서 분리한 뒤 운영 대상은 쿠팡 1,831개가 됐다.
 * 이 중 최근 14일 안에 실제로 한 번 이상 잡힌 상품은 1,679개(91.7%)라 90%
 * 목표는 도달 가능하다. 반면 최근 2,800호출 날의 현재 대상 기준 일일 보유는
 * 약 1,300대였고, 09-08 실측 한계수익(~0.6개/추가 호출)을 적용하면 90%까지
 * 약 500여 호출이 더 필요하다. 그래서 여유를 포함해 3,400으로 둔다.
 *
 * 분당 속도는 바꾸지 않는다. COUPANG_MIN_GAP_MS=6000과 _coupang의 전역
 * 분당 제한은 그대로이며, 이 값은 KST 하루 총량의 천장만 넓힌다.
 */
const COUPANG_DAY_BUDGET = Number(process.env.COUPANG_DAY_BUDGET) || 3400;

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

/*
 * ── 일시적 차단을 기다리는 규칙 (2026-09-08) ─────────────────────────
 *
 * runMallCollection 의 waitOutTemporaryBlock 주석에 근거가 있다. 여기서는
 * 두 숫자의 뜻만 적는다.
 *
 *   RECOVERY_BLOCK_WAIT_MS    한 번에 쉬는 시간.
 *     30초인 이유: 가장 흔한 차단이 api/_adpick.js 의 네트워크 서킷 2분이다.
 *     30초씩 끊어 자면 최대 4회 만에 풀리고, 그동안 deadline 검사도 30초마다
 *     한 번씩 지나간다. 더 길게 자면 «이미 풀렸는데 자고 있는» 시간이 늘고,
 *     더 짧게 자면 풀리지도 않은 차단을 헛되이 두드린다(호출은 안 나가지만
 *     연속 카운터만 빨리 찬다).
 *
 *   RECOVERY_BLOCK_MAX_WAITS  연속 몇 번까지 기다릴지. 6회 = 최대 3분.
 *     2분짜리 네트워크 차단은 넉넉히 덮고, 15분(HTTP 429)·60분(403·401)짜리
 *     진짜 차단은 3분 만에 포기해 예전과 같이 실행을 끝낸다. 즉 이 값은
 *     "짧은 딸꾹질과 진짜 차단을 가르는 선" 이다.
 *
 * ★ 이 값들은 호출 속도와 무관하다. 기다리는 동안 호출은 0회다.
 */
const RECOVERY_BLOCK_WAIT_MS   = Number(process.env.PRICE_RECOVERY_BLOCK_WAIT_MS) || 30 * 1000;
const RECOVERY_BLOCK_MAX_WAITS = Number(process.env.PRICE_RECOVERY_BLOCK_MAX_WAITS) || 6;

/*
 * ── 옵션 게이트 "확정" 임계값 (P1, 2026-09-06) ──────────────────
 *
 * 우리 옵션이 없는 응답을 **몇 번 연속으로** 봐야 "오늘은 이 상품의 옵션을
 * 검색으로 만날 수 없다" 고 확정할 것인가. terminalOption 주석 참고.
 *
 * ★ 1 이면 안 된다. 처음에 그렇게 설계했고, 운영 데이터가 그것을 반박했다.
 *
 *   전제는 "OPTION_MISMATCH 는 결정론적이다 — 검색어를 바꿔도 같은 옵션이
 *   온다" 였다. 틀렸다. 쿠팡 검색은 **검색어마다 다른 옵션을 대표로 싣는다.**
 *
 *   실측 (2026-09-06 KST 운영 데이터 재현, 오늘 응답에 등장한 쿠팡 상품 1,401개):
 *     연속 불일치   상품수   그런데 결국 우리 옵션이 나온 비율(=오판율)
 *          1회        97        69.1%   ← 첫 불일치로 끊으면 3분의 2가 오판
 *          2회        43        41.9%
 *          3회        35        34.3%
 *          4회        17        23.5%
 *          5회        16        12.5%
 *         6회+        32        15.6%
 *
 *   즉 1회로 끊으면 오늘 하루에만 회수 53개를 잃는다(호출 494회 절약).
 *   3회로 끊으면 잃는 회수 13개 / 절약 181회다.
 *
 * ★ 3 을 고른 근거. 오판율이 69% → 42% → 34% 로 급히 떨어진 뒤 평평해진다.
 *   그 무릎이 3이다. 더 올리면 잃는 회수는 줄지만(4회 7개, 5회 5개) 절약도
 *   같이 줄어(101회, 60회) 패스를 둘 이유가 사라진다.
 *
 * ★ 이 값은 "몇 번 확인하고 접을 것인가" 일 뿐, 채택 기준이 아니다.
 *   pickOption 은 여전히 vendorItemId 완전 일치만 채택한다. 이 값을 아무리
 *   낮춰도 다른 옵션의 가격이 기록되는 일은 없다 — 줄어드는 것은 호출뿐이다.
 */
const OPTION_TERMINAL_MISSES = Number(process.env.PRICE_OPTION_TERMINAL_MISSES) || 3;

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

/*
 * ── 1차가 끝난 «이후» 실행의 배분 (2026-09-08 감사) ──────────────────
 *
 * ★ 위 8분은 «1차 패스가 아직 남은 실행» 에 맞춘 값이고, 그 자리에서는 옳다.
 *   쿠팡 1차는 검색어 411종 = 411호출이 필요하고 42분(420회)에 겨우 들어간다.
 *   여기를 줄이면 1차가 다음 실행으로 밀린다 — 1차는 호출당 1.65개를 내는
 *   가장 좋은 패스라 미룰 이유가 없다.
 *
 * ★ 그런데 하루의 두 번째 이후 실행은 사정이 정반대다. 그때 쿠팡은 회수
 *   패스만 도는데, 그 «꼬리» 의 생산성이 ADPICK 보다 한참 낮다.
 *
 *   실측 (KST 2026-09-08, gh run 34169333695 — 그날 네 번째 실행):
 *     쿠팡    42분 / 418호출 → 회수  25개  =  0.60 개/분
 *     ADPICK   8분 /  47호출 → 회수  30개  =  3.75 개/분
 *   같은 1분을 ADPICK 에 주는 것이 6.3배 낫다. 같은 실행에서 ADPICK 은
 *   8분을 다 쓰고도 회수 검색어 1,356종과 미수집 242개를 남긴 채 끝났다.
 *
 *   왜 이렇게 갈리는가: 쿠팡의 좋은 후보(캐시 힌트)는 하루 안에 마른다
 *     힌트 후보  run2 1,211종 → run3 494종 → run4 12종
 *   마르고 나면 남는 것은 facet(0.05/호출)과 사다리(0.02~0.08/호출)뿐이다.
 *   반면 ADPICK 은 후보가 남아돌고 응답 하나가 최대 20건을 실어 온다.
 *
 * ★ 그래서 «1차가 끝난 실행» 에서만 ADPICK 몫을 20분으로 늘린다.
 *   쿠팡은 30분(=300호출)을 받는다. 잃는 것은 꼬리 120호출 ≈ 7개,
 *   얻는 것은 ADPICK 12분 ≈ 45개다.
 *
 * ★ 이 변경은 외부 호출을 «늘리지 않는다». 오히려 쿠팡 호출이 실행당
 *   420 → 300 으로 줄어든다. 호출 간격(쿠팡 6초 / ADPICK 1.5초)도, 전역
 *   분당 상한도, 하루 상한도 한 자리 그대로다. 바뀌는 것은 같은 50분을
 *   어느 쪽에 쓰는가 하나뿐이다.
 */
/* 한 줄로 둔다 — test-second-pass 의 상수 파서가 줄 단위로 숫자를 읽는다. */
const ADPICK_RESERVE_LATE_MS = Number(process.env.PRICE_ADPICK_RESERVE_LATE_MS) || 20 * 60 * 1000;

/**
 * 이 실행의 ADPICK 몫을 정한다.
 * @param {boolean} coupangPass1Done 쿠팡 1차 패스가 오늘 이미 끝났는가
 */
function adpickReserveMs(coupangPass1Done) {
  return coupangPass1Done ? ADPICK_RESERVE_LATE_MS : ADPICK_RESERVE_MS;
}

/** 쿠팡 몫 — 전체에서 ADPICK 예약분을 뺀 나머지. 최소한 절반은 보장한다. */
function coupangBudgetMs(reserveMs) {
  return Math.max(RUN_TIME_BUDGET_MS - reserveMs, Math.floor(RUN_TIME_BUDGET_MS / 2));
}
/** 1차가 남은 실행의 쿠팡 몫 (기존 상수 — 테스트가 소스에서 이 관계를 읽는다). */
const COUPANG_BUDGET_MS = coupangBudgetMs(ADPICK_RESERVE_MS);

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
let _coupangInFlight = 0;   // 예산을 예약하고 아직 응답이 안 온 호출 수
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
  if (_runAborted) return { ok: false, items: [], reason: '잠금 상실 — 이 실행은 더 부르지 않는다' };

  if (_coupangCalls + _coupangInFlight >= COUPANG_RUN_BUDGET) {
    _coupangSkipped++;
    if (!_coupangBudgetWarned) {
      _coupangBudgetWarned = true;
      console.warn(`\n⚠️  쿠팡 호출 예산 ${COUPANG_RUN_BUDGET}회 소진 — 남은 검색어는 건너뜁니다.\n`);
    }
    return { ok: false, items: [], reason: `실행당 호출 예산 ${COUPANG_RUN_BUDGET}회 소진` };
  }

  // 하루 총량 상한 (COUPANG_DAY_BUDGET 주석 참고). 실행당 상한과 별개의 천장이다.
  if (_coupangDayUsed + _coupangCalls + _coupangInFlight >= COUPANG_DAY_BUDGET) {
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
  /*
   * 예산 검사는 동시 호출이 시작되기 전에 슬롯을 예약해야 한다.
   * CONCURRENCY=4라서 응답 뒤에만 _coupangCalls 를 올리면 네 호출이 모두
   * 같은 "남은 1칸"을 보고 들어갈 수 있다. 2026-09-19 운영에서 하루 상한
   * 2,800인데 실제 2,801회가 기록된 원인이 이것이었다.
   */
  _coupangInFlight++;
  let r;
  try {
    r = await searchCoupang(keyword, {
      limit,
      source: 'collect',
      minGapMs: COUPANG_MIN_GAP_MS,
      maxWaitMs: COUPANG_MAX_WAIT_MS
    });

    if (r.apiCalled === true || (r.apiCalled == null && r.from === 'api')) _coupangCalls++;
    else if (r.from === 'none') _coupangSkipped++;
  } finally {
    _coupangInFlight = Math.max(0, _coupangInFlight - 1);
  }

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
/*
 * ── ADPICK 차단 표시 (2026-09-08 감사에서 «영구 래치» 를 버렸다) ──────
 *
 * ★ 무엇이 잘못돼 있었나 — 2분짜리 차단이 8분짜리 예산을 통째로 죽였다.
 *
 *   ADPICK 은 간헐적으로 15초 타임아웃을 낸다(만성적이다 — 09-06·09-07·09-08
 *   실행 로그에 모두 있다). 3연속이면 api/_adpick.js 의 서킷 브레이커가
 *   «2분» 열린다 (noteTransientFailure → COOLDOWN_MIN.network = 2).
 *
 *   그런데 여기서는 그 한 번을 _adpickBlocked = true 로 받아 **이번 실행이
 *   끝날 때까지 영원히** ADPICK 호출을 막았다. 모듈이 2분 뒤 스스로 풀어도
 *   이 플래그가 남아 있어 아무도 다시 부르지 않았다.
 *
 *   실측 (gh run 34164621465, 2026-09-07T21:51Z 실행):
 *     ADPICK 몫 8분(ADPICK_RESERVE_MS) 중 실제로 쓴 시간 **70초**.
 *     22:33:39 시작 → facet 4회(그중 3회 타임아웃) → 22:34:49 종료.
 *     사다리 r1..r10 은 0회. 6.8분과 회수 검색어 1,564종을 통째로 버렸다.
 *     그날 ADPICK 미수집 242개 중 223개가 그 회수 패스를 기다리는 상품이었다.
 *
 * ★ 그래서 «지금 차단인가» 의 판정은 api/_adpick.js 의 시각 기반 상태
 *   (isAdpickBlockedGlobal) 하나에만 맡긴다. 그쪽이 사유별로 정확한 시간을
 *   안다 — 네트워크 2분 / HTTP 429 15분 / 403·401 60분 (COOLDOWN_MIN).
 *   즉 «진짜 심각한 차단» 은 여전히 실행 전체를 덮고(60분 > 실행 50분),
 *   짧은 네트워크 딸꾹질만 2분 만에 회복된다.
 *
 * ★ 아래 두 값은 이제 «부를까 말까» 의 판정에 쓰지 않는다. 로그를 한 번만
 *   찍기 위한 표시이자 리포트용 기록이다 — "이번 실행에서 차단을 본 적이
 *   있는가" 는 콘솔 요약과 메일이 계속 알아야 한다.
 *
 * ★ 분당 호출 속도는 한 자리도 바뀌지 않는다. 늘어나는 것은 «차단이 풀린
 *   뒤에도 부르지 않고 놀던 시간» 뿐이고, 그 시간에도 간격(ADPICK_MIN_GAP_MS
 *   1.5초)·전역 분당 상한(20)·실행당 예산(ADPICK_RUN_BUDGET 400)이 그대로
 *   적용된다. 우회하는 경로를 새로 만들지 않았다.
 */
let _adpickBlocked = false;   // 이번 실행에서 차단을 본 적이 있는가 (리포트 전용)
let _adpickBlockMsg = '';
let _adpickCalls = 0;
let _adpickInFlight = 0;    // 실행 예산을 예약하고 아직 응답이 안 온 호출 수
let _adpickSkipped = 0;
let _adpickBudgetWarned = false;
let _adpickDayUsed = 0;       // 오늘(KST) 이 수집기가 이미 쓴 ADPICK 외부 호출 (V3 에서만 읽는다)
let _adpickDayWarned = false;

/*
 * 이 실행이 잠금을 잃었는가 (V3 체크포인트가 올린다).
 * 잠금을 잃은 실행이 계속 부르면 다음 실행과 같은 검색어를 두 번 태운다.
 * 켜지면 두 fetch 함수가 호출 없이 즉시 실패를 돌려준다.
 */
let _runAborted = false;

/** V3 일일 상한: 이전 사용량을 확인하지 못하면 안전하게 ADPICK 수집만 중단한다. */
async function loadAdpickDayUsage(db = supabase) {
  try {
    const { count, error } = await db
      .from('adpick_api_calls')
      .select('id', { count: 'exact', head: true })
      .eq('kst_date', TODAY).eq('source', 'collect').eq('external_call', true);
    if (error) throw new Error(error.message);
    const used = Number(count);
    if (count == null || !Number.isSafeInteger(used) || used < 0) {
      throw new Error('ADPICK 오늘 호출 수가 유효한 정수가 아닙니다');
    }
    _adpickDayUsed = used;
  } catch (e) {
    // 0으로 두면 새 V3 실행마다 예산을 다시 사용해 일일 상한을 넘을 수 있다.
    // 이 실행에서는 하루 예산을 소진한 것으로 처리한다. 쿠팡 수집은 계속한다.
    _adpickDayUsed = ADPICK_DAY_BUDGET;
    console.warn(`[ADPICK] 오늘 호출량 확인 불가 — 안전을 위해 이 실행의 ADPICK 수집 중단: ${e.message}`);
  }
  return _adpickDayUsed;
}

/**
 * ADPICK 검색. api/_adpick.js를 통해서만 나간다 — 캐시/분당 상한/서킷
 * 브레이커가 거기 있다. 쿠팡과 마찬가지로 retry로 감싸지 않는다.
 *
 * ADPICK 응답에는 productId 가 없다. commissionlink 를 해시한 값(api/_shop.js
 * adpickProductId, products.product_id 와 같은 규칙)으로 매칭한다.
 */
async function fetchAdpickAll(keyword, limit = ADPICK_LIMIT) {
  if (!adpickHasKey()) return { ok: false, items: [], reason: 'ADPICK 키 미설정' };
  /*
   * ★ 판정은 시각 기반 상태 하나로만 한다 (위 _adpickBlocked 주석 참고).
   *   차단이 풀리면 같은 실행 안에서도 다시 부른다. _adpickBlocked 를 이
   *   조건에서 빼는 것이 이 수정의 전부다 — 간격도, 분당 상한도, 실행당
   *   예산도, 서킷 브레이커 자체도 한 줄 그대로다.
   */
  if (isAdpickBlockedGlobal()) return { ok: false, items: [], reason: 'ADPICK 차단 상태' };
  if (_runAborted) return { ok: false, items: [], reason: '잠금 상실 — 이 실행은 더 부르지 않는다' };

  if (V3 && _adpickDayUsed + _adpickCalls + _adpickInFlight >= ADPICK_DAY_BUDGET) {
    _adpickSkipped++;
    if (!_adpickDayWarned) {
      _adpickDayWarned = true;
      console.warn(`⚠️  ADPICK 하루 호출 예산 ${ADPICK_DAY_BUDGET}회 소진`
        + ` (오늘 앞선 실행 ${_adpickDayUsed}회 + 이번 실행 ${_adpickCalls}회) — 남은 검색어는 내일 이어갑니다.`);
    }
    return { ok: false, items: [], reason: `하루 호출 예산 ${ADPICK_DAY_BUDGET}회 소진` };
  }

  if (_adpickCalls + _adpickInFlight >= ADPICK_RUN_BUDGET) {
    _adpickSkipped++;
    if (!_adpickBudgetWarned) {
      _adpickBudgetWarned = true;
      console.warn(`\n⚠️  ADPICK 호출 예산 ${ADPICK_RUN_BUDGET}회 소진 — 남은 검색어는 건너뜁니다.\n`);
    }
    return { ok: false, items: [], reason: `실행당 호출 예산 ${ADPICK_RUN_BUDGET}회 소진` };
  }

  _adpickInFlight++;
  let r;
  try {
    r = await searchAdpick(keyword, {
      limit,
      source: 'collect',
      minGapMs: ADPICK_MIN_GAP_MS,
      maxWaitMs: ADPICK_MAX_WAIT_MS
    });

    if (r.apiCalled === true || (r.apiCalled == null && r.from === 'api')) _adpickCalls++;
    else if (r.from === 'none') _adpickSkipped++;
  } finally {
    _adpickInFlight = Math.max(0, _adpickInFlight - 1);
  }

  /*
   * ★ 차단 기록을 stale-cache 판정 «앞» 으로 옮겼다 (2026-09-08 감사).
   *
   *   예전에는 stale-cache 가 먼저 return 해서, 차단 응답에 오래된 캐시가
   *   딸려 오면 차단을 기록조차 하지 않았다. 실측(gh run 34156285636)에서
   *   실제로 이 경로를 탔다 — 서킷이 열리던 순간의 응답이 전부 STALE-CACHE
   *   였고, 리포트에는 아무 일도 없었던 것처럼 남았다. 지금은 사유가
   *   무엇이든 «차단을 봤다» 는 사실이 먼저 기록된다.
   */
  if (r.blocked && !_adpickBlocked) {
    _adpickBlocked = true;
    _adpickBlockMsg = r.error || '차단';
    console.error(`\n⚠️  ADPICK API 차단/오류 감지: ${_adpickBlockMsg}`);
    console.error('    → 차단이 풀릴 때까지만 멈춥니다 (사유별 시간은 api/_adpick.js COOLDOWN_MIN).'
      + ' 쿠팡 수집은 영향받지 않습니다.\n');
  }

  // 쿠팡과 같은 이유 — 오래된 캐시를 "오늘 가격"으로 기록하지 않는다.
  if (r.from === 'stale-cache') {
    _adpickSkipped++;
    return { ok: false, items: [], reason: '오래된 캐시 — 오늘 가격으로 쓸 수 없음' };
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
/*
 * vendor_item_id / item_id 를 반드시 같이 읽는다 (2026-09-03).
 *
 * 이 두 컬럼이 없으면 수집기는 "우리가 어떤 옵션을 추적하고 있는지"를
 * 모른 채 응답을 채택하게 된다. 실제로 그랬고, 그래서 다른 옵션의
 * 가격이 기록됐다 (pickOption 주석의 실측 참고).
 *
 * 값이 비어 있어도 _price.vendorIdOf 가 link 에서 뽑아내므로 폴백이
 * 있다 — 운영 쿠팡 상품 1,554개 전부에서 vid 확보를 확인했다.
 *
 * ★ 상수로 뽑은 이유 — 전체 스캔(fetchAllProducts)과 대상만 읽기
 *   (fetchProductsByIds)가 반드시 «같은 모양»의 행을 돌려줘야 한다.
 *   두 경로의 컬럼이 갈리면 어느 경로를 탔느냐에 따라 매칭이 달라진다.
 */
const PRODUCT_COLS = 'product_id, mall, title, keyword, link, image, vendor_item_id, item_id'
  /*
   * V3 계획기는 «마지막 성공 경과» 를 collected_at 에서 읽는다 (추가 조회 0회).
   * addRow 는 대상 행에서 필드를 골라 담으므로 이 값이 저장 경로로 새지 않는다.
   */
  + (V3_PLANNER ? ', collected_at' : '');

/**
 * 수집 대상 상품만 골라 읽는다 (2026-09-20 감사).
 *
 * ── 왜 필요한가: 실측 31.2MB 중 29.1MB 를 버리고 있었다 ──────────────
 *
 *   2026-09-18 대량 seed 이후 products 는 69,666행이 됐다. 그런데
 *   fetchCollectorEligibleKeys() 가 그중 2,965행만 남기고 전부 버린다.
 *   그런데도 fetchAllProducts() 는 «먼저 69,666행을 전부 내려받은 뒤»
 *   필터를 걸고 있었다.
 *
 *   2026-09-20 운영 실측 (읽기 전용, 같은 select):
 *     전체 스캔      69,666행 / 448 B/행 / 요청 70회 →  31.2 MB
 *     대상만 읽기     2,965행 / 724 B/행 / 요청  9회 →   2.15 MB   (-93.1%)
 *     행 집합은 완전히 같다 (2,965 = 2,965, 몰 필터로 빠지는 행 0)
 *
 *   daily-prices.yml 은 하루 18칸이라, 버려지는 29MB 가 곧 Supabase
 *   egress 초과(6.94GB / 5GB)의 가장 큰 몫이다.
 *
 * ── 안전장치 ────────────────────────────────────────────────────────
 *
 *   · id 배치는 chunkIdsByLength 로 자른다 — ADPICK product_id 가 64자라
 *     개수로 자르면 URI 가 터진다 (그 함수 주석의 2026-09-05 실측 참고).
 *   · error 를 버리지 않는다. 한 배치라도 실패하면 대상이 조용히 줄어들어
 *     "오늘 수집 안 됨" 으로 보이므로, 던져서 실행을 멈춘다.
 *   · product_id 로 물어본 뒤 (product_id, mall) 키로 다시 좁힌다 —
 *     같은 product_id 가 두 몰에 있을 수 있다.
 *   · 정렬은 전체 스캔과 같은 product_id 오름차순으로 맞춘다. 순서가 곧
 *     커서(price_job_state.cursor_key)의 의미라, 흔들리면 이어받기가 깨진다.
 */
/**
 * IN 목록으로 물을지, 카탈로그를 통째로 훑을지 정하는 경계 (2026-09-22).
 *
 *   IN 목록의 요청 수는 «대상 수 ÷ 배치 크기» 이고, 배치 크기는 URI 예산
 *   12,000자를 id 길이로 나눈 값이다 (ADPICK 은 64자라 배치당 179개).
 *   전체 스캔의 요청 수는 «카탈로그 ÷ 1,000» 으로 고정이다.
 *
 *   2026-09-22 운영 수치 (products 69,743 / 쿠팡 22,924 / ADPICK 46,819):
 *     대상  2,965개 → IN 약  20 요청  vs 전체 스캔 70 요청  → IN 이 싸다
 *     대상 12,666개 → IN 약  75 요청  vs 전체 스캔 70 요청  → 비슷
 *     대상 40,000개 → IN 약 230 요청  vs 전체 스캔 70 요청  → 스캔이 싸다
 *
 *   0.35 는 그 교차점(≈0.3)에 여유를 둔 값이다. 어느 쪽을 골라도
 *   **돌려주는 행 집합은 완전히 같다** — 마지막에 keys 로 거르기 때문이다.
 */
const TARGET_FULLSCAN_RATIO = Math.max(0, Math.min(1,
  Number(process.env.PRICE_TARGET_FULLSCAN_RATIO) || 0.35));

async function fetchProductsByIds(keys, catalogTotal = 0) {
  if (catalogTotal > 0 && keys.size >= catalogTotal * TARGET_FULLSCAN_RATIO) {
    console.log(`  [대상 조회] 대상 ${keys.size}개 / 카탈로그 ${catalogTotal}개`
      + ` — IN 목록보다 전체 키셋 스캔이 싸서 그쪽으로 읽습니다.`);
    const all = await fetchAllProducts();
    return all.filter(r => keys.has(`${r.product_id}|${r.mall}`));
  }
  const ids = [...new Set([...keys].map(k => k.slice(0, k.lastIndexOf('|'))))];
  const out = [];
  for (const chunk of chunkIdsByLength(ids)) {
    const { data, error } = await supabase
      .from('products')
      .select(PRODUCT_COLS)
      .in('product_id', chunk);
    if (error) throw new Error('products 대상 조회 실패: ' + error.message);
    (data || []).forEach(r => { if (keys.has(`${r.product_id}|${r.mall}`)) out.push(r); });
  }
  out.sort((a, b) => String(a.product_id).localeCompare(String(b.product_id)));
  return out;
}

/**
 * 카탈로그 규모만 센다 — 행을 내려받지 않는다 (head 요청, 응답 본문 0바이트).
 * 로그의 "products 전체 / 기타(연동 없음)" 줄을 예전 그대로 찍기 위한 값이고,
 * 실패해도 수집에는 아무 영향이 없다.
 */
async function countCatalog() {
  const one = async (build) => {
    const { count, error } = await build();
    if (error) throw new Error(error.message);
    return Number(count) || 0;
  };
  try {
    const total = await one(() => supabase.from('products')
      .select('*', { count: 'exact', head: true }));
    const coupang = await one(() => supabase.from('products')
      .select('*', { count: 'exact', head: true }).eq('mall', '쿠팡'));
    const adpick = await one(() => supabase.from('products')
      .select('*', { count: 'exact', head: true }).eq('mall', 'ADPICK'));
    return { total, coupang, adpick, other: Math.max(0, total - coupang - adpick) };
  } catch (e) {
    console.warn(`[카탈로그] 규모 조회 실패(로그 표시만 영향): ${e.message}`);
    return null;
  }
}

/**
 * 표 하나를 «커서 뒤부터» 끝까지 훑는다 (키셋 페이지네이션).
 *
 * ── 왜 offset(.range) 을 버리는가 (2026-09-22) ────────────────────
 *
 *   PostgREST 의 .range(from, to) 는 SQL 의 OFFSET 이다. OFFSET n 은
 *   «건너뛸 n 행을 실제로 읽은 뒤 버리는» 동작이라, 뒤쪽 페이지일수록
 *   같은 1,000행을 받는 데 더 많이 읽는다. 카탈로그가 69,743행이면
 *   한 바퀴에 읽히는 행 수는 1,000+2,000+…+69,743 ≈ 243만 행이다
 *   (한 바퀴에 필요한 행의 35배).
 *
 *   키셋은 «마지막으로 본 값보다 큰 것부터 1,000행» 이라 페이지마다
 *   읽는 양이 같다. 6만 번째 페이지도 첫 페이지와 같은 비용이다.
 *
 * ── 그리고 정렬 없는 .range 는 «틀린 답» 을 준다 ─────────────────
 *
 *   ORDER BY 가 없는 질의의 행 순서는 Postgres 가 보장하지 않는다.
 *   페이지 사이에 순서가 흔들리면 어떤 행은 두 번, 어떤 행은 한 번도
 *   안 나온다. fetchEverCollectedKeys 가 정확히 그 모양이었다 —
 *   price_history 143,282행을 정렬 없이 143페이지로 나눠 읽고 있었다.
 *   키셋은 커서 컬럼으로 반드시 정렬하므로 구조적으로 그럴 수 없다.
 *
 * @param {object} o
 *   build      () => PostgrestFilterBuilder — 매 페이지 새로 만든다
 *   columns    select 할 컬럼 (커서 컬럼을 반드시 포함할 것)
 *   cursor     커서 컬럼 이름. 유일하고 단조여야 한다 (기본 'id')
 *   pageSize   한 페이지 행 수
 *   label      오류 메시지에 쓸 이름
 *   onPage     (rows) => void — 페이지마다 부른다. 주면 배열을 쌓지 않는다
 *              (6만~10만 행을 통째로 메모리에 올리지 않기 위한 출구)
 * @returns {Array} onPage 를 주지 않았을 때만 전체 행
 */
/*
 *   filter     (q) => q — select 뒤에 거는 필터. supabase-js v2 에서 .gte/.eq 같은
 *              필터는 select() 가 돌려준 빌더에만 있다. build() 안에서 from() 뒤에
 *              바로 걸면 "gte is not a function" 으로 매번 실패한다 (2026-09-23 운영 실측).
 */
async function keysetScan({ build, columns, cursor = 'id', pageSize = PAGE, label = '조회', onPage = null, filter = null }) {
  const all = onPage ? null : [];
  let after = null;
  let guard = 0;
  /*
   * ★ 끝 판정의 기준은 «요청한 크기» 가 아니라 «서버가 준 최대 크기» 다.
   *   PostgREST 의 db-max-rows(운영 1,000)가 요청보다 작으면, 요청 크기로
   *   판단할 때 첫 페이지에서 루프가 끝나 나머지를 통째로 잃는다.
   *   fetchTargetPages 의 같은 주석 참고.
   */
  let maxPage = 0;
  for (;;) {
    if (++guard > 100000) throw new Error(`${label}: 키셋 페이지가 100,000장을 넘었습니다 (커서 컬럼 '${cursor}' 이 단조롭지 않을 수 있습니다)`);
    let q = build().select(columns);
    if (filter) q = filter(q);
    q = q.order(cursor, { ascending: true }).limit(pageSize);
    if (after !== null) q = q.gt(cursor, after);
    const { data, error } = await q;
    if (error) throw new Error(`${label} 실패: ` + error.message);
    const rows = data || [];
    if (onPage) onPage(rows); else all.push(...rows);
    if (rows.length === 0) return all;
    maxPage = Math.max(maxPage, rows.length);
    if (rows.length < maxPage) return all;
    const next = rows[rows.length - 1][cursor];
    if (next === undefined || next === null) {
      throw new Error(`${label}: 커서 컬럼 '${cursor}' 이 응답에 없습니다 (columns 에 포함시킬 것)`);
    }
    after = next;
  }
}

/**
 * 카탈로그 전체를 읽는다 (PRICE_INCLUDE_BULK_SEED / PRICE_SEED_ONLY 경로).
 *
 * ★ 돌려주는 행의 «모양»은 fetchProductsByIds 와 완전히 같아야 한다
 *   (그 함수 주석 참고). 커서로 쓴 id 는 여기서 떼어낸다.
 * ★ 정렬도 예전 그대로 product_id 오름차순으로 맞춘다 — 그 순서가 곧
 *   커서(price_job_state.cursor_key)의 의미라 흔들리면 이어받기가 깨진다.
 *   (키셋은 id 순으로 읽으므로, 다 읽은 뒤 한 번 정렬한다)
 */
async function fetchAllProducts() {
  const rows = await keysetScan({
    build: () => supabase.from('products'),
    columns: 'id, ' + PRODUCT_COLS,
    cursor: 'id',
    label: 'products 조회'
  });
  const out = rows.map(({ id, ...rest }) => rest);   // eslint-disable-line no-unused-vars
  out.sort((a, b) => String(a.product_id).localeCompare(String(b.product_id))
    || String(a.mall).localeCompare(String(b.mall)));
  return out;
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
  await keysetScan({
    build: () => supabase.from('price_history'),
    columns: 'id, product_id, mall',
    cursor: 'id',
    label: 'price_history 조회(시드 모드)',
    // 14만 행을 배열로 쌓지 않는다 — Set 하나만 남긴다.
    onPage: rows => rows.forEach(r => seen.add(`${r.product_id}|${r.mall}`))
  });
  return seen;
}

/**
 * 2026-09-18 대량 seed 로 들어온 카탈로그를 일일 collector 분모에서 분리한다.
 *
 * 운영 DB 실측:
 *   - 2026-09-18 하루 신규 history: ADPICK 45,672 / 쿠팡 21,068
 *   - 대부분 source='seed'
 *   - 기존 수천 개 규모 collector 가 6만+ 상품을 매일 갱신하려 하면서
 *     일일 예산과 수집률 지표가 동시에 무너졌다.
 *
 * DB 함수 collector_eligible_products() 는
 *   1) seed 폭증 이전부터 존재했거나
 *   2) 이후라도 search / ai / cron / import 로 실제 관측된 상품
 * 만 돌려준다. collect 자체는 seed-only 상품을 승격시키지 않는다.
 *
 * PRICE_INCLUDE_BULK_SEED=1 은 비상 우회용이다.
 */
async function fetchCollectorEligibleKeys() {
  if (process.env.PRICE_INCLUDE_BULK_SEED === '1') return null;

  const seen = new Set();

  /*
   * ★ 캐시 표가 있으면 그것을 읽는다 (2026-09-22).
   *
   *   아래 RPC 경로는 PostgREST max-rows(1,000) 때문에 페이지마다 같은
   *   함수를 처음부터 다시 실행한다. 그 함수 한 번이 6초다(운영 실측).
   *   대상이 2,965개면 같은 6초짜리 계산을 세 번 한다.
   *   캐시 표는 인덱스 있는 평범한 표라 키셋으로 훑으면 된다.
   *
   *   캐시가 비었거나 표가 없으면 아무 말 없이 예전 경로로 내려간다 —
   *   «상시 추적 대상 0개» 로 조용히 좁히는 것이 가장 위험하기 때문이다.
   */
  try {
    const cache = await refreshEligibleCache();
    if (cache.ok && cache.rows > 0) {
      await keysetScan({
        build: () => supabase.from('collector_eligible_cache'),
        /*
         * ★ 커서는 id 다. product_id 는 유일하지 않다 — 같은 product_id 가
         *   두 몰에 있을 수 있고, 그 두 행이 페이지 경계에 걸리면 뒤엣것을
         *   조용히 건너뛴다 (마이그레이션의 id 주석 참고).
         */
        columns: 'id, product_id, mall',
        cursor: 'id',
        label: 'collector_eligible_cache 조회',
        onPage: rowsPage => rowsPage.forEach(r => seen.add(`${r.product_id}|${r.mall}`))
      });
      if (seen.size > 0) return seen;
      console.warn('[collector 대상] 상시 추적 캐시를 읽었으나 0건 — 원본 RPC 로 내려갑니다.');
    }
  } catch (e) {
    console.warn(`[collector 대상] 상시 추적 캐시 읽기 실패 — 원본 RPC 로 내려갑니다: ${e.message}`);
    seen.clear();
  }

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc('collector_eligible_products')
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error('collector_eligible_products 조회 실패: ' + error.message
        + ' — Supabase migration collector_eligible_catalog_after_bulk_seed 적용 여부를 확인하세요.');
    }
    (data || []).forEach(r => seen.add(`${r.product_id}|${r.mall}`));
    if (!data || data.length < PAGE) return seen;
  }
}

/* ─── 수집 대상 조회 (2026-09-22 타임아웃 사고 대응) ─────────────
 *
 * ★ 무엇이 터졌나.
 *
 *   2026-09-22 KST 07:41·07:23 운영 실측 (gh run 35663976131 / 35662376120):
 *     치명적 오류: collector_target_products 조회 실패:
 *       canceling statement due to statement timeout
 *   수집기가 **첫 줄에서** 죽었다. 한 상품도 시도하지 못했다.
 *
 *   읽기 전용 재현 (2026-09-22 10:19 KST):
 *     rpc('collector_target_products', {7, 0}).limit(3)
 *       → 57014 statement timeout, 30,362 ms
 *     rpc('collector_eligible_products')                  6,034 ms
 *     products 69,743행 / price_history 143,282행
 *
 *   하루 전(2026-09-22-collector-target-timeout-batch.sql)에 함수 단위
 *   statement_timeout 을 8초 → 30초로 올려 둔 것을 **하루 만에 다시**
 *   넘겼다. 한도를 올리는 처방은 수명이 끝났다.
 *
 * ★ 왜 한도를 올려도 안 되는가.
 *
 *   collector_target_products() 한 번의 비용은 «오늘 대상이 몇 개인가» 가
 *   아니라 «원장과 카탈로그가 얼마나 큰가» 로 정해진다. 안에서
 *     · price_history 전체 Seq Scan (recorded_at OR source — 인덱스 불가)
 *     · products 조인 + select distinct
 *     · products 69,743행 전부에 hashtextextended 계산
 *   이 매 실행 다시 돈다. 카탈로그가 10만이 되면 60초로 올려도 같은
 *   자리에서 죽는다.
 *
 * ★ 무엇으로 바꾸는가.
 *
 *   비싼 계산을 하루 한 번 캐시 표에 굳히고(collector_refresh_eligible),
 *   대상은 (mall, product_id) 키셋으로 한 페이지씩 받는다
 *   (collector_target_page). 한 문장이 읽는 양이 페이지 크기로 고정되므로
 *   카탈로그가 6만이든 100만이든 **한 문장의 시간은 같다.**
 *   중간에 한 페이지가 실패해도 그 커서부터 다시 받으면 된다.
 *
 *   migration(2026-09-22-collector-target-keyset.sql)이 아직 없는 환경은
 *   예전 batch RPC → 예전 pagination 순으로 폴백한다. 동작은 그대로고
 *   «구조적으로 다시 죽을 수 있는 상태» 라는 것만 경고로 남긴다.
 * ------------------------------------------------------------------ */

/**
 * 대상 한 페이지 크기. 한 문장이 읽는 양의 상한이기도 하다.
 *
 * ★ 1,000 을 넘기지 않는다 — PostgREST 의 db-max-rows 가 1,000 이다.
 *   2026-09-22 읽기 전용 실측: limit 2,000 으로 물어도 정확히 1,000행만
 *   온다 (rpc('collector_eligible_products') 도 같다). 그 상태에서
 *   «요청한 만큼 안 왔으니 마지막 페이지» 로 판단하면 첫 페이지에서
 *   루프가 끝나 **대상의 대부분을 조용히 잃는다.**
 *   아래 루프는 그것과 별개로 «서버가 실제로 준 최대 페이지» 를 보고
 *   끝을 판단하므로, 이 값이 틀려도 데이터를 잃지 않는다.
 */
const TARGET_PAGE = Math.max(100, Math.min(1000,
  Number(process.env.PRICE_TARGET_PAGE) || 1000));

/**
 * 상시 추적 캐시를 필요하면 다시 계산한다.
 *
 * 하루 18칸(daily-prices.yml)이 전부 이 함수를 부르지만, 실제 재계산은
 * 캐시가 p_max_age_minutes 보다 낡았을 때만 일어난다 — 하루 한 번이다.
 *
 * 실패해도 던지지 않는다. 캐시가 낡았다는 사실을 호출부가 보고 판단한다.
 * @returns {{ok: boolean, refreshed: boolean, rows: number, reason: string}}
 */
async function refreshEligibleCache() {
  const maxAge = Math.max(0, Number(process.env.PRICE_ELIGIBLE_MAX_AGE_MIN) || 720);
  const { data, error } = await supabase.rpc('collector_refresh_eligible',
    { p_max_age_minutes: maxAge });
  if (error) {
    return { ok: false, refreshed: false, rows: 0, reason: String(error.message || error) };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    refreshed: !!(row && row.refreshed),
    rows: Number(row && row.row_count) || 0,
    reason: ''
  };
}

/**
 * collector_target_page 를 커서 끝까지 돌려 대상 행을 모은다.
 *
 * ★ 중복이 생길 수 없다. 커서가 (mall, product_id) 오름차순이고 다음
 *   페이지는 언제나 «마지막으로 본 행보다 큰» 것만 받는다. 그래도 방어로
 *   Set 에 넣어 동일 키를 한 번만 센다 (DB 함수가 바뀌어도 리포트의
 *   «대상 수» 가 부풀지 않게).
 *
 * ★ 한 페이지가 실패하면 그 커서를 그대로 들고 재시도한다. 처음부터
 *   다시 받지 않는다 — 이미 받은 페이지는 버리지 않는다.
 *
 * @returns {Array<{product_id, mall, tier}>}
 */
async function fetchTargetPages(meta, { includeAll = false } = {}) {
  const rows = [];
  const seen = new Set();
  let afterMall = null, afterId = null;
  let pages = 0;
  /*
   * ★ 끝 판정을 «요청한 크기» 가 아니라 «서버가 실제로 준 최대 크기» 로 한다.
   *
   *   PostgREST 는 db-max-rows(운영 1,000) 로 응답을 자른다. p_limit 을
   *   2,000 으로 주면 1,000행이 오는데, 그걸 «요청보다 적으니 마지막» 으로
   *   읽으면 첫 페이지에서 멈춰 대상의 대부분을 조용히 잃는다.
   *   서버가 스스로 준 최대치보다 적게 온 페이지가 진짜 마지막이다.
   */
  let maxPage = 0;

  for (;;) {
    let page = null;
    let lastErr = null;
    /*
     * 페이지 단위 재시도. 커서를 잃지 않으므로 한 번 실패해도 그 자리에서
     * 이어붙는다 — 전체를 처음부터 다시 받는 일이 없다.
     */
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, error } = await supabase.rpc('collector_target_page', {
        p_rotation_days: meta.rotationDays || 7,
        p_rotation_bucket: meta.rotationBucket == null ? 0 : meta.rotationBucket,
        p_after_mall: afterMall,
        p_after_product_id: afterId,
        p_limit: TARGET_PAGE,
        p_include_all: includeAll
      });
      if (!error) { page = data || []; lastErr = null; break; }
      lastErr = error;
      const info = DbError.classifyDbError(error);
      // 없는 함수·권한 오류는 재시도해도 같다. 폴백 판단은 호출부가 한다.
      if (!info.transient) break;
      const waitMs = 2000 * attempt;
      console.warn(`[collector 대상] 페이지 ${pages + 1} 일시 실패(${info.kind})`
        + ` — ${attempt}회째, ${Math.round(waitMs / 1000)}초 뒤 같은 커서로 다시 받습니다: ${error.message}`);
      await sleep(waitMs);
    }
    if (lastErr) {
      const e = new Error('collector_target_page 조회 실패: ' + lastErr.message);
      e.rpcError = lastErr;
      e.pagesDone = pages;
      throw e;
    }

    pages++;
    page.forEach(r => {
      const key = `${r.product_id}|${r.mall}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(r);
    });

    if (page.length === 0) break;
    maxPage = Math.max(maxPage, page.length);
    if (page.length < maxPage) break;
    const last = page[page.length - 1];
    afterMall = last.mall;
    afterId = last.product_id;
  }

  return rows;
}

/** YYYY-MM-DD 를 고정된 N개 회전 버킷 중 하나로 매핑한다. */
function rotationBucketForDate(date, days = BULK_ROTATION_DAYS) {
  const n = Math.max(1, Number(days) || 1);
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`회전 버킷 날짜 형식 오류: ${date}`);
  const dayNo = Math.floor(ms / 86400000);
  return ((dayNo % n) + n) % n;
}

/**
 * 현재 실행의 대상 정책을 DB 조회 없이 식별한다.
 *
 * targetSignature 는 같은 날 이미 완료한 상태를 재사용해도 되는지 판단한다.
 * 정책 버전/버킷 수/오늘 버킷이 하나라도 달라지면 기존 completed 상태를
 * 무효화하고 새 대상 집합으로 다시 시작한다. 2026-09-21 배포 당일에도
 * 기존 3천개-only completed 상태에 갇히지 않게 하는 장치다.
 */
function collectorTargetMeta(date = TODAY) {
  if (SEED_ONLY) {
    return { mode: 'seed', rotationDays: 0, rotationBucket: null,
      signature: `seed-v1:${date}` };
  }
  if (process.env.PRICE_INCLUDE_BULK_SEED === '1') {
    return { mode: 'all', rotationDays: 1, rotationBucket: 0,
      signature: `all-v1:${date}` };
  }
  if (!BULK_ROTATION_ENABLED) {
    return { mode: 'daily', rotationDays: 0, rotationBucket: null,
      signature: `daily-v1:${date}` };
  }
  const rotationBucket = rotationBucketForDate(date, BULK_ROTATION_DAYS);
  return {
    mode: 'rotation',
    rotationDays: BULK_ROTATION_DAYS,
    rotationBucket,
    signature: `${COLLECTOR_TARGET_VERSION}:${date}:${BULK_ROTATION_DAYS}:${rotationBucket}`
  };
}

/**
 * 상시 추적 + 오늘 회전 버킷의 키만 받는다.
 *
 * DB 함수가 tier(daily/rotation)를 붙여 돌려주므로 전체 products 를
 * 내려받아 JS 에서 6만 행을 버리는 일이 없다.
 */
async function fetchCollectorTargetKeys(meta = collectorTargetMeta()) {
  if (meta.mode === 'all' || meta.mode === 'seed') return null;

  if (meta.mode === 'daily') {
    const dailyKeys = await fetchCollectorEligibleKeys();
    return {
      keys: dailyKeys,
      dailyKeys,
      rotationKeys: new Set(),
      rotationDays: 0,
      rotationBucket: null
    };
  }

  const keys = new Set();
  const dailyKeys = new Set();
  const rotationKeys = new Set();
  let rows = null;
  let source = '';

  /*
   * ① 키셋 페이지 (2026-09-22-collector-target-keyset.sql).
   *
   *   한 문장이 읽는 양이 TARGET_PAGE 로 고정이라 카탈로그 크기와 무관하게
   *   같은 시간에 끝난다. 이 경로가 있으면 다른 경로는 쓰지 않는다.
   *
   *   ★ 캐시를 먼저 채운다. 캐시가 비어 있으면 상시 추적 대상이 «0개» 로
   *     읽혀서 오늘 대상이 회전 버킷만으로 조용히 좁아진다 — 가장 위험한
   *     실패 모양이라, 그때는 폴백으로 내려가 구형 경로로 계산한다.
   */
  const cache = await refreshEligibleCache();
  if (cache.ok && cache.rows > 0) {
    try {
      rows = await fetchTargetPages(meta);
      source = 'keyset';
      console.log(`[collector 대상] 키셋 페이지 ${TARGET_PAGE}행 단위로 ${rows.length}개를 받았습니다`
        + ` (상시 추적 캐시 ${cache.rows}개${cache.refreshed ? ', 이번 실행에서 갱신' : ''}).`);
    } catch (e) {
      const msg = String((e.rpcError && e.rpcError.message) || e.message || '');
      const missing = /PGRST202|could not find|does not exist|schema cache/i.test(msg);
      if (!missing) throw e;   // 진짜 장애는 숨기지 않는다
      console.warn('[collector 대상] collector_target_page 미적용 — 구형 경로로 내려갑니다.');
      rows = null;
    }
  } else if (!cache.ok) {
    console.warn(`[collector 대상] 상시 추적 캐시를 갱신하지 못했습니다 — 구형 경로로 내려갑니다: ${cache.reason}`);
  } else {
    console.warn('[collector 대상] 상시 추적 캐시가 비어 있습니다 — 구형 경로로 내려갑니다.');
  }

  /*
   * ② 구형 batch RPC (2026-09-22-collector-target-timeout-batch.sql).
   *
   * 회전 대상 RPC 는 본체가 price_history/products 를 훑는 무거운 쿼리다.
   * 예전에는 PostgREST max-rows 때문에 1,000개씩 .range() 하면서 같은 RPC 전체를
   * 페이지마다 다시 실행했다. 오늘 대상이 1.2만개면 같은 계산을 13번 반복한다.
   *
   * batch RPC 는 결과를 JSONB 한 행으로 묶어 한 번만 계산한다. 그래도
   * «한 문장이 카탈로그 전체를 훑는다» 는 성질은 그대로라, 2026-09-22 에
   * 30초 한도를 다시 넘겼다. 그래서 이제 이 경로는 폴백이다.
   *
   * 새 migration 이 아직 없는 환경에서만 구형 pagination 으로 fallback 한다.
   * timeout/DB 장애는 fallback 하지 않는다 — 같은 무거운 쿼리를 반복해 상황을
   * 악화시키지 않고 원인을 그대로 실패로 올린다.
   */
  const batch = rows ? { error: null } : await supabase.rpc('collector_target_products_batch', {
    p_rotation_days: meta.rotationDays,
    p_rotation_bucket: meta.rotationBucket
  });

  if (rows) {
    /* ①이 성공했다 — 구형 경로는 건드리지 않는다. */
  } else if (!batch.error) {
    if (!Array.isArray(batch.data)) {
      throw new Error('collector_target_products_batch 응답 형식 오류: JSON 배열이 아닙니다.');
    }
    rows = batch.data;
    source = 'batch';
  } else {
    const msg = String(batch.error.message || '');
    const missingBatch = /PGRST202|could not find|does not exist|schema cache/i.test(msg);
    if (!missingBatch) {
      throw new Error('collector_target_products_batch 조회 실패: ' + msg);
    }

    console.warn('[collector 대상] batch RPC 미적용 — 구형 pagination fallback 을 사용합니다.');
    rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .rpc('collector_target_products', {
          p_rotation_days: meta.rotationDays,
          p_rotation_bucket: meta.rotationBucket
        })
        .range(from, from + PAGE - 1);

      if (error) {
        throw new Error('collector_target_products 조회 실패: ' + error.message
          + ' — Supabase migration collector_target_timeout_batch 적용 여부를 확인하세요.');
      }

      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    source = 'pagination';
  }

  rows.forEach(r => {
    const key = `${r.product_id}|${r.mall}`;
    keys.add(key);
    if (r.tier === 'rotation') rotationKeys.add(key);
    else dailyKeys.add(key);
  });

  return {
    keys,
    dailyKeys,
    rotationKeys,
    rotationDays: meta.rotationDays,
    rotationBucket: meta.rotationBucket,
    /* 리포트가 «어느 경로로 대상을 받았는가» 를 그대로 싣는다. */
    source
  };
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

const DbError = require('../api/_dberror');

/*
 * ★ 오류를 종류별로 가른다 (2026-09-13 감사).
 *
 *   예전에는 어떤 오류든 "price_job_state 테이블이 없습니다" 로 멈췄다. 그런데
 *   Supabase 게이트웨이 타임아웃(504)·DB 재시작(PGRST002) 같은 일시 장애도 여기로
 *   들어온다. 그러면 멀쩡한 테이블에 마이그레이션 안내가 붙고, 몇 초 뒤면 됐을
 *   수집이 통째로 건너뛰어진다.
 *
 *     TABLE_MISSING           → 마이그레이션 안내 (예전 문구 그대로)
 *     DB_TIMEOUT/DB_UNAVAILABLE → 몇 번 기다렸다 다시 읽고, 끝내 안 되면 원인을 그대로 말한다
 *     그 밖                   → 원인을 그대로 말한다 (테이블 탓으로 돌리지 않는다)
 *
 *   어느 경우든 조용히 처음부터 돌지는 않는다 — 매 실행이 1번부터 돌면 앞쪽 상품만
 *   반복 수집된다.
 */
async function loadState(opts) {
  const o = opts || {};
  const db = o.db || supabase;
  const { data, error } = await DbError.withDbRetry(() => db
    .from('price_job_state')
    .select('job_date, cursor_key, processed, total, status, last_result, last_run_at')
    .eq('id', 1)
    .maybeSingle(), {
    attempts: o.attempts || 4,
    baseDelayMs: o.baseDelayMs == null ? 2000 : o.baseDelayMs,
    sleep: o.sleep,
    onRetry: (info, attempt) => console.warn(
      `[상태] price_job_state 읽기 일시 실패(${info.kind}) — ${attempt}회째, 잠시 뒤 다시 읽습니다: ${info.message}`)
  });

  if (error) {
    const info = DbError.classifyDbError(error);
    if (info.kind === DbError.KIND.TABLE_MISSING) {
      throw new Error(`${STATE_MISSING_HINT} (원인: ${error.message})`);
    }
    const failure = new Error(`price_job_state 를 읽지 못했습니다 [${info.kind}]`
      + `${info.transient ? ' — 테이블 문제가 아니라 DB 응답 문제입니다. 다음 실행에서 이어갑니다' : ''}`
      + ` (원인: ${error.message})`);
    failure.dbErrorKind = info.kind;
    throw failure;
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
async function acquireLock(state, opts) {
  const o = opts || {};
  const db = o.db || supabase;
  const sleep = o.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = Math.max(1, o.attempts || 3);
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
  const payload = {
    last_run_at: nextLast,
    last_result: { ...((state && state.last_result) || {}),
      lock: { runId: token, at: nextLast, until: new Date(now.getTime() + LOCK_TTL_MS).toISOString() } }
  };
  const casLost = { ok: false, reason: '다른 실행이 같은 순간에 잠금을 가져갔습니다 (CAS 실패)' };

  /*
   * ★ DB 일시 장애를 «건너뛰기» 로 끝내지 않는다 (2026-09-13 감사 후속 P2).
   *
   *   예전에는 CAS 갱신이 504/PGRST002 로 끝나면 "잠금 획득 실패" 로 실행 전체를
   *   건너뛰었고 exit 0 이라 아무도 몰랐다. 그런데 일시 장애는 두 가지다.
   *     · 갱신이 들어가지 않았다  → 행이 그대로다. CAS 를 다시 시도해도 안전하다.
   *     · 갱신은 들어갔는데 응답만 잃었다 → 행에 우리 토큰이 있다. 이미 우리 잠금이다.
   *   그래서 행을 다시 읽어 둘을 가른다. 다른 실행의 흔적이 보이면 예전처럼 CAS 실패다.
   *   끝내 일시 장애면 transient 로 알려 호출부(run)가 실패로 끝내게 한다.
   */
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const q = db.from('price_job_state').update(payload).eq('id', 1);
    // ★ CAS — 우리가 읽은 last_run_at 이 그대로일 때만 잡는다.
    const { data, error } = await (prev === null ? q.is('last_run_at', null) : q.eq('last_run_at', prev)).select('id');
    if (!error) return data && data.length ? { ok: true, token } : casLost;

    const info = DbError.classifyDbError(error);
    if (!info.transient) return { ok: false, reason: `잠금 획득 실패: ${error.message}` };

    const read = await db.from('price_job_state').select('last_run_at, last_result').eq('id', 1).maybeSingle();
    if (!read.error && read.data) {
      const held = read.data.last_result && read.data.last_result.lock;
      if (held && held.runId === token) {
        console.warn(`[잠금] 갱신 응답을 잃었지만(${info.kind}) 잠금은 우리 것으로 들어갔습니다 — 이어갑니다.`);
        return { ok: true, token };
      }
      if ((read.data.last_run_at || null) !== prev) return casLost;
    }

    if (attempt === attempts) {
      return { ok: false, transient: true,
        reason: `잠금 획득 중 DB 일시 장애가 계속됐습니다 [${info.kind}] (원인: ${error.message})` };
    }
    console.warn(`[잠금] DB 일시 장애(${info.kind}) — ${attempt}회째, 잠시 뒤 다시 잡습니다: ${error.message}`);
    await sleep(2000 * Math.pow(3, attempt - 1));
  }
  return casLost;
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

/* ─── V3 체크포인트 (2026-09-23) ─────────────────────────────────
 *
 * ★ 왜 필요한가. 레거시는 실행 끝에 saveState 를 딱 한 번 부른다. 그 전에
 *   프로세스가 죽으면(러너 종료·네트워크·timeout-minutes) 가격은 원장에 남지만
 *   «어디까지 찾아봤는가» 가 사라져 다음 실행이 같은 검색어를 다시 부른다.
 *   쿠팡 하루 상한(3,400)을 그렇게 태우면 그날 수집률이 그만큼 줄어든다.
 *
 * ★ 모든 쓰기는 «잠금이 아직 우리 것일 때만» 들어간다.
 *     update ... where id=1 and last_result->lock->>runId = <우리 토큰>
 *   레거시의 최종 저장은 이 조건이 없어서, TTL(80분)을 넘긴 실행이 뒤이어 잠금을
 *   잡은 실행의 상태와 잠금을 덮어쓸 수 있었다. 0행이 갱신되면 잠금을 잃은
 *   것이므로 onLost 로 알려 두 레인을 멈춘다.
 *
 * ★ 체크포인트가 곧 잠금 연장(heartbeat)이다 — 쓸 때마다 until 을 TTL 만큼 민다.
 * ------------------------------------------------------------------ */

/**
 * V3 카나리를 그날 멈춰야 하는 이상 신호. 없으면 '' (순수 함수 — test-collector-v3 가 고정한다).
 *   · ADPICK 429 — 공식 한도(분당 10회) 위반 신호. 리미터가 막았어야 한다
 *   · 쿠팡 차단 · ADPICK 차단 — 제공자 쪽 이상
 *   · 리포트 불변조건 위반 — 집계 코드가 틀렸다
 *   · 잠금 상실 — 다른 실행과 겹쳤다
 *   · 호출은 나갔는데 저장 0행
 */
function v3KillReason(s) {
  const r = [];
  if (s.adpick429) r.push('ADPICK HTTP 429');
  if (s.coupangBlocked) r.push('쿠팡 차단');
  if (s.adpickBlocked && !s.adpick429) r.push('ADPICK 차단');
  if (s.violations && s.violations.length) r.push(`리포트 불변조건 위반 ${s.violations.length}건`);
  if (s.lockLost) r.push('잠금 상실');
  if (s.collectedNothing) r.push('호출했는데 저장 0행');
  return r.join(' · ');
}

/**
 * 그날의 V3 비활성화 표식을 남긴다 (잠금이 우리 것일 때만).
 * 실패해도 던지지 않는다 — 표식을 못 남기면 다음 칸이 다시 V3 로 돌 뿐이고,
 * 그 칸도 같은 이상을 보면 다시 표식을 시도한다.
 */
async function markV3Kill(lockToken, reason, opts) {
  const db = (opts && opts.db) || supabase;
  const at = new Date().toISOString();
  try {
    const { data, error } = await db.from('price_job_state').select('last_result').eq('id', 1).maybeSingle();
    if (error) throw new Error(error.message);
    const lr = (data && data.last_result) || {};
    const kill = { date: TODAY, at, reason, runId: lockToken };
    const u = await db.from('price_job_state')
      .update({ last_result: { ...lr, v3Kill: kill } })
      .eq('id', 1).eq('last_result->lock->>runId', lockToken).select('id');
    if (u.error) throw new Error(u.error.message);
    if (!u.data || !u.data.length) throw new Error('잠금이 우리 것이 아니다');
    console.error(`⛔ [V3 카나리] 오늘(${TODAY}) 남은 실행은 레거시로 돌아갑니다 — ${reason}`);
    return true;
  } catch (e) {
    console.error(`[V3 카나리] 비활성화 표식을 남기지 못했습니다 (${reason}): ${e.message}`);
    return false;
  }
}

/** 이 실행이 상태에 적을 대상 서명. 계획기를 쓰면 레거시와 다른 서명이 된다. */
function targetSignatureFor(meta, v3Planner = V3_PLANNER) {
  return v3Planner ? `${meta.signature}:planner-v3` : meta.signature;
}

/**
 * 같은 날 저장된 상태를 이어받아도 되는가.
 * V3 는 레거시 상태를 이어받는다. 레거시는 V3 상태를 이어받지 않는다(커서가 비어 있다).
 */
function resumeCompatible(prevSignature, meta, v3Planner = V3_PLANNER) {
  if (prevSignature === targetSignatureFor(meta, v3Planner)) return true;
  return !!v3Planner && prevSignature === meta.signature;
}

/** 레인 스냅숏 → price_job_state.last_result.malls[몰] 모양. 최종 저장과 같은 키를 쓴다. */
function mallStateFromSnapshot(s) {
  return {
    cursor_key: s.cursorKey || '', processed: s.processed || 0, total: s.total || 0,
    status: s.status || 'running', failedKeywords: s.failedKeywords || [],
    last_result: {
      secondPassDone: s.secondPassDone || [], facetDryGroups: s.facetDryGroups || [],
      terminalOptionFailures: s.terminalOptionFailures || [], optionMissStreaks: s.optionMissStreaks || {}
    },
    collectorCovered: s.collectorCovered || [], collectorAttempted: s.collectorAttempted || []
  };
}

/**
 * 체크포인트 한 번에 쓸 행.
 * @param {object} o
 *   base  { jobDate, targetSignature, prevLastResult, malls } — 실행 시작 때 이어받은 오늘 상태
 *   snaps { 몰: 스냅숏 } — 이번 실행 레인이 넘긴 최신 값
 */
function checkpointPayload({ base, snaps, lockToken, nowMs, ttlMs }) {
  const malls = { ...(base.malls || {}) };
  Object.entries(snaps || {}).forEach(([m, s]) => {
    malls[m] = { ...(malls[m] || {}), ...mallStateFromSnapshot(s) };
  });
  const c = malls['쿠팡'] || {};
  const iso = new Date(nowMs).toISOString();
  return {
    job_date: base.jobDate,
    cursor_key: c.cursor_key || '', processed: c.processed || 0, total: c.total || 0,
    status: c.status || 'running',
    last_run_at: iso,
    last_result: {
      ...(base.prevLastResult || {}),
      lock: { runId: lockToken, at: iso, until: new Date(nowMs + ttlMs).toISOString() },
      targetSignature: base.targetSignature,
      failedKeywords: c.failedKeywords || [],
      secondPassDone: (c.last_result && c.last_result.secondPassDone) || [],
      plannerStarveCursor: mergeStarveCursor(base.plannerStarveCursor,
        Object.fromEntries(Object.entries(snaps || {}).map(([m, s]) => [m, s.starveCursor]))),
      malls
    }
  };
}

/** 기아 레인 커서를 몰별로 합친다. 새 값이 없으면(null/undefined) 이전 값을 지킨다. */
function mergeStarveCursor(prev, next) {
  const out = { ...(prev || {}) };
  Object.entries(next || {}).forEach(([m, v]) => { if (v != null) out[m] = v; });
  return out;
}

/**
 * 잠금 소유를 조건으로 상태를 쓰는 기록기.
 * note() 는 최소 간격(minIntervalMs)을 지키며 배경에서 쓰고, flush()/finalize() 는 기다린다.
 */
function createCheckpointWriter(o) {
  const db = o.db || supabase;
  const now = o.now || (() => Date.now());
  const minInterval = o.minIntervalMs == null ? CHECKPOINT_MIN_INTERVAL_MS : o.minIntervalMs;
  const ttlMs = o.ttlMs || LOCK_TTL_MS;
  const snaps = {};
  const stats = { writes: 0, failures: 0, lost: false };
  const abortSignal = { aborted: false };
  let lastWrite = now();   // 실행 시작 직후에는 쓰지 않는다 — 방금 잠금을 잡으며 썼다
  let inflight = null;
  let dirty = false;

  async function conditionalUpdate(body) {
    const { data, error } = await db.from('price_job_state')
      .update({ ...body, updated_at: new Date(now()).toISOString() })
      .eq('id', 1)
      .eq('last_result->lock->>runId', o.lockToken)
      .select('id');
    if (error) {
      stats.failures++;
      console.warn(`  [체크포인트] 저장 실패(다음 배치에서 다시 쓴다): ${error.message}`);
      return false;
    }
    if (!data || !data.length) {
      if (!stats.lost) {
        stats.lost = true;
        abortSignal.aborted = true;
        console.error('⛔ [체크포인트] 잠금이 더 이상 우리 것이 아닙니다 — 상태를 쓰지 않고 이 실행을 멈춥니다.');
        if (o.onLost) o.onLost();
      }
      return false;
    }
    stats.writes++;
    lastWrite = now();
    return true;
  }

  function writeLatest() {
    dirty = false;
    return conditionalUpdate(checkpointPayload({
      base: o.base, snaps, lockToken: o.lockToken, nowMs: now(), ttlMs
    }));
  }

  return {
    abortSignal,
    stats,
    note(mall, snap) {
      snaps[mall] = snap;
      dirty = true;
      if (inflight || stats.lost || now() - lastWrite < minInterval) return;
      inflight = writeLatest().finally(() => { inflight = null; });
    },
    async flush() {
      if (inflight) await inflight;
      if (dirty && !stats.lost) return writeLatest();
      return !stats.lost;
    },
    /** 최종 저장 — 레거시 saveState 와 같은 행을 쓰되 잠금 조건을 건다. */
    async finalize(fullState) {
      if (inflight) await inflight;
      if (stats.lost) return false;
      return conditionalUpdate(fullState);
    }
  };
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
/*
 * ★ 배치 크기를 «개수» 가 아니라 «id 글자 수» 로 정한다 (2026-09-05 실측 버그).
 *
 *   예전에는 400개 고정이었다. 쿠팡 product_id 는 10자라 400개 = 약 4,400자로
 *   멀쩡했지만, ADPICK 은 sha256 hex 라 «64자» 다. 400개면 URI 가 약 26,000자가
 *   되어 PostgREST 가 400 Bad Request 로 거절한다.
 *
 *   그런데 아래 호출은 `const { data } = ...` 로 **error 를 버리고 있었다.**
 *   그래서 요청이 통째로 실패해도 data=null → 조용히 "0건" 이 됐다.
 *
 *   운영 실측 (2026-09-05, 읽기 전용 재현):
 *     배치 400 → 찾은 행   0 · 오류 배치 2/2 (Bad Request)
 *     배치 200 → 찾은 행  72
 *     배치 100 → 찾은 행  72
 *     정답(.in 없이 카운트) 72
 *     대조군 쿠팡 400개(10자) → 356행 정상
 *
 *   피해는 조용했지만 작지 않다.
 *     · ADPICK 은 매 실행 "오늘 기록된 상품 0개" 로 판단해, 이미 확보한 72개를
 *       포함해 80개 검색어를 «전부 다시» 불렀다. 403 이 난 공급자에게 필요 없는
 *       요청을 매 실행 반복한 것이다.
 *     · 리포트 불변조건(수집성공 ≤ 오늘가격보유)이 매번 깨졌다.
 *       이번 실행에서 실제로 잡혔다: 1046 > 1022.
 *
 *   URI 예산으로 자르면 id 길이가 어떻든 안전하다. 12,000자는 PostgREST/프록시의
 *   흔한 상한(보통 16KB 안팎)보다 넉넉히 아래다.
 */
const ID_BATCH_CHARS = 12000;

function chunkIdsByLength(ids, budget = ID_BATCH_CHARS) {
  const out = [];
  let cur = [], len = 0;
  for (const id of ids) {
    const cost = String(id).length + 3;      // 값 + 구분자·따옴표 여유
    if (cur.length && len + cost > budget) { out.push(cur); cur = []; len = 0; }
    cur.push(id); len += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

/*
 * ★ 대상이 커지면 «IN 목록으로 묻기» 가 가장 비싼 방법이 된다 (2026-09-22).
 *
 *   chunkIdsByLength 는 URI 예산 12,000자로 자른다. product_id 길이가
 *   몰마다 달라서 한 배치에 들어가는 개수도 다르다.
 *
 *     쿠팡   10자 → 배치당 약  920개  → 22,924개면 약  25 요청
 *     ADPICK 64자 → 배치당 약  179개  → 46,819개면 약 262 요청
 *
 *   즉 카탈로그 전체(6만)를 대상으로 삼는 날이면 이 함수 하나가 287번
 *   왕복한다. 그런데 «오늘 이미 기록된 행» 은 아무리 많아도 오늘 수집한
 *   만큼이고, 그건 (recorded_at 범위 + mall) 로 곧장 훑을 수 있다.
 *
 *   그래서 둘 중 싼 쪽을 고른다.
 *     대상이 작다  → 예전 그대로 IN 목록 (필요한 행만 정확히 받는다)
 *     대상이 크다  → 오늘·그 몰의 행을 키셋으로 훑고 JS 에서 교집합
 *
 *   ★ 결과 집합은 두 방식이 완전히 같다. 어느 쪽도 «오늘 기록된 행» 의
 *     정의(recorded_at 이 KST 오늘 범위 + 같은 mall)를 바꾸지 않는다.
 *     day-scan 쪽은 마지막에 collectible 키로 교집합을 취해 대상 밖 행을
 *     떨어뜨린다 — IN 목록이 하던 일과 같다.
 */
const TODAY_SCAN_THRESHOLD = Math.max(0,
  Number(process.env.PRICE_TODAY_SCAN_THRESHOLD) || 5000);

/** 오늘·그 몰의 원장 행을 키셋으로 훑어 대상과 교집합을 낸다. */
async function collectedTodayByDayScan(mallName, collectible, dayStart, dayEnd) {
  const want = new Set(collectible.map(p => `${p.product_id}|${p.mall}`));
  const found = new Set();
  await keysetScan({
    build: () => supabase.from('price_history'),
    filter: q => q.gte('recorded_at', dayStart).lt('recorded_at', dayEnd).eq('mall', mallName),
    columns: 'id, product_id, mall',
    cursor: 'id',
    label: `[${mallName}] 오늘 기록 스캔`,
    onPage: rows => rows.forEach(r => {
      const k = `${r.product_id}|${r.mall}`;
      if (want.has(k)) found.add(k);
    })
  });
  return found;
}

async function collectedTodayKeys(mallName, collectible) {
  const found = new Set();
  // KST 는 서머타임이 없어 하루가 정확히 24시간이다.
  const dayStart = kstDayStartUtc(TODAY);
  const dayEnd = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  let failed = 0;

  if (collectible.length > TODAY_SCAN_THRESHOLD) {
    try {
      const scanned = await collectedTodayByDayScan(mallName, collectible, dayStart, dayEnd);
      console.log(`  [${mallName}] 오늘 기록 ${scanned.size}개 확인`
        + ` (대상 ${collectible.length}개 — 원장 일자 스캔)`);
      return scanned;
    } catch (e) {
      /*
       * 스캔이 실패하면 IN 목록으로 내려간다. 조용히 «0개» 를 돌려주면
       * 이미 확보한 상품을 전부 다시 부르게 된다 — 그게 가장 비싼 실패다.
       */
      console.warn(`  [${mallName}] 오늘 기록 일자 스캔 실패 — IN 목록으로 내려갑니다: ${e.message}`);
    }
  }

  try {
    const ids = collectible.map(p => p.product_id);
    for (const chunk of chunkIdsByLength(ids)) {
      const { data, error } = await supabase
        .from('price_history')
        .select('product_id, mall')
        .gte('recorded_at', dayStart)
        .lt('recorded_at', dayEnd)
        .eq('mall', mallName)
        .in('product_id', chunk);
      /*
       * error 를 버리지 않는다. 여기서 조용히 실패하면 "오늘 아무것도 없다" 가
       * 되어, 이미 확보한 상품까지 다시 부르는 낭비가 매 실행 반복된다.
       */
      if (error) {
        failed++;
        console.warn(`  [${mallName}] 오늘 기록 조회 배치 실패 (${chunk.length}개): ${error.message}`);
        continue;
      }
      (data || []).forEach(r => found.add(`${r.product_id}|${r.mall}`));
    }
  } catch (e) {
    console.warn(`  [${mallName}] 오늘 기록 조회 실패(무시하고 진행): ${e.message}`);
  }
  if (failed) {
    console.warn(`  [${mallName}] ★ 배치 ${failed}개가 실패해 "오늘 이미 기록됨" 판단이 불완전합니다`
      + ' — 이미 확보한 상품을 다시 부를 수 있습니다.');
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
    /*
     * 커서는 keyword 다 — search_stats_keyword_key 와 같은 유일 키이고,
     * 이 표의 기본키이기도 하다. 정렬 없는 .range 는 페이지 경계에서 행을
     * 빠뜨리거나 두 번 줄 수 있다 (keysetScan 주석 참고).
     */
    await keysetScan({
      build: () => supabase.from('coupang_search_cache'),
      columns: 'keyword, items',
      cursor: 'keyword',
      label: 'coupang_search_cache 조회',
      onPage: rows => rows.forEach(row => {
        const items = Array.isArray(row.items) ? row.items : [];
        items.forEach(it => {
          const pid = String(it && it.productId);
          if (!wantIds.has(pid)) return;
          if (!out.has(pid)) out.set(pid, []);
          const list = out.get(pid);
          if (list.indexOf(row.keyword) < 0) list.push(row.keyword);
        });
      })
    });
  } catch (e) {
    console.warn(`  [캐시 힌트] 조회 실패(무시하고 진행): ${e.message}`);
    return new Map();
  }
  return out;
}

/* ─── 상품 단위 최종 상태 (2026-09-22) ──────────────────────────
 *
 * ★ 왜 필요한가.
 *
 *   기존 리포트에는 두 축이 있었다.
 *     상품 단위  수집성공 / 수집미확보 / 시도 / 미시도 / 무매칭
 *     attempt 단위 blocked / budget / rateLimit / network / …
 *   앞은 «몇 개인가» 만 말하고, 뒤는 «호출이 왜 실패했는가» 만 말한다.
 *   그래서 «이 상품이 오늘 왜 비었는가» 라는 질문에 답하는 칸이 없었다.
 *   미확보 3,000개가 차단 때문인지 예산 때문인지 옵션 불일치 때문인지
 *   리포트만 보고는 구분할 수 없었다.
 *
 * ★ 규칙: 대상 상품 하나는 정확히 한 칸에만 들어간다.
 *   따라서 모든 칸의 합 = 대상 상품 수 다 (reportInvariantErrors 가 고정).
 *
 *   collected           수집기가 오늘 직접 가격을 확보했다
 *   already_collected   오늘 가격은 있는데 수집기가 아니라 다른 경로가 썼다
 *                       (Vercel cron / 사용자 검색 / AI / 임포트)
 *   no_match            호출이 나가 응답을 받았는데 우리 상품이 없었다
 *                       (옵션 불일치로 채택하지 않은 경우도 여기다 —
 *                        다른 옵션 가격을 대신 쓰지 않는 것이 규칙이다)
 *   blocked             공급자가 막았다 (403 / 이용제한 / 서킷 브레이커)
 *   rate_limited        분당·일일 상한, 호출 간격 대기로 못 나갔다
 *   timeout             응답 시간 초과
 *   api_error           그 밖의 API 오류 (5xx / 파싱 실패 / 키 미설정)
 *   db_error            DB 쪽 실패로 못 시도했다
 *   budget              실행당 호출 예산·시간 예산을 다 써서 못 갔다
 *   pending             오늘 아직 차례가 오지 않았다 (커서 뒤 · 다음 실행 몫)
 *   target_query_error  대상 조회 자체가 실패했다 — 이 칸은 몰 단위가
 *                       아니라 실행 단위다 (run 의 치명적 오류 경로에서만
 *                       0 이 아니게 되고, 그때는 몰별 집계가 아예 없다)
 *   unknown             위 어디에도 넣을 근거가 없었다
 *
 * ★ pending / budget 은 요청받은 목록에 없던 칸이다. 그런데 이 둘을
 *   unknown 으로 밀어 넣으면 하루의 첫 실행에서 unknown 이 가장 큰 칸이
 *   되어 분류가 쓸모없어진다 («아직 안 했다» 는 «원인 불명» 이 아니다).
 *   합이 대상 수와 맞아야 한다는 요구를 지키면서 사실대로 적으려면
 *   칸을 더하는 수밖에 없다.
 * ------------------------------------------------------------------ */
const OUTCOME_KEYS = [
  'collected', 'already_collected', 'no_match',
  'blocked', 'rate_limited', 'timeout', 'api_error', 'db_error',
  'budget', 'pending', 'target_query_error', 'unknown'
];

const outcomesTemplate = () => OUTCOME_KEYS.reduce((o, k) => { o[k] = 0; return o; }, {});

/**
 * 호출 실패 사유 문자열을 상품 단위 칸으로 옮긴다.
 *
 * categorizeFailure 와 «같은 낱말» 을 본다 — 두 분류가 다른 규칙을 쓰면
 * attempt 단위 합계와 상품 단위 합계가 서로 다른 이야기를 하게 된다.
 * 다만 칸 이름은 요청받은 taxonomy 를 따른다.
 */
function outcomeFromReason(reason) {
  const raw = String(reason || '');
  if (!raw) return 'unknown';
  const r = raw.toLowerCase();
  /*
   * ★ 공급자 이름이 실려 있으면 «API 쪽 사건» 이다.
   *
   *   DbError.classifyDbError 는 원래 Supabase 응답을 분류하려고 만든
   *   것이라 "fetch failed" / "network error" / 5xx 같은 전송 계층 낱말을
   *   전부 DB_UNAVAILABLE 로 본다. 그 규칙을 그대로 쓰면
   *   «ADPICK 네트워크 오류: fetch failed» 가 db_error 로 들어간다 —
   *   운영자가 DB 를 들여다보게 만드는 잘못된 안내다.
   *
   *   그래서 쿠팡/ADPICK 이 준 사유는 DB 분류를 아예 거치지 않는다.
   *   반대로 공급자 이름이 없는 사유는 DB 를 먼저 묻는다 — 그래야
   *   «canceling statement due to statement timeout» 이 timeout 이 아니라
   *   db_error 로 들어간다 (그건 공급자가 느린 게 아니라 우리 DB 다).
   */
  const fromProvider = /쿠팡|adpick|coupang/i.test(raw);
  if (!fromProvider) {
    const db = DbError.classifyDbError({ message: raw });
    if (db.kind !== DbError.KIND.UNKNOWN) return 'db_error';
  }
  if (r.includes('시간 초과') || r.includes('timeout') || r.includes('timed out')) return 'timeout';
  if (r.includes('차단') || r.includes('중단') || r.includes('403')) return 'blocked';
  if (r.includes('예산') || r.includes('budget')) return 'budget';
  if (r.includes('429') || r.includes('상한') || r.includes('한도')
      || r.includes('간격') || r.includes('대기')) return 'rate_limited';
  if (r.includes('네트워크') || r.includes('network') || r.includes('캐시')
      || r.includes('cache') || r.includes('키 미설정') || r.includes('환경변수')
      || r.includes('api') || r.includes('파싱') || r.includes('파일')) return 'api_error';
  return 'unknown';
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
 *   isBlockedFn  () => boolean — 공급자가 «지금 차단 중인가» 를 시각 기준으로
 *              답하는 함수. 넘기면 회수 패스가 차단을 만나 멈춘 뒤, 차단이
 *              풀리는 것을 보고 남은 시간을 이어서 쓴다(resumeWhenUnblocked).
 *
 *              ★ 기본값이 null 인 것이 중요하다. 이 값이 없으면 «풀렸는지
 *                알 수 없다» 는 뜻이고, 그때는 예전과 똑같이 영구 중단으로
 *                남는다. 모르면서 재개하는 것이 가장 위험하다 —
 *                2026-08-31 의 ADPICK 429 사고가 정확히 그 모양이었다.
 *                그래서 fetchAllFn 만 스텁으로 주는 테스트는 동작이 그대로다.
 *
 *              ★ 지금은 ADPICK 에만 넘긴다. 쿠팡의 차단 신호(403 Access
 *                denied 등)는 성질이 훨씬 무겁고, 이 스크립트가 과거에 쿠팡
 *                이용제한 경고의 주범이었다(파일 머리 주석). 근거 없이
 *                재개를 열지 않는다.
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
                                   cacheHintFn = cacheHintQueries,
                                   isBlockedFn = null,
                                   /*
                                    * V3 (PRICE_COLLECTOR_V3). 셋 다 없으면 레거시 동작 그대로다.
                                    *   planner      { tierOf(row), dayStartMs, limit } — 1차 순서를 기대 회수량으로
                                    *   onCheckpoint (snapshot) => void — 배치마다 진행 상태를 넘긴다
                                    *   abortSignal  { aborted } — 잠금을 잃으면 배치 루프를 멈춘다
                                    */
                                   planner = null,
                                   onCheckpoint = null,
                                   abortSignal = null }) {
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
    mallName, targetProducts: collectible.length, productsTotal: rows.length, noPhraseTotal: noPhrase,
    /*
     * ★ «한 바퀴에 필요한 API 호출 수» (2026-09-22).
     *
     *   이 수집기는 상품 단위로 부르지 않는다 — 검색어 하나로 여러 상품을
     *   덮는다. 그래서 «대상 6만개» 가 «호출 6만회» 를 뜻하지 않는다.
     *   2026-09-22 운영 카탈로그 실측:
     *     쿠팡   22,924개 / 검색어 4,053종 (상품 5.7개/검색어)
     *     ADPICK 46,819개 / 검색어 3,165종 (상품 14.8개/검색어)
     *
     *   «오늘 전량을 돌 수 있는가» 는 상품 수가 아니라 이 값과 호출 예산을
     *   나란히 놓아야 답이 나온다. 그래서 리포트에 그대로 싣는다.
     */
    planGroups: plan.length
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
      /*
       * 아무것도 하지 않은 실행도 상품 단위 상태는 사실대로 채운다.
       * 이번 실행이 시도하지 않았을 뿐, 오늘 누적 상태는 존재한다.
       *   확보함        → collected
       *   오늘 가격 있음 → already_collected
       *   찾아는 봤음   → no_match
       *   그 밖         → pending (이 실행이 시도하지 않았다)
       */
      outcomes: (() => {
        const o = outcomesTemplate();
        const cov = new Set(collectorCoveredIds);
        const att = new Set(collectorAttemptedIds);
        collectible.forEach(p => {
          const k = `${p.product_id}|${p.mall}`;
          if (cov.has(k)) o.collected++;
          else if (done.has(k)) o.already_collected++;
          else if (att.has(k)) o.no_match++;
          else o.pending++;
        });
        return o;
      })(),
      failureCategories: failureCategoriesTemplate(), doneBatches: 0, stoppedEarly: false,
      passStats: [], crossRecovered: 0, optionRejects: {},
      facetDryGroups: (savedState && savedState.last_result && savedState.last_result.facetDryGroups) || [],
      /* 아무 일도 하지 않은 실행이 오늘의 terminal 목록을 지우면 안 된다 (P1). */
      terminalOptionFailures:
        (savedState && savedState.last_result && savedState.last_result.terminalOptionFailures) || [],
      optionMissStreaks:
        (savedState && savedState.last_result && savedState.last_result.optionMissStreaks) || {},
      terminalOptionNew: 0,
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
  /*
   * 오늘 옵션 게이트가 "이 상품은 검색어를 바꿔도 소용없다" 고 확정한 상품
   * (P1, 2026-09-06). terminalOption 주석 참고. 하루 단위로만 이어 간다.
   */
  let priorTerminalOption = [];
  /*
   * 상품별 연속 불일치 카운터도 같이 이어 간다. 이어받기 실행이 0 에서
   * 다시 세면 임계값(OPTION_TERMINAL_MISSES)에 영영 닿지 못한다.
   */
  let priorOptionMissStreaks = {};
  let cursorKey = '', processed = 0, priorFailedKeywords = [];
  const isNewDay = !savedState || savedState.job_date !== TODAY;
  if (!isNewDay) {
    cursorKey = savedState.cursor_key || '';
    processed = savedState.processed || 0;
    priorSecondDone = (savedState.last_result && savedState.last_result.secondPassDone) || [];
    priorTerminalOption = (savedState.last_result && savedState.last_result.terminalOptionFailures) || [];
    priorOptionMissStreaks = (savedState.last_result && savedState.last_result.optionMissStreaks) || {};
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

  /*
   * ★ V3 는 커서가 아니라 «오늘 이미 찾아본 상품» 으로 이어받는다.
   *
   *   순서가 가나다가 아니므로 «커서보다 뒤» 라는 말이 성립하지 않는다.
   *   대신 collectorAttempted(호출이 나가 결과를 받은 상품)·collectorCovered 를
   *   쓴다 — 레거시도 매 실행 이어 적는 목록이라, 같은 날 레거시가 쓴 상태를
   *   V3 가 그대로 이어받을 수 있다. 호출이 실패한 그룹은 attempted 에 들어가지
   *   않으므로 따로 재시도 목록을 두지 않아도 자연히 다시 불린다.
   */
  const v3Plan = !!planner;
  /* 기아 예약 레인 커서 (api/_collectplan.js). 날짜를 넘어 이어진다 — runLocked 가 넘긴다. */
  let starveCursor = v3Plan && planner.starveAfter != null ? planner.starveAfter : null;
  const priorDone = new Set([...priorCollectorAttempted, ...priorCollectorCovered]);
  const pendingRowsOf = (g, extraDone) => g.rows.filter(p => {
    const k = `${p.product_id}|${p.mall}`;
    return !priorDone.has(k) && !(extraDone && extraDone.has(k));
  });
  let remaining = v3Plan
    ? plan.map(g => ({ kw: g.kw, rows: pendingRowsOf(g) })).filter(g => g.rows.length)
    : resumeFrom(plan, cursorKey);
  const failedKeywords = new Map(priorFailedKeywords.map(kw => [kw, '직전 실행에서 실패']));
  const retryGroups = failedKeywords.size && !v3Plan
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
  /*
   * 상품 → «이 상품을 찾으려던 호출이 왜 실패했는가» (2026-09-22).
   * 마지막 사유로 덮는다 — 여러 패스가 같은 상품을 여러 번 시도할 수
   * 있고, 가장 최근 시도가 지금 상태를 가장 잘 말한다.
   * 수집 동작에는 전혀 쓰이지 않는다. 리포트 분류 전용이다.
   */
  const productReason = new Map();
  const noteProductReason = (rows, reason) => {
    if (!reason) return;
    (rows || []).forEach(p => productReason.set(`${p.product_id}|${p.mall}`, String(reason)));
  };
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
      /*
       * ★ terminal 상품도 여기서는 그대로 판정한다 (P1).
       *   이 응답은 다른 상품을 위해 이미 나간 것이라 추가 호출이 0이다.
       *   공짜로 얻을 수 있는 회수를 terminal 표시 때문에 버리지 않는다.
       */
      if (adoptOne(p, items, foundVia) !== 'MATCH') return;  // 옵션이 다르거나 가격이 없다
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
  /*
   * 이 실행이 «시작할 때» 이미 오늘 가격이 있던 상품. 아래 상품 단위
   * 최종 분류(outcomes)에서 already_collected 와 db_error 를 가르는 유일한
   * 근거다 — 둘 다 "uncovered 에는 없는데 이번 실행이 확보하지도 않은"
   * 모양이라, 이 집합 없이는 구분할 수 없다.
   */
  const todayAtStart = new Set();
  if (!isNewDay) {
    const already = await collectedTodayFn(mallName, collectible);
    already.forEach(k => { uncovered.delete(k); todayAtStart.add(k); });
    if (already.size) console.log(`  [${mallName}] 오늘 이미 기록된 ${already.size}개는 건너뜁니다.`);
  }

  /*
   * ── V3 1차 순서 (api/_collectplan.js) ─────────────────────────────
   *   오늘 다른 경로로 이미 가격이 생긴 상품까지 빼고 남은 상품만으로 그룹을
   *   다시 만든 뒤, 기대 회수량 순으로 세운다. 모든 상품이 끝난 그룹은
   *   호출하지 않는다 (레거시는 가격이 이미 있어도 그 그룹을 불렀다).
   */
  if (v3Plan) {
    remaining = remaining
      .map(g => ({ kw: g.kw, rows: pendingRowsOf(g, todayAtStart) }))
      .filter(g => g.rows.length);
    remaining = Planner.orderGroups(remaining, {
      mall: mallName, date: TODAY, dayStartMs: planner.dayStartMs,
      tierOf: planner.tierOf, limit: planner.limit, starveAfter: starveCursor
    });
    processed = planTotal - remaining.reduce((n, g) => n + g.rows.length, 0);
    const starve = remaining.filter(g => g.lane === 'starve').length;
    const exp = n => Planner.expectedWithin(remaining, n).toFixed(0);
    console.log(`  [${mallName}] [V3 계획] 남은 그룹 ${remaining.length}종 (기아 예약 ${starve}종)`
      + ` / 남은 상품 ${planTotal - processed}개 — 기대 회수 앞 100호출 ${exp(100)}개 · 300호출 ${exp(300)}개 · 전부 ${exp(remaining.length)}개`);
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

  /* ── 옵션 게이트의 "확정 실패" (P1, 2026-09-06) ──────────────────
   *
   * ★ 무엇이 잘못돼 있었나.
   *
   *   pickOption 은 실패 사유를 이미 정확히 구분해 낸다. 그런데 adoptOne 이
   *   그것을 boolean 하나로 눌러 버려서, 호출부는 아래 둘을 구분하지 못했다.
   *
   *     NO_PRODUCT_MATCH      응답에 우리 상품이 아예 없었다
   *                           → 다른 검색어로 찾으면 나올 수 있다
   *     OPTION_MISMATCH       상품 페이지는 응답에 있었다. 그런데 우리가
   *     RESPONSE_VID_MISSING  추적하는 vendorItemId 가 그 응답의 옵션 목록에
   *                           없었다 → **검색어를 바꿔도 결과가 같다**
   *
   *   그래서 회수 사다리가 뒤의 두 경우에도 r1..r10 을 끝까지 돌았다.
   *
   *   운영 실측 (2026-09-06 KST, 읽기 전용):
   *     오늘 쿠팡 collect 호출 2,200회 중, 옵션 게이트가 거부한 상품들의
   *     사다리 검색어로 나간 호출이 상당 부분을 차지했다(재현 기준 최대 494회).
   *
   * ★ 단, 한 번의 불일치는 확정이 아니다 — OPTION_TERMINAL_MISSES 주석의
   *   실측 참고. 쿠팡은 검색어마다 다른 옵션을 대표로 싣기 때문에, 첫
   *   불일치로 끊으면 69%가 오판이다. 그래서 **연속 불일치가 임계값에
   *   도달했을 때만** 확정한다. 중간에 우리 옵션이 한 번이라도 나오면
   *   카운터는 0 으로 돌아간다.
   *
   * ★ 이것은 매칭을 느슨하게 하는 변경이 아니다 — 호출을 덜 하는 변경이다.
   *   채택 기준(pickOption)은 한 줄도 바뀌지 않는다. 다른 옵션의 가격을
   *   대신 기록하는 일은 여전히 없고, 그 상품은 그냥 미수집으로 남는다.
   *
   * ★ 영구 차단이 아니다. 쿠팡이 그 옵션을 다시 노출하거나 재색인할 수
   *   있으므로 하루(KST) 단위로만 유지한다. isNewDay 가 리셋하고,
   *   price_job_state.last_result 안의 JSONB 키 하나로만 이어진다
   *   (새 테이블도, 스키마 변경도 없다).
   *
   * ★ 교차 매칭은 막지 않는다. 이 집합은 "이 상품 때문에 새 호출을 내지
   *   말라" 는 뜻이지 "이 상품을 더 보지 말라" 가 아니다. 다른 상품을 위해
   *   이미 나간 응답에 우리 옵션이 들어 있으면 그대로 채택하고, 그때
   *   terminal 표시를 지운다 (adoptOne 의 MATCH 경로).
   */
  const TERMINAL_OPTION_REASONS = ['OPTION_MISMATCH', 'RESPONSE_VID_MISSING'];
  const collectibleKeySet = new Set(collectible.map(p => `${p.product_id}|${p.mall}`));
  const terminalOption = new Set(priorTerminalOption.filter(k => collectibleKeySet.has(k)));
  const terminalOptionNew = new Set();
  /*
   * 상품별 "연속으로 우리 옵션이 없었던 응답" 수. 하루 단위로 이어 간다 —
   * 이어받기 실행이 0 에서 다시 시작하면 임계값에 영원히 닿지 못한다.
   */
  const optionMissStreak = new Map(
    Object.entries(priorOptionMissStreaks).filter(([k]) => collectibleKeySet.has(k))
  );
  /** 오늘 이 상품에 대해 회수 검색어를 더 내도 소용없는가. */
  const isTerminalOption = (p) => terminalOption.has(`${p.product_id}|${p.mall}`);

  /**
   * 응답에서 이 타겟의 옵션을 골라 채택한다. 옵션이 다르면 채택하지 않는다.
   *
   * ★ 반환이 boolean 이 아니라 상태다 (P1). 호출부가 "옵션이 달라서 실패" 와
   *   "응답에 없어서 실패" 를 구분할 수 있어야 하기 때문이다. 채택 여부는
   *   `=== 'MATCH'` 하나로 판정한다.
   *
   * @param {object} target
   * @param {Array}  items    접히지 않은 응답 항목(allItems)
   * @param {string} foundVia 이 응답을 만든 검색어
   * @returns {'MATCH'|'NO_PRICE'|'OPTION_MISMATCH'|'RESPONSE_VID_MISSING'
   *          |'NO_PRODUCT_MATCH'|'TARGET_VID_UNKNOWN'|'NO_TARGET_ID'} 판정 결과
   */
  function adoptOne(target, items, foundVia) {
    const key = `${target.product_id}|${target.mall}`;
    const pick = pickOption(target, items);
    if (!pick.item) {
      optionRejects.set(pick.reason, (optionRejects.get(pick.reason) || 0) + 1);
      if (pick.reason === 'OPTION_MISMATCH' && optionRejectLogged < OPTION_REJECT_LOG_MAX) {
        optionRejectLogged++;
        console.warn(`  [${mallName}] OPTION_MISMATCH productId=${target.product_id}`
          + ` targetVendorItemId=${pick.want} responseVendorItemId=[${(pick.got || []).join(', ')}]`
          + ` 검색어="${String(foundVia).slice(0, 40)}" — 다른 옵션이라 채택하지 않습니다.`);
      }
      /*
       * ★ 여기가 P1 의 전부다. 사유가 확정 실패 후보면 연속 카운터를 올리고,
       *   임계값(OPTION_TERMINAL_MISSES)에 닿았을 때만 terminal 로 적는다.
       *
       *   NO_PRODUCT_MATCH 는 여기 오지 않는다 — 호출부가 응답에 그 productId
       *   가 있을 때만 이 함수를 부르기 때문이다. 혹시 오더라도 아래 목록에
       *   없으므로 카운터조차 올라가지 않는다.
       */
      if (TERMINAL_OPTION_REASONS.indexOf(pick.reason) > -1) {
        const n = (optionMissStreak.get(key) || 0) + 1;
        optionMissStreak.set(key, n);
        if (n >= OPTION_TERMINAL_MISSES && !terminalOption.has(key)) {
          terminalOption.add(key);
          terminalOptionNew.add(key);
        }
      }
      return pick.reason;
    }
    if (!addRow(target, pick.item, foundVia)) return 'NO_PRICE';
    /*
     * 옵션이 실제로 돌아왔다 — 앞선 응답들의 판단은 더 이상 유효하지 않다.
     * (검색어마다 다른 옵션이 오므로 이런 일이 실제로 흔하다 —
     *  OPTION_TERMINAL_MISSES 주석의 실측 참고)
     */
    optionMissStreak.delete(key);
    terminalOption.delete(key);
    terminalOptionNew.delete(key);
    return 'MATCH';
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
      noteProductReason(groupRows, e.message);
      console.log(`  [${mallName}] [실패] [${kw}] ${e.message} — 나머지는 계속 진행합니다.`);
      return;
    }

    if (!r.ok) {
      notePass('pass1', { ok: false, hit: 0 });
      failedKeywords.set(kw, r.reason);
      noteAttemptFailure(r.reason);
      noteProductReason(groupRows, r.reason);
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
      if (adoptOne(target, respItems, kw) !== 'MATCH') return;  // 옵션이 다르면 채택하지 않는다
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

  /*
   * 다음 실행이 이어받는 데 필요한 값만 담은 스냅숏 (V3 체크포인트).
   * 최종 결과 객체와 같은 이름·같은 상한(slice)을 쓴다 — 두 경로가 저장하는
   * 모양이 갈리면 어느 쪽에서 끊겼느냐에 따라 이어받기가 달라진다.
   * status 는 언제나 running 이다. 완료 판정은 실행 끝의 최종 저장만 한다.
   */
  function checkpointSnapshot() {
    return {
      cursorKey, processed, total: planTotal, status: 'running', starveCursor,
      failedKeywords: [...failedKeywords.keys()],
      collectorCovered: [...collectorCovered].filter(k => collectibleKeySet.has(k)),
      collectorAttempted: [...collectorAttempted].filter(k => collectibleKeySet.has(k)),
      secondPassDone: priorSecondDone.slice(-3000),
      facetDryGroups: priorFacetDry,
      terminalOptionFailures: [...terminalOption].slice(-3000),
      optionMissStreaks: Object.fromEntries(
        [...optionMissStreak.entries()].filter(([k]) => !terminalOption.has(k)).slice(-3000))
    };
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
    if (abortSignal && abortSignal.aborted) {
      stoppedEarly = true;
      console.warn(`⛔ [${mallName}] 잠금을 잃었습니다 — 배치 루프를 멈춥니다 (다른 실행이 이어받는다).`);
      break;
    }
    const batch = batches[b];
    attemptedGroups.push(...batch);
    const batchProducts = batch.reduce((n, g) => n + g.rows.length, 0);
    const batchStart = Date.now();

    const s = await runBatch(batch);

    if (!v3Plan) cursorKey = batch[batch.length - 1].kw;
    else starveCursor = Planner.advanceStarveCursor(starveCursor, batch);
    processed += batchProducts;
    doneBatches++;
    if (onCheckpoint) onCheckpoint(checkpointSnapshot());

    const elapsedS = Math.round((Date.now() - batchStart) / 1000);
    console.log(`  [${mallName}] └ 배치 ${b + 1}/${batches.length} 완료 — 상품 ${batchProducts}개,`
      + ` 기록 ${s.recorded}행, ${elapsedS}초  [누적 ${processed}/${planTotal}]`);

    const usedUp = Date.now() >= deadlineTs;
    if (usedUp && b < batches.length - 1) {
      stoppedEarly = true;
      console.log(`⏱  [${mallName}] 시간 예산 도달 — 여기까지 저장하고 종료합니다.`
        + (v3Plan ? ' 다음 실행이 남은 그룹을 다시 계획해 이어갑니다.'
          : ` 다음 실행이 "${cursorKey}" 다음부터 이어갑니다.`));
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
  let recoveryFailed = false;
  let recoveryHalted = false;
  const secondPassTried = [];
  let facetCalls = 0, facetRecovered = 0;
  /*
   * 캐시 힌트 패스의 호출 수. 블록 밖에서 선언하는 이유는 회수 합계 로그와
   * secondPassCalls 합산이 이 값을 읽어야 하기 때문이다.
   * 회수 하위 상한(SECOND_PASS_MAX_CALLS)에 이 값을 넣지 «않는» 근거는
   * canCall() 주석에 실측과 함께 적어 두었다.
   */
  let hintCalls = 0;

  if (SECOND_PASS_ENABLED && !stoppedEarly) {
    const attemptedNow = [...retryGroups, ...attemptedGroups].flatMap(g => g.rows);
    const attemptedNowKeys = new Set(attemptedNow.map(p => `${p.product_id}|${p.mall}`));
    const alreadyTried = new Set(priorSecondDone);

    /** 이 상품이 회수 패스 대상인가 — 1차가 "성공적으로" 지나간 것만. */
    const eligible = (p) => {
      const k = `${p.product_id}|${p.mall}`;
      /*
       * ★ 옵션 게이트가 확정 실패를 낸 상품은 오늘 회수 대상이 아니다 (P1).
       *   상품 페이지는 이미 응답에 있었고 우리 옵션만 없었다 — 검색어를
       *   바꿔도 같은 응답이 온다. 여기서 걸러 두면 캐시 힌트·facet 그룹
       *   선정·사다리·secondPassRemaining 계산이 한꺼번에 이 상품을 뺀다.
       *   (terminalOption 주석 참고. 하루가 바뀌면 리셋된다)
       */
      if (terminalOption.has(k)) return false;
      if (pass1Succeeded.has(k)) return true;                  // 이번 실행에서 1차 성공
      const kw = p.keyword || searchPhraseFromTitle(p.title);  // 오늘 앞선 실행이 1차를 돈 것
      /* V3: 커서가 없다. 오늘 앞선 실행이 실제로 찾아본 상품인가로 가른다. */
      if (v3Plan) return priorDone.has(k) && !failedKeywords.has(kw);
      if (!kw || !cursorKey || kw > cursorKey) return false;
      return !failedKeywords.has(kw);
    };

    /*
     * 예산·시간이 남았는가. rate limit 은 fetchAllFn 이 지킨다.
     *
     * ★ hintCalls 는 «일부러» 이 상한에서 뺀다 (2026-09-08 감사).
     *
     *   처음엔 이걸 회계 버그로 보고 상한 안에 넣었다. 측정이 그 판단을
     *   뒤집었다. SECOND_PASS_MAX_CALLS 의 목적은 "1차·facet·사다리 몫을
     *   남긴다" 인데, 그 몫을 남겨서 돌아오는 것이 거의 없다.
     *
     *   같은 날 패스별 실측 회수율 (KST 2026-09-08, 실행 4회):
     *     hint    0.58~0.61 개/호출   ← 캐시가 실제로 그 상품을 돌려줬던 문구
     *     facet   0.05      개/호출   (43회 → 2개)
     *     사다리 r1 0.08     개/호출   (228회 → 19개)
     *     사다리 r2 0.02     개/호출   (136회 → 3개)
     *   자릿수가 다르다. hint 를 420 에서 끊고 그 뒤를 사다리에 넘기면
     *   호출당 회수가 10분의 1로 떨어진다 — 실측으로 44회를 옮길 때 약 26개를
     *   잃는다.
     *
     *   그리고 hint 는 «스스로 마른다». 후보 수가 실행마다
     *     run2 1,211종 → run3 494종 → run4 12종
     *   으로 줄어, 마르는 순간 남은 예산이 자동으로 facet·사다리로 간다
     *   (run4 가 정확히 그렇게 돌았다). 즉 이 상한이 하던 일을 후보 고갈이
     *   이미 하고 있고, 상한은 «잘 듣는 패스를 일찍 끊는» 역할만 한다.
     *
     * ★ 그래서 hint 는 이 하위 상한 대신 «진짜 벽» 세 개로만 묶는다. 셋 다
     *   우회 불가능한 자리에 있다.
     *     · deadlineTs            — 바로 아래 줄
     *     · COUPANG_RUN_BUDGET    — fetchCoupangAll 안, 캐시 적중을 뺀 실호출만 센다
     *     · COUPANG_DAY_BUDGET    — 같은 함수, 하루 총량
     *   실측으로 이 셋이 먼저 걸린다: hint 반복 423회일 때 실제 API 는 418회로
     *   시간 상한(420) 아래였다.
     *   (scripts/test-second-pass.js §13-A 가 이 관계를 고정한다)
     */
    const canCall = () => !recoveryHalted
      && secondPassCalls + facetCalls < SECOND_PASS_MAX_CALLS
      && Date.now() < deadlineTs;

    /*
     * ── 차단이 «풀린 뒤» 를 되찾는다 (2026-09-08) ────────────────────────
     *
     * ★ 먼저, 바꾸지 «않는» 것부터.
     *
     *   차단을 만나면 즉시 회수 호출을 멈추는 것(recoveryHalted)은 그대로다.
     *   그건 2026-08-31 에 실제로 난 사고를 막는 장치다 — ADPICK 1차가 서킷
     *   브레이커로 전부 막힌 상태에서 2차가 120회를 더 태웠고, 회수는 0이었고,
     *   그 호출이 일일 쿼터를 갉아먹어 HTTP 429 까지 갔다. 막힌 API 를 계속
     *   두드리는 것은 낭비일 뿐 아니라 유해하다.
     *   (scripts/test-second-pass.js §5·§8 이 이 성질을 고정한다)
     *
     * ★ 그런데 «멈춘 뒤 영원히 안 돌아오는 것» 은 그 사고와 아무 상관이 없다.
     *
     *   ADPICK 의 흔한 차단은 15초 타임아웃 3연속으로 열리는 **2분**짜리다
     *   (api/_adpick.js COOLDOWN_MIN.network). 모듈은 2분 뒤 스스로 푼다.
     *   그런데 이 함수의 recoveryHalted 는 실행이 끝날 때까지 남았다.
     *
     *   실측 (gh run 34164621465, 2026-09-07T21:51Z):
     *     ADPICK 몫 8분 중 실제로 쓴 시간 70초. 남은 6.8분과 회수 검색어
     *     1,564종을 2분짜리 차단 하나 때문에 통째로 버렸다.
     *
     * ★ 그래서 «공급자가 풀렸다고 말할 때만» 재개한다.
     *
     *   판단 근거는 추측이 아니라 공급자 모듈의 시각 기반 상태(isBlockedFn)다.
     *   그 함수를 넘겨받지 못하면(=풀렸는지 알 길이 없으면) 예전과 똑같이
     *   영구 중단으로 남는다. 모르면 보수적으로 — 이게 기본값이다.
     *   그래서 fetchAllFn 만 스텁으로 넣는 테스트의 동작은 한 줄도 안 바뀐다.
     *
     * ★ 기다리는 동안 호출은 0회다. 무한 재시도가 아니고 네 겹으로 막혀 있다.
     *     · 공급자가 «아직 차단» 이라고 말하는 동안에만 잔다
     *     · 총 대기가 RECOVERY_BLOCK_MAX_WAITS × WAIT_MS(=3분)를 넘으면
     *       영구 중단으로 승격한다 — 15분(429)·60분(403) 짜리 진짜 차단은
     *       여기서 걸려 예전과 똑같이 실행의 회수 패스를 끝낸다
     *     · 대기는 deadlineTs 를 넘지 않는다
     *     · 호출 상한(SECOND_PASS_MAX_CALLS)·예산 검사는 그대로다
     *
     * ★ 분당 호출 속도는 한 자리도 바뀌지 않는다. 재개한 뒤에도 간격·전역
     *   분당 상한·서킷 브레이커가 그대로 정한다. 이 블록이 되찾는 것은
     *   «불러도 되는데 부르지 않고 놀던 시간» 하나뿐이다.
     */
    const HALT_PERMANENT = ['budget', 'noKeys'];
    const HALT_TEMPORARY = ['blocked', 'rateLimit'];
    let blockWaitedMs = 0;

    /**
     * 차단이 풀릴 때까지만 기다렸다가 회수 패스를 재개한다.
     * 공급자 상태를 알 수 없으면(isBlockedFn 미주입) 아무것도 하지 않는다 —
     * 그 경우 recoveryHalted 가 그대로 남아 예전처럼 실행이 끝난다.
     */
    async function resumeWhenUnblocked() {
      if (typeof isBlockedFn !== 'function') return;
      const maxWaitMs = RECOVERY_BLOCK_MAX_WAITS * RECOVERY_BLOCK_WAIT_MS;
      while (isBlockedFn()) {
        if (blockWaitedMs >= maxWaitMs) {
          console.warn(`  [${mallName}] 차단이 ${Math.round(maxWaitMs / 1000)}초를 넘겨 계속됩니다`
            + ' — 짧은 딸꾹질이 아니라고 보고 이번 실행의 회수 패스를 마칩니다.');
          return;                       // recoveryHalted 를 그대로 둔 채 끝낸다
        }
        const room = deadlineTs - Date.now();
        if (room <= 0) return;
        const nap = Math.min(RECOVERY_BLOCK_WAIT_MS, room);
        await sleep(nap);
        blockWaitedMs += nap;
      }
      // 공급자가 «풀렸다» 고 말했다 — 남은 시간과 예산이 있으면 이어서 부른다.
      if (Date.now() >= deadlineTs) return;
      recoveryHalted = false;
      console.log(`  [${mallName}] 차단이 풀렸습니다 (누적 대기 ${Math.round(blockWaitedMs / 1000)}초)`
        + ' — 회수 패스를 이어갑니다.');
    }

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
      catch (e) {
        recoveryFailed = true;
        notePass(pass, { ok: false, hit: 0 }); noteAttemptFailure(e.message);
        noteProductReason(rows, e.message);
        return { ok: false, items: -1, hit: 0 };
      }
      if (!r.ok) {
        recoveryFailed = true;
        const category = categorizeFailure(r.reason);
        notePass(pass, { ok: false, hit: 0 }); noteAttemptFailure(r.reason);
        noteProductReason(rows, r.reason);
        /*
         * ★ 중단 자체는 예전과 똑같다 — 사유가 무엇이든 여기서 즉시 멈춘다.
         *   달라지는 것은 그다음뿐이다: 시간이 지나면 풀리는 사유에 한해,
         *   공급자가 «풀렸다» 고 말하면 남은 시간을 이어서 쓴다
         *   (resumeWhenUnblocked 주석 참고).
         */
        if (HALT_PERMANENT.indexOf(category) > -1 || HALT_TEMPORARY.indexOf(category) > -1) {
          recoveryHalted = true;
        }
        if (HALT_TEMPORARY.indexOf(category) > -1) await resumeWhenUnblocked();
        return { ok: false, items: -1, hit: 0 };
      }

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
        if (adoptOne(target, respItems, query) !== 'MATCH') return;
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
        // ★ hintCalls 는 바깥 변수다 (선언부 주석 참고) — canCall() 이 매
        //   반복마다 이 값을 보고 회수 상한을 지킨다.
        let hintHit = 0;
        for (const [q, pids] of byQuery) {
          if (!canCall()) break;
          // 앞선 호출이 이미 잡았거나, 옵션 게이트가 확정 실패를 낸 상품은 뺀다 (P1).
          const targets = [...uncovered.values()]
            .filter(p => pids.indexOf(String(p.product_id)) > -1 && !isTerminalOption(p));
          if (!targets.length) continue;
          hintCalls++;
          const res = await callAndMatch(q, targets, 'hint');
          if (!res.ok) continue;
          hintHit += res.hit;
          if (res.hit) console.log(`  [${mallName}] [hint] "${q}" +${res.hit}`);
        }
        console.log(`  [${mallName}] 캐시 힌트 완료 — 호출 ${hintCalls}회, 회수 ${hintHit}개`);
        /*
         * ★ 여기서 secondPassCalls 에 더하지 않는다. 더하면 canCall() 이
         *   hintCalls 를 두 번 세게 되어(바깥 변수 + 합산분) 회수 상한이
         *   실제의 절반으로 줄어든다. 합산은 facet 과 똑같이 패스가 전부
         *   끝난 뒤 한 번만 한다 (아래 secondPassCalls += facetCalls + hintCalls).
         */
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
          /*
           * ★ terminal 상품은 타겟에서 뺀다 (P1). 라운드 도중에 terminal 이
           *   된 상품이 남은 facet 을 계속 살려 두는 것을 막는다 — 그 상품
           *   때문에 나가는 추가 호출을 0으로 만드는 것이 이 패스의 목적이다.
           */
          const targets = g.rows.filter(p => uncovered.has(`${p.product_id}|${p.mall}`)
            && !isTerminalOption(p));
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
        /*
         * 앞선 호출이 이미 잡았거나(uncovered 에서 빠짐), 이 라운드 도중에
         * 옵션 게이트가 확정 실패를 냈으면(terminal) 타겟에서 뺀다 (P1).
         * 남는 타겟이 없으면 이 검색어는 호출하지 않는다.
         */
        const targets = rows.filter(p => uncovered.has(`${p.product_id}|${p.mall}`)
          && !isTerminalOption(p));
        if (!targets.length) continue;
        secondPassCalls++; secondPassGroups++; roundCalls++;
        const res = await callAndMatch(q, targets, `r${round + 1}`);
        if (!res.ok) continue;
        secondPassRecovered += res.hit; roundHit += res.hit;
      }
      console.log(`  [${mallName}] 회수 R${round + 1} — 검색어 ${byQuery.size}종 중 ${roundCalls}회 호출, +${roundHit}개`);

      // 남은 수는 모든 라운드가 끝난 뒤 현재 uncovered 기준으로 다시 계산한다.
      // 여기서 현재 라운드만 세면 라운드 경계에서 예산이 끝날 때 뒤 라운드가
      // 0개로 사라져 completed 오판이 난다.
    }

    /*
     * 아직 부르지 못한 회수 검색어를 전체 라운드 + facet 후보에서 다시 센다.
     * 실패한 호출은 alreadyTried에 들어가지 않으므로 다음 cron에서 재시도된다.
     * 이 계산이 0이어도 이번 실행에 transport 실패가 있었으면 status는 running이다.
     */
    const pendingRecovery = new Set();
    [...uncovered.values()].filter(eligible).forEach(p => {
      const qs = queryPlan.get(`${p.product_id}|${p.mall}`) || [];
      qs.forEach(q => { if (q && !alreadyTried.has(q)) pendingRecovery.add(q); });
    });
    plan.filter(g => g.rows.length > FACET_MIN_GROUP && !facetDry.has(g.kw) && g.rows.some(eligible))
      .forEach(g => {
        const coveredIds = new Set(
          g.rows.filter(p => !uncovered.has(`${p.product_id}|${p.mall}`)).map(p => String(p.product_id))
        );
        buildFacetQueries(g.kw, g.rows, coveredIds, FACET_POOL_PER_GROUP)
          .forEach(f => { if (f.query && !alreadyTried.has(f.query)) pendingRecovery.add(f.query); });
      });
    secondPassRemaining = pendingRecovery.size;

    if (obsMap.size) {
      const s = await saveAll();
      obsMap.clear();
      totalRecorded += s.recorded; totalSaved += s.saved;
      totalRejected += s.rejected; totalSuspect += s.suspect;
    }
    if (secondPassCalls || facetCalls || hintCalls) {
      console.log(`  [${mallName}] 회수 패스 합계 — 호출 ${secondPassCalls + facetCalls + hintCalls}회`
        + ` (hint ${hintCalls} / facet ${facetCalls}), 회수 ${secondPassRecovered + facetRecovered}개,`
        + ` 남은 검색어 ${secondPassRemaining}종`);
    }
    secondPassRecovered += facetRecovered;
    // 합산은 여기 한 번뿐이다 (캐시 힌트 블록의 주석 참고).
    secondPassCalls += facetCalls + hintCalls;
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
  const status = isFullyDone && !failedKeywords.size && secondPassRemaining === 0 && !recoveryFailed
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

  /*
   * ── 상품 단위 최종 상태 (OUTCOME_KEYS 주석 참고) ─────────────
   *
   * 대상 상품을 정확히 한 칸씩 넣는다. 우선순위가 곧 정의다:
   *   ① 수집기가 확보했다            → collected
   *   ② 오늘 가격은 있다(다른 경로)  → already_collected
   *   ③ 호출이 나가 응답을 받았다    → no_match
   *   ④ 못 나갔다                    → 마지막 실패 사유로 분류
   *   ⑤ 사유 기록이 없다             → 아직 차례가 안 왔으면 pending,
   *                                     이번 실행이 예산/시간으로 끊겼으면 budget
   *
   * ★ 이 계산은 읽기 전용이고 수집 동작에 전혀 영향을 주지 않는다.
   *   위에서 이미 확정된 집합(uncovered / collectorCovered /
   *   collectorAttempted / productReason)만 다시 세는 것이다.
   */
  const coveredSet = new Set(collectorCoveredIds);
  const attemptedSet = new Set(collectorAttemptedIds);
  const outcomes = outcomesTemplate();
  /* 사유를 알 수 없는 미시도 상품이 pending 인지 budget 인지의 기준. */
  const ranOutOfRoom = stoppedEarly;
  collectible.forEach(p => {
    const key = `${p.product_id}|${p.mall}`;
    if (coveredSet.has(key)) { outcomes.collected++; return; }
    if (!uncovered.has(key)) {
      /*
       * uncovered 에서 빠졌는데 collectorCovered 에는 없다 = 응답에는
       * 있었는데 원장에 행이 남지 않았다 (값 이상 거부 / upsert 실패).
       * markCovered 주석의 "이 둘이 갈리는 경우" 가 정확히 이것이다.
       * 그것을 already_collected 로 세면 «오늘 가격이 있다» 는 거짓말이 된다.
       */
      if (todayAtStart.has(key)) outcomes.already_collected++;
      else outcomes.db_error++;
      return;
    }
    if (attemptedSet.has(key)) { outcomes.no_match++; return; }
    const reason = productReason.get(key);
    if (reason) { outcomes[outcomeFromReason(reason)]++; return; }
    outcomes[ranOutOfRoom ? 'budget' : 'pending']++;
  });

  return {
    outcomes,
    ...base,
    skipped: false,
    cursorKey, processed, total: planTotal, status,
    starveCursor,
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
    /*
     * 오늘 옵션 게이트가 확정 실패를 낸 상품 (P1, terminalOption 주석 참고).
     * 같은 날 후속 실행이 이 상품들에 회수 검색어를 다시 내지 않게 이어 간다.
     * 하루가 바뀌면 isNewDay 가 읽지 않으므로 자동으로 리셋된다.
     * 상한은 secondPassDone 과 같은 이유로 둔다.
     */
    terminalOptionFailures: [...terminalOption].slice(-3000),
    /*
     * 아직 임계값에 닿지 않은 상품의 연속 불일치 카운터. 이어받기 실행이
     * 이어서 세야 확정이 성립한다 (OPTION_TERMINAL_MISSES 주석 참고).
     * 확정된 상품은 terminalOptionFailures 로 옮겨졌으므로 여기서 뺀다.
     */
    optionMissStreaks: Object.fromEntries(
      [...optionMissStreak.entries()].filter(([k]) => !terminalOption.has(k)).slice(-3000)
    ),
    /* 이번 실행에서 새로 확정된 수 — 리포트/시뮬레이션이 효과를 볼 수 있게. */
    terminalOptionNew: terminalOptionNew.size,
    // 오늘 누적 시도 목록. 무한히 커지지 않도록 상한을 둔다.
    secondPassDone: [...priorSecondDone, ...secondPassTried].slice(-3000)
  };
}

// ─── 메인 ─────────────────────────────────────────────────────
const CACHE_RETENTION_DEFAULT_MS = 24 * 60 * 60 * 1000;

function cacheRetentionMs(envName) {
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw > 0 ? raw : CACHE_RETENTION_DEFAULT_MS;
}

/**
 * 검색 캐시는 재생성 가능한 파생 데이터다.
 *
 * active TTL은 6시간이고 공급자 장애 시 stale fallback만 잠깐 쓴다.
 * fallback 상한을 넘긴 row를 계속 들고 있으면 JSONB TOAST가 DB 용량을
 * 크게 잡아먹는다(2026-09-19 실측: Coupang 86MB + ADPICK 12MB).
 *
 * 실패해도 collector 본체는 계속 돈다. 캐시 정리 실패가 가격 수집 실패보다
 * 중요한 일은 아니다.
 */
async function pruneSearchCaches() {
  const specs = [
    ['coupang_search_cache', cacheRetentionMs('COUPANG_STALE_MAX_MS')],
    ['adpick_search_cache', cacheRetentionMs('ADPICK_STALE_MAX_MS')]
  ];
  const result = {};
  for (const [table, keepMs] of specs) {
    const cutoff = new Date(Date.now() - keepMs).toISOString();
    try {
      const { count, error } = await supabase
        .from(table)
        .delete({ count: 'exact' })
        .lt('fetched_at', cutoff);
      if (error) throw new Error(error.message);
      result[table] = Number(count) || 0;
      console.log(`[cache prune] ${table}: ${result[table]}행 삭제 (보존 ${Math.round(keepMs / 3600000)}시간)`);
    } catch (e) {
      result[table] = null;
      console.warn(`[cache prune] ${table} 정리 실패 — 수집은 계속: ${e.message}`);
    }
  }
  return result;
}

async function run() {
  const state = await loadState();

  /*
   * ★ 잠금을 먼저 잡는다 (acquireLock 주석의 실측 겹침 참고).
   *   못 잡으면 아무것도 하지 않고 정상 종료한다 — 실패가 아니라
   *   "다른 실행이 하고 있다" 이므로 exit 0 이어야 Actions 가 빨간불이 되지 않는다.
   */
  const lock = await acquireLock(state);
  if (!lock.ok) {
    if (lock.transient) {
      // 다른 실행이 도는 게 아니라 DB 가 답하지 못했다. 초록불로 숨기지 않는다.
      console.error(`[잠금] 이번 실행을 시작하지 못했습니다 — ${lock.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[잠금] 이번 실행은 건너뜁니다 — ${lock.reason}`);
    return;
  }
  console.log(`[잠금] 획득 (${lock.token}) — TTL ${Math.round(LOCK_TTL_MS / 60000)}분`);
  try {
    if (!state || state.job_date !== TODAY || state.status !== 'completed') {
      await pruneSearchCaches();
    }
    await runLocked(state, lock.token);
  } finally {
    await releaseLock(lock.token);
    console.log('[잠금] 해제');
  }
}

/** 잠금을 쥔 상태에서 도는 본체. 예외는 호출부(run)가 finally 로 받는다. */
async function runLocked(state, lockToken) {
  /*
   * 오늘 수집 대상의 정체성을 먼저 정한다. 같은 날짜라도 2026-09-21 이전
   * completed 상태에는 targetSignature 가 없으므로 새 회전 정책 배포 즉시
   * 기존 커서를 버리고 다시 시작한다.
   */
  const targetMeta = collectorTargetMeta(TODAY);
  /*
   * ★ V3 계획기는 서명 끝에 ':planner-v3' 를 붙인다.
   *   V3 상태의 cursor_key 는 비어 있다(커서로 이어받지 않는다). 레거시가 그 상태를
   *   이어받으면 «커서 없음 = 처음부터» 로 읽어 오늘 찾아본 검색어를 다시 부른다.
   *   서명이 다르면 레거시는 상태를 초기화하고 새로 시작한다 — 호출 낭비는 있어도
   *   잘못 이어받지는 않는다. 반대로 V3 는 같은 날 레거시 상태를 그대로 이어받는다
   *   (레거시도 collectorAttempted/Covered 를 매 실행 적으므로 정보가 충분하다).
   */
  const previousTargetSignature = state && state.last_result && state.last_result.targetSignature;
  const targetStateMatches = !state || state.job_date !== TODAY
    || resumeCompatible(previousTargetSignature, targetMeta);
  targetMeta.signature = targetSignatureFor(targetMeta);
  const resumeState = targetStateMatches ? state : null;

  if (state && state.job_date === TODAY && !targetStateMatches) {
    console.log(`\n[진행] 오늘 수집 대상 정책이 바뀌었습니다 — 기존 상태를 리셋하고 새 대상 집합으로 시작합니다.`);
    console.log(`       이전=${previousTargetSignature || '(없음)'} / 현재=${targetMeta.signature}`);
  }

  const savedMalls = (resumeState && resumeState.last_result && resumeState.last_result.malls) || {};
  const coupangSaved = resumeState
    ? { job_date: resumeState.job_date, cursor_key: resumeState.cursor_key,
        processed: resumeState.processed, total: resumeState.total,
        status: resumeState.status,
        last_result: {
          failedKeywords: (resumeState.last_result || {}).failedKeywords || [],
          /*
           * 오늘 앞선 실행이 확보한 상품 목록. 이걸 안 넘기면 이어받기 실행이
           * 빈 집합에서 시작해 성공률이 자기 몫으로 축소된다.
           */
          collectorCovered: (savedMalls['쿠팡'] && savedMalls['쿠팡'].collectorCovered) || [],
          collectorAttempted: (savedMalls['쿠팡'] && savedMalls['쿠팡'].collectorAttempted) || [],
          secondPassDone: (savedMalls['쿠팡'] && savedMalls['쿠팡'].last_result
            && savedMalls['쿠팡'].last_result.secondPassDone)
            || (resumeState.last_result && resumeState.last_result.secondPassDone) || [],
          facetDryGroups: (savedMalls['쿠팡'] && savedMalls['쿠팡'].last_result
            && savedMalls['쿠팡'].last_result.facetDryGroups) || [],
          terminalOptionFailures: (savedMalls['쿠팡'] && savedMalls['쿠팡'].last_result
            && savedMalls['쿠팡'].last_result.terminalOptionFailures) || [],
          optionMissStreaks: (savedMalls['쿠팡'] && savedMalls['쿠팡'].last_result
            && savedMalls['쿠팡'].last_result.optionMissStreaks) || {}
        } }
    : null;

  const adpickSaved = savedMalls['ADPICK']
    ? {
        job_date: resumeState.job_date, ...savedMalls['ADPICK'],
        last_result: {
          failedKeywords: savedMalls['ADPICK'].failedKeywords || [],
          collectorCovered: savedMalls['ADPICK'].collectorCovered || [],
          collectorAttempted: savedMalls['ADPICK'].collectorAttempted || [],
          secondPassDone: (savedMalls['ADPICK'].last_result || {}).secondPassDone || [],
          facetDryGroups: (savedMalls['ADPICK'].last_result || {}).facetDryGroups || [],
          terminalOptionFailures: (savedMalls['ADPICK'].last_result || {}).terminalOptionFailures || [],
          optionMissStreaks: (savedMalls['ADPICK'].last_result || {}).optionMissStreaks || {}
        }
      }
    : null;

  const coupangDoneToday = resumeState && resumeState.job_date === TODAY
    && resumeState.status === 'completed';
  const adpickDoneToday  = resumeState && resumeState.job_date === TODAY
    && savedMalls['ADPICK'] && savedMalls['ADPICK'].status === 'completed';

  if (coupangDoneToday && adpickDoneToday) {
    console.log(`\n[진행] ${TODAY} (KST) 작업은 두 몰 모두 이미 완료되었습니다`
      + ` — 쿠팡 ${resumeState.processed}/${resumeState.total}, ADPICK ${savedMalls['ADPICK'].processed}/${savedMalls['ADPICK'].total}.`
      + ` 이번 실행은 아무 상품도 처리하지 않습니다.`);
    console.log(`       대상 정책: ${targetMeta.signature}`);
    return;
  }

  /*
   * ★ 대상을 «먼저» 정하고, 그 대상만 읽는다 (2026-09-20 감사).
   *
   *   예전 순서는 «전체 69,666행을 내려받고 → 2,965행만 남긴다» 였다.
   *   같은 결과를 얻으면서 29MB 를 매 실행 버렸다 (fetchProductsByIds 주석의
   *   실측 참고). 순서만 뒤집으면 행 집합은 한 줄도 달라지지 않는다.
   *
   *   PRICE_INCLUDE_BULK_SEED=1(비상 우회) 과 PRICE_SEED_ONLY=1(시드 모드)은
   *   대상이 카탈로그 전체이므로 예전처럼 전체 스캔을 그대로 쓴다.
   */
  const target = SEED_ONLY ? null : await fetchCollectorTargetKeys(targetMeta);
  const catalog = await countCatalog();

  let products;
  let dailyTargetProducts = 0;
  let rotationTargetProducts = 0;

  if (target) {
    products = await fetchProductsByIds(target.keys, catalog ? catalog.total : 0);
    dailyTargetProducts = target.dailyKeys.size;
    rotationTargetProducts = target.rotationKeys.size;

    if (targetMeta.mode === 'rotation') {
      console.log(`\n[collector 대상] 상시 추적 + 전체 카탈로그 회전 수집`);
      console.log(`  상시 추적 ${dailyTargetProducts}개 + 회전 ${rotationTargetProducts}개`
        + ` = 오늘 대상 ${target.keys.size}개`);
      console.log(`  회전 버킷 ${target.rotationBucket + 1}/${target.rotationDays}`
        + ` — 지원 몰 전체를 ${target.rotationDays}일 주기로 나눠 갱신합니다.`);
    } else {
      console.log(`\n[collector 대상] 상시 추적 카탈로그만 갱신합니다 (회전 수집 비활성).`);
      console.log(`  대상 키 ${target.keys.size}개 → products ${products.length}행`);
    }
    if (catalog) console.log(`  카탈로그 전체 ${catalog.total}행 중 오늘 ${products.length}행을 읽었습니다.`);
  } else {
    products = await fetchAllProducts();
    dailyTargetProducts = products.length;
    if (!SEED_ONLY) {
      console.warn('\n[collector 대상] PRICE_INCLUDE_BULK_SEED=1 — 전체 products 를 한 번에 수집 대상으로 사용합니다.');
    }
  }

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

  /*
   * ★ 분모를 이름으로 구분해 찍는다 (2026-09-20 감사).
   *
   *   "products 전체" 와 "수집 대상" 이 같은 줄에 섞여 있어서, seed 이후
   *   69,666 과 2,965 중 어느 쪽이 수집률의 분모인지 로그만으로는 알 수 없었다.
   *   카탈로그 규모는 head 요청으로만 세므로 행을 내려받지 않는다.
   */
  console.log(`\n가격 수집 시작 (${TODAY}, ${kstNowStamp()})`);
  if (catalog) {
    console.log(`  카탈로그 전체        ${catalog.total}개  (쿠팡 ${catalog.coupang} / ADPICK ${catalog.adpick}`
      + `${catalog.other ? ` / 기타 ${catalog.other}` : ''})  ← 수집률의 분모가 아니다`);
  }
  console.log(`  수집 대상            ${products.length}개${SEED_ONLY ? ' (시드 모드 — 실제 대상은 위 필터 참고)' : ''}`);
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

  /*
   * ★ 쿠팡 1차가 오늘 이미 끝났는가 — 시간 배분의 유일한 판단 근거다
   *   (adpickReserveMs 주석의 실측 참고). 저장된 진행 상태만 보고 정하므로
   *   추가 조회도, API 호출도 없다.
   *
   *   커서가 계획 끝에 닿으면 processed 가 total 에 이른다. total 이 0 이면
   *   («아직 아무것도 안 돌았다») 1차가 끝났다고 볼 수 없으므로 제외한다.
   */
  const coupangPass1Done = !!(coupangSaved && coupangSaved.job_date === TODAY
    && Number(coupangSaved.total) > 0
    && Number(coupangSaved.processed) >= Number(coupangSaved.total));
  const adpickReserve = adpickReserveMs(coupangPass1Done);
  const coupangShare = coupangBudgetMs(adpickReserve);
  if (V3_PARALLEL) {
    console.log(`시간 배분: [V3 병렬] 쿠팡·ADPICK 모두 ${Math.round(RUN_TIME_BUDGET_MS / 60000)}분`
      + ` — 제공자별 분당 한도·간격은 그대로, 두 레인이 동시에 돈다.`);
  } else {
    console.log(`시간 배분: 쿠팡 ${Math.round(coupangShare / 60000)}분`
      + ` / ADPICK ${Math.round(adpickReserve / 60000)}분`
      + `  (쿠팡 1차 ${coupangPass1Done ? '완료 — ADPICK 에 더 준다' : '진행 중 — 쿠팡 몫을 지킨다'})`);
  }
  if (V3) {
    await loadAdpickDayUsage();
    console.log(`ADPICK 오늘 호출량: ${_adpickDayUsed}회 / 하루 상한 ${ADPICK_DAY_BUDGET}회`
      + ` (이번 실행 상한 ${ADPICK_RUN_BUDGET}회)`);
    console.log(`[V3] 계획기 ${V3_PLANNER ? 'ON' : 'OFF'} / 병렬 ${V3_PARALLEL ? 'ON' : 'OFF'}`
      + ` / 체크포인트 ${V3_CHECKPOINT ? 'ON' : 'OFF'}  (대상 서명 ${targetMeta.signature})`);
  }

  /* V3 계획기 입력 — tier 는 대상 RPC 가 준 값, 경과는 products.collected_at. */
  const dayStartMs = Date.parse(kstDayStartUtc(TODAY));
  const tierOfRow = p => (target && target.rotationKeys && target.rotationKeys.has(`${p.product_id}|${p.mall}`)
    ? 'rotation' : 'daily');
  /*
   * 기아 레인 커서는 날짜를 넘어 이어진다 — 하루가 바뀌어도 어제 멈춘 자리 다음부터
   * 굶은 그룹을 부른다. 그래서 오늘 상태가 아니라 «마지막 상태» 에서 읽는다.
   */
  const priorStarve = (state && state.last_result && state.last_result.plannerStarveCursor) || {};
  const plannerFor = (limit, mall) => (V3_PLANNER
    ? { tierOf: tierOfRow, dayStartMs, limit, starveAfter: priorStarve[mall] == null ? null : priorStarve[mall] }
    : null);

  /*
   * 체크포인트 기록기. 오늘 이어받은 상태를 바탕으로 깔고 레인 스냅숏만 덮는다 —
   * 아직 스냅숏이 없는 레인(이미 완료됐거나 시작 전)의 오늘 상태를 지우지 않기 위해서다.
   */
  const writer = V3_CHECKPOINT ? createCheckpointWriter({
    lockToken,
    base: {
      jobDate: TODAY,
      targetSignature: targetMeta.signature,
      prevLastResult: resumeState && resumeState.job_date === TODAY
        ? (() => { const { lock, malls, ...rest } = resumeState.last_result || {}; return rest; })()  // eslint-disable-line no-unused-vars
        : {},
      malls: resumeState && resumeState.job_date === TODAY ? savedMalls : {},
      plannerStarveCursor: priorStarve
    },
    onLost: () => { _runAborted = true; }
  }) : null;

  const coupangArgs = {
    mallName: '쿠팡', rows: coupangRows, fetchAllFn: fetchCoupangAll,
    savedState: coupangSaved,
    planner: plannerFor(COUPANG_LIMIT, '쿠팡'),
    onCheckpoint: writer ? snap => writer.note('쿠팡', snap) : null,
    abortSignal: writer ? writer.abortSignal : null
  };
  const adpickArgs = {
    mallName: 'ADPICK', rows: adpickRows, fetchAllFn: fetchAdpickAll,
    savedState: adpickSaved,
    /*
     * ★ ADPICK 에만 넘긴다 (isBlockedFn 문서 참고). 흔한 차단이 15초 타임아웃
     *   3연속으로 열리는 2분짜리라, 그것 하나로 8분 예산을 통째로 버리는 일이
     *   매 실행 벌어지고 있었다. 쿠팡에는 넘기지 않는다.
     */
    isBlockedFn: isAdpickBlockedGlobal,
    planner: plannerFor(ADPICK_LIMIT, 'ADPICK'),
    onCheckpoint: writer ? snap => writer.note('ADPICK', snap) : null,
    abortSignal: writer ? writer.abortSignal : null
  };

  let coupangResult, adpickResult;
  if (V3_PARALLEL) {
    /*
     * ★ 두 레인이 공유하는 것은 DB 쓰기(서로 다른 mall 행)와 콘솔뿐이다. 호출 예산·
     *   간격·서킷은 몰마다 따로 있는 모듈 변수(_coupang* / _adpick*)와 모듈
     *   (api/_coupang.js / api/_adpick.js)에 있다. 상태 저장은 두 레인이 끝난 뒤
     *   한 번, 중간에는 기록기가 한 줄로 합쳐 쓴다 — 레인끼리 서로를 덮지 않는다.
     *
     * ★ allSettled — 한 레인의 예외가 다른 레인의 진행을 버리지 않게 한다.
     *   예외가 났으면 남은 스냅숏을 저장한 뒤 그 예외를 그대로 올린다.
     */
    const deadlineTs = started + RUN_TIME_BUDGET_MS;
    const [c, a] = await Promise.allSettled([
      runMallCollection({ ...coupangArgs, deadlineTs }),
      runMallCollection({ ...adpickArgs, deadlineTs })
    ]);
    if (c.status === 'rejected' || a.status === 'rejected') {
      if (writer) await writer.flush();
      throw (c.status === 'rejected' ? c.reason : a.reason);
    }
    coupangResult = c.value;
    adpickResult = a.value;
  } else {
    // ── 쿠팡 먼저 — 자기 몫이 다 되면 남은 시간을 ADPICK 에게 넘긴다.
    coupangResult = await runMallCollection({ ...coupangArgs, deadlineTs: started + coupangShare });
    // ── ADPICK — 쿠팡이 일찍 끝났으면 남은 시간을 전부 받는다(최소 절반 보장).
    adpickResult = await runMallCollection({ ...adpickArgs, deadlineTs: started + RUN_TIME_BUDGET_MS });
  }
  coupangResult.apiCalls = _coupangCalls;
  adpickResult.apiCalls = _adpickCalls;

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
    console.log(`  검색시도 ${r.attemptCalls} / 성공 ${r.attemptSuccess} / 실패 ${r.attemptFailed}  (${cats})`);
    console.log(`  외부API 실제 호출 ${r.apiCalls || 0}`);
    console.log(`  저장   price_history ${r.recorded}행 / products ${r.saved}행`
      + ` / 급변 보류 ${r.suspect} / 값 이상 거부 ${r.rejected}`);
    console.log(`  진행   오늘 ${r.processed}/${r.total} (검색 그룹에 담긴 상품 ${r.processedProducts}개)`);
    console.log(`  한바퀴 검색어 ${r.planGroups}종 = 1회전에 필요한 API 호출 ${r.planGroups}회`
      + `  (대상 ${r.targetProducts}개 ÷ ${r.planGroups}종 = 검색어당 ${r.planGroups > 0 ? (r.targetProducts / r.planGroups).toFixed(1) : '-'}개)`);
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

  const finalState = {
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
      /*
       * V3 카나리 비활성화 표식은 그날 끝까지 살아 있어야 한다. 레거시 실행도
       * last_result 를 통째로 새로 쓰므로 여기서 이어 적지 않으면 다음 칸이 V3 를 다시 켠다.
       */
      ...(state && state.job_date === TODAY && state.last_result && state.last_result.v3Kill
        && state.last_result.v3Kill.date === TODAY ? { v3Kill: state.last_result.v3Kill } : {}),
      targetSignature: targetMeta.signature,
      /* V3 기아 레인 커서 — 레거시 실행은 이 값을 모르므로 계획기를 쓸 때만 적는다. */
      ...(V3_PLANNER ? { plannerStarveCursor: mergeStarveCursor(priorStarve,
        { '쿠팡': coupangResult.starveCursor, 'ADPICK': adpickResult.starveCursor }) } : {}),
      targetMode: targetMeta.mode,
      rotationDays: targetMeta.rotationDays,
      rotationBucket: targetMeta.rotationBucket,
      dailyTargetProducts,
      rotationTargetProducts,
      productsTotal: catalog ? catalog.total : products.length,
      targetLoadedProducts: products.length,
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
            facetDryGroups: coupangResult.facetDryGroups || [],
            // 오늘 확정된 옵션 실패 (P1) — 같은 날 후속 실행이 이어받는다.
            terminalOptionFailures: coupangResult.terminalOptionFailures || [],
            optionMissStreaks: coupangResult.optionMissStreaks || {}
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
            facetDryGroups: adpickResult.facetDryGroups || [],
            // 오늘 확정된 옵션 실패 (P1) — 같은 날 후속 실행이 이어받는다.
            terminalOptionFailures: adpickResult.terminalOptionFailures || [],
            optionMissStreaks: adpickResult.optionMissStreaks || {}
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
  };
  if (writer) {
    const ok = await writer.finalize(finalState);
    console.log(`[체크포인트] 중간 저장 ${writer.stats.writes}회 / 실패 ${writer.stats.failures}회`
      + ` / 최종 저장 ${ok ? '완료' : '못 함'}${writer.stats.lost ? ' — 잠금 상실' : ''}`);
    if (writer.stats.lost) process.exitCode = 1;
  } else {
    await saveState(finalState);
  }

  // ── 수집 결과 이메일 발송 (실패해도 수집 결과에 영향 없음, 여기서 절대 throw 하지 않는다) ──
  const sum = (f) => (Number(coupangResult[f]) || 0) + (Number(adpickResult[f]) || 0);
  const report = {
    execAt: kstNowStamp(),
    date: TODAY,
    productsTotal: catalog ? catalog.total : products.length,
    targetLoadedProducts: products.length,
    dailyTargetProducts,
    rotationTargetProducts,
    rotationDays: targetMeta.rotationDays,
    rotationBucket: targetMeta.rotationBucket,
    targetMode: targetMeta.mode,
    otherTotal: otherRows.length,
    otherByMall: Object.fromEntries(otherByMall),
    malls: [coupangResult, adpickResult],

    /*
     * ── 상품 단위 최종 상태 (OUTCOME_KEYS 주석 참고) ──
     *   모든 칸의 합 = targetProducts. reportInvariantErrors 가 고정한다.
     *   target_query_error 는 여기서 언제나 0 이다 — 대상 조회가 실패하면
     *   이 코드에 닿기 전에 run() 이 죽고 sendFailureNotice 가 그 사실을
     *   따로 보낸다.
     */
    outcomes: OUTCOME_KEYS.reduce((o, k) => {
      o[k] = ((coupangResult.outcomes || {})[k] || 0) + ((adpickResult.outcomes || {})[k] || 0);
      return o;
    }, {}),

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
    apiCalls: sum('apiCalls'),
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
    // 1차 자체가 예산·차단 등으로 응답을 못 받아 다음 실행에서 다시 불러야 하는 검색어.
    retryQueueRemaining: (coupangResult.failedKeywords || []).length
      + (adpickResult.failedKeywords || []).length,

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
  {
    const o = report.outcomes || {};
    const oSum = OUTCOME_KEYS.reduce((t, k) => t + (Number(o[k]) || 0), 0);
    console.log(`  최종 상태 분류 합계 = 대상              ${oSum} = ${report.targetProducts}`);
    console.log(`    ${OUTCOME_KEYS.map(k => `${k} ${Number(o[k]) || 0}`).join(' / ')}`);
  }
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

  /*
   * ★ V3 카나리 자동 비활성화. 이상 신호가 하나라도 있으면 그날 남은 실행은
   *   레거시로 돌아간다 (scripts/v3-canary-gate.js 가 이 표식을 읽는다).
   */
  if (V3) {
    const killReason = v3KillReason({
      adpick429: /\b429\b/.test(`${_adpickBlockMsg} ${as.blockReason || ''}`),
      coupangBlocked, adpickBlocked, violations,
      lockLost: !!(writer && writer.stats.lost), collectedNothing
    });
    if (killReason) await markV3Kill(lockToken, killReason);
  }

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
  /*
   * 상품 단위 최종 상태는 모집단을 «남김없이, 겹침없이» 나눈다.
   * 합이 대상 수와 다르면 어떤 상품이 두 칸에 들어갔거나 어느 칸에도
   * 못 들어간 것이고, 둘 다 분류 규칙이 틀렸다는 뜻이다.
   */
  if (report.outcomes) {
    const oSum = OUTCOME_KEYS.reduce((t, k) => t + n(report.outcomes[k]), 0);
    if (oSum !== target) {
      out.push(`상품 단위(최종 상태): 분류 합계 ${oSum} ≠ 대상 ${target}`);
    }
    if (n(report.outcomes.collected) !== cOk) {
      out.push(`상품 단위(최종 상태): collected ${n(report.outcomes.collected)}`
        + ` ≠ 수집 성공 ${cOk} — 같은 사실을 두 곳이 다르게 세고 있다`);
    }
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
 *   attempt 단위 검색 attempt / 성공·실패 / 실패 원인  (검색어 처리 1회 = 1)
 *   API 단위     실제 외부 API 호출                        (cache·budget 거절 제외)
 *   행 단위      price_history 저장 / products 갱신 / 급변 보류 / 값 이상 거부
 *
 *   2026-09-01 리포트가 "실패 26 인데 실패 원인 합계 151" 로 나온 것은
 *   실패 개수는 검색어 단위, noMatch 는 상품 단위였기 때문이다. 그래서
 *   섹션 제목에까지 단위를 적는다 — 읽는 사람이 단위를 추측할 일이 없어야 한다.
 */
function buildReportHtml(report) {
  const {
    execAt, date, productsTotal, targetLoadedProducts,
    dailyTargetProducts, rotationTargetProducts, rotationDays, rotationBucket,
    otherTotal, otherByMall, malls, failCats, outcomes,
    targetProducts, collectorSuccessProducts, collectorMissingProducts,
    attemptedProducts, skippedProducts, noMatchProducts,
    todayPriceProducts, uncoveredProducts,
    attemptCalls, attemptSuccess, attemptFailed, attemptCallsRecovery, apiCalls,
    recorded, saved, suspect, rejected, processedProducts,
    passStats, recoveryQueueRemaining, retryQueueRemaining
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

  /*
   * ── 상품 단위 최종 상태 (2026-09-22) ─────────────────────────
   *
   * ★ 이 표만이 «미확보 n개가 왜 비었는가» 에 답한다. 기존 두 축은
   *   상품 수(얼마나)와 호출 실패 사유(왜 호출이 실패했나)를 따로 말할 뿐,
   *   «이 상품» 과 «그 사유» 를 잇지 못했다.
   *
   * ★ 0인 칸도 지우지 않는다. 지우면 합이 맞는지 눈으로 확인할 수 없고,
   *   "이번엔 왜 이 칸이 안 보이지" 를 매번 다시 따져야 한다.
   */
  const OUTCOME_LABEL = {
    collected:          ['수집 성공', '수집기가 오늘 직접 확보', '#0b7a4b'],
    already_collected:  ['이미 수집됨', '다른 경로(검색·cron·AI)가 오늘 기록', '#0b7a4b'],
    no_match:           ['무매칭', '응답을 받았으나 우리 상품/옵션이 없음', '#8a6d3b'],
    blocked:            ['차단', '403 · 이용제한 · 서킷 브레이커', '#c9362b'],
    rate_limited:       ['호출 제한', '429 · 분당/일일 상한 · 간격 대기', '#c9362b'],
    timeout:            ['응답 시간 초과', '', '#c9362b'],
    api_error:          ['API 오류', '5xx · 파싱 실패 · 키 미설정', '#c9362b'],
    db_error:           ['DB 오류', '응답은 받았으나 원장에 남지 않음', '#c9362b'],
    budget:             ['예산 소진', '이번 실행의 호출·시간 예산이 끝남', '#8a6d3b'],
    pending:            ['대기', '오늘 아직 차례가 오지 않음 (다음 실행 몫)', '#888'],
    target_query_error: ['대상 조회 실패', '수집 대상 자체를 못 읽음', '#c9362b'],
    unknown:            ['원인 불명', '', '#c9362b']
  };
  const outcomeSum = OUTCOME_KEYS.reduce((t, k) => t + num((outcomes || {})[k]), 0);
  const outcomeRows = OUTCOME_KEYS.map(k => {
    const [label, hint, color] = OUTCOME_LABEL[k];
    const v = num((outcomes || {})[k]);
    return `<tr>
      <td style="padding:5px 0;font-size:13px;color:#444">${esc(label)}
        <span style="color:#bbb;font-size:11px">${esc(k)}${hint ? ' · ' + hint : ''}</span></td>
      <td style="padding:5px 0;text-align:right;font-weight:${v ? 700 : 400};color:${v ? color : '#ccc'}">${v}</td>
    </tr>`;
  }).join('');

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
      ${num(rotationDays) > 0 ? row('└ 상시 추적 <span style="color:#bbb">(매일)</span>', num(dailyTargetProducts)) : ''}
      ${num(rotationDays) > 0 ? row(`└ 회전 수집 <span style="color:#bbb">(버킷 ${num(rotationBucket) + 1}/${num(rotationDays)})</span>`, num(rotationTargetProducts)) : ''}
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
      ${row('시도율 <span style="color:#bbb">attempted ÷ target</span>', pct(rateOf(attemptedProducts, targetProducts)), { bold: true })}
      ${row('시도 대비 성공률 <span style="color:#bbb">success ÷ attempted</span>', pct(rateOf(collectorSuccessProducts, attemptedProducts)), { bold: true })}
      ${row('전체 수집 성공률 <span style="color:#bbb">success ÷ target</span>', pct(rateOf(collectorSuccessProducts, targetProducts)), { bold: true })}
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
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin:14px 0 4px">상품별 최종 상태 <span style="color:#bbb;font-weight:400">(단위: 상품 · 한 상품은 한 칸에만)</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">
      ${outcomeRows}
    </table>
    <div style="font-size:11px;color:${outcomeSum === num(targetProducts) ? '#bbb' : '#c9362b'};margin-top:4px">
      분류 합계 ${outcomeSum} ${outcomeSum === num(targetProducts) ? '=' : '≠'} 대상 ${num(targetProducts)}
      ${outcomeSum === num(targetProducts) ? '' : ' — 분류 규칙이 모집단을 남김없이 나누지 못하고 있다'}<br>
      ※ «대기» 는 장애가 아니다 — 오늘 남은 실행이 이어서 처리할 몫이다.
    </div>
  </td></tr>

  <tr><td style="padding:20px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:4px">수집 실행 <span style="color:#bbb;font-weight:400">(검색 시도와 실제 외부 API 호출을 분리)</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">
      ${row('검색 attempt (collector 검색 시도)', num(attemptCalls), { bold: true })}
      ${row('실제 외부 API 호출', num(apiCalls), { bold: true })}
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
      ※ 처리 상품 수는 검색 시도 횟수가 아니다 — 한 attempt가 여러 상품을 덮는다.<br>
      ※ budget·차단처럼 API 입구에서 거절된 attempt는 실제 외부 API 호출에 포함되지 않는다.<br>
      ※ price_history 값은 upsert 로 보낸 행 수다. 같은 날 같은 (상품·몰·vendor)을 다시
      수집하면 UNIQUE 제약으로 기존 행을 덮으므로, DB 에 새로 생긴 행 수는 이보다 적을 수 있다.
    </div>
  </td></tr>

  <tr><td style="padding:20px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:4px">패스별 성적 <span style="color:#bbb;font-weight:400">(어느 검색 전략이 얼마에 얼마를 건졌나)</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border:1px solid #eee;border-radius:6px">
      <tr style="background:#f8f8f7">
        <td style="padding:6px 12px;color:#888;font-size:11px">패스</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">검색시도</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">응답</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">적중 시도</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">회수 상품</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">시도당 회수</td>
      </tr>
      ${passRows}
    </table>
    <div style="font-size:11px;color:#bbb;margin-top:4px">
      pass1 = 1차 키워드 검색 · facet = 큰 그룹 분할 · r1~r9 = 상품별 검색어 사다리(라운드).<br>
      ※ 비교 기준은 "시도당 회수" 다 — 한 검색 시도가 여러 상품을 덮으므로 회수 상품 수만으로는 전략을 비교할 수 없다.<br>
      남은 1차 재시도 큐(예산·차단 등으로 응답 못 받음): <b>${num(retryQueueRemaining)}</b>종<br>
      남은 회수 큐(1차 응답 후 추가 검색 전략): <b>${num(recoveryQueueRemaining)}</b>종
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
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">검색<br>attempt</td>
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
      ${num(targetLoadedProducts) > 0 ? row('오늘 로드한 수집 대상', num(targetLoadedProducts)) : ''}
      ${num(rotationDays) > 0 ? row(`전체 카탈로그 회전 주기`, `${num(rotationDays)}일`) : ''}
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
/**
 * 실행이 죽은 «단계» 를 이름으로 돌려준다 (2026-09-22).
 *
 * 몰별 집계가 없는 실패에서는 상품 단위 분류(outcomes)를 만들 수 없다.
 * 그래도 «대상 조회에서 죽었다» 와 «저장에서 죽었다» 는 완전히 다른
 * 사건이고, 메일 제목만 보고 구분할 수 있어야 한다.
 * 이 값은 outcomes 의 target_query_error 칸과 같은 이름을 쓴다.
 */
function failureStage(err) {
  const m = String((err && err.message) || err || '');
  if (/collector_target_page|collector_target_products|collector_eligible_products|collector_refresh_eligible|대상 조회/.test(m)) {
    return 'target_query_error';
  }
  if (/price_job_state/.test(m)) return 'state_error';
  if (/products 조회|price_history 조회/.test(m)) return 'db_error';
  const kind = DbError.classifyDbError({ message: m }).kind;
  if (kind !== DbError.KIND.UNKNOWN) return 'db_error';
  return 'unknown';
}

async function sendFailureNotice(err) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const email = require('../api/_channel/email');
    const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head>
<body style="font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;padding:32px;background:#f5f5f4">
<div style="background:#fff;border-radius:12px;padding:32px;max-width:560px;margin:0 auto">
  <div style="font-size:18px;font-weight:800;color:#c9362b">⚠️ SEOSA 가격 수집 — 실행 자체가 실패했습니다</div>
  <div style="font-size:13px;color:#888;margin-top:8px">기준 날짜(KST): ${TODAY} / 실행 시각: ${kstNowStamp()}</div>
  <div style="font-size:13px;color:#888;margin-top:4px">실패 단계: <b style="color:#c9362b">${failureStage(err)}</b></div>
  <div style="margin-top:20px;padding:16px;background:#fdf2f2;border-radius:8px;font-size:13px;color:#c9362b;white-space:pre-wrap;word-break:break-word">${
    String((err && err.message) || err).replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 2000)
  }</div>
  <div style="margin-top:16px;font-size:12px;color:#aaa">몰별 수집 로직에 도달하기 전에 예외가 발생해, 몰별 결과 집계 없이 이 알림만 보냅니다. GitHub Actions 로그를 확인하세요.</div>
</div>
</body></html>`;
    const result = await email.send({
      to: REPORT_EMAIL,
      subject: `[SEOSA] ${TODAY} 가격 수집 실패 — 실행 자체가 중단됨 (${failureStage(err)})`,
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
  // 전체 카탈로그 회전 수집 — 순수 함수는 test-price-batch 가 고정한다.
  rotationBucketForDate, collectorTargetMeta, BULK_ROTATION_DAYS,
  // 리포트 집계의 계약 — 테스트가 이 둘로 불변조건을 고정한다.
  reportInvariantErrors, productSuccessRate, todayPriceRate,
  /*
   * 상품 단위 최종 상태 — test-collector-scale 이 «합 = 대상» 과
   * 사유→칸 매핑을 고정한다.
   */
  OUTCOME_KEYS, outcomesTemplate, outcomeFromReason, failureStage,
  // 키셋 스캔 — 커서 진행/중복 없음/커서 컬럼 누락 검출을 테스트가 고정한다.
  keysetScan, TARGET_PAGE, fetchTargetPages, refreshEligibleCache,
  TODAY_SCAN_THRESHOLD, collectedTodayByDayScan,
  // 동시 실행 방지 — test-price-mall-collection 이 CAS/만료/보존을 고정한다.
  acquireLock, releaseLock, LOCK_TTL_MS,
  // 상태 읽기의 오류 분류 — test-audit-regressions 가 일시 장애 재시도/표 없음 안내를 고정한다.
  loadState, STATE_MISSING_HINT,
  // .in() URI 상한 회귀 — test-price-mall-collection 이 이 계약을 고정한다.
  chunkIdsByLength, ID_BATCH_CHARS,
  // 파생 캐시 보존/정리 — storage 회귀 테스트가 이 계약을 고정한다.
  pruneSearchCaches, cacheRetentionMs, CACHE_RETENTION_DEFAULT_MS,
  // V3 — test-collector-v3 가 체크포인트 모양·잠금 조건·플래그 기본값을 고정한다.
  createCheckpointWriter, checkpointPayload, mallStateFromSnapshot, targetSignatureFor, resumeCompatible,
  v3KillReason, markV3Kill, loadAdpickDayUsage,
  V3, V3_PLANNER, V3_PARALLEL, V3_CHECKPOINT, ADPICK_DAY_BUDGET
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
