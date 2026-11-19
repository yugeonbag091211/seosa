'use strict';
// Provider-issued Coupang links, staged separately from historical catalogue links.
// An explicit env kill switch AND a genuine positive official partner click are required.
const crypto = require('node:crypto');
const { safeBuyLink, classifyCoupang } = require('./_affiliate');
function linkHasChannel(link, subId) {
  try {
    const u = new URL(link);
    return classifyCoupang(link).ok && u.protocol === 'https:'
      && u.hostname === 'link.coupang.com'
      && /^\/re\/AFF[A-Z]*$/.test(u.pathname)
      && [...u.searchParams].some(([k, v]) => k.toLowerCase() === 'subid' && v === subId);
  } catch (_) { return false; }
}
const CHANNEL = 'SEOSA2026';
const MIN_REPORT_DATE = '2026-11-19';

function percent() {
  if (process.env.COUPANG_LINKS_ROLLOUT !== '1' ||
      process.env.COUPANG_CHANNEL_SUBID !== CHANNEL) return 0;
  const n = Number(process.env.COUPANG_LINKS_PERCENT);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 0;
}
function key(item) {
  if (!item || !/^(쿠팡|coupang)$/i.test(String(item.mall || ''))) return '';
  const pid = String(item.productId || item.product_id || '');
  const vid = String(item.vendorItemId || item.vendor_item_id || '');
  return /^[0-9]{7,13}$/.test(pid) && /^[0-9]{7,14}$/.test(vid)
    ? pid + '|' + vid : '';
}
function inRollout(k, pct) {
  if (!k || pct <= 0) return false;
  const bucket = crypto.createHash('sha256').update(k).digest().readUInt32BE(0) % 100;
  return bucket < pct;
}
async function positiveOfficialClick(db) {
  const result = await db.from('coupang_partner_channel_daily')
    .select('report_date,clicks').eq('sub_id', CHANNEL)
    .gte('report_date', MIN_REPORT_DATE).gt('clicks', 0).limit(1);
  return !result.error && Array.isArray(result.data) && result.data.length > 0;
}
async function stagedByKey(db, items) {
  const pct = percent();
  const wanted = new Map();
  for (const item of items || []) {
    const k = key(item);
    if (inRollout(k, pct)) wanted.set(k, item);
  }
  if (!wanted.size) return new Map();
  try {
    if (!await positiveOfficialClick(db)) return new Map();
    const ids = [...new Set([...wanted.values()].map(x => String(x.productId || x.product_id)))];
    if (ids.length > 100) return new Map(); // bounded API reads
    const result = await db.from('coupang_channel_deeplinks')
      .select('product_id,item_id,vendor_item_id,landing_url,sub_id')
      .eq('sub_id', CHANNEL).in('product_id', ids).limit(1000);
    if (result.error || !Array.isArray(result.data)) return new Map();
    const matches = new Map(), ambiguous = new Set();
    for (const row of result.data) {
      const k = String(row.product_id) + '|' + String(row.vendor_item_id);
      if (!wanted.has(k) || row.sub_id !== CHANNEL) continue;
      const u = safeBuyLink(row.landing_url, { vendorItemId: row.vendor_item_id });
      if (!u || !linkHasChannel(u, CHANNEL)) continue;
      // Never choose arbitrarily between different item IDs for one option.
      if (matches.has(k)) { ambiguous.add(k); continue; }
      matches.set(k, u);
    }
    for (const k of ambiguous) matches.delete(k);
    return matches;
  } catch (_) {
    // A database outage or absent staging table must not break purchase links.
    return new Map();
  }
}
async function overlay(items, db) {
  if (!Array.isArray(items) || !items.length || !percent()) return items;
  const links = await stagedByKey(db, items);
  if (!links.size) return items;
  return items.map(item => {
    const url = links.get(key(item));
    if (!url) return item;
    const out = { ...item };
    if ('link' in out) out.link = url;
    if ('url' in out) out.url = url;
    if ('productUrl' in out) out.productUrl = url;
    if (out.sourceUrl) out.sourceUrl = url;
    return out;
  });
}
async function overlayProductView(v, db) {
  if (!v || !v.product || !percent()) return v;
  const canonical = v.canonical;
  const lowest = canonical && canonical.canonicalLowestProductId ? {
    productId: canonical.canonicalLowestProductId,
    vendorItemId: canonical.canonicalLowestVendorItemId,
    mall: canonical.canonicalLowestMall,
    link: canonical.canonicalLowestLink
  } : null;
  const items = lowest ? [v.product, lowest] : [v.product];
  const resolved = await overlay(items, db);
  v.product = resolved[0];
  if (lowest && resolved[1] !== lowest) {
    v.canonical = { ...canonical, canonicalLowestLink: resolved[1].link };
    v.product.canonicalLowestLink = resolved[1].link;
    if (Array.isArray(v.canonical.canonicalOffers)) {
      v.canonical.canonicalOffers = v.canonical.canonicalOffers.map(o =>
        String(o.productId) === String(lowest.productId) &&
        String(o.vendorItemId) === String(lowest.vendorItemId)
          ? { ...o, link: resolved[1].link } : o);
    }
    if (Array.isArray(v.canonical.offers)) {
      v.canonical.offers = v.canonical.offers.map(o =>
        String(o.productId) === String(lowest.productId) &&
        String(o.vendorItemId) === String(lowest.vendorItemId)
          ? { ...o, link: resolved[1].link } : o);
    }
  }
  return v;
}
module.exports = { CHANNEL, percent, key, inRollout, positiveOfficialClick,
  stagedByKey, overlay, overlayProductView };
