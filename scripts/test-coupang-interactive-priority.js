#!/usr/bin/env node
'use strict';

// Exercise the real API wrapper against a loopback HTTP server. The quota RPC
// is isolated here; test-coupang-db-quota.js executes its real SQL separately.
const assert = require('assert');
const http = require('http');
const Module = require('module');
let pass = 0, apiHits = 0, acquireHits = 0, denyBackground = false;
const requests = [];
const finishes = [];
let heldKeyword = '', releaseAcquire = null, holdReady = null;
function equal(actual, expected, label) {
  assert.strictEqual(actual, expected, label);
  pass++;
  console.log('  PASS ' + label);
}
const server = http.createServer((req, res) => {
  apiHits++;
  const keyword = new URL(req.url, 'http://127.0.0.1').searchParams.get('keyword');
  requests.push(keyword);
  if (keyword === 'trigger-429') {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '3' });
    return res.end('Too Many Requests');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ rCode: '0', data: { productData: [] } }));
});
const fakeSupabase = {
  rpc(name, args) {
    if (name === 'coupang_acquire_v2') {
      acquireHits++;
      const allowed = !denyBackground || args.p_source === 'search';
      const response = { data: [{ allowed, call_id: allowed ? 'fixture-' + acquireHits : null,
        reason: allowed ? '' : 'collector/background 분당 budget 20/20', used: 20 }], error: null };
      if (args.p_keyword === heldKeyword) return new Promise(resolve => {
        releaseAcquire = () => resolve(response);
        if (holdReady) holdReady();
      });
      return Promise.resolve(response);
    }
    if (name === 'coupang_finish') finishes.push(args);
    return Promise.resolve({ data: null, error: null });
  },
  from() {
    const q = { select: () => q, eq: () => q,
      maybeSingle: async () => ({ data: null, error: null }), upsert: async () => ({ data: null, error: null }) };
    return q;
  }
};
function reload() {
  const supabasePath = require.resolve('../api/_supabase');
  require.cache[supabasePath] = Object.assign(new Module(supabasePath, null), {
    filename: supabasePath, loaded: true, exports: fakeSupabase
  });
  delete require.cache[require.resolve('../api/_coupang')];
  apiHits = 0; acquireHits = 0; denyBackground = false; requests.length = 0; finishes.length = 0;
  heldKeyword = ''; releaseAcquire = null; holdReady = null;
  return require('../api/_coupang');
}
const search = (C, keyword, source, extra = {}) => C.searchCoupang(keyword, {
  source, limit: 1, useCache: false, minGapMs: 1, maxWaitMs: 5000, ...extra
});

(async () => {
  process.env.COUPANG_DISABLE_GLOBAL_GATE = '0';
  process.env.COUPANG_ACCESS_KEY = 'fixture-access';
  process.env.COUPANG_SECRET_KEY = 'fixture-secret';
  process.env.COUPANG_MIN_GAP_MS = '1';
  for (const name of ['COUPANG_SEARCH_OPERATING_CAP', 'COUPANG_GLOBAL_MAX_PER_MIN',
    'COUPANG_INTERACTIVE_RESERVE_PER_MIN', 'COUPANG_COLLECTOR_MAX_PER_MIN']) delete process.env[name];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.COUPANG_API_HOST = `http://127.0.0.1:${server.address().port}`;
  const log = console.log, warn = console.warn;
  console.log = text => { if (!String(text).startsWith('[coupang]')) log(text); };
  console.warn = () => {};
  try {
    {
      const C = reload();
      await search(C, 'collector-first', 'collect', { minGapMs: 250 });
      const pending = [1, 2, 3].map(i => search(C, 'collector-pending-' + i, 'collect', { minGapMs: 250 }));
      // Let all background promises reach their spacing waits.
      await new Promise(resolve => setImmediate(resolve));
      const interactive = await search(C, 'interactive-priority', 'search', { minGapMs: 1, maxWaitMs: 20 });
      equal(interactive.apiCalled, true, 'interactive enters the provider while three collectors wait for their gaps');
      equal(requests[1], 'interactive-priority', 'interactive is served ahead of pending background requests');
      const completed = await Promise.all(pending);
      equal(completed.every(result => result.apiCalled === true), true, 'background spacing resumes after interactive search');
      equal(apiHits, 5, 'queue priority neither retries nor drops the already-authorized background requests');
    }
    {
      const C = reload();
      denyBackground = true;
      for (let i = 0; i < 36; i++) {
        const denied = await search(C, 'db-denied-' + i, 'collect');
        assert.strictEqual(denied.apiCalled, false, 'a denied DB reservation never reaches the provider');
      }
      equal(acquireHits, 36, 'DB-denied collectors release local reservations instead of filling the local operating cap');
      equal(apiHits, 0, 'repeated DB denial spends zero actual external calls');
      const interactive = await search(C, 'interactive-after-denials', 'search', { maxWaitMs: 20 });
      equal(interactive.apiCalled, true, 'repeated collector DB denials do not block an interactive local slot');
      equal(apiHits, 1, 'only the authorized interactive request reaches the provider');
      equal(C.localStats().inWindow, 1, 'the local rolling window counts only the retained external-call reservation');
    }
    {
      const C = reload();
      heldKeyword = 'pending-before-circuit';
      const ready = new Promise(resolve => { holdReady = resolve; });
      const pending = search(C, heldKeyword, 'collect');
      await ready;
      const blocked = await search(C, 'trigger-429', 'search');
      equal(blocked.apiCalled, true, 'the single 429 response counts as an external call');
      equal(blocked.blocked, true, 'the existing circuit opens on the provider 429');
      releaseAcquire();
      const cancelled = await pending;
      equal(cancelled.apiCalled, false, 'a DB-waiting collector is cancelled when another response opens the circuit');
      equal(apiHits, 1, 'the collector does not send another external request after the circuit opens');
      equal(finishes.some(args => args.res === 'cancelled_before_fetch'), true, 'the conservative DB reservation gets a cancelled-before-fetch outcome');
      equal(C.localStats().inWindow, 1, 'the cancelled collector releases its local interactive slot');
    }
    {
      const C = reload();
      const originalNow = Date.now;
      const frozenNow = originalNow();
      let elapsed = 0;
      Date.now = () => frozenNow + elapsed;
      try {
        const immediate = await search(C, 'zero-wait-fixture', 'search', { maxWaitMs: 0 });
        equal(immediate.apiCalled, true, 'maxWaitMs=0 still permits an immediately available slot');
        const pending = search(C, 'expired-spacing-wait', 'collect', { minGapMs: 100, maxWaitMs: 150 });
        // Freeze the reservation clock until its 100ms sleep has begun, then
        // simulate a delayed event-loop wakeup beyond the 150ms deadline.
        await new Promise(resolve => setImmediate(resolve));
        elapsed = 1000;
        const expired = await pending;
        equal(expired.apiCalled, false, 'an elapsed spacing deadline is rejected even when the gap has become zero');
        equal(/최대 대기 시간 소진/.test(expired.error), true, 'the expired wait reports its bounded deadline');
        equal(acquireHits, 1, 'the expired waiter does not reserve a DB call');
        equal(apiHits, 1, 'the expired waiter does not send another external request');
      } finally { Date.now = originalNow; }
    }
    {
      const C = reload();
      for (let i = 0; i < 20; i++) assert.strictEqual((await search(C, 'local-collector-' + i, 'collect')).apiCalled, true);
      equal(apiHits, 20, 'the local collector limiter allows exactly 20 calls');
      const beforeAcquire = acquireHits;
      const denied = await search(C, 'local-collector-21', 'collect');
      equal(denied.apiCalled, false, 'the local collector limiter refuses call 21');
      equal(acquireHits, beforeAcquire, 'the local 21st collector refusal does not reserve a DB call');
      for (let i = 0; i < 15; i++) assert.strictEqual((await search(C, 'local-interactive-' + i, 'search')).apiCalled, true);
      equal(apiHits, 35, '15 interactive calls remain usable after 20 actual collector calls');
      equal((await search(C, 'local-interactive-36', 'search')).apiCalled, false, 'the local Search operating cap remains 35');
      equal(apiHits, 35, 'the local limiter does not make external call 36');
    }
    console.log(`\nPASS ${pass} / FAIL 0`);
  } finally { console.log = log; console.warn = warn; server.close(); }
})().catch(error => { console.error(error.stack || error); server.close(); console.log(`PASS ${pass} / FAIL 1`); process.exitCode = 1; });
