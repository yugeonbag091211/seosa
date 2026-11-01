'use strict';

/*
 * Previous-search versus stored-catalogue price continuity.
 *
 * Only compare a price saved in a server-issued, HMAC-verified recommendation
 * reference with a server-verified price for the SAME merchant/offer/option.
 * Never promote either observation to a live checkout price.
 *
 * This helper does not accept client-supplied price/history data.
 */

function priceConflict(previous, subject) {
  const seen = Number(previous && previous.searchPrice);
  const stored = Number(subject && subject.price);
  if (!Number.isSafeInteger(seen) || seen <= 0
      || !Number.isSafeInteger(stored) || stored <= 0 || seen === stored) return null;
  if (!previous || !subject || subject.isCanonicalGroup) return null;
  if (String(previous.productId || '') !== String(subject.productId || '')
      || String(previous.vendorItemId || '') !== String(subject.vendorItemId || '')
      || String(previous.mallId || previous.mall || '') !== String(subject.mallId || subject.mall || '')) return null;
  const checkedAt = typeof subject.checkedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(subject.checkedAt)
    ? subject.checkedAt : '';
  return { searchedPrice: seen, storedPrice: stored, checkedAt };
}

function conflictMessage(conflict, subjectTitle) {
  if (!conflict) return '';
  const title = String(subjectTitle || '상품').replace(/\s+/g, ' ').slice(0, 70);
  const won = n => Math.round(n).toLocaleString('en-US') + '원';
  const storedWhen = conflict.checkedAt ? ` (${conflict.checkedAt} 기록)` : ' (마지막 저장 기록)';
  return [
    `앞에서 추천했던 「${title}」의 가격이 서로 다르게 확인됐어요.`,
    `처음 검색 결과에서 표시했던 가격은 ${won(conflict.searchedPrice)}이고, 서사에 저장된 같은 판매처·옵션의 가격은 ${won(conflict.storedPrice)}${storedWhen}이에요.`,
    '두 가격은 확인한 시점이 다를 수 있어요. 어느 쪽이 지금 실제 결제 가격인지 다시 확인하지 못했기 때문에, 더 싼 가격으로 구매할 수 있다거나 지금 사는 게 유리하다고 단정하면 안 돼요.',
    '판매처에서 옵션과 실제 결제 가격을 확인하면 그 금액을 기준으로 서사의 가격 기록과 비교할 수 있어요.'
  ].join('\n\n');
}

module.exports = { priceConflict, conflictMessage };
