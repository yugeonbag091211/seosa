#!/usr/bin/env node
'use strict';
/* Search-only channel canary must not write tagged URLs to legacy catalogue. */
const assert = require('node:assert/strict');
process.env.COUPANG_CHANNEL_ROLLOUT = '1';
process.env.COUPANG_CHANNEL_MODE = 'canary';
process.env.COUPANG_CHANNEL_SUBID = 'SEOSA2026';
process.env.COUPANG_CHANNEL_CANARY_PERCENT = '100';
delete process.env.SEOSA_DB_READONLY;

const shop = require('../api/_shop');
const tagged = {
  mall: '쿠팡', productId: '9369201576', title: '에어팟 프로 3',
  lprice: 296000, oprice: 296000,
  link: 'https://link.coupang.com/re/AFFSDP?lptag=AF8789251&itemId=1&vendorItemId=2&subId=SEOSA2026',
  vendorItemId: '2', _source: 'api'
};
const legacy = {
  ...tagged,
  link: 'https://link.coupang.com/re/AFFSDP?lptag=AF8789251&itemId=1&vendorItemId=2'
};
let passed = 0;
function pass(condition, message) {
  assert.ok(condition, message);
  console.log('[PASS] ' + message);
  passed++;
}
pass(shop.isChannelCanaryProduct(tagged), 'tagged search item classified as transient canary');
pass(!shop.isChannelCanaryProduct(legacy), 'legacy item not classified as canary');
pass(!shop.recordableNonCanary(tagged), 'tagged canary cannot be persisted as a product');
pass(shop.recordableNonCanary(legacy), 'legacy item remains recordable');
pass(shop.recordableNonCanary({ mall: 'ADPICK', link: 'https://biz.adpick.co.kr/r123', _source: 'api' }),
  'ADPICK remains recordable in a channel canary');

(async () => {
  // No DB credentials or mocks are supplied: these two calls MUST return
  // before any read or write; otherwise the test fails closed.
  const saved = await shop.saveProducts('에어팟 프로 3', [tagged], { source: 'search', from: 'api' });
  pass(saved.saved === 0 && saved.skipped === true, 'saveProducts skips canary without DB access');
  const history = await shop.recordPrices([{
    productId: tagged.productId, mall: tagged.mall, keyword: '에어팟 프로 3',
    title: tagged.title, price: tagged.lprice, link: tagged.link,
    vendorItemId: tagged.vendorItemId
  }], { source: 'search' });
  pass(history.saved === 0 && history.recorded === 0,
    'direct recordPrices search path never writes canary');
  console.log('PASS ' + passed + ' / FAIL 0 (offline, database external 0)');
})().catch(e => {
  console.error(e && e.stack || e);
  process.exitCode = 1;
});
