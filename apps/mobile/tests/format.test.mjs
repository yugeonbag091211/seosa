import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient } from '../lib/api.ts';
import { asOfLabel, mallColor, priceStats, productDetailView, resultSummary, trendSummary, verdictView } from '../lib/format.ts';

const NOW = Date.parse('2026-09-13T12:00:00+09:00');
const pts = prices => prices.map((price, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, price }));

test('as-of label follows the web wording', () => {
  assert.equal(asOfLabel('2026-09-13T01:00:00+09:00', NOW), '오늘 기준');
  assert.equal(asOfLabel('2026-09-12T01:00:00+09:00', NOW), '어제 기준');
  assert.match(asOfLabel('2026-09-01T01:00:00+09:00', NOW), /^\d\d\.\d\d 기준$/);
  assert.equal(asOfLabel('', NOW), '');
  assert.equal(asOfLabel('not a date', NOW), '');
});

test('as-of label compares KST calendar dates, not elapsed 24h buckets', () => {
  // Collected 23:50 KST yesterday, "now" is 00:10 KST today: 20 minutes elapsed but the
  // calendar day already changed, so it must read "어제", not "오늘".
  const justAfterMidnight = Date.parse('2026-09-13T00:10:00+09:00');
  assert.equal(asOfLabel('2026-09-12T23:50:00+09:00', justAfterMidnight), '어제 기준');

  // Collected 23:00 KST two calendar days back; only 26 hours elapsed but two midnights were
  // crossed, so it must be dated, not read as "어제".
  const twoDaysLater = Date.parse('2026-09-13T01:00:00+09:00');
  assert.equal(asOfLabel('2026-09-11T23:00:00+09:00', twoDaysLater), '09.11 기준');

  // A clock-skewed future timestamp has no "day" label of its own; treat it as today's.
  assert.equal(asOfLabel('2026-09-14T09:00:00+09:00', NOW), '오늘 기준');

  // Malformed but non-empty strings never throw or produce a label.
  assert.equal(asOfLabel('2026-13-99', NOW), '');
});

test('mall dot colors only for brands the web verified', () => {
  assert.deepEqual(mallColor('쿠팡'), { token: 'coupang' });
  assert.deepEqual(mallColor('알리'), { token: 'ali' });
  assert.deepEqual(mallColor('오늘의집'), { hex: '#00a1ff' });
  assert.equal(mallColor('ADPICK'), null);
  assert.equal(mallColor(undefined), null);
});

test('verdict view: collecting under two points, server text otherwise', () => {
  assert.equal(verdictView(1, { verdict: 'BUY', label: 'x', reasons: [], cautions: [] }).head, '가격 추이를 수집하고 있어요');
  const buy = verdictView(5, { verdict: 'GOOD_BUY', label: '싼 편이다', reasons: ['30일 평균보다 낮다'], cautions: ['옵션이 섞였다'] });
  assert.equal(buy.tone, 'buy');
  assert.equal(buy.line, '30일 평균보다 낮다 · 옵션이 섞였다');
  const wait = verdictView(5, { verdict: 'DONT_BUY', label: '지금은 비싸다', reasons: [], cautions: [] });
  assert.equal(wait.tone, 'wait');
  assert.equal(wait.line, '지금은 비싸다');
  assert.equal(verdictView(5, { verdict: 'SOMETHING_NEW', label: 'l', reasons: [], cautions: [] }).head, '아직 판단하기 어려워요');
  assert.equal(verdictView(5, null), null);
});

test('trend summary mirrors the web PRICE TREND box', () => {
  assert.equal(trendSummary(pts([15900]), null), null);
  const flat = trendSummary(pts([15900, 15900]), { verdict: 'UNKNOWN', label: '' });
  assert.equal(flat.label, '거의 변동 없음');
  assert.equal(flat.recent, '최근 7일 안정세');
  assert.match(flat.position, /충분하지 않아/);
  const down = trendSummary(pts([20000, 19000, 18000]), { verdict: 'GOOD_BUY', label: '싼 편이다' });
  assert.equal(down.tone, 'down');
  assert.equal(down.label, '10.0% 하락 ↓');
  assert.equal(down.recent, '📉 최근 3일 연속 하락 중');
  assert.equal(down.position, '↘ 싼 편이다');
  assert.equal(trendSummary(pts([10000, 12000]), null).label, '20.0% 상승 ↑');
});

test('price stats and result summary ignore invalid prices', () => {
  assert.deepEqual(priceStats(pts([15000, 0, 17000])), { min: 15000, avg: 16000, max: 17000 });
  assert.equal(priceStats([]), null);
  assert.deepEqual(resultSummary([9900, 139000, Number.NaN, 20000]), { min: 9900, max: 139000, count: 3 });
  assert.equal(resultSummary([]), null);
});

test('product detail view derives verdict count, trend, and stats from the same normalized points', () => {
  // The server sent a duplicate date (last write wins) and an unsorted, invalid-price entry.
  // Every metric must agree on the same 3-day series, not a mix of raw and normalized points.
  const raw = [
    { date: '2026-09-01', price: 20000 },
    { date: '2026-09-03', price: 16000 },
    { date: '2026-09-02', price: 18000 },
    { date: '2026-09-01', price: 21000 }, // duplicate date: overwrites the first 2026-09-01 point
    { date: '2026-09-04', price: 0 },     // invalid price: dropped entirely
  ];
  const deal = { verdict: 'GOOD_BUY', label: '싼 편이다', reasons: ['30일 평균보다 낮다'], cautions: [] };
  const view = productDetailView(raw, deal);

  assert.equal(view.count, 3, 'one point per calendar day, invalid price dropped');
  assert.deepEqual(view.observations.map(p => p.date), ['2026-09-03', '2026-09-02', '2026-09-01']);
  assert.equal(view.observations[2].price, 21000, 'duplicate date keeps the later write');
  assert.deepEqual(view.stats, { min: 16000, avg: 18333, max: 21000 });
  assert.equal(view.trend.days, 3);
  assert.equal(view.verdict.tone, 'buy');

  // Fewer than 2 usable points (after dropping duplicates/invalids) means no trend or stats,
  // and the verdict falls back to "still collecting" even though raw had more entries.
  const thin = productDetailView([{ date: '2026-09-01', price: 100 }, { date: '2026-09-01', price: 200 }, { date: '2026-09-02', price: 0 }], deal);
  assert.equal(thin.count, 1);
  assert.equal(thin.trend, null);
  assert.equal(thin.stats.avg, 200, 'stats still compute from the single valid point');
  assert.equal(thin.verdict.head, '가격 추이를 수집하고 있어요');
});

test('product detail stats cover the full server history, not just the chart\'s 30-day window', () => {
  // 45 daily points: the all-time low (day 1) falls outside the chart's most-recent-30 window.
  const raw = pts(Array.from({ length: 45 }, (_, i) => (i === 0 ? 5000 : 20000 + i)));
  const deal = { verdict: 'NORMAL', label: '평범한 가격', reasons: [], cautions: [] };
  const view = productDetailView(raw, deal);

  assert.equal(view.count, 45, 'every observation day counts, not only the last 30');
  assert.equal(view.stats.min, 5000, 'an all-time low older than 30 days must still surface');
  // Trend describes what the chart is actually drawing (its most-recent-30 window), not the
  // full 45-day history stats cover.
  assert.equal(view.trend.days, 30);
});

test('product detail trend matches the chart\'s 30-day window even when it disagrees with the full history', () => {
  // 45 daily points where the full history is a net rise (day 1 low, day 45 high) but the last
  // 30 days — exactly what PriceChart draws — are a steady decline. Trend must describe the
  // chart, not the full history, or the text and the picture would tell opposite stories.
  const first15 = [10000, ...Array(14).fill(30000)];
  const last30 = Array.from({ length: 30 }, (_, i) => 30000 - i * 350); // day16..day45: 30000 → 19850
  const raw = pts([...first15, ...last30]);
  const deal = { verdict: 'NORMAL', label: '평범한 가격', reasons: [], cautions: [] };
  const view = productDetailView(raw, deal);

  assert.equal(view.count, 45);
  // Full-history direction (day 1 → day 45) would be "up"; the visible chart window is "down".
  assert.equal(view.trend.tone, 'down');
  assert.equal(view.trend.days, 30);
});

const initPayload = {
  popular: [{ keyword: '무선 이어폰', count: 9 }, { keyword: '' }, 7],
  priceDrop: [
    { title: '손선풍기', mall: '쿠팡', mallLabel: '', productId: '1', lprice: 19800, oprice: 45300, savePct: 56.3, isAllTimeLow: true, trust: { level: 'high', label: '신뢰 높음', summary: '15시간 전', reasons: [{ kind: 'good', text: '확인됨' }, { bad: 1 }] } },
    { title: 'broken' },
  ],
  daily: { keyword: '아이패드 11프로 케이스', products: [{ title: '케이스', lprice: 15900, mall: '쿠팡', productId: '2', collectedAt: '2026-09-13T01:00:00Z', savePct: '12' }] },
  monthly: { month: 9, title: '가을의 시작', subtitle: '선선한 바람', products: [] },
};

test('home reads /api/init and keeps each section independently', async () => {
  const client = createApiClient(async url => {
    assert.equal(new URL(url).pathname, '/api/init');
    return new Response(JSON.stringify(initPayload));
  });
  const feed = await client.home();
  assert.deepEqual(feed.keywords, ['무선 이어폰']);
  assert.equal(feed.drops.length, 1);
  assert.equal(feed.drops[0].savePct, 56.3);
  assert.equal(feed.drops[0].isAllTimeLow, true);
  assert.equal(feed.drops[0].mallLabel, undefined, 'empty label falls back to mall on screen');
  assert.deepEqual(feed.drops[0].trust.reasons, [{ kind: 'good', text: '확인됨' }]);
  assert.equal(feed.daily.keyword, '아이패드 11프로 케이스');
  assert.equal(feed.daily.products[0].savePct, undefined, 'string savePct is dropped, not coerced');
  assert.equal(feed.monthly.title, '가을의 시작');
  assert.equal(feed.monthly.products.length, 0);
});

test('home: all-malformed payload is an error, an empty payload is not', async () => {
  const broken = createApiClient(async () => new Response(JSON.stringify({ priceDrop: [{ title: 'x' }], daily: { keyword: 'k', products: [{}] } })));
  await assert.rejects(broken.home(), error => error instanceof ApiError && error.kind === 'invalid_response');
  const empty = createApiClient(async () => new Response(JSON.stringify({ popular: [], priceDrop: [], daily: null, monthly: null })));
  assert.deepEqual(await empty.home(), { keywords: [], drops: [], daily: null, monthly: null });
  const notObject = createApiClient(async () => new Response('[]'));
  await assert.rejects(notObject.home(), error => error.kind === 'invalid_response');
});

test('home uses the 12s home timeout and maps 5xx to unavailable', async () => {
  const outage = createApiClient(async () => new Response('', { status: 502 }));
  await assert.rejects(outage.home(), error => error.kind === 'unavailable');
  const slow = createApiClient((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }), { homeMs: 5 });
  await assert.rejects(slow.home(), error => error.kind === 'timeout');
});
