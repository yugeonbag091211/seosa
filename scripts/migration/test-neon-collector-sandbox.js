#!/usr/bin/env node
/*
 * 가격 수집기 DB 경로 실측 — Neon 테스트 브랜치, «한 트랜잭션 안에서 하고 전부 되돌린다».
 *
 *   (with-neon 래퍼가 NEON_DATABASE_URL 을 프로세스 환경으로만 넣는다)
 *   node scripts/migration/test-neon-collector-sandbox.js
 *
 * 운영 수집기(scripts/collect-all-prices.js)와 저장 경로(api/_shop.recordPrices)의 «실제 함수» 를
 * 그대로 부른다. 다른 점은 api/_supabase 자리에 «BEGIN 이 걸린 연결 하나» 를 쓰는 Neon 호환
 * 클라이언트를 끼운다는 것뿐이다. 끝에서 ROLLBACK 하고, 새 연결로 흔적이 0인지 다시 본다.
 *
 *   잠금        loadState → acquireLock(CAS) → 같은 상태로 두 번째 acquireLock 은 진다 → releaseLock
 *   상태        saveState(upsert id=1)
 *   가격 기록   recordPrices: 같은 KST 날 두 번 → 1행(가격 갱신), 다음 날 → 새 행, 다른 옵션 → 따로
 *               targetVendorItemId 가 다른 관측 → 저장 안 함(OPTION_MISMATCH)
 *   당일 확인   collectedTodayByDayScan 이 방금 기록한 상품을 «오늘 수집됨» 으로 본다
 *   호출 한도   coupang_acquire_v2 → coupang_finish · adpick_acquire · coupang_usage
 *   정리        pruneSearchCaches (24시간 지난 검색 캐시 삭제 — 되돌린다)
 *
 * ★ 공급자 API(쿠팡·ADPICK) 호출 0회. 운영 데이터는 트랜잭션 밖으로 바뀌지 않는다.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const pg = require('pg');

const ALLOWED_HOSTS = new Set([
  'ep-gentle-art-aoaa97v4.c-2.ap-southeast-1.aws.neon.tech',
  'ep-gentle-art-aoaa97v4-pooler.c-2.ap-southeast-1.aws.neon.tech'
]);
const PROBE = '__seosa_sandbox_' + Date.now().toString(36);
const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/;

function inject(rel, exportsValue) {
  const p = require.resolve(path.join(__dirname, '..', '..', rel));
  const m = new Module(p, null);
  m.filename = p; m.loaded = true; m.exports = exportsValue;
  require.cache[p] = m;
}

let passed = 0;
let failed = 0;

async function main() {
  const url = process.env.NEON_DATABASE_URL || '';
  if (!ALLOWED_HOSTS.has(new URL(url || 'postgres://x').hostname) || process.env.VERCEL_ENV !== 'preview') {
    throw new Error('격리된 테스트 브랜치(Preview)에서만 돈다');
  }
  const { createClient, _internal } = require('../../api/_neonpg');
  const conn = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true }, types: _internal.postgrestTypes });
  await conn.connect();
  await conn.query('BEGIN');
  const sandbox = createClient({ query: (text, values) => conn.query({ text, values }) });
  inject('api/_supabase.js', sandbox);

  // 각 검사를 SAVEPOINT 로 감싼다 — 하나가 실패해도 트랜잭션이 «aborted» 로 굳지 않게.
  async function test(name, fn) {
    await conn.query('SAVEPOINT t');
    try { await fn(); await conn.query('RELEASE SAVEPOINT t'); passed++; console.log('  PASS ' + name); }
    catch (e) { await conn.query('ROLLBACK TO SAVEPOINT t'); failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }

  const quiet = console.warn;
  try {
    const Collector = require('../../scripts/collect-all-prices');
    const Shop = require('../../api/_shop');
    const { kstToday, kstDayStartUtc } = require('../../api/_price');

    console.log('\n[잠금 · 상태]');
    let state = null;
    await test('loadState → price_job_state 한 행 (날짜는 문자열, 시각은 PostgREST 표기)', async () => {
      state = await Collector.loadState({ attempts: 1 });
      assert.ok(state, '상태 행이 있어야 한다');
      assert.match(state.job_date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(state.last_run_at === null || ISO_TZ.test(state.last_run_at), String(state.last_run_at));
      assert.equal(typeof state.last_result, 'object');
    });
    let token = null;
    await test('★ acquireLock(CAS) 승 → 같은 옛 상태로 다시 잡으면 짐 → releaseLock', async () => {
      const first = await Collector.acquireLock(state, { attempts: 1 });
      assert.equal(first.ok, true, first.reason);
      token = first.token;
      // 다른 실행이 «옛 last_run_at» 을 들고 왔다 — CAS 가 0행을 잡아야 한다(마이크로초까지 같은 값 비교).
      const second = await Collector.acquireLock({ ...state, last_result: {} }, { attempts: 1 });
      assert.equal(second.ok, false);
      assert.match(second.reason, /CAS/);
      await Collector.releaseLock(token);
      const after = await Collector.loadState({ attempts: 1 });
      assert.equal(after.last_result.lock, undefined, '잠금이 풀렸다');
      assert.notEqual(after.last_run_at, state.last_run_at, 'last_run_at 이 갱신됐다');
    });

    console.log('\n[가격 기록 — recordPrices (수집기·검색 공용 저장 경로)]');
    const day1 = new Date(Date.parse(kstDayStartUtc(kstToday())) + 3 * 3600 * 1000);   // 오늘 KST 03:00
    const day2 = new Date(day1.getTime() + 24 * 3600 * 1000);
    const obs = (price, vid, extra = {}) => ({
      productId: PROBE, mall: '쿠팡', title: 'sandbox probe', price,
      link: `https://www.coupang.com/vp/products/1?itemId=11&vendorItemId=${vid}`, vendorItemId: vid, ...extra
    });
    const rowsOf = async () => {
      const r = await sandbox.from('price_history').select('vendor_item_id, price, recorded_at, recorded_date, source')
        .eq('product_id', PROBE).order('recorded_at', { ascending: true }).order('vendor_item_id');
      assert.equal(r.error, null, r.error && r.error.message);
      return r.data;
    };
    await test('★ 같은 KST 날 두 번 → 1행(가격만 갱신) · 옵션 둘은 따로', async () => {
      console.warn = () => {};
      const a = await Shop.recordPrices([obs(10000, 'v1'), obs(20000, 'v2')], { source: 'sandbox', updateCatalog: false, now: day1 });
      const b = await Shop.recordPrices([obs(9900, 'v1')], { source: 'sandbox', updateCatalog: false, now: new Date(day1.getTime() + 3600 * 1000) });
      console.warn = quiet;
      assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
      const rows = await rowsOf();
      assert.deepEqual(rows.map(r => [r.vendor_item_id, r.price]).sort(), [['v1', 9900], ['v2', 20000]]);
      assert.ok(rows.every(r => r.recorded_date === kstToday(day1) && ISO_TZ.test(r.recorded_at) && r.source === 'sandbox'));
    });
    await test('다음 KST 날 → 새 행 (이력이 쌓인다)', async () => {
      console.warn = () => {};
      const c = await Shop.recordPrices([obs(9800, 'v1')], { source: 'sandbox', updateCatalog: false, now: day2 });
      console.warn = quiet;
      assert.deepEqual(c.errors, []);
      const v1 = (await rowsOf()).filter(r => r.vendor_item_id === 'v1');
      assert.deepEqual(v1.map(r => [r.recorded_date, r.price]), [[kstToday(day1), 9900], [kstToday(day2), 9800]]);
    });
    await test('★ 추적 옵션과 다른 옵션의 관측 → 저장 안 함 (OPTION_MISMATCH)', async () => {
      console.warn = () => {};
      const r = await Shop.recordPrices([obs(1, 'v9', { targetVendorItemId: 'v1' })], { source: 'sandbox', updateCatalog: false, now: day2 });
      console.warn = quiet;
      assert.equal(r.optionMismatch, 1);
      assert.ok(!(await rowsOf()).some(x => x.vendor_item_id === 'v9'));
    });
    await test('카탈로그 갱신 경로(updateCatalog) → products upsert 가 Neon 에서 성공', async () => {
      console.warn = () => {};
      const r = await Shop.recordPrices([obs(9700, 'v1')], { source: 'sandbox', now: day2 });
      console.warn = quiet;
      assert.deepEqual(r.errors, []);
      const p = await sandbox.from('products').select('product_id, mall, lprice, vendor_item_id').eq('product_id', PROBE).maybeSingle();
      assert.equal(p.error, null, p.error && p.error.message);
      assert.ok(p.data, 'products 에 행이 생겼다');
    });

    console.log('\n[당일 수집 확인 — 같은 상품을 하루에 두 번 부르지 않는 근거]');
    await test('★ collectedTodayByDayScan 이 방금 기록한 옵션을 «오늘 수집됨» 으로 본다', async () => {
      const dayStart = kstDayStartUtc(kstToday(day2));
      const dayEnd = new Date(Date.parse(dayStart) + 24 * 3600 * 1000).toISOString();
      const target = { product_id: PROBE, mall: '쿠팡', vendor_item_id: 'v1', link: obs(0, 'v1').link };
      const other = { product_id: PROBE, mall: '쿠팡', vendor_item_id: 'v2', link: obs(0, 'v2').link };
      const found1 = await Collector.collectedTodayByDayScan('쿠팡', [target], dayStart, dayEnd);
      assert.ok(found1.has(`${PROBE}|쿠팡`));
      const found2 = await Collector.collectedTodayByDayScan('쿠팡', [other], dayStart, dayEnd);
      assert.ok(!found2.has(`${PROBE}|쿠팡`), 'v2 는 day2 에 기록이 없다');
    });

    console.log('\n[호출 한도 RPC — 프로세스 사이 공유 상태]');
    await test('coupang_acquire_v2 → call_id(number) → coupang_finish', async () => {
      const a = await sandbox.rpc('coupang_acquire_v2', {
        p_source: 'collector', p_keyword: PROBE, p_search_operating_cap: 40, p_global_operating_cap: 45,
        p_interactive_reserve: 10, p_collector_cap: 30
      });
      assert.equal(a.error, null, a.error && a.error.message);
      const row = a.data[0];
      assert.equal(typeof row.allowed, 'boolean');
      if (row.allowed) {
        assert.equal(typeof row.call_id, 'number');
        const f = await sandbox.rpc('coupang_finish', { call_id: row.call_id, res: 'ok', http: 200, rcode: '0', n_items: 3 });
        assert.equal(f.error, null, f.error && f.error.message);
      }
    });
    await test('adpick_acquire → allowed/wait_ms', async () => {
      const r = await sandbox.rpc('adpick_acquire', {
        p_bucket: 'search', p_max_per_min: 10, p_margin_ms: 1000, p_not_before_ms: 0, p_max_wait_ms: 0, p_source: 'sandbox'
      });
      assert.equal(r.error, null, r.error && r.error.message);
      assert.equal(typeof r.data[0].allowed, 'boolean');
      assert.equal(typeof r.data[0].wait_ms, 'number');
    });
    await test('상태 저장(saveState 와 같은 upsert id=1 · 전체 행)', async () => {
      // saveState(finalState) 는 job_date·cursor_key·processed·total·status·last_result 를 다 보낸다.
      const cur = await Collector.loadState({ attempts: 1 });
      const row = { id: 1, job_date: cur.job_date, cursor_key: cur.cursor_key, processed: cur.processed, total: cur.total,
        status: 'completed', last_result: { ...cur.last_result, sandbox: PROBE }, updated_at: new Date().toISOString() };
      const r = await sandbox.from('price_job_state').upsert(row, { onConflict: 'id' });
      assert.equal(r.error, null, r.error && r.error.message);
      const back = await Collector.loadState({ attempts: 1 });
      assert.equal(back.status, 'completed'); assert.equal(back.last_result.sandbox, PROBE);
    });
    await test('pruneSearchCaches → 24시간 지난 검색 캐시 행 수를 센다(되돌림)', async () => {
      const log = console.log; console.log = () => {};
      const r = await Collector.pruneSearchCaches();
      console.log = log;
      assert.equal(typeof r.coupang_search_cache, 'number');
      assert.equal(typeof r.adpick_search_cache, 'number');
      console.log(`       (삭제됐을 행: 쿠팡 ${r.coupang_search_cache} · ADPICK ${r.adpick_search_cache} — ROLLBACK 으로 되돌림)`);
    });
  } finally {
    console.warn = quiet;
    await conn.query('ROLLBACK');
    await conn.end();
  }

  // 새 연결로 흔적 확인
  const check = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await check.connect();
  const left = await check.query(`select (select count(*) from price_history where product_id like $1)::int ph,
    (select count(*) from products where product_id like $1)::int p,
    (select count(*) from coupang_api_calls where keyword like $1)::int cc`, [PROBE + '%']);
  await check.end();
  const l = left.rows[0];
  console.log(`\n  ROLLBACK 뒤 흔적: price_history ${l.ph} · products ${l.p} · coupang_api_calls ${l.cc}`);
  if (l.ph || l.p || l.cc) failed++;

  console.log('\n====================================================');
  console.log(`결과: ${passed} PASS / ${failed} FAIL`);
  console.log(`NEON_COLLECTOR_SANDBOX ${failed ? 'FAIL' : 'PASS'}`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('NEON_COLLECTOR_SANDBOX_FAILED ' + (e && e.stack || e)); process.exitCode = 1; });
