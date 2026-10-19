#!/usr/bin/env node
'use strict';

// Offline only: inject a fake Supabase client before loading the production
// wrapper. No Supabase credentials, network calls, or database writes occur.
const assert = require('assert');
const Module = require('module');

process.env.VERCEL_ENV = 'preview';
process.env.SUPABASE_URL = 'https://supabase.mock.invalid';
process.env.SUPABASE_SECRET_KEY = 'offline-fixture-only';
process.env.COUPANG_ACCESS_KEY = 'offline-fixture-only';
process.env.COUPANG_SECRET_KEY = 'offline-fixture-only';
process.env.ADPICK_API_KEY = 'offline-fixture-only';

const calls = { reads: 0, writes: 0, rpc: 0, fetch: 0, saves: 0, searches: 0 };
function queryBuilder() {
  const q = {
    select() { return q; },
    eq() { return q; },
    in() { return q; },
    gte() { return q; },
    order() { return q; },
    range() { return q; },
    limit() { return q; },
    maybeSingle() { return q; },
    single() { return q; },
    insert() { calls.writes++; return q; },
    upsert() { calls.writes++; return q; },
    update() { calls.writes++; return q; },
    delete() { calls.writes++; return q; },
    then(resolve, reject) {
      calls.reads++;
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    }
  };
  return q;
}
const fakeClient = {
  from() { return queryBuilder(); },
  rpc() { calls.rpc++; return Promise.resolve({ data: null, error: null }); }
};

const originalLoad = Module._load;
Module._load = function loadWithFakeSupabase(request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient };
  return originalLoad.call(this, request, parent, isMain);
};

global.fetch = async () => {
  calls.fetch++;
  throw new Error('Unexpected network call in offline read-only test');
};

const db = require('../api/_supabase');
const assertBlocked = (fn, label) => {
  assert.throws(fn, /Preview database write blocked/, label);
};

async function main() {
  const metrics = await db.runAiReadOnly(async () => {
    assert.strictEqual(db.isAiReadOnly(), true, 'Preview AI enters trusted read-only scope');
    // A caller-supplied header has no role in the deployment decision.
    const spoofedReq = { headers: { 'x-vercel-env': 'production', 'x-seosa-ai-readonly': '0' } };
    assert.strictEqual(db.isPreviewDeployment(), true, 'request headers cannot disable Preview protection');
    void spoofedReq;

    await db.from('products').select('product_id').maybeSingle();
    for (const method of ['insert', 'upsert', 'update', 'delete']) {
      assertBlocked(() => db.from('products')[method]({ product_id: 'fixture' }), `${method} blocked`);
    }
    assert.throws(() => db.rpc('mutating_or_unknown_rpc'), /Preview database RPC blocked/);

    // The provider circuit intentionally owns a separate Supabase client.
    // Its gate/fail/success RPCs must still be blocked inside the Preview scope.
    const circuit = require('../api/_global-circuit');
    const gate = await circuit.before('offline-provider', 'offline-model');
    assert.strictEqual(gate.degraded, true, 'Preview circuit gate degrades to local state without DB');
    circuit._reset(); // Re-enable each RPC path in memory; no database state exists here.
    await circuit.failure('offline-provider', 'offline-model', 'quota', 1000);
    circuit._reset();
    await circuit.success('offline-provider', 'offline-model', 'offline-probe');

    const coupang = require('../api/_coupang');
    const adpick = require('../api/_adpick');
    const c = await coupang.searchCoupang('offline mouse', { source: 'ai', maxWaitMs: 0 });
    const a = await adpick.searchAdpick('offline mouse', { source: 'ai', maxWaitMs: 0 });
    assert.strictEqual(c.from, 'none', 'Coupang cache miss fails closed');
    assert.strictEqual(a.from, 'none', 'ADPICK cache miss fails closed');
    assert.strictEqual(c.blocked, true);
    assert.strictEqual(a.blocked, true);
    return db.readOnlyMetrics();
  });

  assert.deepStrictEqual(metrics, { writeAttempts: 4, rpcBlocked: 4 });
  assert.strictEqual(calls.writes, 0, 'the fake DB observed zero write operations');
  assert.strictEqual(calls.rpc, 0, 'the fake DB observed zero RPCs');
  assert.strictEqual(calls.fetch, 0, 'provider cache misses do not call external APIs in Preview');
  assert(calls.reads >= 3, 'read-only cache and product queries remain available');

  // The AI search path must skip saveProducts even when a provider returns a
  // usable fixture. This is a mocked repository and cannot touch a real DB.
  const shopPath = require.resolve('../api/_shop');
  const trustPath = require.resolve('../api/_trust');
  require.cache[shopPath] = {
    id: shopPath, filename: shopPath, loaded: true,
    exports: {
      async searchAll() {
        calls.searches++;
        const item = {
          title: 'Offline mouse fixture', lprice: 1200, link: 'https://example.invalid/item',
          image: '', mall: '쿠팡', productId: 'offline-product', isCoupang: true,
          _source: 'api', vendorItemId: 'offline-option'
        };
        return { items: [item], allItems: [item], from: 'api', blocked: false };
      },
      async saveProducts() { calls.saves++; }
    }
  };
  require.cache[trustPath] = {
    id: trustPath, filename: trustPath, loaded: true,
    exports: { async attachTrust(items) { return items; } }
  };
  const ai = require('../api/ai');
  const background = [];
  const found = await db.runAiReadOnly(() => ai._internal.searchProducts(
    'mouse', 5000, { background: promise => background.push(promise) }
  ));
  assert.strictEqual(found.ok, true);
  assert.strictEqual(found.items.length, 1);
  assert.strictEqual(calls.searches, 1);
  assert.strictEqual(calls.saves, 0, 'Preview AI search does not call saveProducts');
  assert.strictEqual(background.length, 0, 'Preview AI search schedules no background persistence');

  // In Production, the Preview-only guard is inactive and the existing AI
  // observation persistence callback remains available.
  process.env.VERCEL_ENV = 'production';
  assert.strictEqual(db.isPreviewDeployment(), false);
  const scheduled = [];
  await ai._internal.searchProducts('mouse', 5000, { background: promise => scheduled.push(promise) });
  await Promise.all(scheduled);
  assert.strictEqual(calls.saves, 1, 'Production AI search persistence remains enabled');
  await db.from('products').upsert({ product_id: 'production-fixture' });
  assert.strictEqual(calls.writes, 1, 'Production Supabase writes remain enabled');

  process.stdout.write('AI Preview read-only offline assertions passed (mock Supabase; no real credentials or network)\n');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
