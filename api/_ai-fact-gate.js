'use strict';

/**
 * Last-mile shopping facts gate (independent of the model).
 *
 * The shopping pipeline already ranks, verifies and grounds model output.
 * This gate is intentionally narrower: it checks the *emitted* cards against
 * server-owned cards + currently eligible ranked items one last time. It can
 * never make an untrusted offer trusted or turn a model claim into a fact.
 *
 * A failed gate fails closed for the *whole recommendation* rather than
 * silently showing fewer cards with a text referring to the removed ones.
 * It must not expose the rejected recommendation through topRecommendation
 * metadata or the signed next-turn product reference.
 *
 * Neither this gate nor its tests perform external API or database calls.
 */
const FAIL_TEXT = '확인된 상품 정보와 추천 조건이 일치하지 않아 해당 추천을 표시하지 않았어요. 조건을 다시 확인한 뒤 검색해 주세요.';
const HISTORY_TEXT = '이 상품·옵션의 검증된 가격 이력 자료가 부족해 가격이 내려갔는지 또는 최저가인지 판단할 수 없어요. 확인되지 않은 가격 흐름은 추측하지 않겠습니다.';

function id(x) { return String(x == null ? '' : x).trim(); }
function money(x) {
  const n = Number(x);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
function key(x) {
  return [id(x && x.productId), id(x && x.vendorItemId), id(x && x.mall)].join('\u0001');
}
function isSameOffer(a, b) {
  if (!a || !b || !id(a.productId) || !id(b.productId)) return false;
  if (id(a.productId) !== id(b.productId)) return false;
  // The vendor option must match when either side supplies it.
  if (id(a.vendorItemId) !== id(b.vendorItemId)) return false;
  // A seller-specific offer must not be substituted with another seller's price.
  if (a.mall && b.mall && id(a.mall) !== id(b.mall)) return false;
  return true;
}
function price(x) { return money(x && (x.lprice ?? x.price)); }
function unsafeHistoryClaim(text) {
  // Match affirmative recorded trends, not statements disclosing uncertainty.
  const lines = String(text || '').split(/[\n.!?。]+/);
  return lines.some(s => {
    if (/(?:없|부족|못|알 수 없|불확실|확인되지 않|단정할 수 없|모르|추측하지 않)/.test(s)) return false;
    return /(?:역대|최근|30일|7일|지난달|어제|전날).{0,25}(?:최저|하락|상승|평균|기록|변동)|(?:최저|하락|상승|평균).{0,22}(?:기록|확인됐|관측됐)/.test(s);
  });
}
function stripRecommendationMetadata(p) {
  delete p.topProductId;
  delete p.topRecommendation;
  delete p.topRecommendationRef;
  delete p.reusePreviousCard;
  delete p.recommendationChange;
}
function applyFactGate(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, failures: [] };
  }
  const out = { ...payload };
  const failures = [];
  const offered = Array.isArray(out.items) ? out.items : [];
  const trusted = Array.isArray(options.trustedCards) ? options.trustedCards : [];
  const eligible = Array.isArray(options.eligibleItems) ? options.eligibleItems : [];
  const hardBudget = !!options.enforceBudget && money(options.maxPrice);
  const minBudget = !!options.enforceBudget && money(options.minPrice);
  const excluded = Array.isArray(options.excludedBrands)
    ? options.excludedBrands.map(x => id(x).toLowerCase()).filter(Boolean) : [];

  for (const card of offered) {
    const authoritative = trusted.find(t => isSameOffer(card, t));
    // Non-Coupang cards intentionally omit internal vendorItemId. Permit
    // only a unique merchant/product/price match to a verified ranked row.
    const matches = eligible.filter(it => {
      if (isSameOffer(card, it)) return true;
      if (!card || !it || !id(card.productId) || id(card.productId) !== id(it.productId)) return false;
      const mall = id(card.mall), ownerMall = id(it.mallId || it.mall);
      if (!mall || mall.toLowerCase() !== ownerMall.toLowerCase()) return false;
      if (card.isCoupang || /쿠팡|coupang/i.test(mall) || id(card.vendorItemId)) return false;
      return price(card) > 0 && price(card) === price(it);
    });
    const ranked = matches.length === 1 ? matches[0] : null;
    if (!authoritative || !ranked) {
      failures.push('UNKNOWN_PRODUCT_ID');
      continue;
    }
    if (!price(card) || price(card) !== price(authoritative)
      || (money(card.displayPrice) && money(authoritative.displayPrice)
        && money(card.displayPrice) !== money(authoritative.displayPrice))) {
      failures.push('PRICE_MISMATCH');
    }
    if (hardBudget && price(card) > hardBudget) failures.push('BUDGET_VIOLATION');
    if (minBudget && price(card) < minBudget) failures.push('BUDGET_VIOLATION');
    if (options.avoidGaming && /(?:게임\s*전용|게이밍|gaming|e-?sports)/i.test(id(card.title))) {
      failures.push('EXCLUDED_BRAND_VIOLATION');
    }
    const title = id(card.title).toLowerCase();
    if (excluded.some(b => title.startsWith(b + ' ') || title === b)) {
      failures.push('EXCLUDED_BRAND_VIOLATION');
    }
    if (ranked._identity && options.excludedTier != null
      && ranked._identity.tier >= options.excludedTier) {
      failures.push('EXCLUDED_BRAND_VIOLATION');
    }
    // Even a correctly priced card is invalid if model-facing claim arrays
    // cite a different product, or claim a different verified price.
    if (Array.isArray(card.evidence)) for (const ev of card.evidence) {
      if (ev && ev.product_id && id(ev.product_id) !== id(card.productId)) {
        failures.push('CROSS_PRODUCT_EVIDENCE');
      }
      if (ev && ev.field === 'price' && money(ev.value) !== price(authoritative)) {
        failures.push('PRICE_MISMATCH');
      }
    }
  }

  if (offered.length && !failures.length) {
    const top = out.topRecommendation;
    if (top && (top.productId || top.lprice || top.price)) {
      // A highlighted recommendation is metadata, not an additional offer.
      // Don't persist unrelated or stale products across follow-up turns.
      const selected = offered.find(c => isSameOffer(c, top));
      if (!selected || (price(top) && price(top) !== price(selected))) {
        failures.push('CROSS_PRODUCT_EVIDENCE');
      }
    }
    if (out.topProductId && !offered.some(c => id(c.productId) === id(out.topProductId))) {
      // A follow-up can intentionally show a subset; remove the stale top
      // metadata rather than blocking otherwise accurate cards.
      stripRecommendationMetadata(out);
    }
  }

  if (options.historyQuestion && !options.historyVerified && unsafeHistoryClaim(out.text)) {
    failures.push('UNSOURCED_PRICE_HISTORY');
  }

  const reasons = [...new Set(failures)];
  if (reasons.some(r => r !== 'UNSOURCED_PRICE_HISTORY')) {
    out.text = FAIL_TEXT;
    out.items = [];
    stripRecommendationMetadata(out);
    out.degraded = true;
  } else if (reasons.includes('UNSOURCED_PRICE_HISTORY')) {
    out.text = HISTORY_TEXT;
    stripRecommendationMetadata(out);
    out.degraded = true;
  }
  return { payload: out, failures: reasons };
}
module.exports = { applyFactGate, isSameOffer, unsafeHistoryClaim, FAIL_TEXT, HISTORY_TEXT };
