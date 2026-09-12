#!/usr/bin/env node
'use strict';

/**
 * External Hotdeal Radar collector.
 *
 * Only enabled adapters are called. The registry ships with no enabled live
 * community adapter; adding one requires a verified official API/RSS/feed.
 */
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
for (const name of ['.env.local', '.env']) {
  const file = path.join(root, name);
  if (fs.existsSync(file)) { require('dotenv').config({ path: file }); break; }
}

const supabase = require('../api/_supabase');
const registry = require('../api/hotdeal-sources/registry');
const Radar = require('../api/_external-hotdeal');
const { kstToday } = require('../api/_kst');

const DRY_RUN = process.argv.includes('--dry-run');
const PRODUCT_LIMIT = Math.max(100, Math.min(10000, Number(process.env.EXTERNAL_HOTDEAL_PRODUCT_LIMIT) || 5000));

function log(message, extra) {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...(extra || {}) }));
}

async function loadProducts(db) {
  const { data, error } = await db.from('products')
    .select('product_id, vendor_item_id, mall, title, link, lprice, collected_at')
    .order('collected_at', { ascending: false })
    .limit(PRODUCT_LIMIT);
  if (error) throw new Error(`products: ${error.message}`);
  return data || [];
}

async function loadHistory(matches, db) {
  const ids = [...new Set(matches.map(m => m.product && String(m.product.product_id)).filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('price_history')
      .select('product_id, vendor_item_id, mall, price, recorded_date, recorded_at')
      .in('product_id', ids.slice(i, i + 100))
      .order('recorded_date', { ascending: true });
    if (error) throw new Error(`price_history: ${error.message}`);
    for (const row of data || []) {
      const key = String(row.product_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
  }
  return map;
}

function historyFor(match, history) {
  if (!match || !match.product) return [];
  const product = match.product;
  const rows = history.get(String(product.product_id)) || [];
  const mallRows = product.mall ? rows.filter(r => String(r.mall || '') === String(product.mall)) : rows;
  const sameMall = mallRows.length ? mallRows : rows;
  const vid = String(product.vendor_item_id || '');
  if (!vid) return sameMall;
  const sameVendor = sameMall.filter(r => String(r.vendor_item_id || '') === vid);
  // Preserve the established legacy fallback only when old history has no vendor id at all.
  return sameVendor.length || sameMall.some(r => r.vendor_item_id) ? sameVendor : sameMall;
}

function rowFor(deal, match, verification) {
  const product = match && match.product;
  return {
    source: deal.source,
    source_post_id: deal.externalId,
    source_url: deal.postUrl,
    canonical_source_url: deal.canonicalPostUrl,
    title: deal.title,
    normalized_title: deal.normalizedTitle,
    price: deal.price,
    original_price: deal.originalPrice,
    mall: deal.mall,
    product_url: deal.productUrl,
    canonical_product_url: deal.canonicalProductUrl,
    image_url: deal.imageUrl,
    posted_at: deal.postedAt,
    fetched_at: deal.fetchedAt,
    matched_product_id: product ? String(product.product_id) : null,
    matched_mall: product ? String(product.mall || '') : '',
    matched_vendor_item_id: product ? String(product.vendor_item_id || '') : '',
    match_confidence: Math.round((match.confidence || 0) * 1000) / 1000,
    match_method: match.method || 'none',
    deal_score: verification.dealScore,
    verification_status: verification.verificationStatus,
    price_vs_30d_avg: verification.priceVs30dAvg,
    price_vs_90d_low: verification.priceVs90dLow,
    average_30d: verification.stats.average30,
    low_30d: verification.stats.low30,
    low_90d: verification.stats.low90,
    previous_price: verification.stats.previousPrice,
    history_observation_count: verification.stats.count,
    history_last_observed_at: verification.stats.lastObservedAt,
    metadata: { ...deal.metadata, matchReason: match.reason, scoreParts: verification.parts },
    last_verified_at: new Date().toISOString()
  };
}

async function save(rows, db) {
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await db.from('external_hotdeals')
      .upsert(rows.slice(i, i + 100), { onConflict: 'source,source_post_id' });
    if (error) throw new Error(`external_hotdeals: ${error.message}`);
  }
}

async function main(options) {
  const opts = options || {};
  const db = opts.db || supabase;
  const sourceRegistry = opts.registry || registry;
  const fetched = await sourceRegistry.fetchAll({ now: new Date() });
  fetched.errors.forEach(error => log('source_error', error));
  if (!fetched.items.length) {
    log('no_active_external_source', { activeSources: sourceRegistry.active().map(s => s.id) });
    return { fetched: 0, matched: 0, exposed: 0, written: 0, errors: fetched.errors.length };
  }

  const products = await loadProducts(db);
  const matches = fetched.items.map(deal => Radar.matchProduct(deal, products));
  const history = await loadHistory(matches, db);
  let rows = fetched.items.map((deal, i) => {
    const match = matches[i];
    return rowFor(deal, match, Radar.verifyDeal(deal, match, historyFor(match, history), kstToday()));
  });
  rows = Radar.dedupeAcrossSources(rows).map(row => ({
    ...row,
    group_key: row.groupKey,
    is_primary: row.isPrimary,
    source_count: row.sourceCount,
    sources: row.sources
  }));
  rows.forEach(row => { delete row.groupKey; delete row.isPrimary; delete row.sourceCount; });

  if (!(DRY_RUN || opts.dryRun)) await save(rows, db);
  const result = {
    fetched: fetched.items.length,
    matched: rows.filter(r => r.matched_product_id).length,
    exposed: rows.filter(r => r.is_primary && r.deal_score >= Radar.EXPOSURE_SCORE).length,
    written: (DRY_RUN || opts.dryRun) ? 0 : rows.length,
    errors: fetched.errors.length
  };
  log(DRY_RUN || opts.dryRun ? 'dry_run' : 'complete', result);
  return result;
}

if (require.main === module) {
  main().catch(error => { log('failed', { error: String(error && error.message || error) }); process.exitCode = 1; });
}

module.exports = { main, loadProducts, loadHistory, historyFor, rowFor };
