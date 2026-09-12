'use strict';

const Identity = require('./_identity');
const { canonicalUrl, normalizedTitle, stableKey } = require('./hotdeal-sources/normalize');

const MATCH_THRESHOLD = 0.75;
const EXPOSURE_SCORE = 60;

function setIntersects(a, b) { return a.size && b.size && [...a].some(v => b.has(v)); }
function setsConflict(a, b) { return a.size && b.size && !setIntersects(a, b); }

function quantities(title) {
  const out = new Set();
  const re = /(\d+(?:\.\d+)?)\s*(캔|병|개입|개|입|팩|박스|봉|포|정|롤|매|장|권)(?![가-힣])/gi;
  let m;
  while ((m = re.exec(String(title || ''))) !== null) out.add(`${Number(m[1])}${m[2].toLowerCase()}`);
  return out;
}

function measurements(title) {
  const out = new Set();
  const re = /(\d+(?:\.\d+)?)\s*(ml|l|g|kg|gb|tb|mah|oz|인치|형)(?![a-z가-힣])/gi;
  let m;
  while ((m = re.exec(String(title || ''))) !== null) {
    let value = Number(m[1]);
    let unit = m[2].toLowerCase();
    if (unit === 'l') { value *= 1000; unit = 'ml'; }
    if (unit === 'kg') { value *= 1000; unit = 'g'; }
    if (unit === 'tb') { value *= 1024; unit = 'gb'; }
    if (unit === '형') unit = '인치';
    out.add(`${value}${unit}`);
  }
  return out;
}

function jaccardTitle(a, b) {
  const A = new Set(normalizedTitle(a).split(' ').filter(Boolean));
  const B = new Set(normalizedTitle(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  A.forEach(v => { if (B.has(v)) intersection++; });
  return intersection / (A.size + B.size - intersection);
}

function urlOf(product) { return canonicalUrl(product.link || product.product_url || product.url); }

function vendorId(value) {
  const text = String(value || '');
  const match = text.match(/[?&](?:vendorItemId|itemId)=([0-9A-Za-z_-]+)/i)
    || text.match(/\/products\/([0-9A-Za-z_-]+)/i);
  return match ? match[1] : '';
}

function matchScore(deal, product) {
  const d = deal || {}, p = product || {};
  const candidateTitle = d.title || '';
  const storedTitle = p.title || '';
  if (!candidateTitle || !storedTitle) return { confidence: 0, reason: '상품명 결손', method: 'none' };

  const dc = measurements(candidateTitle), pc = measurements(storedTitle);
  const dq = quantities(candidateTitle), pq = quantities(storedTitle);
  const dm = Identity.modelCodes(candidateTitle), pm = Identity.modelCodes(storedTitle);
  const dg = Identity.grades(candidateTitle), pg = Identity.grades(storedTitle);
  if (setsConflict(dc, pc)) return { confidence: 0.02, reason: '용량/크기 불일치', method: 'conflict' };
  if (setsConflict(dq, pq)) return { confidence: 0.02, reason: '수량 불일치', method: 'conflict' };
  if (setsConflict(dm, pm)) return { confidence: 0.02, reason: '모델번호 불일치', method: 'conflict' };
  if ((dg.size || pg.size) && setsConflict(dg, pg)) return { confidence: 0.05, reason: '세대/등급 불일치', method: 'conflict' };

  const dealUrl = canonicalUrl(d.productUrl || d.product_url);
  const productUrl = urlOf(p);
  if (dealUrl && productUrl && dealUrl === productUrl) {
    return { confidence: 1, reason: '상품 URL 완전 일치', method: 'url' };
  }
  const dv = vendorId(dealUrl), pv = String(p.vendor_item_id || vendorId(productUrl));
  if (dv && pv && dv === pv && (!d.mall || !p.mall || String(d.mall) === String(p.mall))) {
    return { confidence: 0.99, reason: '몰 상품 식별자 일치', method: 'mall-id' };
  }

  const judged = Identity.judgeSameProduct(storedTitle, candidateTitle);
  if (judged.tier === 'D') return { confidence: 0.05, reason: judged.reasons[0], method: 'identity-reject' };
  if (setIntersects(dm, pm)) {
    const brand = [...Identity.idTokens(candidateTitle)][0];
    const hasBrand = brand && Identity.idTokens(storedTitle).has(brand);
    return { confidence: hasBrand ? 0.97 : 0.9, reason: hasBrand ? '브랜드 + 모델번호 일치' : '모델번호 일치', method: 'model' };
  }
  if (judged.tier === 'A') return { confidence: 0.94, reason: judged.reasons[0], method: 'identity' };
  if (judged.tier === 'B') return { confidence: 0.82, reason: judged.reasons[0], method: 'identity' };

  const similarity = jaccardTitle(storedTitle, candidateTitle);
  const confidence = Math.min(0.74, Math.round(similarity * 80) / 100);
  return { confidence, reason: `제목 토큰 유사도 ${Math.round(similarity * 100)}%`, method: 'title' };
}

function matchProduct(deal, products, threshold) {
  const min = Number.isFinite(threshold) ? threshold : MATCH_THRESHOLD;
  let best = null;
  for (const product of products || []) {
    const result = matchScore(deal, product);
    if (!best || result.confidence > best.confidence) best = { ...result, product };
  }
  if (!best || best.confidence < min) {
    return { product: null, confidence: best ? best.confidence : 0, reason: best ? best.reason : '후보 없음', method: best ? best.method : 'none' };
  }
  return best;
}

function day(value) { return String(value || '').slice(0, 10); }
function dateMs(value) { const n = Date.parse(`${day(value)}T00:00:00Z`); return Number.isFinite(n) ? n : 0; }
function avg(values) { return values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null; }

function historyStats(points, today) {
  const byDay = new Map();
  for (const point of points || []) {
    const d = day(point.date || point.recorded_date || point.recorded_at);
    const price = Math.round(Number(point.price) || 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || price <= 0) continue;
    if (!byDay.has(d) || price < byDay.get(d)) byDay.set(d, price);
  }
  const rows = [...byDay].sort((a, b) => a[0].localeCompare(b[0]));
  const now = dateMs(today) || Date.now();
  const within = n => rows.filter(([d]) => now - dateMs(d) <= (n - 1) * 86400000 && dateMs(d) <= now);
  const p30 = within(30).map(r => r[1]);
  const p90 = within(90).map(r => r[1]);
  const latest = rows[rows.length - 1];
  const previous = rows.length > 1 ? rows[rows.length - 2] : null;
  return {
    count: rows.length,
    average30: avg(p30),
    low30: p30.length ? Math.min(...p30) : null,
    low90: p90.length ? Math.min(...p90) : null,
    previousPrice: previous ? previous[1] : null,
    lastObservedAt: latest ? latest[0] : null,
    staleDays: latest ? Math.max(0, Math.round((now - dateMs(latest[0])) / 86400000)) : null
  };
}

function discountPercent(reference, price) {
  return reference && price > 0 ? Math.round((reference - price) / reference * 1000) / 10 : null;
}

function verifyDeal(deal, match, points, today) {
  const stats = historyStats(points, today);
  const matchConfidence = Number(match && match.confidence) || 0;
  const avgDiscount = discountPercent(stats.average30, deal.price);
  const lowDelta = stats.low90 ? Math.round((deal.price - stats.low90) / stats.low90 * 1000) / 10 : null;
  const fresh = stats.staleDays == null ? 0 : stats.staleDays <= 2 ? 5 : stats.staleDays <= 7 ? 3 : 0;
  const parts = {
    averageDiscount: avgDiscount == null ? 0 : Math.max(0, Math.min(45, avgDiscount / 30 * 45)),
    lowProximity: lowDelta == null ? 0 : lowDelta <= 0 ? 20 : Math.max(0, 20 * (1 - lowDelta / 15)),
    observations: Math.min(15, stats.count / 14 * 15),
    match: matchConfidence * 15,
    freshness: fresh
  };
  let score = Math.round(Object.values(parts).reduce((s, v) => s + v, 0));
  const suspiciousPrice = (stats.average30 && deal.price < stats.average30 * 0.5)
    || (stats.previousPrice && deal.price < stats.previousPrice * 0.5);
  if (!match || !match.product || matchConfidence < MATCH_THRESHOLD) score = 0;
  else if (suspiciousPrice) score = 0;
  else if (stats.count < 3) score = Math.min(score, 49);
  else if (stats.count < 7) score = Math.min(score, 74);
  else if (stats.count < 14) score = Math.min(score, 89);
  if (stats.staleDays != null && stats.staleDays > 14) score = Math.min(score, 59);

  let status = 'NOT_QUALIFIED';
  if (!match || !match.product) status = 'UNMATCHED';
  else if (suspiciousPrice) status = 'SUSPICIOUS_PRICE';
  else if (stats.count < 3) status = 'INSUFFICIENT_HISTORY';
  else if (score >= 90) status = 'STRONG_DEAL';
  else if (score >= 75) status = 'GOOD_DEAL';
  else if (score >= EXPOSURE_SCORE) status = 'INTEREST';

  return {
    dealScore: score,
    verificationStatus: status,
    priceVs30dAvg: avgDiscount,
    priceVs90dLow: lowDelta,
    stats,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10]))
  };
}

function similarPrice(a, b) { return Math.abs(a - b) / Math.max(a, b) <= 0.05; }
function closeInTime(a, b) { return Math.abs(Date.parse(a) - Date.parse(b)) <= 48 * 3600000; }

function dedupeAcrossSources(rows) {
  const groups = [];
  for (const row of rows || []) {
    const canonical = canonicalUrl(row.productUrl || row.product_url);
    const matchId = String(row.matchedProductId || row.matched_product_id || '');
    let group = groups.find(g => {
      const first = g[0];
      const firstCanonical = canonicalUrl(first.productUrl || first.product_url);
      const firstMatch = String(first.matchedProductId || first.matched_product_id || '');
      const sameIdentity = (matchId && firstMatch && matchId === firstMatch)
        || (canonical && firstCanonical && canonical === firstCanonical);
      return sameIdentity && similarPrice(Number(row.price), Number(first.price))
        && closeInTime(row.postedAt || row.posted_at, first.postedAt || first.posted_at);
    });
    if (!group) { group = []; groups.push(group); }
    group.push(row);
  }
  return groups.map(group => {
    const sorted = group.slice().sort((a, b) => Number(b.dealScore || b.deal_score || 0) - Number(a.dealScore || a.deal_score || 0));
    const sources = [...new Set(sorted.map(r => String(r.source || '')).filter(Boolean))];
    const first = sorted[0];
    const identity = first.matchedProductId || first.matched_product_id
      || canonicalUrl(first.productUrl || first.product_url) || normalizedTitle(first.title);
    const groupKey = stableKey(`${identity}|${Math.round(Number(first.price) / 1000)}|${day(first.postedAt || first.posted_at)}`);
    return sorted.map((row, index) => ({ ...row, groupKey, isPrimary: index === 0, sourceCount: sources.length, sources }));
  }).flat();
}

module.exports = {
  MATCH_THRESHOLD, EXPOSURE_SCORE, quantities, measurements, jaccardTitle, matchScore, matchProduct,
  historyStats, verifyDeal, dedupeAcrossSources
};
