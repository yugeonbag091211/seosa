'use strict';
// AI v3.4 — Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009).
// score(d) = Σ_lists w_list / (k + rank_list(d)),  rank starting at 1.
// Fusion ORDERS candidates; it never accepts one. Every fused item still goes
// through the catalog/core validators.
function itemKey(item) {
  if (!item) return '';
  const pid = String(item.productId || item.product_id || '');
  const mall = String(item.mall || '');
  return mall && pid ? mall + ':' + pid : '';
}
// lists: array of [name, items] in PRIORITY order. When the same SKU appears
// in several lists the FIRST list's object is kept (put the provider-observed
// «live» list first so its price wins over a stored DB price).
function rrfFuse(lists, { k = 60, weights = {} } = {}) {
  if (!(k > 0)) throw new Error('rrf k must be positive');
  const score = new Map(), keep = new Map(), via = new Map(), firstSeen = new Map();
  let order = 0;
  for (const [name, items] of lists) {
    const w = weights[name] == null ? 1 : Number(weights[name]);
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      const key = itemKey(item);
      if (!key) return;
      if (via.has(key) && via.get(key).includes(name)) return; // duplicate inside one list
      score.set(key, (score.get(key) || 0) + w / (k + index + 1));
      if (!keep.has(key)) { keep.set(key, item); firstSeen.set(key, order++); }
      via.set(key, [...(via.get(key) || []), name]);
    });
  }
  return [...score.keys()]
    .sort((a, b) => (score.get(b) - score.get(a)) || (firstSeen.get(a) - firstSeen.get(b)))
    .map(key => {
      const item = keep.get(key);
      const out = { ...item };
      Object.defineProperty(out, '_rrf', { value: Math.round(score.get(key) * 1e6) / 1e6, enumerable: false });
      Object.defineProperty(out, '_via', { value: via.get(key), enumerable: false });
      return out;
    });
}
module.exports = { rrfFuse, itemKey };
