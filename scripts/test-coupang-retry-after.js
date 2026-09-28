#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const Module = require('module');
const path = require('path');

let apiHits = 0;
const rpcCalls = [];
const server = http.createServer((_req, res) => {
  apiHits++;
  res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '3' });
  res.end('Too Many Requests');
});

const fakeSupabase = {
  rpc(name, args) {
    rpcCalls.push({ name, args });
    if (name === 'coupang_acquire_v2') {
      return Promise.resolve({ data: [{ allowed: true, call_id: 'fixture-call', reason: '', used: 1 }], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  },
  from() {
    const q = {
      select() { return q; },
      eq() { return q; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      upsert() { return Promise.resolve({ data: null, error: null }); }
    };
    return q;
  }
};

(async () => {
  process.env.COUPANG_DISABLE_GLOBAL_GATE = '0';
  process.env.COUPANG_ACCESS_KEY = 'fixture-access';
  process.env.COUPANG_SECRET_KEY = 'fixture-secret';
  process.env.COUPANG_MIN_GAP_MS = '1';
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.COUPANG_API_HOST = `http://127.0.0.1:${server.address().port}`;

  const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
  const coupangPath = require.resolve(path.join(__dirname, '..', 'api', '_coupang.js'));
  require.cache[supabasePath] = Object.assign(new Module(supabasePath, null), {
    filename: supabasePath, loaded: true, exports: fakeSupabase
  });
  delete require.cache[coupangPath];
  const Coupang = require('../api/_coupang');

  try {
    assert.strictEqual(Coupang.parseRetryAfter('3', 0), 3000, 'delta-seconds parses');
    assert.strictEqual(Coupang.parseRetryAfter('not-a-date', 0), null, 'invalid value falls back');
    assert.strictEqual(Coupang.parseRetryAfter(null, 0), null, 'missing header falls back');
    assert.strictEqual(Coupang.parseRetryAfter(new Date(5000).toUTCString(), 0), 5000,
      'HTTP-date parses relative to current time');

    const result = await Coupang.searchCoupang('retry-after fixture', {
      source: 'search', limit: 1, useCache: false, maxWaitMs: 5000, minGapMs: 1
    });
    const block = rpcCalls.find(call => call.name === 'coupang_block_seconds');
    assert.strictEqual(apiHits, 1, '429 is not retried');
    assert.strictEqual(result.apiCalled, true, 'one provider request was made');
    assert.strictEqual(result.blocked, true, '429 is reported as blocked');
    assert.ok(block, 'shared block RPC is called');
    assert.strictEqual(block.args.p_seconds, 3, 'Retry-After overrides default cooldown');
    assert.strictEqual(Coupang.localStats().blockedForSec, 3, 'local circuit uses same Retry-After');
    assert.ok(rpcCalls.some(call => call.name === 'coupang_finish'), 'reserved call gets a final outcome');
    console.log('PASS: Retry-After delta/date parsing, shared seconds block, and no retry');
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  server.close();
  process.exitCode = 1;
});
