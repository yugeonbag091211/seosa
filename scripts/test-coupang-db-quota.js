#!/usr/bin/env node
'use strict';

// Run the checked-in production PL/pgSQL, including its advisory lock, against
// a fresh disposable database on a loopback-only PostgreSQL test server.
// This does not read SUPABASE_* credentials or connect to a production DB.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client, Pool } = require('pg');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIGRATIONS = [
  'supabase/coupang-quota.sql',
  'supabase/2026-09-28-coupang-minute-quota.sql',
  'supabase/2026-09-28-coupang-quota-search-path.sql',
  'supabase/migrations/20261001074444_coupang_collector_daily_budget.sql'
];
let pass = 0;
function equal(actual, expected, label) {
  assert.strictEqual(actual, expected, label);
  pass++;
  console.log('  PASS ' + label);
}

(async () => {
  const raw = process.env.COUPANG_QUOTA_TEST_DATABASE_URL;
  if (!raw) throw new Error('Set COUPANG_QUOTA_TEST_DATABASE_URL to a dedicated loopback PostgreSQL test server');
  const url = new URL(raw);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback test servers are permitted');
  assert.ok(/^\/seosa_coupang_quota_test(?:_[a-z0-9_]+)?$/.test(url.pathname), 'A dedicated seosa_coupang_quota_test database is required');
  const database = 'seosa_coupang_quota_test_' + process.pid + '_' + crypto.randomBytes(4).toString('hex');
  const admin = new Client({ connectionString: raw });
  let pool, created = false;
  await admin.connect();
  try {
    // Supabase migrations revoke/grant these standard roles. They are created
    // only on the explicitly selected, isolated local test server.
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;`);
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    created = true;
    url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.toString(), max: 12 });
    for (const migration of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, '..', migration), 'utf8'));
    const reset = async () => {
      // These tables exist only in the database this process just created.
      await pool.query('TRUNCATE public.coupang_api_calls RESTART IDENTITY');
      await pool.query("UPDATE public.coupang_api_state SET blocked_until = NULL, reason = '' WHERE id = 1");
    };
    const acquire = async (source = 'collect', config = [35, 80, 15, 20], client = pool) => {
      const { rows } = await client.query('SELECT * FROM public.coupang_acquire_v2($1,$2,$3,$4,$5,$6)',
        [source, 'isolated-db-fixture', ...config]);
      return rows[0];
    };
    const count = async () => Number((await pool.query('SELECT count(*) AS n FROM public.coupang_api_calls')).rows[0].n);

    equal((await pool.query("SELECT * FROM public.coupang_acquire_v2('collect','default-config-fixture')")).rows[0].allowed, true,
      'the migration default arguments allow the first collector reservation');
    for (let i = 1; i < 20; i++) equal((await acquire()).allowed, true, `collector call ${i + 1} is allowed in one minute`);
    equal((await acquire()).allowed, false, 'collector call 21 is denied in the same window');
    equal(await count(), 20, 'a denied collector does not create an external-call reservation');
    for (let i = 0; i < 15; i++) equal((await acquire('search')).allowed, true, `reserved interactive call ${i + 1} is allowed after 20 collectors`);
    equal((await acquire('search')).allowed, false, 'interactive call 36 respects the 35 operating ceiling');
    equal(await count(), 35, 'collector plus interactive totals stay at the operating ceiling');

    await reset();
    const interactiveOnly = await Promise.all(Array.from({ length: 40 }, () => acquire('search')));
    equal(interactiveOnly.filter(row => row.allowed).length, 35, 'interactive can use the whole operating budget when collectors are idle');
    await reset();
    const overlappingCollectors = await Promise.all(Array.from({ length: 64 }, (_, i) => acquire(i % 2 ? 'collect' : 'cron')));
    equal(overlappingCollectors.filter(row => row.allowed).length, 20, 'multiple collector/cron DB clients share exactly 20 background slots');
    equal(await count(), 20, 'parallel background clients cannot oversubscribe the DB ledger');
    equal((await acquire('search')).allowed, true, 'interactive remains available after simultaneous background requests');

    await reset();
    const dangerousOverrides = await Promise.all(Array.from({ length: 30 }, () => acquire('collect', [1000, 1000, 0, 1000])));
    equal(dangerousOverrides.filter(row => row.allowed).length, 20, 'the DB clamps an excessive collector override to the first-stage 20 ceiling');
    await reset();
    const lowerOperating = await Promise.all(Array.from({ length: 30 }, () => acquire('collect', [30, 80, 0, 1000])));
    equal(lowerOperating.filter(row => row.allowed).length, 15, 'the DB keeps a 15-slot interactive reserve even when callers request zero');

    await reset();
    const searchHard = await Promise.all(Array.from({ length: 64 }, () => acquire('search', [1000, 1000, 15, 20])));
    equal(searchHard.filter(row => row.allowed).length, 50, 'inflated caller caps cannot exceed the Search 50/min hard cap');
    equal(await count(), 50, 'Search hard ceiling is enforced on the real shared DB ledger');
    equal(/Search 분당 hard cap/.test((await acquire('search', [1000, 1000, 15, 20])).reason), true, 'Search call 51 is rejected by the hard cap');

    await reset();
    await pool.query("INSERT INTO public.coupang_api_calls(api_type,source,keyword,called_at) SELECT 'deeplink','fixture','non-search',clock_timestamp() FROM generate_series(1,99)");
    equal((await acquire('search', [1000, 1000, 15, 20])).allowed, true, 'the hundredth global call can use the last available slot');
    const globalDenied = await acquire('search', [1000, 1000, 15, 20]);
    equal(globalDenied.allowed, false, 'global call 101 is denied even when Search is below 50');
    equal(/전체 API 분당 hard cap/.test(globalDenied.reason), true, 'the 100/min global hard ceiling is independent of Search');
    equal(await count(), 100, 'global denial does not reserve call 101');

    await reset();
    // Keep day fixtures outside the last minute, including runs at KST 00:00.
    const sinceMidnight = Number((await pool.query("SELECT extract(epoch FROM clock_timestamp() - (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')) AS seconds")).rows[0].seconds);
    if (sinceMidnight < 62) await sleep(Math.ceil((62 - sinceMidnight) * 1000));
    await pool.query(`INSERT INTO public.coupang_api_calls(api_type,source,keyword,outcome,called_at)
      SELECT 'search','collect','earlier-today', CASE WHEN n % 2 = 0 THEN 'pending' ELSE 'http_error' END,
        date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
      FROM generate_series(1,3399) AS n`);
    const dailyParallel = await Promise.all(Array.from({ length: 12 }, () => acquire()));
    equal(dailyParallel.filter(row => row.allowed).length, 1, 'multiple collector DB clients can reserve only daily call 3400');
    equal(await count(), 3400, 'pending and failed calls still count toward the shared daily ceiling');
    const dailyDenied = await acquire();
    equal(dailyDenied.allowed, false, 'daily call 3401 is rejected by the atomic DB gate');
    equal(/하루 호출 예산.*3400/.test(dailyDenied.reason), true, 'the denial identifies the 3400 daily ceiling');
    equal((await acquire('search')).allowed, true, 'collector daily exhaustion does not reject interactive search');
    await reset();
    await pool.query(`INSERT INTO public.coupang_api_calls(api_type,source,keyword,called_at)
      SELECT 'search','collect','yesterday',
        (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul') - interval '1 second'
      FROM generate_series(1,3400)`);
    equal((await acquire()).allowed, true, 'yesterday collector calls do not consume today KST allowance');

    await reset();
    await pool.query("SELECT public.coupang_block_seconds(60, 'fixture-429')");
    equal((await acquire('collect')).allowed, false, 'the shared circuit blocks background clients');
    equal((await acquire('search')).allowed, false, 'the existing shared circuit also blocks interactive clients');
    equal(await count(), 0, 'shared cooldown denial does not consume an external call');
    await pool.query("SELECT public.coupang_block_seconds(1, 'fixture-shorter')");
    equal(Number((await pool.query('SELECT extract(epoch FROM blocked_until-clock_timestamp()) AS seconds FROM public.coupang_api_state')).rows[0].seconds) > 55, true,
      'a shorter Retry-After cannot reduce an existing longer shared cooldown');

    await reset();
    const owner = await pool.connect();
    const waiter = await pool.connect();
    try {
      const waiterPid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await owner.query('BEGIN');
      await owner.query('SELECT pg_advisory_xact_lock(8912042601)');
      await owner.query("INSERT INTO public.coupang_api_calls(api_type,source,keyword,called_at) SELECT 'search','collect','expiring',clock_timestamp()-interval '59.7 seconds' FROM generate_series(1,20)");
      const waiting = acquire('collect', [35, 80, 15, 20], waiter);
      let waitingOnLock = false;
      for (let i = 0; i < 100; i++) {
        const event = (await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [waiterPid])).rows[0];
        if (event && event.wait_event === 'advisory') { waitingOnLock = true; break; }
        await sleep(10);
      }
      equal(waitingOnLock, true, 'a second PostgreSQL backend actually waits on the production advisory lock');
      await sleep(450);
      await owner.query('COMMIT');
      equal((await waiting).allowed, true, 'the gate refreshes its clock after waiting for the shared lock');
    } finally { await owner.query('ROLLBACK'); owner.release(); waiter.release(); }

    await reset();
    const transaction = await pool.connect();
    try {
      await transaction.query('BEGIN');
      const started = (await transaction.query('SELECT transaction_timestamp() AS started')).rows[0].started;
      await sleep(200);
      const reserved = await acquire('collect', [35, 80, 15, 20], transaction);
      const stamped = (await transaction.query('SELECT called_at FROM public.coupang_api_calls WHERE id=$1', [reserved.call_id])).rows[0].called_at;
      equal(stamped.getTime() - started.getTime() >= 150, true, 'ledger timestamp records actual reservation time, not the old transaction start');
      await transaction.query('COMMIT');
    } finally { await transaction.query('ROLLBACK'); transaction.release(); }

    const privileges = await pool.query("SELECT has_function_privilege('anon', 'public.coupang_acquire_v2(text,text,integer,integer,integer,integer)', 'EXECUTE') AS anon, has_function_privilege('authenticated', 'public.coupang_acquire_v2(text,text,integer,integer,integer,integer)', 'EXECUTE') AS authenticated, has_function_privilege('service_role', 'public.coupang_acquire_v2(text,text,integer,integer,integer,integer)', 'EXECUTE') AS service_role");
    equal(privileges.rows[0].anon, false, 'anonymous clients cannot acquire privileged quota slots');
    equal(privileges.rows[0].authenticated, false, 'authenticated public clients cannot acquire privileged quota slots');
    equal(privileges.rows[0].service_role, true, 'server service_role retains execute permission');
    console.log(`\nPASS ${pass} / FAIL 0 (production SQL, isolated PostgreSQL, concurrent clients)`);
  } finally {
    if (pool) await pool.end();
    // Drop only the unique database created above; the supplied test DB and all
    // existing databases are untouched, even when assertions fail.
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
})().catch(error => { console.error(error.stack || error); console.log(`PASS ${pass} / FAIL 1`); process.exitCode = 1; });
