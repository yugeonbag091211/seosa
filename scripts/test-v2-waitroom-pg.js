#!/usr/bin/env node
'use strict';
/*
 * ② 구매 대기실 마이그레이션 — 연결이 여럿인 «실제» PostgreSQL 에서만 시험할 수 있는 것.
 * (scripts/test-v2-waitroom.js 는 메모리 가짜 DB 라 제약·권한·동시성을 흉내만 낸다.)
 *
 *   PG_TEST_URL=postgres://user:pass@host:port/db node scripts/test-v2-waitroom-pg.js
 *
 * PG_TEST_URL 이 없으면 건너뛴다(exit 0). CI 는 러너 안의 일회용 postgres:17 서비스로 돈다.
 * 새 데이터베이스를 만들고 끝나면 지운다. 이메일을 보내지 않는다.
 *
 * 여기서 고정하는 것
 *   1) 마이그레이션 재실행 안전 · ROLLBACK 뒤 다시 적용
 *   2) RLS·권한: anon/authenticated 는 두 표를 읽지도 쓰지도 못한다. service_role 은 발송 기록을 지우지 못한다
 *   3) 같은 사람·같은 상품·같은 날 선점은 동시 12연결 중 정확히 하나 · 무장 해제 CAS 도 하나
 *   4) 항목을 지워도 발송 기록은 남고(item_id 만 NULL) 다시 담은 항목이 같은 날 다시 선점하지 못한다
 *   5) 같은 상품의 다른 옵션 항목도 같은 날 두 번째 선점은 막힌다 · 다른 사람은 막지 않는다
 *   6) 첫 판(item_id UNIQUE · cascade)을 적용한 환경 → UPGRADE: 기록 보존 · 재실행 안전 ·
 *      이미 중복이 있으면 크게 실패하고 아무것도 바꾸지 않는다
 */

const fs = require('fs');
const path = require('path');

const URL_ = process.env.PG_TEST_URL;
if (!URL_) {
  console.log('[test-v2-waitroom-pg] SKIP — PG_TEST_URL 없음 (CI 의 postgres 서비스에서 돈다)');
  process.exit(0);
}
const { Client } = require('pg');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, 'supabase', f), 'utf8');
const MIGRATION = read('2026-09-24-seosa2-waitroom.sql');
const UPGRADE = read('2026-09-25-seosa2-waitroom-series-dedupe.UPGRADE.sql');
const VERIFY = read('2026-09-24-seosa2-waitroom.VERIFY.sql');
const ROLLBACK = read('2026-09-24-seosa2-waitroom.ROLLBACK.sql');

// 첫 판(2026-09-24, 87c0012)의 발송 기록 표 — UPGRADE 시험용으로 모양만 옮겨 둔다
const FIRST_DRAFT_NOTIFICATIONS = `
  create table public.waitroom_notifications (
    id bigserial primary key,
    item_id bigint not null references public.waitroom_items (id) on delete cascade,
    email text not null, notify_date date not null, price integer not null, target_price integer not null,
    status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
    attempts integer not null default 1, error text not null default '',
    created_at timestamptz not null default now(), sent_at timestamptz,
    constraint waitroom_notifications_once_per_day unique (item_id, notify_date));`;

let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400))); }
}
function section(t) { console.log('\n── ' + t); }

async function main() {
  const admin = new Client({ connectionString: URL_ });
  await admin.connect();
  const DB = `wr_test_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database ${DB}`);
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    -- Supabase 의 service_role 은 RLS 를 우회한다
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if; end $$`);
  // 역할은 클러스터 공용이라 다른 시험이 먼저 만들었을 수 있다 — Supabase 처럼 RLS 우회를 보장한다
  await admin.query('alter role service_role bypassrls');
  const u = new URL(URL_); u.pathname = '/' + DB;
  const conns = [];
  const connect = async () => { const c = new Client({ connectionString: u.toString() }); c.on('error', () => {}); await c.connect(); conns.push(c); return c; };
  const c = await connect();
  const one = async (s, p) => (await c.query(s, p)).rows[0];
  const denied = async (role, sql) => {
    try { await c.query('begin'); await c.query(`set local role ${role}`); await c.query(sql); await c.query('rollback'); return false; }
    catch (e) { await c.query('rollback'); return /permission denied/.test(e.message); }
  };
  const claimSql = `insert into waitroom_notifications (item_id, email, product_id, mall, notify_date, price, target_price)
    values ($1, $2, $3, '쿠팡', current_date, 9500, 10000)
    on conflict (email, product_id, mall, notify_date) do nothing returning id`;

  try {
    section('1) 적용 · 재적용 · 제약');
    await c.query(MIGRATION);
    await c.query(MIGRATION);
    const defs = (await c.query(`select conname, pg_get_constraintdef(oid) d from pg_constraint
      where conrelid = 'public.waitroom_notifications'::regclass and contype in ('u', 'f')`)).rows;
    check(defs.some(r => /UNIQUE \(email, product_id, mall, notify_date\)/.test(r.d)) && defs.some(r => /ON DELETE SET NULL/.test(r.d)),
      '두 번 적용해도 같은 모양 — UNIQUE (email, product_id, mall, notify_date) · 항목 FK ON DELETE SET NULL', defs);
    const v = await c.query(VERIFY);
    check(Array.isArray(v) && v.length > 3, 'VERIFY.sql 이 오류 없이 돈다');

    section('2) RLS · 권한');
    await c.query(`insert into waitroom_items (email, product_id, mall, vendor_item_id, target_price) values ('a@x', 'A', '쿠팡', '1', 10000)`);
    check(await denied('anon', 'select * from waitroom_items') && await denied('authenticated', 'select * from waitroom_items')
      && await denied('authenticated', 'select * from waitroom_notifications'), 'anon/authenticated 는 두 표를 읽을 수 없다');
    check(await denied('anon', `insert into waitroom_items (email, product_id, mall, target_price) values ('evil@x','A','쿠팡',1)`)
      && await denied('authenticated', `update waitroom_items set target_price = 1`), 'anon/authenticated 는 쓸 수 없다');
    const rls = (await c.query(`select relname, relrowsecurity from pg_class where relname in ('waitroom_items','waitroom_notifications')`)).rows;
    check(rls.length === 2 && rls.every(r => r.relrowsecurity), '두 표 모두 RLS 켜짐 (정책 0 = 기본 거부)', rls);
    await c.query('begin'); await c.query('set local role service_role');
    const svc = (await c.query('select count(*)::int n from waitroom_items')).rows[0].n;
    await c.query('rollback');
    check(svc === 1, 'service_role 은 읽는다 (서버 API 는 토큰 이메일로 좁혀서만 쓴다)');
    check(await denied('service_role', 'delete from waitroom_notifications'), 'service_role 도 발송 기록은 지울 수 없다 (기록 보존)');

    section('3) 동시 선점 · 무장 해제 CAS — 12연결');
    const item = (await one(`select id from waitroom_items where email = 'a@x'`)).id;
    const racers = await Promise.all(Array.from({ length: 12 }, () => connect()));
    const claims = await Promise.all(racers.map(r => r.query(claimSql, [item, 'a@x', 'A'])));
    check(claims.filter(r => r.rowCount === 1).length === 1, '같은 사람·같은 상품·같은 날 선점은 12개 중 정확히 하나', claims.map(r => r.rowCount));
    const cas = await Promise.all(racers.map(r => r.query('update waitroom_items set armed = false where id = $1 and armed = true returning id', [item])));
    check(cas.filter(r => r.rowCount === 1).length === 1, '무장 해제(armed=true → false)도 정확히 하나', cas.map(r => r.rowCount));

    section('4) 항목 삭제 뒤에도 발송 기록 보존');
    await c.query('delete from waitroom_items where id = $1', [item]);
    const kept = (await c.query(`select item_id, status from waitroom_notifications where email = 'a@x'`)).rows;
    check(kept.length === 1 && kept[0].item_id === null, '항목을 지워도 발송 기록은 남고 item_id 만 NULL', kept);
    const again = (await one(`insert into waitroom_items (email, product_id, mall, vendor_item_id, target_price) values ('a@x','A','쿠팡','1',10000) returning id`)).id;
    check((await c.query(claimSql, [again, 'a@x', 'A'])).rowCount === 0, '다시 담은 항목도 같은 날 다시 선점하지 못한다');

    section('5) 같은 상품의 다른 옵션 · 다른 사람');
    const opt2 = (await one(`insert into waitroom_items (email, product_id, mall, vendor_item_id, target_price) values ('a@x','A','쿠팡','',9000) returning id`)).id;
    check((await c.query(claimSql, [opt2, 'a@x', 'A'])).rowCount === 0, '같은 상품을 옵션 번호 없이 담은 항목도 같은 날 두 번째 선점은 막힌다');
    const other = (await one(`insert into waitroom_items (email, product_id, mall, vendor_item_id, target_price) values ('b@x','A','쿠팡','1',10000) returning id`)).id;
    check((await c.query(claimSql, [other, 'b@x', 'A'])).rowCount === 1, '다른 사람의 같은 상품은 막지 않는다');
    check((await c.query(claimSql, [again, 'a@x', 'B'])).rowCount === 1, '같은 사람의 다른 상품은 막지 않는다');

    section('6) ROLLBACK · 다시 적용');
    await c.query(ROLLBACK);
    const gone = await one(`select to_regclass('public.waitroom_items') a, to_regclass('public.waitroom_notifications') b`);
    check(gone.a === null && gone.b === null, 'ROLLBACK 은 두 표를 지운다');
    await c.query(MIGRATION);
    check((await one(`select to_regclass('public.waitroom_notifications') t`)).t !== null, 'ROLLBACK 뒤 다시 적용된다');

    section('7) 첫 판 적용 환경 → UPGRADE');
    await c.query(ROLLBACK);
    const itemsOnly = MIGRATION.replace(/create table if not exists public\.waitroom_notifications[\s\S]*?\n\);/, FIRST_DRAFT_NOTIFICATIONS)
      .replace(/create index if not exists waitroom_notifications_series_idx[\s\S]*?;/, '');
    await c.query(itemsOnly);
    await c.query(`insert into waitroom_items (email, product_id, mall, vendor_item_id, target_price) values ('old@x','Z','쿠팡','9',5000);
      insert into waitroom_notifications (item_id, email, notify_date, price, target_price, status)
        select id, 'old@x', current_date - 3, 4900, 5000, 'sent' from waitroom_items where email = 'old@x'`);
    await c.query(UPGRADE);
    await c.query(UPGRADE);
    const up = (await c.query(`select conname, pg_get_constraintdef(oid) d from pg_constraint
      where conrelid = 'public.waitroom_notifications'::regclass and contype in ('u', 'f')`)).rows;
    const rows = (await c.query('select email, product_id, mall, status from waitroom_notifications')).rows;
    check(up.some(r => /UNIQUE \(email, product_id, mall, notify_date\)/.test(r.d)) && up.some(r => /ON DELETE SET NULL/.test(r.d))
      && !up.some(r => /CASCADE|UNIQUE \(item_id/.test(r.d)) && rows.length === 1 && rows[0].product_id === 'Z',
    'UPGRADE 두 번: 새 제약 · 기존 기록 보존(상품·몰 채움)', { up, rows });

    // 첫 판의 중복 버그가 이미 남긴 흔적(같은 사람·상품·날짜 두 행)이 있으면 UPGRADE 는 멈추고 아무것도 바꾸지 않는다
    await c.query(ROLLBACK);
    await c.query(itemsOnly);
    await c.query(`insert into waitroom_items (email, product_id, mall, vendor_item_id, target_price) values ('d@x','Q','쿠팡','1',5000), ('d@x','Q','쿠팡','',5000);
      insert into waitroom_notifications (item_id, email, notify_date, price, target_price, status)
        select id, 'd@x', current_date, 4900, 5000, 'sent' from waitroom_items where email = 'd@x'`);
    let upErr = '';
    try { await c.query(UPGRADE); } catch (e) { upErr = e.message; await c.query('rollback').catch(() => {}); }
    const still = (await c.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'waitroom_notifications_once_per_day'`)).rows[0];
    const colCount = (await one(`select count(*)::int n from information_schema.columns where table_name = 'waitroom_notifications' and column_name in ('product_id','mall')`)).n;
    check(/could not create unique index|duplicate key/.test(upErr) && /\(item_id, notify_date\)/.test(still.d) && colCount === 0,
      '중복 흔적이 있으면 UPGRADE 는 실패하고(트랜잭션) 표는 첫 판 그대로', { upErr: upErr.slice(0, 120), still, colCount });
  } finally {
    for (const cl of conns) { try { await cl.end(); } catch (e) { /* ignore */ } }
    await admin.query(`drop database if exists ${DB} with (force)`);
    await admin.end();
  }
  console.log(`\n[test-v2-waitroom-pg] PASS ${pass} / FAIL ${fail}`);
  if (fail) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
