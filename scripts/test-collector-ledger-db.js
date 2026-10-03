#!/usr/bin/env node
'use strict';

// Runs the checked-in migration against an ephemeral PostgreSQL WASM database.
// No connection string, network provider, catalog credential or production DB is used.
// PGlite has one connection: concurrent promises exercise the real serialized SQL
// transitions, but cannot prove PostgreSQL multi-backend lock/deadlock behavior.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  ({ PGlite } = require('../.tmp/db-test/node_modules/@electric-sql/pglite'));
}
const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20261003003832_collector_daily_efficiency.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const hash = q => crypto.createHash('sha256').update(q, 'utf8').digest('hex');
const Failure = require('../api/_collector-failure');
const { normalizeQuery } = require('../api/_collector-query');
// The SQL text repeats the JS vocabulary/retry lists; parse the quoted lists from the migration.
const sqlList = re => { const m = re.exec(migration); if (!m) throw new Error(`list not found: ${re}`); return m[1].match(/'([A-Z_]+)'/g).map(s => s.slice(1, -1)); };
const token = () => crypto.randomUUID();
let pass = 0, fail = 0;

async function test(name, fn) {
  try { await fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.error(`[FAIL] ${name}: ${e.message}`); }
}

async function main() {
  const db = new PGlite();
  await db.waitReady;
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const value = async (sql, params = []) => Object.values(await one(sql, params))[0];
  const rejects = async (sql, params = []) => assert.rejects(() => db.query(sql, params));
  const claim = (source, q, t = token(), digest = hash(q)) => value(
    'select public.collector_query_claim($1,$2,$3,$4::uuid) as result', [source, q, digest, t]);
  const begin = (source, date, q, t) => value(
    'select public.collector_query_begin($1,$2::date,$3,$4::uuid) as result', [source, date, hash(q), t]);
  const finish = (source, date, q, t, status, reason = null, result = null, next = null, count = 0) => value(
    'select public.collector_query_finish($1,$2::date,$3,$4::uuid,$5,$6,$7::jsonb,$8::timestamptz,$9) as result',
    [source, date, hash(q), t, status, reason, result == null ? null : JSON.stringify(result), next, count]);
  const invalidate = (source, date, q, t) => value(
    'select public.collector_query_invalidate($1,$2::date,$3,$4::uuid) as result', [source, date, hash(q), t]);
  const record = (source, date, events) => db.query(
    'select * from public.collector_progress_record($1,$2::date,$3::jsonb)',
    [source, date, events == null ? null : JSON.stringify(events)]);
  const progressRow = (key, source, date) => one(
    'select * from public.collector_product_progress where source=$1 and kst_date=$2::date and product_key=$3', [source, date, key]);
  const queryRow = (q, source, date) => one(
    'select * from public.collector_query_runs where source=$1 and kst_date=$2::date and query_hash=$3', [source, date, hash(q)]);
  const expire = (q, source, date, field = 'next_retry_at') => db.query(
    `update public.collector_query_runs set ${field}=clock_timestamp()-interval '1 second' where source=$1 and kst_date=$2::date and query_hash=$3`,
    [source, date, hash(q)]);
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    // Sentinels ensure this additive migration leaves existing catalog/history intact.
    await db.exec("create table public.products(id text primary key, title text); create table public.price_history(id integer primary key, product_id text, price integer); insert into public.products values('existing','existing product'); insert into public.price_history values(1,'existing',1000);");
    await db.exec(migration);
    const date = await value("select (clock_timestamp() at time zone 'Asia/Seoul')::date::text");
    const fetchedAt = await value('select clock_timestamp()::text');
    const payload = (source, items = []) => ({ version: 1, source, fetchedAt, items, allItems: items });
    const source = 'coupang';

    await test('actual migration creates only additive state tables and preserves catalog/history sentinels', async () => {
      assert.deepEqual((await db.query('select * from public.products')).rows, [{ id: 'existing', title: 'existing product' }]);
      assert.deepEqual((await db.query('select * from public.price_history')).rows, [{ id: 1, product_id: 'existing', price: 1000 }]);
      assert.equal(await value("select count(*)::int from pg_class where relname in ('collector_query_runs','collector_product_progress') and relrowsecurity"), 2);
    });
    await test('actual migration is idempotent on an existing local schema', async () => {
      await db.exec(migration);
      assert.equal(await value("select count(*)::int from pg_class where relname='collector_query_runs'"), 1);
    });
    await test('all six RPCs are security invoker with a pinned search_path', async () => {
      const rows = (await db.query("select proname,prosecdef,proconfig from pg_proc where proname in ('collector_query_claim','collector_query_begin','collector_query_finish','collector_query_invalidate','collector_query_expire_results','collector_progress_record')")).rows;
      assert.equal(rows.length, 6); assert.ok(rows.every(r => r.prosecdef === false));
      assert.ok(rows.every(r => r.proconfig.some(c => c.startsWith('search_path='))));
    });
    for (const role of ['anon', 'authenticated']) {
      await test(`${role} cannot read either state table or execute claim/progress RPC`, async () => {
        await db.exec(`set role ${role}`);
        try {
          await rejects('select * from public.collector_query_runs');
          await rejects('select * from public.collector_product_progress');
          await rejects('select public.collector_query_claim($1,$2,$3,$4::uuid)', [source, 'role denial', hash('role denial'), token()]);
          await rejects('select * from public.collector_progress_record($1,$2::date,$3::jsonb)', [source, date, '[]']);
          await rejects('select public.collector_query_expire_results(1)');
        } finally { await db.exec('reset role'); }
      });
    }
    await test('PUBLIC has no execution ACL on the six collector RPCs', async () => {
      assert.equal(await value("select count(*)::int from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.proname in ('collector_query_claim','collector_query_begin','collector_query_finish','collector_query_invalidate','collector_query_expire_results','collector_progress_record') and a.grantee=0 and a.privilege_type='EXECUTE'"), 0);
    });
    await db.exec('set role service_role');

    let winner;
    const raceQuery = 'one real query';
    await test('concurrent claim promises produce one owner and nine inflight SQL states', async () => {
      const tokens = Array.from({ length: 10 }, token);
      const claims = await Promise.all(tokens.map(t => claim(source, raceQuery, t)));
      assert.equal(claims.filter(c => c.action === 'claimed').length, 1);
      assert.equal(claims.filter(c => c.action === 'inflight').length, 9);
      winner = claims.find(c => c.action === 'claimed').claim_token;
      assert.equal(claims[0].kst_date, date);
    });
    await test('same owner claim replay is idempotent and consumes no request budget', async () => {
      const c = await claim(source, raceQuery, winner); assert.equal(c.action, 'claimed'); assert.equal(c.request_count, 0);
    });
    await test('wrong token and wrong KST day cannot begin an outgoing request', async () => {
      assert.equal(await begin(source, date, raceQuery, token()), false);
      assert.equal(await begin(source, '1999-01-01', raceQuery, winner), false);
    });
    await test('concurrent begin promises permit exactly one actual request', async () => {
      const starts = await Promise.all(Array.from({ length: 10 }, () => begin(source, date, raceQuery, winner)));
      assert.equal(starts.filter(Boolean).length, 1); assert.equal((await queryRow(raceQuery, source, date)).request_count, 1);
      assert.equal((await queryRow(raceQuery, source, date)).confirmed_request_count, 0);
    });
    await test('a caller cannot pair a query with another query identity (SQL recomputes SHA-256)', async () => {
      await assert.rejects(() => claim(source, 'different normalized query', token(), hash(raceQuery)), /hash mismatch/);
    });
    await test('SQL rejects non-canonical identities (case, spacing, NFKC, control characters)', async () => {
      for (const raw of ['Model A', 'model  a', ' model a', 'model a ', 'ｍodel a', 'model\ta', 'model\u0085a', '삼성'.normalize('NFD')]) {
        await assert.rejects(() => claim(source, raw, token(), hash(raw)), /not canonical/, JSON.stringify(raw));
      }
    });
    await test('every JS-normalized identity is accepted by the SQL guard (JS and SQL agree)', async () => {
      const pool = [...'AaZz09 +-/()[]_.,\u00a0\u3000\t\n\u0085\u200b\ufeff\u00ad\uff21\uff5a\uff10\ufb03\u2460\u2122\u338e\u0130\u03a3\u03c2삼성갤럭시버즈\u1100\u1161\u11a8\u0307'];
      let seed = 11; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
      let accepted = 0;
      for (let i = 0; i < 400; i++) {
        let s = 'q'; for (let j = rnd(10); j > 0; j--) s += pool[rnd(pool.length)];
        const n = normalizeQuery(s);
        const c = await claim('adpick', n, token(), hash(n));
        assert.ok(['claimed', 'inflight'].includes(c.action), JSON.stringify(s)); accepted++;
      }
      assert.equal(accepted, 400);
    });
    await test('SQL failure vocabulary and retry/terminal lists match api/_collector-failure.js', async () => {
      const sorted = a => [...a].sort();
      assert.deepEqual(sorted(sqlList(/collector_query_runs[\s\S]*?failure_reason text check \(failure_reason in \(([^)]*)\)/)), sorted(Failure.REASONS));
      assert.deepEqual(sorted(sqlList(/collector_product_progress \([\s\S]*?failure_reason text CHECK \(failure_reason IN \(([^)]*)\)/)), sorted(Failure.REASONS));
      assert.deepEqual(sorted(sqlList(/coalesce\(v_row\.failure_reason,'UNKNOWN'\)\s+not in \(([^)]*)\)/)), sorted(Failure.QUERY_RETRYABLE));
      assert.deepEqual(sorted(sqlList(/transient_failures = old\.transient_failures[\s\S]*?reason IN \(([^)]*)\)/)), sorted(Failure.TRANSIENT));
      assert.deepEqual(sorted(sqlList(/WHEN old\.failure_reason IN \(([^)]*)\) THEN old\.failure_reason/)), sorted(Failure.PRODUCT_TERMINAL));
      assert.deepEqual(sorted(sqlList(/mismatch_at = coalesce\(old\.mismatch_at[\s\S]*?reason IN \(([^)]*)\)/)), sorted(Failure.ALTERNATE_LIMITED));
    });
    await test('primary keys, indexes and check constraints exist as declared', async () => {
      const idx = (await db.query("select indexname from pg_indexes where tablename in ('collector_query_runs','collector_product_progress')")).rows.map(r => r.indexname).sort();
      assert.deepEqual(idx, ['collector_product_progress_pkey', 'collector_query_runs_date_status_idx', 'collector_query_runs_pkey', 'collector_query_runs_result_expiry_idx']);
      const checks = await value("select count(*)::int from pg_constraint where conrelid in ('public.collector_query_runs'::regclass,'public.collector_product_progress'::regclass) and contype='c'");
      assert.ok(checks >= 12, String(checks));
      await rejects("insert into public.collector_query_runs(source,kst_date,normalized_query,query_hash,status,claim_token,lease_until,failure_reason) values('coupang','1999-01-02','x',$1,'failed',$2::uuid,now(),'NOT_A_REASON')", [hash('x'), token()]);
    });
    await test('provider/date/hash primary key rejects duplicate ledger rows', async () => {
      await rejects("insert into public.collector_query_runs(source,kst_date,normalized_query,query_hash,status,claim_token,lease_until) values($1,$2::date,$3,$4,'running',$5::uuid,clock_timestamp())",
        [source, date, raceQuery, hash(raceQuery), token()]);
      assert.equal(await value('select count(*)::int from public.collector_query_runs where source=$1 and kst_date=$2::date and query_hash=$3', [source, date, hash(raceQuery)]), 1);
    });
    await test('different providers claim the same query independently', async () => {
      assert.equal((await claim('adpick', raceQuery)).action, 'claimed');
    });
    await test('wrong token cannot finish the active owner result', async () => {
      assert.equal(await finish(source, date, raceQuery, token(), 'completed', null, payload(source)), false);
      assert.equal((await queryRow(raceQuery, source, date)).status, 'running');
    });
    await test('valid same-day completed result is cached and never starts a second search', async () => {
      assert.equal(await finish(source, date, raceQuery, winner, 'completed', null, payload(source), null, 0), true);
      const cached = await claim(source, raceQuery); assert.equal(cached.action, 'cached'); assert.equal(cached.request_count, 1);
      assert.deepEqual(cached.result.items, []); assert.equal(await begin(source, date, raceQuery, winner), false);
      assert.equal((await queryRow(raceQuery, source, date)).confirmed_request_count, 1);
    });
    await test('replayed finish cannot increment the confirmed actual request counter twice', async () => {
      assert.equal(await finish(source, date, raceQuery, winner, 'completed', null, payload(source)), false);
      assert.equal((await queryRow(raceQuery, source, date)).confirmed_request_count, 1);
    });
    await test('same-day cache adoption consumes zero request intents and confirmed calls', async () => {
      const q = 'adopt existing cache', c = await claim(source, q);
      assert.equal(await finish(source, date, q, c.claim_token, 'completed', null, payload(source)), true);
      const r = await queryRow(q, source, date);
      assert.equal(r.request_count, 0); assert.equal(r.confirmed_request_count, 0);
      assert.equal((await claim(source, q)).action, 'cached');
    });
    await test('cache expiry stops reuse but preserves the completed daily dedupe guard', async () => {
      await expire(raceQuery, source, date, 'expires_at');
      assert.equal((await claim(source, raceQuery)).action, 'daily_done');
    });
    await test('local old-day record allows a fresh claim on the next KST date', async () => {
      const q = 'fresh daily query', old = token();
      await db.query("insert into public.collector_query_runs(source,kst_date,normalized_query,query_hash,status,claim_token,lease_until,request_count) values($1,'1999-01-01',$2,$3,'completed',$4::uuid,clock_timestamp(),1)", [source, q, hash(q), old]);
      const c = await claim(source, q); assert.equal(c.action, 'claimed'); assert.equal(c.request_count, 0); assert.equal(c.kst_date, date);
    });

    await test('expired claim without a begun request can be reclaimed; stale owner is fenced', async () => {
      const q = 'unstarted worker crash', old = token(); await claim(source, q, old);
      await expire(q, source, date, 'lease_until');
      const c = await claim(source, q); assert.equal(c.action, 'claimed'); assert.notEqual(c.claim_token, old);
      assert.equal(await begin(source, date, q, old), false);
      assert.equal(await finish(source, date, q, old, 'failed', 'NETWORK_ERROR'), false);
      assert.equal(await begin(source, date, q, c.claim_token), true);
    });
    await test('expired begun worker crash never reissues an uncertain request on the same day', async () => {
      const q = 'begun worker crash', t = token(); await claim(source, q, t); await begin(source, date, q, t);
      await expire(q, source, date, 'lease_until');
      assert.equal((await claim(source, q)).action, 'inflight'); assert.equal((await queryRow(q, source, date)).request_count, 1);
    });
    await test('NETWORK_ERROR waits at least two minutes before its single repair retry', async () => {
      const q = 'retry network', c = await claim(source, q); await begin(source, date, q, c.claim_token);
      const started = Date.now();
      await finish(source, date, q, c.claim_token, 'failed', 'NETWORK_ERROR', null, new Date(0).toISOString());
      const deferred = await claim(source, q); assert.equal(deferred.action, 'deferred');
      assert.ok(Date.parse(deferred.next_retry_at) >= started + 119000);
      await expire(q, source, date);
      const next = await claim(source, q); assert.equal(next.action, 'claimed');
      assert.equal(await begin(source, date, q, next.claim_token), true);
      await finish(source, date, q, next.claim_token, 'failed', 'NETWORK_ERROR');
      assert.equal((await claim(source, q)).action, 'daily_done'); assert.equal((await queryRow(q, source, date)).request_count, 2);
    });
    await test('RATE_LIMIT before the request consumes zero calls and resumes after budget deferral', async () => {
      const q = 'rate gate defer', c = await claim(source, q);
      await finish(source, date, q, c.claim_token, 'deferred', 'RATE_LIMIT', null, new Date(0).toISOString());
      assert.equal((await queryRow(q, source, date)).request_count, 0); assert.equal((await claim(source, q)).action, 'deferred');
      await expire(q, source, date); const next = await claim(source, q);
      assert.equal(next.action, 'claimed'); assert.equal(await begin(source, date, q, next.claim_token), true);
      assert.equal((await queryRow(q, source, date)).request_count, 1);
    });
    for (const reason of ['AUTH_ERROR', 'NO_RESULT', 'OPTION_MISMATCH', 'AMBIGUOUS_MATCH', 'INVALID_PRODUCT']) {
      await test(`${reason} failed search is never reissued today, even after backoff`, async () => {
        const q = `terminal ${reason.toLowerCase()}`, c = await claim(source, q); await begin(source, date, q, c.claim_token);
        await finish(source, date, q, c.claim_token, 'failed', reason);
        assert.equal((await claim(source, q)).action, 'daily_done');
        await expire(q, source, date);
        assert.equal((await claim(source, q)).action, 'daily_done');
      });
    }
    const badPayloads = [
      ['missing fetchedAt', p => { delete p.fetchedAt; return p; }],
      ['null fetchedAt', p => ({ ...p, fetchedAt: null })],
      ['missing items', p => { delete p.items; return p; }],
      ['null allItems', p => ({ ...p, allItems: null })],
      ['wrong source', p => ({ ...p, source: 'adpick' })],
      ['wrong KST date', p => ({ ...p, fetchedAt: '1999-01-01T00:00:00Z' })],
      ['wrong payload version', p => ({ ...p, version: 2 })],
      ['string payload version', p => ({ ...p, version: '1' })],
      ['more than twenty candidates', p => ({ ...p, allItems: Array.from({ length: 21 }, () => ({})) })]
    ];
    for (const [name, change] of badPayloads) {
      await test(`actual SQL rejects cached payload with ${name}`, async () => {
        const q = `bad payload ${name.toLowerCase()}`, c = await claim(source, q); await begin(source, date, q, c.claim_token);
        await assert.rejects(() => finish(source, date, q, c.claim_token, 'completed', null, change(payload(source))));
        assert.equal((await queryRow(q, source, date)).status, 'running');
      });
    }
    await test('completed status requires a stored result', async () => {
      const q = 'completed missing payload', c = await claim(source, q);
      await assert.rejects(() => finish(source, date, q, c.claim_token, 'completed'), /requires result/);
    });
    await test('payload over 160KB is rejected before it is stored', async () => {
      const q = 'large payload', c = await claim(source, q);
      await assert.rejects(() => finish(source, date, q, c.claim_token, 'completed', null,
        payload(source, [{ title: 'x'.repeat(160001) }])));
    });
    await test('stale invalidator cannot discard the current cache token', async () => {
      const q = 'cache repair', c = await claim(source, q); await begin(source, date, q, c.claim_token);
      await finish(source, date, q, c.claim_token, 'completed', null, payload(source));
      await invalidate(source, date, q, token()); assert.equal((await claim(source, q)).action, 'cached');
      await invalidate(source, date, q, c.claim_token); assert.equal((await claim(source, q)).action, 'deferred');
      await expire(q, source, date); const next = await claim(source, q);
      assert.equal(next.action, 'claimed'); assert.equal(await begin(source, date, q, next.claim_token), true);
      await finish(source, date, q, next.claim_token, 'completed', null, payload(source));
      await invalidate(source, date, q, c.claim_token); assert.equal((await claim(source, q)).action, 'cached');
      assert.equal((await queryRow(q, source, date)).request_count, 2);
      assert.equal((await queryRow(q, source, date)).confirmed_request_count, 2);
    });
    await test('expired result cleanup is bounded and preserves paid counters and today payloads', async () => {
      for (const q of ['old payload one', 'old payload two']) {
        await db.query("insert into public.collector_query_runs(source,kst_date,normalized_query,query_hash,status,claim_token,lease_until,request_count,confirmed_request_count,result,expires_at) values($1,'1999-01-01',$2,$3,'completed',$4::uuid,clock_timestamp(),1,1,$5::jsonb,clock_timestamp()-interval '1 day')", [source, q, hash(q), token(), JSON.stringify(payload(source))]);
      }
      assert.equal(await value('select public.collector_query_expire_results(1)'), 1);
      assert.equal(await value("select count(*)::int from public.collector_query_runs where normalized_query like 'old payload %' and result is not null"), 1);
      assert.equal(await value("select sum(confirmed_request_count)::int from public.collector_query_runs where normalized_query like 'old payload %'"), 2);
      assert.equal((await claim(source, 'adopt existing cache')).action, 'cached');
      assert.equal(await value('select public.collector_query_expire_results(1000)'), 1);
      assert.equal(await value('select public.collector_query_expire_results(1000)'), 0);
    });

    const event = (key, extra = {}) => ({ product_key: key, event_id: token(), query: 'model query',
      status: 'evaluated', attempted: true, evaluated: true, success: false, failure_reason: 'NO_RESULT', ...extra });
    await test('progress: a failed request adds a transient failure but no evaluated query', async () => {
      const key = 'transient product';
      await record(source, date, [event(key, { evaluated: false, failure_reason: 'TIMEOUT', status: 'failed' })]);
      await record(source, date, [event(key, { evaluated: false, failure_reason: 'NETWORK_ERROR', status: 'failed' })]);
      const r = await progressRow(key, source, date);
      assert.equal(r.attempt_count, 2); assert.equal(r.transient_failures, 2); assert.deepEqual(r.queries, []);
    });
    await test('progress: mismatch_at marks the evaluated-query count at the first option miss', async () => {
      const key = 'mismatch product';
      await record(source, date, [event(key, { query: 'first', failure_reason: 'NO_MATCH' })]);
      await record(source, date, [event(key, { query: 'second', failure_reason: 'OPTION_MISMATCH' })]);
      await record(source, date, [event(key, { query: 'third', failure_reason: 'OPTION_MISMATCH' })]);
      const r = await progressRow(key, source, date);
      assert.equal(r.mismatch_at, 2); assert.deepEqual(r.queries, ['first', 'second', 'third']);
    });
    await test('progress: product-terminal reasons stick for the day; success still wins', async () => {
      const key = 'sticky product';
      await record(source, date, [event(key, { failure_reason: 'WRITE_REJECTED', status: 'write_rejected', attempted: false, evaluated: false })]);
      await record(source, date, [event(key, { failure_reason: 'RATE_LIMIT', status: 'deferred', attempted: false, evaluated: false })]);
      assert.equal((await progressRow(key, source, date)).failure_reason, 'WRITE_REJECTED');
      await record(source, date, [event(key, { success: true, status: 'success', failure_reason: null })]);
      const r = await progressRow(key, source, date);
      assert.ok(r.success_at); assert.equal(r.failure_reason, null);
    });
    await test('progress rejects a failure reason outside the shared vocabulary', async () => {
      await assert.rejects(() => record(source, date, [event('bad reason', { failure_reason: 'NETWORK' })]), /invalid collector failure reason/);
    });
    await test('progress RPC returns a stored actual attempt and deduplicates the same event ID', async () => {
      const e = event('P1|쿠팡|V1');
      const a = (await record(source, date, [e])).rows[0];
      const b = (await record(source, date, [e])).rows[0];
      assert.equal(a.attempt_count, 1); assert.equal(b.attempt_count, 1); assert.ok(b.attempted_at);
      assert.deepEqual(b.event_ids, [e.event_id]); assert.deepEqual(b.queries, ['model query']);
    });
    await test('progress success is monotonic across concurrent event promises and late failures', async () => {
      const key = 'P2|쿠팡|V1';
      const events = [event(key), event(key, { success: true, status: 'success' }), event(key, { failure_reason: 'NETWORK_ERROR', next_retry_at: fetchedAt })];
      await Promise.all(events.map(e => record(source, date, [e])));
      const r = await progressRow(key, source, date);
      assert.equal(r.attempt_count, 3); assert.ok(r.success_at); assert.equal(r.last_status, 'success');
      assert.equal(r.failure_reason, null); assert.equal(r.next_retry_at, null); assert.equal(r.event_ids.length, 3);
    });
    await test('same progress events in one batch cannot double count an attempt', async () => {
      const e = event('same batch event'); const r = (await record(source, date, [e, e])).rows;
      assert.equal(r.length, 2); assert.ok(r.every(x => x.attempt_count === 1));
    });
    await test('same-product batch keeps newest failure/query despite inverse event ID order', async () => {
      const key = 'ordered failure';
      await record(source, date, [event(key, { event_id: 'z-first', query: 'original', failure_reason: 'NO_RESULT' }),
        event(key, { event_id: 'a-second', query: 'safe alternate', status: 'failed', failure_reason: 'OPTION_MISMATCH' })]);
      const r = await progressRow(key, source, date);
      assert.equal(r.attempt_count, 2); assert.equal(r.last_query, 'safe alternate');
      assert.equal(r.last_status, 'failed'); assert.equal(r.failure_reason, 'OPTION_MISMATCH');
      assert.deepEqual(r.queries, ['original', 'safe alternate']);
    });
    await test('nonrequest RATE_LIMIT records reason without pretending a product was attempted', async () => {
      const key = 'deferred product';
      await record(source, date, [event(key, { attempted: false, status: 'deferred', failure_reason: 'RATE_LIMIT' })]);
      const r = await progressRow(key, source, date);
      assert.equal(r.attempt_count, 0); assert.equal(r.attempted_at, null); assert.equal(r.failure_reason, 'RATE_LIMIT');
    });
    await test('new vendor option has independent progress while old option success remains intact', async () => {
      await record(source, date, [event('option|쿠팡|OLD', { success: true }), event('option|쿠팡|NEW')]);
      assert.ok((await progressRow('option|쿠팡|OLD', source, date)).success_at);
      assert.equal((await progressRow('option|쿠팡|NEW', source, date)).success_at, null);
    });
    await test('progress source and KST date keep independent rows', async () => {
      await record('adpick', date, [event('isolated')]); await record(source, '1999-01-01', [event('isolated')]);
      assert.equal(await progressRow('isolated', source, date), undefined);
      assert.equal((await progressRow('isolated', 'adpick', date)).attempt_count, 1);
    });
    await test('NFKC-expanded query identity over eighty characters persists without truncation', async () => {
      const q = 'ﬃ'.repeat(80).normalize('NFKC'), second = `${q.slice(0, -1)}x`;
      assert.equal(q.length, 240);
      const c = await claim(source, q); assert.equal(c.action, 'claimed');
      assert.equal((await queryRow(q, source, date)).normalized_query, q);
      await record(source, date, [event('Unicode identity', { query: q, event_id: 'z-first-long' }),
        event('Unicode identity', { query: second, event_id: 'a-second-long' })]);
      const r = await progressRow('Unicode identity', source, date);
      assert.equal(r.last_query, second); assert.deepEqual(r.queries, [q, second]);
    });
    await test('progress batch enforces the two-hundred-event limit without partial writes', async () => {
      await assert.rejects(() => record(source, date, Array.from({ length: 201 }, (_, i) => event(`overflow ${i}`))), /invalid collector progress batch/);
      assert.equal(await value("select count(*)::int from public.collector_product_progress where product_key like 'overflow %'"), 0);
    });
    await test('progress rejects SQL NULL and nonarray batch input', async () => {
      await assert.rejects(() => record(source, date, null)); await assert.rejects(() => record(source, date, {}));
    });
    await test('progress rejects missing event identity and rolls back the whole batch', async () => {
      await assert.rejects(() => record(source, date, [event('rolled back'), { product_key: 'bad' }]), /invalid collector progress event/);
      assert.equal(await progressRow('rolled back', source, date), undefined);
    });
    await test('catalog and price history are unchanged after every real SQL transition', async () => {
      await db.exec('reset role');
      assert.equal(await value('select count(*)::int from public.products'), 1);
      assert.equal(await value('select price from public.price_history where id=1'), 1000);
      assert.equal(await value('select count(*)::int from public.price_history'), 1);
    });
  } finally { await db.close(); }
  await verifyAndRollback();
  console.log(`Collector ledger actual SQL: ${pass} PASS / ${fail} FAIL`);
  console.log('Concurrency limit: PGlite serializes one connection; multi-backend PostgreSQL contention was not exercised.');
  process.exitCode = fail ? 1 : 0;
}
// The VERIFY and ROLLBACK files run as written against a fresh database.
async function verifyAndRollback() {
  const dir = path.join(__dirname, '..', 'supabase');
  const verify = fs.readFileSync(path.join(dir, '2026-10-03-collector-daily-efficiency.VERIFY.sql'), 'utf8');
  const rollback = fs.readFileSync(path.join(dir, '2026-10-03-collector-daily-efficiency.ROLLBACK.sql'), 'utf8');
  const db = new PGlite();
  await db.waitReady;
  const value = async sql => Object.values((await db.query(sql)).rows[0])[0];
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec("create table public.products(id text primary key); create table public.price_history(id integer primary key, price integer); create table public.price_job_state(id integer primary key); insert into public.products values('kept'); insert into public.price_history values(1,1000); insert into public.price_job_state values(1);");
    await db.exec(migration);
    await test('VERIFY runs end to end (behavior block passes) and leaves no rows behind', async () => {
      await db.exec(verify);
      assert.equal(await value('select count(*)::int from public.collector_query_runs'), 0);
      assert.equal(await value('select count(*)::int from public.collector_product_progress'), 0);
    });
    await test('VERIFY behavior block fails loudly if duplicate prevention is broken', async () => {
      await db.exec("alter table public.collector_query_runs drop constraint collector_query_runs_pkey");
      await db.exec("create or replace function public.collector_query_claim(p_source text, p_normalized_query text, p_query_hash text, p_token uuid, p_lease_seconds integer default 180) returns jsonb language sql as $f$ select jsonb_build_object('action','claimed','kst_date',(clock_timestamp() at time zone 'Asia/Seoul')::date) $f$");
      await assert.rejects(() => db.exec(verify), /duplicate prevention failed/);
      await db.exec('rollback');
      await db.exec(migration); // restores the real claim function; the table is rebuilt after ROLLBACK below
    });
    await test('ROLLBACK drops only the additive objects; catalog/history/job state survive; migration re-applies', async () => {
      await db.exec(rollback);
      assert.equal(await value("select to_regclass('public.collector_query_runs') is null"), true);
      assert.equal(await value("select to_regclass('public.collector_product_progress') is null"), true);
      assert.equal(await value("select count(*)::int from pg_proc where proname like 'collector\_query\_%' or proname = 'collector_progress_record'"), 0);
      assert.equal(await value('select count(*)::int from public.products'), 1);
      assert.equal(await value('select price from public.price_history where id=1'), 1000);
      assert.equal(await value('select count(*)::int from public.price_job_state'), 1);
      await db.exec(migration);
      assert.equal(await value("select to_regclass('public.collector_query_runs') is not null"), true);
    });
  } finally { await db.close(); }
  console.log(`Collector ledger VERIFY/ROLLBACK: done (${pass} PASS / ${fail} FAIL cumulative)`);
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
