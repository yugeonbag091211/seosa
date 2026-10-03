'use strict';

/*
 * NO_MATCH cause analysis over a read-only snapshot (pure; no DB, no network).
 * scripts/analyze-nomatch.js builds the snapshot with SELECT-only queries.
 *
 * Identity is the collector's exact rule — never title similarity:
 *   Coupang  productId + vendorItemId      ADPICK  sha256(commissionlink) (api/_shop adpickProductId)
 *
 * snapshot = {
 *   today: 'YYYY-MM-DD' (KST), dayStartIso: KST 00:00 of today as ISO,
 *   malls: { [mall]: { attempted: ['pid|mall'], covered: [...], option: [...] } },
 *   products: [{ product_id, mall, keyword, title, link, vendor_item_id, collected_at, lprice }],
 *   lastPrice: { [mall]: { [product_id]: 'YYYY-MM-DD' } }   // last price_history date before today
 *   caches: { [mall]: [{ keyword, items, fetched_at }] }     // provider search caches
 * }
 */
const crypto = require('crypto');
const Q = require('../api/_query');
const { queryIdentity } = require('../api/_collector-query');
const Planner = require('../api/_collectplan');

const sha = s => crypto.createHash('sha256').update(String(s || '')).digest('hex');
const vidOfLink = link => { const m = /vendorItemId=(\d+)/.exec(String(link || '')); return m ? m[1] : ''; };
const titleKey = t => Q.tokenize(t).map(w => w.toLowerCase()).join(' ');
const tokenSet = t => new Set(Q.tokenize(t).map(w => w.toLowerCase()));
const jaccard = (a, b) => { let i = 0; a.forEach(x => { if (b.has(x)) i++; }); const u = a.size + b.size - i; return u ? i / u : 0; };
const isCoupang = mall => mall === '쿠팡';

/** Exact identity of a response item (what the collector adopts). */
function itemIdentity(mall, it) {
  return isCoupang(mall) ? `${it.productId}|${it.vendorItemId || vidOfLink(it.link)}` : sha(it.commissionlink);
}
function itemProductId(mall, it) { return isCoupang(mall) ? String(it.productId) : sha(it.commissionlink); }
function targetIdentity(mall, p) {
  return isCoupang(mall) ? `${p.product_id}|${p.vendor_item_id || vidOfLink(p.link)}` : String(p.product_id);
}
function ageDays(lastDate, today) {
  return lastDate ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDate}T00:00:00Z`)) / 86400000 : Infinity;
}
const freshness = age => (age <= Planner.RECOVERY_RECENT_DAYS ? 'recent' : 'stale');

const QTY_OR_OPTION = /(블랙|화이트|그레이|실버|네이비|핑크|레드|블루|그린)|\d+\s*(개|개입|팩|입|매|장|병|캔|박스|ea|pcs|세트)(\s|$)/i;
const PROMO_OR_SPECIAL = /[[\]()+&/!*~★☆※]|무료배송|당일발송|정품|특가|할인|증정|사은품|이벤트|쿠폰|로켓/;

function analyzeMall(snapshot, mall) {
  const st = snapshot.malls[mall];
  const covered = new Set(st.covered), option = new Set(st.option);
  const byKey = new Map(snapshot.products.filter(p => p.mall === mall).map(p => [`${p.product_id}|${mall}`, p]));
  const lastPrice = snapshot.lastPrice[mall] || {};
  const dayStart = Date.parse(snapshot.dayStartIso);
  const todays = (snapshot.caches[mall] || []).filter(r => Date.parse(r.fetched_at) >= dayStart);
  const answer = new Map(todays.map(r => [queryIdentity(r.keyword), r.items || []]));
  const seenExact = new Map(), seenTitle = new Map();
  for (const [q, items] of answer) {
    for (const it of items) {
      const id = itemIdentity(mall, it);
      if (!seenExact.has(id)) seenExact.set(id, new Set());
      seenExact.get(id).add(q);
      const tk = titleKey(it.title);
      if (!seenTitle.has(tk)) seenTitle.set(tk, new Map());
      seenTitle.get(tk).set(itemProductId(mall, it), { price: it.lprice || it.price, seller: it.cpName || '' });
    }
  }

  const out = { attempted: st.attempted.length, covered: covered.size, option: option.size, nomatch: 0,
    causes: {}, features: { query_has_option_qty_color: 0, query_has_promo_special: 0, title_has_model_code: 0 },
    ladder: { recent: { tried: 0, recovered: 0, queries: 0, stillNomatch: 0 }, stale: { tried: 0, recovered: 0, queries: 0, stillNomatch: 0 } },
    strategies: { recent: {}, stale: {} }, firstPassGroups: {}, fuzzyFalsePositivesAvoided: 0,
    relist: { candidates: 0, unique: 0, uniquePriceWithin30: 0 } };
  const relistList = [];
  const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  const groups = new Map();

  for (const key of st.attempted) {
    const p = byKey.get(key);
    if (!p) continue;
    const id = targetIdentity(mall, p);
    const q1 = queryIdentity(p.keyword || '');
    const hits = seenExact.get(id) || new Set();
    const age = ageDays(lastPrice[p.product_id], snapshot.today);
    const cls = freshness(age);
    if (p.keyword) {
      if (!groups.has(q1)) groups.set(q1, { rows: 0, recent: 0, q1Hits: 0 });
      const g = groups.get(q1); g.rows++; if (cls === 'recent') g.recent++; if (hits.has(q1)) g.q1Hits++;
    }

    // Alternate queries the collector actually executed today for this product (natural experiment).
    const candidates = Q.generateSecondPassCandidates(p).filter(c => queryIdentity(c.query) !== q1
      && answer.has(queryIdentity(c.query)));
    if (candidates.length) {
      const L = out.ladder[cls];
      L.tried++; L.queries += candidates.length;
      if (candidates.some(c => hits.has(queryIdentity(c.query)))) L.recovered++;
      else if (!covered.has(key) && !option.has(key)) L.stillNomatch++;
      const pt = tokenSet(p.title), brand = (Q.brandOf(p.title) || '').toLowerCase();
      for (const c of candidates) {
        const items = answer.get(queryIdentity(c.query));
        const s = out.strategies[cls][c.type] = out.strategies[cls][c.type]
          || { executed: 0, exact: 0, otherOption: 0, similarDifferentId: 0 };
        s.executed++;
        const exact = hits.has(queryIdentity(c.query));
        if (exact) s.exact++;
        else if (isCoupang(mall) && items.some(it => String(it.productId) === String(p.product_id))) s.otherOption++;
        if (!exact && items.some(it => itemProductId(mall, it) !== String(p.product_id)
            && (Q.brandOf(it.title) || '').toLowerCase() === brand && jaccard(pt, tokenSet(it.title)) >= 0.7)) {
          s.similarDifferentId++; out.fuzzyFalsePositivesAvoided++;
        }
      }
    }
    if (covered.has(key) || option.has(key)) continue;

    // ── NO_MATCH: mutually exclusive cause (first matching rule wins) ──
    out.nomatch++;
    const q = p.keyword || '';
    if (QTY_OR_OPTION.test(q)) out.features.query_has_option_qty_color++;
    if (PROMO_OR_SPECIAL.test(q)) out.features.query_has_promo_special++;
    if (Q.modelsOf(p.title).length) out.features.title_has_model_code++;
    const q1Answer = answer.get(q1);
    const sameTitle = [...(seenTitle.get(titleKey(p.title)) || new Map())].filter(([pid]) => pid !== String(p.product_id));
    let cause;
    if (hits.size) cause = 'H_exact_item_in_todays_answers';
    else if (q1Answer && q1Answer.length === 0) cause = 'NO_RESULT_empty_answer';
    else if (sameTitle.length) cause = 'E_same_title_new_id';
    else if (cls === 'stale') cause = 'G_stale_not_in_any_answer';
    else if (q1Answer && q1Answer.some(it => (Q.brandOf(it.title) || '').toLowerCase() === (Q.brandOf(p.title) || '').toLowerCase()
        && jaccard(tokenSet(p.title), tokenSet(it.title)) >= 0.5)) cause = 'F_similar_only_in_keyword_answer';
    else cause = 'A_recent_dropped_from_keyword_ranking';
    bump(out.causes, cause);

    if (sameTitle.length) {
      out.relist.candidates++;
      if (sameTitle.length === 1) {
        out.relist.unique++;
        const [[newId, info]] = sameTitle;
        const ratio = p.lprice ? info.price / p.lprice : null;
        const within = ratio != null && ratio >= 0.7 && ratio <= 1.3;
        if (within) out.relist.uniquePriceWithin30++;
        relistList.push({ mall, oldProductId: String(p.product_id), newProductId: newId, title: p.title,
          oldPrice: p.lprice, newPrice: info.price, priceRatio: ratio, seller: info.seller,
          lastPriced: lastPrice[p.product_id] || null, reviewRequired: true, passesPriceGuard: within });
      }
    }
  }
  for (const g of groups.values()) {
    const cls = g.recent === g.rows ? 'all_recent' : g.recent === 0 ? 'all_stale' : 'mixed';
    const a = out.firstPassGroups[cls] = out.firstPassGroups[cls] || { groups: 0, products: 0, q1Hits: 0 };
    a.groups++; a.products += g.rows; a.q1Hits += g.q1Hits;
  }
  return { result: out, relistList };
}

/**
 * Same number of ladder queries, recent-first order (api/_collectplan orderRecoveryQueue).
 * Untried products are assumed to recover at their class's measured rate — an estimate,
 * reported with the measured inputs, never as a measured outcome.
 */
function counterfactual(result) {
  const r = result.ladder.recent, s = result.ladder.stale;
  const budget = r.queries + s.queries;
  const qpp = { recent: r.tried ? r.queries / r.tried : 1, stale: s.tried ? s.queries / s.tried : 1 };
  const rate = { recent: r.tried ? r.recovered / r.tried : 0, stale: s.tried ? s.recovered / s.tried : 0 };
  // Recent products the ladder could serve: those it tried + recent NO_MATCH it never reached.
  const untriedRecent = Math.max(0, (result.causes.A_recent_dropped_from_keyword_ranking || 0)
    + (result.causes.F_similar_only_in_keyword_answer || 0) - r.stillNomatch);
  const recentPool = r.tried + untriedRecent;
  const recentServed = Math.min(recentPool, budget / qpp.recent);
  const left = Math.max(0, budget - recentServed * qpp.recent);
  const staleServed = Math.min(s.tried + Math.max(0, (result.causes.G_stale_not_in_any_answer || 0) - s.stillNomatch), left / qpp.stale);
  const expected = recentServed * rate.recent + staleServed * rate.stale;
  const actual = r.recovered + s.recovered;
  return { ladderQueries: budget, actualRecovered: actual, recentPool, untriedRecent, recentRate: +rate.recent.toFixed(3),
    staleRate: +rate.stale.toFixed(3), queriesPerProduct: { recent: +qpp.recent.toFixed(2), stale: +qpp.stale.toFixed(2) },
    expectedRecovered: Math.round(expected), expectedGain: Math.round(expected - actual) };
}

function analyze(snapshot) {
  const malls = {}, relist = [];
  for (const mall of Object.keys(snapshot.malls)) {
    const { result, relistList } = analyzeMall(snapshot, mall);
    malls[mall] = { ...result, counterfactualRecentFirst: counterfactual(result) };
    relist.push(...relistList);
  }
  return { report: { today: snapshot.today, malls }, relist };
}

module.exports = { analyze, analyzeMall, counterfactual, itemIdentity, targetIdentity, ageDays };
