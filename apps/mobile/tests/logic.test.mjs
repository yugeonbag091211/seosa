import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../lib/api.ts';
import { CHART, buildChartModel, formatWon, normalizePoints } from '../lib/chart.ts';
import { SLOW_NOTICE_MS, createSearchSession } from '../lib/searchSession.ts';

const day = n => `2026-08-${String(n).padStart(2, '0')}`;
const inPlot = (model, width) => model.coords.every(c =>
  Number.isFinite(c.x) && Number.isFinite(c.y) && c.y >= CHART.top && c.y <= CHART.bottom && c.x >= 0 && c.x <= width);

/* ── price chart ──────────────────────────────────────────────────── */

test('chart: no usable points means no chart', () => {
  assert.equal(buildChartModel([], 300), null);
  assert.equal(buildChartModel([{ date: day(1), price: 0 }, { date: day(2), price: Number.NaN }], 300), null);
});

test('chart: a single point is centered without a line', () => {
  const model = buildChartModel([{ date: day(1), price: 12900 }], 300);
  assert.equal(model.coords.length, 1);
  assert.equal(model.coords[0].x, 150);
  assert.equal(model.path, '');
  assert.match(model.accessibilityLabel, /가격 기록 1일/);
});

test('chart: flat prices sit on the middle line and are described as unchanged', () => {
  const model = buildChartModel([1, 2, 3].map(n => ({ date: day(n), price: 50000 })), 300);
  assert.equal(model.flat, true);
  assert(model.coords.every(c => c.y === (CHART.top + CHART.bottom) / 2));
  assert.match(model.accessibilityLabel, /변동 없음/);
});

test('chart: unsorted input and repeated dates are normalized (no zigzag, no vertical jump)', () => {
  const points = normalizePoints([
    { date: day(3), price: 3000 }, { date: day(1), price: 1000 }, { date: day(3), price: 4000 }
  ]);
  assert.deepEqual(points, [{ date: day(1), price: 1000 }, { date: day(3), price: 4000 }]);
});

test('chart: only the most recent 30 observation days are drawn', () => {
  const valid = Array.from({ length: 45 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10), price: 1000 + i,
  }));
  const model = buildChartModel(valid, 320);
  assert.equal(model.points.length, 30);
  assert.equal(model.firstDate, valid[15].date);
  assert.equal(model.lastDate, valid[44].date);
});

test('chart: a very large price range stays inside the plot area', () => {
  const model = buildChartModel([{ date: day(1), price: 990 }, { date: day(2), price: 12_000_000 }, { date: day(3), price: 45_000 }], 280);
  assert(inPlot(model, 280));
  assert.equal(model.min, 990);
  assert.equal(model.max, 12_000_000);
});

test('chart: zero width (before layout) still produces finite coordinates', () => {
  const model = buildChartModel([{ date: day(1), price: 1 }, { date: day(2), price: 2 }], 0);
  assert(model.coords.every(c => Number.isFinite(c.x) && Number.isFinite(c.y)));
});

test('chart: won formatting', () => {
  assert.equal(formatWon(1234567), '1,234,567원');
});

/* ── search session ───────────────────────────────────────────────── */

function fakeTimers() {
  const pending = new Map();
  let next = 0;
  return {
    set: (callback, ms) => { const handle = ++next; pending.set(handle, { callback, ms }); return handle; },
    clear: handle => { pending.delete(handle); },
    fireAll: () => { for (const [handle, { callback }] of [...pending]) { pending.delete(handle); callback(); } },
    size: () => pending.size,
    delays: () => [...pending.values()].map(v => v.ms),
  };
}

function controllableSearch() {
  const calls = [];
  const search = (keyword, signal) => new Promise((resolve, reject) => {
    const call = { keyword, signal, resolve, reject };
    calls.push(call);
    signal.addEventListener('abort', () => reject(new ApiError('aborted', 'Request aborted')), { once: true });
  });
  return { calls, search };
}

test('session: the slow notice is 8 seconds', () => {
  assert.equal(SLOW_NOTICE_MS, 8000);
});

test('session: the same keyword while running is not sent twice', async () => {
  const { calls, search } = controllableSearch();
  const session = createSearchSession({ search, timers: fakeTimers() });
  const first = session.run('마우스');
  assert.deepEqual(await session.run(' 마우스 '), { status: 'ignored' });
  assert.equal(calls.length, 1);
  calls[0].resolve([]);
  assert.equal((await first).status, 'success');
});

test('session: a different keyword replaces the running search and the old response is dropped', async () => {
  const { calls, search } = controllableSearch();
  const session = createSearchSession({ search, timers: fakeTimers() });
  const first = session.run('마우스');
  const second = session.run('키보드');
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(await first, { status: 'ignored' });
  calls[1].resolve([{ title: '키보드', lprice: 1, mall: '쿠팡' }]);
  const outcome = await second;
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.keyword, '키보드');
});

test('session: long-wait notice fires only while the search is still running', async () => {
  const timers = fakeTimers();
  const slow = [];
  const { calls, search } = controllableSearch();
  const session = createSearchSession({ search, timers, onSlow: keyword => slow.push(keyword) });
  const pending = session.run('노트북');
  assert.deepEqual(timers.delays(), [SLOW_NOTICE_MS]);
  timers.fireAll();
  assert.deepEqual(slow, ['노트북']);
  calls[0].resolve([]);
  await pending;
  assert.equal(timers.size(), 0, 'timer cleared after completion');

  const later = session.run('모니터');
  calls[1].resolve([]);
  await later;
  timers.fireAll();
  assert.deepEqual(slow, ['노트북'], 'a finished search never shows the notice');
});

test('session: cancel aborts the request, clears the timer, and reports nothing', async () => {
  const timers = fakeTimers();
  const { calls, search } = controllableSearch();
  const session = createSearchSession({ search, timers });
  const pending = session.run('마우스');
  session.cancel();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(session.runningKeyword, null);
  assert.equal(timers.size(), 0);
  assert.deepEqual(await pending, { status: 'ignored' });
});

test('session: errors are returned for the screen, not thrown, and nothing retries', async () => {
  const { calls, search } = controllableSearch();
  const session = createSearchSession({ search, timers: fakeTimers() });
  const pending = session.run('마우스');
  calls[0].reject(new ApiError('unavailable', 'Provider unavailable', 503));
  const outcome = await pending;
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.error.kind, 'unavailable');
  assert.equal(calls.length, 1);
});

test('session: an empty keyword is ignored without a request', async () => {
  const { calls, search } = controllableSearch();
  const session = createSearchSession({ search, timers: fakeTimers() });
  assert.deepEqual(await session.run('   '), { status: 'ignored' });
  assert.equal(calls.length, 0);
});
