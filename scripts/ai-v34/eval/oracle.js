'use strict';
// AI v3.4 independent judge (oracle). Imports NOTHING from api/ and nothing
// from the v2 evaluator: card requirements come only from the frozen spec in
// questions-v34.js, and every card is re-checked against the frozen corpus
// (existence, price, freshness). A card is never trusted because the engine
// labelled it, and HTTP 200 / card count / model self-assessment never PASS.
const norm = s => String(s == null ? '' : s).normalize('NFKC').toLowerCase();
const flat = s => norm(s).replace(/[^0-9a-z가-힣]/g, '');

// Accessory / part words (authored for this oracle). A title is treated as a
// part when such a word appears and is not in an inclusion context.
const PART_WORDS = ['케이스', '커버', '필름', '강화유리', '보호필름', '거치대', '스탠드', '파우치', '스트랩', '밴드교체', '충전기', '충전독',
  '충전케이블', '케이블', '젠더', '어댑터', '이어팁', '이어패드', '이어캡', '키캡', '키스킨', '팜레스트', '필터', '먼지봉투', '브러시', '브러쉬',
  '노즐', '물걸레패드', '걸레패드', '리필', '부품', '교체용', '호환용', '호환품', '소모품', '액세서리', '악세사리', '리모컨', '마우스패드',
  '펜슬', '펜촉', '유심', '배터리팩', '보호캡', '실리콘', '스킨', '키링', '도킹', '그립테이프', '미끄럼방지테이프', '마우스피트',
  '마우스스케이트', '교체헤드'];
const INCLUDED = /(포함|증정|사은품|동봉|구성품|세트구성|패키지|번들)/;
function partWord(title) {
  const t = flat(String(title).split(/\/디지털기기|\/생활\/가전|\/pc\/주변기기/i)[0]);
  for (const w of PART_WORDS) {
    const at = t.indexOf(w);
    if (at < 0) continue;
    const around = t.slice(Math.max(0, at - 12), at + w.length + 16);
    if (INCLUDED.test(around)) continue;
    // "충전케이블 포함 무선 이어폰" handled above; "케이스형"/"케이스 내장" is a feature
    if (/^(?:형|내장|일체형)/.test(t.slice(at + w.length, at + w.length + 3))) continue;
    // "무선충전기능", "충전기능" style feature words
    if (w === '충전기' && /^능/.test(t.slice(at + w.length))) continue;
    return w;
  }
  return null;
}
const USED_RE = /(중고|리퍼|refurb|전시\s*(?:품|상품)|반품|(?:특\s*s|s|a\+?|b)\s*급|개봉\s*(?:된\s*)?(?:제품|상품)|used|renewed)/i;

// Seller category tails ("…/디지털기기/헤드폰") are not product words.
const sold = title => String(title == null ? '' : title).split(/\/디지털기기|\/생활\/?가전|\/pc\/주변기기|\/가전디지털/i)[0];
// "ENC 노이즈캔슬링" is call-noise reduction, not ANC.
const withoutEnc = f => f.replace(/(?:enc|cvc|통화)노이즈캔슬링/g, 'enc');
// Short model codes ("t7", "g304", "v12", "m4") must not be glued to a
// preceding letter/digit ("tt70w" — a lamp — is not T7) nor followed by a
// digit ("t70"). A trailing letter is allowed ("V15ORIGIN"); category groups
// keep "T9C" tennis shoes out. Short Latin words ("lg", "jbl", "hp") stand alone.
const SHORT_CODE = /^([a-z]{1,3})(\d{1,4})([a-z]?)$/;
const SHORT_LATIN = /^[a-z]{1,4}$/;
function hasWord(word, f, n) {
  const w = flat(word);
  if (!w) return false;
  const m = SHORT_CODE.exec(w);
  if (m) return new RegExp('(?<![a-z0-9])' + m[1] + '[\\s-]?' + m[2] + (m[3] ? '[\\s-]?' + m[3] : '') + '(?![0-9])', 'i').test(n);
  if (SHORT_LATIN.test(w)) return new RegExp('(?<![a-z])' + w + '(?![a-z])', 'i').test(n);
  return f.includes(w);
}
// Does a title/price satisfy one spec? Returns the list of violated rules.
function specErrors(spec, title, price) {
  const errs = [];
  const f = withoutEnc(flat(sold(title))), n = norm(sold(title));
  for (const group of spec.all || []) {
    if (!group.some(word => hasWord(word, f, n))) errs.push('missing:' + flat(group[0]));
  }
  for (const re of spec.allRe || []) if (!new RegExp(re, 'i').test(n)) errs.push('missing_re:' + re.slice(0, 24));
  for (const word of spec.not || []) if (hasWord(word, f, n)) errs.push('prohibited:' + flat(word));
  for (const re of spec.notRe || []) if (new RegExp(re, 'i').test(n)) errs.push('prohibited_re:' + re.slice(0, 24));
  const p = Number(price);
  if (!(p > 0)) errs.push('no_price');
  if (spec.min != null && p < spec.min) errs.push('below_min');
  if (spec.max != null && (spec.maxExclusive ? p >= spec.max : p > spec.max)) errs.push('over_budget');
  if (spec.floor != null && p < spec.floor) errs.push('below_device_floor');
  const used = spec.used || 'exclude';
  if (used === 'exclude' && USED_RE.test(n)) errs.push('used_not_requested');
  if (used === 'only' && !USED_RE.test(n)) errs.push('not_used');
  const part = partWord(title);
  if (part) errs.push('accessory:' + part);
  if (NON_GOODS.some(w => f.includes(w))) errs.push('non_goods');
  return errs;
}
// Catalog rows that are services/experiences, never goods.
const NON_GOODS = ['투어', '체험', '촬영지', '입장권', '이용권', '티켓'];
function isFresh(collectedAt, asOfMs, maxAgeDays) {
  const t = Date.parse(collectedAt || '');
  if (!Number.isFinite(t)) return false;
  return (asOfMs - t) / 86400000 <= maxAgeDays;
}
// Corpus-level eligibility (used for gold sets): spec + freshness.
function eligibleRow(spec, row, asOfMs, maxAgeDays) {
  return specErrors(spec, row.title, row.lprice).length === 0 && isFresh(row.collected_at, asOfMs, maxAgeDays);
}
// Card-level checks against the corpus (no trust in card fields).
function cardErrors(card, spec, corpus, ctx) {
  const errs = [];
  const id = String(card && card.productId || '');
  const row = corpus.get(id);
  if (!row) return ['card_not_in_corpus'];
  if (Number(card.price) !== Number(row.lprice)) errs.push('price_mismatch');
  if (!/^https?:\/\//i.test(String(card.link || ''))) errs.push('invalid_link');
  if (!isFresh(row.collected_at, ctx.asOfMs, ctx.maxAgeDays)) errs.push('stale_price_shown');
  // Judge the SOLD title as stored in the corpus (a card cannot rename it).
  for (const e of specErrors(spec, row.title, row.lprice)) errs.push(e);
  return errs;
}
const OUTAGE_TEXT = /(실패|장애|일시적|잠시\s*후|확인하지\s*못|조회할\s*수\s*없|불가능|unavailable)/;
const STALE_TEXT = /(가격[^.]{0,30}(?:확인|오래)|최근[^.]{0,20}가격|오래된\s*가격)/;
const ABSENCE_TEXT = /(후보가\s*없어요|상품이\s*없어요|찾지\s*못했|맞는\s*상품이\s*없)/;

// Judge one turn. gold: { count } for AUTO turns, { sides:[{count},{count}] } for COMPARE.
function judgeTurn({ turn, result, previous, gold, corpus, ctx }) {
  const spec = turn.spec || {};
  const cards = Array.isArray(result && result.cards) ? result.cards : [];
  const status = result && result.status;
  const answer = String(result && result.answer || '');
  const causes = [];
  let expect = turn.expect;
  if (expect === 'AUTO') expect = gold && gold.count > 0 ? 'FIND' : 'NO_RESULT';
  if (expect === 'COMPARE') expect = gold && gold.sides && gold.sides.every(s => s.count > 0) ? 'FIND_COMPARE' : 'NO_RESULT';
  if (expect === 'DYNAMIC') {
    const prevCards = Array.isArray(previous && previous.cards) ? previous.cards : [];
    expect = prevCards.some(c => cardErrors(c, spec, corpus, ctx).length === 0) ? 'FIND' : 'NO_RESULT';
  }
  const out = (verdict, outcome, extra = {}) => ({ verdict, outcome, expect, causes, ...extra });
  // Outage / stale rubrics (fault injection)
  if (expect === 'OUTAGE') {
    if (status === 503) return out('PASS', 'HONEST_OUTAGE');
    if (status !== 200) { causes.push('http_' + status); return out('FAIL', 'HTTP_FAILURE'); }
    const checks = cards.map(c => cardErrors(c, spec, corpus, ctx));
    if (cards.length) {
      checks.forEach((e, i) => e.forEach(x => causes.push('card' + (i + 1) + ':' + x)));
      return causes.length ? out('FAIL', 'WRONG_CARDS', { cardChecks: checks }) : out('PASS', 'DEGRADED_VALID_CARDS', { cardChecks: checks });
    }
    if (OUTAGE_TEXT.test(answer)) return out('PASS', 'HONEST_OUTAGE_TEXT');
    causes.push('absence_or_silence_during_outage');
    return out('FAIL', 'OUTAGE_REPORTED_AS_ABSENCE');
  }
  if (status !== 200) { causes.push('http_' + status); return out('FAIL', 'HTTP_FAILURE'); }
  if (cards.length > 4) causes.push('too_many_cards');
  if (spec.single && cards.length > 1) causes.push('more_than_one_for_single_pick');
  if (spec.amongPrevious) {
    const shown = new Set((previous && previous.cards || []).map(c => c.productId));
    if (cards.some(c => !shown.has(c.productId))) causes.push('not_among_previously_shown');
  }
  if (expect === 'STALE_ONLY') {
    const checks = cards.map(c => cardErrors(c, spec, corpus, ctx));
    checks.forEach((e, i) => e.forEach(x => causes.push('card' + (i + 1) + ':' + x)));
    if (cards.length) return causes.length ? out('FAIL', 'WRONG_OR_STALE_CARDS', { cardChecks: checks }) : out('PASS', 'FRESH_ALTERNATIVE', { cardChecks: checks });
    if (STALE_TEXT.test(answer)) return out('PASS', 'HONEST_STALE_PRICE');
    causes.push(ABSENCE_TEXT.test(answer) ? 'stale_reported_as_absence' : 'stale_not_explained');
    return out('FAIL', 'STALE_REPORTED_AS_ABSENCE');
  }
  if (expect === 'FIND_COMPARE') {
    const sides = spec.sides || [];
    const fits = cards.map(c => sides.map(s => cardErrors(c, s, corpus, ctx)));
    if (cards.length !== 2) causes.push('comparison_not_two_cards');
    const aOk = fits.findIndex(f => f[0].length === 0);
    const bOk = fits.findIndex((f, i) => i !== aOk && f[1].length === 0);
    if (aOk < 0) causes.push('side_a_missing_or_wrong');
    if (bOk < 0) causes.push('side_b_missing_or_wrong');
    return causes.length ? out('FAIL', cards.length ? 'WRONG_COMPARISON' : 'MISSED_AVAILABLE', { cardChecks: fits })
      : out('PASS', 'CORRECT_COMPARISON', { cardChecks: fits });
  }
  // A comparison whose side does not exist: any shown card must at least be
  // one of the two named products (it cannot be a third product).
  const checks = cards.map(c => {
    if (!spec.sides) return cardErrors(c, spec, corpus, ctx);
    const perSide = spec.sides.map(s => cardErrors(c, s, corpus, ctx));
    return perSide.some(e => e.length === 0) ? [] : perSide.reduce((a, b) => (a.length <= b.length ? a : b));
  });
  checks.forEach((e, i) => e.forEach(x => causes.push('card' + (i + 1) + ':' + x)));
  if (!cards.length) {
    if (expect === 'FIND') { causes.push('MISSED_AVAILABLE'); return out('FAIL', 'MISSED_AVAILABLE'); }
    if (causes.length) return out('FAIL', 'CONSTRAINT_ERROR');
    return out('UNVERIFIED', 'CORRECT_NO_RESULT');
  }
  if (causes.length) return out('FAIL', checks.some(c => c.length) ? 'WRONG_CARDS' : 'CONSTRAINT_ERROR', { cardChecks: checks });
  if (expect === 'NO_RESULT') return out('UNVERIFIED', 'CARDS_CONTRADICT_GOLD', { cardChecks: checks });
  return out('PASS', 'CORRECT_CARDS', { cardChecks: checks });
}
function combine(verdicts) {
  if (verdicts.includes('FAIL')) return 'FAIL';
  if (verdicts.includes('NEEDS_REVIEW')) return 'NEEDS_REVIEW';
  if (verdicts.includes('UNVERIFIED')) return 'UNVERIFIED';
  return 'PASS';
}
module.exports = { judgeTurn, specErrors, eligibleRow, cardErrors, isFresh, partWord, combine, flat, norm };
