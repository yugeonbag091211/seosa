#!/usr/bin/env node
'use strict';
// Offline unit + actual provider integration. Real PostgreSQL RPCs are tested in test-collector-ledger-db.js.
const assert = require('assert');
const crypto = require('crypto');
const { createQueryLedger, normalizeQuery, queryIdentity, queryHash, ledgerEnabled, failureReason, validPayload,
  payloadFor, expireQueryResults, RETRY_MS } = require('../api/_collector-query');
const Failure = require('../api/_collector-failure');
const { kstDateKey } = require('../api/_cache-date');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

// Mirrors the SQL claim/begin/finish transitions (real SQL: test-collector-ledger-db.js).
function fakeDb(clock) {
  const rows = new Map();
  const legacy = new Map();
  const db = { rows, legacy, fail: false, denyBegin: false,
    async rpc(name, a) {
      if (db.fail) return { error: { message: 'not exposed: do-not-print-secret' } };
      const date = a.p_date || kstDateKey(clock());
      const key = `${a.p_source}:${date}:${a.p_query_hash}`;
      let row = rows.get(key);
      if (name === 'collector_query_claim') {
        // The SQL recomputes the hash and checks the canonical form; so does this mirror.
        assert.equal(crypto.createHash('sha256').update(a.p_normalized_query, 'utf8').digest('hex'), a.p_query_hash);
        assert.equal(normalizeQuery(a.p_normalized_query), a.p_normalized_query);
        if (!row) {
          row = { kst_date: date, status: 'running', claim_token: a.p_token, request_count: 0, lease: clock() + a.p_lease_seconds * 1000 };
          rows.set(key, row);
        }
        let action;
        if (row.status === 'completed') action = row.expires > clock() ? 'cached' : 'daily_done';
        else if (row.status === 'running' && row.claim_token === a.p_token) action = 'claimed';
        else if (row.status === 'running' && (row.started || row.lease > clock())) action = 'inflight';
        else if (row.request_count >= 2 || (row.status === 'failed' && !Failure.isRetryable(row.failure_reason || 'UNKNOWN'))) action = 'daily_done';
        else if (Date.parse(row.next_retry_at) > clock()) action = 'deferred';
        else { action = 'claimed'; Object.assign(row, { status: 'running', claim_token: a.p_token, started: false, lease: clock() + 180000 }); }
        return { data: { ...row, action } };
      }
      if (name === 'collector_query_begin') {
        const begun = !db.denyBegin && row && row.claim_token === a.p_token && row.status === 'running'
          && !row.started && row.lease > clock() && row.request_count < 2;
        if (begun) { row.started = true; row.request_count++; }
        return { data: !!begun };
      }
      if (name === 'collector_query_finish') {
        const finished = row && row.claim_token === a.p_token && row.status === 'running';
        if (finished) Object.assign(row, { status: a.p_status, result: a.p_result, failure_reason: a.p_failure_reason,
          next_retry_at: a.p_next_retry_at, expires: clock() + 86400000 });
        return { data: !!finished };
      }
      if (name === 'collector_query_invalidate') {
        if (row && row.claim_token === a.p_token && row.status === 'completed') {
          Object.assign(row, { status: 'failed', result: null, failure_reason: 'SOURCE_ERROR', next_retry_at: new Date(clock() + RETRY_MS).toISOString() });
        }
        return { data: row || null };
      }
      return { data: null };
    },
    // Provider cache/limiter tables: any chain resolves; the legacy search cache is readable.
    from(table) {
      let keyword;
      const q = new Proxy({}, { get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej);
        if (prop === 'eq') return (field, value) => { if (field === 'keyword') keyword = value; return q; };
        if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: legacy.get(`${table}:${keyword}`) || null, error: null });
        if (prop === 'upsert') return async row => { if (row && row.keyword) legacy.set(`${table}:${row.keyword}`, row); return { error: null }; };
        return () => q;
      } });
      return q;
    }
  };
  return db;
}
const cp = { productId: '11', title: 'Model A 128GB', lprice: 10000, oprice: 10000,
  link: 'https://link.coupang.com/a?itemId=1&vendorItemId=2', itemId: '1', vendorItemId: '2' };
const ad = { title: 'Model A', price: 10000, commissionlink: 'https://shop.example/a', cpCode: '1' };

async function main() {
  // ── canonical query identity ────────────────────────────────────────
  check('canonical-equivalent spacing/case/width/zero-width/NFD variants share one identity', () => {
    const same = ['삼성   갤럭시 버즈3', ' 삼성 갤럭시 버즈3 ', '삼성 갤럭시 버즈3', '삼성\u00A0갤럭시\u3000버즈3',
      '삼성\t갤럭시\n버즈３', '삼성\u200B 갤럭시 버즈3\uFEFF', '삼성 갤럭시 버즈3'.normalize('NFD'), '삼성\u0085갤럭시 버즈3'];
    same.forEach(q => assert.equal(normalizeQuery(q), '삼성 갤럭시 버즈3', JSON.stringify(q)));
    assert.equal(new Set(same.map(queryHash)).size, 1);
    assert.equal(normalizeQuery(' Ｇａｌａｘｙ  S24 Ultra '), 'galaxy s24 ultra');
    assert.equal(normalizeQuery(' Ａ  +  B\n128GB '), 'a + b 128gb');
  });
  check('meaningfully different queries are never merged', () => {
    for (const [a, b] of [['A+B', 'A B'], ['128GB', '256GB'], ['버즈3', '버즈 3'], ['삼성갤럭시', '삼성 갤럭시'],
      ['아이폰15', '아이폰 15 프로'], ['USB-C', 'USB C'], ['1.5L', '15L']]) {
      assert.notEqual(queryHash(a), queryHash(b), `${a} vs ${b}`);
    }
  });
  check('identity describes the provider request: trimmed, capped at 80 characters, then canonical', () => {
    const long = `${'가'.repeat(79)}나다라`;
    assert.equal(queryIdentity(`  ${long}`), '가'.repeat(79) + '나');
    assert.equal(queryIdentity('   '), '');
  });
  check('canonical form is idempotent and satisfies the SQL invariants (200k random strings)', () => {
    const pool = [...'AaZz09 +-/()[]_.,\u00a0\u3000\t\n\u0085\u200b\ufeff\u00ad\uff21\uff5a\uff10\uff19\ufb03\u2460\u2122\u338e\u0130\u1e9e\u03a3\u03c2삼성갤럭시버즈\u1100\u1161\u11a8\u0307'];
    let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 200000; i++) {
      let s = ''; for (let j = rnd(12); j > 0; j--) s += pool[rnd(pool.length)];
      const n = normalizeQuery(s);
      assert(normalizeQuery(n) === n && n === n.trim() && !/ {2}/.test(n) && !/[A-Z]/.test(n)
        && n.normalize('NFKC') === n && !/[\u0000-\u001f\u007f-\u009f]/.test(n), JSON.stringify(s));
    }
  });

  // ── failure taxonomy ────────────────────────────────────────────────
  check('401 and 403 are AUTH_ERROR, never NETWORK_ERROR or SOURCE_ERROR', () => {
    for (const error of ['쿠팡 API 401: Unauthorized', '쿠팡 API 403: Access denied', 'ADPICK API 403: forbidden',
      '호출 중단 중 (120초 남음): HTTP 401: invalid signature', 'COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 환경변수 없음',
      'ADPICK_API_KEY 환경변수 없음', 'Invalid API key', '쿠팡 접근 차단: Access Denied']) {
      assert.equal(failureReason({ error }), 'AUTH_ERROR', error);
    }
    assert.equal(Failure.fromHttpStatus(401), 'AUTH_ERROR');
    assert.equal(Failure.fromHttpStatus(403, 'denied'), 'AUTH_ERROR');
  });
  check('429, quota, budget and minute limits are RATE_LIMIT (403 naming a rate limit too)', () => {
    for (const error of ['쿠팡 API 429: Too Many Requests', 'ADPICK API 403: rate limit exceeded', '전역 제한: collector 분당 budget 5/5',
      '실행당 호출 예산 700회 소진', '하루 호출 예산 3400회 소진', '호출 생략: 분당 상한/대기 초과', '시간당 검색 한도 10/10']) {
      assert.equal(failureReason({ error }), 'RATE_LIMIT', error);
    }
  });
  check('abort/timeout is TIMEOUT; DNS/reset/fetch failure is NETWORK_ERROR', () => {
    assert.equal(failureReason({ error: '쿠팡 네트워크 응답 시간 초과 (15000ms)' }), 'TIMEOUT');
    assert.equal(failureReason({ error: 'AbortError: The operation was aborted' }), 'TIMEOUT');
    assert.equal(failureReason({ error: 'ADPICK API 504: gateway timeout' }), 'TIMEOUT');
    for (const error of ['쿠팡 네트워크 오류: fetch failed', 'ECONNRESET', 'getaddrinfo ENOTFOUND api', 'socket hang up']) {
      assert.equal(failureReason({ error }), 'NETWORK_ERROR', error);
    }
  });
  check('a normal empty answer is NO_RESULT; a non-empty answer is not a failure', () => {
    assert.equal(failureReason({ items: [], error: null }), 'NO_RESULT');
    assert.equal(failureReason({ items: [cp], error: null }), null);
  });
  check('5xx/parse failures are SOURCE_ERROR; bad parameters are INVALID_PRODUCT; unknown is UNKNOWN', () => {
    assert.equal(failureReason({ error: '쿠팡 API 500: temporarily unavailable' }), 'SOURCE_ERROR');
    assert.equal(failureReason({ error: '쿠팡 응답 파싱 실패' }), 'SOURCE_ERROR');
    for (const error of ['키워드 없음', '쿠팡 rCode=400: invalid parameter', 'ADPICK API 400: invalid request']) {
      assert.equal(failureReason({ error }), 'INVALID_PRODUCT', error);
    }
    assert.equal(failureReason({ error: 'something unexpected' }), 'UNKNOWN');
  });
  check('product-level match reasons map onto the same vocabulary', () => {
    assert.equal(Failure.classify('OPTION_MISMATCH'), 'OPTION_MISMATCH');
    assert.equal(Failure.classify('RESPONSE_VID_MISSING'), 'OPTION_MISMATCH');
    assert.equal(Failure.classify('NO_PRODUCT_MATCH'), 'NO_MATCH');
    assert.equal(Failure.classify('NO_TARGET_ID'), 'INVALID_PRODUCT');
    assert.equal(Failure.classify('NO_PRICE'), 'INVALID_PRODUCT');
  });
  check('typed failure metadata wins over the message; unsupported values become UNKNOWN', () => {
    for (const reason of Failure.REASONS) {
      assert.equal(failureReason({ error: 'unstructured provider message', failureReason: reason }), reason);
    }
    assert.equal(failureReason({ error: 'HTTP 403', failureReason: 'AUTH_ERROR' }), 'AUTH_ERROR');
    assert.equal(failureReason({ error: 'x', failureReason: 'SECRET_UNKNOWN_VALUE' }), 'UNKNOWN');
  });
  check('retry policy lists: AUTH/INVALID/NO_RESULT are never retried; transport/provider errors are', () => {
    for (const r of ['AUTH_ERROR', 'INVALID_PRODUCT', 'NO_RESULT', 'NO_MATCH', 'OPTION_MISMATCH']) assert(!Failure.isRetryable(r), r);
    for (const r of ['RATE_LIMIT', 'NETWORK_ERROR', 'TIMEOUT', 'SOURCE_ERROR', 'UNKNOWN']) assert(Failure.isRetryable(r), r);
    // Every reason has exactly one documented retry policy.
    assert.deepEqual(Object.keys(Failure.RETRY_POLICY).sort(), [...Failure.REASONS].sort());
  });

  // ── daily ledger (JS side) ─────────────────────────────────────────
  let now = Date.parse('2026-10-02T16:00:00Z');
  const db = fakeDb(() => now);
  const runner = createQueryLedger({ db, clock: () => now });
  let calls = 0;
  const api = source => async begin => {
    if (!await begin()) return { items: [], from: 'none', error: 'fenced', failureReason: 'SOURCE_ERROR' };
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    const item = source === 'coupang' ? cp : ad;
    return { items: [item], allItems: [item, { ...item, vendorItemId: '3' }], from: 'api', error: null };
  };
  const first = await runner.run('coupang', ' MODEL A ', { limit: 1 }, api('coupang'));
  const second = await runner.run('coupang', 'model  a', { limit: 1 }, api('coupang'));
  check('same source + normalized query + KST day → one external request', () => {
    assert.equal(calls, 1); assert.equal(first.apiCalled, true); assert.equal(second.apiCalled, false);
    assert.equal(second.from, 'cache'); assert.equal(second.items[0].productId, '11');
    assert.equal(second.allItems.length, 2); assert.equal(second.allItems[1].vendorItemId, '3');
  });
  await runner.run('adpick', 'model a', {}, api('adpick'));
  check('different source → its own request', () => assert.equal(calls, 2));
  now = Date.parse('2026-10-03T15:00:00Z');
  await runner.run('coupang', 'model a', {}, api('coupang'));
  check('next KST date → may search again', () => assert.equal(calls, 3));
  const beforeRace = calls;
  const race = await Promise.all([runner.run('coupang', 'race', {}, api('coupang')), runner.run('coupang', 'RACE', {}, api('coupang'))]);
  check('same process, same query at once → one request; the follower shares the response', () => {
    assert.equal(calls - beforeRace, 1); assert.equal(race.filter(r => r.apiCalled).length, 1);
    const follower = race.find(r => !r.apiCalled);
    assert.equal(follower.queryState, 'cached'); assert.equal(follower.items[0].productId, '11');
  });
  const beforeCross = calls;
  const otherProcess = createQueryLedger({ db, clock: () => now });
  const cross = await Promise.all([runner.run('coupang', 'cross race', {}, api('coupang')),
    otherProcess.run('coupang', ' CROSS  RACE ', {}, api('coupang'))]);
  check('separate processes, same query at once → one request; the loser is in flight, not failed', () => {
    assert.equal(calls - beforeCross, 1); assert.equal(cross.filter(r => r.apiCalled).length, 1);
    const loser = cross.find(r => !r.apiCalled);
    assert.equal(loser.queryState, 'inflight'); assert.equal(loser.failureReason, null);
  });
  let sharedFailures = 0;
  const flaky = async begin => { assert(await begin()); sharedFailures++;
    return { items: [], from: 'none', error: '쿠팡 네트워크 오류: fetch failed', failureReason: 'NETWORK_ERROR' }; };
  const sharedFail = await Promise.all([runner.run('coupang', 'shared failure', {}, flaky), runner.run('coupang', 'shared failure', {}, flaky)]);
  check('a follower of a failed request is not counted as another request', () => {
    assert.equal(sharedFailures, 1); assert.equal(sharedFail.filter(r => r.apiCalled).length, 1);
    assert.equal(sharedFail.find(r => !r.apiCalled).failureReason, 'NETWORK_ERROR');
  });
  const regular = await runner.run('coupang', 'resume', { source: 'collect' }, api('coupang'));
  const catchup = await createQueryLedger({ db, clock: () => now }).run('coupang', 'resume', { source: 'cron' }, api('coupang'));
  check('separate process shares the regular run completion', () => {
    assert.equal(regular.apiCalled, true); assert.equal(catchup.apiCalled, false); assert.equal(catchup.items.length, 1);
  });

  // Per category: how many actual requests may the same query make in one KST day?
  const caps = { NETWORK_ERROR: 2, TIMEOUT: 2, RATE_LIMIT: 2, SOURCE_ERROR: 2, UNKNOWN: 2,
    AUTH_ERROR: 1, INVALID_PRODUCT: 1 };
  for (const [reason, cap] of Object.entries(caps)) {
    let requests = 0;
    const failing = async begin => {
      if (!await begin()) return { items: [], from: 'none', error: 'fenced' };
      requests++;
      return { items: [], from: 'none', error: reason, failureReason: reason };
    };
    const q = `cap ${reason.toLowerCase()}`;
    await runner.run('coupang', q, {}, failing);
    await runner.run('coupang', q, {}, failing);
    const immediate = requests;
    for (let i = 0; i < 5; i++) { now += RETRY_MS + 1; await runner.run('coupang', q, {}, failing); }
    check(`${reason}: no immediate repeat; at most ${cap} request(s) per query/day`, () => {
      assert.equal(immediate, 1); assert.equal(requests, cap);
    });
  }
  let empties = 0;
  const empty = async begin => { assert(await begin()); empties++; return { items: [], from: 'api', error: null }; };
  const emptyFirst = await runner.run('coupang', 'empty success', {}, empty);
  for (let i = 0; i < 3; i++) { now += RETRY_MS + 1; await runner.run('coupang', 'empty success', {}, empty); }
  const emptyAgain = await runner.run('coupang', 'empty success', {}, empty);
  check('NO_RESULT: a normal empty answer is reused, never requested again today', () => {
    assert.equal(empties, 1); assert.equal(emptyFirst.failureReason, 'NO_RESULT'); assert.equal(emptyAgain.failureReason, 'NO_RESULT');
    assert.equal(emptyAgain.apiCalled, false);
  });
  const deferred = await runner.run('adpick', 'limited', {}, async () => ({ items: [], error: 'rate limit', failureReason: 'RATE_LIMIT', from: 'none' }));
  const limitedAgain = await runner.run('adpick', 'limited', {}, api('adpick'));
  check('RATE_LIMIT before any request consumes no request budget and defers', () => {
    assert.equal(deferred.apiCalled, false); assert.equal(limitedAgain.apiCalled, false);
    const row = db.rows.get(`adpick:${kstDateKey(now)}:${queryHash('limited')}`); assert.equal(row.request_count, 0);
  });
  const corrupted = db.rows.get(`coupang:${kstDateKey(now)}:${queryHash('race')}`);
  corrupted.result.allItems[0].lprice = -1;
  const corruptSkip = await runner.run('coupang', 'race', {}, api('coupang'));
  check('corrupt cached results are never reused; repair is deferred', () => {
    assert.equal(corruptSkip.queryState, 'corrupt'); assert.equal(corruptSkip.apiCalled, false); assert.equal(corruptSkip.items.length, 0);
  });
  now += RETRY_MS + 1;
  const repaired = await runner.run('coupang', 'race', {}, api('coupang'));
  check('corrupt cache permits one bounded repair request after backoff', () => assert.equal(repaired.apiCalled, true));
  check('previous-KST-day, future and malformed payloads are rejected', () => {
    const p = { version: 1, source: 'coupang', items: [cp], allItems: [cp], fetchedAt: '2026-10-01T16:00:00Z' };
    assert.equal(validPayload('coupang', p, now), false);
    assert.equal(validPayload('coupang', { ...p, fetchedAt: new Date(now + 60000).toISOString() }, now), false);
    assert.equal(validPayload('coupang', { ...p, items: 'malformed', fetchedAt: new Date(now).toISOString() }, now), false);
    assert.equal(validPayload('coupang', { ...p, allItems: 'malformed', fetchedAt: new Date(now).toISOString() }, now), false);
  });
  const staleRow = db.rows.get(`coupang:${kstDateKey(now)}:${queryHash('resume')}`);
  staleRow.expires = now - 1;
  const staleBefore = calls;
  const expired = await runner.run('coupang', 'resume', {}, api('coupang'));
  check('an expired query cache is never stamped as a current price', () => {
    assert.equal(calls, staleBefore); assert.equal(expired.items.length, 0); assert.equal(expired.queryState, 'daily_done');
  });
  db.rows.set(`coupang:${kstDateKey(now)}:${queryHash('uncertain crash')}`, { kst_date: kstDateKey(now), status: 'running',
    claim_token: 'old-worker', request_count: 1, started: true, lease: now - 1 });
  const crashBefore = calls;
  const uncertain = await runner.run('coupang', 'uncertain crash', {}, api('coupang'));
  check('a lease that expired after the request began never duplicates that uncertain request', () => {
    assert.equal(calls, crashBefore); assert.equal(uncertain.queryState, 'inflight');
  });
  db.rows.set(`coupang:${kstDateKey(now)}:${queryHash('pre-request crash')}`, { kst_date: kstDateKey(now), status: 'running',
    claim_token: 'old-worker', request_count: 0, started: false, lease: now - 1 });
  const safe = await runner.run('coupang', 'pre-request crash', {}, api('coupang'));
  check('an expired claim that never began is safely reclaimed', () => assert.equal(safe.apiCalled, true));
  db.fail = true;
  const unavailable = await runner.run('adpick', 'db down', {}, api('adpick'));
  check('enabled but unavailable ledger fails closed without leaking DB details', () => {
    assert.equal(unavailable.apiCalled, false); assert.equal(unavailable.queryState, 'unavailable');
    assert(!JSON.stringify(unavailable).includes('do-not-print-secret'));
  });
  check('cached payload keeps identity/options and drops raw provider/debug fields', () => {
    const p = payloadFor('coupang', { items: [{ ...cp, rawDebug: 'do-not-store', unknownCredential: 'do-not-store' }] }, now);
    assert.equal(p.items[0].vendorItemId, '2'); assert.equal(p.items[0].link, cp.link);
    assert(!JSON.stringify(p).includes('do-not-store'));
  });
  let expiryArgs;
  const cleared = await expireQueryResults({ db: { async rpc(name, args) {
    assert.equal(name, 'collector_query_expire_results'); expiryArgs = args; return { data: 10 };
  } }, batchSize: 50000 });
  check('explicit cache expiry is bounded to 1000 rows per call', () => {
    assert.equal(cleared, 10); assert.equal(expiryArgs.p_batch_size, 1000);
  });
  await providerIntegration();
  console.log(`\n${passed} PASS, 0 FAIL (offline; no provider/Production calls)`);
}

/** Load the real provider modules against an injected DB (fresh circuit/limiter state each time). */
function loadProviders(db) {
  const sb = require.resolve('../api/_supabase');
  require.cache[sb] = { id: sb, filename: sb, loaded: true, exports: db };
  for (const m of ['../api/_coupang', '../api/_adpick', '../api/_collector-query']) delete require.cache[require.resolve(m)];
  return { ...require('../api/_coupang'), ...require('../api/_adpick') };
}

async function providerIntegration() {
  Object.assign(process.env, { PRICE_QUERY_LEDGER: '1', COUPANG_API_HOST: 'http://localhost', ADPICK_API_HOST: 'http://localhost',
    COUPANG_DISABLE_GLOBAL_GATE: '1', ADPICK_GLOBAL_LIMIT: '0', COUPANG_ACCESS_KEY: 'offline-key', COUPANG_SECRET_KEY: 'offline-key',
    ADPICK_API_KEY: 'offline-key', COUPANG_MIN_GAP_MS: '1', ADPICK_MIN_GAP_MS: '1', ADPICK_MAX_PER_MIN: '100' });
  const originalFetch = global.fetch;
  const opts = { source: 'collect', limit: 1, minGapMs: 0, maxWaitMs: 1000, useCache: false, forceRefresh: true };
  try {
    let db = fakeDb(Date.now);
    let { searchCoupang, searchAdpick } = loadProviders(db);
    let requests = 0;
    const requestedLimits = { coupang: [], adpick: [] };
    global.fetch = async url => {
      assert(String(url).startsWith('http://localhost/'), 'real external calls forbidden'); requests++;
      const provider = String(url).includes('/search?q=') ? 'adpick' : 'coupang';
      requestedLimits[provider].push(Number(new URL(url).searchParams.get('limit')));
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(provider === 'adpick'
        ? { success: true, data: [{ title: 'A', price: '10000', commissionlink: 'https://shop.example/a' }] }
        : { rCode: '0', data: { productData: [
          { productId: 11, productName: 'A', productPrice: 10000, productUrl: cp.link },
          { productId: 12, productName: 'B', productPrice: 12000, productUrl: 'https://link.coupang.com/b?itemId=4&vendorItemId=5' }
        ] } }) };
    };
    const a = await searchCoupang(' Integration Query ', opts);
    const b = await searchCoupang('integration  query', { ...opts, source: 'cron' });
    check('real Coupang provider: forceRefresh cannot bypass the daily dedupe', () => {
      assert.equal(requests, 1); assert.equal(a.apiCalled, true); assert.equal(b.apiCalled, false);
      assert.equal(b.items.length, 1); assert.equal(b.allItems.length, 2);
    });
    const c = await searchAdpick('Integration Query', opts);
    const d = await searchAdpick(' integration query ', opts);
    check('real ADPICK provider: daily dedupe, separate from Coupang', () => {
      assert.equal(requests, 2); assert.equal(c.apiCalled, true); assert.equal(d.apiCalled, false);
    });
    const beforeConcurrent = requests;
    const concurrent = await Promise.all([searchCoupang('provider race', opts), searchCoupang(' PROVIDER  RACE ', { ...opts, source: 'cron' })]);
    check('real provider: simultaneous collectors issue one external request', () => {
      assert.equal(requests - beforeConcurrent, 1); assert.equal(concurrent.filter(r => r.apiCalled).length, 1);
    });
    db.denyBegin = true;
    const fenced = await searchCoupang('invalid claim token', opts);
    const adFenced = await searchAdpick('invalid claim token', opts);
    check('both real providers need the atomic begin immediately before fetch', () => {
      assert.equal(requests, 3); assert.equal(fenced.apiCalled, false); assert.equal(adFenced.apiCalled, false);
    });
    db.denyBegin = false;
    db.legacy.set('coupang_search_cache:legacy cache', { items: [cp], req_limit: 10, fetched_at: new Date().toISOString() });
    const legacy = await searchCoupang('legacy cache', { ...opts, useCache: true, forceRefresh: false });
    const adopted = await searchCoupang(' LEGACY CACHE ', opts);
    check('same-day provider cache is adopted with its original fetched timestamp', () => {
      assert.equal(requests, 3); assert.equal(legacy.apiCalled, false); assert.equal(adopted.apiCalled, false);
      assert.equal(adopted.resultFetchedAt, db.legacy.get('coupang_search_cache:legacy cache').fetched_at);
    });
    db.fail = true;
    await searchCoupang('ledger unavailable', opts); await searchAdpick('ledger unavailable', opts);
    check('both provider wrappers fail closed when the ledger is unavailable', () => assert.equal(requests, 3));
    check('interactive search keeps its existing refresh policy', () => {
      assert.equal(ledgerEnabled({ source: 'search', forceRefresh: true }), false);
      assert.equal(ledgerEnabled({ source: 'diag' }), false);
      assert.equal(ledgerEnabled({ source: 'collect' }), true);
    });
    check('fan-out keeps the existing provider request limits', () => {
      assert(requestedLimits.coupang.every(limit => limit === 10));
      assert(requestedLimits.adpick.every(limit => limit === 20));
    });

    // Real HTTP outcomes → typed failure, actual-request flag, ledger state and retry behavior.
    const scenarios = [
      ['HTTP 401', () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => 'Unauthorized' }), 'AUTH_ERROR', 'failed', 1],
      ['HTTP 403', () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => 'Access denied' }), 'AUTH_ERROR', 'failed', 1],
      ['HTTP 429', () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'Too Many Requests' }), 'RATE_LIMIT', 'failed', 1],
      ['HTTP 500', () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'oops' }), 'SOURCE_ERROR', 'failed', 1],
      ['abort', () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); }, 'TIMEOUT', 'failed', 1],
      ['connection reset', () => { throw new TypeError('fetch failed'); }, 'NETWORK_ERROR', 'failed', 1],
      ['empty answer', () => ({ ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ rCode: '0', data: { productData: [] } }) }), 'NO_RESULT', 'completed', 1]
    ];
    for (const [name, respond, want, status, wantRequests] of scenarios) {
      db = fakeDb(Date.now);
      ({ searchCoupang } = loadProviders(db));
      let n = 0;
      global.fetch = async () => { n++; return respond(); };
      const r = await searchCoupang(`scenario ${name}`, opts);
      const again = await searchCoupang(`scenario ${name}`, opts);
      const row = db.rows.get(`coupang:${kstDateKey(Date.now())}:${queryHash(`scenario ${name}`)}`);
      check(`Coupang ${name} → ${want}; request counted as an attempt; not repeated immediately`, () => {
        assert.equal(r.failureReason, want); assert.equal(r.apiCalled, true);
        assert.equal(row.status, status); assert.equal(row.failure_reason, want === 'NO_RESULT' ? 'NO_RESULT' : want);
        assert.equal(n, wantRequests); assert.equal(again.apiCalled, false);
        if (want === 'AUTH_ERROR') assert.notEqual(r.failureReason, 'NETWORK_ERROR');
      });
    }
    db = fakeDb(Date.now);
    ({ searchAdpick } = loadProviders(db));
    global.fetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => 'bad key' });
    const adAuth = await searchAdpick('scenario adpick auth', opts);
    check('ADPICK HTTP 401 → AUTH_ERROR with the request counted', () => {
      assert.equal(adAuth.failureReason, 'AUTH_ERROR'); assert.equal(adAuth.apiCalled, true);
    });
  } finally { global.fetch = originalFetch; }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
