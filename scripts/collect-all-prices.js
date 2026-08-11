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

const TODAY = new Date().toISOString().slice(0, 10);
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
 * ★ 한 번 실행으로 전체가 다 돌지 않는다. 그게 정상이다.
 *   2026-08-11 운영 DB 실측:
 *     products 1,432행 중 keyword 가 빈 행 809
 *       ├ 네이버쇼핑 526 → 연동이 없어 수집 대상이 아니다
 *       └ 쿠팡      283 → searchPhraseFromTitle 로 283/283 검색어 유도 성공,
 *                          유도된 고유 검색어 264종
 *     여기에 keyword 가 이미 있는 49종을 더하면 검색어 313종이다.
 *   예산 120회로는 한 실행에 절반이 안 된다. 유도 그룹을 oldestFirst 로
 *   정렬해 두었으므로(아래 plan) 며칠에 걸쳐 한 바퀴를 돈다.
 *   → 첫 실행의 커버리지 경고는 고장이 아니다. 예산을 올리기 전에
 *     쿠팡 분당 상한(_coupang.MAX_PER_MIN)부터 확인할 것.
 */
const COUPANG_RUN_BUDGET  = Number(process.env.COUPANG_RUN_BUDGET) || 120;

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
  if (!COUP_ACCESS || !COUP_SECRET) return [];
  if (_coupangBlocked || isBlocked()) return [];

  if (_coupangCalls >= COUPANG_RUN_BUDGET) {
    _coupangSkipped++;
    if (!_budgetWarned) {
      _budgetWarned = true;
      console.warn(`\n⚠️  쿠팡 호출 예산 ${COUPANG_RUN_BUDGET}회 소진 — 남은 키워드는 건너뜁니다.\n`);
    }
    return [];
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
    return [];
  }

  if (r.blocked && !_coupangBlocked) {
    _coupangBlocked = true;
    _coupangBlockMsg = r.error || '차단';
    console.error(`\n⚠️  쿠팡 API 차단 감지: ${_coupangBlockMsg}`);
    console.error('    → 이번 실행에서는 쿠팡 호출을 멈춥니다.\n');
  }

  return r.items.map(it => ({
    productId: it.productId,
    title: it.title,
    lprice: it.lprice,
    oprice: it.oprice,
    link: it.link,
    image: it.image,
    mall: '쿠팡',
    itemId: it.itemId || '',
    vendorItemId: it.vendorItemId || '',
  }));
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
  obsMap.set(`${target.product_id}|${target.mall}`, {
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
   * 검색어 처리 순서.
   *
   *   1) DB 에 keyword 가 있는 그룹 — 살아있는 카탈로그다. 매일 갱신되어야 한다.
   *   2) 제목에서 유도한 그룹 — 오래 확인 못 한 것부터.
   *
   * 실행당 호출 예산(COUPANG_RUN_BUDGET)이 있어서 한 번에 전부는 못 돈다.
   * 2)를 오래된 순으로 정렬해 두면 매 실행마다 가장 묵은 것부터 처리되고,
   * 며칠에 걸쳐 전체가 한 바퀴 돈다. 예산을 넘기면 fetchCoupangAll 이
   * 알아서 건너뛰므로 쿠팡 상한을 넘길 위험은 없다.
   */
  const oldestFirst = rows => Math.min(...rows.map(r => Date.parse(r.collected_at) || 0));

  const byKeyword = new Map();
  withKeyword.forEach(p => {
    if (!byKeyword.has(p.keyword)) byKeyword.set(p.keyword, []);
    byKeyword.get(p.keyword).push(p);
  });

  const plan = [
    ...[...byKeyword.entries()].map(([kw, rows]) => ({ kw, rows, derived: false })),
    ...[...derivedGroups.entries()]
      .map(([kw, rows]) => ({ kw, rows, derived: true }))
      .sort((a, b) => oldestFirst(a.rows) - oldestFirst(b.rows))
  ];

  console.log(`── 쿠팡 검색 (검색어 ${plan.length}종, 실행당 예산 ${COUPANG_RUN_BUDGET}회) ──`);
  let recovered = 0;

  for (let i = 0; i < plan.length; i += CONCURRENCY) {
    const batch = plan.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ kw, rows, derived }) => {
      const coupangById = new Map();
      rows.forEach(p => coupangById.set(p.product_id, p));

      // retry로 감싸지 않는다 — 제한 응답을 재시도하면 경고가 쌓인다.
      const coupangItems = await fetchCoupangAll(kw).catch(() => []);
      if (!coupangItems.length) return;

      let hit = 0;
      coupangItems.forEach(item => {
        const target = coupangById.get(item.productId);
        // derived 인 경우에만 kw 를 keyword 로 채운다 (기존 값은 addRow 가 지킨다).
        if (target && addRow(target, item, derived ? kw : '')) {
          markCovered(target.product_id, target.mall);
          hit++;
          if (derived) recovered++;
        }
      });

      const pct = rows.length > 0 ? Math.round(hit / rows.length * 100) : 0;
      console.log(`  ${derived ? '유도' : '기존'} [${kw}] ${hit}/${rows.length} (${pct}%) — 쿠팡 ${coupangItems.length}건`);
    }));
  }

  if (recovered) {
    console.log(`\n  ✅ keyword 가 없던 상품 ${recovered}개를 찾아 검색어를 채웠습니다 (다음 수집부터 정상 경로).`);
  }

  // ── 저장 ──────────────────────────────────────────────────
  console.log(`\n── 저장 ──`);
  const { saved, recorded, total: rowTotal, rejected, suspect } = await saveAll();
  console.log(`price_history 기록: ${recorded}/${rowTotal}행`);
  console.log(`products 현재가 갱신: ${saved}행`
    + (suspect ? `  (급변 보류 ${suspect}행 — 다음 수집에서 같은 값이면 반영)` : '')
    + (rejected ? `  (값 이상 거부 ${rejected}행)` : ''));

  // ── 커버리지 리포트 ────────────────────────────────────────
  const finalMissing = [...uncovered.values()];
  const covered  = collectible.length - finalMissing.length;
  const coverage = collectible.length > 0 ? Math.round(covered / collectible.length * 100) : 100;

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`커버리지: ${covered}/${collectible.length} (${coverage}%)   ← 수집 대상 기준`);
  console.log(`          ${covered}/${products.length} (${Math.round(covered / products.length * 100)}%)   ← products 전체 기준(참고)`);

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
  const collectedNothing = collectible.length > 0 && recorded === 0;

  if (blocked || collectedNothing) {
    console.error('\n수집 실패로 처리합니다 (exit 1)');
    if (blocked) console.error('  - 쿠팡 API 차단 상태');
    if (collectedNothing) console.error(`  - 수집 대상 ${collectible.length}개 중 저장 0행`);
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

run().catch(e => {
  console.error('치명적 오류:', e.message, e.stack);
  process.exit(1);
});
