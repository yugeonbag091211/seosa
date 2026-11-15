'use strict';
/*
 * scripts/db-quality 정정 절차 검증 — 격리된 in-process PostgreSQL(PGlite)에서만.
 *   진단(01) → 승인 목록만 정정(02) → 확인(03) → 되돌리기(04) 가 «되돌릴 수 있게» 동작하는가.
 *   행을 지우지 않는가 · 원장(price_history)을 건드리지 않는가 · 승인 뒤 값이 바뀐 행은 건드리지 않는가.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SQL = f => fs.readFileSync(path.join(__dirname, 'db-quality', f), 'utf8');
const BATCH = 'test-20261115';
// psql 변수 :'batch_id' 를 리터럴로 — PGlite 는 psql 이 아니다
const bind = sql => sql.replace(/:'batch_id'/g, `'${BATCH}'`);
// 확인용 select 와 commit 주석까지 한 번에 실행하고, 마지막 select 결과를 돌려준다
const statements = sql => sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n').split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

(async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = await PGlite.create();
  const run = async (sql) => { let last; for (const s of statements(bind(sql))) last = await db.query(s); return last; };
  try {
    await db.exec(`
      create table products (product_id text not null, mall text not null, keyword text not null default '', title text,
        lprice integer, collected_at timestamptz default now(), primary key (product_id, mall));
      create table price_history (product_id text, mall text, price integer, recorded_at timestamptz default now());
      insert into products values
        ('c1','쿠팡','수영복','코카콜라 오리지널 300ml 24개',13180, now()),
        ('c2','쿠팡','수영복','나이키 여성 원피스 수영복',74940, now()),
        ('c3','ADPICK','수영복','쌜모네키친 생연어 횟감용 200g',15290, now() - interval '10 days'),
        ('c4','쿠팡','텀블러','스탠리 퀜처 텀블러 887ml',45000, now());
      insert into price_history values ('c1','쿠팡',13180), ('c1','쿠팡',13500), ('c3','ADPICK',15290);`);

    await test('진단(01)이 오류 없이 «낱말이 하나도 없는 행» 을 센다', async () => {
      const all = statements(SQL('01-diagnose.sql'));
      const r = await db.query(all[1]);
      assert.equal(Number(r.rows[0].no_word_rows), 2);           // 콜라·연어
      assert.equal(Number(r.rows[0].no_word_live_3d), 1);        // 콜라만 최근 수집
      for (const s of all) await db.query(s);
    });

    await test('정정(02): 승인 목록만, 승인 당시 keyword 가 같은 행만 비우고 옛 값을 남긴다', async () => {
      const sql = SQL('02-quarantine.sql').replace(/create temp table quarantine_staging[\s\S]*?on commit drop;/,
        `create temp table quarantine_staging (product_id text, mall text, keyword text, reason text default '');
         insert into quarantine_staging values ('c1','쿠팡','수영복','keyword_absent'), ('c3','ADPICK','수영복','keyword_absent'),
           ('c4','쿠팡','다른키워드','stale-approval');`);
      await run(sql + '\ncommit;');
      const p = (await db.query("select product_id, keyword from products order by product_id")).rows;
      assert.deepEqual(p.map(r => [r.product_id, r.keyword]), [['c1', ''], ['c2', '수영복'], ['c3', ''], ['c4', '텀블러']]);
      const q = (await db.query(`select product_id, old_keyword from product_keyword_quarantine where batch_id = '${BATCH}' order by product_id`)).rows;
      assert.deepEqual(q.map(r => [r.product_id, r.old_keyword]), [['c1', '수영복'], ['c3', '수영복']]);
    });

    await test('행을 지우지 않고 원장(price_history)을 건드리지 않는다', async () => {
      assert.equal(Number((await db.query('select count(*) n from products')).rows[0].n), 4);
      assert.equal(Number((await db.query('select count(*) n from price_history')).rows[0].n), 3);
    });

    await test('확인(03) 질의가 돈다', async () => {
      for (const s of statements(bind(SQL('03-verify.sql')))) await db.query(s);
    });

    await test('되돌리기(04): 아직 빈 행만 옛 값으로 — 수집기가 그 사이 새로 채운 값은 지킨다', async () => {
      await db.query("update products set keyword = '쌜모네키친 생연어' where product_id = 'c3'");   // 수집기가 채운 셈
      await run(SQL('04-rollback.sql') + '\ncommit;');
      const p = (await db.query("select product_id, keyword from products order by product_id")).rows;
      assert.deepEqual(p.map(r => [r.product_id, r.keyword]), [['c1', '수영복'], ['c2', '수영복'], ['c3', '쌜모네키친 생연어'], ['c4', '텀블러']]);
      const restored = Number((await db.query(`select count(*) n from product_keyword_quarantine where batch_id='${BATCH}' and restored_at is not null`)).rows[0].n);
      assert.equal(restored, 2);
    });
  } finally { await db.close(); }
  console.log(JSON.stringify({ passed, failed: 0, database: 'PGlite (in-process PostgreSQL)' }));
})().catch(e => { console.error('DB_QUALITY_QUARANTINE_FAIL', e.stack); process.exitCode = 1; });
