#!/usr/bin/env node
'use strict';

/**
 * Bounded image backfill for recent community cards already stored without a photo.
 * Uses the exact same official Coupang/ADPICK search, provider rate limiters,
 * model/variant guards and reference-image labeling as the live Radar collector.
 * Does not scrape community sites, invent photos or mark deals price-verified.
 */
require('./_env');
const db = require('../api/_supabase');
const { enrichAffiliateRows, safeImageUrl } = require('./collect-external-hotdeals');

const HOURS = 72;
const COOLDOWN_HOURS = 12;
const ROW_LIMIT = Math.max(1, Math.min(12, Number(process.env.EXTERNAL_IMAGE_BACKFILL_ROWS) || 8));
const DRY_RUN = process.argv.includes('--dry-run');

function chooseRows(rows, nowMs, max = ROW_LIMIT) {
  const cutoff = nowMs - COOLDOWN_HOURS * 3600000;
  return (rows || []).filter(r => {
    if (!r || !r.id || !r.title || !r.source_url || !Number(r.price)) return false;
    if (safeImageUrl(r.image_url) || r.matched_product_id) return false;
    const last = Date.parse(r.metadata && r.metadata.imageBackfillAttemptedAt || '');
    return !Number.isFinite(last) || last < cutoff;
  }).slice(0, max);
}

async function main(opts = {}) {
  const client = opts.db || db;
  const enrich = opts.enrich || enrichAffiliateRows;
  const nowMs = opts.nowMs || Date.now();
  const dryRun = DRY_RUN || !!opts.dryRun;
  const since = new Date(nowMs - HOURS * 3600000).toISOString();
  const { data, error } = await client.from('external_hotdeals')
    .select('id,source,source_post_id,source_url,title,price,mall,product_url,image_url,metadata,matched_product_id,posted_at')
    .eq('is_primary', true)
    .gte('posted_at', since)
    .order('posted_at', { ascending: false })
    .limit(200);
  if (error) throw new Error('load recent community deals: ' + error.message);
  // Most recent first, but do not repeatedly waste calls on still-unavailable SKUs.
  const chosen = chooseRows(data, nowMs, opts.rowLimit || ROW_LIMIT);
  const stats = { eligible: (data || []).filter(r => !safeImageUrl(r.image_url)).length,
    selected: chosen.length, imageFilled: 0, affiliateMatched: 0,
    skipped: 0, errors: 0, dryRun };
  if (dryRun) { console.log(JSON.stringify(stats)); return stats; }
  for (const original of chosen) {
    const row = { ...original, metadata: { ...(original.metadata || {}) } };
    const deal = {
      title: original.title, price: Number(original.price), mall: original.mall,
      postUrl: original.source_url, productUrl: original.product_url || '',
      metadata: original.metadata || {}
    };
    try {
      await enrich([deal], [row], { lookupLimit: 1, searchLimit: 2 });
      const photo = safeImageUrl(row.image_url);
      const patch = {
        metadata: { ...row.metadata, imageBackfillAttemptedAt: new Date(nowMs).toISOString() }
      };
      if (photo) patch.image_url = photo;
      // A verified 0.90 identity may be stored, but never alter verification_status
      // or interpret an affiliate search price as the original community deal price.
      if (row.matched_product_id && Number(row.match_confidence) >= 0.90) {
        patch.matched_product_id = row.matched_product_id;
        patch.matched_mall = row.matched_mall || '';
        patch.matched_vendor_item_id = row.matched_vendor_item_id || '';
        patch.match_confidence = row.match_confidence;
        patch.match_method = row.match_method || '';
      }
      let update = client.from('external_hotdeals').update(patch).eq('id', original.id);
      update = original.image_url == null ? update.is('image_url', null) : update.eq('image_url', '');
      const saved = await update;
      if (saved.error) throw new Error('update image metadata: ' + saved.error.message);
      if (photo) stats.imageFilled++;
      if (patch.matched_product_id) stats.affiliateMatched++;
    } catch (e) {
      stats.errors++;
      console.error(JSON.stringify({ event: 'image_backfill_failed', id: original.id, reason: String(e.message || e) }));
    }
  }
  console.log(JSON.stringify({ event: 'image_backfill', ...stats }));
  return stats;
}

if (require.main === module) main().catch(e => {
  console.error(JSON.stringify({ event: 'image_backfill_fatal', reason: String(e.message || e) }));
  process.exitCode = 1;
});
module.exports = { chooseRows, main };
