'use strict';
/*
 * 100문항 판정 — 순수 함수 (scripts/test-ai-100-grader.js 가 고정한다).
 *
 *   PASS        전송 OK + 자동 검사 전부 통과 + 사람이 볼 필요가 없는 문항
 *   FAIL        hard 위반이 하나라도 있다 (HTTP 200 이어도)
 *   UNVERIFIED  hard 위반은 없지만 soft 불일치가 있거나, 답의 옳고 그름을 사람이 봐야 하는 문항,
 *               또는 seed(후속 질문의 앞 턴)가 실패해 후속을 평가할 수 없는 경우
 *
 * HTTP 200 은 판정 근거가 아니다 — 전송 성공일 뿐이다.
 */
const { TYPES, BRANDS, CATEGORY_LABELS } = require('./cases');

const USED = /중고|리퍼|리퍼비시|전시\s*(?:품|상품)|반품\s*(?:제품|상품|회수)|개봉\s*(?:된\s*)?(?:제품|상품)|\b(?:used|refurbished|renewed|open[\s-]?box)\b|(?:^|[^A-Za-z])(?:S|A\+?|B)\s*급(?!\s*(?:에너지|효율))/i;
const MAX_PRICE_AGE_DAYS = 10;   // 사이트의 PRICE_MAX_DISPLAY_AGE_DAYS 기본값 (api/_ai-v34-freshness)

const num = v => (v == null || v === '' ? NaN : Number(v));

/** v3 cards · legacy items 를 한 모양으로. */
function cardsOf(data) {
  const d = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(d.cards) ? d.cards : Array.isArray(d.items) ? d.items : [];
  return list.filter(c => c && typeof c === 'object').map(c => ({
    id: String(c.productId || c.id || ''),
    title: String(c.title || ''),
    price: num(c.price != null ? c.price : c.lprice),
    mall: String(c.mallLabel || c.mall || ''),
    mallKey: String(c.mall || ''),
    url: String(c.url || c.link || c.productUrl || ''),
    observedAt: String(c.priceObservedAt || c.collectedAt || ''),
    freshness: c.priceFreshness || null,
    ageDays: c.priceAgeDays != null ? Number(c.priceAgeDays) : null
  }));
}

function answerOf(data) {
  const d = data && typeof data === 'object' ? data : {};
  return typeof d.answer === 'string' ? d.answer : typeof d.text === 'string' ? d.text : '';
}

/** 카드 한 장의 위반: { hard: [...], soft: [...] } */
function checkCard(card, expect, opts = {}) {
  const e = expect || {};
  const hard = [], soft = [];
  const t = card.title;
  if (!Number.isSafeInteger(card.price) || card.price <= 0) hard.push('invalid_price');
  if (card.url && !/^https:\/\//i.test(card.url)) hard.push('non_https_link');
  if (!card.url) hard.push('missing_link');
  if (e.type) {
    const ty = TYPES[e.type];
    if (ty && !ty.include.test(t)) hard.push('wrong_type:' + e.type);
    else if (ty && ty.exclude && ty.exclude.test(t)) hard.push('accessory_or_part_as:' + e.type);
  }
  if (Number.isSafeInteger(card.price)) {
    if (e.maxPrice != null && card.price > e.maxPrice) hard.push('over_budget');
    if (e.minPrice != null && card.price < e.minPrice) hard.push('under_range');
  }
  if (e.brand && BRANDS[e.brand] && !BRANDS[e.brand].test(t)) hard.push('wrong_brand:' + e.brand);
  if (e.notBrand && BRANDS[e.notBrand] && BRANDS[e.notBrand].test(t)) hard.push('excluded_brand:' + e.notBrand);
  (e.must || []).forEach((re, i) => { if (!re.test(t)) hard.push('model_mismatch:' + i); });
  (e.mustNot || []).forEach((re, i) => { if (re.test(t)) hard.push('forbidden_variant:' + i); });
  (e.soft || []).forEach((re, i) => { if (!re.test(t)) soft.push('soft_mismatch:' + i); });
  if (!e.allowUsed && USED.test(t)) hard.push('used_or_refurb');
  if (e.mall && card.mallKey !== e.mall && card.mall !== e.mall) hard.push('wrong_mall');
  if (e.sides && !e.sides.some(re => re.test(t))) hard.push('neither_compare_side');
  // 오래된 가격을 «현재가» 로 보이면 안 된다 — 엔진의 판정(freshness) 또는 관측 시각으로 본다.
  if (card.freshness === 'stale' || card.freshness === 'unknown') hard.push('stale_or_unknown_price');
  else if (card.observedAt && Number.isFinite(Date.parse(card.observedAt)) && Number.isFinite(opts.nowMs)) {
    const age = (opts.nowMs - Date.parse(card.observedAt)) / 86400000;
    if (age > MAX_PRICE_AGE_DAYS) hard.push('stale_price');
  }
  return { hard, soft };
}

/**
 * @param {object} c    cases.js 의 문항
 * @param {object} turn { status, version, gate, elapsedMs, error, data }  — 채점하는 턴
 * @param {object} ctx  { seed: 같은 꼴의 seed 턴 | null, requireV3, nowMs, review }
 */
function gradeCase(c, turn, ctx = {}) {
  const e = c.expect || {};
  const hard = [], soft = [], notes = [];
  const data = (turn && turn.data) || {};
  const cards = cardsOf(data);
  const answer = answerOf(data);
  const transportOk = !!turn && turn.status === 200 && !data.error && !!answer.trim();
  const out = (verdict, extra) => ({
    verdict, reasons: [...new Set(hard)], soft: [...new Set(soft)], notes,
    cardCount: cards.length, cardsChecked: cards.length, cardViolations: extra && extra.cardViolations || 0
  });

  if (ctx.seed !== undefined && e.seed) {
    const s = ctx.seed;
    const seedOk = s && s.status === 200 && !(s.data || {}).error && !!answerOf(s.data).trim();
    if (!seedOk) { notes.push('seed_failed'); return out('UNVERIFIED'); }
  }
  if (!turn || !transportOk) {
    hard.push(!turn ? 'not_run' : turn.status !== 200 ? 'http_' + (turn.status || 0) : data.error ? 'error_body' : 'empty_answer');
    return out('FAIL');
  }
  if (ctx.requireV3 && turn.version !== 'v3') hard.push('not_v3:' + (turn.gate || turn.version || 'unknown'));

  if (e.cards === 'required' && !cards.length) hard.push('no_cards');
  if (e.cards === 'forbidden' && cards.length) hard.push('cards_on_non_shopping');

  let cardViolations = 0;
  for (const card of cards) {
    const r = checkCard(card, e, { nowMs: ctx.nowMs });
    if (r.hard.length) cardViolations++;
    hard.push(...r.hard);
    soft.push(...r.soft);
  }
  if (e.sides && cards.length && !e.sides.every(re => cards.some(cd => re.test(cd.title)))) soft.push('one_compare_side_only');

  // ── 후속 질문: 앞 턴과의 관계 ──
  if (e.seed && ctx.seed) {
    const seedCards = cardsOf(ctx.seed.data);
    const f = e.followup || {};
    if (turn.version === 'v3') {
      const st = (data.stats || {});
      // 상태 판정을 보고하지 않는 서버(2026-11-14 이전 v3)는 계약을 확인할 수 없다 — 실패가 아니라 검증 불가.
      if (st.state == null) soft.push('state_unreported');
      else if (st.state !== 'valid') hard.push('state_not_carried:' + st.state);
      const conv = st.conversation;
      if (!conv) soft.push('history_contract_unreported');
      else if (ctx.seed.version === 'v3' && (ctx.seed.data || {}).turnSig && !(conv.verifiedAssistant >= 1)) hard.push('prior_answer_not_verified');
    } else if (turn.version === 'legacy' && !(typeof data.convState === 'string' && data.convState)) {
      soft.push('legacy_no_convstate');
    }
    if (f.cheaperThanSeed && cards.length) {
      const floor = Math.min(...seedCards.map(x => x.price).filter(Number.isFinite));
      if (Number.isFinite(floor) && cards.some(x => !(x.price < floor))) hard.push('not_cheaper_than_seed');
      if (!seedCards.length) notes.push('seed_had_no_cards');
    }
    if (f.onlySeedIndex != null) {
      const want = seedCards[f.onlySeedIndex];
      if (!want) notes.push('seed_lacks_referenced_item');
      else if (cards.length && !(cards.length === 1 && cards[0].id === want.id)) hard.push('wrong_referenced_product');
    }
    if (f.differentFromSeed && cards.length) {
      const ids = new Set(seedCards.map(x => x.id));
      if (cards.some(x => ids.has(x.id))) hard.push('repeated_seed_product');
    }
    if (f.pricierThanSeed && cards.length && seedCards.length) {
      const top = Math.max(...seedCards.map(x => x.price).filter(Number.isFinite));
      if (!(Math.max(...cards.map(x => x.price)) > top)) soft.push('not_pricier_than_seed');
    }
  }

  if (hard.length) {
    const human = reviewOf(ctx.review, c);
    if (human && human.verdict === 'PASS') notes.push('human_disagrees_with_auto_fail: ' + human.evidence);
    return out('FAIL', { cardViolations });
  }
  const human = reviewOf(ctx.review, c);
  if (human) {
    notes.push('human_review: ' + human.evidence);
    return out(human.verdict, { cardViolations });
  }
  if (soft.length || e.review) {
    if (e.review) notes.push('needs_human_review');
    return out('UNVERIFIED', { cardViolations });
  }
  return out('PASS', { cardViolations });
}

function reviewOf(review, c) {
  if (!review) return null;
  const r = review[c.id] || review[String(c.n)];
  if (!r || !['PASS', 'FAIL'].includes(r.verdict) || typeof r.evidence !== 'string' || !r.evidence.trim()) return null;
  return r;
}

function percentile(values, p) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
}

/** USD 단가: { input, output } = 100만 토큰당 달러. 없으면 비용은 null(토큰만). */
function costOf(usage, prices) {
  if (!usage || !prices || !Number.isFinite(prices.input) || !Number.isFinite(prices.output)) return null;
  return (Number(usage.inputTokens) || 0) / 1e6 * prices.input + (Number(usage.outputTokens) || 0) / 1e6 * prices.output;
}

function summarize(rows, { prices } = {}) {
  const verdicts = { PASS: 0, FAIL: 0, UNVERIFIED: 0 };
  const byCategory = {};
  const reasons = {};
  const latencies = [], seedLatencies = [];
  const versions = {}, gates = {};
  let requests = 0, http200 = 0, transportErrors = 0, nonJson = 0, timeouts = 0;
  let tokensIn = 0, tokensOut = 0, modelCalls = 0, priced = 0, unpriced = 0, costUsd = 0;
  let needCards = 0, gotCards = 0, cardsTotal = 0, cardsBad = 0;
  const seenTurn = t => {
    if (!t) return;
    requests++;
    if (t.status === 200) http200++;
    if (t.status === 0) transportErrors++;
    if (t.error === 'non_json_response') nonJson++;
    if (/timeout|aborted/i.test(String(t.error || ''))) timeouts++;
    versions[t.version || 'unknown'] = (versions[t.version || 'unknown'] || 0) + 1;
    if (t.gate) gates[t.gate] = (gates[t.gate] || 0) + 1;
    const usage = t.data && t.data.stats && t.data.stats.modelUsage;
    if (usage && Number.isFinite(Number(usage.totalTokens))) {
      tokensIn += Number(usage.inputTokens) || 0; tokensOut += Number(usage.outputTokens) || 0; modelCalls += Number(usage.calls) || 0;
      const c = costOf(usage, prices);
      if (c != null) { priced++; costUsd += c; } else unpriced++;
    } else unpriced++;
  };
  for (const r of rows) {
    verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
    const cat = byCategory[r.category] || (byCategory[r.category] = { label: CATEGORY_LABELS[r.category] || r.category, PASS: 0, FAIL: 0, UNVERIFIED: 0 });
    cat[r.verdict]++;
    for (const x of r.reasons || []) { const k = x.split(':')[0]; reasons[k] = (reasons[k] || 0) + 1; }
    if (r.turn && r.turn.status > 0) latencies.push(r.turn.elapsedMs);
    if (r.seedTurn && r.seedTurn.status > 0) seedLatencies.push(r.seedTurn.elapsedMs);
    seenTurn(r.turn); seenTurn(r.seedTurn);
    if (r.expectCards === 'required') { needCards++; if (r.cardCount > 0) gotCards++; }
    cardsTotal += r.cardsChecked || 0; cardsBad += r.cardViolations || 0;
  }
  const avg = a => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
  return {
    evaluated: rows.length, verdicts, byCategory, failReasons: reasons,
    transport: { requests, http200, transportErrors, nonJson, timeouts,
      errorRate: requests ? Math.round((requests - http200) / requests * 1000) / 10 : null },
    versions, v3Gates: gates,
    accuracy: {
      recommendationRate: needCards ? Math.round(gotCards / needCards * 1000) / 10 : null,
      casesNeedingCards: needCards, casesWithCards: gotCards,
      cardsShown: cardsTotal, cardsViolatingConstraints: cardsBad,
      cardPrecision: cardsTotal ? Math.round((cardsTotal - cardsBad) / cardsTotal * 1000) / 10 : null,
      passRateOfAll: rows.length ? Math.round(verdicts.PASS / rows.length * 1000) / 10 : null
    },
    latencyMs: { scored: { n: latencies.length, avg: avg(latencies), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.length ? Math.max(...latencies) : null },
      seeds: { n: seedLatencies.length, avg: avg(seedLatencies), p95: percentile(seedLatencies, 0.95) } },
    cost: { modelCalls, inputTokens: tokensIn, outputTokens: tokensOut,
      usd: priced ? Math.round(costUsd * 1e6) / 1e6 : null, pricedRequests: priced, unpricedRequests: unpriced,
      verified: unpriced === 0 && priced > 0,
      note: prices ? 'token-based estimate with the given $/1M prices' : 'no price table given — tokens only; legacy answers report no token usage' }
  };
}

module.exports = { gradeCase, checkCard, cardsOf, answerOf, summarize, percentile, costOf, USED, MAX_PRICE_AGE_DAYS };
