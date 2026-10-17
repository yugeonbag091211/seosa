import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeSearchResults } from '../lib/searchSort.ts';

const P = (over = {}) => ({
  productId: '1', mall: '쿠팡', vendorItemId: '1', title: '상품', price: 10_000,
  mallLabel: '쿠팡', image: '', link: 'https://link.coupang.com/a/test', listPrice: 0,
  savePct: 0, collectedAt: '', isRocket: null, trust: null, priceChange: null, ...over,
});

test('search sort: relevance preserves the server order without returning the same array', () => {
  const items = [P({ productId: 'a' }), P({ productId: 'b' }), P({ productId: 'c' })];
  const arranged = arrangeSearchResults(items, 'relevance');
  assert.deepEqual(arranged.map(x => x.productId), ['a', 'b', 'c']);
  assert.notEqual(arranged, items);
});

test('search sort: low price is ascending and stable on ties', () => {
  const items = [
    P({ productId: 'a', price: 20_000 }),
    P({ productId: 'b', price: 9_000 }),
    P({ productId: 'c', price: 9_000 }),
  ];
  assert.deepEqual(arrangeSearchResults(items, 'price').map(x => x.productId), ['b', 'c', 'a']);
});

test('search sort: biggest verified drop uses percentage first, amount second, no-drop rows last', () => {
  const items = [
    P({ productId: 'none', priceChange: null }),
    P({ productId: 'pct10-small', priceChange: { prevPrice: 11_000, dropAmount: 1_000, dropPct: 10, isAllTimeLow: false } }),
    P({ productId: 'pct20', priceChange: { prevPrice: 12_000, dropAmount: 2_000, dropPct: 20, isAllTimeLow: false } }),
    P({ productId: 'pct10-big', priceChange: { prevPrice: 15_000, dropAmount: 5_000, dropPct: 10, isAllTimeLow: true } }),
  ];
  assert.deepEqual(arrangeSearchResults(items, 'drop').map(x => x.productId), ['pct20', 'pct10-big', 'pct10-small', 'none']);
});

test('search sort: never mutates the server result order', () => {
  const items = [P({ productId: 'a', price: 30_000 }), P({ productId: 'b', price: 10_000 })];
  arrangeSearchResults(items, 'price');
  assert.deepEqual(items.map(x => x.productId), ['a', 'b']);
});
