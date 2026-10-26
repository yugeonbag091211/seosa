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
  // "A 아니면 B?" · "A 대 B" · "A, B 중에 하나만" · "A하고 B 차이가 뭐야" 도 두 상품 비교다 (2026-10-26 홀드아웃).
  const m = /^(.{2,75}?)\s*(?:와|과|랑|하고|\s+vs\.?\s+|\s+versus\s+|\s+아니면\s+|\s+대\s+|\s+또는\s+|\s+혹은\s+|\s*,\s*)\s*(.{2,75}?)\??\s+(?:비교(?:해\s*(?:줘|주세요|줄래|볼래|봐|보자)|해|해볼래|해주세요|해줘)?|중(?:에서|에)?\s*(?:뭐|뭘|무엇|어떤|어느|가성비|가격|더|살|고를|좋|낫|추천|하나)|(?:가격|성능|가성비|장단점|기능)\s*(?:차이|비교)|차이(?:가|는|점)?\s*(?:알려|설명|있|뭐|어때|궁금)).*$/i.exec(s);
  if (!m) return null;
  let left = m[1].trim(), right = m[2].trim().replace(/\?+$/, '');
  // "그램16이랑" · "갤럭시탭이랑" — '이랑' 의 '이' 는 받침 있는 말 뒤에만 붙는다. 받침 없는 말 뒤의 '이' 는
  // 이름의 일부다("스페이스그레이랑" · "와이파이랑"). 그대로 두면 "그램16이" 로 검색됐다 (2026-10-26).
  if (/이$/.test(left) && left.length > 2 && hasBatchim(left[left.length - 2])) left = left.slice(0, -1);
  // 앞에 붙은 예산·용도는 검색어가 아니다 — "50만원 이하로 아이패드" · "학생용으로 그램". 예산은 핸들러가
  // 질문 전체에서 읽어 두 쪽 모두에 건다(api/ai.js 비교 경로).
  left = left
    .replace(/^(?:예산\s*(?:은|는)?\s*)?\d[\d,]*(?:\.\d+)?\s*(?:만|천|억)?\s*원?\s*(?:대|이하|이내|미만|까지|정도|안팎|선)?\s*(?:로|으로|에서|의|에|인|짜리)?\s+/, '')
    .replace(/^[가-힣]{1,8}용(?:으로|으로는|이면|인|에)?\s+/, '')
    .trim();
  // Korean object particles before "비교해줘" are grammar, not part of
  // the product family: "아이패드랑 갤럭시탭을 비교해줘".
  // Restrict to a final particle on Hangul words to preserve model codes.
  right = right.replace(/([가-힣]{2,})(?:을|를)$/, '$1');
  // "A랑 B 둘 중 가성비" 의 «둘» 은 비교 대상을 세는 말이다 — «아디다스 삼바 둘» 로 검색됐다 (2026-10-26).
  right = right.replace(/\s+(?:둘|두\s*(?:개|제품|상품|모델))(?:\s*다)?$/, '').trim();
  // Broad family aliases: the marketplace title may be Korean even when
  // the user asks for the family in English.
  if (/^ipad$/i.test(left)) left = '아이패드';
  if (/^ipad$/i.test(right)) right = '아이패드';
  if (/^galaxy\s*tab$/i.test(left)) left = '갤럭시탭';
  if (/^galaxy\s*tab$/i.test(right)) right = '갤럭시탭';
  // Common family names may be written without a numeric model anchor.
  const knownFamily = /^(?:아이패드|갤럭시\s*탭|갤럭시탭|ipad|galaxy\s*tab)$/i;
  // "버즈3 프로 블랙과 화이트" · "에어팟 맥스 실버랑 스페이스그레이" explicitly name two color
  // options of the same series, not the generic product "화이트".
  const COLOR_WORD = /(스페이스\s*그레이|블랙|검정|화이트|흰색|실버|그레이|네이비|블루|레드|핑크|그린|골드|퍼플|베이지|아이보리|브라운|오렌지|옐로우|민트|미드나이트|스타라이트)/;
  const onlyColor = new RegExp('^' + COLOR_WORD.source + '(?:\\s*(?:색|색상|컬러))?$');
  if (onlyColor.test(right) && COLOR_WORD.test(left)) {
    right = left.replace(COLOR_WORD, right.replace(/\s*(?:색|색상|컬러)$/, ''));
  }
  if (!left || !right || left === right || left.length > 75 || right.length > 75) return null;
  // Reject sentence fragments and meta-instructions: a particle in "검색 결과"
  // must never split an unrelated prompt into two shop searches.
  if (/[.!?。;:<>]/.test(left + right)) return null;
  const AIID = require('./_aiidentity');
  // 브랜드·계열 이름도 상품 지목이다 — "다이슨 V15랑 비스포크 제트" · "에어포스1이랑 아디다스 삼바" (2026-10-26).
  const named = term => AIID.productEvidence(term) > 0 || /[0-9]/.test(term) || knownFamily.test(term) || AIID.namesBrand(term);
  if (!named(left) || !named(right)) return null;
  // "노트북과 태블릿 차이 알려줘" · "무선 이어폰이랑 유선 이어폰 비교" 는 종류를 묻는 지식 질문이다 —
  // 각 종류의 가장 싼 판매 글 두 개의 가격 차이로 답하면 질문에 답하지 않은 것이다. 일반 경로로 보낸다.
  if (bareCategory(left, AIID) || bareCategory(right, AIID)) return null;
  return [left, right];
}

/* 종류명과 꾸밈말만으로 된 말인가 ("노트북" · "무선 이어폰" · "로봇청소기"). 모델·계열·브랜드가 있으면 아니다. */
const CATEGORY_MODIFIER = /^(?:무선|유선|블루투스|게이밍|게임용|노이즈캔슬링|일반|휴대용|소형|대형|미니|전기|로봇|스마트|가정용|업소용|접이식|오픈형|커널형|넥밴드|저가|고가|싼|비싼|좋은)$/;
function bareCategory(term, AIID) {
  const words = String(term || '').trim().split(/\s+/).filter(Boolean)
    .map(w => w.replace(/(?:은|는|이|가|을|를|와|과|랑|이랑)$/, m => (w.length - m.length >= 2 ? '' : m)));
  // 아이패드·갤럭시탭은 종류명 목록(_aiidentity CATEGORY_NOUNS)에도 있지만 상품 계열 이름이다.
  const kind = w => AIID.categoryNounOf(w) && !/^(?:아이패드|갤럭시탭)$/.test(w);
  return words.length > 0 && !/[0-9a-z]/i.test(term)
    && words.some(kind)
    && words.every(w => kind(w) || CATEGORY_MODIFIER.test(w));
}

/* 한글 음절·숫자의 받침 유무 — '이랑/랑' 같은 조사 꼴을 가린다. 숫자는 한국어로 읽은 소리로 본다(6=육). */
function hasBatchim(ch) {
  const c = String(ch || '');
  if (/^[0136780]$/.test(c)) return true;     // 영·일·삼·육·칠·팔 (0 은 «영»)
  if (/^[2459]$/.test(c)) return false;       // 이·사·오·구
  const code = c.charCodeAt(0) - 0xAC00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
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

/** The cheapest exact offer for one side. `accept` narrows the exact offers (budget gate in api/ai.js). */
function pickExact(raw, query, AIID, normalize, accept) {
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
  const exact = gate.items.filter(x => x._identity && x._identity.tier === AIID.TIER.EXACT
    && (typeof accept !== 'function' || accept(x)));
  exact.sort((a,b) => a.price - b.price);
  return exact[0] || null;
}

/** 조건 객체의 예산을 사람이 읽는 말로 ("50만원 이하" · "10만~20만원"). */
function budgetLabel(c) {
  const won = n => { const v = Math.round(n); return v % 10000 === 0 ? (v / 10000).toLocaleString('ko-KR') + '만원' : v.toLocaleString('ko-KR') + '원'; };
  const max = Math.round(Number(c && (c.budgetSaid || c.budgetMax)) || 0);
  const min = Math.round(Number(c && c.budgetMin) || 0);
  if (min && max) return won(min) + '~' + won(max);
  if (max) return won(max) + ' 이하';
  if (min) return won(min) + ' 이상';
  return '';
}

/**
 * opts.budgetLabel     — 비교에 건 예산 ("50만원 이하")
 * opts.missingByBudget — [bool,bool] 정확한 옵션은 있었지만 이번 말의 예산 안에는 없었다
 * opts.overBudget      — [bool,bool] 앞 대화에서 이어진 예산을 넘는다(고르기는 그대로, 사실만 밝힌다)
 */
function formatComparison(requested, offers, source, opts) {
  const o = opts || {};
  const won = n => Math.round(n).toLocaleString('ko-KR') + '원';
  const lines = [source === 'catalog'
    ? '앞에서 비교한 두 상품을 서사 카탈로그에서 다시 확인했어요. 아래 가격은 마지막 수집 시점의 기록이며 현재 결제가는 아닐 수 있어요.'
    : '두 상품을 각각 검색해 확인한 표시 가격을 비교했어요.'];
  offers.forEach((p,i) => {
    const name = requested[i];
    if (!p) {
      lines.push(o.missingByBudget && o.missingByBudget[i] && o.budgetLabel
        ? `${i+1}. 「${name}」: 예산(${o.budgetLabel}) 안에서 정확히 일치하는 판매 상품을 확인하지 못했어요.`
        : `${i+1}. 「${name}」: 정확히 일치하는 판매 상품과 가격을 확인하지 못했어요.`);
      return;
    }
    const over = o.overBudget && o.overBudget[i] && o.budgetLabel ? ` — 앞에서 말씀하신 예산(${o.budgetLabel})을 넘어요` : '';
    lines.push(`${i+1}. ${p.title} — ${won(p.price)} (${p.mall || '판매처 미확인'})${over}`);
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
module.exports = { parseComparison, isPairFollowup, pickExact, formatComparison, budgetLabel };
