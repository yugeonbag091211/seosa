#!/usr/bin/env node
/*
 * GitHub Actions에서 매일 실행 — products 전체 쿠팡 상품 가격 수집
 * node scripts/collect-all-prices.js
 *
 * 수집 전략:
 *   1차) 키워드별 쿠팡 검색 — 키워드당 최대 50건
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

require('dotenv').config({ quiet: true });
const supabase = require('../api/_supabase');
const { searchCoupang, isBlocked, localStats } = require('../api/_coupang');

const TODAY = new Date().toISOString().slice(0, 10);
const CONCURRENCY   = 4;
const PAGE          = 1000;
const UPSERT_CHUNK  = 200;
const COUPANG_LIMIT = 50;

// 배치 실행이라 사용자 대기 시간이 없다. 호출 간격을 넉넉히 벌려
// 라이브 검색(/api/search)이 쓸 몫을 분당 절반 이상 남겨둔다.
const COUPANG_MIN_GAP_MS  = 6000;    // → 이 스크립트만으로는 분당 최대 10회
const COUPANG_MAX_WAIT_MS = 120000;
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
    link: it.link,
    image: it.image,
    mall: '쿠팡',
  }));
}

// ─── DB 조회 ──────────────────────────────────────────────────
async function fetchAllProducts() {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products')
      .select('product_id, mall, title, keyword, link')
      .order('product_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error('products 조회 실패: ' + error.message);
    all.push(...(data || []));
    if (!data || data.length < PAGE) return all;
  }
}

// ─── 가격 행 저장 맵 ──────────────────────────────────────────
const rowMap = new Map();
const NOW_ISO = new Date().toISOString();

function addRow(target, price, link) {
  const p = parseInt(price, 10) || 0;
  if (p <= 0) return false;
  rowMap.set(`${target.product_id}|${target.mall}|${TODAY}`, {
    product_id: target.product_id,
    mall: target.mall,
    title: target.title,
    price: p,
    link: link || target.link || '',
    recorded_at: NOW_ISO,
    recorded_date: TODAY,
  });
  return true;
}

// ─── upsert ──────────────────────────────────────────────────
let _firstUpsertError = null;

async function upsertChunk(chunk) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase
      .from('price_history')
      .upsert(chunk, { onConflict: 'product_id,mall,recorded_date', ignoreDuplicates: false });
    if (!error) return chunk.length;
    if (!_firstUpsertError) _firstUpsertError = error.message;
    if (attempt < 2 && chunk.length > 1) {
      const half = Math.ceil(chunk.length / 2);
      const a = await upsertChunk(chunk.slice(0, half));
      const b = await upsertChunk(chunk.slice(half));
      return a + b;
    }
    console.error(`    저장 오류 (청크${chunk.length}행, 시도${attempt + 1}):`, error.message.slice(0, 200));
  }
  return 0;
}

async function saveAll() {
  const rows = [...rowMap.values()];
  if (rows.length === 0) {
    console.warn('  경고: rowMap이 비어 있음 — API 응답에서 매칭 0건');
    return { saved: 0, total: 0 };
  }
  console.log(`  샘플 행(첫 번째):`, JSON.stringify(rows[0]));
  let saved = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    saved += await upsertChunk(rows.slice(i, i + UPSERT_CHUNK));
  }
  if (_firstUpsertError) {
    console.error('\n  [DB 오류 원문]', _firstUpsertError);
  }
  return { saved, total: rows.length };
}

// ─── 메인 ─────────────────────────────────────────────────────
async function run() {
  const products = await fetchAllProducts();
  console.log(`\n총 ${products.length}개 상품 가격 수집 시작 (${TODAY})\n`);

  const uncovered = new Map();
  products.forEach(p => uncovered.set(`${p.product_id}|${p.mall}`, p));
  const markCovered = (pid, mall) => uncovered.delete(`${pid}|${mall}`);

  // ── 1차: 키워드별 쿠팡 검색 ─────────────────────────────────
  console.log('── 1차: 키워드별 쿠팡 검색 ──');
  const byKeyword = new Map();
  products.forEach(p => {
    if (p.keyword && isCoupangRow(p)) {
      if (!byKeyword.has(p.keyword)) byKeyword.set(p.keyword, []);
      byKeyword.get(p.keyword).push(p);
    }
  });

  const keywords = [...byKeyword.keys()];
  for (let i = 0; i < keywords.length; i += CONCURRENCY) {
    const batch = keywords.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async keyword => {
      const targets = byKeyword.get(keyword);
      const coupangById = new Map();
      targets.forEach(p => coupangById.set(p.product_id, p));

      // retry로 감싸지 않는다 — 제한 응답을 재시도하면 경고가 쌓인다.
      const coupangItems = await fetchCoupangAll(keyword).catch(() => []);

      let hit = 0;
      coupangItems.forEach(item => {
        const target = coupangById.get(item.productId);
        if (target && addRow(target, item.lprice, item.link)) {
          markCovered(target.product_id, target.mall);
          hit++;
        }
      });

      const total = targets.length;
      const pct = total > 0 ? Math.round(hit / total * 100) : 0;
      console.log(`  [${keyword}] ${hit}/${total} (${pct}%) — 쿠팡 ${coupangItems.length}건`);
    }));
  }

  // ── 저장 ──────────────────────────────────────────────────
  console.log(`\n── 저장 ──`);
  const { saved, total: rowTotal } = await saveAll();
  console.log(`price_history upsert: ${saved}/${rowTotal}행`);

  // ── 커버리지 리포트 ────────────────────────────────────────
  const finalMissing = [...uncovered.values()];
  const covered  = products.length - finalMissing.length;
  const coverage = products.length > 0 ? Math.round(covered / products.length * 100) : 100;

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`커버리지: ${covered}/${products.length} (${coverage}%)`);

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

  if (coverage < 80) {
    console.warn(`경고: 커버리지 ${coverage}% < 80%`);
  } else if (coverage < 95) {
    console.warn(`경고: 커버리지 ${coverage}% < 95%`);
  }
}

run().catch(e => {
  console.error('치명적 오류:', e.message, e.stack);
  process.exit(1);
});
