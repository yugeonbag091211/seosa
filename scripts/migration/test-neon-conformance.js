#!/usr/bin/env node
/*
 * Neon 호환 계층 실측 적합성 테스트 — «격리된 Neon 테스트 브랜치» 에서만 돈다.
 *
 *   NEON_DATABASE_URL=<테스트 브랜치> SEOSA_DB_BACKEND=neon SEOSA_NEON_EXPERIMENTAL=1 VERCEL_ENV=preview \
 *     node scripts/migration/test-neon-conformance.js
 *
 * test-neon-adapter.js(가짜 실행기)가 «보내는 SQL» 을 본다면, 여기서는 실제 Postgres 18 이
 * 돌려주는 값이 PostgREST 와 같은 모양인지 본다 — 타입 · 1,000행 상한 · rpc 반환 모양 ·
 * jsonb 쓰기 · upsert 중복 방지 · 묶음 트랜잭션의 원자성 · abort.
 *
 * ★ 쓰기는 이 테스트가 만든 «검사용 행» 에만 한다(키에 __seosa_conformance_ 접두). finally 에서
 *   지우고, 지워졌는지 다시 읽어 확인한다. 운영 데이터 행은 읽기만 한다.
 * ★ 공급자 API(쿠팡·ADPICK·LLM) 호출 0회.
 */
'use strict';

// 묶음(chunk) 경로를 작은 입력으로 타게 한다 — 반드시 어댑터 require 전에.
process.env.SEOSA_NEON_MAX_PARAMS = '100';

const assert = require('node:assert/strict');

const ALLOWED_HOSTS = new Set([
  'ep-gentle-art-aoaa97v4.c-2.ap-southeast-1.aws.neon.tech',
  'ep-gentle-art-aoaa97v4-pooler.c-2.ap-southeast-1.aws.neon.tech'
]);

function guard() {
  if (process.env.SEOSA_DB_BACKEND !== 'neon' || process.env.SEOSA_NEON_EXPERIMENTAL !== '1' || process.env.VERCEL_ENV !== 'preview') {
    throw new Error('Preview + Neon 플래그가 필요합니다');
  }
  const host = new URL(process.env.NEON_DATABASE_URL || 'postgres://x').hostname;
  if (!ALLOWED_HOSTS.has(host)) throw new Error('격리된 테스트 브랜치가 아니면 거절합니다');
}

const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROBE = '__seosa_conformance_' + Date.now().toString(36);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

function kstDate(iso) {
  return new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function main() {
  guard();
  const db = require('../../api/_supabase');
  const { client } = require('../../api/_neonpg');
  try {
    console.log('[A) 읽기 — 타입과 상한]');
    let sample = [];
    await test('price_history 타입: id/price number · recorded_at PostgREST 표기 · recorded_date 문자열', async () => {
      const r = await db.from('price_history').select('id, product_id, mall, recorded_at, recorded_date, price, vendor_item_id').order('id', { ascending: false }).limit(5);
      assert.equal(r.error, null, r.error && r.error.message);
      assert.equal(r.data.length, 5);
      for (const row of r.data) {
        assert.equal(typeof row.id, 'number');
        assert.equal(typeof row.price, 'number');
        assert.match(row.recorded_at, ISO_TZ);
        assert.match(row.recorded_date, DATE);
        assert.equal(row.recorded_date, kstDate(row.recorded_at), '트리거가 만든 KST 날짜와 일치');
      }
      sample = r.data;
    });
    await test('numeric(products.oprice) → number|null · 1,000행 상한(limit 2000 → 1000)', async () => {
      const r = await db.from('products').select('id, oprice').limit(2000);
      assert.equal(r.error, null, r.error && r.error.message);
      assert.equal(r.data.length, 1000);
      assert.ok(r.data.every(x => typeof x.id === 'number' && (x.oprice === null || typeof x.oprice === 'number')));
    });
    await test('count exact + head', async () => {
      const r = await db.from('products').select('*', { count: 'exact', head: true });
      assert.equal(r.error, null); assert.equal(r.data, null);
      assert.ok(r.count > 70000, 'products ' + r.count);
      console.log('       products count = ' + r.count);
    });
    await test('like * 접두 · or() · in()', async () => {
      const r = await db.from('products').select('product_id, title').or('title.like.삼성*,title.like.SAMSUNG*').limit(20);
      assert.equal(r.error, null, r.error && r.error.message);
      assert.ok(r.data.length > 0);
      assert.ok(r.data.every(x => x.title.startsWith('삼성') || x.title.startsWith('SAMSUNG')));
      const ids = [...new Set(sample.map(x => x.product_id))];
      const r2 = await db.from('price_history').select('product_id').in('product_id', ids).limit(50);
      assert.equal(r2.error, null);
      assert.ok(r2.data.every(x => ids.includes(x.product_id)));
    });
    await test('single 0행 → PGRST116 · maybeSingle 0행 → null', async () => {
      const a = await db.from('products').select('id').eq('product_id', PROBE).single();
      assert.equal(a.error && a.error.code, 'PGRST116');
      const b = await db.from('products').select('id').eq('product_id', PROBE).maybeSingle();
      assert.equal(b.error, null); assert.equal(b.data, null);
    });
    await test('키셋 3장: id 가 number 로 단조 증가, 겹침 없음', async () => {
      let after = null; const seen = new Set();
      for (let i = 0; i < 3; i++) {
        let q = db.from('price_history').select('id').order('id', { ascending: true }).limit(1000);
        if (after !== null) q = q.gt('id', after);
        const { data, error } = await q;
        assert.equal(error, null);
        assert.equal(data.length, 1000);
        for (let j = 1; j < data.length; j++) assert.ok(data[j].id > data[j - 1].id);
        data.forEach(x => { assert.ok(!seen.has(x.id)); seen.add(x.id); });
        after = data[data.length - 1].id;
      }
    });
    await test('★ 없는 컬럼 · 없는 표 → _dberror 가 «없음» 으로 분류', async () => {
      const dberr = require('../../api/_dberror');
      const a = await db.from('products').select('no_such_column').limit(1);
      assert.equal(dberr.classifyDbError(a.error).kind, 'COLUMN_MISSING');
      const b = await db.from('no_such_table_x').select('*').limit(1);
      assert.equal(dberr.classifyDbError(b.error).kind, 'TABLE_MISSING');
    });

    console.log('\n[B) rpc — 반환 모양]');
    await test('coupang_usage() → 배열 1행 (SETOF TABLE)', async () => {
      const r = await db.rpc('coupang_usage');
      assert.equal(r.error, null, r.error && r.error.message);
      assert.ok(Array.isArray(r.data) && r.data.length === 1);
      assert.equal(typeof r.data[0].last_day, 'number');
      assert.ok(r.data[0].blocked_until === null || ISO_TZ.test(r.data[0].blocked_until));
    });
    await test('collector_target_page(…) + range(0,4) → 5행 이하', async () => {
      const r = await db.rpc('collector_target_page', {
        p_rotation_days: 1, p_rotation_bucket: 0, p_after_mall: '', p_after_product_id: '', p_limit: 20, p_include_all: false
      }).range(0, 4);
      assert.equal(r.error, null, r.error && r.error.message);
      assert.ok(Array.isArray(r.data) && r.data.length <= 5);
    });
    await test('price_drop_state_del_count() → bigint 스칼라가 number', async () => {
      const r = await db.rpc('price_drop_state_del_count');
      assert.equal(r.error, null, r.error && r.error.message);
      assert.equal(typeof r.data, 'number');
    });
    await test('price_history_prior_obs(text[], …) → SETOF price_history 행', async () => {
      const ids = [...new Set(sample.map(x => x.product_id))];
      const r = await db.rpc('price_history_prior_obs', { p_ids: ids, p_before: new Date().toISOString(), p_since: '2020-01-01T00:00:00Z' });
      assert.equal(r.error, null, r.error && r.error.message);
      assert.ok(Array.isArray(r.data));
      assert.ok(r.data.every(x => ids.includes(x.product_id) && ISO_TZ.test(x.recorded_at)));
    });
    await test('seo_sitemap_products(…) → jsonb 스칼라가 객체/배열', async () => {
      const r = await db.rpc('seo_sitemap_products', { p_id_from: 0, p_id_to: 2000, p_min_days: 1, p_max_age_days: 3650 });
      assert.equal(r.error, null, r.error && r.error.message);
      assert.equal(typeof r.data, 'object');
    });
    await test('없는 함수 → PGRST202', async () => {
      const r = await db.rpc('no_such_function_x', {});
      assert.equal(r.error.code, 'PGRST202');
    });

    console.log('\n[C) 쓰기 — 검사용 행만]');
    await test('search_stats insert → single → upsert(onConflict) → update → delete(count)', async () => {
      assert.equal((await db.from('search_stats').insert({ keyword: PROBE, count: 1 })).error, null);
      let got = await db.from('search_stats').select('keyword, count, last_searched_at').eq('keyword', PROBE).single();
      assert.equal(got.error, null); assert.equal(got.data.count, 1); assert.match(got.data.last_searched_at, ISO_TZ);
      assert.equal((await db.from('search_stats').upsert({ keyword: PROBE, count: 2 }, { onConflict: 'keyword' })).error, null);
      assert.equal((await db.from('search_stats').update({ count: 3 }).eq('keyword', PROBE)).error, null);
      got = await db.from('search_stats').select('count').eq('keyword', PROBE).single();
      assert.equal(got.data.count, 3);
      const del = await db.from('search_stats').delete({ count: 'exact' }).eq('keyword', PROBE);
      assert.equal(del.error, null); assert.equal(del.count, 1);
    });
    await test('★ user_data jsonb 배열 쓰기 → 같은 배열로 읽힌다', async () => {
      const email = PROBE + '@probe.invalid';
      const wish = [{ productId: 'p1', mall: '쿠팡' }, 'x'];
      const up = await db.from('user_data').upsert({ email, wish, viewed: [], searches: ['키보드'] }, { onConflict: 'email' });
      assert.equal(up.error, null, up.error && up.error.message);
      const got = await db.from('user_data').select('wish, viewed, searches').eq('email', email).single();
      assert.deepEqual(got.data, { wish, viewed: [], searches: ['키보드'] });
    });
    await test('auth_codes upsert(onConflict 없음 → 기본키) 두 번 → 1행', async () => {
      const email = PROBE + '@probe.invalid';
      const exp = new Date(Date.now() + 600000).toISOString();
      assert.equal((await db.from('auth_codes').upsert({ email, code_hash: 'h1', expires_at: exp, attempts: 0 })).error, null);
      assert.equal((await db.from('auth_codes').upsert({ email, code_hash: 'h2', expires_at: exp, attempts: 0 })).error, null);
      const got = await db.from('auth_codes').select('code_hash').eq('email', email);
      assert.equal(got.data.length, 1); assert.equal(got.data[0].code_hash, 'h2');
    });
    await test('★ price_history upsert 중복 방지: 같은 (상품·몰·옵션·KST일) → 1행, 가격 갱신', async () => {
      const at = '2026-10-20T16:30:00.123456+00:00';   // KST 2026-10-21 01:30
      const base = { product_id: PROBE, mall: '쿠팡', title: 'probe', link: '', recorded_at: at, item_id: '', source: 'conformance' };
      const rows = [{ ...base, vendor_item_id: 'v1', price: 1000 }, { ...base, vendor_item_id: 'v2', price: 2000 }];
      const key = 'product_id,mall,vendor_item_id,recorded_date';
      // recorded_date 는 트리거가 채운다 — 충돌 판정에 쓰이므로 행에도 같은 값을 넣는다(_shop.upsertHistory 와 같은 모양).
      const withDate = rows.map(r => ({ ...r, recorded_date: kstDate(at) }));
      assert.equal((await db.from('price_history').upsert(withDate, { onConflict: key })).error, null);
      const again = await db.from('price_history').upsert([{ ...withDate[0], price: 900 }], { onConflict: key });
      assert.equal(again.error, null, again.error && again.error.message);
      const got = await db.from('price_history').select('vendor_item_id, price, recorded_at, recorded_date').eq('product_id', PROBE).order('vendor_item_id');
      assert.equal(got.data.length, 2);
      assert.deepEqual(got.data.map(x => [x.vendor_item_id, x.price]), [['v1', 900], ['v2', 2000]]);
      assert.equal(got.data[0].recorded_date, '2026-10-21', 'KST 날짜');
      assert.equal(got.data[0].recorded_at, '2026-10-20T16:30:00.123456+00:00', '마이크로초 보존');
      // CAS(수집기 잠금이 쓰는 eq(timestamp))가 읽은 값 그대로 다시 맞는다.
      const cas = await db.from('price_history').update({ source: 'conformance-cas' }).eq('product_id', PROBE).eq('recorded_at', got.data[0].recorded_at).select('id');
      assert.equal(cas.error, null); assert.equal(cas.data.length, 2);
    });
    await test('★ 묶음 upsert(여러 문장)는 한 트랜잭션: 성공은 전부, 실패는 전무', async () => {
      const at = '2026-10-19T03:00:00+00:00';
      const mk = (i, price) => ({ product_id: PROBE + '_bulk', mall: '쿠팡', title: 'probe', vendor_item_id: 'b' + i, item_id: '', recorded_at: at, recorded_date: kstDate(at), price, source: 'conformance' });
      // 9컬럼 × 40행 = 360 인자 > 100 → 4문장
      const ok = await db.from('price_history').upsert(Array.from({ length: 40 }, (_, i) => mk(i, 100 + i)), { onConflict: 'product_id,mall,vendor_item_id,recorded_date' });
      assert.equal(ok.error, null, ok.error && ok.error.message);
      let n = await db.from('price_history').select('*', { count: 'exact', head: true }).eq('product_id', PROBE + '_bulk');
      assert.equal(n.count, 40);
      const bad = Array.from({ length: 40 }, (_, i) => mk(100 + i, i === 39 ? 'not-a-number' : 1));
      const r = await db.from('price_history').upsert(bad, { onConflict: 'product_id,mall,vendor_item_id,recorded_date' });
      assert.equal(r.error && r.error.code, '22P02');
      n = await db.from('price_history').select('*', { count: 'exact', head: true }).eq('product_id', PROBE + '_bulk');
      assert.equal(n.count, 40, '실패한 묶음의 앞 문장도 되돌려졌다');
    });

    console.log('\n[D) 중단 · 동시성]');
    await test('abortSignal: 실행 중 중단 → AbortError', async () => {
      const c = new AbortController();
      const p = db.from('price_history').select('*').limit(1000).abortSignal(c.signal);
      setTimeout(() => c.abort(), 1);
      const r = await p;
      assert.match(r.error && r.error.message || '', /^AbortError/);
    });
    await test('동시 12개 질의 (pool 5)', async () => {
      const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => db.from('products').select('id').range(i * 10, i * 10 + 9)));
      assert.ok(rs.every(r => !r.error && r.data.length === 10));
    });
  } finally {
    // 검사용 행 정리 — 실패해도 남은 것을 보고한다.
    const email = PROBE + '@probe.invalid';
    const cleanups = [
      ['search_stats', q => q.eq('keyword', PROBE)],
      ['user_data', q => q.eq('email', email)],
      ['auth_codes', q => q.eq('email', email)],
      ['price_history', q => q.eq('product_id', PROBE)],
      ['price_history', q => q.eq('product_id', PROBE + '_bulk')]
    ];
    for (const [table, f] of cleanups) {
      const r = await f(db.from(table).delete());
      if (r.error) console.log(`  ★ 정리 실패 ${table}: ${r.error.message}`);
    }
    const left = await db.from('price_history').select('*', { count: 'exact', head: true }).like('product_id', PROBE + '*');
    const leftStats = await db.from('search_stats').select('*', { count: 'exact', head: true }).eq('keyword', PROBE);
    console.log(`\n  검사용 행 정리: price_history 남음 ${left.count} · search_stats 남음 ${leftStats.count}`);
    if (left.count !== 0 || leftStats.count !== 0) failed++;
    await client.close();
  }
  console.log('\n====================================================');
  console.log(`결과: ${passed} PASS / ${failed} FAIL`);
  console.log(`NEON_CONFORMANCE ${failed ? 'FAIL' : 'PASS'}`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('NEON_CONFORMANCE_FAILED ' + e.message); process.exitCode = 1; });
