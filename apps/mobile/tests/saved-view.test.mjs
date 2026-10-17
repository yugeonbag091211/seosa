import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeSaved, savedCurrentPrice, savedKey } from '../lib/savedModel.ts';

const S = (over = {}) => ({
  productId: 'p1',
  mall: '쿠팡',
  vendorItemId: 'v1',
  title: '상품',
  mallLabel: '쿠팡',
  image: '',
  link: 'https://link.coupang.com/a/test',
  savedPrice: 10_000,
  savedAt: '2026-10-10T00:00:00.000Z',
  ...over,
});

const point = (price, date = '2026-10-17') => [{ date, price }];

test('saved view: recent sort is deterministic and never mutates persisted order', () => {
  const old = S({ productId: 'old', savedAt: '2026-10-01T00:00:00.000Z' });
  const newest = S({ productId: 'new', savedAt: '2026-10-15T00:00:00.000Z' });
  const middle = S({ productId: 'mid', savedAt: '2026-10-08T00:00:00.000Z' });
  const persisted = [old, newest, middle];

  const arranged = arrangeSaved(persisted, undefined, 'recent');
  assert.deepEqual(arranged.map(x => x.productId), ['new', 'mid', 'old']);
  assert.deepEqual(persisted.map(x => x.productId), ['old', 'new', 'mid']);
});

test('saved view: biggest price decrease comes first and unknown latest prices go last', () => {
  const a = S({ productId: 'a', savedPrice: 10_000 });
  const b = S({ productId: 'b', savedPrice: 20_000 });
  const c = S({ productId: 'c', savedPrice: 5_000 });
  const d = S({ productId: 'd', savedPrice: 7_000 });
  const latest = {
    [savedKey(a)]: point(8_000),   // -2,000
    [savedKey(b)]: point(19_500),  // -500
    [savedKey(c)]: point(5_500),   // +500
    // d deliberately has no server observation
  };

  assert.deepEqual(arrangeSaved([b, d, c, a], latest, 'drop').map(x => x.productId), ['a', 'b', 'c', 'd']);
});

test('saved view: dropped-only requires a real latest observation below saved price', () => {
  const down = S({ productId: 'down', savedPrice: 10_000 });
  const same = S({ productId: 'same', savedPrice: 10_000 });
  const up = S({ productId: 'up', savedPrice: 10_000 });
  const unknown = S({ productId: 'unknown', savedPrice: 10_000 });
  const latest = {
    [savedKey(down)]: point(9_000),
    [savedKey(same)]: point(10_000),
    [savedKey(up)]: point(11_000),
  };

  assert.deepEqual(arrangeSaved([same, unknown, up, down], latest, 'recent', true).map(x => x.productId), ['down']);
});

test('saved view: low-price sort uses latest observed price and falls back explicitly to saved-time price', () => {
  const latestCheap = S({ productId: 'latest-cheap', savedPrice: 30_000 });
  const savedCheap = S({ productId: 'saved-cheap', savedPrice: 9_000 });
  const expensive = S({ productId: 'expensive', savedPrice: 12_000 });
  const latest = {
    [savedKey(latestCheap)]: point(8_000),
    [savedKey(expensive)]: point(15_000),
  };

  assert.equal(savedCurrentPrice(latestCheap, latest[savedKey(latestCheap)]), 8_000);
  assert.equal(savedCurrentPrice(savedCheap, undefined), 9_000);
  assert.deepEqual(arrangeSaved([expensive, savedCheap, latestCheap], latest, 'price').map(x => x.productId), ['latest-cheap', 'saved-cheap', 'expensive']);
});
