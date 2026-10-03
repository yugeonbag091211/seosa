#!/usr/bin/env node
'use strict';

/*
 * Multi-backend PostgreSQL contention for the collector ledger/progress RPCs.
 * PGlite (test-collector-ledger-db.js) serializes one connection; this test opens real
 * parallel backends and holds row locks open so claims genuinely race.
 *
 * Runs only with COLLECTOR_PG_URL pointing at a disposable database (the Collector
 * Regression workflow starts a postgres service). It creates the Supabase roles and applies
 * the checked-in migration there. Never point it at Supabase/production.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const URL_ENV = process.env.COLLECTOR_PG_URL;
if (!URL_ENV) {
  console.log('SKIP test-collector-ledger-pg: COLLECTOR_PG_URL not set (runs in the Collector Regression workflow with a postgres service).');
  process.exit(0);
}
if (/supabase\.(co|com)|pooler\.supabase/i.test(URL_ENV)) {
  console.error('Refusing to run against a Supabase host: this test creates roles and writes rows.');
  process.exit(1);
}
const { Client } = require('pg');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261003003832_collector_daily_efficiency.sql'), 'utf8');
const hash = q => crypto.createHash('sha256').update(q, 'utf8').digest('hex');
const N = 16;
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.error(`[FAIL] ${name}: ${e.message}`); }
}
async function connect() {
  const c = new Client({ connectionString: URL_ENV });
  await c.connect();
  await c.query('set role service_role');
  return c;
}

async function main() {
  const admin = new Client({ connectionString: URL_ENV });
  await admin.connect();
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
  end $$;`);
  await admin.query(`grant usage on schema public to service_role`);
  await admin.query(migration);
  const { rows: [{ v }] } = await admin.query('show server_version');
  console.log(`PostgreSQL ${v}, ${N} parallel backends`);
  const clients = await Promise.all(Array.from({ length: N }, connect));
  const date = (await admin.query("select (clock_timestamp() at time zone 'Asia/Seoul')::date::text as d")).rows[0].d;
  const claimSql = 'select public.collector_query_claim($1,$2,$3,$4::uuid,180) as r';

  try {
    await test(`${N} backends claim one query while the first holds its transaction open → one owner`, async () => {
      const q = `race ${crypto.randomUUID()}`;
      // Every backend claims inside a transaction and sleeps before commit, so later claims
      // block on the unique index / row lock and must re-read the committed state.
      const results = await Promise.all(clients.map(async c => {
        await c.query('begin');
        try {
          const r = (await c.query(claimSql, ['coupang', q, hash(q), crypto.randomUUID()])).rows[0].r;
          await c.query('select pg_sleep(0.15)');
          await c.query('commit');
          return r;
        } catch (e) { await c.query('rollback'); throw e; }
      }));
      assert.equal(results.filter(r => r.action === 'claimed').length, 1, JSON.stringify(results.map(r => r.action)));
      assert.equal(results.filter(r => r.action === 'inflight').length, N - 1);
      const owner = results.find(r => r.action === 'claimed');
      const begins = await Promise.all(clients.map(c => c.query(
        'select public.collector_query_begin($1,$2::date,$3,$4::uuid) as ok', ['coupang', date, hash(q), owner.claim_token])));
      assert.equal(begins.filter(b => b.rows[0].ok).length, 1);
      const row = (await admin.query('select request_count from public.collector_query_runs where query_hash=$1', [hash(q)])).rows[0];
      assert.equal(row.request_count, 1);
    });

    await test(`${N} backends race to reclaim one expired, never-started claim → one new owner`, async () => {
      const q = `reclaim ${crypto.randomUUID()}`;
      await clients[0].query(claimSql, ['adpick', q, hash(q), crypto.randomUUID()]);
      await admin.query("update public.collector_query_runs set lease_until=clock_timestamp()-interval '1 second' where query_hash=$1", [hash(q)]);
      const results = await Promise.all(clients.map(c => c.query(claimSql, ['adpick', q, hash(q), crypto.randomUUID()])
        .then(r => r.rows[0].r)));
      assert.equal(results.filter(r => r.action === 'claimed').length, 1, JSON.stringify(results.map(r => r.action)));
    });

    await test(`${N} backends race on a retryable failure after backoff → at most one retry request`, async () => {
      const q = `retry ${crypto.randomUUID()}`;
      const first = (await clients[0].query(claimSql, ['coupang', q, hash(q), crypto.randomUUID()])).rows[0].r;
      await clients[0].query('select public.collector_query_begin($1,$2::date,$3,$4::uuid)', ['coupang', date, hash(q), first.claim_token]);
      await clients[0].query("select public.collector_query_finish($1,$2::date,$3,$4::uuid,'failed','NETWORK_ERROR',null,null,0)",
        ['coupang', date, hash(q), first.claim_token]);
      await admin.query("update public.collector_query_runs set next_retry_at=clock_timestamp()-interval '1 second' where query_hash=$1", [hash(q)]);
      const results = await Promise.all(clients.map(c => c.query(claimSql, ['coupang', q, hash(q), crypto.randomUUID()]).then(r => r.rows[0].r)));
      const winners = results.filter(r => r.action === 'claimed');
      assert.equal(winners.length, 1);
      const begins = await Promise.all(results.map(r => clients[0].query('select public.collector_query_begin($1,$2::date,$3,$4::uuid) as ok',
        ['coupang', date, hash(q), r.claim_token])));
      assert.equal(begins.filter(b => b.rows[0].ok).length, 1);
      assert.equal((await admin.query('select request_count from public.collector_query_runs where query_hash=$1', [hash(q)])).rows[0].request_count, 2);
    });

    await test(`${N} backends record overlapping progress batches in opposite orders → no deadlock, exact counts`, async () => {
      const keys = Array.from({ length: 8 }, (_, i) => `deadlock ${crypto.randomUUID()} ${i}`);
      const batch = order => order.map(k => ({ product_key: k, event_id: crypto.randomUUID(), query: 'q',
        status: 'evaluated', attempted: true, evaluated: true, failure_reason: 'NO_MATCH' }));
      await Promise.all(clients.map((c, i) => c.query('select count(*) from public.collector_progress_record($1,$2::date,$3::jsonb)',
        ['coupang', date, JSON.stringify(batch(i % 2 ? [...keys].reverse() : keys))])));
      const rows = (await admin.query('select product_key, attempt_count from public.collector_product_progress where product_key = any($1)', [keys])).rows;
      assert.equal(rows.length, keys.length);
      assert.ok(rows.every(r => r.attempt_count === N), JSON.stringify(rows.map(r => r.attempt_count)));
    });

    await test(`${N} backends replay the same event id → counted once`, async () => {
      const key = `idempotent ${crypto.randomUUID()}`, ev = { product_key: key, event_id: crypto.randomUUID(), query: 'q',
        status: 'failed', attempted: true, evaluated: false, failure_reason: 'TIMEOUT' };
      await Promise.all(clients.map(c => c.query('select count(*) from public.collector_progress_record($1,$2::date,$3::jsonb)',
        ['adpick', date, JSON.stringify([ev])])));
      const r = (await admin.query('select attempt_count, transient_failures from public.collector_product_progress where product_key=$1', [key])).rows[0];
      assert.equal(r.attempt_count, 1); assert.equal(r.transient_failures, 1);
    });

    await test('JS-normalized identities are accepted by the server build of the SQL guard', async () => {
      const { normalizeQuery } = require('../api/_collector-query');
      for (const raw of ['삼성   갤럭시 버즈3', ' Ｇａｌａｘｙ S24 ', 'USB-C 충전기 65W', 'ﬃ '.repeat(30), '삼성 갤럭시'.normalize('NFD')]) {
        const n = normalizeQuery(raw);
        const r = (await clients[1].query(claimSql, ['adpick', n, hash(n), crypto.randomUUID()])).rows[0].r;
        assert.ok(['claimed', 'inflight', 'cached'].includes(r.action), raw);
      }
    });
  } finally {
    await Promise.all(clients.map(c => c.end()));
    await admin.end();
  }
  console.log(`Collector ledger multi-backend PostgreSQL: ${pass} PASS / ${fail} FAIL`);
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
