#!/usr/bin/env node
'use strict';
/*
 * 2026-09-13 전수 감사 후속 — 남은 P2 세 건의 회귀 고정. 외부 호출 0회 · 운영 DB 0회.
 *
 *   A. /api/search   공급원이 전부 응답하지 못하면 200 [] («결과 없음») 이 아니라 503
 *   B. acquireLock   잠금 갱신 중 DB 일시 장애: 응답만 잃었으면 회수, 안 들어갔으면 재시도,
 *                    끝내 안 되면 «일시 장애» 로 알린다 (조용한 건너뛰기 금지)
 *   C. sitemap       30일 이력 페이지를 순차 34회가 아니라 동시에 읽는다 — 결과는 같다
 */
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

for (const k of ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'ADPICK_API_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY']) delete process.env[k];
global.fetch = async url => { throw new Error(`offline test made a network request: ${url}`); };

const PG002 = { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' };
const GW504 = { message: '<html><head><title>504 Gateway Time-out</title></head></html>' };

/* ── 가짜 Supabase — 검사마다 db 를 갈아 끼운다 ─────────────────────── */
let db = null;
function inject(rel, exportsValue) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p;
  require.cache[p].loaded = true;
  require.cache[p].exports = exportsValue;
}
/** 기본 db: 어떤 조회든 DB 일시 장애로 답한다 (전면 장애 재현). */
function downDb() {
  const q = {};
  ['select', 'eq', 'in', 'gte', 'lt', 'lte', 'order', 'limit', 'range', 'is', 'update', 'upsert', 'maybeSingle', 'insert', 'not', 'or']
    .forEach(m => { q[m] = () => q; });
  q.then = (resolve, reject) => Promise.resolve({ data: null, error: PG002 }).then(resolve, reject);
  return { from: () => q, rpc: () => Promise.resolve({ data: null, error: PG002 }) };
}
inject('api/_supabase.js', new Proxy({}, {
  get(_target, prop) {
    if (prop === 'then') return undefined;
    const target = db || downDb();
    return typeof target[prop] === 'function' ? target[prop].bind(target) : undefined;
  }
}));
inject('api/_notify.js', { send: async () => ({ ok: true }) });

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (error) { failures.push(name); console.log(`  [FAIL] ${name}\n         ${error && error.message}`); }
}
const section = title => console.log(`\n[${title}]`);

function callHandler(handler, req) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      getHeader(k) { return headers[String(k).toLowerCase()]; },
      json(body) { resolve({ status: this.statusCode, headers, body }); return this; },
      end(body) { resolve({ status: this.statusCode, headers, body }); return this; }
    };
    Promise.resolve(handler(Object.assign({
      method: 'GET', headers: { origin: 'https://seosa.ai.kr' }, query: {},
      socket: { remoteAddress: `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
    }, req), res)).catch(reject);
  });
}

(async () => {
  console.log('=== P2 후속 회귀 (외부 호출 0회) ===');

  /* ── A ───────────────────────────────────────────────────────────── */
  section('A) /api/search — 전면 장애와 «결과 없음» 구분');
  const realShop = require('../api/_shop');
  let searchImpl = null;
  inject('api/_shop.js', Object.assign({}, realShop, {
    searchAll: (...args) => (searchImpl ? searchImpl(...args) : realShop.searchAll(...args)),
    saveProducts: async () => ({ saved: 0, errors: [] })
  }));
  const search = require('../api/search');

  await check('searchAll: 쿠팡·ADPICK 둘 다 응답하지 못하면 failed=true', async () => {
    searchImpl = null;
    const r = await realShop.searchAll('로지텍 마우스', { coupangLimit: 10 });
    assert.equal(r.items.length, 0);
    assert.equal(r.failed, true, JSON.stringify(r));
  });
  await check('공급원 전면 장애 → 503 · no-store · 다시 시도 안내 (200 [] 로 «결과 없음» 처럼 보이지 않는다)', async () => {
    db = null;
    searchImpl = null;
    const r = await callHandler(search, { query: { keyword: '로지텍 마우스' } });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(String(r.headers['cache-control'] || ''), /no-store/);
    assert(r.body && typeof r.body.error === 'string' && r.body.error.length > 0);
  });
  await check('공급원이 정상으로 0건을 돌려주면 여전히 200 []', async () => {
    searchImpl = async () => ({ items: [], errors: [], from: 'api', blocked: false, mismatch: false, failed: false });
    const r = await callHandler(search, { query: { keyword: '존재하지않는상품명' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });
  await check('한쪽만 실패하고 다른 쪽이 결과를 주면 200 과 결과', async () => {
    searchImpl = async () => ({
      items: [{ title: '로지텍 G304 무선 마우스', lprice: 39000, mall: '쿠팡', productId: '101',
        link: 'https://www.coupang.com/vp/products/101?vendorItemId=202', _source: 'api' }],
      errors: ['ADPICK 예외: timeout'], from: 'api', blocked: false, mismatch: false, failed: false
    });
    const r = await callHandler(search, { query: { keyword: '로지텍 마우스' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
  });
  searchImpl = null;

  /* ── B ───────────────────────────────────────────────────────────── */
  section('B) acquireLock — 잠금 갱신 중 DB 일시 장애');
  const Collector = require('./collect-all-prices');
  /*
   * script 한 칸이 update 한 번이다.
   *   drop  갱신이 들어가지 않고 일시 장애로 답한다
   *   lost  갱신은 들어갔는데 응답을 잃었다 (게이트웨이 504)
   *   deny  일시 장애가 아닌 오류
   *   ok    정상 CAS
   */
  function lockDb(row, script) {
    const log = { updates: 0, reads: 0 };
    return {
      log,
      from() {
        let mode = 'select', payload = null, eqLast, isNull = false;
        const q = {
          update(p) { mode = 'update'; payload = p; return q; },
          select() { return q; },
          eq(k, v) { if (k === 'last_run_at') eqLast = v; return q; },
          is(k, v) { if (k === 'last_run_at' && v === null) isNull = true; return q; },
          maybeSingle() { return q; },
          then(resolve, reject) {
            if (mode === 'update') {
              log.updates++;
              const step = script.length > 1 ? script.shift() : script[0];
              const match = isNull ? row.last_run_at === null : row.last_run_at === eqLast;
              if (step === 'drop') return Promise.resolve({ data: null, error: PG002 }).then(resolve, reject);
              if (step === 'deny') {
                return Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied for table price_job_state' } })
                  .then(resolve, reject);
              }
              if (match) Object.assign(row, payload);
              if (step === 'lost') return Promise.resolve({ data: null, error: GW504 }).then(resolve, reject);
              return Promise.resolve({ data: match ? [{ id: 1 }] : [], error: null }).then(resolve, reject);
            }
            log.reads++;
            return Promise.resolve({ data: JSON.parse(JSON.stringify(row)), error: null }).then(resolve, reject);
          }
        };
        return q;
      }
    };
  }
  const freshRow = () => ({ id: 1, last_run_at: '2026-09-13T00:00:00.000Z', last_result: {} });
  const noSleep = async () => {};

  await check('갱신이 안 들어간 일시 장애는 다시 시도해서 잠금을 잡는다', async () => {
    const row = freshRow();
    db = lockDb(row, ['drop', 'ok']);
    const r = await Collector.acquireLock({ ...row }, { db, sleep: noSleep });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(db.log.updates, 2);
    assert.equal(row.last_result.lock.runId, r.token);
  });
  await check('갱신은 들어갔는데 응답만 잃었으면(504) 다시 읽어 우리 잠금으로 회수한다 — 두 번 갱신하지 않는다', async () => {
    const row = freshRow();
    db = lockDb(row, ['lost']);
    const r = await Collector.acquireLock({ ...row }, { db, sleep: noSleep });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(db.log.updates, 1);
    assert.equal(row.last_result.lock.runId, r.token);
  });
  await check('일시 장애가 계속되면 ok=false · transient=true (조용한 «다른 실행 중» 이 아니다)', async () => {
    const row = freshRow();
    db = lockDb(row, ['drop']);
    const r = await Collector.acquireLock({ ...row }, { db, sleep: noSleep, attempts: 3 });
    assert.equal(r.ok, false);
    assert.equal(r.transient, true, JSON.stringify(r));
    assert.equal(db.log.updates, 3);
  });
  await check('일시 장애가 아닌 오류는 재시도하지 않는다', async () => {
    const row = freshRow();
    db = lockDb(row, ['deny']);
    const r = await Collector.acquireLock({ ...row }, { db, sleep: noSleep });
    assert.equal(r.ok, false);
    assert.notEqual(r.transient, true);
    assert.equal(db.log.updates, 1);
  });
  await check('정상 CAS 경합(다른 실행이 먼저 가져감)은 예전처럼 건너뛰기다', async () => {
    const row = freshRow();
    db = lockDb(row, ['ok']);
    const r = await Collector.acquireLock({ ...row, last_run_at: '2026-09-12T00:00:00.000Z' }, { db, sleep: noSleep });
    assert.equal(r.ok, false);
    assert.notEqual(r.transient, true);
    assert.match(r.reason, /CAS/);
  });

  /* ── C ───────────────────────────────────────────────────────────── */
  section('C) sitemap — 이력 페이지를 동시에 읽는다');
  const { productLifecycle, LIFECYCLE } = require('../api/_price');
  const page = require('../api/_product-page');
  function sitemapDb(historyRows, products, latencyMs) {
    const stats = { inFlight: 0, maxInFlight: 0, requests: 0 };
    return {
      stats,
      from(table) {
        const f = { from: 0, to: 999, count: false, head: false };
        const q = {
          select(_cols, opts) { if (opts && opts.count) f.count = true; if (opts && opts.head) f.head = true; return q; },
          gte: () => q, order: () => q, eq: () => q,
          range(a, b) { f.from = a; f.to = b; return q; },
          limit(n) { f.to = n - 1; return q; },
          then(resolve, reject) {
            stats.requests++;
            stats.inFlight++;
            stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
            const src = table === 'price_history' ? historyRows : products;
            const data = f.head ? null : src.slice(f.from, Math.min(f.to + 1, f.from + 1000));
            return new Promise(r => setTimeout(r, latencyMs))
              .then(() => { stats.inFlight--; return { data, error: null, count: f.count ? src.length : null }; })
              .then(resolve, reject);
          }
        };
        return q;
      }
    };
  }
  const nowIso = new Date().toISOString();
  const products = Array.from({ length: 300 }, (_, i) => ({
    product_id: String(700000 + i), mall: '쿠팡', keyword: '마우스', title: `상품 ${i}`, lprice: 10000,
    link: `https://www.coupang.com/vp/products/${700000 + i}?vendorItemId=${900000 + i}`, collected_at: nowIso
  }));
  const history = [];
  products.forEach((p, i) => {
    const days = i < 150 ? 10 : 5;   // 앞 150개만 색인 문턱(7일)을 넘는다
    for (let d = 0; d < days; d++) {
      for (let k = 0; k < 8; k++) {
        const at = new Date(Date.now() - d * 86400000 - k * 60000).toISOString();
        history.push({ product_id: p.product_id, mall: p.mall, recorded_date: at.slice(0, 10), recorded_at: at });
      }
    }
  });

  await check('전제: 가짜 상품은 전부 live 다', () => {
    assert(products.every(p => productLifecycle(p).state === LIFECYCLE.LIVE), productLifecycle(products[0]).state);
  });
  await check('18,000행(18페이지)을 동시에 읽고, 7일 이상 기록된 150개만 정확히 한 번씩 담는다', async () => {
    db = sitemapDb(history, products, 25);
    const list = await page._internal.indexableProducts();
    const got = list.map(x => x.pid).sort();
    const want = products.slice(0, 150).map(p => p.product_id).sort();
    assert.deepEqual(got, want);
    assert(db.stats.maxInFlight >= 4, `max in-flight ${db.stats.maxInFlight}`);
  });

  db = null;
  console.log(`\nPASS ${passed}  /  FAIL ${failures.length}`);
  if (failures.length) { console.log('failed: ' + failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
