#!/usr/bin/env node
'use strict';

/*
 * Daily product progress + scheduler + collector integration.
 * Offline: production DB/provider/notify modules are replaced before the collector loads.
 * End-to-end cases run the real runMallCollection against the checked-in migration on an
 * in-process PostgreSQL (scripts/_collector-sql-harness.js) and the real query ledger.
 */
const assert = require('assert/strict');
const path = require('path');
const Module = require('module');
process.env.PRICE_BATCH_INTERVAL_MS = '1';
process.env.PRICE_SECOND_PASS = '0';
process.env.PRICE_SECOND_PASS_ROUNDS = '1';
process.env.PRICE_SECOND_PASS_MAX_CALLS = '4';
process.env.PRICE_CACHE_HINT = '0';
process.env.PRICE_FACET_MIN_GROUP = '100';

function inject(rel, value) {
  const file = require.resolve(path.join(__dirname, '..', rel));
  const mod = new Module(file); mod.filename = file; mod.loaded = true; mod.exports = value;
  require.cache[file] = mod;
}
const forbidden = () => { throw new Error('Unexpected real database/provider access in offline test'); };
inject('api/_supabase.js', { from: forbidden, rpc: forbidden });
inject('api/_notify.js', { send: forbidden });
inject('api/_coupang.js', { searchCoupang: forbidden, isBlocked: () => false, localStats: () => ({}) });
inject('api/_adpick.js', { searchAdpick: forbidden, isBlocked: () => false, localStats: () => ({}),
  hasKey: () => false, recordExternalCall: forbidden, redact: String });
const P = require('../api/_collector-progress');
const Q = require('../api/_collector-query');
const C = require('./collect-all-prices');
const { createSqlHarness } = require('./_collector-sql-harness');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.error(`[FAIL] ${name}: ${e.stack || e.message}`); }
}

const today = C.kstToday();
let uid = 0;
const fresh = prefix => `${prefix}${++uid}`;
const row = (id, keyword = id, mall = 'ADPICK', vid = '') => ({ product_id: id, keyword,
  title: id, mall, vendor_item_id: vid, collected_at: null, link: '', image: '' });
const item = (id, vid = '', mall = 'ADPICK') => ({ productId: id, title: id, lprice: 1000, oprice: 1000,
  mall, vendorItemId: vid, itemId: '', link: 'https://example.invalid/p', image: '' });
const stateOf = (p, values) => new Map([[P.productKey(p), { attempted_at: '2026-10-03T00:00:00Z',
  attempt_count: 1, transient_failures: 0, mismatch_at: null, queries: ['query'], success_at: null,
  failure_reason: 'NO_MATCH', last_status: 'evaluated', ...values }]]);
const source = mall => (mall === '쿠팡' ? 'coupang' : 'adpick');

/*
 * A provider seen through the real query ledger: claim → begin → external(query) → finish.
 * external(query) returns items (a normal answer) or { fail: reason, request: bool }.
 * Returns the collector-level shape of fetchCoupangAll / fetchAdpickAll.
 */
function ledgerProvider(h, src, external) {
  const ledger = Q.createQueryLedger({ db: h.client });
  const log = [];
  const fn = async query => {
    const r = await ledger.run(src, query, {}, async begin => {
      const out = await external(query, () => begin());
      return out;
    });
    log.push({ query, apiCalled: r.apiCalled, state: r.queryState });
    if (r.from === 'api' || r.from === 'cache') {
      return { ok: true, reason: '', apiCalled: r.apiCalled, queryState: r.queryState,
        items: r.items, allItems: r.allItems || r.items };
    }
    return { ok: false, items: [], reason: String(r.error || ''), apiCalled: r.apiCalled,
      failureReason: r.failureReason, queryState: r.queryState, nextRetryAt: r.nextRetryAt };
  };
  fn.log = log;
  return fn;
}
// External API double: answers[query] = items | { fail, request }. Counts real requests.
function externalApi(answers) {
  const requests = [];
  const ext = async (query, begin) => {
    const a = typeof answers === 'function' ? answers(query) : answers[query];
    if (a && a.fail && a.request === false) return { items: [], from: 'none', error: a.fail, failureReason: a.reason };
    if (!await begin()) return { items: [], from: 'none', error: 'fenced', failureReason: 'SOURCE_ERROR' };
    requests.push(query);
    if (a && a.fail) return { items: [], from: 'none', error: a.fail, failureReason: a.reason };
    const items = a || [];
    return { items, allItems: items, from: 'api', error: null, resultFetchedAt: new Date().toISOString() };
  };
  ext.requests = requests;
  return ext;
}

function harness(h, rows, fetchAllFn, options = {}) {
  const history = options.history || new Set();
  const recorded = [];
  const progress = options.progress === undefined
    ? P.createProgress({ db: h.client, source: source(rows[0].mall) }) : options.progress;
  return {
    history, recorded, progress,
    run: () => (options.collector || C).runMallCollection({ mallName: rows[0].mall, rows, fetchAllFn,
      deadlineTs: Date.now() + 8000, collectedTodayFn: async () => new Set(history),
      cacheHintFn: async () => new Map(),
      recordPricesFn: options.recordPricesFn || (async observations => {
        recorded.push(...observations); observations.forEach(o => history.add(`${o.productId}|${o.mall}`));
        return { saved: observations.length, recorded: observations.length, rejected: 0, suspect: 0,
          errors: [], recordedKeys: observations.map(o => `${o.productId}|${o.mall}`) };
      }), ...options, progress })
  };
}

async function main() {
  // ── pure rules: retry caps and scheduling ───────────────────────────────
  const target = row('T', 'query');
  await test('same query is never evaluated twice for a product today (NO_MATCH / NO_RESULT / OPTION_MISMATCH)', () => {
    for (const failure_reason of ['NO_MATCH', 'NO_RESULT', 'OPTION_MISMATCH', 'AMBIGUOUS_MATCH']) {
      assert.equal(P.canEvaluate(target, ' QUERY ', stateOf(target, { failure_reason, mismatch_at: null })), false, failure_reason);
    }
  });
  await test('NO_MATCH keeps the bounded recovery ladder: several alternates, capped by MAX_PRODUCT_QUERIES', () => {
    const queries = Array.from({ length: 5 }, (_, i) => `q${i}`);
    assert.equal(P.canEvaluate(target, 'next', stateOf(target, { queries })), true);
    const full = Array.from({ length: P.MAX_PRODUCT_QUERIES }, (_, i) => `q${i}`);
    assert.equal(P.canEvaluate(target, 'next', stateOf(target, { queries: full })), false);
  });
  await test('OPTION_MISMATCH / AMBIGUOUS_MATCH: exactly one alternate query after the first miss', () => {
    for (const failure_reason of ['OPTION_MISMATCH', 'AMBIGUOUS_MATCH']) {
      assert.equal(P.canEvaluate(target, 'alt', stateOf(target, { failure_reason, mismatch_at: 1, queries: ['query'] })), true);
      assert.equal(P.canEvaluate(target, 'third', stateOf(target, { failure_reason, mismatch_at: 1, queries: ['query', 'alt'] })), false);
    }
  });
  await test('NETWORK_ERROR / TIMEOUT: retry only after backoff, at most three transient failures per day', () => {
    for (const failure_reason of ['NETWORK_ERROR', 'TIMEOUT', 'SOURCE_ERROR', 'UNKNOWN']) {
      const s = { failure_reason, queries: [], transient_failures: 1, next_retry_at: '2030-01-01T00:00:00Z' };
      assert.equal(P.canEvaluate(target, 'query', stateOf(target, s), { now: 0 }), false, `${failure_reason} waits`);
      assert.equal(P.canEvaluate(target, 'query', stateOf(target, { ...s, next_retry_at: null })), true, `${failure_reason} retries`);
      assert.equal(P.canEvaluate(target, 'query', stateOf(target, { ...s, next_retry_at: null,
        transient_failures: P.MAX_TRANSIENT_FAILURES })), false, `${failure_reason} capped`);
    }
  });
  await test('RATE_LIMIT deferral (no request) waits for next_retry_at and is still unattempted', () => {
    const st = stateOf(target, { attempted_at: null, attempt_count: 0, queries: [], failure_reason: 'RATE_LIMIT',
      next_retry_at: '2030-01-01T00:00:00Z' });
    assert.equal(P.canEvaluate(target, 'query', st, { now: 0 }), false);
    assert.equal(P.priority(target, new Map([[P.productKey(target), { ...st.get(P.productKey(target)), next_retry_at: null }]])), 0);
  });
  await test('AUTH_ERROR / INVALID_PRODUCT / WRITE_REJECTED are terminal for the day with any query', () => {
    for (const failure_reason of ['AUTH_ERROR', 'INVALID_PRODUCT', 'WRITE_REJECTED']) {
      assert.equal(P.canEvaluate(target, 'brand new query', stateOf(target, { failure_reason, queries: [] })), false, failure_reason);
    }
  });
  await test('success is never rescheduled', () => assert.equal(P.canEvaluate(target, 'alt',
    stateOf(target, { success_at: '2026-10-03T00:01:00Z', failure_reason: null })), false));
  await test('an unconfirmed match may re-read the same query (served from the ledger cache)', () => {
    assert.equal(P.canEvaluate(target, 'query', stateOf(target, { failure_reason: null, last_status: 'matched' })), true);
  });
  await test('priority: unattempted < transient retry < option alternate < other evaluated < success < blocked', () => {
    const p = P.createProgress({ db: { from: forbidden, rpc: forbidden }, source: 'adpick', now: () => 0 });
    const rows = ['new', 'network', 'option', 'empty', 'success', 'blocked'].map(id => row(id));
    p.state.set(P.productKey(rows[1]), { attempted_at: 'x', attempt_count: 1, failure_reason: 'NETWORK_ERROR', queries: [] });
    p.state.set(P.productKey(rows[2]), { attempted_at: 'x', attempt_count: 1, failure_reason: 'OPTION_MISMATCH', mismatch_at: 1, queries: ['option'] });
    p.state.set(P.productKey(rows[3]), { attempted_at: 'x', attempt_count: 1, failure_reason: 'NO_MATCH', queries: ['empty'] });
    p.state.set(P.productKey(rows[4]), { attempted_at: 'x', success_at: 'x', attempt_count: 1, queries: [] });
    p.state.set(P.productKey(rows[5]), { attempted_at: 'x', attempt_count: 1, failure_reason: 'AUTH_ERROR', queries: [] });
    const ordered = p.orderGroups([...rows].reverse().map(r => ({ kw: r.keyword, rows: [r] })));
    assert.deepEqual(ordered.map(g => g.kw), ['new', 'network', 'option', 'empty', 'success', 'blocked']);
  });
  await test('orderGroups is stable: equal priority keeps the caller (planner) order', () => {
    const p = P.createProgress({ db: { from: forbidden, rpc: forbidden }, source: 'adpick' });
    const groups = ['zeta', 'alpha', 'mid'].map(k => ({ kw: k, rows: [row(k)] }));
    assert.deepEqual(p.orderGroups(groups).map(g => g.kw), ['zeta', 'alpha', 'mid']);
  });
  await test('metrics keep the original denominator and never fabricate 100% on empty input', () => {
    const m = P.metrics({ targets: 10, attempted: 8, successful: 6, calls: 4, uniqueCalls: 3, duplicates: 1, newMatches: 6 });
    assert.equal(m.rawSuccessRate, 60); assert.equal(m.attemptCoverage, 80); assert.equal(m.attemptSuccessRate, 75);
    assert.equal(m.uniqueQueryEfficiency, 2); assert.equal(m.duplicateSearchRatio, 25);
    const e = P.metrics({ targets: 0, attempted: 0, successful: 0 });
    assert.equal(e.rawSuccessRate, null); assert.equal(e.attemptCoverage, null); assert.equal(e.duplicateSearchRatio, null);
  });

  // ── real SQL: progress bookkeeping ───────────────────────────────────────
  const h = await createSqlHarness();
  try {
    const prog = (src = 'adpick', opts = {}) => P.createProgress({ db: h.client, source: src, ...opts });
    const loaded = async (src = 'adpick', bind) => { const p = prog(src); if (bind) p.bindTargets(bind); await p.load(); return p; };

    await test('actual failed request = attempt + transient failure + backoff; the query stays retryable', async () => {
      const t = row(fresh('net')), p = prog();
      await p.recordFailure([t], 'q', { ok: false, apiCalled: true, failureReason: 'NETWORK_ERROR' });
      const s = (await loaded()).state.get(P.productKey(t));
      assert.equal(s.attempt_count, 1); assert.equal(s.transient_failures, 1); assert.ok(s.attempted_at);
      assert.deepEqual(s.queries, []); assert.ok(Date.parse(s.next_retry_at) > Date.now() + 100000);
    });
    await test('rate-gate deferral without a request is not an attempt', async () => {
      const t = row(fresh('rate')), p = prog();
      await p.recordFailure([t], 'q', { ok: false, apiCalled: false, failureReason: 'RATE_LIMIT',
        nextRetryAt: new Date(Date.now() + 120000).toISOString() });
      const s = (await loaded()).state.get(P.productKey(t));
      assert.equal(s.attempted_at, null); assert.equal(s.attempt_count, 0); assert.equal(s.failure_reason, 'RATE_LIMIT');
    });
    await test('in-flight elsewhere, ledger down and circuit-open AUTH deferral leave no product record', async () => {
      const t = row(fresh('skip')), p = prog();
      await p.recordFailure([t], 'q', { ok: false, apiCalled: false, queryState: 'inflight', failureReason: null });
      await p.recordFailure([t], 'q', { ok: false, apiCalled: false, queryState: 'unavailable', failureReason: null });
      await p.recordFailure([t], 'q', { ok: false, apiCalled: false, failureReason: 'AUTH_ERROR' });
      assert.equal((await loaded()).state.has(P.productKey(t)), false);
    });
    await test('an actual 401/403 request makes the product terminal for the day', async () => {
      const t = row(fresh('auth')), p = prog();
      await p.recordFailure([t], 'q', { ok: false, apiCalled: true, failureReason: 'AUTH_ERROR' });
      const l = await loaded();
      assert.equal(l.state.get(P.productKey(t)).failure_reason, 'AUTH_ERROR');
      assert.equal(l.canEvaluate(t, 'different query'), false);
    });
    await test('evaluation distinguishes NO_RESULT (empty answer) from NO_MATCH (answer without the target)', async () => {
      const a = row(fresh('empty')), b = row(fresh('nomatch')), p = prog();
      await p.recordEvaluation([a], 'qa', new Map(), { emptyResponse: true });
      await p.recordEvaluation([b], 'qb', new Map(), { emptyResponse: false });
      const l = await loaded();
      assert.equal(l.state.get(P.productKey(a)).failure_reason, 'NO_RESULT');
      assert.equal(l.state.get(P.productKey(b)).failure_reason, 'NO_MATCH');
      assert.deepEqual(l.state.get(P.productKey(b)).queries, ['qb']);
    });
    await test('success is monotonic; a late failure event cannot erase it', async () => {
      const t = row(fresh('mono')), p = prog();
      await p.recordWrites([P.productKey(t)]);
      await p.recordFailure([t], 'late', { ok: false, apiCalled: true, failureReason: 'NETWORK_ERROR' });
      const s = (await loaded()).state.get(P.productKey(t));
      assert.ok(s.success_at); assert.equal(s.failure_reason, null); assert.equal(s.next_retry_at, null);
    });
    await test('WRITE_REJECTED only for integrity refusals; terminal and sticky', async () => {
      const t = row(fresh('rej')), p = prog();
      await p.recordWrites([], [P.productKey(t)]);
      await p.recordFailure([t], 'later', { ok: false, apiCalled: false, failureReason: 'RATE_LIMIT' });
      const s = (await loaded()).state.get(P.productKey(t));
      assert.equal(s.failure_reason, 'WRITE_REJECTED');
    });
    await test('next KST date and a different provider start with fresh eligibility', async () => {
      const t = row(fresh('date')), p = prog();
      await p.recordEvaluation([t], 'q', new Map(), {});
      const tomorrow = P.createProgress({ db: h.client, source: 'adpick', date: '2099-01-01' }); await tomorrow.load();
      assert.equal(tomorrow.canEvaluate(t, 'q'), true);
      assert.equal((await loaded('coupang')).state.has(P.productKey(t)), false);
    });
    await test('runtime date guard stops old-day writes at KST midnight', async () => {
      let now = Date.parse('2026-10-03T14:59:59Z');
      const guarded = P.createProgress({ db: h.client, source: 'adpick', date: '2026-10-03', now: () => now, enforceDate: true });
      const t = row(fresh('mid'));
      await guarded.recordEvaluation([t], 'q', new Map(), {});
      now = Date.parse('2026-10-03T15:00:00Z');
      await assert.rejects(() => guarded.recordEvaluation([t], 'q2', new Map(), {}), /KST date changed/);
    });
    await test('a changed Coupang option never inherits the previous option success', async () => {
      const id = fresh('OPT'), oldT = row(id, 'q', '쿠팡', 'OLD'), newT = row(id, 'q', '쿠팡', 'NEW');
      const a = prog('coupang'); a.bindTargets([oldT]); await a.recordWrites([P.productKey(oldT)]);
      const b = await loaded('coupang', [newT]); assert.equal(b.canEvaluate(newT, 'q'), true);
      const c = await loaded('coupang', [oldT]); assert.equal(c.canEvaluate(oldT, 'q'), false);
    });
    await test('load and search metrics page through PostgREST-style 1000-row caps', async () => {
      const p = prog('coupang');
      const many = Array.from({ length: 450 }, (_, i) => ({ product_key: `page|쿠팡|${i}`, query: 'q', status: 'deferred',
        failure_reason: 'RATE_LIMIT' }));
      await p.record(many);
      const l = await loaded('coupang'); assert.ok(l.state.size >= 450);
    });

    // ── end-to-end: real collector + real ledger + real progress SQL ──────────
    await test('regular success → independent catch-up makes zero searches (no cursor needed)', async () => {
      const t = row(fresh('A'), fresh('kw-'), '쿠팡', 'V1');
      const ext = externalApi(q => [item(t.product_id, 'V1', '쿠팡')]);
      const regular = harness(h, [t], ledgerProvider(h, 'coupang', ext));
      await regular.run();
      const catchup = harness(h, [t], ledgerProvider(h, 'coupang', ext), { history: regular.history,
        savedState: { job_date: today, cursor_key: '', last_result: {} } });
      await catchup.run();
      assert.equal(ext.requests.length, 1);
      assert.equal(regular.recorded.length, 1);
    });
    await test('a later run for a different target with the same query reuses today\'s answer (no second request)', async () => {
      const kw = fresh('Shared Query '), x = row(fresh('SX'), kw, '쿠팡', 'VX'), y = row(fresh('SY'), ` ${kw.toLowerCase()} `, '쿠팡', 'VY');
      const ext = externalApi(() => [item(x.product_id, 'VX', '쿠팡'), item(y.product_id, 'VY', '쿠팡')]);
      const first = harness(h, [x], ledgerProvider(h, 'coupang', ext));
      await first.run();
      const cronLike = harness(h, [y], ledgerProvider(h, 'coupang', ext));
      await cronLike.run();
      assert.equal(ext.requests.length, 1);
      assert.equal(cronLike.history.has(`${y.product_id}|쿠팡`), true);
    });
    await test('regular network failure → catch-up waits; after backoff one retry; the query cap ends it', async () => {
      const t = row(fresh('N'), fresh('net-kw-'), '쿠팡', 'V1');
      const ext = externalApi(() => ({ fail: '쿠팡 네트워크 오류: fetch failed', reason: 'NETWORK_ERROR' }));
      const run = () => harness(h, [t], ledgerProvider(h, 'coupang', ext)).run();
      await run();
      assert.equal(ext.requests.length, 1);
      await run();                                    // immediate catch-up: product backoff
      assert.equal(ext.requests.length, 1);
      const expire = () => h.exec(`update public.collector_product_progress set next_retry_at = now() - interval '1 second';
        update public.collector_query_runs set next_retry_at = now() - interval '1 second';`);
      await expire(); await run();                    // one allowed retry
      assert.equal(ext.requests.length, 2);
      await expire(); await run();                    // ledger: 2 requests/query/day reached
      assert.equal(ext.requests.length, 2);
      const s = (await loaded('coupang', [t])).state.get(P.productKey(t));
      assert.equal(s.attempt_count, 2); assert.equal(s.transient_failures, 2);
    });
    await test('fan-out success covers a queued group: that group is never searched', async () => {
      const kwFirst = fresh('a-first-'), kwLater = fresh('z-later-');
      const rows = Array.from({ length: 21 }, (_, i) => row(fresh(`F${i}-`), kwFirst));
      const other = row(fresh('B'), kwLater); rows.push(other);
      const ext = externalApi(q => (q === kwFirst ? [item(rows[0].product_id), item(other.product_id)] : []));
      const run = harness(h, rows, async q => {
        const r = await ext(q, async () => true);
        return { ok: true, apiCalled: true, items: r.items, allItems: r.allItems };
      });
      const result = await run.run();
      assert.deepEqual(ext.requests, [kwFirst]);
      assert.ok(result.crossRecovered >= 1);
      assert.ok((await loaded()).state.get(P.productKey(other)).success_at);
    });
    await test('fan-out option miss does not consume the target own query or its alternate budget', async () => {
      const kwFirst = fresh('a-own-'), kwLater = fresh('z-own-');
      const rows = Array.from({ length: 20 }, (_, i) => row(fresh(`G${i}-`), kwFirst, '쿠팡', `GV${i}`));
      const b = row(fresh('B'), kwLater, '쿠팡', 'B-EXPECTED'); rows.push(b);
      const answers = { [kwFirst]: [item(rows[0].product_id, 'GV0', '쿠팡'), item(b.product_id, 'B-WRONG', '쿠팡')],
        [kwLater]: [item(b.product_id, 'B-EXPECTED', '쿠팡')] };
      const ext = externalApi(answers);
      const run = harness(h, rows, async q => {
        const r = await ext(q, async () => true);
        return { ok: true, apiCalled: true, items: r.items, allItems: r.allItems };
      });
      await run.run();
      assert.deepEqual(ext.requests, [kwFirst, kwLater]);
      assert.equal(run.history.has(`${b.product_id}|쿠팡`), true);
      const s = (await loaded('coupang', rows)).state.get(P.productKey(b));
      assert.deepEqual(s.queries, [kwLater]); assert.equal(s.mismatch_at, null); assert.ok(s.success_at);
    });
    await test('two collectors at once share the ledger: each distinct query reaches the provider once', async () => {
      const rows = Array.from({ length: 6 }, (_, i) => row(fresh('R'), fresh(`race-${i}-`), '쿠팡', `RV${i}`));
      const ext = externalApi(q => { const t = rows.find(r => r.keyword === q); return [item(t.product_id, t.vendor_item_id, '쿠팡')]; });
      const a = harness(h, rows, ledgerProvider(h, 'coupang', ext));
      const b = harness(h, rows, ledgerProvider(h, 'coupang', ext), { history: a.history });
      await Promise.all([a.run(), b.run()]);
      assert.equal(ext.requests.length, 6); assert.equal(new Set(ext.requests).size, 6);
      assert.equal(a.history.size, 6);
    });
    await test('under a call budget, never-attempted targets run before retries — across runs, from the DB', async () => {
      // Alphabetical plan order would put the retry first; priority must override it.
      const retryT = row(fresh('RT'), fresh('a-retry-'));
      const news = Array.from({ length: 3 }, (_, i) => row(fresh('NU'), fresh(`n-new-${i}-`)));
      const p0 = prog();
      await p0.recordFailure([retryT], retryT.keyword, { ok: false, apiCalled: true, failureReason: 'TIMEOUT' });
      await h.exec(`update public.collector_product_progress set next_retry_at = now() - interval '1 second'
        where product_key = '${P.productKey(retryT)}'`);
      const calls = [];
      let budget = 2;
      const fetchAllFn = async q => {
        if (budget <= 0) return { ok: false, items: [], reason: '실행당 호출 예산 2회 소진' };
        budget--; calls.push(q);
        return { ok: true, apiCalled: true, items: [], allItems: [] };
      };
      const rows = [retryT, ...news];
      await harness(h, rows, fetchAllFn).run();
      assert.deepEqual(calls, [news[0].keyword, news[1].keyword]);
      budget = 2;
      await harness(h, rows, fetchAllFn).run();            // next run, fresh client: resume from DB
      assert.deepEqual(calls.slice(2), [news[2].keyword, retryT.keyword]);
    });
    await test('V3 planner order is kept inside the same priority (daily tier first)', async () => {
      const rot = row(fresh('ROT'), fresh('a-rotation-')), daily = row(fresh('DAY'), fresh('z-daily-'));
      const calls = [];
      await harness(h, [rot, daily], async q => { calls.push(q); return { ok: true, apiCalled: true, items: [] }; }, {
        planner: { tierOf: p => (p === daily || p.product_id === daily.product_id ? 'daily' : 'rotation'),
          dayStartMs: Date.now() - 3600000, limit: 20, dailyFirst: true }
      }).run();
      assert.equal(calls[0], daily.keyword);
    });
    await test('metrics: a failed request counts as an attempt, a rate-gate skip does not, a cache reuse is not a search call', async () => {
      const n = row(fresh('MN'), fresh('m-net-'), '쿠팡', 'V'), l = row(fresh('ML'), fresh('m-limited-'), '쿠팡', 'V');
      const base = fresh('Same Query ');
      const c1 = row(fresh('MC'), base, '쿠팡', 'V1'), c2 = row(fresh('MC'), base.toLowerCase().replace(' ', '   '), '쿠팡', 'V2');
      const ext = externalApi(q => (q === n.keyword ? { fail: '쿠팡 네트워크 오류: fetch failed', reason: 'NETWORK_ERROR' }
        : q === l.keyword ? { fail: '전역 제한: collector 분당 budget 5/5', reason: 'RATE_LIMIT', request: false }
          : [item(c1.product_id, 'V1', '쿠팡'), item(c2.product_id, 'V2', '쿠팡')]));
      const run = harness(h, [n, l, c1, c2], ledgerProvider(h, 'coupang', ext));
      // Search counters are day-scoped (whole ledger for the source): compare this run's delta.
      const before = await prog('coupang').searchMetrics();
      const r = await run.run();
      const m = r.efficiencyMetrics;
      assert.equal(m.searchCalls - before.calls, 2);     // n's failed request + one request for c1/c2's query
      assert.equal(m.duplicateSearchCalls - before.duplicates, 0);
      assert.equal(m.targetProducts, 4);
      assert.equal(m.attemptedProducts, 3);            // n (request failed), c1, c2 — not l
      assert.equal(m.successfulProducts, 2);
      assert.equal(m.failureProducts.UNATTEMPTED, 1);
      assert.equal(m.failureProducts.NETWORK_ERROR, 1);
      assert.equal(ext.requests.filter(q => q === c1.keyword || q === c2.keyword).length, 1);
      assert.equal(m.ledgerCacheReuses, 1);
      assert.equal(m.searchMetricScope, 'daily_ledger_since_enable');
    });
    await test('integrity refusal → WRITE_REJECTED and not searched again; a DB write failure stays retryable', async () => {
      const w = row(fresh('W'), fresh('w-kw-')), d = row(fresh('D'), fresh('d-kw-'));
      const calls = [];
      const fetchAllFn = async q => { calls.push(q); const t = q === w.keyword ? w : d;
        return { ok: true, apiCalled: true, items: [item(t.product_id)] }; };
      const recordPricesFn = async obs => ({ saved: 0, recorded: 0, rejected: obs.some(o => o.productId === w.product_id) ? 1 : 0,
        suspect: 0, recordedKeys: [], errors: obs.some(o => o.productId === d.product_id) ? ['history upsert failed'] : [] });
      await harness(h, [w], fetchAllFn, { recordPricesFn }).run();
      await harness(h, [d], fetchAllFn, { recordPricesFn }).run();
      const l = await loaded();
      assert.equal(l.state.get(P.productKey(w)).failure_reason, 'WRITE_REJECTED');
      assert.equal(l.canEvaluate(w, w.keyword), false);
      assert.equal(l.state.get(P.productKey(d)).failure_reason, null);
      assert.equal(l.canEvaluate(d, d.keyword), true);
    });
    await test('progress write failure stops the lane without throwing; matched prices are still saved', async () => {
      const kw = fresh('pf-'), rows = Array.from({ length: 25 }, (_, i) => row(fresh(`PF${i}-`), i < 21 ? kw : fresh('pf-other-')));
      const calls = [];
      const run = harness(h, rows, async q => { calls.push(q); return { ok: true, apiCalled: true, items: [item(rows[0].product_id)] }; });
      await run.progress.load();
      h.fail('collector_progress_record');
      let result;
      try { result = await run.run(); } finally { h.heal(); }
      assert.equal(calls.length, 1);
      assert.equal(run.recorded.length, 1);
      assert.notEqual(result.status, 'completed');
    });
    await test('collector metrics keep no-phrase targets in the denominator as INVALID_PRODUCT', async () => {
      const noQuery = { ...row(fresh('IQ'), ''), title: '' };
      const good = row(fresh('GQ'), fresh('g-kw-'));
      const r = await harness(h, [good, noQuery], async () => ({ ok: true, apiCalled: true, items: [item(good.product_id)] })).run();
      assert.equal(r.efficiencyMetrics.targetProducts, 2);
      assert.equal(r.efficiencyMetrics.rawSuccessRate, 50);
      assert.equal(r.efficiencyMetrics.failureProducts.INVALID_PRODUCT, 1);
    });
    await test('success counts only confirmed today rows (rejected/next-day writes never inflate it)', async () => {
      const t = row(fresh('ND'), fresh('nd-kw-'));
      const r = await harness(h, [t], async () => ({ ok: true, apiCalled: true, items: [item(t.product_id)] }),
        { collectedTodayFn: async () => new Set() }).run();
      assert.equal(r.efficiencyMetrics.successfulProducts, 0); assert.equal(r.efficiencyMetrics.newlyMatchedProducts, 0);
    });
    await test('report-only metric failure never breaks collection (efficiencyMetrics=null)', async () => {
      const t = row(fresh('EM'), fresh('em-kw-'));
      let first = true;
      const r = await harness(h, [t], async () => ({ ok: true, apiCalled: true, items: [item(t.product_id)] }), {
        collectedTodayFn: async () => { if (first) { first = false; return new Set(); } throw new Error('ledger read failed'); }
      }).run();
      assert.equal(r.efficiencyMetrics, null); assert.ok(r.status);
    });
    await test('exact identity only: wrong option / accessory / similar names are never adopted', async () => {
      const kw = fresh('same-');
      const rows = [row(fresh('EXACT'), kw, '쿠팡', 'V1'), row(fresh('WRONG'), kw, '쿠팡', 'V2'), row(fresh('SIMILAR'), kw, '쿠팡', 'V3')];
      const response = [item(rows[0].product_id, 'V1', '쿠팡'), item(rows[1].product_id, 'OTHER', '쿠팡'),
        item(`${rows[2].product_id}-ACCESSORY`, 'V3', '쿠팡')];
      const run = harness(h, rows, async () => ({ ok: true, apiCalled: true, items: response, allItems: response }));
      await run.run();
      assert.equal(run.history.has(`${rows[0].product_id}|쿠팡`), true);
      assert.equal(run.history.has(`${rows[1].product_id}|쿠팡`), false);
      assert.equal(run.history.has(`${rows[2].product_id}|쿠팡`), false);
      assert.ok(run.recorded.every(o => o.vendorItemId === o.targetVendorItemId));
      const s = (await loaded('coupang', rows)).state.get(P.productKey(rows[1]));
      assert.equal(s.failure_reason, 'OPTION_MISMATCH'); assert.equal(s.mismatch_at, 1);
    });
    await test('recovery ladder after an option miss: exactly one alternate query', async () => {
      const scriptPath = require.resolve('./collect-all-prices'); const original = require.cache[scriptPath];
      process.env.PRICE_SECOND_PASS = '1'; process.env.PRICE_SECOND_PASS_ROUNDS = '10'; process.env.PRICE_SECOND_PASS_MAX_CALLS = '20';
      delete require.cache[scriptPath];
      const recoveryCollector = require('./collect-all-prices');
      process.env.PRICE_SECOND_PASS = '0'; process.env.PRICE_SECOND_PASS_ROUNDS = '1'; process.env.PRICE_SECOND_PASS_MAX_CALLS = '4';
      require.cache[scriptPath] = original;
      const t = { ...row(fresh('LAD'), '삼성 갤럭시 버즈3 프로', '쿠팡', 'EXPECTED'), title: '삼성 갤럭시 버즈3 프로 블루투스 이어폰 화이트 정품' };
      const queries = [];
      await harness(h, [t], async q => { queries.push(q); return { ok: true, apiCalled: true,
        items: [item(t.product_id, 'OTHER', '쿠팡')] }; }, { collector: recoveryCollector }).run();
      assert.equal(queries.length, 2, JSON.stringify(queries));
      const s = (await loaded('coupang', [t])).state.get(P.productKey(t));
      assert.equal(s.failure_reason, 'OPTION_MISMATCH'); assert.equal(s.queries.length, 2); assert.equal(s.success_at, null);
    });
  } finally { await h.close(); }

  console.log(`Collector progress: ${pass} PASS / ${fail} FAIL`);
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
