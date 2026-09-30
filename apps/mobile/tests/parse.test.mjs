import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProduct, parseProducts, parseTodayDrop, parsePoints, parseDeal, parseAiAnswer, safeUrl } from '../lib/parse.ts';

const COUPANG_LINK = 'https://link.coupang.com/re/AFFSDP?lptag=AF1234567&pageKey=8082654809&itemId=2000&vendorItemId=95768196637&traceid=V0-153';

const row = (over = {}) => ({
  title: '삼성 &amp; LG 모니터', lprice: 15900, mall: '쿠팡', mallLabel: '', productId: '8082654809',
  vendorItemId: '95768196637', link: COUPANG_LINK, image: 'https://thumbnail.coupangcdn.com/x.jpg', oprice: 19900, savePct: 20,
  ...over,
});

test('product keeps identity and the exact affiliate link', () => {
  const p = parseProduct(row());
  assert.equal(p.link, COUPANG_LINK);
  assert.equal(p.vendorItemId, '95768196637');
  assert.equal(p.mall, '쿠팡');
  assert.equal(p.mallLabel, '쿠팡');
  assert.equal(p.title, '삼성 & LG 모니터');
  assert.equal(p.price, 15900);
  assert.equal(p.listPrice, 19900);
});

test('rows without id, mall, title or a positive price are dropped — never shown as 0원', () => {
  assert.equal(parseProduct(row({ lprice: 0 })), null);
  assert.equal(parseProduct(row({ lprice: -1 })), null);
  assert.equal(parseProduct(row({ lprice: 'abc' })), null);
  assert.equal(parseProduct(row({ productId: '' })), null);
  assert.equal(parseProduct(row({ mall: '' })), null);
  assert.equal(parseProduct(row({ title: '' })), null);
  assert.equal(parseProducts([row(), null, row({ lprice: 0 }), 'x']).length, 1);
});

test('list price only when it is above the price', () => {
  assert.equal(parseProduct(row({ oprice: 15900 })).listPrice, 0);
  assert.equal(parseProduct(row({ oprice: 10000 })).savePct, 0);
});

test('unsafe links and images are removed, not rewritten', () => {
  const p = parseProduct(row({ link: 'javascript:alert(1)', image: '//cdn/x.jpg' }));
  assert.equal(p.link, '');
  assert.equal(p.image, '');
  assert.equal(safeUrl('  https://a.b/c?x=1&y=%20 '), 'https://a.b/c?x=1&y=%20');
});

test('priceChange is kept only when it describes this exact price', () => {
  const ok = parseProduct(row({ priceChange: { prevPrice: 19000, currentPrice: 15900, dropAmount: 3100, dropPct: 16, isAllTimeLow: true } }));
  assert.deepEqual(ok.priceChange, { prevPrice: 19000, dropAmount: 3100, dropPct: 16, isAllTimeLow: true });
  // The view row lags: its current price is another observation (or another option).
  const stale = parseProduct(row({ priceChange: { prevPrice: 50000, currentPrice: 44490, dropAmount: 5510, dropPct: 11 } }));
  assert.equal(stale.priceChange, null);
  const up = parseProduct(row({ priceChange: { prevPrice: 15000, currentPrice: 15900, dropAmount: 0, dropPct: 0 } }));
  assert.equal(up.priceChange, null);
});

const drop = (over = {}) => ({
  id: 'today:1', productId: '1', mall: '쿠팡', vendorItemId: '9', title: 'T', image: '', mallLabel: '',
  currentPrice: 9000, previousPrice: 10000, dropAmount: 1000, dropPct: 10, verified: false, link: COUPANG_LINK,
  recordedAt: '2026-09-30T01:00:00Z', previousAt: '2026-09-29T01:00:00Z', ...over,
});

test('today-drop cards pass through the server numbers unchanged', () => {
  const d = parseTodayDrop(drop());
  assert.equal(d.currentPrice, 9000);
  assert.equal(d.previousPrice, 10000);
  assert.equal(d.dropAmount, 1000);
  assert.equal(d.dropPct, 10);
  assert.equal(d.link, COUPANG_LINK);
});

test('today-drop cards with missing or inconsistent numbers are dropped, not repaired', () => {
  assert.equal(parseTodayDrop(drop({ previousPrice: 0 })), null);
  assert.equal(parseTodayDrop(drop({ dropPct: null })), null);
  assert.equal(parseTodayDrop(drop({ previousPrice: 9000 })), null);         // not a drop
  assert.equal(parseTodayDrop(drop({ dropAmount: 5000 })), null);            // does not add up
  assert.equal(parseTodayDrop(drop({ productId: '' })), null);
  assert.ok(parseTodayDrop(drop({ dropAmount: 1001 })));                     // rounding tolerance of 1원
});

test('points: sorted, lowest per day, invalid dropped', () => {
  const pts = parsePoints([
    { date: '2026-09-29', price: 12000 }, { date: '2026-09-28', price: 13000 },
    { date: '2026-09-29', price: 11000 }, { date: 'bad', price: 1 }, { date: '2026-09-27', price: 0 },
  ]);
  assert.deepEqual(pts, [{ date: '2026-09-28', price: 13000 }, { date: '2026-09-29', price: 11000 }]);
});

test('deal keeps server text verbatim and ignores non-strings', () => {
  const d = parseDeal({ verdict: 'BUY', label: '지금 사도 좋아요', reasons: ['30일 평균보다 12% 낮아요', 3, ''], cautions: [], stats: { low: 9000, high: 12000, avg30: 10000 } });
  assert.equal(d.label, '지금 사도 좋아요');
  assert.deepEqual(d.reasons, ['30일 평균보다 12% 낮아요']);
  assert.equal(d.stats.low, 9000);
  assert.equal(parseDeal({ label: 'x' }), null);
});

test('AI answer keeps the signature and the signed recommendation ref', () => {
  const a = parseAiAnswer({ text: '추천', turnSig: 'at1.x.y', topProductId: '1', topRecommendationRef: 'rr1.a.b', guest: true, items: [row()], followups: ['더 싼 거', { x: 1 }] });
  assert.equal(a.turnSig, 'at1.x.y');
  assert.equal(a.topRecommendationRef, 'rr1.a.b');
  assert.equal(a.items.length, 1);
  assert.deepEqual(a.followups, ['더 싼 거']);
  assert.equal(parseAiAnswer({ error: 'x' }), null);
});
