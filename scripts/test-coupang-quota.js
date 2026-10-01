#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const Module = require('module');
const path = require('path');

let apiHits = 0;
let rpcMode = 'denied';
let rpcCalls = 0;
let lastAcquire = null;
let cacheRow = null;
let responseMode = 'ok';

const server = http.createServer((req, res) => {
  apiHits++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (responseMode === 'parse-error') return res.end('temporarily invalid JSON');
  if (responseMode === 'param-error') return res.end(JSON.stringify({ rCode: '400', rMessage: 'bad fixture parameter' }));
  res.end(JSON.stringify({
    rCode: '0',
    data: { productData: [{
      productId: 7001,
      productName: 'safe quota fixture',
      productPrice: 1000,
      productUrl: 'https://link.coupang.com/re?itemId=71&vendorItemId=701'
    }] }
  }));
});

function fakeSupabase() {
  return {
    rpc(name, args) {
      if (name === 'coupang_acquire_v2') {
        rpcCalls++;
        lastAcquire = args;
        if (rpcMode === 'error') return Promise.resolve({ data: null, error: { message: 'temporary Supabase timeout' } });
        if (rpcMode === 'denied') return Promise.resolve({
          data: [{ allowed: false, call_id: null, reason: 'Search 분당 운영 budget 35/35', used: 35 }],
          error: null
        });
        if (rpcMode === 'no-id') return Promise.resolve({
          data: [{ allowed: true, call_id: null, reason: '', used: 1 }],
          error: null
        });
        return Promise.resolve({
          data: [{ allowed: true, call_id: 'reserved-1', reason: '', used: 1 }],
          error: null
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(name) {
      let keyword = '';
      const q = {
        select() { return q; },
        eq(column, value) { if (column === 'keyword') keyword = value; return q; },
        maybeSingle() {
          return Promise.resolve({
            data: name === 'coupang_search_cache' && cacheRow && cacheRow.keyword === keyword ? cacheRow : null,
            error: null
          });
        },
        upsert(row) {
          cacheRow = row;
          return Promise.resolve({ data: null, error: null });
        }
      };
      return q;
    }
  };
}

(async () => {
  process.env.COUPANG_DISABLE_GLOBAL_GATE = '0';
  process.env.COUPANG_ACCESS_KEY = 'test-access';
  process.env.COUPANG_SECRET_KEY = 'test-secret';
  process.env.COUPANG_MIN_GAP_MS = '1';
  process.env.COUPANG_API_HOST = 'http://127.0.0.1';
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.COUPANG_API_HOST = 'http://127.0.0.1:' + server.address().port;
  // A legacy setting may have allowed 40/min; it must not raise the new
  // configured operating budget unless the new setting is explicitly provided.
  process.env.COUPANG_MAX_PER_MIN = '40';
  delete process.env.COUPANG_SEARCH_OPERATING_CAP;
  delete process.env.COUPANG_COLLECTOR_MAX_PER_MIN;
  delete process.env.COUPANG_INTERACTIVE_RESERVE_PER_MIN;
  delete process.env.COUPANG_GLOBAL_MAX_PER_MIN;

  const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
  const coupangPath = require.resolve(path.join(__dirname, '..', 'api', '_coupang.js'));
  require.cache[supabasePath] = Object.assign(new Module(supabasePath, null), {
    filename: supabasePath, loaded: true, exports: fakeSupabase()
  });
  delete require.cache[coupangPath];
  const Coupang = require('../api/_coupang');
  const attempt = opts => Coupang.searchCoupang('quota fixture', {
    source: 'search', limit: 1, maxWaitMs: 5000, minGapMs: 1, ...opts
  });

  try {
    assert.strictEqual(Coupang.MAX_PER_MIN, 35, 'Search operating budget is 35/min');
    assert.strictEqual(Coupang.SEARCH_HARD_CAP, 50, 'Search hard cap is 50/min');
    assert.strictEqual(Coupang.GLOBAL_OPERATING_CAP, 80, 'initial global operating budget is 80/min');
    assert.strictEqual(Coupang.GLOBAL_HARD_CAP, 100, 'global API hard cap is 100/min');
    assert.strictEqual(Coupang.INTERACTIVE_RESERVE, 15, '15/min remains available to interactive search');
    assert.strictEqual(Coupang.COLLECTOR_BUDGET, 20, 'collector/background budget is 20/min');
    assert.strictEqual(Coupang.shouldDisableGlobalGateForTest('1', 'https://api-gateway.coupang.com'), false,
      'test switch cannot disable the production-host quota gate');
    assert.strictEqual(Coupang.shouldDisableGlobalGateForTest('1', 'http://127.0.0.1:3000'), true,
      'test switch only disables a loopback mock');
    let result = await attempt({ useCache: false });
    assert.strictEqual(result.apiCalled, false, 'minute budget denies before provider call');
    assert.strictEqual(lastAcquire.p_source, 'search');
    assert.strictEqual(lastAcquire.p_search_operating_cap, 35);
    assert.strictEqual(lastAcquire.p_global_operating_cap, 80);
    assert.strictEqual(lastAcquire.p_interactive_reserve, 15);
    assert.strictEqual(lastAcquire.p_collector_cap, 20);
    assert.strictEqual(apiHits, 0);

    result = await attempt({ source: 'collect', useCache: false });
    assert.strictEqual(result.apiCalled, false, 'collector uses the same atomic gate without consuming an interactive call');
    assert.strictEqual(lastAcquire.p_source, 'collect', 'source identity reaches the DB quota function');
    assert.strictEqual(apiHits, 0);

    rpcMode = 'error';
    result = await attempt({ useCache: false });
    assert.strictEqual(result.apiCalled, false, 'transient gate error fails closed');
    assert.strictEqual(apiHits, 0);

    rpcMode = 'no-id';
    result = await attempt({ useCache: false });
    assert.strictEqual(result.apiCalled, false, 'missing reservation id fails closed');
    assert.strictEqual(apiHits, 0);

    rpcMode = 'allowed';
    result = await attempt({ useCache: false });
    assert.strictEqual(result.from, 'api', 'valid reservation permits one request');
    assert.strictEqual(result.apiCalled, true);
    assert.strictEqual(apiHits, 1, 'no unreserved request reached the API');
    responseMode = 'param-error';
    result = await attempt({ useCache: false });
    assert.strictEqual(result.apiCalled, true, 'rCode=400 still consumes an actual external call');
    assert.strictEqual(apiHits, 2, 'parameter errors are not retried');
    responseMode = 'parse-error';
    result = await attempt({ useCache: false });
    assert.strictEqual(result.apiCalled, true, 'invalid JSON still consumes an actual external call');
    assert.strictEqual(apiHits, 3, 'invalid responses are not retried');
    responseMode = 'ok';

    const cacheDate = require('../api/_cache-date');
    const today = cacheDate.kstDateKey(new Date());
    cacheRow = {
      keyword: 'quota fixture',
      items: [{ productId: '7001', title: 'today', lprice: 1000, itemId: '71', vendorItemId: '701' }],
      req_limit: 10,
      fetched_at: new Date().toISOString()
    };
    const beforeRpc = rpcCalls;
    const beforeApi = apiHits;
    result = await attempt({ useCache: true });
    assert.strictEqual(result.from, 'cache', 'today cache remains reusable');
    assert.strictEqual(rpcCalls, beforeRpc, 'today cache does not reserve a provider call');
    assert.strictEqual(apiHits, beforeApi);

    // The DB gate remains authoritative; deployment values cannot consume the
    // reserved interactive share or turn this first rollout into 25/min.
    const loadConfig = () => { delete require.cache[coupangPath]; return require('../api/_coupang'); };
    process.env.COUPANG_COLLECTOR_MAX_PER_MIN = '25';
    process.env.COUPANG_INTERACTIVE_RESERVE_PER_MIN = '1';
    const unsafeConfig = loadConfig();
    assert.strictEqual(unsafeConfig.COLLECTOR_BUDGET, 20, 'an excessive collector override is clamped at 20/min');
    assert.strictEqual(unsafeConfig.INTERACTIVE_RESERVE, 15, 'an override cannot remove the minimum interactive reserve');
    process.env.COUPANG_SEARCH_OPERATING_CAP = '30';
    const lowerConfig = loadConfig();
    assert.strictEqual(lowerConfig.COLLECTOR_BUDGET, 15, 'a lower operating cap leaves the interactive reserve intact');

    const midnight = Date.parse(today + 'T00:00:00+09:00');
    cacheRow.fetched_at = new Date(midnight - 60000).toISOString();
    rpcMode = 'denied';
    result = await attempt({ useCache: true, cacheTtlMs: 24 * 60 * 60 * 1000 });
    assert.strictEqual(result.from, 'stale-cache', 'yesterday cache cannot count as today');
    assert.strictEqual(result.apiCalled, false);
    assert.strictEqual(apiHits, beforeApi);

    console.log('PASS: minute quota config, isolated call source, fail-closed reservation, and cache date boundary');
    process.exitCode = 0;
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
