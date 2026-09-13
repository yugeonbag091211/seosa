import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient } from '../lib/api.ts';
import { asOfLabel, mallColor, priceStats, resultSummary, trendSummary, verdictView } from '../lib/format.ts';

const NOW = Date.parse('2026-09-13T12:00:00+09:00');
const pts = prices => prices.map((price, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, price }));

test('as-of label follows the web wording', () => {
  assert.equal(asOfLabel('2026-09-13T01:00:00+09:00', NOW), '오늘 기준');
  assert.equal(asOfLabel('2026-09-12T01:00:00+09:00', NOW), '어제 기준');
  assert.match(asOfLabel('2026-09-01T01:00:00+09:00', NOW), /^\d\d\.\d\d 기준$/);
  assert.equal(asOfLabel('', NOW), '');
  assert.equal(asOfLabel('not a date', NOW), '');
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
