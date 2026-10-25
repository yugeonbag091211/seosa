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
  // Natural shopping comparison forms. The right-hand description ends
  // before the comparison instruction; never search for the entire sentence.
  const m = /^(.{2,75}?)\s*(?:와|과|랑|하고|\s+vs\.?\s+|\s+versus\s+)\s*(.{2,75}?)\s+(?:비교(?:해\s*(?:줘|주세요|줄래|볼래|봐|보자)|해|해볼래|해주세요|해줘)?|중(?:에서|에)?\s*(?:뭐|뭘|무엇|어떤|어느|가성비|가격|더|살|고를|좋|낫|추천)|(?:가격|성능|가성비|장단점|기능)\s*(?:차이|비교)|차이\s*(?:알려|설명|있|뭐)).*$/i.exec(s);
  if (!m) return null;
  let left = m[1].trim(), right = m[2].trim();
  // Korean object particles before "비교해줘" are grammar, not part of
  // the product family: "아이패드랑 갤럭시탭을 비교해줘".
  // Restrict to a final particle on Hangul words to preserve model codes.
  right = right.replace(/([가-힣]{2,})(?:을|를)$/, '$1');
  // Broad family aliases: the marketplace title may be Korean even when
  // the user asks for the family in English.
  if (/^ipad$/i.test(left)) left = '아이패드';
  if (/^ipad$/i.test(right)) right = '아이패드';
  if (/^galaxy\s*tab$/i.test(left)) left = '갤럭시탭';
  if (/^galaxy\s*tab$/i.test(right)) right = '갤럭시탭';
  // Common family names may be written without a numeric model anchor.
  const knownFamily = /^(?:아이패드|갤럭시\s*탭|갤럭시탭|ipad|galaxy\s*tab)$/i;
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
  const named = term => AIID.productEvidence(term) > 0 || /[0-9]/.test(term) || knownFamily.test(term);
  if (!named(left) || !named(right)) return null;
  return [left, right];
}


/**
 * Contextual references to a pair are resolved ONLY with a valid signed
 * conversation state. A bare "그거" is singular/ambiguous and must not
 * silently pick one side.
 */
function isPairFollowup(question) {
  const q = String(question || '').trim().slice(0, 240);
  if (!q || q.length > 180) return false;
  return /(?:둘\s*중|두\s*(?:제품|상품|모델)|이\s*둘|그\s*둘|둘\s*다|둘\s*의|둘\s*을|둘\s*이|각각|앞(?:에서)?\s*비교한|아까\s*비교한|방금\s*비교한|비교했던|그\s*중)/.test(q);
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

function formatComparison(requested, offers, source) {
  const won = n => Math.round(n).toLocaleString('ko-KR') + '원';
  const lines = [source === 'catalog'
    ? '앞에서 비교한 두 상품을 서사 카탈로그에서 다시 확인했어요. 아래 가격은 마지막 수집 시점의 기록이며 현재 결제가는 아닐 수 있어요.'
    : '두 상품을 각각 검색해 확인한 표시 가격을 비교했어요.'];
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
    lines.push('비교 대상 중 하나 이상을 확인하지 못해서 가격 차이나 가성비 우열을 단정할 수 없어요.');
  }
  lines.push('실제 결제 금액과 옵션·배송 조건은 판매처에서 다시 확인해야 해요.');
  return lines.join('\n\n');
}
module.exports = { parseComparison, isPairFollowup, pickExact, formatComparison };
