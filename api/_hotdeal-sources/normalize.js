'use strict';

const crypto = require('crypto');
const HD = require('../_hotdeal');
const { normalizeMall } = require('../_hotsource');

const TRACKING_KEYS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'ref', 'referrer', 'affiliate', 'aff', 'affid'
]);

function canonicalUrl(value) {
  const safe = HD.safeUrl(value);
  if (!safe) return '';
  try {
    const url = new URL(safe);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_KEYS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function normalizedTitle(value) {
  return HD.cleanTitle(value, 300)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePostedAt(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Common external adapter result. Invalid rows never reach matching. */
function normalizeExternalHotdeal(raw, source) {
  const r = raw || {};
  const title = HD.cleanTitle(r.title, 300);
  const price = HD.toKRW(r.price);
  const externalId = HD.cleanTitle(r.externalId || r.id, 160);
  const postUrl = HD.safeUrl(r.postUrl || r.sourceUrl);
  const productUrl = HD.safeUrl(r.productUrl || r.url);
  const postedAt = normalizePostedAt(r.postedAt);
  if (!title || !price || !externalId || !postUrl || !postedAt) return null;

  const originalRaw = HD.toKRW(r.originalPrice);
  return {
    source: String(source || r.source || 'unknown').slice(0, 60),
    externalId,
    title,
    normalizedTitle: normalizedTitle(title),
    price,
    originalPrice: originalRaw && originalRaw > price ? originalRaw : null,
    mall: normalizeMall(r.mall),
    productUrl,
    postUrl,
    canonicalProductUrl: canonicalUrl(productUrl),
    canonicalPostUrl: canonicalUrl(postUrl),
    imageUrl: HD.safeUrl(r.imageUrl || r.image),
    postedAt,
    fetchedAt: new Date().toISOString(),
    metadata: r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
      ? r.metadata : {}
  };
}

/**
 * Same-source duplicate removal. A post is the same post when either its
 * provider id or its canonical post URL repeats. The first provider id seen
 * is kept so the (source, source_post_id) upsert key never shifts between runs,
 * and a batch never carries two rows for one conflict key (Postgres rejects that).
 */
function dedupeByCanonicalUrl(rows) {
  const slots = new Map();
  const out = [];
  for (const row of (rows || []).filter(Boolean)) {
    const keys = [`${row.source}|id:${row.externalId}`];
    if (row.canonicalPostUrl) keys.push(`${row.source}|url:${row.canonicalPostUrl}`);
    const hit = keys.find(key => slots.has(key));
    if (hit === undefined) {
      keys.forEach(key => slots.set(key, out.length));
      out.push(row);
      continue;
    }
    const idx = slots.get(hit);
    keys.forEach(key => { if (!slots.has(key)) slots.set(key, idx); });
    if (row.price < out[idx].price) out[idx] = { ...row, externalId: out[idx].externalId };
  }
  return out;
}

function stableKey(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

module.exports = {
  canonicalUrl, normalizedTitle, normalizeExternalHotdeal, dedupeByCanonicalUrl, stableKey
};
