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
const { kstToday } = require('../api/_price');

// 헤더 로그용. price_history.recorded_date / price_job_state.job_date 와 같은 KST 기준.
const TODAY = kstToday();
const CONCURRENCY   = 4;
const PAGE          = 1000;
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
 */
const COUPANG_RUN_BUDGET  = Number(process.env.COUPANG_RUN_BUDGET) || 400;
/** ADPICK 도 같은 안전판. ADPICK 상품 수(282, 2026-08-29 실측)가 쿠팡보다 훨씬
 *  적어 이 값을 넘길 일이 당분간 없지만, 폭주 방지용으로 똑같이 둔다. */
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
const BATCH_INTERVAL_MS = Number(process.env.PRICE_BATCH_INTERVAL_MS) || 60000;

/*
 * 이 실행이 쓸 수 있는 시간. GitHub Actions 의 timeout-minutes 보다 넉넉히 짧게.
 * 예산을 넘기면 진행 상태를 저장하고 정상 종료한다 — 다음 실행이 이어받는다.
 *
 * ★ 몰별로 절반씩 나눠 쓴다 (runMallCollection 의 deadlineTs).
 *   쿠팡을 먼저 돌리고 남는 시간을 ADPICK에 넘기는 구조라, 쿠팡이 정상이면
 *   ADPICK 은 최소 절반(기본 25분)을 보장받는다. 쿠팡이 차단되거나 예산을
 *   금방 소진해 일찍 끝나면 ADPICK 은 그만큼 더 받는다 — 반대로 쿠팡이
 *   시간을 다 채워도 ADPICK 몫(절반)은 침범하지 않는다.
 */
const RUN_TIME_BUDGET_MS = Number(process.env.PRICE_RUN_BUDGET_MS) || 50 * 60 * 1000;
const MALL_BUDGET_MS     = Math.floor(RUN_TIME_BUDGET_MS / 2);

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

// ─── 몰별 API 호출 상태 (쿠팡) ─────────────────────────────
let _coupangBlocked = false;
let _coupangBlockMsg = '';
let _coupangCalls = 0;      // 실제로 나간 호출 수 (캐시 적중은 제외)
let _coupangSkipped = 0;    // 예산/상한/차단으로 건너뛴 횟수
let _coupangBudgetWarned = false;

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

  return {
    ok: true,
    reason: '',
    items: r.items.map(it => ({
      productId: it.productId,
      title: it.title,
      lprice: it.lprice,
      oprice: it.oprice,
      link: it.link,
      image: it.image,
      mall: '쿠팡',
      itemId: it.itemId || '',
      vendorItemId: it.vendorItemId || '',
    }))
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
      .select('product_id, mall, title, keyword, link, image')
      .order('product_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error('products 조회 실패: ' + error.message);
    all.push(...(data || []));
    if (!data || data.length < PAGE) return all;
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
    .select('job_date, cursor_key, processed, total, status, last_result')
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

const failureCategoriesTemplate = () => ({
  blocked: 0, budget: 0, staleCache: 0, network: 0,
  noMatch: 0, noKeys: 0, rateLimit: 0, other: 0
});

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
 */
async function runMallCollection({ mallName, rows, fetchAllFn, savedState, deadlineTs }) {
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
    mallName, target: collectible.length, productsTotal: rows.length, noPhraseTotal: noPhrase
  };

  if (savedState && savedState.job_date === TODAY && savedState.status === 'completed') {
    console.log(`[${mallName}] ${TODAY} (KST) 작업은 이미 완료되었습니다 — 이번 실행은 처리하지 않습니다.`);
    return {
      ...base, skipped: true,
      cursorKey: savedState.cursor_key || '', processed: savedState.processed || 0, total: savedState.total || planTotal,
      status: 'completed', failedKeywords: [],
      attempted: 0, success: 0, recorded: 0, saved: 0, rejected: 0, suspect: 0,
      uncollected: 0, failureCategories: failureCategoriesTemplate(), doneBatches: 0, stoppedEarly: false
    };
  }

  let cursorKey = '', processed = 0, priorFailedKeywords = [];
  const isNewDay = !savedState || savedState.job_date !== TODAY;
  if (!isNewDay) {
    cursorKey = savedState.cursor_key || '';
    processed = savedState.processed || 0;
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

  if (!remaining.length && !retryGroups.length && !isNewDay) {
    console.log(`[${mallName}] 남은 검색어가 없습니다 — 오늘 작업을 완료로 표시합니다.`);
    return {
      ...base, skipped: false,
      cursorKey, processed, total: planTotal, status: 'completed', failedKeywords: [],
      attempted: 0, success: 0, recorded: 0, saved: 0, rejected: 0, suspect: 0,
      uncollected: 0, failureCategories: failureCategoriesTemplate(), doneBatches: 0, stoppedEarly: false
    };
  }
  if (!remaining.length && !retryGroups.length && isNewDay) {
    // 이 몰에 오늘 처리할 검색어 자체가 없다(상품 0개 등) — 바로 완료.
    return {
      ...base, skipped: false,
      cursorKey: '', processed: 0, total: 0, status: 'completed', failedKeywords: [],
      attempted: 0, success: 0, recorded: 0, saved: 0, rejected: 0, suspect: 0,
      uncollected: 0, failureCategories: failureCategoriesTemplate(), doneBatches: 0, stoppedEarly: false
    };
  }

  console.log(`── [${mallName}] 검색 (남은 검색어 ${remaining.length}종 / 전체 ${plan.length}종,`
    + ` 배치당 ${BATCH_PRODUCTS}개 상품, 간격 ${Math.round(BATCH_INTERVAL_MS / 1000)}초) ──`);

  const uncovered = new Map();
  collectible.forEach(p => uncovered.set(`${p.product_id}|${p.mall}`, p));
  const markCovered = (pid, mall) => uncovered.delete(`${pid}|${mall}`);

  const obsMap = new Map();
  const failureCategories = failureCategoriesTemplate();
  let recovered = 0;
  const notFoundKeywords = [];
  let totalRecorded = 0, totalSaved = 0, totalRejected = 0, totalSuspect = 0;
  let doneBatches = 0;
  let stoppedEarly = false;

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
    });
    return true;
  }

  async function saveAll() {
    const savedRows = [...obsMap.values()];
    if (savedRows.length === 0) return { saved: 0, recorded: 0, total: 0, rejected: 0, suspect: 0 };
    let recorded = 0, saved = 0, rejected = 0, suspect = 0;
    const errors = [];
    for (let i = 0; i < savedRows.length; i += UPSERT_CHUNK) {
      const r = await recordPrices(savedRows.slice(i, i + UPSERT_CHUNK), { label: `collect:${mallName}` });
      recorded += r.recorded; saved += r.saved; rejected += r.rejected; suspect += r.suspect;
      if (r.errors.length) errors.push(...r.errors);
    }
    if (errors.length) console.error(`  [${mallName}] [DB 오류 원문]`, errors.slice(0, 3).join(' | '));
    return { saved, recorded, total: savedRows.length, rejected, suspect };
  }

  /** 검색어 그룹 하나를 처리한다. 실패해도 던지지 않는다 — 호출부가 계속 돈다. */
  async function processGroup({ kw, rows: groupRows }) {
    const byId = new Map();
    groupRows.forEach(p => byId.set(p.product_id, p));

    let r;
    try {
      r = await fetchAllFn(kw);
    } catch (e) {
      failedKeywords.set(kw, e.message);
      console.log(`  [${mallName}] [실패] [${kw}] ${e.message} — 나머지는 계속 진행합니다.`);
      return;
    }

    if (!r.ok) {
      failedKeywords.set(kw, r.reason);
      failureCategories[categorizeFailure(r.reason)]++;
      console.log(`  [${mallName}] [보류] [${kw}] ${r.reason} — 재시도 대상`);
      return;
    }

    let hit = 0;
    r.items.forEach(item => {
      const target = byId.get(item.productId);
      if (target && addRow(target, item, kw)) {
        markCovered(target.product_id, target.mall);
        hit++;
        if (!target.keyword) recovered++;
      }
    });

    failedKeywords.delete(kw);

    if (hit === 0) {
      notFoundKeywords.push(kw);
      failureCategories.noMatch += groupRows.length;
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

  if (recovered) {
    console.log(`  [${mallName}] ✅ keyword 가 없던 상품 ${recovered}개를 찾아 검색어를 채웠습니다.`);
  }

  const isFullyDone = !stoppedEarly && batches.length === doneBatches;
  const status = isFullyDone && !failedKeywords.size ? 'completed' : 'running';

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

  return {
    ...base,
    skipped: false,
    cursorKey, processed, total: planTotal, status,
    failedKeywords: [...failedKeywords.keys()],
    attempted: attempted.length,
    success,
    recorded: totalRecorded, saved: totalSaved, rejected: totalRejected, suspect: totalSuspect,
    uncollected: uncovered.size,
    failureCategories,
    doneBatches, stoppedEarly,
    notFoundCount: notFoundKeywords.length
  };
}

// ─── 메인 ─────────────────────────────────────────────────────
async function run() {
  const state = await loadState();
  const coupangSaved = state
    ? { job_date: state.job_date, cursor_key: state.cursor_key, processed: state.processed, total: state.total,
        status: state.status, last_result: { failedKeywords: (state.last_result || {}).failedKeywords || [] } }
    : null;
  const savedMalls = (state && state.last_result && state.last_result.malls) || {};
  const adpickSaved = savedMalls['ADPICK']
    ? { job_date: state.job_date, ...savedMalls['ADPICK'], last_result: { failedKeywords: savedMalls['ADPICK'].failedKeywords || [] } }
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
  const coupangRows = products.filter(isCoupangRow);
  const adpickRows  = products.filter(isAdpickRow);
  const otherRows   = products.filter(p => !isCoupangRow(p) && !isAdpickRow(p));

  const otherByMall = new Map();
  otherRows.forEach(p => otherByMall.set(p.mall, (otherByMall.get(p.mall) || 0) + 1));

  console.log(`\n가격 수집 시작 (${TODAY}, ${kstNowStamp()})`);
  console.log(`  products 전체        ${products.length}개`);
  console.log(`  ├ 쿠팡               ${coupangRows.length}개`);
  console.log(`  ├ ADPICK             ${adpickRows.length}개`);
  console.log(`  └ 기타(연동 없음)     ${otherRows.length}개`
    + (otherByMall.size ? `  (${[...otherByMall.entries()].map(([m, n]) => `${m} ${n}`).join(', ')})` : ''));

  const started = Date.now();

  // ── 쿠팡 먼저 — 자기 몫(절반)이 다 되면 남은 시간을 ADPICK 에게 넘긴다.
  const coupangResult = await runMallCollection({
    mallName: '쿠팡', rows: coupangRows, fetchAllFn: fetchCoupangAll,
    savedState: coupangSaved, deadlineTs: started + MALL_BUDGET_MS
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
  [coupangResult, adpickResult].forEach(r => {
    console.log(`${r.mallName}`);
    console.log(`  대상 ${r.target} / 조회시도 ${r.attempted} / 성공 ${r.success} /`
      + ` 저장 ${r.recorded} / 실패 ${r.attempted - r.success} / 오늘 진행 ${r.processed}/${r.total}`
      + `  [${r.status}]`);
  });
  if (otherRows.length) {
    console.log(`기타(연동 없음) — 대상 ${otherRows.length} / 조회시도 0 / 성공 0 / 저장 0 / 실패 0 (재조회 API 없음)`);
  }
  console.log('═'.repeat(60) + '\n');

  const cs = coupangLocalStats();
  const as = adpickLocalStats();
  console.log(`쿠팡 API 호출: ${cs.calls}회 (예산 ${COUPANG_RUN_BUDGET}회) / 캐시 ${cs.cacheHits} / 생략 ${cs.denied + _coupangSkipped}`);
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
      recorded: coupangResult.recorded + adpickResult.recorded,
      saved: coupangResult.saved + adpickResult.saved,
      rejected: coupangResult.rejected + adpickResult.rejected,
      suspect: coupangResult.suspect + adpickResult.suspect,
      failedKeywords: coupangResult.failedKeywords, // 쿠팡 몫(하위호환)
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
          target: coupangResult.target, attempted: coupangResult.attempted, success: coupangResult.success,
          recorded: coupangResult.recorded, saved: coupangResult.saved, uncollected: coupangResult.uncollected
        },
        'ADPICK': {
          cursor_key: adpickResult.cursorKey, processed: adpickResult.processed, total: adpickResult.total,
          status: adpickResult.status, failedKeywords: adpickResult.failedKeywords,
          target: adpickResult.target, attempted: adpickResult.attempted, success: adpickResult.success,
          recorded: adpickResult.recorded, saved: adpickResult.saved, uncollected: adpickResult.uncollected
        }
      }
    }
  });

  // ── 수집 결과 이메일 발송 (실패해도 수집 결과에 영향 없음, 여기서 절대 throw 하지 않는다) ──
  const report = {
    execAt: kstNowStamp(),
    date: TODAY,
    productsTotal: products.length,
    otherTotal: otherRows.length,
    otherByMall: Object.fromEntries(otherByMall),
    malls: [coupangResult, adpickResult],
    failCats: mergedFailureCategories,
    target: coupangResult.target + adpickResult.target,
    attempted: coupangResult.attempted + adpickResult.attempted,
    success: coupangResult.success + adpickResult.success,
    recorded: coupangResult.recorded + adpickResult.recorded,
    uncollected: coupangResult.uncollected + adpickResult.uncollected
  };
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
  const attemptedTotal = coupangResult.attempted + adpickResult.attempted;
  const collectedNothing = attemptedTotal > 0 && report.recorded === 0;

  if (bothBlocked || collectedNothing) {
    console.error('\n수집 실패로 처리합니다 (exit 1)');
    if (coupangBlocked) console.error('  - 쿠팡 API 차단 상태');
    if (adpickBlocked) console.error('  - ADPICK API 차단 상태');
    if (collectedNothing) console.error(`  - 이번 실행 시도 ${attemptedTotal}개 중 저장 0행`);
    console.error('  → 원인 확인:  node scripts/coupang-probe.js');
    process.exitCode = 1;
    return;
  }

  const overallCoverage = report.attempted > 0 ? Math.round(report.success / report.attempted * 100) : 100;
  if (overallCoverage < 50) {
    console.warn(`경고: 이번 실행 커버리지 ${overallCoverage}% — 대상 상품 상당수가 검색 결과 밖으로 밀려났습니다.`);
  } else if (overallCoverage < 80) {
    console.warn(`경고: 이번 실행 커버리지 ${overallCoverage}% < 80%`);
  }
  if (coupangBlocked) console.warn('경고: 쿠팡 API 차단 상태 (ADPICK 은 영향받지 않음)');
  if (adpickBlocked) console.warn('경고: ADPICK API 차단 상태 (쿠팡은 영향받지 않음)');
}

// ─── 수집 결과 이메일 ────────────────────────────────────────────
const REPORT_EMAIL = process.env.PRICE_REPORT_EMAIL || 'yugeonbag091211@gmail.com';

function buildReportHtml(report) {
  const { execAt, date, productsTotal, otherTotal, otherByMall, malls, failCats,
    target, attempted, success, recorded, uncollected } = report;

  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function pct(n) { return n != null ? n.toFixed(1) + '%' : '-'; }

  const successRate = attempted > 0 ? (success / attempted * 100) : 100;
  const statusColor = successRate >= 80 ? '#0b7a4b' : successRate >= 50 ? '#b5850b' : '#c9362b';

  const mallRows = malls.map(m => `
    <tr>
      <td style="padding:8px 12px;font-weight:700;color:#111;border-top:1px solid #eee">${esc(m.mallName)}</td>
      <td style="padding:8px 12px;text-align:right;border-top:1px solid #eee">${m.target}</td>
      <td style="padding:8px 12px;text-align:right;border-top:1px solid #eee">${m.attempted}</td>
      <td style="padding:8px 12px;text-align:right;color:#0b7a4b;border-top:1px solid #eee">${m.success}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;border-top:1px solid #eee">${m.recorded}</td>
      <td style="padding:8px 12px;text-align:right;color:#c9362b;border-top:1px solid #eee">${m.attempted - m.success}</td>
    </tr>`).join('');

  const otherRow = otherTotal > 0 ? `
    <tr>
      <td style="padding:8px 12px;color:#888;border-top:1px solid #eee">기타 (${esc(Object.keys(otherByMall).join(', ') || '연동 없음')})</td>
      <td style="padding:8px 12px;text-align:right;color:#888;border-top:1px solid #eee">${otherTotal}</td>
      <td style="padding:8px 12px;text-align:right;color:#888;border-top:1px solid #eee">0</td>
      <td style="padding:8px 12px;text-align:right;color:#888;border-top:1px solid #eee">0</td>
      <td style="padding:8px 12px;text-align:right;color:#888;border-top:1px solid #eee">0</td>
      <td style="padding:8px 12px;text-align:right;color:#888;border-top:1px solid #eee">-</td>
    </tr>` : '';

  const catRows = Object.entries(failCats || {})
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<tr><td style="padding:4px 12px;color:#555">${esc(k)}</td><td style="padding:4px 12px;text-align:right;font-weight:600">${v}</td></tr>`)
    .join('') || '<tr><td style="padding:4px 12px;color:#888" colspan="2">없음</td></tr>';

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
  <tr><td style="padding:24px 32px">
    <div style="font-size:14px;color:#888;margin-bottom:8px">기준 날짜 (KST)</div>
    <div style="font-size:28px;font-weight:800;color:#111;letter-spacing:-.02em">${esc(date)}</div>
    <div style="font-size:12px;color:#aaa;margin-top:4px">실행 시각: ${esc(execAt)}</div>
  </td></tr>
  <tr><td style="padding:0 32px">
    <div style="display:inline-block;background:${statusColor};color:#fff;font-size:13px;font-weight:700;padding:5px 16px;border-radius:20px">
      이번 실행 커버리지 ${pct(successRate)}
    </div>
    <div style="font-size:12px;color:#888;margin-top:8px">전체 대상 ${target} / 조회 시도 ${attempted} / 성공 ${success} / 저장 ${recorded} / 미수집 ${uncollected}</div>
  </td></tr>
  <tr><td style="padding:16px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:8px">몰별 결과</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border:1px solid #eee;border-radius:6px">
      <tr style="background:#f8f8f7">
        <td style="padding:6px 12px;color:#888;font-size:11px">몰</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">대상</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">조회시도</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">성공</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">저장</td>
        <td style="padding:6px 12px;text-align:right;color:#888;font-size:11px">실패</td>
      </tr>
      ${mallRows}${otherRow}
    </table>
  </td></tr>
  <tr><td style="padding:16px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:8px">전체 products (참고)</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee">
      <tr><td style="padding:6px 0;color:#888;font-size:13px">products 전체</td>
          <td style="padding:6px 0;text-align:right;font-weight:600">${productsTotal}</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:16px 32px 0">
    <div style="font-size:12px;font-weight:700;color:#888;letter-spacing:.06em;margin-bottom:8px">실패 원인별 개수 (몰 합계)</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border:1px solid #eee;border-radius:6px">
      ${catRows}
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
    const successRate = report.attempted > 0 ? (report.success / report.attempted * 100) : 100;
    const result = await email.send({
      to: REPORT_EMAIL,
      subject: `[SEOSA] ${report.date} 가격 수집 리포트 — 이번 실행 커버리지 ${successRate.toFixed(1)}%`,
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
  runMallCollection, categorizeFailure, isCoupangRow, isAdpickRow
};

if (require.main === module) {
  run().catch(async e => {
    console.error('치명적 오류:', e.message, e.stack);
    await sendFailureNotice(e);
    process.exit(1);
  });
}
