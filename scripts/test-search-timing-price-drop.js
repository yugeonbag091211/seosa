#!/usr/bin/env node
'use strict';

/*
 * /api/search 지연 (2026-11-24 감사 Stage 3).
 *
 *   1. 가격 하락 조회는 price_drop_for_products 함수가 있으면 그걸 쓰고, 없으면(PGRST202)
 *      지금처럼 price_drop_top 뷰를 읽는다. 함수가 없다는 것은 한 번만 확인한다.
 *      (뷰는 검색 결과 18개를 위해 price_history 56만 행을 훑었다 — 운영 423~479ms.
 *       함수는 같은 행을 2~13ms 에 냈다. supabase/2026-11-24-price-drop-for-products.sql)
 *   2. 신뢰도(attachTrust)와 가격 하락(attachPriceChange)은 저장 뒤에 함께 돈다.
 *   3. 단계별 시간이 Server-Timing 헤더로 나간다.
 *
 * 외부 호출 0 · DB 접속 0 (가짜 DB).
 */

const assert = require('node:assert/strict');
const Module = require('node:module');

let pass = 0;
let fail = 0;
async function check(label, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${label}`); }
  catch (e) { fail++; console.log(`  FAIL  ${label} — ${e && e.message}`); }
}

/* 가짜 DB — 시나리오마다 rpc/from 동작을 바꿔 끼운다. */
const calls = [];
const fakeDb = {
  rpcImpl: null,
  viewImpl: null,
  viewRows: [],
  rpc(name, params) { calls.push(['rpc', name, params]); return this.rpcImpl(name, params); },
  from(table) {
    calls.push(['from', table]);
    const rows = this.viewRows;
    return { select() { return this; }, in(col, ids) { calls.push(['in', col, ids.length]); return fakeDb.viewImpl ? fakeDb.viewImpl(col, ids) : Promise.resolve({ data: rows, error: null }); } };
  }
};
const dbPath = require.resolve('../api/_supabase');
require.cache[dbPath] = Object.assign(new Module(dbPath), { filename: dbPath, id: dbPath, loaded: true, exports: fakeDb });

const facets = require('../api/_facets');
const { loadDropRows, resetDropRpc } = facets._internal;

const ROW = {
  product_id: '9100200300', mall: '쿠팡', current_price: 9000, prev_price: 12000, all_time_low: 9000,
  drop_amount: 3000, drop_pct: 25, is_all_time_low: true, link: 'https://link.coupang.com/re/AFFSDP?vendorItemId=111'
};
const item = () => ({ productId: '9100200300', mall: '쿠팡', vendorItemId: '111', lprice: 9000, title: 't' });

(async () => {
  console.log('\n가격 하락 조회: 함수가 있으면 함수, 없으면 뷰');

  await check('함수가 없으면(PGRST202) 뷰로 읽고, 다음부터는 함수를 다시 부르지 않는다', async () => {
    resetDropRpc(); calls.length = 0;
    fakeDb.rpcImpl = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.price_drop_for_products(p_ids) in the schema cache' } });
    fakeDb.viewRows = [ROW];
    const a = await loadDropRows(['P1']);
    assert.equal(a.via, 'view');
    const b = await loadDropRows(['P1']);
    assert.equal(b.via, 'view');
    assert.equal(calls.filter(c => c[0] === 'rpc').length, 1, JSON.stringify(calls));
  });

  await check('함수가 있으면 함수 결과를 쓰고 뷰는 읽지 않는다', async () => {
    resetDropRpc(); calls.length = 0;
    fakeDb.rpcImpl = async (name, params) => {
      assert.equal(name, 'price_drop_for_products');
      assert.deepEqual(params, { p_ids: ['P1'] });
      return { data: [ROW], error: null };
    };
    const r = await loadDropRows(['P1']);
    assert.equal(r.via, 'rpc');
    assert.equal(calls.filter(c => c[0] === 'from').length, 0);
  });

  await check('함수 호출이 예외를 던지면(읽기 전용 검증 환경 등) 그 묶음은 뷰로 읽는다', async () => {
    resetDropRpc(); calls.length = 0;
    fakeDb.rpcImpl = () => { throw new Error('읽기 전용 검증 환경입니다 — DB 쓰기를 막았습니다: rpc price_drop_for_products'); };
    fakeDb.viewRows = [ROW];
    const r = await loadDropRows(['P1']);
    assert.equal(r.via, 'view');
  });

  await check('함수의 다른 오류(시간 초과 등)는 «없음» 으로 기억하지 않는다', async () => {
    resetDropRpc(); calls.length = 0;
    let n = 0;
    fakeDb.rpcImpl = async () => { n++; return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }; };
    await loadDropRows(['P1']);
    await loadDropRows(['P1']);
    assert.equal(n, 2, 'rpc is retried on the next search');
  });

  await check('SEOSA_PRICE_DROP_RPC=0 이면 함수를 부르지 않는다', async () => {
    resetDropRpc(); calls.length = 0;
    process.env.SEOSA_PRICE_DROP_RPC = '0';
    fakeDb.rpcImpl = async () => { throw new Error('must not be called'); };
    const r = await loadDropRows(['P1']);
    delete process.env.SEOSA_PRICE_DROP_RPC;
    assert.equal(r.via, 'view');
  });

  await check('함수 경로와 뷰 경로가 같은 행이면 붙는 «가격 하락» 도 같다', async () => {
    resetDropRpc();
    fakeDb.rpcImpl = async () => ({ data: [ROW], error: null });
    const viaRpc = [item()];
    await facets.attachPriceChange(viaRpc);
    resetDropRpc();
    fakeDb.rpcImpl = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    fakeDb.viewRows = [ROW];
    const viaView = [item()];
    await facets.attachPriceChange(viaView);
    assert.ok(viaRpc[0].priceChange, 'priceChange attached');
    assert.deepEqual(viaRpc[0].priceChange, viaView[0].priceChange);
  });

  await check('뷰가 오류를 반환하거나 예외를 던져도 검색 상품을 그대로 돌려준다', async () => {
    resetDropRpc();
    fakeDb.rpcImpl = async () => ({ data: null, error: { code: '57014', message: 'timeout' } });
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const viewImpl of [
        async () => ({ data: null, error: { message: 'view failed' } }),
        async () => { throw new Error('connection failed'); }
      ]) {
        fakeDb.viewImpl = viewImpl;
        const items = [item()];
        assert.equal(await facets.attachPriceChange(items), items);
        assert.equal(items[0].priceChange, undefined);
      }
    } finally {
      fakeDb.viewImpl = null;
      console.warn = warn;
    }
  });

  console.log('\n/api/search: 신뢰도와 가격 하락은 함께 돌고, 단계 시간이 Server-Timing 으로 나간다');
  {
    const shop = require('../api/_shop');
    const http = require('../api/_http');
    http.applyCors = () => true;
    require('../api/_ratelimit').guard = () => true;
    http.fail = (res, e, ctx) => res.status(ctx.status || 500).json({ error: ctx.message || String(e) });
    shop.saveProducts = async () => ({ saved: 0 });
    const events = [];
    const wait = ms => new Promise(r => setTimeout(r, ms));
    require('../api/_trust').attachTrust = async () => { events.push('trust:start'); await wait(120); events.push('trust:end'); };
    facets.attachPriceChange = async () => { events.push('drop:start'); await wait(120); events.push('drop:end'); };
    const items = [{ title: '무선 이어폰 블루투스', lprice: 49000, oprice: 49000, mall: '쿠팡', _source: 'api', productId: 'T-1', link: 'https://example.test/p/1' }];
    shop.searchAll = async () => ({ items, allItems: items, from: 'api', providerSources: { coupang: 'api', adpick: 'api' },
      providerBlocked: { coupang: false, adpick: false }, freshAnswered: true, failed: false, errors: [] });
    const handler = require('../api/search');
    const headers = {};
    let status = 200;
    const res = { setHeader(k, v) { headers[k] = v; return this; }, status(n) { status = n; return this; }, json() { return this; } };
    const t0 = Date.now();
    const log = console.log; const lines = []; console.log = (...a) => lines.push(a.join(' '));
    try { await handler({ method: 'GET', headers: {}, query: { keyword: '무선 이어폰' } }, res); }
    finally { console.log = log; }
    const elapsed = Date.now() - t0;

    await check('응답 200', async () => assert.equal(status, 200));
    await check('두 단계가 서로를 기다리지 않는다(둘 다 시작한 뒤에 끝난다)', async () => {
      assert.deepEqual(events.slice(0, 2).sort(), ['drop:start', 'trust:start'], JSON.stringify(events));
      assert.ok(elapsed < 230, `elapsed ${elapsed}ms (sequential would be ≥240ms)`);
    });
    await check('Server-Timing 에 prov·save·trust·drop·rank·total 이 있다', async () => {
      const st = headers['Server-Timing'] || '';
      for (const k of ['prov', 'save', 'trust', 'drop', 'rank', 'total']) assert.match(st, new RegExp(`(^|, )${k};dur=\\d+`), st);
    });
    await check('[search-timing] 로그 한 줄이 남는다', async () => {
      const line = lines.find(l => l.startsWith('[search-timing] '));
      assert.ok(line, lines.join('\n'));
      const j = JSON.parse(line.slice('[search-timing] '.length));
      assert.equal(j.items, 1);
      assert.equal(j.src, 'api');
    });
  }

  console.log(`\nSearch timing / price-drop: ${pass}/${pass + fail} PASS, ${fail} FAIL. External calls: 0. DB connections: 0.`);
  process.exit(fail ? 1 : 0);
})();
