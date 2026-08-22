#!/usr/bin/env node
/*
 * GitHub Actions에서 매일 실행 — products 전체 쿠팡 상품 가격 수집
 * node scripts/collect-all-prices.js
 *
 * 수집 전략:
 *   1차) 키워드별 쿠팡 검색 — 키워드당 최대 10건 (쿠팡 limit 상한)
 *   마지막) 커버리지 리포트 출력
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
 */

require('./_env');
const supabase = require('../api/_supabase');
const { searchCoupang, isBlocked, localStats } = require('../api/_coupang');
const { recordPrices, searchPhraseFromTitle } = require('../api/_shop');
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

// 배치 실행이라 사용자 대기 시간이 없다. 호출 간격을 넉넉히 벌려
// 라이브 검색(/api/search)이 쓸 몫을 분당 절반 이상 남겨둔다.
const COUPANG_MIN_GAP_MS  = 6000;    // → 이 스크립트만으로는 분당 최대 10회
const COUPANG_MAX_WAIT_MS = 120000;
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

/* ── 배치 진행 설정 ────────────────────────────────────────────────
 *
 * 한 배치가 덮는 상품 수와 배치 간격.
 *
 * ★ "상품 20개 = 쿠팡 호출 20회" 가 아니다.
 *   쿠팡 파트너스에는 상품 단건 조회 API 가 없다. 검색 API 하나뿐이라
 *   (api/_coupang.js SEARCH_PATH) 검색어로 찾아서 productId 를 맞춰보는
 *   방식이고, 검색 1회가 최대 10건을 돌려주므로 여러 상품이 한 번에 덮인다.
 *
 *   2026-08-13 운영 DB 실측(scripts 로 계산):
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
 */
const RUN_TIME_BUDGET_MS = Number(process.env.PRICE_RUN_BUDGET_MS) || 50 * 60 * 1000;

/*
 * 한국시간(Asia/Seoul) 기준 오늘 날짜는 api/_price.kstToday 하나만 쓴다.
 * price_history.recorded_date 도, price_job_state.job_date 도, 여기서 하루
 * 경계를 판정하는 자리도 모두 같은 함수를 거친다 — 예전에는 저장은 UTC 로
 * 하고 판정은 KST 로 해서 하루가 어긋났다.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── 환경변수 ────────────────────────────────────────────────
const COUP_ACCESS  = process.env.COUPANG_ACCESS_KEY;
const COUP_SECRET  = process.env.COUPANG_SECRET_KEY;

console.log('[환경변수 진단]');
console.log('  COUPANG_ACCESS_KEY :', COUP_ACCESS  ? `설정됨 (${COUP_ACCESS.length}자)` : '❌ 없음');
console.log('  COUPANG_SECRET_KEY :', COUP_SECRET  ? `설정됨 (${COUP_SECRET.length}자)` : '❌ 없음');
console.log('  SUPABASE_URL       :', process.env.SUPABASE_URL       ? '설정됨' : '❌ 없음');
console.log('  SUPABASE_SECRET_KEY:', process.env.SUPABASE_SECRET_KEY ? '설정됨' : '❌ 없음');
console.log('');

// ─── 유틸 ────────────────────────────────────────────────────
function isCoupangRow(p) {
  return p.mall === '쿠팡' || (p.link && p.link.includes('coupang'));
}

// ─── 쿠팡 API 상태 추적 ─────────────────────────────────────
let _coupangBlocked = false;
let _coupangBlockMsg = '';
let _coupangCalls = 0;      // 실제로 나간 호출 수 (캐시 적중은 제외)
let _coupangSkipped = 0;    // 예산/상한/차단으로 건너뛴 횟수
let _budgetWarned = false;

// ─── API 호출 ─────────────────────────────────────────────────
/**
 * 쿠팡 검색. api/_coupang.js를 통해서만 나간다.
 *
 * 여기서 직접 fetch/HMAC을 만들면 분당 상한도 차단 감지도 캐시도 전부 우회한다.
 * 절대 retry로 감싸지 말 것.
 */
async function fetchCoupangAll(keyword, limit = COUPANG_LIMIT) {
  /*
   * 반환값 { ok, items, reason }.
   *
   * ok=false 는 "호출이 나가지 못했다"는 뜻이고 재시도 대상이다.
   * ok=true + items=[] 는 "호출은 성공했는데 결과가 비었다"는 뜻이라
   * 재시도해도 같다. 호출부가 이 둘을 구분해야 차단 때문에 못 받은 상품을
   * "원래 없는 상품"으로 오해해 영원히 누락시키지 않는다.
   */
  if (!COUP_ACCESS || !COUP_SECRET) return { ok: false, items: [], reason: '쿠팡 키 미설정' };
  if (_coupangBlocked || isBlocked())  return { ok: false, items: [], reason: '쿠팡 차단 상태' };

  if (_coupangCalls >= COUPANG_RUN_BUDGET) {
    _coupangSkipped++;
    if (!_budgetWarned) {
      _budgetWarned = true;
      console.warn(`\n⚠️  쿠팡 호출 예산 ${COUPANG_RUN_BUDGET}회 소진 — 남은 키워드는 건너뜁니다.\n`);
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
 * (scripts/test-price-batch.js)
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

/* ─── 관측값 모으기 ───────────────────────────────────────────
 *
 * ★ 이 스크립트가 products 를 갱신하지 않던 것이 "SEOSA 가격이 실제와 다르다"의
 *   최우선 원인이었다 (2026-08-09 확인).
 *
 *   매일 도는 이 수집기는 price_history 에만 썼다. products.lprice —
 *   홈의 오늘의 셀렉션 / 이달의 추천 / 취향 추천이 현재가로 그리는 바로 그
 *   컬럼 — 은 /api/search 나 /api/cron 이 그 키워드를 건드릴 때만 바뀌었고,
 *   cron 은 TODAY_PICKS + 이달의 큐레이션만 돈다. 나머지 키워드의 현재가는
 *   누군가 마지막으로 검색한 시점에 얼어붙는다.
 *
 *   실측: 쿠팡 상품 200건 중 39건(19.5%)의 products.lprice 가 같은 날 받아온
 *   쿠팡 가격과 달랐다. 최대 2.42배.
 *     예) "1+1 HOMEY NEST 암막커튼"  products=75,000 / 같은 날 쿠팡=39,900
 *
 *   이제 api/_shop.js 의 recordPrices() 하나로 price_history 와 products 를
 *   함께 갱신한다. 검증(0원·비정상 급변·옵션 교체)도 그쪽에 들어 있어서
 *   /api/search, /api/cron, 이 스크립트가 전부 같은 규칙을 쓴다.
 * ------------------------------------------------------------------ */
const obsMap = new Map();

function addRow(target, item, foundVia) {
  const price = parseInt(item.lprice, 10) || 0;
  if (price <= 0) return false;
  obsMap.set(`${target.product_id}|${target.mall}|${item.vendorItemId || ''}`, {
    productId: target.product_id,
    mall: target.mall,
    // 제목은 DB 의 것을 유지한다. 이 스크립트는 "이미 아는 상품의 오늘 가격"을
    // 채우는 일만 한다 — 카탈로그를 재작성하지 않는다.
    title: target.title,
    /*
     * keyword 는 DB 값이 있으면 그대로 두고, 비어 있을 때만 이번에 실제로
     * 이 상품을 찾아낸 검색어를 채운다.
     *
     * 기존 값을 덮어쓰지 않는다. 그리고 아무 문자열이나 넣는 게 아니라,
     * 방금 그 검색어로 검색했을 때 이 productId 가 실제로 결과에 나왔다는
     * 것이 확인된 값만 넣는다 — 다음 수집부터 이 행이 정상적으로 도달된다.
     */
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
  const rows = [...obsMap.values()];
  if (rows.length === 0) {
    console.warn('  경고: 관측값이 비어 있음 — API 응답에서 매칭 0건');
    return { saved: 0, recorded: 0, total: 0, rejected: 0, suspect: 0 };
  }
  console.log(`  샘플 관측(첫 번째):`, JSON.stringify(rows[0]).slice(0, 200));

  let recorded = 0, saved = 0, rejected = 0, suspect = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const r = await recordPrices(rows.slice(i, i + UPSERT_CHUNK), { label: 'collect' });
    recorded += r.recorded;
    saved += r.saved;
    rejected += r.rejected;
    suspect += r.suspect;
    if (r.errors.length) errors.push(...r.errors);
  }
  if (errors.length) console.error('\n  [DB 오류 원문]', errors.slice(0, 3).join(' | '));
  return { saved, recorded, total: rows.length, rejected, suspect };
}

// ─── 메인 ─────────────────────────────────────────────────────
async function run() {
  /*
   * ★ 진행 상태를 가장 먼저 본다.
   *
   *   오늘 이미 완료된 날이면 products 1,400여 행을 읽을 이유도 없다.
   *   (완료 판정을 products 조회 뒤에 두면, 아무 일도 안 하는 실행이
   *    매번 테이블을 통째로 읽는다)
   */
  const today = kstToday();
  let state = await loadState();

  if (state && state.job_date === today && state.status === 'completed') {
    console.log(`\n[진행] ${today} (KST) 작업은 이미 완료되었습니다`
      + ` — ${state.processed}/${state.total}개 처리됨. 이번 실행은 아무 상품도 처리하지 않습니다.`);
    console.log('       (다음 작업은 KST 자정 이후 실행부터 시작합니다)');
    return;
  }

  const products = await fetchAllProducts();

  /*
   * 커버리지 분모.
   *
   * 이 스크립트는 "쿠팡 상품을 검색해서 productId 로 다시 찾는" 방식이다.
   * 비쿠팡 행은 네이버 연동을 제거해서 조회할 수단 자체가 없으므로 분모에서 뺀다.
   * (분모에 넣으면 수집이 정상일 때도 낮은 커버리지가 나와서, 진짜로 망가졌을
   *  때와 구분이 안 된다. 실제로 그 숫자 때문에 GitHub Actions 가 한 건도 못
   *  모으고 있다는 걸 오래 눈치채지 못했다)
   *
   * ★ keyword 없는 행도 이제 대상이다.
   *   예전에는 "검색 단서 없음"으로 통째로 제외했는데, 그게 쿠팡 상품 654개 중
   *   287개였다. 그 287개는 가격이 영원히 갱신되지 않는다는 뜻이다.
   *   이제 상품명에서 검색어를 유도해서(_shop.searchPhraseFromTitle) 찾아본다.
   *   찾으면 그 검색어를 keyword 에 채워 다음 수집부터는 정상 경로를 탄다.
   */
  const coupangRows = products.filter(isCoupangRow);
  const withKeyword = coupangRows.filter(p => p.keyword);
  const noKeyword   = coupangRows.filter(p => !p.keyword);
  const notCoupang  = products.filter(p => !isCoupangRow(p));

  // 유도 검색어별로 묶는다. 같은 브랜드 상품이 여러 개면 호출 1회로 같이 잡힌다.
  const derivedGroups = new Map();
  noKeyword.forEach(p => {
    const phrase = searchPhraseFromTitle(p.title);
    if (!phrase) return;
    if (!derivedGroups.has(phrase)) derivedGroups.set(phrase, []);
    derivedGroups.get(phrase).push(p);
  });
  const noPhrase = noKeyword.length - [...derivedGroups.values()].reduce((n, a) => n + a.length, 0);

  const collectible = [...withKeyword, ...[...derivedGroups.values()].flat()];

  console.log(`\n가격 수집 시작 (${TODAY})`);
  console.log(`  products 전체        ${products.length}개`);
  console.log(`  ├ 쿠팡               ${coupangRows.length}개`);
  console.log(`  │  ├ keyword 있음    ${withKeyword.length}개`);
  console.log(`  │  ├ 제목에서 유도    ${collectible.length - withKeyword.length}개 (검색어 ${derivedGroups.size}종)`);
  console.log(`  │  └ 검색어 유도 실패 ${noPhrase}개`);
  console.log(`  └ 비쿠팡             ${notCoupang.length}개  (연동 없음 — 대상 제외)`);
  console.log(`  수집 대상 합계       ${collectible.length}개\n`);

  const uncovered = new Map();
  collectible.forEach(p => uncovered.set(`${p.product_id}|${p.mall}`, p));
  const markCovered = (pid, mall) => uncovered.delete(`${pid}|${mall}`);

  /*
   * 검색어 처리 순서 — 검색어 문자열 오름차순으로 고정한다.
   *
   * ★ 예전에는 유도 그룹을 collected_at 오름차순(oldestFirst)으로 정렬했다.
   *   그 값은 수집에 성공하는 순간 now() 로 바뀐다. 즉 정렬 기준이 작업
   *   도중에 변한다. 하루를 여러 번의 실행으로 나눠 이어가는 지금 구조에서
   *   그러면 실행마다 순서가 뒤바뀌어, 커서 뒤쪽에 있던 그룹이 앞으로
   *   올라오며 통째로 건너뛰어진다. 검색어 문자열은 변하지 않으므로
   *   몇 번을 나눠 돌아도 순서가 같다.
   *
   * 같은 검색어가 DB keyword 와 유도 검색어 양쪽에 있으면 한 그룹으로 합친다.
   * (안 합치면 같은 검색어로 두 번 호출한다)
   */
  const plan = buildPlan(withKeyword, derivedGroups);
  const planTotal = plan.reduce((n, g) => n + g.rows.length, 0);

  // ── 날짜 전환 판정 ─────────────────────────────────────────
  // (오늘 completed 인 경우는 이 함수 맨 앞에서 이미 return 했다)
  if (!state || state.job_date !== today) {
    // 날짜가 바뀌었다(또는 첫 실행). 새 하루로 리셋하고 1번부터 시작한다.
    console.log(`\n[진행] 새 작업일 ${today} (KST) — 처음부터 시작합니다.`
      + (state ? `  (직전 작업일 ${state.job_date} / ${state.status})` : ''));
    state = { job_date: today, cursor_key: '', processed: 0, total: planTotal, status: 'running' };
    await saveState(state);
  } else {
    console.log(`\n[진행] ${today} (KST) 이어서 진행 — ${state.processed}/${state.total}개 완료,`
      + ` 커서 "${state.cursor_key}" 다음부터`);
  }

  // 커서 뒤쪽만 남긴다. 문자열 비교라 목록에 행이 추가·삭제돼도 위치가 밀리지 않는다.
  const remaining = resumeFrom(plan, state.cursor_key || '');

  /*
   * 재시도 대상 검색어. kw → 사유.
   *
   * Map 인 이유: 같은 날 뒤 실행에서 성공하면 지워야 하고(delete), 같은
   * 검색어가 두 번 실패해도 한 번만 남아야 한다. 이 목록은 price_job_state
   * .last_result.failedKeywords 로 저장되어 같은 날 보충 실행이 이어받는다.
   * (하루가 바뀌면 상태가 통째로 리셋되므로 자연히 비워진다)
   */
  const failedKeywords = new Map(
    ((state.last_result && state.last_result.failedKeywords) || []).map(kw => [kw, '직전 실행에서 실패'])
  );

  /*
   * 커서를 지나온 구간 중 호출이 못 나갔던 검색어. 커서는 건드리지 않는다 —
   * 이미 지나온 자리라 커서를 뒤로 돌리면 그 뒤 상품을 전부 다시 처리한다.
   */
  const retryGroups = failedKeywords.size
    ? plan.filter(g => failedKeywords.has(g.kw) && !remaining.some(x => x.kw === g.kw))
    : [];

  /*
   * ★ 남은 검색어도 없고 재시도할 것도 없을 때만 완료다.
   *
   *   실패한 검색어가 남아 있는데 completed 로 굳혀 버리면, 같은 날 보충
   *   실행이 맨 앞의 completed 검사에 걸려 그냥 끝나므로 그 상품들은
   *   그날 영영 가격을 못 받는다. 그래서 재시도가 남아 있으면 running 을
   *   유지한다 — 커서는 끝에 있으므로 1번부터 다시 도는 일은 없다.
   */
  if (!remaining.length && !retryGroups.length) {
    console.log('  남은 검색어가 없습니다 — 오늘 작업을 완료로 표시합니다.');
    await saveState({ ...state, status: 'completed', total: planTotal, last_run_at: new Date().toISOString() });
    return;
  }

  console.log(`── 쿠팡 검색 (남은 검색어 ${remaining.length}종 / 전체 ${plan.length}종,`
    + ` 배치당 ${BATCH_PRODUCTS}개 상품, 간격 ${Math.round(BATCH_INTERVAL_MS / 1000)}초,`
    + ` 실행당 호출 예산 ${COUPANG_RUN_BUDGET}회) ──`);

  /*
   * 배치 나누기 — 검색어 그룹을 경계에서 쪼개지 않는다.
   * 그룹을 쪼개면 같은 검색어를 두 배치에서 각각 호출하게 되어 호출이 낭비된다.
   */
  const batches = splitBatches(remaining, BATCH_PRODUCTS);
  console.log(`  → 배치 ${batches.length}개로 나눔\n`);

  const started = Date.now();
  let recovered = 0;
  let totalRecorded = 0, totalSaved = 0, totalRejected = 0, totalSuspect = 0;

  const notFoundKeywords = []; // 호출은 됐는데 결과에 우리 상품이 없던 검색어
  let doneBatches = 0;
  let stoppedEarly = false;

  /** 검색어 그룹 하나를 처리한다. 실패해도 던지지 않는다 — 호출부가 계속 돈다. */
  async function processGroup({ kw, rows }) {
    const coupangById = new Map();
    rows.forEach(p => coupangById.set(p.product_id, p));

    /*
     * ★ 한 검색어가 실패해도 배치 전체를 멈추지 않는다.
     *   실패는 기록만 하고 다음 검색어로 넘어간다.
     *   retry 로 감싸지 않는다 — 제한 응답을 즉시 재시도하면 경고가 쌓인다.
     *   (재시도는 같은 날 뒤 실행에서, 간격을 두고 한다)
     */
    let r;
    try {
      r = await fetchCoupangAll(kw);
    } catch (e) {
      failedKeywords.set(kw, e.message);
      console.log(`  [실패] [${kw}] ${e.message} — 나머지는 계속 진행합니다.`);
      return;
    }

    /*
     * 실패의 종류를 구분한다.
     *   ok=false  → 호출이 못 나갔다(차단·예산·상한·stale). 재시도 대상이다.
     *   ok=true 인데 매칭 0 → 호출은 성공했고 쿠팡 결과에 우리 상품이
     *                        없었다. 재시도해도 같으므로 커버리지 문제다.
     * 이 둘을 뭉뚱그리면 차단 때문에 못 받은 것을 "원래 없는 상품"으로
     * 오해해서 영원히 누락시킨다.
     */
    if (!r.ok) {
      failedKeywords.set(kw, r.reason);
      console.log(`  [보류] [${kw}] ${r.reason} — 재시도 대상`);
      return;
    }

    let hit = 0;
    r.items.forEach(item => {
      const target = coupangById.get(item.productId);
      // addRow 가 기존 keyword 를 지킨다. 비어 있을 때만 kw 가 채워진다.
      if (target && addRow(target, item, kw)) {
        markCovered(target.product_id, target.mall);
        hit++;
        if (!target.keyword) recovered++;
      }
    });

    // 호출이 성공했으면 재시도 목록에서 뺀다(직전 실행에서 실패했던 검색어).
    failedKeywords.delete(kw);

    if (hit === 0) notFoundKeywords.push(kw);
    const pct = rows.length > 0 ? Math.round(hit / rows.length * 100) : 0;
    console.log(`  [${kw}] ${hit}/${rows.length} (${pct}%) — 쿠팡 ${r.items.length}건`);
  }

  /** 배치 하나(그룹 여러 개)를 처리하고 저장한다. */
  async function runBatch(batch) {
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      // 그룹 단위 병렬(CONCURRENCY). 쿠팡 호출 간격은 _coupang.js 가 지킨다.
      await Promise.all(batch.slice(i, i + CONCURRENCY).map(processGroup));
    }
    const s = await saveAll();
    obsMap.clear();   // 다음 배치가 이 배치 관측을 다시 저장하지 않도록 비운다
    totalRecorded += s.recorded;
    totalSaved    += s.saved;
    totalRejected += s.rejected;
    totalSuspect  += s.suspect;
    return s;
  }

  const stateSnapshot = (status) => ({
    job_date: state.job_date,
    cursor_key: state.cursor_key,
    processed: state.processed,
    total: state.total,
    status,
    last_run_at: new Date().toISOString(),
    last_result: {
      batches: doneBatches,
      recorded: totalRecorded,
      saved: totalSaved,
      notFound: notFoundKeywords.length,
      // 같은 날 다음 실행이 이 목록부터 다시 시도한다.
      failedKeywords: [...failedKeywords.keys()]
    }
  });

  /* ── 0) 재시도 패스 ────────────────────────────────────────
   *
   * 직전 실행에서 호출이 못 나갔던 검색어를 먼저 다시 시도한다.
   * (retryGroups 는 위에서 계산해 두었다 — 커서는 건드리지 않는다)
   */
  if (retryGroups.length) {
    console.log(`── 재시도: 직전 실행에서 못 받은 검색어 ${retryGroups.length}종 ──`);
    for (const rb of splitBatches(retryGroups, BATCH_PRODUCTS)) {
      const bs = Date.now();
      const s = await runBatch(rb);
      console.log(`  └ 재시도 배치 완료 — 기록 ${s.recorded}행, 현재가 ${s.saved}행`
        + `  (남은 재시도 ${failedKeywords.size}종)\n`);
      await saveState(stateSnapshot('running'));
      if (Date.now() - started >= RUN_TIME_BUDGET_MS) { stoppedEarly = true; break; }
      const w = BATCH_INTERVAL_MS - (Date.now() - bs);
      if (w > 0) await sleep(w);
    }
  }

  // ── 1) 본 배치 루프 ───────────────────────────────────────
  for (let b = 0; b < batches.length && !stoppedEarly; b++) {
    const batch = batches[b];
    const batchProducts = batch.reduce((n, g) => n + g.rows.length, 0);
    const batchStart = Date.now();

    const s = await runBatch(batch);

    // ── 진행 위치 저장 ──────────────────────────────────────
    // 커서는 이 배치의 마지막 검색어. 다음 실행은 이보다 큰 검색어부터 본다.
    state.cursor_key = batch[batch.length - 1].kw;
    state.processed += batchProducts;
    state.total = planTotal;
    doneBatches++;

    const isLast = b === batches.length - 1;
    /*
     * 마지막 배치를 끝냈어도, 못 받은 검색어가 남아 있으면 completed 로
     * 굳히지 않는다. 굳히면 같은 날 보충 실행이 맨 앞 검사에 걸려 그냥
     * 끝나 버려서 그 상품들은 그날 가격을 못 받는다.
     * (커서는 이미 끝에 있으므로 running 이어도 1번부터 다시 돌지 않는다)
     */
    await saveState(stateSnapshot(isLast && !failedKeywords.size ? 'completed' : 'running'));

    const elapsedS = Math.round((Date.now() - batchStart) / 1000);
    console.log(`  └ 배치 ${b + 1}/${batches.length} 완료 — 상품 ${batchProducts}개,`
      + ` 기록 ${s.recorded}행, 현재가 ${s.saved}행, ${elapsedS}초`
      + `  [누적 ${state.processed}/${state.total}]\n`);

    if (isLast) {
      if (failedKeywords.size) {
        console.log(`⚠️  ${today} (KST) 마지막 배치까지 돌았지만 못 받은 검색어 ${failedKeywords.size}종이 남았습니다.`
          + ' 오늘 보충 실행이 이 목록만 다시 시도합니다(1번부터 다시 돌지 않습니다).');
      } else {
        console.log(`✅ ${today} (KST) 전체 ${state.processed}/${state.total}개 처리 완료 — 오늘 작업을 종료합니다.`);
      }
      break;
    }

    // ── 다음 배치까지 대기 (1분 간격) ────────────────────────
    const usedMs = Date.now() - started;
    if (usedMs >= RUN_TIME_BUDGET_MS) {
      stoppedEarly = true;
      console.log(`⏱  실행 시간 예산(${Math.round(RUN_TIME_BUDGET_MS / 60000)}분) 도달 —`
        + ` 여기까지 저장하고 종료합니다. 다음 실행이 "${state.cursor_key}" 다음부터 이어갑니다.`);
      break;
    }
    const waitMs = BATCH_INTERVAL_MS - (Date.now() - batchStart);
    if (waitMs > 0) await sleep(waitMs);
  }

  if (recovered) {
    console.log(`\n  ✅ keyword 가 없던 상품 ${recovered}개를 찾아 검색어를 채웠습니다 (다음 수집부터 정상 경로).`);
  }

  // ── 저장 요약 ─────────────────────────────────────────────
  console.log(`\n── 저장 ──`);
  const saved = totalSaved, recorded = totalRecorded;
  const rejected = totalRejected, suspect = totalSuspect;
  console.log(`price_history 기록: ${recorded}행`);
  console.log(`products 현재가 갱신: ${saved}행`
    + (suspect ? `  (급변 보류 ${suspect}행 — 다음 수집에서 같은 값이면 반영)` : '')
    + (rejected ? `  (값 이상 거부 ${rejected}행)` : ''));

  if (failedKeywords.size) {
    console.log(`\n재시도 대상 검색어 ${failedKeywords.size}종 (호출이 못 나감):`);
    [...failedKeywords.entries()].slice(0, 10).forEach(([kw, why]) => console.log(`  - [${kw}] ${why}`));
    if (failedKeywords.size > 10) console.log(`  ... 외 ${failedKeywords.size - 10}종`);
    console.log('  → 같은 날 다음 보충 실행(KST 03:00 / 06:00)이 이 목록부터 다시 시도합니다.');
  }

  /* ── 커버리지 리포트 ────────────────────────────────────────
   *
   * ★ 분모는 "이번 실행이 실제로 시도한 상품" 이다.
   *   재개형이라 한 실행이 전체를 돌지 않는다. 전체(collectible)를 분모로
   *   두면 정상적으로 절반만 돈 실행이 커버리지 50% 로 찍혀서, 진짜로
   *   망가진 실행과 구분이 안 된다. 하루 전체 진행률은 price_job_state 의
   *   processed/total 로 따로 본다.
   */
  const attempted = batches.slice(0, doneBatches).flatMap(bt => bt.flatMap(g => g.rows));
  const attemptedKeys = new Set(attempted.map(p => `${p.product_id}|${p.mall}`));
  const finalMissing = [...uncovered.values()].filter(p => attemptedKeys.has(`${p.product_id}|${p.mall}`));
  const covered  = attempted.length - finalMissing.length;
  const coverage = attempted.length > 0 ? Math.round(covered / attempted.length * 100) : 100;

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`이번 실행 커버리지: ${covered}/${attempted.length} (${coverage}%)   ← 이번 실행이 시도한 상품 기준`);
  console.log(`오늘 진행률       : ${state.processed}/${state.total}`
    + `  (${state.total ? Math.round(state.processed / state.total * 100) : 100}%)`
    + `  상태 ${stoppedEarly ? 'running(다음 실행이 이어감)' : (doneBatches && batches.length === doneBatches ? 'completed' : 'running')}`);
  console.log(`수집 대상 전체    : ${collectible.length}개 / products 전체 ${products.length}개`
    + `  (비쿠팡 ${notCoupang.length}개는 연동 없음 — 대상 제외)`);

  const cs = localStats();
  console.log(`\n쿠팡 API 호출: ${cs.calls}회 (예산 ${COUPANG_RUN_BUDGET}회)`);
  console.log(`  캐시로 대체: ${cs.cacheHits}회 / 상한·차단으로 생략: ${cs.denied + _coupangSkipped}회`);
  console.log(`  자체 상한: 분당 ${cs.maxPerMin}회, 호출 간격 ${COUPANG_MIN_GAP_MS}ms (공식 한도 분당 50회)`);

  if (_coupangBlocked || cs.blocked) {
    console.log(`\n⚠️  쿠팡 API: 차단 상태`);
    console.log(`    ${String(_coupangBlockMsg || cs.blockReason).replace(/<[^>]*>/g, '').slice(0, 150)}`);
    console.log('    → 쿠팡 파트너스에 소명 필요 (https://partners.coupang.com)');
    console.log('    → 소명 후 해제:  Supabase SQL Editor 에서  select coupang_unblock();');
  }

  if (finalMissing.length > 0) {
    console.log(`\n미수집: ${finalMissing.length}개`);
    finalMissing.slice(0, 30).forEach(p =>
      console.log(`  - [${p.mall}] ${p.product_id} | ${p.title.slice(0, 60)}`)
    );
    if (finalMissing.length > 30) console.log(`  ... 외 ${finalMissing.length - 30}개`);
  }

  console.log(`${'═'.repeat(50)}\n`);

  /*
   * 실패는 반드시 빨갛게 끝내야 한다.
   *
   * 예전에는 무슨 일이 있어도 exit 0 이었다. 그래서 이 잡이 2026-07-30 이후로
   * 단 한 행도 저장하지 못하고 있었는데 GitHub Actions 는 계속 초록불이었고,
   * 아무도 몰랐다. (price_history 에 15:00 UTC 대 기록이 하루도 없다)
   *
   * 이제 아래 경우에는 exit 1 로 끝내서 Actions 가 실패 알림을 보내게 한다.
   *   - 쿠팡 차단 감지
   *   - 수집 대상이 있는데 한 행도 저장하지 못함
   */
  const blocked = _coupangBlocked || cs.blocked;
  // 실패 판정은 price_history 기준으로 본다. products 갱신 수(saved)는 급변
  // 보류로 정상적으로 0 이 될 수 있어서, 그걸로 판정하면 멀쩡한 실행이 실패로 찍힌다.
  //
  // 분모는 이번 실행이 시도한 상품이다. "오늘 이미 completed 라 아무것도
  // 안 한 실행"은 위에서 이미 return 했으므로 여기 오지 않는다.
  const collectedNothing = attempted.length > 0 && recorded === 0;

  if (blocked || collectedNothing) {
    console.error('\n수집 실패로 처리합니다 (exit 1)');
    if (blocked) console.error('  - 쿠팡 API 차단 상태');
    if (collectedNothing) console.error(`  - 이번 실행 시도 ${attempted.length}개 중 저장 0행`);
    console.error('  → 원인 확인:  node scripts/coupang-probe.js');
    process.exitCode = 1;
    return;
  }

  if (coverage < 50) {
    console.warn(`경고: 커버리지 ${coverage}% — 대상 상품 상당수가 키워드 검색 결과 밖으로 밀려났습니다.`);
  } else if (coverage < 80) {
    console.warn(`경고: 커버리지 ${coverage}% < 80%`);
  }
}

/* ------------------------------------------------------------------ *
 *  테스트용 노출.
 *
 *  scripts/test-price-batch.js 가 쿠팡 호출 없이 배치·커서·날짜 로직만
 *  검증한다. require 해도 run() 이 돌지 않도록 아래에서 가드한다.
 * ------------------------------------------------------------------ */
module.exports = { kstToday, buildPlan, splitBatches, resumeFrom, BATCH_PRODUCTS };

if (require.main === module) {
  run().catch(e => {
    console.error('치명적 오류:', e.message, e.stack);
    process.exit(1);
  });
}
