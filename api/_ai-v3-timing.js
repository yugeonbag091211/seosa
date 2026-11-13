'use strict';

const { dealOf } = require('./_deal');
const { kstToday } = require('./_price');

// UNKNOWN is intentionally omitted: insufficient, stale or suspect evidence
// cannot support a recommendation about when to purchase.
function assessTiming(product, stat, today = kstToday(new Date())) {
  const price = Number(product && (product.price ?? product.lprice));
  if (!stat || !Number.isFinite(price) || price <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(stat.lastDate || '') || stat.lastDate > today) return null;
  const deal = dealOf(stat, price, today);
  const mapping = { BUY:'buy_now', GOOD_BUY:'good_deal', NORMAL:'fair', WATCH:'wait', WAIT:'wait', DONT_BUY:'overpriced' };
  const verdict = mapping[deal.verdict];
  if (!verdict || !Number.isFinite(deal.score)) return null;
  const messages = {
    buy_now:'지금 구매하기 좋은 편이에요.',
    good_deal:'비교적 좋은 가격이에요.',
    fair:'보통 수준의 가격이에요.',
    wait:'조금 더 지켜볼 만해요.',
    overpriced:'높은 편이라 가격을 더 지켜보는 게 좋아요.'
  };
  const reason = '확인된 ' + Number(stat.count) + '일의 가격 기록을 기준으로 ' + messages[verdict];
  return { verdict, reason, dealScore:Math.max(0, Math.min(100, Math.round(deal.score))),
    caution: deal.cautions && deal.cautions.length ? deal.cautions[0] : '' };
}
function timingMessage(assessment) {
  if (!assessment || !assessment.reason) return '';
  return assessment.reason + (assessment.caution ? ' ' + assessment.caution.replace(/[.\s]+$/, '') + '.' : '');
}
module.exports = { assessTiming, timingMessage };
