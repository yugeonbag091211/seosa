'use strict';
/*
 * 가격 계열 로더 — SEOSA 2.0 의 ① 타이밍 · ④ 확장 · ⑥ 이상 탐지가 함께 쓴다.
 *
 * ── 왜 새 로더인가 (그리고 왜 새 규칙이 아닌가) ─────────────────────
 *
 * /api/history 는 KST 날짜당 최저가 한 점으로 접은 곡선만 돌려준다. 그것으로
 * 충분한 화면이 대부분이지만, 이상 탐지는 «접기 전» 관측이 필요하다 — 같은
 * 날 두 값이 충돌했는지, 옵션(vendor_item_id)이 언제 바뀌었는지는 접고 나면
 * 사라진다. 그래서 원본 행과 접은 점을 «한 번의 조회로» 함께 돌려준다.
 *
 * ★ 규칙은 하나도 새로 만들지 않는다.
 *     옵션 가르기  → _price.sameVendorRows   (옛 기록 폴백 포함)
 *     날짜         → _price.observedKstDate  (recorded_at 을 KST 로)
 *     같은 날 여럿 → 최저가 한 점            (history.js collapseToDaily 와 같다)
 *     옵션 모름    → _price.vendorIdOf       (컬럼 → link 순)
 *   같은 상품에 대해 모달·상품 페이지·AI·이 로더가 같은 곡선을 그려야 한다.
 *   scripts/test-v2-foundation.js 가 history.js 와 점 단위로 같은지 고정한다.
 *
 * ★ 읽기 전용. price_history 1회 + products 1회가 전부다.
 */

const supabase = require('./_supabase');
const { observedKstDate, sameVendorRows, vendorIdOf, kstToday } = require('./_price');

/** 한 상품에서 읽을 최대 행 수 (history.js SINGLE_MAX_ROWS 와 같은 값). */
const MAX_ROWS = 3000;
/** 기본 조회 창(일). */
const DEFAULT_DAYS = 365;

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }

/** 행 → KST 날짜당 최저가, 날짜 오름차순. */
function toDailyPoints(rows) {
  const byDate = new Map();
  (rows || []).forEach(r => {
    const date = observedKstDate(r);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const price = Math.round(Number(r.price));
    if (!(price > 0)) return;
    const cur = byDate.get(date);
    if (cur === undefined || price < cur) byDate.set(date, price);
  });
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, price]) => ({ date, price }));
}

/** 관측 시각 오름차순. recorded_at 이 없으면 라벨, 그다음 id 로 전순서를 준다. */
function byTimeAsc(a, b) {
  const ta = String(a.recorded_at || a.recorded_date || '');
  const tb = String(b.recorded_at || b.recorded_date || '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (Number(a.id) || 0) - (Number(b.id) || 0);
}

/**
 * 카탈로그 행 중 이 요청에 맞는 것.
 * 몰까지 맞는 행 → 그중 옵션까지 맞는 행 → 첫 행 순으로 고른다.
 */
function pickProduct(rows, mall, vid) {
  const list = (rows || []).filter(Boolean);
  const sameMall = mall ? list.filter(r => String(r.mall || '') === mall) : list;
  const pool = sameMall.length ? sameMall : (mall ? [] : list);
  if (!pool.length) return null;
  if (vid) {
    const exact = pool.find(r => vendorIdOf(r) === vid);
    if (exact) return exact;
  }
  return pool[0];
}

/**
 * 한 상품의 가격 계열.
 *
 * @param {{productId:string, mall?:string, vendorItemId?:string}} key
 * @param {{days?:number}} [opts]
 * @returns {Promise<{product:object|null, vendorItemId:string, rawRows:object[], rows:object[],
 *                    points:{date:string,price:number}[], truncated:boolean}>}
 */
async function loadSeries(key, opts) {
  const productId = str(key && key.productId, 120);
  const mall = str(key && key.mall, 40);
  let vendorItemId = str(key && key.vendorItemId, 120);
  const empty = { product: null, vendorItemId, rawRows: [], rows: [], points: [], truncated: false };
  if (!productId) return empty;

  const days = Math.max(1, Math.min(730, Math.round(Number(opts && opts.days) || DEFAULT_DAYS)));
  const cutoff = kstToday(new Date(Date.now() - days * 86400000));

  let pq = supabase.from('products')
    .select('product_id, mall, mall_label, vendor_item_id, title, lprice, oprice, image, link, keyword, collected_at')
    .eq('product_id', productId);
  if (mall) pq = pq.eq('mall', mall);

  let hq = supabase.from('price_history')
    .select('id, product_id, mall, vendor_item_id, price, recorded_date, recorded_at')
    .eq('product_id', productId);
  if (mall) hq = hq.eq('mall', mall);
  hq = hq.gte('recorded_date', cutoff)
    // 잘릴 때 오래된 쪽이 버려지도록 최신순으로 받는다 (history.js baseQuery 와 같은 이유).
    .order('recorded_date', { ascending: false })
    .limit(MAX_ROWS);

  const [pr, hr] = await Promise.all([pq.limit(10), hq]);
  if (hr.error) throw new Error(`price_history 조회 실패: ${hr.error.message}`);
  // 카탈로그를 못 읽어도 가격 계열은 쓸 수 있다 — 제목·링크만 비는 것이다.
  if (pr.error) console.warn(`[series] products 조회 실패(계열만 사용): ${pr.error.message}`);

  const product = pickProduct(pr.error ? [] : pr.data, mall, vendorItemId);
  if (!vendorItemId && product) vendorItemId = vendorIdOf(product);

  const rawRows = (hr.data || []).slice().sort(byTimeAsc);
  const rows = sameVendorRows(rawRows, vendorItemId);
  return {
    product,
    vendorItemId,
    rawRows,
    rows,
    points: toDailyPoints(rows),
    truncated: (hr.data || []).length >= MAX_ROWS
  };
}

/** 응답에 싣는 상품 요약 — 카탈로그 행을 통째로 내보내지 않는다. */
function productSummary(key, series) {
  const p = series && series.product;
  return {
    productId: str(key && key.productId, 120),
    mall: (p && p.mall) || str(key && key.mall, 40) || '',
    mallLabel: (p && (p.mall_label || p.mall)) || '',
    vendorItemId: (series && series.vendorItemId) || '',
    title: (p && p.title) || null,
    image: (p && p.image) || null,
    url: (p && p.link) || null,
    catalogPrice: p && Number(p.lprice) > 0 ? Math.round(Number(p.lprice)) : null,
    referencePrice: p && Number(p.oprice) > 0 ? Math.round(Number(p.oprice)) : null,
    collectedAt: (p && p.collected_at) || null
  };
}

/** 요청 쿼리에서 상품 키를 읽는다. productId 가 없으면 null. */
function readKey(q) {
  const productId = str(q && (q.productId || q.pid), 120);
  if (!productId || !/^[\w.-]+$/.test(productId)) return null;
  return { productId, mall: str(q && q.mall, 40), vendorItemId: str(q && q.vendorItemId, 120) };
}

module.exports = {
  loadSeries, toDailyPoints, productSummary, readKey, pickProduct,
  MAX_ROWS, DEFAULT_DAYS
};
