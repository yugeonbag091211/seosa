import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiRequest, contextSelectors, trimHistory, MAX_CONTEXT_PRODUCTS } from '../lib/ai.ts';
import { purchaseTarget, AFFILIATE_NOTE } from '../lib/affiliate.ts';
import { buildChart, nearestIndex, defaultRange, availableRanges, withinRange, rangeSummary } from '../lib/chart.ts';
import { toggleSaved, restoreSaved, savedStatus, isSaved, SAVED_LIMIT } from '../lib/savedModel.ts';
import { isSessionUsable, restoreSession, maskEmail } from '../lib/sessionModel.ts';
import { observedLabel, won, kstDate, ageInDays } from '../lib/format.ts';
import { suggestions, pushRecent, suggestKey } from '../lib/suggest.ts';
import { routeForAlert, PUSH_ENABLED } from '../lib/notifications.ts';

const P = (over = {}) => ({
  productId: '1', mall: '쿠팡', vendorItemId: '2', title: '상품', price: 10000, mallLabel: '쿠팡', image: '',
  link: 'https://link.coupang.com/a/abc', listPrice: 0, savePct: 0, collectedAt: '', isRocket: null, trust: null, priceChange: null, ...over,
});

/* ── AI ── */

test('AI context: selectors only, backend mall id, deduped by option, capped at 8', () => {
  const list = [P(), P(), P({ vendorItemId: '3' }), ...Array.from({ length: 10 }, (_, i) => P({ productId: `x${i}` }))];
  const sel = contextSelectors(list);
  assert.equal(sel.length, MAX_CONTEXT_PRODUCTS);
  assert.deepEqual(Object.keys(sel[0]).sort(), ['mall', 'mallId', 'productId', 'ref', 'title', 'vendorItemId']);
  assert.equal(sel[0].mallId, '쿠팡');
  assert.equal(sel[1].vendorItemId, '3');
});

test('AI history: signatures pass through untouched, unsigned assistant turns stay unsigned, last 10 only', () => {
  const h = Array.from({ length: 14 }, (_, i) => (i % 2 ? { role: 'assistant', text: `a${i}`, sig: i === 13 ? 'at1.k.s' : undefined } : { role: 'user', text: `u${i}` }));
  const t = trimHistory(h);
  assert.equal(t.length, 10);
  assert.deepEqual(t[t.length - 1], { role: 'assistant', text: 'a13', sig: 'at1.k.s' });
  assert.equal('sig' in t[t.length - 3], false);
});

test('AI request shape matches the web (question, contextProducts, chatHistory, view, prevTop, prevTopRef)', () => {
  const b = buildAiRequest({ question: '  추천해줘 ', context: [P()], history: [], prevTopProductId: '1', prevTopRef: 'r.e.f' });
  assert.deepEqual(Object.keys(b).sort(), ['chatHistory', 'contextProducts', 'prevTop', 'prevTopRef', 'question', 'view']);
  assert.equal(b.question, '추천해줘');
  assert.equal(b.prevTopRef, 'r.e.f');
  assert.equal(JSON.stringify(b).includes('10000'), false);
});

/* ── Affiliate ── */

test('purchase links are opened exactly as the server sent them', () => {
  const urls = [
    'https://link.coupang.com/re/AFFSDP?lptag=AF1234567&pageKey=8082654809&itemId=2000&vendorItemId=95768196637&traceid=V0-153&requestid=20260930&token=31850C%7CGM',
    'https://link.coupang.com/a/hb5vuuKbV6',
    'https://biz.adpick.co.kr/r4544668',
  ];
  for (const u of urls) assert.equal(purchaseTarget(u, '쿠팡').url, u);
  assert.equal(purchaseTarget('javascript:alert(1)', '쿠팡'), null);
  assert.equal(purchaseTarget('/p/123', '쿠팡'), null);
  assert.equal(purchaseTarget('', '쿠팡'), null);
  assert.equal(purchaseTarget(' https://a.b/c ', '').url, 'https://a.b/c');
});

test('affiliate disclosure text is the web wording', () => {
  assert.equal(AFFILIATE_NOTE, '이 페이지에는 제휴 링크가 포함되어 있으며, 구매 시 SEOSA가 일정 수수료를 제공받습니다.');
});

/* ── Chart ── */

const pts = [
  { date: '2026-09-01', price: 12000 }, { date: '2026-09-02', price: 11000 },
  { date: '2026-09-20', price: 13000 }, { date: '2026-09-29', price: 9000 },
];

test('chart: x follows calendar days, so collection gaps stay visible', () => {
  const m = buildChart(pts, 300, 100, { top: 0, bottom: 0, left: 0, right: 0 });
  assert.equal(m.points[0].x, 0);
  assert.equal(m.points[3].x, 300);
  assert.ok(m.points[1].x < 15);        // one day in 28
  assert.equal(m.min, 9000);
  assert.equal(m.max, 13000);
  // max near the top and min near the bottom, with headroom so neither sits on the frame
  assert.ok(m.points[2].y > 0 && m.points[2].y < 10);
  assert.ok(m.points[3].y < 100 && m.points[3].y > 90);
});

test('chart: scrubbing snaps to a real point', () => {
  const m = buildChart(pts, 280, 100);
  assert.equal(nearestIndex(m, 0), 0);
  assert.equal(nearestIndex(m, 10_000), 3);
  assert.equal(m.points[nearestIndex(m, 200)].price, 13000);
});

test('chart: flat and single-point series do not divide by zero', () => {
  const flat = buildChart([{ date: '2026-09-01', price: 5000 }, { date: '2026-09-02', price: 5000 }], 100, 50);
  assert.ok(flat.flat);
  assert.ok(flat.points.every(p => Number.isFinite(p.y)));
  const one = buildChart([{ date: '2026-09-01', price: 5000 }], 100, 50);
  assert.ok(Number.isFinite(one.points[0].x));
  assert.equal(buildChart([], 100, 50), null);
});

test('chart: ranges start at the shortest that shows everything', () => {
  assert.equal(defaultRange(pts), 30);
  // The last 7 days hold one point only — a tab that shows a single dot is not offered.
  assert.equal(withinRange(pts, 7).length, 1);
  assert.deepEqual(availableRanges(pts), [30]);
  const dense = Array.from({ length: 40 }, (_, i) => ({ date: `2026-08-${String(i % 31 + 1).padStart(2, '0')}`, price: 1000 + i }))
    .concat(Array.from({ length: 29 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, price: 900 + i })));
  assert.deepEqual(availableRanges(dense.filter((p, i, a) => a.findIndex(q => q.date === p.date) === i).sort((a, b) => (a.date < b.date ? -1 : 1))), [7, 30, 90]);
  assert.equal(defaultRange([{ date: '2026-01-01', price: 1 }, { date: '2026-09-01', price: 1 }]), 365);
  const s = rangeSummary(pts);
  assert.deepEqual([s.low, s.high, s.lowDate, s.change], [9000, 13000, '2026-09-29', -3000]);
  assert.equal(rangeSummary([{ date: '2026-09-10', price: 5 }, { date: '2026-09-20', price: 9 }, { date: '2026-09-30', price: 5 }]).lowDate, '2026-09-30');
});

/* ── Saved ── */

test('saved: two options of one page are two items; toggling removes only that option', () => {
  let list = toggleSaved([], P());
  list = toggleSaved(list, P({ vendorItemId: '3' }));
  assert.equal(list.length, 2);
  list = toggleSaved(list, P());
  assert.equal(list.length, 1);
  assert.equal(list[0].vendorItemId, '3');
  assert.ok(isSaved(list, { productId: '1', mall: '쿠팡', vendorItemId: '3' }));
});

test('saved: stored data is validated on restore', () => {
  const good = { productId: '1', mall: '쿠팡', vendorItemId: '2', title: 't', savedPrice: 100, savedAt: 'x', link: 'javascript:x' };
  const r = restoreSaved([good, good, { productId: '2' }, null, 'x', { ...good, savedPrice: 0, productId: '9' }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].link, '');
  assert.deepEqual(restoreSaved('garbage'), []);
  const many = Array.from({ length: SAVED_LIMIT + 20 }, (_, i) => ({ ...good, productId: `p${i}` }));
  assert.equal(restoreSaved(many).length, SAVED_LIMIT);
});

test('saved: latest price comes only from server points', () => {
  const [item] = toggleSaved([], P({ price: 10000 }));
  assert.deepEqual(savedStatus(item, []), { latest: null, change: null });
  assert.equal(savedStatus(item, [{ date: '2026-09-29', price: 9000 }]).change, -1000);
});

/* ── Session ── */

test('session: expired or malformed tokens are not used', () => {
  const now = Date.parse('2026-09-30T00:00:00Z');
  const ok = { token: 'v1.eyJlIjoiYSJ9.c2lnbmF0dXJl', email: 'a@b.co', expiresAt: '2026-10-30T00:00:00Z' };
  assert.ok(isSessionUsable(ok, now));
  assert.equal(isSessionUsable({ ...ok, expiresAt: '2026-09-29T00:00:00Z' }, now), false);
  assert.equal(isSessionUsable({ ...ok, token: 'short' }, now), false);
  assert.equal(isSessionUsable({ ...ok, token: 'has space in it and long enough' }, now), false);
  assert.deepEqual(restoreSession(JSON.stringify(ok), now), ok);
  assert.equal(restoreSession('{oops', now), null);
  assert.equal(restoreSession(null, now), null);
  assert.equal(maskEmail('yugeon@gmail.com'), 'yu****@gmail.com');
});

/* ── Format ── */

test('observation labels use the KST calendar', () => {
  const now = Date.parse('2026-09-30T03:00:00Z');                     // 12:00 KST, 9/30
  assert.equal(observedLabel('2026-09-29T15:30:00Z', now), '오늘');   // 00:30 KST 9/30
  assert.equal(observedLabel('2026-09-29T14:30:00Z', now), '어제');   // 23:30 KST 9/29
  assert.equal(observedLabel('2026-09-20', now), '9월 20일');
  assert.equal(observedLabel('', now), '');
  assert.equal(kstDate('2026-09-29T15:00:00Z'), '2026-09-30');
  assert.equal(ageInDays('2026-09-27', now), 3);
  assert.equal(won(0), '');
  assert.equal(won(15900), '15,900원');
});

/* ── Suggestions ── */

test('autocomplete: only real keywords, spacing-insensitive, prefix first', () => {
  const s = suggestions('무선이어', ['무선 이어폰'], ['블루투스 무선이어폰', '무선 이어폰', '마우스']);
  assert.deepEqual(s.map(x => x.keyword), ['무선 이어폰', '블루투스 무선이어폰']);
  assert.equal(s[0].kind, 'recent');
  assert.deepEqual(suggestions('', ['a'], ['b']), []);
  assert.equal(suggestKey('ＬＧ 그램!'), 'lg그램');
  assert.deepEqual(pushRecent(['A', 'b c'], 'bc'), ['bc', 'A']);
});

/* ── Push (prepared, off) ── */

test('push stays off and routes to the exact option', () => {
  assert.equal(PUSH_ENABLED, false);
  assert.equal(routeForAlert({ kind: 'big_drop', productId: '1', mall: '쿠팡', vendorItemId: '2', title: '', body: '' }), `/product/${encodeURIComponent('1|쿠팡|2')}`);
  assert.equal(routeForAlert({ kind: 'big_drop', productId: 'h', mall: 'ADPICK', vendorItemId: '', title: '', body: '' }), `/product/${encodeURIComponent('h|ADPICK')}`);
});
