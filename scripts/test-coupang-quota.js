#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const Module = require('module');
const path = require('path');

let apiHits = 0;
let rpcMode = 'denied';
let rpcCalls = 0;
let cacheRow = null;

const server = http.createServer((req, res) => {
  apiHits++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
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
    rpc(name) {
      if (name === 'coupang_acquire') {
        rpcCalls++;
        if (rpcMode === 'error') return Promise.resolve({ data: null, error: { message: 'temporary Supabase timeout' } });
        if (rpcMode === 'denied') return Promise.resolve({
          data: [{ allowed: false, call_id: null, reason: '시간당 검색 한도 10/10', used: 10 }],
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

  const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
  const coupangPath = require.resolve(path.join(__dirname, '..', 'api', '_coupang.js'));
  require.cache[supabasePath] = Object.assign(new Module(supabasePath, null), {
    filename: supabasePath, loaded: true, exports: fakeSupabase()
  });
  delete require.cache[coupangPath];
  const Coupang = require('../api/_coupang');
  const attempt = opts => Coupang.searchCoupang('quota fixture', {
    source: 'test', limit: 1, maxWaitMs: 5000, minGapMs: 1, ...opts
  });

  try {
    assert.strictEqual(Coupang.MAX_PER_HOUR, 10, 'official hourly limit is explicit');
    assert.strictEqual(Coupang.shouldDisableGlobalGateForTest('1', 'https://api-gateway.coupang.com'), false,
      'test switch cannot disable the production-host quota gate');
    assert.strictEqual(Coupang.shouldDisableGlobalGateForTest('1', 'http://127.0.0.1:3000'), true,
      'test switch only disables a loopback mock');
    let result = await attempt({ useCache: false });
    assert.strictEqual(result.apiCalled, false, 'hourly gate denies before provider call');
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

    const midnight = Date.parse(today + 'T00:00:00+09:00');
    cacheRow.fetched_at = new Date(midnight - 60000).toISOString();
    rpcMode = 'denied';
    result = await attempt({ useCache: true, cacheTtlMs: 24 * 60 * 60 * 1000 });
    assert.strictEqual(result.from, 'stale-cache', 'yesterday cache cannot count as today');
    assert.strictEqual(result.apiCalled, false);
    assert.strictEqual(apiHits, beforeApi);

    console.log('PASS: global quota gate, reserved-call invariant, and cache date boundary');
    process.exitCode = 0;
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();