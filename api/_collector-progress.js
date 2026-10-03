'use strict';

// Daily collection state is independent of a job's cursor, target signature or worker.
// This is deliberately opt-in until the additive migration is verified everywhere.
const crypto = require('crypto');
const defaultDb = require('./_supabase');
const { kstToday } = require('./_kst');
const { vendorIdOf } = require('./_price');
const Query = require('./_collector-query');
const Failure = require('./_collector-failure');

/*
 * Per product, per provider, per KST day (see docs/collector-efficiency-architecture.md):
 *   transient failures (request left, no response)  ≤ MAX_TRANSIENT_FAILURES
 *   distinct evaluated queries                       ≤ MAX_PRODUCT_QUERIES (backstop; the
 *                                                     recovery ladder's own caps are lower)
 *   alternates after the first option/ambiguous miss ≤ MAX_ALTERNATES_AFTER_MISMATCH
 * The same query is never evaluated twice for a product on the same day.
 */
const MAX_TRANSIENT_FAILURES = 3;
const MAX_PRODUCT_QUERIES = 16;
const MAX_ALTERNATES_AFTER_MISMATCH = 1;
const BACKOFF_MS = Query.RETRY_MS;
const normalizeQuery = q => Query.queryIdentity(q);
const productKey = p => `${p.product_id}|${p.mall}`;
const enabled = () => process.env.PRICE_QUERY_LEDGER === '1';
const failureReason = reason => Failure.classify(reason) || 'UNKNOWN';
// Query states where no request was made for these targets and nothing is known about them.
const NOT_EVALUATED = new Set(['inflight', 'unavailable']);

/** Why this product may not be searched with `query` now (null = it may). */
function blockReason(p, query, state, now = Date.now()) {
  const s = state.get(productKey(p));
  if (!s) return null;
  if (s.success_at) return 'success';
  if (Failure.isProductTerminal(s.failure_reason)) return 'terminal';
  if (s.next_retry_at && Date.parse(s.next_retry_at) > now) return 'backoff';
  if ((s.transient_failures || 0) >= MAX_TRANSIENT_FAILURES) return 'transient_cap';
  const queries = s.queries || [];
  // A matched target whose write was not confirmed (e.g. a DB blip) may re-read the same
  // query: the ledger serves it from today's cache, so this costs no provider request.
  const unconfirmedMatch = s.last_status === 'matched' && !s.failure_reason;
  if (query != null && queries.includes(normalizeQuery(query)) && !unconfirmedMatch) return 'same_query';
  if (queries.length >= MAX_PRODUCT_QUERIES) return 'query_cap';
  if (s.mismatch_at != null && queries.length >= s.mismatch_at + MAX_ALTERNATES_AFTER_MISMATCH) return 'alternate_cap';
  return null;
}

function canEvaluate(p, query, state, { now = Date.now() } = {}) {
  return blockReason(p, query, state, now) === null;
}

/*
 * Lower runs first. 0 = no actual attempt today (never searched, or only deferred without a
 * request). Unattempted targets always precede every kind of retry; successes and blocked
 * targets sort last.
 */
function priority(p, state, now = Date.now()) {
  const s = state.get(productKey(p));
  if (!s) return 0;
  if (s.success_at) return 4;
  if (blockReason(p, null, state, now)) return 5;
  if (!s.attempted_at) return 0;
  if (Failure.isTransient(s.failure_reason)) return 1;
  if (Failure.isAlternateLimited(s.failure_reason)) return 2;
  return 3;
}

function metrics({ targets, attempted, successful, calls = 0, uniqueCalls = 0, duplicates = 0, newMatches = 0 }) {
  const ratio = (n, d) => d ? n / d * 100 : null;
  return {
    targetProducts: targets, attemptedProducts: attempted, successfulProducts: successful,
    rawSuccessRate: ratio(successful, targets), attemptCoverage: ratio(attempted, targets),
    attemptSuccessRate: ratio(successful, attempted), uniqueQueryEfficiency: uniqueCalls ? newMatches / uniqueCalls : null,
    duplicateSearchRatio: ratio(duplicates, calls), searchCalls: calls, uniqueSearchCalls: uniqueCalls,
    duplicateSearchCalls: duplicates, newlyMatchedProducts: newMatches
  };
}

function createProgress({ db = defaultDb, date = kstToday(), source, now = () => Date.now(), enforceDate = false } = {}) {
  if (!['coupang', 'adpick'].includes(source)) throw new Error('Invalid progress source');
  const state = new Map();
  const storageKeys = new Map(), targetKeys = new Map();
  // Coupang progress is per tracked option: a changed vendorItemId never inherits yesterday's/other success.
  function bindTargets(rows) {
    rows.forEach(p => {
      const key = productKey(p);
      const vid = source === 'coupang' ? vendorIdOf(p) : '';
      const stored = vid ? `${key}|${vid}` : key;
      storageKeys.set(key, stored); targetKeys.set(stored, key);
    });
  }
  const absorb = data => data.forEach(s => {
    const key = targetKeys.size ? targetKeys.get(s.product_key) : s.product_key;
    if (key) state.set(key, { ...s, product_key: key });
  });
  async function load() {
    let cursor = '';
    for (;;) {
      let q = db.from('collector_product_progress').select('*').eq('source', source).eq('kst_date', date)
        .order('product_key', { ascending: true }).limit(1000);
      if (cursor) q = q.gt('product_key', cursor);
      const { data, error } = await q;
      if (error || !Array.isArray(data)) throw new Error('Collector progress unavailable; collection paused');
      absorb(data);
      if (data.length === 0) break; // PostgREST's configured row cap may be below 1,000.
      const next = data[data.length - 1].product_key;
      if (next <= cursor) throw new Error('Collector progress pagination did not advance');
      cursor = next;
    }
    return state;
  }
  /*
   * Event fields: attempted (an actual request started for this target, or it was evaluated
   * against a real same-day response), evaluated (a real response was compared to it),
   * success (price_history confirmed today's exact option row).
   */
  async function record(events) {
    if (!events.length) return;
    if (enforceDate && kstToday(now()) !== date) throw new Error('Collector KST date changed; resume in next daily run');
    for (let i = 0; i < events.length; i += 200) {
      const chunk = events.slice(i, i + 200).map(e => ({
        product_key: storageKeys.get(e.product_key) || e.product_key, query: normalizeQuery(e.query), status: e.status,
        attempted: !!e.attempted, evaluated: !!e.evaluated, success: !!e.success,
        event_id: e.event_id || crypto.randomUUID(),
        failure_reason: e.success ? null : e.failure_reason || null,
        next_retry_at: e.next_retry_at || null
      }));
      const { data, error } = await db.rpc('collector_progress_record', { p_source: source, p_date: date, p_events: chunk });
      if (error || !Array.isArray(data) || data.length !== chunk.length) {
        throw new Error('Collector progress write unavailable; collection paused');
      }
      absorb(data);
    }
  }
  /** A search that produced no response for these targets (failure, deferral, ledger skip). */
  async function recordFailure(rows, query, r) {
    if (NOT_EVALUATED.has(r.queryState)) return; // another worker owns it / ledger down: nothing learned
    const attempted = r.apiCalled === true;
    const reason = r.failureReason || failureReason(r.reason || r.error);
    // A circuit opened by another request's 401/403 says nothing about these targets; recording
    // the sticky AUTH_ERROR would wrongly end their day. Their own 401/403 (attempted) does.
    if (!attempted && reason === 'AUTH_ERROR') return;
    const backoff = attempted && Failure.isRetryable(reason) ? new Date(now() + BACKOFF_MS).toISOString() : null;
    const ledger = r.nextRetryAt && Date.parse(r.nextRetryAt) > now() ? r.nextRetryAt : null;
    const nextRetry = [backoff, ledger].filter(Boolean).sort().pop() || null;
    await record(rows.map(p => ({ product_key: productKey(p), query, attempted, evaluated: false, success: false,
      status: attempted ? 'failed' : 'deferred', failure_reason: reason, next_retry_at: nextRetry })));
  }
  /**
   * A real same-day response (fresh or reused from the ledger) compared to these targets.
   * outcomes: Map(productKey → 'MATCH' | adoptOne reason). Absent targets were not in the
   * response: NO_RESULT if the response was empty, otherwise NO_MATCH.
   */
  async function recordEvaluation(rows, query, outcomes, { emptyResponse = false } = {}) {
    await record(rows.map(p => {
      const key = productKey(p);
      const outcome = outcomes.get(key);
      const reason = outcome === 'MATCH' ? null
        : outcome ? failureReason(outcome) : (emptyResponse ? 'NO_RESULT' : 'NO_MATCH');
      return { product_key: key, query, attempted: true, evaluated: true, success: false,
        status: outcome === 'MATCH' ? 'matched' : 'evaluated', failure_reason: reason };
    }));
  }
  /** Confirmed price_history writes → success; matched but unconfirmed → WRITE_REJECTED. */
  async function recordWrites(recordedKeys, rejectedKeys = []) {
    const ok = new Set(recordedKeys);
    await record([
      ...[...ok].map(k => ({ product_key: k, success: true, status: 'success' })),
      ...[...new Set(rejectedKeys)].filter(k => !ok.has(k)).map(k => ({ product_key: k, status: 'write_rejected',
        failure_reason: 'WRITE_REJECTED' }))
    ]);
  }
  async function searchMetrics() {
    let cursor = '', calls = 0, unique = 0, duplicates = 0, uncertainRequestIntents = 0;
    for (;;) {
      let q = db.from('collector_query_runs').select('query_hash,request_count,confirmed_request_count').eq('source', source).eq('kst_date', date)
        .order('query_hash', { ascending: true }).limit(1000);
      if (cursor) q = q.gt('query_hash', cursor);
      const { data, error } = await q;
      if (error || !Array.isArray(data)) throw new Error('Collector query metrics unavailable');
      for (const row of data) {
        const n = Number(row.confirmed_request_count ?? row.request_count) || 0;
        uncertainRequestIntents += Math.max(0, (Number(row.request_count) || 0) - n);
        calls += n; if (n) unique++; duplicates += Math.max(0, n - 1);
      }
      if (data.length === 0) break;
      const next = data[data.length - 1].query_hash;
      if (next <= cursor) throw new Error('Collector query metrics pagination did not advance');
      cursor = next;
    }
    return { calls, uniqueCalls: unique, duplicates, uncertainRequestIntents };
  }
  return { source, date, state, bindTargets, load, record, recordFailure, recordEvaluation, recordWrites, searchMetrics,
    canEvaluate: (p, q, opts) => canEvaluate(p, q, state, { now: now(), ...opts }),
    blockReason: (p, q) => blockReason(p, q, state, now()),
    // Stable: equal priority keeps the caller's (planner's) order.
    orderGroups: groups => groups.map((g, i) => ({ g, i, p: Math.min(...g.rows.map(p => priority(p, state, now()))) }))
      .sort((a, b) => a.p - b.p || a.i - b.i).map(x => x.g) };
}

/** Throws unless both additive tables are readable (collector startup check; read-only). */
async function preflight(db = defaultDb) {
  for (const [table, column] of [['collector_query_runs', 'query_hash'], ['collector_product_progress', 'product_key']]) {
    const { error } = await db.from(table).select(column).limit(1);
    if (error) throw new Error(`${table} unavailable`);
  }
  return true;
}

module.exports = { createProgress, preflight, enabled, productKey, normalizeQuery, failureReason, priority, canEvaluate, blockReason,
  metrics, MAX_TRANSIENT_FAILURES, MAX_PRODUCT_QUERIES, MAX_ALTERNATES_AFTER_MISMATCH };
