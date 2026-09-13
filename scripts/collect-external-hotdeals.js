#!/usr/bin/env node
'use strict';

/**
 * External Hotdeal Radar collector.
 *
 *   enabled sources → normalize → match products → verify with price_history
 *   → group across sources (including recent stored rows) → decide exposure → save
 *
 * ── Exposure is OFF by default (shadow) ───────────────────────────────
 *   EXTERNAL_HOTDEAL_SHADOW          anything but '0' = shadow: every row is saved with is_exposed=false
 *   EXTERNAL_HOTDEAL_PUBLIC_SOURCES  with shadow off, only these comma-separated sources may be exposed
 *   api/hotdeals.js additionally requires EXTERNAL_HOTDEAL_PUBLIC=1. Both switches must be on.
 *
 * ── Flags ─────────────────────────────────────────────────────────────
 *   --dry-run   no writes (works before the external_hotdeals migration is applied)
 *   --sample    print every verdict for manual review (title, price, matched product, score, reasons)
 *
 * Logs carry counts, ids and product titles only. Adapters never read post bodies or authors.
 */
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
for (const name of ['.env.local', '.env']) {
  const file = path.join(root, name);
  if (fs.existsSync(file)) { require('dotenv').config({ path: file }); break; }
}

const supabase = require('../api/_supabase');
const registry = require('../api/_hotdeal-sources/registry');
const Radar = require('../api/_external-hotdeal');
const { kstToday } = require('../api/_kst');
const { sameVendorRows } = require('../api/_price');

const DRY_RUN = process.argv.includes('--dry-run');
const SAMPLE = process.argv.includes('--sample');
/** PostgREST caps one response at 1000 rows; limit(5000) alone silently returns 1000. */
const PAGE = 1000;
const PRODUCT_LIMIT = Math.max(100, Math.min(10000, Number(process.env.EXTERNAL_HOTDEAL_PRODUCT_LIMIT) || 5000));
const HISTORY_DAYS = 90;
const HISTORY_CHUNK = 20;
/** Stored posts inside this window are regrouped with the current batch (closeInTime is 48h). */
const GROUP_WINDOW_HOURS = 72;

function log(message, extra) {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...(extra || {}) }));
}

function exposurePolicy(env) {
  const e = env || process.env;
  const shadow = e.EXTERNAL_HOTDEAL_SHADOW !== '0';
  const publicSources = [...new Set(String(e.EXTERNAL_HOTDEAL_PUBLIC_SOURCES || '')
    .split(',').map(s => s.trim()).filter(Boolean))];
  return { shadow, publicSources, allows: source => !shadow && publicSources.indexOf(String(source || '')) > -1 };
}

async function selectPaged(build, limit) {
  const rows = [];
  for (let from = 0; from < limit; from += PAGE) {
    const to = Math.min(from + PAGE, limit) - 1;
    const { data, error } = await build().range(from, to);
    if (error) throw new Error(error.message);
    const page = data || [];
    rows.push(...page);
    if (page.length < to - from + 1) break;
  }
  return rows;
}

async function loadProducts(db) {
  try {
    return await selectPaged(() => db.from('products')
      .select('product_id, vendor_item_id, mall, title, link, lprice, collected_at')
      .order('collected_at', { ascending: false })
      .order('product_id', { ascending: true })
      .order('mall', { ascending: true }), PRODUCT_LIMIT);
  } catch (error) {
    throw new Error(`products: ${error.message}`);
  }
}

async function loadHistory(matches, db, today) {
  const ids = [...new Set(matches.map(m => m && m.product && String(m.product.product_id)).filter(Boolean))];
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - (HISTORY_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const map = new Map();
  for (let i = 0; i < ids.length; i += HISTORY_CHUNK) {
    let rows;
    try {
      rows = await selectPaged(() => db.from('price_history')
        .select('product_id, vendor_item_id, mall, price, recorded_date, recorded_at')
        .in('product_id', ids.slice(i, i + HISTORY_CHUNK))
        .gte('recorded_date', since)
        .order('recorded_date', { ascending: true })
        .order('product_id', { ascending: true })
        .order('mall', { ascending: true })
        .order('vendor_item_id', { ascending: true }), 50000);
    } catch (error) {
      throw new Error(`price_history: ${error.message}`);
    }
    for (const row of rows) {
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
  // No fallback to other malls: another mall's history is not this listing's history.
  const sameMall = product.mall ? rows.filter(r => String(r.mall || '') === String(product.mall)) : rows;
  // The option guard is the shared _price.sameVendorRows rule (product page and price stats use it too).
  return sameVendorRows(sameMall, product.vendor_item_id);
}

function rowFor(deal, match, verification, nowMs) {
  const product = match && match.product;
  const candidate = match && match.candidate;
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
    match_confidence: Math.round(((match && match.confidence) || 0) * 1000) / 1000,
    match_method: (match && match.method) || 'none',
    deal_score: verification.dealScore,
    verification_status: verification.verificationStatus,
    verification_reasons: verification.reasons,
    price_vs_30d_avg: verification.priceVs30dAvg,
    price_vs_90d_low: verification.priceVs90dLow,
    average_30d: verification.stats.average30,
    low_30d: verification.stats.low30,
    low_90d: verification.stats.low90,
    previous_price: verification.stats.previousPrice,
    history_observation_count: verification.stats.count,
    history_last_observed_at: verification.stats.lastObservedAt,
    is_exposed: false,
    metadata: {
      ...deal.metadata,
      matchReason: match && match.reason,
      matchedTitle: product ? String(product.title || '').slice(0, 200) : '',
      bestCandidateId: !product && candidate ? String(candidate.product_id || '') : '',
      bestCandidateTitle: !product && candidate ? String(candidate.title || '').slice(0, 200) : '',
      effectivePrice: verification.effectivePrice,
      priceVs30dMedian: verification.priceVs30dMedian,
      scoreParts: verification.parts
    },
    last_verified_at: new Date(nowMs).toISOString()
  };
}

function isMissingTable(message) {
  return /external_hotdeals.*(does not exist|could not find)|could not find the table|schema cache/i.test(String(message || ''));
}

async function loadRecentGroupRows(db, rows, nowMs, dryRun) {
  const ids = [...new Set(rows.map(r => r.matched_product_id).filter(Boolean))];
  if (!ids.length) return { rows: [], tableMissing: false };
  const since = new Date(nowMs - GROUP_WINDOW_HOURS * 3600000).toISOString();
  try {
    const found = await selectPaged(() => db.from('external_hotdeals').select('*')
      .in('matched_product_id', ids)
      .gte('posted_at', since)
      .order('id', { ascending: true }), 5000);
    return { rows: found, tableMissing: false };
  } catch (error) {
    if (isMissingTable(error.message)) {
      if (dryRun) return { rows: [], tableMissing: true };
      throw new Error('external_hotdeals table is missing — apply supabase/2026-09-12-external-hotdeals.sql manually');
    }
    throw new Error(`external_hotdeals(read): ${error.message}`);
  }
}

/**
 * Regroup the current batch together with recently stored posts so a product
 * posted on two communities in different runs still has one primary row.
 * Every source row is kept; only group fields and exposure are rewritten.
 */
function regroup(current, recent, policy) {
  const key = r => `${r.source}|${r.source_post_id}`;
  const seen = new Set(current.map(key));
  const carried = (recent || []).filter(r => !seen.has(key(r))).map(r => {
    const copy = { ...r };
    delete copy.id;
    return copy;
  });
  const rows = Radar.dedupeAcrossSources(current.concat(carried)).map(row => {
    const out = { ...row, group_key: row.groupKey, is_primary: row.isPrimary, source_count: row.sourceCount, sources: row.sources };
    delete out.groupKey; delete out.isPrimary; delete out.sourceCount;
    out.is_exposed = !!(out.is_primary && policy.allows(out.source) && Radar.isExposableRow(out));
    return out;
  });
  return { rows, carried: carried.length };
}

async function save(rows, db) {
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await db.from('external_hotdeals')
      .upsert(rows.slice(i, i + 100), { onConflict: 'source,source_post_id' });
    if (error) throw new Error(`external_hotdeals: ${error.message}`);
  }
}

function countRows(rows) {
  return {
    unique: rows.length,
    matched: rows.filter(r => r.matched_product_id).length,
    highConfidence: rows.filter(r => r.matched_product_id && Number(r.match_confidence) >= Radar.HIGH_MATCH_CONFIDENCE).length,
    unmatched: rows.filter(r => !r.matched_product_id).length,
    verified: rows.filter(Radar.isExposableRow).length,
    suspicious: rows.filter(r => r.verification_status === 'SUSPICIOUS_PRICE').length,
    groupedUnderOther: rows.filter(r => !r.is_primary).length,
    exposed: rows.filter(r => r.is_exposed).length
  };
}

function summarize(sourceStats, rows, extra) {
  const sum = key => sourceStats.reduce((s, stat) => s + (Number(stat[key]) || 0), 0);
  const totals = countRows(rows);
  return {
    dryRun: extra.dryRun,
    shadow: extra.policy.shadow,
    publicSources: extra.policy.publicSources,
    fetched: sum('fetched'),
    normalized: sum('normalized'),
    duplicates: sum('duplicates') + totals.groupedUnderOther,
    ...totals,
    written: extra.written,
    carriedFromDb: extra.carried,
    tableMissing: extra.tableMissing,
    errors: sourceStats.filter(stat => stat.status !== 'ok').length,
    sources: sourceStats.map(stat => ({ ...stat, ...countRows(rows.filter(r => r.source === stat.source)) }))
  };
}

function summaryText(s) {
  const lines = [];
  for (const src of s.sources) {
    lines.push(`Source: ${src.source} (${src.kind || 'feed'}) status=${src.status}${src.errorKind ? ` error=${src.errorKind}` : ''}`
      + ` http=${src.httpStatus == null ? '-' : src.httpStatus} attempts=${src.attempts == null ? '-' : src.attempts} latency=${src.latencyMs}ms`);
    lines.push(`  Fetched: ${src.fetched}  Normalized: ${src.normalized}  Duplicates: ${src.duplicates}  Skipped: ${JSON.stringify(src.skipped || {})}`);
    lines.push(`  Matched: ${src.matched}  High-confidence: ${src.highConfidence}  Unmatched: ${src.unmatched}`);
    lines.push(`  Verified >=${Radar.EXPOSURE_SCORE}: ${src.verified}  Suspicious: ${src.suspicious}  Grouped under another post: ${src.groupedUnderOther}  Exposed: ${src.exposed}`);
  }
  if (!s.sources.length) lines.push('Source: (none enabled)');
  lines.push(`Mode: ${s.dryRun ? 'dry-run' : 'write'} · ${s.shadow ? 'shadow (no public exposure)' : `public sources=[${s.publicSources.join(',')}]`}`
    + ` · written=${s.written} · carried=${s.carriedFromDb}${s.tableMissing ? ' · external_hotdeals table missing' : ''}`);
  return lines.join('\n');
}

function sampleOf(rows) {
  return rows.map(r => {
    const meta = r.metadata || {};
    return {
      source: r.source,
      id: r.source_post_id,
      title: r.title,
      price: r.price,
      mall: r.mall,
      shipping: meta.shippingNote || null,
      match: r.matched_product_id
        ? { productId: r.matched_product_id, title: meta.matchedTitle, confidence: Number(r.match_confidence), method: r.match_method, reason: meta.matchReason }
        : { confidence: Number(r.match_confidence), method: r.match_method, reason: meta.matchReason, bestCandidate: meta.bestCandidateTitle || null },
      score: r.deal_score,
      status: r.verification_status,
      reasons: r.verification_reasons,
      vs30dAvg: r.price_vs_30d_avg,
      vs90dLow: r.price_vs_90d_low,
      historyDays: r.history_observation_count,
      primary: r.is_primary,
      exposed: r.is_exposed,
      postUrl: r.source_url
    };
  });
}

async function main(options) {
  const opts = options || {};
  const db = opts.db || supabase;
  const sourceRegistry = opts.registry || registry;
  const dryRun = DRY_RUN || !!opts.dryRun;
  const policy = exposurePolicy(opts.env);
  const nowMs = opts.now == null ? Date.now() : Number(opts.now);
  const today = opts.today || kstToday();

  const fetched = await sourceRegistry.fetchAll({ now: new Date(nowMs) });
  (fetched.errors || []).forEach(error => log('source_error', error));

  let rows = [];
  let carried = 0;
  let tableMissing = false;
  if (fetched.items.length) {
    const products = await loadProducts(db);
    const matches = fetched.items.map(deal => Radar.matchProduct(deal, products));
    const history = await loadHistory(matches, db, today);
    const current = fetched.items.map((deal, i) => rowFor(deal, matches[i],
      Radar.verifyDeal(deal, matches[i], historyFor(matches[i], history), today), nowMs));
    const recent = await loadRecentGroupRows(db, current, nowMs, dryRun);
    tableMissing = recent.tableMissing;
    const grouped = regroup(current, recent.rows, policy);
    rows = grouped.rows;
    carried = grouped.carried;
  }

  if (!dryRun && rows.length) await save(rows, db);
  const currentKeys = new Set(fetched.items.map(d => `${d.source}|${d.externalId}`));
  const currentRows = rows.filter(r => currentKeys.has(`${r.source}|${r.source_post_id}`));
  const summary = summarize(fetched.sources || [], currentRows,
    { dryRun, policy, written: dryRun ? 0 : rows.length, carried, tableMissing });

  if (!opts.quiet) {
    console.log(summaryText(summary));
    if (SAMPLE || opts.sample) console.log(JSON.stringify(sampleOf(currentRows), null, 2));
    log(dryRun ? 'dry_run' : 'complete', summary);
  }
  return summary;
}

if (require.main === module) {
  main().catch(error => { log('failed', { error: String((error && error.message) || error) }); process.exitCode = 1; });
}

module.exports = {
  main, loadProducts, loadHistory, historyFor, rowFor, exposurePolicy, regroup, selectPaged,
  summaryText, sampleOf
};
