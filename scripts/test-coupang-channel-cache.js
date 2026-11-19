#!/usr/bin/env node
'use strict';
/*
 * SEOSA2026 partner channel cache contract — offline, no DB/provider calls.
 * Test with a local fake API and an in-memory Supabase-compatible cache.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');

process.env.COUPANG_DISABLE_GLOBAL_GATE = '1';
process.env.COUPANG_ACCESS_KEY = 'test-access';
process.env.COUPANG_SECRET_KEY = 'test-secret';
process.env.COUPANG_MIN_GAP_MS = '1';
process.env.COUPANG_FETCH_LIMIT = '1';
delete process.env.COUPANG_CHANNEL_ROLLOUT;
delete process.env.COUPANG_CHANNEL_SUBID;
delete process.env.COUPANG_CHANNEL_MODE;
delete process.env.COUPANG_CHANNEL_ALL_WRITERS_ACK;
delete process.env.COUPANG_CHANNEL_CANARY_PERCENT;

const legacy = new Map();
const channel = new Map();
let failChannelRead = false;
let serverMode = 'good';
let apiCalls = 0;

function fakeQuery(table) {
  const filters = {};
  const self = {
    select() { return self; },
    eq(field, value) { filters[field] = value; return self; },
    async maybeSingle() {
      if (table === 'coupang_channel_search_cache' && failChannelRead) {
        return { data: null, error: { message: 'relation missing (test)' } };
      }
      const db = table === 'coupang_search_cache' ? legacy
        : table === 'coupang_channel_search_cache' ? channel : null;
      if (!db) throw Error('unexpected table ' + table);
      const key = table === 'coupang_search_cache'
        ? filters.keyword : filters.sub_id + '|' + filters.keyword;
      return { data: db.get(key) || null, error: null };
    },
    async upsert(row) {
      const db = table === 'coupang_search_cache' ? legacy
        : table === 'coupang_channel_search_cache' ? channel : null;
      if (!db) throw Error('unexpected upsert table ' + table);
      const key = table === 'coupang_search_cache'
        ? row.keyword : row.sub_id + '|' + row.keyword;
      db.set(key, row);
      return { data: null, error: null };
    }
  };
  return self;
}

const mockSupabase = { from: fakeQuery };
const origLoad = Module._load;
Module._load = function(req) {
  if (req === './_supabase') return mockSupabase;
  return origLoad.apply(this, arguments);
};

const server = http.createServer((req, res) => {
  apiCalls++;
  const url = new URL(req.url, 'http://127.0.0.1');
  const subId = url.searchParams.get('subId') || '';
  const used = serverMode === 'bad' ? 'WRONG_CHANNEL' : subId;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    rCode: '0',
    data: { productData: [{
      productId: '9369201576', productName: '에어팟 프로 3',
      productPrice: 296000,
      productUrl: 'https://link.coupang.com/re/AFFSDP?lptag=AF8789251&itemId=111&vendorItemId=222'
        + (used ? '&subId=' + used : ''),
      productImage: 'https://img.invalid/earbuds.jpg'
    }] }
  }));
});

let passed = 0;
function test(ok, message) {
  assert.ok(ok, message);
  passed++;
  process.stdout.write('[PASS] ' + message + '\n');
}

server.listen(0, async () => {
  process.env.COUPANG_API_HOST = 'http://127.0.0.1:' + server.address().port;
  try {
    const C = require('../api/_coupang');
    const kw = '에어팟 프로 3';
    const legacyItem = {
      productId: '9369201576', title: kw, lprice: 296000,
      link: 'https://link.coupang.com/re/AFFSDP?lptag=AF8789251&itemId=111&vendorItemId=222'
    };
    legacy.set(kw, { keyword: kw, items: [legacyItem], req_limit: 10, fetched_at: new Date().toISOString() });

    test(C.channelCacheTable('') === 'coupang_search_cache'
      && C.channelCacheTable('SEOSA2026') === 'coupang_channel_search_cache', 'legacy and channel tables are different');
    const options = { source: 'test', limit: 1, maxWaitMs: 5000 };
    let r = await C.searchCoupang(kw, options);
    test(r.from === 'cache' && apiCalls === 0 && !r.items[0].link.includes('subId'),
      'default OFF serves unchanged legacy cache without API call');

    process.env.COUPANG_CHANNEL_ROLLOUT = '1';
    process.env.COUPANG_CHANNEL_SUBID = 'SEOSA2026';
    process.env.COUPANG_CHANNEL_MODE = 'full';
    process.env.COUPANG_CHANNEL_ALL_WRITERS_ACK = '1';
    test(C.activeChannelSubId() === 'SEOSA2026', 'explicit full rollout reads configured SUBID');
    r = await C.searchCoupang(kw, options);
    test(r.from === 'api' && apiCalls === 1 && C.linkHasChannel(r.items[0].link, 'SEOSA2026'),
      'channel ON skips legacy cache and returns tagged provider URL');
    test(channel.has('SEOSA2026|' + kw) && legacy.get(kw).items[0].link === legacyItem.link,
      'channel cache write does not modify legacy cache');
    r = await C.searchCoupang(kw, options);
    test(r.from === 'cache' && apiCalls === 1 && C.linkHasChannel(r.items[0].link, 'SEOSA2026'),
      'channel cache hit does not call upstream again');

    delete process.env.COUPANG_CHANNEL_ROLLOUT;
    r = await C.searchCoupang(kw, options);
    test(r.from === 'cache' && apiCalls === 1 && r.items[0].link === legacyItem.link,
      'rollout OFF instantly restores legacy cache behavior');

    // Search-only canary never changes collectors, cron, or AI requests.
    process.env.COUPANG_CHANNEL_ROLLOUT = '1';
    process.env.COUPANG_CHANNEL_SUBID = 'SEOSA2026';
    process.env.COUPANG_CHANNEL_MODE = 'canary';
    process.env.COUPANG_CHANNEL_CANARY_PERCENT = '100';
    test(C.activeChannelSubId('search', kw) === 'SEOSA2026'
      && C.activeChannelSubId('collect', kw) === ''
      && C.activeChannelSubId('cron', kw) === ''
      && C.activeChannelSubId('ai', kw) === '',
      'canary applies only to live search, never collectors/cron/AI');
    const collected = await C.searchCoupang(kw, { ...options, source: 'collect' });
    test(collected.from === 'cache' && collected.items[0].link === legacyItem.link,
      'collector still reads legacy cache during canary');
    r = await C.searchCoupang(kw, { ...options, source: 'search' });
    test(r.from === 'cache' && C.linkHasChannel(r.items[0].link, 'SEOSA2026'),
      'real-time search reads channel cache during canary');

    process.env.COUPANG_CHANNEL_MODE = 'full';
    process.env.COUPANG_CHANNEL_ALL_WRITERS_ACK = '1';
    failChannelRead = true;
    const beforeMissing = apiCalls;
    r = await C.searchCoupang('다른 키워드', options);
    test(r.from === 'none' && r.apiCalled === false && apiCalls === beforeMissing,
      'missing channel cache table fails closed, no upstream call');
    failChannelRead = false;

    serverMode = 'bad';
    const beforeBad = apiCalls;
    r = await C.searchCoupang('새 키워드', options);
    test(r.from === 'none' && !!r.error && apiCalls === beforeBad + 1
      && !channel.has('SEOSA2026|새 키워드'),
      'mismatched upstream SUBID never enters channel cache');

    process.env.COUPANG_CHANNEL_SUBID = 'bad@id';
    const beforeInvalid = apiCalls;
    r = await C.searchCoupang('아무 키워드', options);
    test(r.from === 'none' && /채널 설정 오류/.test(r.error) && apiCalls === beforeInvalid,
      'invalid channel configuration fails closed');

    delete process.env.COUPANG_CHANNEL_ROLLOUT;
    delete process.env.COUPANG_CHANNEL_SUBID;
    delete process.env.COUPANG_CHANNEL_MODE;
    delete process.env.COUPANG_CHANNEL_ALL_WRITERS_ACK;
    delete process.env.COUPANG_CHANNEL_CANARY_PERCENT;
    process.stdout.write('PASS ' + passed + ' / FAIL 0 (offline, API external 0, DB external 0)\n');
  } catch (e) {
    process.stderr.write('FAIL: ' + (e && e.stack || e) + '\n');
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
