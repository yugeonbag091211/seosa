'use strict';
// AI v3.2 — deterministic, user-grounded utterance analysis.
//
// GPT plans the search, but some decisions must be grounded in what the user
// literally said, because a wrong call is costly and GPT was observed to get
// them wrong in the 2026-11-06 online-200 run:
//   * informational questions ("OLED와 LCD 차이가 있니?") must not search;
//   * "X 가격 비교해줘" about ONE product is a price lookup, not a 2-way compare;
//   * "N만원대" is a price band, "이내/아래/안에서/안으로" are ceilings;
//   * "그중/위에서" refers to the cards actually shown last turn;
//   * exclusions come from the user's words only — never product IDs.
// No network, DB or model dependency.

const clean = (x, n = 800) => String(x == null ? '' : x).normalize('NFKC').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const flat = x => clean(x, 200).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');

const UNIT = '(만\\s*원|만원|만|천\\s*원|천원|원)';
const NUM = '(\\d+(?:\\.\\d+)?)';
function won(n, unit) {
  const factor = /만/.test(unit || '') ? 10000 : /천/.test(unit || '') ? 1000 : 1;
  const v = Math.round(Number(n) * factor);
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}
// parseBudget("무선 헤드폰 중 11만원부터 15만원 제품") → { min:110000, max:150000 }
// parseBudget("7만원대") → { min:70000, max:79999, band:true }
// parseBudget("50만원 미만") → { max:500000, maxExclusive:true }
function parseBudget(text) {
  const s = clean(text).replace(/(\d),(?=\d{3})/g, '$1');
  const out = { min: null, max: null, band: false, maxExclusive: false };
  // 1) explicit ranges: "12~15만원", "11만원부터 15만원(까지)", "12만원에서 15만원"
  const range = [...s.matchAll(new RegExp(NUM + '\\s*' + UNIT + '?\\s*(?:~|∼|–|-|에서|부터)\\s*' + NUM + '\\s*' + UNIT, 'g'))];
  if (range.length) {
    const m = range[range.length - 1];
    const lo = won(m[1], m[2] || m[4]), hi = won(m[3], m[4]);
    if (lo != null && hi != null && lo <= hi && /만|천|원/.test(m[2] || m[4] || '')) {
      out.min = lo; out.max = hi; return out;
    }
  }
  // 2) band: "7만원대" = 70,000 – 79,999 (not "up to 70,000")
  const band = [...s.matchAll(/(\d{1,4})\s*만\s*원?\s*대(?!\s*(?:이하|미만|이상|초반|중반|후반))/g)];
  if (band.length) {
    const n = Number(band[band.length - 1][1]);
    // Korean round bands preserve the last *significant* place: '7만원대'
    // = 70–79k, but '30만원대' = 300–399k, not just 300–309k.
    // '15만원대' remains 150–159k; '100만원대' spans 1–1.99M.
    const trailingZeroes = (String(n).match(/0+$/) || [''])[0].length;
    const step = 10 ** trailingZeroes;
    out.min = n * 10000; out.max = (n + step) * 10000 - 1; out.band = true;
  }
  // 3) ceilings
  const ceil = [...s.matchAll(new RegExp(NUM + '\\s*' + UNIT + '\\s*(이하|미만|이내|아래|까지|안쪽|안에서|안으로|내외로|내로|밖에|넘지\\s*않|선에서|이하로)', 'g'))];
  const cap = [...s.matchAll(new RegExp('(?:최대|예산(?:은|이)?|상한(?:은|이)?)\\s*' + NUM + '\\s*' + UNIT, 'g'))];
  if (ceil.length) {
    const m = ceil[ceil.length - 1];
    out.max = won(m[1], m[2]); out.band = false;
    out.maxExclusive = m[3] === '미만';
  } else if (cap.length && out.max == null) {
    const m = cap[cap.length - 1];
    out.max = won(m[1], m[2]);
  }
  // 4) floors
  const floor = [...s.matchAll(new RegExp(NUM + '\\s*' + UNIT + '\\s*(?:이상|부터|초과|넘는|넘게)', 'g'))];
  if (floor.length && !out.band) {
    const m = floor[floor.length - 1];
    out.min = won(m[1], m[2]);
  }
  // v3.4 (V078): keep the old output (min dropped) but report the contradiction
  // so the engine can ask instead of searching with half of the condition.
  if (out.min != null && out.max != null && out.min > out.max) { out.conflict = { min: out.min, max: out.max }; out.min = null; }
  return out;
}

// Shopping verbs, except in a thank-you clause ("추천해줘서 고마워").
const PURCHASE_IMPERATIVE = /(?:추천|찾아|골라|고르|보여|검색|알아봐|비교)(?!\s*(?:해\s*)?(?:줘|주어|주셔)서)|구매|구입|사고\s*싶|살\s*(?:까|만한|건데|거야|게)|사려(?:고|는)|사\s*줘|어디서\s*사|최저가|가격\s*(?:비교|알려|얼마)|얼마(?!나)|주문|팔아|파는\s*곳|뭐가\s*(?:좋아|좋을|낫|괜찮)|뭘\s*(?:살|고를)|어떤\s*(?:게|걸|것|제품)\s*(?:좋|나아|괜찮)|좋을까|(?:남겨|빼|제외해|골라)\s*줘|하나만|한\s*개만/;
// Questions about meaning, mechanism, difference or care — not purchases.
const INFORMATIONAL = /(?:원리|작동\s*(?:방식|원리)|어떻게\s*(?:작동|동작|측정|재|되|하는|다른)|무슨\s*(?:뜻|의미)|뜻이|의미(?:가|는)|(?:이|가)\s*뭐(?:야|예요|에요|니|지|임)|란\s*(?:뭐|무엇)|이란|무엇인가|차이(?:가|는|를|점|이)?\s*(?:좀\s*)?(?:있|뭐|뭔|무엇|알려|설명|어떻)|차이점|왜\s|왜$|설명해|방법(?:이|은|을)?\s*(?:뭐|알려)|하는\s*법|보관(?:하는|법)|얼마나\s*(?:자주|오래)|교체\s*(?:주기|시기)|수명(?:은|이)\s*(?:왜|얼마))/;
const THANKS = /(?:고마워|고맙|감사(?:합니다|해요|해)?|다음에\s*(?:올|다시|물어|봐)|잘\s*있어|안녕히)/;
// "그중", "위에서", "방금 보여준 것 중" → the cards displayed last turn.
const REFERS_DISPLAYED = /(?:그\s*중|이\s*중|그것들?\s*중|위(?:에서|의)\s*|위\s*(?:상품|제품|목록|후보)|앞(?:에서|서)\s*(?:보여|추천|말한|찾은)|방금\s*(?:보여|추천|찾은)|아까\s*(?:보여|추천|찾은)|(?:보여|추천|찾아)\s*준\s*(?:것|거|상품|제품|후보)\s*중|추천한\s*(?:것|거|상품|제품)\s*중)/;
const WANTS_SINGLE = /(?:하나만|하나\s*(?:만\s*)?(?:추천|골라|선택|남겨|정해|뽑아)|하나를\s*(?:골라|추천|선택)|한\s*(?:개|제품|가지|모델)\s*만?\s*(?:추천|골라|선택|남겨)?|딱\s*하나|최종\s*(?:추천\s*)?하나|1\s*개만|가장\s*(?:좋은|적절한|나은)\s*(?:거|것|제품)?\s*하나)/;
const PRICE_LOOKUP = /(?:가격\s*비교|최저가|어디(?:가|서)\s*(?:제일\s*)?(?:싸|저렴)|판매처\s*(?:비교|별)|가격\s*(?:알려|얼마))/;
const TWO_SUBJECTS = /(?:\bvs\.?\b|이랑|랑\s|하고\s|와\s|과\s|와의|과의|대비|중\s*(?:뭐가|어느))/i;

function analyzeUtterance(text) {
  const t = clean(text);
  const budget = parseBudget(t);
  const hasBudget = budget.max != null || budget.min != null;
  const purchase = PURCHASE_IMPERATIVE.test(t);
  const informational = INFORMATIONAL.test(t) && !purchase && !hasBudget;
  const thanks = THANKS.test(t) && !purchase && !hasBudget;
  return {
    budget, hasBudget, purchase, informational, thanks,
    referencesDisplayed: REFERS_DISPLAYED.test(t),
    wantsSingle: WANTS_SINGLE.test(t),
    priceLookup: PRICE_LOOKUP.test(t) && !TWO_SUBJECTS.test(t)
  };
}

// ── exclusions ────────────────────────────────────────────────────────
const GENERIC = new Set(['제품', '상품', '것', '거', '모델', '판매글', '글', '조건', '건', '종류', '물건', '본체', '판매', '옵션', '구성', '파는', '파는건']);
const PARTICLE = /(?:은|는|이|가|을|를|도|만|의|으로|로|이나|나|이랑|랑|과|와)$/;
const { brandOfWord, BRANDS } = require('./_ai-v32-brands');
const { isAccessoryWord } = require('./_ai-v32-listing');
const CATEGORY_NOUN = /^(?:pc|컴퓨터|스피커|헤드폰|헤드셋|이어폰|노트북|모니터|키보드|마우스|청소기|공기청정기|태블릿|스마트폰|휴대폰|시계|스마트워치|외장하드|기타)$/i;
const SYNONYMS = [
  ['게이밍', '게임용', 'gaming'], ['중고', '리퍼', '중고품'], ['로봇청소기', '로봇 청소기'],
  ['렌탈', '렌털', '대여'], ['번들', '세트', '콤보', 'combo']
];
function stripParticle(word) {
  let w = String(word || '').trim();
  for (let i = 0; i < 2 && w.length > 2 && PARTICLE.test(w); i++) w = w.replace(PARTICLE, '');
  return w;
}
const REFERENCE_WORD = /^(?:그중|그중에서|이중|위에서|앞에서|여기서|거기서|그거|이거|저거|그리고|그럼|근데|또)$/;
// Words the user excluded. A one-word noun phrase is excluded as a word
// ("게이밍 제품은 제외" → 게이밍, "할부원금 조건 제외" → 할부원금). A multi-word
// phrase is excluded only as the phrase ("헤드셋 마이크 말고" → "헤드셋 마이크"),
// because its head alone ("마이크") would wrongly drop "마이크 내장 헤드폰".
function userExclusions(text) {
  const t = clean(text);
  const out = [];
  const re = /((?:[가-힣a-z0-9+]{1,20}\s+){0,2}[가-힣a-z0-9+]{1,20})\s*(?:은|는|이|가|을|를)?\s*(?:제외|말고|빼고|빼\s*줘|빼주세요|빼라|아닌|아니고|없이|싫)/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const words = m[1].split(/\s+/).map(stripParticle).filter(Boolean)
      .filter(w => !/^\d/.test(w) && !/만원|이하|이상|미만|이내/.test(w) && !REFERENCE_WORD.test(w));
    while (words.length && GENERIC.has(words[words.length - 1])) words.pop();
    if (!words.length) continue;
    // "노트북 삼성 빼고": a brand right before the negator is the excluded object.
    const last = words[words.length - 1];
    if (brandOfWord(last)) { out.push(last); continue; }
    // "PC 스피커 RGB 제외": a product-type noun before the head only says what
    // the head belongs to — exclude the feature word itself. An accessory head
    // ("헤드셋 마이크", "모니터 스탠드") stays a phrase: excluding the bare word
    // would drop "마이크 내장" headphones; the listing parser rejects accessories.
    if (words.length >= 2 && CATEGORY_NOUN.test(words[words.length - 2]) && !isAccessoryWord(last)) {
      if (last.length >= 2) out.push(last);
      continue;
    }
    const phrase = words.length >= 2 ? words.slice(-2).join(' ') : words[0];
    if (phrase.replace(/\s/g, '').length >= 2 && !GENERIC.has(phrase)) out.push(phrase);
  }
  return [...new Set(out)].slice(0, 6);
}
// "렌탈 말고", "중고 제외" mention a word only to reject it.
function mentionedPositively(text, wordRe) {
  const t = clean(text);
  const g = new RegExp(wordRe.source, 'gi');
  let m;
  while ((m = g.exec(t)) !== null) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 14);
    // v3.4: a generic noun may sit between the word and the negation
    // ("게이밍 제품은 제외", "중고 상품은 빼고", "로지텍 것은 말고").
    if (!/^\s*(?:(?:제품|상품|모델|것|거|쪽|류|계열|브랜드|라인)\s*)?(?:은|는|이|가|을|를|도)?\s*(?:안\s*하|말고|제외|없이|빼|아닌|아니|싫|필요\s*없)/.test(after)) return true;
  }
  return false;
}
const LOOKS_LIKE_ID = /^[^\s:]{2,12}:[0-9a-z]{6,}$/i;
// Keep a GPT-proposed exclusion only if the user (now or earlier) said it.
function groundExclusions(proposed, utterance, prior = []) {
  const said = flat(utterance) + '|' + (prior || []).map(flat).join('|');
  return (Array.isArray(proposed) ? proposed : [])
    .map(x => clean(x, 55)).filter(Boolean)
    .filter(x => !LOOKS_LIKE_ID.test(x))
    .map(stripParticle)
    .filter(x => x.length >= 2 && !GENERIC.has(x) && said.includes(flat(x)));
}
function exclusionVariants(term) {
  const f = flat(term);
  const group = SYNONYMS.find(g => g.some(w => flat(w) === f));
  // v3.4 (V079): an excluded BRAND covers its company aliases — «로지텍은 빼고»
  // must also exclude a title that only says «Logitech».
  const brand = brandOfWord(term);
  const entry = brand ? BRANDS.find(e => e[0] === brand) : null;
  const aliases = entry ? entry[1].map(flat) : [];
  return [...new Set([...(group ? group.map(flat) : [f]), ...aliases])];
}
function excludedBy(title, exclusions) {
  const t = flat(title);
  return (exclusions || []).find(word => exclusionVariants(word).some(v => v && t.includes(v))) || null;
}
module.exports = { parseBudget, analyzeUtterance, userExclusions, groundExclusions, excludedBy,
  exclusionVariants, stripParticle, mentionedPositively, LOOKS_LIKE_ID };
