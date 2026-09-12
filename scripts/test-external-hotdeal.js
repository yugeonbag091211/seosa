#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Normalize = require('../api/_hotdeal-sources/normalize');
const Radar = require('../api/_external-hotdeal');

global.fetch = async url => { throw new Error(`offline test made a network request: ${url}`); };

const raw = (over) => ({
  externalId: 'post-1', title: 'Samsung Galaxy S24 SM-S921N 256GB', price: '799,000원',
  originalPrice: '1,100,000원', mall: 'Coupang',
  productUrl: 'https://www.coupang.com/vp/products/123?vendorItemId=777&utm_source=x',
  postUrl: 'https://community.example/deal/1?utm_source=feed#comments',
  imageUrl: 'https://img.example/1.jpg', postedAt: '2026-09-12T01:00:00Z', ...over
});

console.log('=== External Hotdeal Radar (offline) ===');

// 1. normalize
const normalized = Normalize.normalizeExternalHotdeal(raw(), 'community-feed');
assert(normalized);
assert.equal(normalized.price, 799000);
assert.equal(normalized.originalPrice, 1100000);
assert.equal(normalized.mall, '쿠팡');
assert.equal(normalized.canonicalPostUrl, 'https://community.example/deal/1');
assert.equal(Normalize.normalizeExternalHotdeal(raw({ price: '-1원' }), 'x'), null);

// 2. same canonical URL dedupe
const duplicate = Normalize.normalizeExternalHotdeal(raw({ externalId: 'changed', price: 790000,
  postUrl: 'https://community.example/deal/1?utm_medium=social' }), 'community-feed');
const deduped = Normalize.dedupeByCanonicalUrl([normalized, duplicate]);
assert.equal(deduped.length, 1);
assert.equal(deduped[0].price, 790000);

const product = (over) => ({ product_id: 'p1', vendor_item_id: '777', mall: '쿠팡',
  title: 'Samsung Galaxy S24 SM-S921N 256GB',
  link: 'https://www.coupang.com/vp/products/123?vendorItemId=777', ...over });

// 3/4. exact URL and exact model matching
assert.equal(Radar.matchScore(normalized, product()).confidence, 1);
const modelDeal = { ...normalized, productUrl: '', canonicalProductUrl: '' };
const modelMatch = Radar.matchProduct(modelDeal, [product({ link: '' })]);
assert(modelMatch.product);
assert(modelMatch.confidence >= 0.95);
assert.equal(modelMatch.method, 'model');

// 5. quantity mismatch must never be forced
const qty = Radar.matchProduct({ ...normalized, title: '코카콜라 355ml 24캔', productUrl: '' }, [
  product({ title: '코카콜라 355ml 48캔', link: '', vendor_item_id: '' })
]);
assert.equal(qty.product, null);
assert(qty.confidence < Radar.MATCH_THRESHOLD);
assert.match(qty.reason, /수량/);

// 6. capacity mismatch must never be forced
const cap = Radar.matchProduct({ ...normalized, title: '샴푸 500ml 2개', productUrl: '' }, [
  product({ title: '샴푸 1L 2개', link: '', vendor_item_id: '' })
]);
assert.equal(cap.product, null);
assert.match(cap.reason, /용량/);

function history(count, normalPrice, latestPrice) {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    price: i === count - 1 ? latestPrice : normalPrice
  }));
}

// 7/9. score and high-confidence deal
const strongDeal = { ...normalized, price: 70000 };
const exactMatch = { product: product(), confidence: 1, method: 'url', reason: 'url' };
const strong = Radar.verifyDeal(strongDeal, exactMatch, history(14, 100000, 70000), '2026-09-14');
assert(strong.dealScore >= 90, `strong score=${strong.dealScore}`);
assert.equal(strong.verificationStatus, 'STRONG_DEAL');
assert(strong.priceVs30dAvg > 20);

// 8. insufficient history cannot manufacture precision
const insufficient = Radar.verifyDeal(strongDeal, exactMatch, history(2, 100000, 70000), '2026-09-02');
assert(insufficient.dealScore <= 49);
assert.equal(insufficient.verificationStatus, 'INSUFFICIENT_HISTORY');

// An implausible 50%+ plunge is not promoted as a bargain without confirmation.
const suspicious = Radar.verifyDeal({ ...strongDeal, price: 10000 }, exactMatch,
  history(14, 100000, 100000), '2026-09-14');
assert.equal(suspicious.dealScore, 0);
assert.equal(suspicious.verificationStatus, 'SUSPICIOUS_PRICE');

// 10. low-confidence match is not assigned or exposed
const low = Radar.verifyDeal(strongDeal, { product: null, confidence: 0.7 }, history(14, 100000, 70000), '2026-09-14');
assert.equal(low.dealScore, 0);
assert.equal(low.verificationStatus, 'UNMATCHED');

// 3 (cross-source). Keep originals, mark one primary, preserve all sources.
const grouped = Radar.dedupeAcrossSources([
  { source: 'fmkorea', title: normalized.title, price: 70000, productUrl: normalized.productUrl,
    postedAt: '2026-09-12T01:00:00Z', matchedProductId: 'p1', dealScore: 96 },
  { source: 'ppomppu', title: normalized.title, price: 71000, productUrl: normalized.productUrl,
    postedAt: '2026-09-12T04:00:00Z', matchedProductId: 'p1', dealScore: 92 }
]);
assert.equal(grouped.length, 2);
assert.equal(grouped.filter(r => r.isPrimary).length, 1);
assert.equal(grouped[0].sourceCount, 2);
assert.deepEqual(grouped[0].sources.sort(), ['fmkorea', 'ppomppu']);

// Migration safety and adapter policy.
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', '2026-09-12-external-hotdeals.sql'), 'utf8');
assert(migration.includes('create table if not exists external_hotdeals'));
assert(!/\b(drop|truncate)\s+(table\s+)?(products|price_history)\b/i.test(migration.replace(/^\s*--.*$/gm, '')));
assert(migration.includes('enable row level security'));
const registry = require('../api/_hotdeal-sources/registry');
assert.equal(registry.active().length, 0, 'no live source is enabled by default');
assert(fs.existsSync(path.join(__dirname, '..', 'api', '_hotdeal-sources', 'registry.js')),
  'source helpers use the underscore directory and do not consume a Vercel function slot');
assert(!fs.existsSync(path.join(__dirname, '..', 'api', 'hotdeal-sources')),
  'there is no deployable-looking helper directory under api');

console.log('PASS external hotdeal: normalize, URL/source dedupe, model matching, variant guards, score, confidence, grouping, migration safety');
