#!/usr/bin/env node
'use strict';

// Execute the production collector entry point with an isolated provider/DB.
// No real credentials, HTTP requests, price writes, or collector run() are used.
const assert = require('assert');
const Module = require('module');
const path = require('path');
let pass = 0;
function equal(actual, expected, label) {
  assert.strictEqual(actual, expected, label);
  pass++;
  console.log('  PASS ' + label);
}

function inject(relative, exports) {
  const filename = require.resolve(path.join(__dirname, '..', relative));
  require.cache[filename] = Object.assign(new Module(filename, null), { filename, loaded: true, exports });
}

function fixture(overrides = {}, dayUsed = 0, dayError = null) {
  for (const name of ['COUPANG_RUN_BUDGET', 'COUPANG_DAY_BUDGET', 'COUPANG_COLLECT_MIN_GAP_MS',
    'COUPANG_MIN_GAP_MS', 'COUPANG_COLLECTOR_MAX_PER_MIN']) delete process.env[name];
  Object.assign(process.env, { COUPANG_ACCESS_KEY: 'fixture-access', COUPANG_SECRET_KEY: 'fixture-secret', ...overrides });
  const state = { entries: 0, external: 0, cache: 0, denied: 0, next: null, gate: null, query: {} };
  inject('api/_supabase.js', {
    from(table) {
      const q = {
        select(columns, options) { state.query.table = table; state.query.options = options; return q; },
        eq(column, value) { state.query[column] = value; return q; },
        gte(column, value) { state.query.start = value; return q; },
        lt(column, value) { state.query.end = value; return q; },
        then(resolve) { return Promise.resolve({ count: dayUsed, data: [], error: dayError }).then(resolve); }
      };
      return q;
    },
    rpc() { throw new Error('The collector unit test must not make a real DB RPC'); }
  });
  inject('api/_notify.js', { send: async () => ({ ok: true }) });
  inject('api/_coupang.js', {
    async searchCoupang(keyword, options) {
      state.entries++;
      state.options = options;
      const result = state.next || { from: 'api', items: [], allItems: [], apiCalled: true, blocked: false };
      state.next = null;
      if (result.apiCalled === true) state.external++;
      else if (result.from === 'cache') state.cache++;
      else state.denied++;
      if (state.gate) await state.gate;
      return result;
    },
    isBlocked: () => false,
    localStats: () => ({ calls: state.external, cacheHits: state.cache, denied: state.denied, blocked: false })
  });
  inject('api/_adpick.js', { hasKey: () => false, isBlocked: () => false, localStats: () => ({ calls: 0 }),
    searchAdpick: async () => { throw new Error('This test must not call ADPICK'); } });
  const filename = require.resolve('./collect-all-prices');
  delete require.cache[filename];
  return { C: require(filename), state };
}

(async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    {
      const { C, state } = fixture();
      equal(C.COUPANG_RUN_BUDGET, 900, 'default run budget is 900');
      equal(C.COUPANG_DAY_BUDGET, 3400, 'default daily budget remains 3400');
      equal(C.COUPANG_MIN_GAP_MS, 3000, 'collector default minimum gap is 3000ms');
      // A cache result and a quota refusal must not consume the 900 calls.
      state.next = { from: 'cache', items: [], allItems: [], apiCalled: false, blocked: false };
      await C.fetchCoupangAll('cache');
      state.next = { from: 'none', items: [], apiCalled: false, blocked: false, error: 'minute budget' };
      await C.fetchCoupangAll('denied');
      state.next = { from: 'stale-cache', items: [], allItems: [], apiCalled: false, blocked: false };
      await C.fetchCoupangAll('stale-cache');
      // External failures count just like successes. Keep them non-blocking so
      // the test can reach the ceiling without modifying circuit behavior.
      state.next = { from: 'none', items: [], apiCalled: true, blocked: false, error: '쿠팡 rCode=400: fixture' };
      await C.fetchCoupangAll('parameter-error');
      state.next = { from: 'none', items: [], apiCalled: true, blocked: false, error: '쿠팡 응답 파싱 실패' };
      await C.fetchCoupangAll('parse-error');
      for (let i = 0; i < 898; i++) await C.fetchCoupangAll('external-' + i);
      equal(state.external, 900, 'cache/refusals excluded and both external failure types counted at exactly 900');
      equal(state.entries, 903, 'fresh/stale cache and refusals did not consume the run budget');
      const rejected = await C.fetchCoupangAll('external-901');
      equal(rejected.ok, false, 'the 901st actual external call is denied');
      equal(/실행당 호출 예산 900/.test(rejected.reason), true, 'run ceiling reports the active 900 limit');
      equal(state.external, 900, 'run ceiling prevents entry to the provider');
      equal(state.options.source, 'collect', 'collector identity reaches the production provider');
      equal(state.options.minGapMs, 3000, 'provider receives the collector-specific 3-second gap');
    }
    {
      const { C, state } = fixture();
      for (let i = 0; i < 899; i++) await C.fetchCoupangAll('serial-' + i);
      let release;
      state.gate = new Promise(resolve => { release = resolve; });
      const pending = [0, 1, 2, 3].map(i => C.fetchCoupangAll('concurrent-' + i));
      equal(state.external, 900, 'four concurrent requests reserve only the one remaining run slot');
      release();
      const results = await Promise.all(pending);
      equal(results.filter(result => !result.ok && /실행당 호출 예산/.test(result.reason)).length, 3,
        'the other three concurrent requests stop before external calls');
    }
    {
      const { C, state } = fixture({}, 3399);
      equal(await C.loadCoupangDayUsage(), 3399, 'today usage snapshot reads previous collector calls');
      equal(state.query.table, 'coupang_api_calls', 'daily snapshot reads the provider ledger');
      equal(state.query.source, 'collect', 'daily snapshot counts collector calls only');
      equal(Date.parse(state.query.end) - Date.parse(state.query.start), 86400000, 'daily snapshot uses one KST day');
      let release;
      state.gate = new Promise(resolve => { release = resolve; });
      const pending = [0, 1, 2, 3].map(i => C.fetchCoupangAll('daily-' + i));
      equal(state.external, 1, 'at 3399 today, concurrent requests reserve only one remaining daily slot');
      release();
      const results = await Promise.all(pending);
      equal(results.filter(result => !result.ok && /하루 호출 예산 3400/.test(result.reason)).length, 3,
        'the other daily requests stop before external calls');
      const denied = await C.fetchCoupangAll('daily-3401');
      equal(/하루 호출 예산 3400/.test(denied.reason), true, 'the 3401st daily call is denied');
      equal(state.external, 1, 'daily ceiling does not spend another provider call');
    }
    {
      for (const [count, error] of [[null, null], [NaN, null], [-1, null], [1.5, null],
        [0, { message: 'fixture database timeout' }]]) {
        const { C, state } = fixture({}, count, error);
        equal(await C.loadCoupangDayUsage(), 3400, `missing/invalid/failed daily snapshot fails closed (${String(count)}, ${error ? 'error' : 'no error'})`);
        const rejected = await C.fetchCoupangAll('unsafe-day-snapshot');
        equal(rejected.ok, false, 'a failed daily snapshot denies before entering the provider');
        equal(state.external, 0, 'a failed daily snapshot spends zero external calls');
      }
    }
    {
      const { C } = fixture({ COUPANG_RUN_BUDGET: '9000', COUPANG_DAY_BUDGET: '34000', COUPANG_COLLECT_MIN_GAP_MS: '1' });
      equal(C.COUPANG_RUN_BUDGET, 900, 'deployment overrides cannot increase the phase-one run ceiling');
      equal(C.COUPANG_DAY_BUDGET, 3400, 'deployment overrides cannot increase the daily ceiling');
      equal(C.COUPANG_MIN_GAP_MS, 3000, 'deployment overrides cannot make the collector faster than 3 seconds');
      const lower = fixture({ COUPANG_RUN_BUDGET: '10', COUPANG_DAY_BUDGET: '100', COUPANG_COLLECT_MIN_GAP_MS: '4000', COUPANG_MIN_GAP_MS: '1' }).C;
      equal(lower.COUPANG_RUN_BUDGET, 10, 'smaller run budgets remain configurable');
      equal(lower.COUPANG_DAY_BUDGET, 100, 'smaller daily budgets remain configurable');
      equal(lower.COUPANG_MIN_GAP_MS, 4000, 'a slower collector gap wins over legacy interactive gap settings');
    }
  } finally { console.warn = warn; }
  console.log(`\nPASS ${pass} / FAIL 0`);
})().catch(error => { console.error(error.stack || error); console.log(`PASS ${pass} / FAIL 1`); process.exitCode = 1; });
