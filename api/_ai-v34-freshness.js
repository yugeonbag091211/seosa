'use strict';
// AI v3.4 — price-age gate for recommendation cards.
//
// The site already has ONE definition of «a price we may show as current»:
// _price.productLifecycle (MAX_DISPLAY_AGE_DAYS, default 10). The v3 engine
// never applied it, so a DB row last collected 49 days ago could become a
// recommended card with its old price (2026-11-10 online-50: up to 13 of 36
// displayed cards were older than 10 days). This module applies the same rule
// to AI candidates, with an injectable clock for deterministic replay.
const { productLifecycle, LIFECYCLE, MAX_DISPLAY_AGE_DAYS } = require('./_price');

const OBSERVED_SOURCES = new Set(['api', 'cache']);

function maxPriceAgeDays(env = process.env) {
  const v = Number(env.AI_V34_MAX_PRICE_AGE_DAYS);
  // Never allow a configuration to turn the gate off or exceed 60 days.
  return Number.isFinite(v) && v > 0 && v <= 60 ? v : MAX_DISPLAY_AGE_DAYS;
}
function clockOf(now) {
  if (typeof now === 'function') return Number(now());
  if (now instanceof Date) return now.getTime();
  return Number.isFinite(Number(now)) && now != null ? Number(now) : Date.now();
}
// state: observed (provider API/cache right now), fresh (DB, within limit),
//        stale (DB too old / stale-cache / dead mall), unknown (DB without a
//        usable timestamp), not_applicable (no provenance: injected test data).
function priceFreshness(item, { now, maxAgeDays } = {}) {
  const at = clockOf(now);
  const limit = Number(maxAgeDays) > 0 ? Number(maxAgeDays) : maxPriceAgeDays();
  const source = String((item && (item._source || item.source)) || '');
  const collectedAt = String((item && (item.collectedAt || item.collected_at)) || '');
  if (OBSERVED_SOURCES.has(source)) return { state: 'observed', ageDays: 0, observedAt: null, limitDays: limit };
  if (source === 'stale-cache') return { state: 'stale', reason: 'stale_cache', ageDays: null, observedAt: null, limitDays: limit };
  if (!source && !collectedAt) return { state: 'not_applicable', ageDays: null, observedAt: null, limitDays: limit };
  const life = productLifecycle({
    product_id: (item && (item.productId || item.product_id || item.id)) || 'unknown',
    mall: item && item.mall, lprice: item && (item.lprice == null ? item.price : item.lprice),
    collected_at: collectedAt
  }, { maxAgeDays: limit, now: at });
  const ageDays = Number.isFinite(life.ageDays) ? Math.max(0, Math.round(life.ageDays * 10) / 10) : null;
  const observedAt = collectedAt && Number.isFinite(Date.parse(collectedAt)) ? new Date(Date.parse(collectedAt)).toISOString() : null;
  if (life.state === LIFECYCLE.LIVE) return { state: 'fresh', ageDays, observedAt, limitDays: limit };
  if (!observedAt) return { state: 'unknown', reason: 'price_time_unknown', ageDays: null, observedAt: null, limitDays: limit };
  return { state: 'stale', reason: life.state === LIFECYCLE.DEAD_MALL ? 'dead_mall' : life.state === LIFECYCLE.INVALID ? 'invalid' : 'too_old',
    ageDays, observedAt, limitDays: limit };
}
function isRecommendable(freshness) {
  return freshness.state === 'observed' || freshness.state === 'fresh' || freshness.state === 'not_applicable';
}
module.exports = { priceFreshness, isRecommendable, maxPriceAgeDays, clockOf, OBSERVED_SOURCES };
