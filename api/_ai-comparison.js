'use strict';
/*
 * Explicit two-product comparisons. Only the user's own two named products
 * are split into independent server searches; do not treat a joint phrase as
 * one model identity. No client-supplied price or product is an input.
 */
function parseComparison(question) {
  const s = String(question || '').trim().slice(0, 240);
  // Keep this intentionally narrow. Ordinary recommendations and comparisons
  // between attributes must continue to use the regular concierge route.
  const m = /^(.{2,75}?)\s*(?:와|과|랑|하고|vs\.?|versus)\s+(.{2,75}?)\s+비교해\s*(?:줘|주세요|줄래|볼래)(?:[.!?？]+)?(?:\s+.*)?$/i.exec(s);
  if (!m) return null;
  let left = m[1].trim(), right = m[2].trim();
  // "버즈3 프로 블랙과 화이트" explicitly names two color options of
  // the same series, not the generic product "화이트".
  const color = /^(?:블랙|검정|화이트|흰색)$/;
  if (color.test(right) && /(블랙|검정|화이트|흰색)/.test(left)) {
    right = left.replace(/블랙|검정|화이트|흰색/, right);
  }
  if (!left || !right || left === right || left.length > 75 || right.length > 75) return null;
  // Reject sentence fragments and meta-instructions: a particle in "검색 결과"
  // must never split an unrelated prompt into two shop searches.
  if (/[.!?。;:<>]/.test(left + right)) return null;
  const AIID = require('./_aiidentity');
  const named = term => AIID.productEvidence(term) > 0 || /[A-Za-z]{2,}|[0-9]/.test(term);
  if (!named(left) || !named(right)) return null;
  return [left, right];
}

function pickExact(raw, query, AIID, normalize) {
  const candidates = (Array.isArray(raw) ? raw : [])
    .filter(x => x && x.productId && Number.isSafeInteger(Number(x.lprice)) && Number(x.lprice) > 0)
    .slice(0, 40).map(x => {
      const n = normalize(x);
      Object.defineProperty(n, '_compareRaw', { value: x });
      return n;
    });
  if (!candidates.length) return null;
  const contract = AIID.buildContract({
    query, userText: query, titles: candidates.map(x => x.title)
  });
  const gate = AIID.partition(candidates, contract);
  if (gate.state !== 'EXACT') return null;
  const exact = gate.items.filter(x => x._identity && x._identity.tier === AIID.TIER.EXACT);
  exact.sort((a,b) => a.price - b.price);
  return exact[0] || null;
}

function formatComparison(requested, offers) {
  const won = n => Math.round(n).toLocaleString('ko-KR') + '원';
  const lines = ['두 상품을 각각 검색해서 확인한 결과예요.'];
  offers.forEach((p,i) => {
    const name = requested[i];
    if (!p) { lines.push(`${i+1}. 「${name}」: 정확히 일치하는 판매 상품과 가격을 확인하지 못했어요.`); return; }
    lines.push(`${i+1}. ${p.title} — ${won(p.price)} (${p.mall || '판매처 미확인'})`);
  });
  if (offers[0] && offers[1]) {
    const difference = Math.abs(offers[0].price - offers[1].price);
    if (difference === 0) lines.push('두 상품의 확인된 표시 가격은 같아요.');
    else lines.push(`표시 가격 차이는 ${won(difference)}이고, ${offers[0].price < offers[1].price ? '첫 번째' : '두 번째'} 상품이 더 저렴해요.`);
    lines.push('상품명에 없는 실제 성능·기능의 우열은 추측하지 않을게요. 용도와 사양을 추가로 확인해야 정확한 가성비를 판단할 수 있어요.');
  } else {
    lines.push('둘 다 확인되지 않아 가격 차이나 가성비 우열을 단정할 수 없어요.');
  }
  lines.push('위 금액은 검색 시점의 표시 가격이며 실제 결제 금액은 판매처에서 옵션을 선택해 확인해야 해요.');
  return lines.join('\n\n');
}
module.exports = { parseComparison, pickExact, formatComparison };
