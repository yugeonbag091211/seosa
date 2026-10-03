'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { replay } = require('./replay-collector-efficiency');
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '../reports/collector-efficiency-baseline.json'), 'utf8').replace(/^\uFEFF/, ''));

test('seven real KST days reproduce conservative savings without manufacturing price gains', () => {
  const report = replay(baseline);
  assert.equal(report.totals.before_search_calls, 34639);
  assert.equal(report.totals.unique_queries, 33583);
  assert.equal(report.totals.saved_search_calls, 1047);
  assert.equal(report.totals.after_search_calls, 33592);
  assert.equal(report.totals.additional_product_attempts, null);
  assert.equal(report.totals.additional_successful_products, null);
  assert.equal(report.totals.after_raw_success_rate, null);
});

test('errors before the first success remain possible retries', () => {
  const report = replay(baseline);
  assert.equal(report.totals.after_duplicate_calls, 9);
  const failedDay = report.days.find(day => day.provider === 'adpick' && day.kst_date === '2026-09-28');
  assert.equal(failedDay.before_duplicate_calls, 2);
  assert.equal(failedDay.saved_search_calls, 0);
});

test('recent cache/checkpoint fixes already removed most duplicate opportunities', () => {
  const report = replay(baseline);
  assert.equal(report.latest_three_days.before_search_calls, 16540);
  assert.equal(report.latest_three_days.saved_search_calls, 10);
  assert.equal(report.latest_three_days.before_duplicate_calls, 12);
});

test('provider budgets remain separate and sum to the whole', () => {
  const report = replay(baseline);
  assert.equal(report.by_provider.coupang.saved_search_calls, 730);
  assert.equal(report.by_provider.adpick.saved_search_calls, 317);
  assert.equal(report.by_provider.coupang.before_search_calls + report.by_provider.adpick.before_search_calls, report.totals.before_search_calls);
});

test('a corrupted histogram is rejected instead of improving the reported number', () => {
  const changed = structuredClone(baseline);
  changed.duplicate_group_histograms[0].safely_reusable_calls_per_query = 0;
  assert.throws(() => replay(changed), /Histogram differs/);
});

test('duplicate provider/day evidence is rejected', () => {
  const changed = structuredClone(baseline);
  changed.days.push(structuredClone(changed.days[0]));
  assert.throws(() => replay(changed), /duplicate provider\/day/);
});

test('replay is deterministic and leaves its evidence unchanged', () => {
  const before = JSON.stringify(baseline);
  assert.deepEqual(replay(baseline), replay(baseline));
  assert.equal(JSON.stringify(baseline), before);
});

// ── Final ledger policy over individual calls (scripts/replay-collector-ledger.js) ──
const { simulate, summarize, outcomeReason } = require('./replay-collector-ledger');
const T0 = Date.parse('2026-10-01T00:00:00Z'), MIN = 60000;
const call = (query, dt, outcome, extra = {}) => ({ provider: 'coupang', kstDate: '2026-10-01', query, at: T0 + dt,
  seq: dt, outcome, http_status: outcome === 'ok' ? 200 : 0, ...extra });

test('final policy: success is reused; canonical variants are one identity', () => {
  const s = summarize(simulate([call('Galaxy  Buds3', 0, 'ok'), call(' galaxy buds3 ', 5 * MIN, 'ok'),
    call('GALAXY BUDS3', 9 * MIN, 'ok')]));
  assert.equal(s.before_calls, 3); assert.equal(s.after_calls, 1); assert.equal(s.normalization_merged_keys, 2);
  assert.equal(s.success_at_risk, 0);
});

test('final policy: a retryable failure gets one retry, only after the 2-minute backoff', () => {
  const s = summarize(simulate([call('q', 0, 'timeout'), call('q', 30000, 'ok'), call('q', 3 * MIN, 'ok'), call('q', 9 * MIN, 'ok')]));
  assert.equal(s.after_calls, 2); assert.equal(s.suppressed_backoff_or_cap, 1); assert.equal(s.success_at_risk, 1);
  const capped = summarize(simulate([call('r', 0, 'network_error'), call('r', 3 * MIN, 'timeout'), call('r', 6 * MIN, 'ok')]));
  assert.equal(capped.after_calls, 2); assert.equal(capped.success_at_risk, 1);
});

test('final policy: 401/403 and parameter errors are terminal; unfinished requests are never repeated', () => {
  const s = summarize(simulate([call('a', 0, 'http_error', { http_status: 401 }), call('a', 10 * MIN, 'ok'),
    call('b', 0, 'param_error'), call('b', 10 * MIN, 'ok'), call('c', 0, 'pending'), call('c', 10 * MIN, 'ok')]));
  assert.equal(s.after_calls, 3); assert.equal(s.suppressed_terminal_or_uncertain, 3); assert.equal(s.success_at_risk, 3);
});

test('historical log outcomes map onto the shared failure vocabulary', () => {
  assert.equal(outcomeReason('coupang', { outcome: 'ok' }), null);
  assert.equal(outcomeReason('coupang', { outcome: 'http_error', http_status: 401 }), 'AUTH_ERROR');
  assert.equal(outcomeReason('coupang', { outcome: 'http_error', http_status: 504 }), 'TIMEOUT');
  assert.equal(outcomeReason('adpick', { outcome: '429', http_status: 429 }), 'RATE_LIMIT');
  assert.equal(outcomeReason('adpick', { outcome: 'other', http_status: 503 }), 'SOURCE_ERROR');
  assert.equal(outcomeReason('coupang', { outcome: 'pending' }), 'UNCERTAIN');
});

test('final-code replay of the real seven days reproduces the aggregate evidence', () => {
  const final = JSON.parse(fs.readFileSync(path.join(__dirname, '../reports/collector-efficiency-final-replay.json'), 'utf8'));
  const c = final.collector_scope;
  assert.equal(c.totals.before_calls, 34639); assert.equal(c.totals.after_calls, 33592);
  assert.equal(c.totals.before_duplicate_calls, 1056); assert.equal(c.totals.after_duplicate_calls, 9);
  assert.equal(c.latest_three_days.before_duplicate_calls, 12); assert.equal(c.latest_three_days.saved_calls, 10);
  assert.equal(c.totals.success_at_risk, 0);
  // Same totals as the aggregate histogram replay above: two independent methods agree.
  const report = replay(baseline);
  assert.equal(c.totals.saved_calls, report.totals.saved_search_calls);
  assert.equal(c.totals.identities, report.totals.unique_queries);
  assert(!JSON.stringify(final).match(/"query"|keyword/), 'aggregate report must not contain query text');
});
