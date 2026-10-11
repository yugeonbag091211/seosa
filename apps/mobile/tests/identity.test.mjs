import test from 'node:test';
import assert from 'node:assert/strict';
import { productKey, sameProduct, parseProductKey, hasCompleteIdentity } from '../lib/identity.ts';

// The web's histKey (public/index.html), copied verbatim to pin the contract.
/* eslint-disable no-var */
function webHistKey(it) {
  if (!it || !it.productId) return '';
  var base = String(it.productId) + '|' + String(it.mall || '');
  var vid = it.vendorItemId || '';
  return vid ? base + '|' + vid : base;
}
/* eslint-enable no-var */

test('productKey is byte-identical to the web histKey', () => {
  const cases = [
    { productId: '8082654809', mall: '쿠팡', vendorItemId: '95768196637' },
    { productId: '8082654809', mall: '쿠팡', vendorItemId: '' },
    { productId: 'a1b2c3', mall: 'ADPICK', vendorItemId: '' },
    { productId: '', mall: '쿠팡', vendorItemId: '1' },
  ];
  for (const c of cases) assert.equal(productKey(c), webHistKey(c));
});

test('two options of one Coupang page are different products', () => {
  const a = { productId: '8082654809', mall: '쿠팡', vendorItemId: '95768196637' };
  const b = { productId: '8082654809', mall: '쿠팡', vendorItemId: '91193685703' };
  assert.equal(sameProduct(a, b), false);
  assert.notEqual(productKey(a), productKey(b));
  assert.equal(sameProduct(a, { ...a }), true);
});

test('same productId in another mall is another product', () => {
  assert.equal(sameProduct({ productId: '1', mall: '쿠팡', vendorItemId: '' }, { productId: '1', mall: 'ADPICK', vendorItemId: '' }), false);
});

test('parseProductKey round-trips', () => {
  const a = { productId: '8082654809', mall: '쿠팡', vendorItemId: '95768196637' };
  assert.deepEqual(parseProductKey(productKey(a)), a);
  assert.deepEqual(parseProductKey('abc|ADPICK'), { productId: 'abc', mall: 'ADPICK', vendorItemId: '' });
  assert.equal(parseProductKey('nokey'), null);
});

test('a Coupang row without an option id is incomplete', () => {
  assert.equal(hasCompleteIdentity({ productId: '1', mall: '쿠팡', vendorItemId: '' }), false);
  assert.equal(hasCompleteIdentity({ productId: '1', mall: '쿠팡', vendorItemId: '2' }), true);
  assert.equal(hasCompleteIdentity({ productId: 'h', mall: 'ADPICK', vendorItemId: '' }), true);
});
