'use strict';

/** Check that a topic change dropped the old budget and returned real priced candidates. */
function scopeDropPassed(result) {
  if (!result || !result.verify || result.verify.budgetDropped !== true) return false;
  const cards = Array.isArray(result.cards) ? result.cards : [];
  if (!cards.length) return false;
  return cards.every(card => {
    const price = Number(card && card.lprice);
    return Number.isFinite(price) && price > 0;
  });
}

function confirmedMerchantResult(result) {
  if (!result || result.status !== 200 || !result.verify ||
      result.verify.search !== 'found') return false;
  const cards = Array.isArray(result.cards) ? result.cards : [];
  return cards.length > 0 && cards.every(x => {
    const price = Number(x && x.lprice);
    return Number.isFinite(price) && price > 0;
  });
}
module.exports = { scopeDropPassed, confirmedMerchantResult };
