'use strict';

const Identity = require('./_identity');
const HD = require('./_hotdeal');
const { canonicalUrl, normalizedTitle, stableKey } = require('./_hotdeal-sources/normalize');

/*
 * 0.75 was re-checked against a 2026-09-13 probe (the cases now live in
 * scripts/test-external-hotdeal-validation.js). Confidence falls into layers:
 *   url / vendorItemId 0.99–1 · model 0.90–0.97 · identity A 0.94 · identity B 0.82 · title ≤ 0.74
 * Every false match found (8 of 24 must-not-match pairs) sat in the B layer,
 * so the fix is the gate into that layer, not the threshold.
 */
const MATCH_THRESHOLD = 0.75;
const HIGH_MATCH_CONFIDENCE = 0.9;
const EXPOSURE_SCORE = 60;
const VISIBLE_STATUSES = ['STRONG_DEAL', 'GOOD_DEAL', 'INTEREST'];

function setIntersects(a, b) { return a.size && b.size && [...a].some(v => b.has(v)); }
function setsConflict(a, b) { return a.size && b.size && !setIntersects(a, b); }
function setsDiffer(a, b) { return [...a].some(v => !b.has(v)) || [...b].some(v => !a.has(v)); }

/** "5개입" and "5개" are the same count; 캔/병/박스 are different packagings. */
const COUNT_UNIT_ALIAS = { '개입': '개', '입': '개' };

/** "(총1kg)" restates the pack total. It is not a separate variant value. */
const TOTAL_RE = /총\s*\d+(?:\.\d+)?\s*(?:ml|l|g|kg|gb|tb|mah|oz|캔|병|개입|개|입|팩|박스|봉|포|정|롤|매|장|권)/gi;
function withoutTotals(title) { return String(title || '').replace(TOTAL_RE, ' '); }

function countsIn(text) {
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*(캔|병|개입|개|입|팩|박스|봉|포|정|롤|매|장|권)(?![가-힣])/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const unit = m[2].toLowerCase();
    out.push(`${Number(m[1])}${COUNT_UNIT_ALIAS[unit] || unit}`);
  }
  // A bare multiplier is a count too ("200ml x2"). "x 2봉" is already read above;
  // "340x3408x870" is a dimension, so the sign must follow a letter, ")" or a space.
  const multiplier = /(?<=[a-z가-힣)\s])[x×*]\s*(\d{1,2})(?![\d가-힣a-z.])/gi;
  while ((m = multiplier.exec(text)) !== null) out.push(`${Number(m[1])}개`);
  return out;
}

/** A total ("총 4개") is ignored only when the title states the counts it adds up. */
function quantityList(title) {
  const parts = countsIn(withoutTotals(title));
  return parts.length ? parts : countsIn(String(title || ''));
}

function quantities(title) { return new Set(quantityList(title)); }

/** Order-insensitive multiset. "20개 + 10개" and "10개 + 10개" have equal sets but different bags. */
function quantityBag(title) { return quantityList(title).sort().join('|'); }

function multiCount(set) { return [...set].some(v => parseFloat(v) > 1); }

function measurements(title) {
  const out = new Set();
  // "x" may follow a unit as a multiplier ("2kgx3개").
  const re = /(\d+(?:\.\d+)?)\s*(ml|l|g|kg|gb|tb|mah|oz|인치|형)(?![a-wyz가-힣])/gi;
  let m;
  while ((m = re.exec(withoutTotals(title))) !== null) {
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

/*
 * Variant words that split one product line into different products and that
 * _identity.grades does not cover (RTX 5070 vs 5070 Ti, Switch vs Switch OLED).
 */
const VARIANT_RULES = [
  ['ti', /(^|[^a-z])ti([^a-z]|$)/i],
  ['super', /(^|[^a-z])super([^a-z]|$)/i],
  ['xt', /(^|[^a-z])xtx?([^a-z]|$)/i],
  ['se', /(^|[^a-z])se([^a-z]|$)/i],
  ['fe', /(^|[^a-z])fe([^a-z]|$)/i],
  ['oled', /oled/i],
  ['air', /(^|[^a-z])air([^a-z]|$)|에어(?!팟|컨|프라이|로|쿠션|건|캡|랩)/i],
  ['fold', /(^|[^a-z])fold\d*([^a-z]|$)|폴드/i],
  ['flip', /(^|[^a-z])flip\d*([^a-z]|$)|플립/i]
];

function variants(title) {
  const s = String(title || '');
  return new Set(VARIANT_RULES.filter(([, re]) => re.test(s)).map(([key]) => key));
}

let accessoryWords = null;
/** Accessory / refill words. Reuses _search.ACCESSORY_TIER (curated against real search false positives). */
function accessories(title) {
  if (!accessoryWords) {
    try { accessoryWords = (require('./_search').ACCESSORY_TIER || []).map(pair => pair[0]); }
    catch (_) { accessoryWords = []; }
  }
  const s = String(title || '');
  return new Set(accessoryWords.filter(word => s.indexOf(word) > -1));
}

const BUNDLE_RE = /번들|패키지|(^|[^a-z])(bundle|package)([^a-z]|$)/i;

/** Flavor / scent options ("흑임자맛", "라벤더향"). */
function flavors(title) {
  const out = new Set();
  const re = /([가-힣]{1,8})(맛|향)(?![가-힣])/g;
  let m;
  while ((m = re.exec(String(title || ''))) !== null) out.add(m[1] + m[2]);
  return out;
}

/*
 * Spec codes look like model codes (letters + digits) but are shared by many
 * products (a real catalog pair: two different brands' IPX8 phone pouches).
 */
const SPEC_CODE_RE = /^(IPX?\d{1,2}|DDR\d|LPDDR\d\w*|WIFI\d\w*|USB\d\w*|HDMI\d\w*|PCIE\d\w*|BT\d\w*|UHS-?\w+)$/i;

/** Each side carries a value the other lacks: different, not merely omitted. */
function bothHaveExtra(a, b) {
  return a.size && b.size && [...a].some(v => !b.has(v)) && [...b].some(v => !a.has(v));
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

/** '' and '__LEGACY__' mean "option unknown", never a value to compare. */
function realVendorItemId(value) {
  const v = String(value || '').trim();
  return v && v !== '__LEGACY__' ? v : '';
}

/**
 * Only Coupang's vendorItemId identifies an option. productId (/vp/products/N)
 * and itemId are different namespaces and must never be compared with it.
 */
function urlVendorItemId(url) {
  const m = String(url || '').match(/[?&]vendorItemId=(\d+)/i);
  return m ? m[1] : '';
}

function isCoupangUrl(url) {
  try { return /(^|\.)coupang\.com$/i.test(new URL(url).hostname); } catch (_) { return false; }
}

function matchScore(deal, product) {
  const d = deal || {}, p = product || {};
  const candidateTitle = d.title || '';
  const storedTitle = p.title || '';
  if (!candidateTitle || !storedTitle) return { confidence: 0, reason: '상품명 결손', method: 'none' };

  /*
   * 1) Values written on both sides that disagree veto every other signal.
   *    Counts and capacities must agree exactly when both sides state them:
   *    "32G/1TB" vs "64G/1TB" shares 1TB but is a different product (real
   *    catalog mutation audit, 2026-09-13). Model codes may be omitted on one
   *    side (seller codes), so they conflict only when each side has its own.
   */
  const dc = measurements(candidateTitle), pc = measurements(storedTitle);
  const dq = quantities(candidateTitle), pq = quantities(storedTitle);
  const dm = Identity.modelCodes(candidateTitle), pm = Identity.modelCodes(storedTitle);
  const dg = Identity.grades(candidateTitle), pg = Identity.grades(storedTitle);
  const df = flavors(candidateTitle), pf = flavors(storedTitle);
  if (dc.size && pc.size && setsDiffer(dc, pc)) return { confidence: 0.02, reason: '용량/크기 불일치', method: 'conflict' };
  if (dq.size && pq.size && quantityBag(candidateTitle) !== quantityBag(storedTitle)) {
    return { confidence: 0.02, reason: '수량 불일치', method: 'conflict' };
  }
  if (bothHaveExtra(dm, pm)) return { confidence: 0.02, reason: '모델번호 불일치', method: 'conflict' };
  if ((dg.size || pg.size) && setsConflict(dg, pg)) return { confidence: 0.05, reason: '세대/등급 불일치', method: 'conflict' };
  if (df.size && pf.size && setsDiffer(df, pf)) return { confidence: 0.05, reason: '맛/향 옵션 불일치', method: 'conflict' };

  const dealUrl = canonicalUrl(d.productUrl || d.product_url);
  const productUrl = urlOf(p);
  const dealVid = urlVendorItemId(dealUrl);
  const productVid = realVendorItemId(p.vendor_item_id) || urlVendorItemId(productUrl);
  if (dealVid && productVid && dealVid !== productVid) {
    return { confidence: 0.02, reason: '옵션 식별자(vendorItemId) 불일치', method: 'conflict' };
  }

  /* 2) Mall identifiers. */
  if (dealUrl && productUrl && dealUrl === productUrl) {
    // A Coupang productId-level URL does not pin the option we track.
    const optionUnknown = isCoupangUrl(dealUrl) && productVid && !dealVid;
    if (!optionUnknown) return { confidence: 1, reason: '상품 URL 완전 일치', method: 'url' };
  }
  if (dealVid && productVid && dealVid === productVid
    && (!d.mall || !p.mall || String(d.mall) === String(p.mall))) {
    return { confidence: 0.99, reason: '몰 옵션 식별자(vendorItemId) 일치', method: 'mall-id' };
  }

  /* 3) Title-only evidence. Information present on one side only means "may differ". */
  if (!dq.size !== !pq.size && (multiCount(dq) || multiCount(pq))) {
    return { confidence: 0.05, reason: '수량 표기가 한쪽에만 있다', method: 'conflict' };
  }
  const dv = variants(candidateTitle), pv = variants(storedTitle);
  if (setsDiffer(dv, pv)) {
    return { confidence: 0.05, reason: `변형 표기 불일치 [${[...pv].join(',')}] ≠ [${[...dv].join(',')}]`, method: 'conflict' };
  }
  const da = accessories(candidateTitle), pa = accessories(storedTitle);
  if (setsDiffer(da, pa)) {
    return { confidence: 0.05, reason: `부속/리필 표기 불일치 [${[...pa].join(',')}] ≠ [${[...da].join(',')}]`, method: 'conflict' };
  }
  if (BUNDLE_RE.test(candidateTitle) !== BUNDLE_RE.test(storedTitle)) {
    return { confidence: 0.05, reason: '번들/패키지 구성이 한쪽에만 있다', method: 'conflict' };
  }

  const judged = Identity.judgeSameProduct(storedTitle, candidateTitle);
  if (judged.tier === 'D') return { confidence: 0.05, reason: judged.reasons[0], method: 'identity-reject' };
  const sharedCodes = [...dm].filter(code => pm.has(code) && !SPEC_CODE_RE.test(code));
  if (sharedCodes.length) {
    const brand = [...Identity.idTokens(candidateTitle)][0];
    const hasBrand = brand && Identity.idTokens(storedTitle).has(brand);
    if (hasBrand) return { confidence: 0.97, reason: '브랜드 + 모델번호 일치', method: 'model' };
    // Without a brand, only a long code is distinctive enough on its own.
    if (sharedCodes.some(code => code.replace(/-/g, '').length >= 6)) {
      return { confidence: 0.9, reason: '모델번호 일치', method: 'model' };
    }
  }
  if (judged.tier === 'A') return { confidence: 0.94, reason: judged.reasons[0], method: 'identity' };

  const similarity = jaccardTitle(storedTitle, candidateTitle);
  if (judged.tier === 'B') {
    // B measures overlap against the shorter title, so a strict subset scores 100%.
    // Words present on one side only are unverified differences.
    if (similarity >= 0.6) return { confidence: 0.82, reason: judged.reasons[0], method: 'identity' };
    return {
      confidence: 0.7,
      reason: `${judged.reasons[0]} · 한쪽에만 있는 낱말이 많다(유사도 ${Math.round(similarity * 100)}%)`,
      method: 'identity-partial'
    };
  }
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
    return {
      product: null,
      // Kept for false-negative audits only. Never used as identity.
      candidate: best ? best.product : null,
      confidence: best ? best.confidence : 0,
      reason: best ? best.reason : '후보 없음',
      method: best ? best.method : 'none'
    };
  }
  return best;
}

function day(value) { return String(value || '').slice(0, 10); }
function dateMs(value) { const n = Date.parse(`${day(value)}T00:00:00Z`); return Number.isFinite(n) ? n : 0; }
function avg(values) { return values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null; }
function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

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
    count90: p90.length,
    average30: avg(p30),
    median30: median(p30),
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

const CONDITIONAL_PRICE_RE = /카드|청구\s*할인|쿠폰|적립|페이백|캐시백|중복\s*할인|즉시\s*할인/;
const MEMBER_PRICE_RE = /와우|멤버십|멤버쉽|회원\s*(가|전용|한정)|스마일\s*클럽|유니버스\s*클럽|클럽\s*전용|네이버\s*플러스/i;

/** What the community price actually means, from adapter metadata and the raw title. */
function priceContext(deal) {
  const d = deal || {};
  const meta = d.metadata && typeof d.metadata === 'object' ? d.metadata : {};
  const text = `${meta.rawTitle || ''} ${d.title || ''}`;
  const fee = Number(meta.shippingFee);
  return {
    shippingFee: Number.isFinite(fee) && fee > 0 ? fee : 0,
    shippingUnknown: meta.shippingNote === 'conditional' || meta.shippingNote === 'unknown',
    priceIsFrom: meta.priceIsFrom === true,
    priceQualified: meta.priceHasCondition === true,
    conditional: CONDITIONAL_PRICE_RE.test(text),
    memberOnly: MEMBER_PRICE_RE.test(text)
  };
}

/**
 * Verify a community price against SEOSA's own history.
 *
 * `reasons` explains the score for API/debug. Positive evidence:
 *   HIGH_MATCH_CONFIDENCE BELOW_30D_AVG NEW_90D_LOW NEAR_90D_LOW
 * Doubts (each zeroes, caps, or only annotates the score):
 *   UNMATCHED LOW_MATCH_CONFIDENCE SUSPICIOUS_DROP DEEP_BELOW_90D_LOW NO_HISTORY
 *   INSUFFICIENT_HISTORY LOW_HISTORY_COUNT STALE_HISTORY AVG30_SKEWED_BY_SPIKE
 *   OPTION_PRICE_RANGE PRICE_QUALIFIER MEMBER_ONLY_PRICE CONDITIONAL_PRICE
 *   CROSS_MALL_REFERENCE SHIPPING_ADDED SHIPPING_UNKNOWN
 */
function verifyDeal(deal, match, points, today) {
  const stats = historyStats(points, today);
  const ctx = priceContext(deal);
  const matchConfidence = Number(match && match.confidence) || 0;
  const matched = !!(match && match.product) && matchConfidence >= MATCH_THRESHOLD;
  // Shipping is part of what the buyer pays; SEOSA history is item price. Adding it is the conservative side.
  const effectivePrice = deal.price + ctx.shippingFee;
  const avgDiscount = discountPercent(stats.average30, effectivePrice);
  const medianDiscount = discountPercent(stats.median30, effectivePrice);
  // One spike drags the mean up. Score with whichever reference is less flattering.
  const scoringDiscount = avgDiscount == null ? medianDiscount
    : medianDiscount == null ? avgDiscount : Math.min(avgDiscount, medianDiscount);
  const lowDelta = stats.low90 ? Math.round((effectivePrice - stats.low90) / stats.low90 * 1000) / 10 : null;
  const fresh = stats.staleDays == null ? 0 : stats.staleDays <= 2 ? 5 : stats.staleDays <= 7 ? 3 : 0;
  const parts = {
    averageDiscount: scoringDiscount == null ? 0 : Math.max(0, Math.min(45, scoringDiscount / 30 * 45)),
    lowProximity: lowDelta == null ? 0 : lowDelta <= 0 ? 20 : Math.max(0, 20 * (1 - lowDelta / 15)),
    observations: Math.min(15, stats.count90 / 14 * 15),
    match: matchConfidence * 15,
    freshness: fresh
  };

  const reasons = [];
  const caps = [];
  const cap = (code, max) => { reasons.push(code); caps.push(max); };

  if (!match || !match.product) reasons.push('UNMATCHED');
  else if (matchConfidence < MATCH_THRESHOLD) reasons.push('LOW_MATCH_CONFIDENCE');
  else if (matchConfidence >= HIGH_MATCH_CONFIDENCE) reasons.push('HIGH_MATCH_CONFIDENCE');

  if (scoringDiscount != null && scoringDiscount >= 5) reasons.push('BELOW_30D_AVG');
  if (lowDelta != null && lowDelta < 0) reasons.push('NEW_90D_LOW');
  else if (lowDelta != null && lowDelta <= 2) reasons.push('NEAR_90D_LOW');
  if (stats.average30 && stats.median30 && stats.average30 > stats.median30 * 1.08) reasons.push('AVG30_SKEWED_BY_SPIKE');

  // A price under half of what SEOSA observed is more often a typo, a wrong
  // option, or a per-unit price than a bargain. The previous-point rule only
  // fires when the median agrees, so a spike returning to normal is not flagged.
  const suspiciousPrice = !!((stats.average30 && effectivePrice < stats.average30 * 0.5)
    || (stats.median30 && effectivePrice < stats.median30 * 0.5)
    || (stats.previousPrice && effectivePrice < stats.previousPrice * 0.5
      && (!stats.median30 || effectivePrice < stats.median30 * 0.8)));
  if (suspiciousPrice) reasons.push('SUSPICIOUS_DROP');
  else if (stats.low90 && effectivePrice < stats.low90 * 0.7) cap('DEEP_BELOW_90D_LOW', 74);

  if (stats.count90 === 0) reasons.push('NO_HISTORY');
  else if (stats.count90 < 3) reasons.push('INSUFFICIENT_HISTORY');
  else if (stats.count90 < 7) reasons.push('LOW_HISTORY_COUNT');
  if (stats.staleDays != null && stats.staleDays > 14) reasons.push('STALE_HISTORY');

  if (ctx.priceIsFrom) cap('OPTION_PRICE_RANGE', 49);
  if (ctx.priceQualified) cap('PRICE_QUALIFIER', 74);
  if (ctx.memberOnly) cap('MEMBER_ONLY_PRICE', 74);
  if (ctx.conditional) cap('CONDITIONAL_PRICE', 89);
  if (matched && deal.mall && match.product.mall && String(deal.mall) !== String(match.product.mall)) {
    cap('CROSS_MALL_REFERENCE', 89);
  }
  if (ctx.shippingFee > 0) reasons.push('SHIPPING_ADDED');
  if (ctx.shippingUnknown) reasons.push('SHIPPING_UNKNOWN');

  let score = Math.round(Object.values(parts).reduce((s, v) => s + v, 0));
  if (!matched) score = 0;
  else if (suspiciousPrice) score = 0;
  else if (stats.count90 < 3) score = Math.min(score, 49);
  else if (stats.count90 < 7) score = Math.min(score, 74);
  else if (stats.count90 < 14) score = Math.min(score, 89);
  if (stats.staleDays != null && stats.staleDays > 14) score = Math.min(score, 59);
  caps.forEach(max => { score = Math.min(score, max); });

  let status = 'NOT_QUALIFIED';
  if (!matched) status = 'UNMATCHED';
  else if (suspiciousPrice) status = 'SUSPICIOUS_PRICE';
  else if (stats.count90 < 3) status = 'INSUFFICIENT_HISTORY';
  else if (score >= 90) status = 'STRONG_DEAL';
  else if (score >= 75) status = 'GOOD_DEAL';
  else if (score >= EXPOSURE_SCORE) status = 'INTEREST';

  return {
    dealScore: score,
    verificationStatus: status,
    reasons,
    effectivePrice,
    priceVs30dAvg: avgDiscount,
    priceVs30dMedian: medianDiscount,
    priceVs90dLow: lowDelta,
    stats,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10]))
  };
}

/** Same invariant as the external_hotdeals_exposure_check constraint (minus is_primary). */
function isExposableRow(row) {
  const r = row || {};
  return !!r.matched_product_id
    && Number(r.match_confidence) >= MATCH_THRESHOLD
    && Number(r.deal_score) >= EXPOSURE_SCORE
    && VISIBLE_STATUSES.indexOf(r.verification_status) > -1;
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
  MATCH_THRESHOLD, HIGH_MATCH_CONFIDENCE, EXPOSURE_SCORE, VISIBLE_STATUSES,
  quantities, measurements, variants, accessories, flavors, jaccardTitle, matchScore, matchProduct,
  historyStats, priceContext, verifyDeal, isExposableRow, dedupeAcrossSources
};
