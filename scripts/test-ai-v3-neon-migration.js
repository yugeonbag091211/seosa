'use strict';
/*
 * AI v3 운영 의존성 마이그레이션 검증 — 격리된 in-process PostgreSQL(PGlite)에서만 돈다.
 *
 *   1. 원래 Supabase 용 20261113000000 이 Supabase 역할이 없는 DB(운영 Neon 과 같은 조건)에서 실패함을 재현
 *   2. Neon 호환판 20261115000000 이 같은 조건에서 적용되고, 두 번 적용해도 같다(멱등)
 *   3. v3 회로(api/_ai-v3-monitor.js)가 쓰는 질의 꼴 · 프로필 병합 함수가 실제로 동작
 *   4. ROLLBACK 파일이 객체를 지우고, 다시 적용할 수 있다
 * 운영 DB·네트워크를 쓰지 않는다.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIG = p => fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', p), 'utf8');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

(async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = await PGlite.create();
  try {
    await test('운영 Neon 처럼 Supabase 역할(anon·authenticated·service_role)이 없다', async () => {
      const r = await db.query("select count(*)::int as n from pg_roles where rolname in ('anon','authenticated','service_role')");
      assert.equal(r.rows[0].n, 0);
    });

    await test('원래 Supabase 용 마이그레이션은 그 조건에서 실패한다 (role does not exist)', async () => {
      let error = null;
      try { await db.exec('begin;' + MIG('20261113000000_user_profiles.sql') + 'commit;'); }
      catch (e) { error = e; await db.exec('rollback;').catch(() => {}); }
      assert.ok(error && /role "anon" does not exist|role "service_role" does not exist/.test(String(error.message)), String(error && error.message));
      const t = await db.query("select count(*)::int as n from information_schema.tables where table_name = 'ai_v3_profiles'");
      assert.equal(t.rows[0].n, 0, '실패한 트랜잭션은 표를 남기지 않는다');
    });

    await test('Neon 호환판이 적용되고 멱등이다', async () => {
      await db.exec(MIG('20261115000000_ai_v3_neon.sql'));
      await db.exec(MIG('20261115000000_ai_v3_neon.sql'));
      const t = await db.query("select table_name from information_schema.tables where table_schema='public' and table_name in ('ai_v3_profiles','ai_v3_monitor_events') order by 1");
      assert.deepEqual(t.rows.map(r => r.table_name), ['ai_v3_monitor_events', 'ai_v3_profiles']);
      const f = await db.query("select count(*)::int as n from pg_proc where proname = 'merge_ai_v3_user_profile'");
      assert.equal(f.rows[0].n, 1);
    });

    await test('회로 질의 꼴(최근 5분 v3 표본·실패 수)이 동작한다', async () => {
      await db.query("insert into public.ai_v3_monitor_events (version, success) values ('v3', true), ('v3', false), ('legacy', true)");
      const all = await db.query("select count(*)::int as n from public.ai_v3_monitor_events where version = 'v3' and created_at >= now() - interval '5 minutes'");
      const bad = await db.query("select count(*)::int as n from public.ai_v3_monitor_events where version = 'v3' and success = false and created_at >= now() - interval '5 minutes'");
      assert.equal(all.rows[0].n, 2);
      assert.equal(bad.rows[0].n, 1);
      let rejected = false;
      try { await db.query("insert into public.ai_v3_monitor_events (version, success) values ('v9', true)"); } catch (_) { rejected = true; }
      assert.ok(rejected, 'version 은 v3/legacy 만');
    });

    await test('프로필 병합 함수: 최근 브랜드·범주가 앞에, 예산 null 은 기존 값 유지', async () => {
      const uid = 'a'.repeat(64);
      await db.query('select public.merge_ai_v3_user_profile($1, $2, $3, $4, $5)', [uid, '삼성', '노트북', null, 1000000]);
      await db.query('select public.merge_ai_v3_user_profile($1, $2, $3, $4, $5)', [uid, 'LG', '모니터', null, null]);
      const p = (await db.query('select preferred_brands, category_interests, budget_max from public.ai_v3_profiles where user_id = $1', [uid])).rows[0];
      assert.deepEqual(p.preferred_brands, ['LG', '삼성']);
      assert.deepEqual(p.category_interests, ['모니터', '노트북']);
      assert.equal(Number(p.budget_max), 1000000);
      let rejected = false;
      try { await db.query('select public.merge_ai_v3_user_profile($1, null, null, null, null)', ['not-a-hash']); } catch (_) { rejected = true; }
      assert.ok(rejected, 'user_id 는 64자 hex 해시만');
    });

    await test('VERIFY 파일의 읽기 질의가 오류 없이 돈다', async () => {
      const sql = MIG('20261115000000_ai_v3_neon.VERIFY.sql').split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
      for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.query(stmt);
    });

    await test('ROLLBACK 이 객체를 지우고 다시 적용할 수 있다', async () => {
      await db.exec(MIG('20261115000000_ai_v3_neon.ROLLBACK.sql'));
      const t = await db.query("select count(*)::int as n from information_schema.tables where table_name in ('ai_v3_profiles','ai_v3_monitor_events')");
      assert.equal(t.rows[0].n, 0);
      await db.exec(MIG('20261115000000_ai_v3_neon.sql'));
      const t2 = await db.query("select count(*)::int as n from information_schema.tables where table_name in ('ai_v3_profiles','ai_v3_monitor_events')");
      assert.equal(t2.rows[0].n, 2);
    });
  } finally { await db.close(); }
  console.log(JSON.stringify({ passed, failed: 0, database: 'PGlite (in-process PostgreSQL, no Supabase roles — same as production Neon)' }));
})().catch(e => { console.error('AI_V3_NEON_MIGRATION_FAIL', e.stack); process.exitCode = 1; });
