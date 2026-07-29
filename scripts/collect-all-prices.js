#!/usr/bin/env node
/*
 * GitHub Actions에서 매일 실행 — products 전체 상품 가격 수집
 * node scripts/collect-all-prices.js
 *
 * 수집 전략:
 *   1차) 키워드 검색 — Naver 최대 300건(100×3페이지), Coupang 50건
 *        쿠팡 상품도 네이버에서 fallback 매칭 (쿠팡 API 차단 시 대비)
 *   2차) 1차에서 빠진 상품 — 상품명 앞 6단어로 직접 검색 (개별 fallback)
 *   3차) 여전히 빠지면 — 상품명 전체 exact 검색
 *   마지막) 커버리지 리포트 출력
 */

require('dotenv').config({ quiet: true });
const crypto   = require('crypto');
const supabase = require('../api/_supabase');

const TODAY = new Date().toISOString().slice(0, 10);
const CONCURRENCY   = 4;
const PAGE          = 1000;
const UPSERT_CHUNK  = 200;
const NAVER_DISPLAY = 100;
const NAVER_PAGES   = 3;
const COUPANG_LIMIT = 50;

// ─── 환경변수 ────────────────────────────────────────────────
const NAVER_ID     = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
const COUP_ACCESS  = process.env.COUPANG_ACCESS_KEY;
const COUP_SECRET  = process.env.COUPANG_SECRET_KEY;

console.log('[환경변수 진단]');
console.log('  NAVER_CLIENT_ID    :', NAVER_ID     ? `설정됨 (${NAVER_ID.length}자)` : '❌ 없음');
console.log('  NAVER_CLIENT_SECRET:', NAVER_SECRET ? `설정됨 (${NAVER_SECRET.length}자)` : '❌ 없음');
console.log('  COUPANG_ACCESS_KEY :', COUP_ACCESS  ? `설정됨 (${COUP_ACCESS.length}자)` : '❌ 없음');
console.log('  COUPANG_SECRET_KEY :', COUP_SECRET  ? `설정됨 (${COUP_SECRET.length}자)` : '❌ 없음');
console.log('  SUPABASE_URL       :', process.env.SUPABASE_URL       ? '설정됨' : '❌ 없음');
console.log('  SUPABASE_SECRET_KEY:', process.env.SUPABASE_SECRET_KEY ? '설정됨' : '❌ 없음');
console.log('');

// ─── 유틸 ────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retry(fn, attempts = 3, delayMs = 1500) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts - 1) throw e;
      await sleep(delayMs * (i + 1));
    }
  }
}

function isCoupangRow(p) {
  return p.mall === '쿠팡' || (p.link && p.link.includes('coupang'));
}

// ─── 쿠팡 API 상태 추적 ─────────────────────────────────────
let _coupangBlocked = false;
let _coupangBlockMsg = '';

// ─── API 호출 ─────────────────────────────────────────────────
async function naverPage(keyword, start, display) {
  if (!NAVER_ID || !NAVER_SECRET) return [];
  const url = `https://openapi.naver.com/v1/search/shop.json`
    + `?query=${encodeURIComponent(keyword)}&display=${display}&start=${start}&sort=sim`;
  const r = await fetch(url, {
    headers: { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET }
  });
  if (!r.ok) {
    console.warn(`    네이버 API ${r.status} (start=${start}): ${(await r.text()).slice(0, 120)}`);
    return [];
  }
  return ((await r.json()).items || []).map(it => ({
    productId: String(it.productId || ''),
    title: it.title.replace(/<[^>]*>/g, ''),
    lprice: parseInt(it.lprice) || 0,
    link: it.link || '',
    image: it.image || '',
    mall: it.mallName || '네이버쇼핑',
  })).filter(i => i.lprice > 0 && i.productId);
}

async function fetchNaverAll(keyword, maxPages = NAVER_PAGES) {
  const all = new Map();
  for (let page = 0; page < maxPages; page++) {
    const start = page * NAVER_DISPLAY + 1;
    const items = await retry(() => naverPage(keyword, start, NAVER_DISPLAY));
    items.forEach(it => { if (!all.has(it.productId)) all.set(it.productId, it); });
    if (items.length < NAVER_DISPLAY) break;
    await sleep(200);
  }
  return [...all.values()];
}

function coupangAuth(path, query) {
  const date = new Date();
  const ts = date.getUTCFullYear().toString().slice(-2)
    + String(date.getUTCMonth() + 1).padStart(2, '0')
    + String(date.getUTCDate()).padStart(2, '0')
    + 'T'
    + String(date.getUTCHours()).padStart(2, '0')
    + String(date.getUTCMinutes()).padStart(2, '0')
    + String(date.getUTCSeconds()).padStart(2, '0')
    + 'Z';
  const sig = crypto.createHmac('sha256', COUP_SECRET).update(ts + 'GET' + path + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${COUP_ACCESS}, signed-date=${ts}, signature=${sig}`;
}

async function fetchCoupangAll(keyword, limit = COUPANG_LIMIT) {
  if (!COUP_ACCESS || !COUP_SECRET) return [];
  if (_coupangBlocked) return [];

  const path  = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
  const query = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
  const r = await fetch(`https://api-gateway.coupang.com${path}?${query}`, {
    headers: { Authorization: coupangAuth(path, query) }
  });
  if (!r.ok) {
    console.warn(`    쿠팡 API HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return [];
  }
  const data = await r.json();

  if (data.rCode && data.rCode !== '200' && data.rCode !== 200) {
    if (!_coupangBlocked) {
      _coupangBlocked = true;
      _coupangBlockMsg = data.rMessage || `rCode=${data.rCode}`;
      console.error(`\n⚠️  쿠팡 API 차단 감지 (rCode=${data.rCode}): ${_coupangBlockMsg}`);
      console.error('    → 쿠팡 상품은 네이버 API fallback으로 수집합니다.\n');
    }
    return [];
  }

  return ((data.data && data.data.productData) || []).map(it => ({
    productId: String(it.productId || ''),
    title: it.productName || '',
    lprice: parseInt(it.discountPrice || it.productPrice) || 0,
    link: it.productUrl || '',
    image: it.productImage || '',
    mall: '쿠팡',
  })).filter(i => i.lprice > 0 && i.productId);
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

// ─── upsert (재시도 포함) ──────────────────────────────────────
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
    console.warn('  경고: rowMap이 비어 있음 — API 응답에서 product_id 매칭 0건');
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
  const markCovered = (productId, mall) => uncovered.delete(`${productId}|${mall}`);

  // ── 1차: 키워드 검색 ──────────────────────────────────────
  console.log('── 1차: 키워드별 검색 ──');
  const byKeyword = new Map();
  const noKeyword = [];
  products.forEach(p => {
    if (p.keyword) {
      if (!byKeyword.has(p.keyword)) byKeyword.set(p.keyword, []);
      byKeyword.get(p.keyword).push(p);
    } else {
      noKeyword.push(p);
    }
  });

  const keywords = [...byKeyword.keys()];
  for (let i = 0; i < keywords.length; i += CONCURRENCY) {
    const batch = keywords.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async keyword => {
      const targets = byKeyword.get(keyword);
      const naverById   = new Map();
      const coupangById = new Map();
      targets.forEach(p => {
        (isCoupangRow(p) ? coupangById : naverById).set(p.product_id, p);
      });

      // 네이버는 항상 호출 (쿠팡 상품도 네이버에서 검색 가능)
      const naverItems = await retry(() => fetchNaverAll(keyword)).catch(() => []);
      const coupangItems = coupangById.size > 0
        ? await retry(() => fetchCoupangAll(keyword)).catch(() => [])
        : [];

      let hit = 0;

      // 네이버 결과에서 네이버 상품 매칭
      naverItems.forEach(item => {
        const target = naverById.get(item.productId);
        if (target && addRow(target, item.lprice, item.link)) {
          markCovered(target.product_id, target.mall);
          hit++;
        }
      });

      // 쿠팡 결과에서 쿠팡 상품 매칭
      coupangItems.forEach(item => {
        const target = coupangById.get(item.productId);
        if (target && addRow(target, item.lprice, item.link)) {
          markCovered(target.product_id, target.mall);
          hit++;
        }
      });

      // 핵심: 아직 미수집인 쿠팡 상품을 네이버 결과에서도 찾기
      // (쿠팡 API 차단 시, 또는 쿠팡 product_id가 실제로는 네이버 ID인 경우)
      coupangById.forEach((target, pid) => {
        if (!uncovered.has(`${pid}|${target.mall}`)) return;
        const naverMatch = naverItems.find(it => it.productId === pid);
        if (naverMatch && addRow(target, naverMatch.lprice, naverMatch.link)) {
          markCovered(pid, target.mall);
          hit++;
        }
      });

      const total = targets.length;
      const pct = total > 0 ? Math.round(hit / total * 100) : 0;
      console.log(`  [${keyword}] ${hit}/${total} (${pct}%) — 네이버 ${naverItems.length}건, 쿠팡 ${coupangItems.length}건`);
    }));
  }

  // ── 2차: keyword 없는 상품 — 상품명 6단어 검색 ─────────────
  if (noKeyword.length > 0) {
    console.log(`\n── 2차: keyword 없는 상품 ${noKeyword.length}개 개별 검색 ──`);
    for (let i = 0; i < noKeyword.length; i += CONCURRENCY) {
      const batch = noKeyword.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async p => {
        const q = p.title.split(/\s+/).slice(0, 6).join(' ');
        // 쿠팡 상품도 네이버에서 검색 (네이버가 쿠팡 상품을 포함하므로)
        const naverItems = await retry(() => fetchNaverAll(q, 1)).catch(() => []);
        let match = naverItems.find(it => it.productId === p.product_id);

        if (!match && isCoupangRow(p)) {
          const coupangItems = await retry(() => fetchCoupangAll(q, 20)).catch(() => []);
          match = coupangItems.find(it => it.productId === p.product_id);
        }

        if (match && addRow(p, match.lprice, match.link)) {
          markCovered(p.product_id, p.mall);
        }
      }));
      if ((i + CONCURRENCY) % 20 === 0) {
        console.log(`  진행: ${Math.min(i + CONCURRENCY, noKeyword.length)}/${noKeyword.length}`);
        await sleep(500);
      }
    }
  }

  // ── 3차: 여전히 누락된 상품 — 상품명 10단어 검색 ────────────
  const stillMissing = [...uncovered.values()];
  if (stillMissing.length > 0) {
    console.log(`\n── 3차: 누락 ${stillMissing.length}개 exact 검색 ──`);
    for (let i = 0; i < stillMissing.length; i += CONCURRENCY) {
      const batch = stillMissing.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async p => {
        const q = p.title.split(/\s+/).slice(0, 10).join(' ');
        const naverItems = await retry(() => fetchNaverAll(q, 1)).catch(() => []);
        let match = naverItems.find(it => it.productId === p.product_id);

        if (!match && isCoupangRow(p)) {
          const coupangItems = await retry(() => fetchCoupangAll(q, 20)).catch(() => []);
          match = coupangItems.find(it => it.productId === p.product_id);
        }

        if (match && addRow(p, match.lprice, match.link)) {
          markCovered(p.product_id, p.mall);
        }
      }));
      await sleep(300);
    }
  }

  // ── 저장 ──────────────────────────────────────────────────
  console.log(`\n── 저장 ──`);
  const { saved, total: rowTotal } = await saveAll();
  console.log(`price_history upsert: ${saved}/${rowTotal}행`);

  // ── 커버리지 리포트 ────────────────────────────────────────
  const finalMissing = [...uncovered.values()];
  const covered  = products.length - finalMissing.length;
  const coverage = Math.round(covered / products.length * 100);

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`커버리지: ${covered}/${products.length} (${coverage}%)`);

  if (_coupangBlocked) {
    console.log(`\n⚠️  쿠팡 API 상태: 차단됨`);
    console.log(`    사유: ${_coupangBlockMsg}`);
    console.log('    → 쿠팡 파트너스에 소명 필요 (https://partners.coupang.com)');
  }

  if (finalMissing.length > 0) {
    const coupangMissing = finalMissing.filter(p => isCoupangRow(p));
    const naverMissing = finalMissing.filter(p => !isCoupangRow(p));
    console.log(`\n미수집: 네이버 ${naverMissing.length}개, 쿠팡 ${coupangMissing.length}개`);
    finalMissing.slice(0, 30).forEach(p =>
      console.log(`  - [${p.mall}] ${p.product_id} | ${p.title.slice(0, 60)}`)
    );
    if (finalMissing.length > 30) console.log(`  ... 외 ${finalMissing.length - 30}개`);
  }

  console.log(`${'═'.repeat(50)}\n`);

  if (coverage < 80) {
    console.warn(`경고: 커버리지 ${coverage}% < 80%`);
  }
  if (coverage < 95) {
    console.warn(`경고: 커버리지 ${coverage}% < 95%`);
  }
}

run().catch(e => {
  console.error('치명적 오류:', e.message, e.stack);
  process.exit(1);
});
