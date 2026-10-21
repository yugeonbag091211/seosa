#!/usr/bin/env node
/*
 * 저장 경로의 «직전 관측» 을 계열당 한 행 RPC 로 (2026-10-21) — 외부 API·운영 DB 0회.
 *
 *   node scripts/test-prev-obs-rpc.js
 *
 * 운영 Neon 읽기 전용 대조(상품 1,200개): 예전 조각 조회 2.78MB · 12질의 → RPC 0.46MB · 4질의,
 * 결과 1,191개 동일 · 차이 0 · RPC 에만 8개(예전 방식이 묶음당 2,000행 상한에 걸려 놓친 값).
 * 고정하는 것:
 *   [1] RPC 가 준 계열 행 중 (상품|몰) 최신 한 행 — 예전 규칙과 같다 (옵션은 값으로 남는다, __LEGACY__ → link)
 *   [2] RPC 를 오늘 시작 시각 이전(p_before)으로 부른다 — 오늘 행과 자기 비교하지 않게
 *   [3] 함수 없음·오류·배열 아님·스위치(SEOSA_PREV_OBS_RPC=0) → 예전 조각 조회로 같은 결과
 */
'use strict';

const path = require('path');
const Module = require('module');
function inject(rel, ex) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p; require.cache[p].loaded = true; require.cache[p].exports = ex;
}

const HIST = [
  // 상품 A: 옵션 두 개, 최신은 V2 (어제)
  { product_id: 'A', mall: '쿠팡', price: 1000, recorded_at: '2026-10-19T03:00:00+00:00', recorded_date: '2026-10-19', vendor_item_id: 'V1', link: '' },
  { product_id: 'A', mall: '쿠팡', price: 1200, recorded_at: '2026-10-20T03:00:00+00:00', recorded_date: '2026-10-20', vendor_item_id: 'V2', link: '' },
  { product_id: 'A', mall: '쿠팡', price: 900, recorded_at: '2026-10-18T03:00:00+00:00', recorded_date: '2026-10-18', vendor_item_id: 'V2', link: '' },
  // 상품 B: 옛 행 — vid 가 __LEGACY__ 라 link 에서 뽑는다
  { product_id: 'B', mall: '쿠팡', price: 5000, recorded_at: '2026-10-10T03:00:00+00:00', recorded_date: '2026-10-10', vendor_item_id: '__LEGACY__',
    link: 'https://link.coupang.com/re/AFFSDP?pageKey=B&itemId=1&vendorItemId=777' },
  // 상품 C: ADPICK, 오늘 행(비교 대상에서 빠져야 한다) + 그제
  { product_id: 'C', mall: 'ADPICK', price: 3000, recorded_at: '2026-10-21T02:00:00+00:00', recorded_date: '2026-10-21', vendor_item_id: '', link: '' },
  { product_id: 'C', mall: 'ADPICK', price: 2800, recorded_at: '2026-10-19T02:00:00+00:00', recorded_date: '2026-10-19', vendor_item_id: '', link: '' }
];

const calls = { rpc: [], from: 0 };
let rpcMode = 'ok';
function latestPerSeries(ids, before) {
  const best = new Map();
  for (const r of HIST) {
    if (ids.indexOf(r.product_id) < 0 || !(r.recorded_at < before)) continue;
    const k = `${r.product_id}|${r.mall}|${r.vendor_item_id}`;
    if (!best.has(k) || r.recorded_at > best.get(k).recorded_at) best.set(k, r);
  }
  return [...best.values()];
}
const fake = {
  rpc(name, args) {
    calls.rpc.push({ name, args });
    if (rpcMode === 'missing') return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.price_history_prior_obs in the schema cache' } });
    if (rpcMode === 'error') return Promise.resolve({ data: null, error: { code: 'XX000', message: 'boom' } });
    if (rpcMode === 'null') return Promise.resolve({ data: null, error: null });
    return Promise.resolve({ data: latestPerSeries(args.p_ids, args.p_before), error: null });
  },
  from(table) {
    calls.from++;
    const f = { in: null, lt: null };
    const q = {
      select() { return q; },
      in(c, v) { f.in = v; return q; },
      lt(c, v) { f.lt = v; return q; },
      order() { return q; },
      limit() { return q; },
      then(res) {
        const rows = HIST.filter(r => f.in.indexOf(r.product_id) > -1 && r.recorded_at < f.lt)
          .sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
        return Promise.resolve({ data: table === 'price_history' ? rows : [], error: null }).then(res);
      }
    };
    return q;
  }
};
inject('api/_supabase.js', fake);

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}
const eq = (label, a, b) => check(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

(async () => {
  const Shop = require('../api/_shop');
  const keys = [{ productId: 'A' }, { productId: 'B' }, { productId: 'C' }];
  const today = '2026-10-21';
  const view = m => [...m.entries()].sort().map(([k, v]) => [k, v.price, v.vendorItemId, String(v.observedAt).slice(0, 10)]);

  console.log('\n[1·2] RPC 경로');
  rpcMode = 'ok'; calls.rpc.length = 0; calls.from = 0;
  const viaRpc = await Shop.loadPrevObservations(keys, today);
  eq('(상품|몰) 최신 한 행 · 옵션 값 · __LEGACY__ 는 link 에서', view(viaRpc), [
    ['A|쿠팡', 1200, 'V2', '2026-10-20'],
    ['B|쿠팡', 5000, '777', '2026-10-10'],
    ['C|ADPICK', 2800, '', '2026-10-19']
  ]);
  eq('RPC 1회 · 표 직접 조회 0회', [calls.rpc.length, calls.from], [1, 0]);
  check('★ p_before = 오늘 KST 시작 (오늘 행과 자기 비교하지 않는다)', calls.rpc[0] && calls.rpc[0].args.p_before === '2026-10-20T15:00:00.000Z',
    calls.rpc[0] && calls.rpc[0].args.p_before);

  console.log('\n[3] 예전 조각 조회로 돌아가는 경우 — 결과는 같다');
  for (const mode of ['error', 'null']) {
    rpcMode = mode; calls.from = 0;
    const m = await Shop.loadPrevObservations(keys, today);
    eq(`RPC ${mode} → 예전 조회 결과가 RPC 경로와 같다`, view(m), view(viaRpc));
    check(`RPC ${mode} → 표를 직접 조회했다`, calls.from > 0);
  }
  rpcMode = 'ok';
  process.env.SEOSA_PREV_OBS_RPC = '0';
  calls.rpc.length = 0;
  const off = await Shop.loadPrevObservations(keys, today);
  eq('스위치 SEOSA_PREV_OBS_RPC=0 → RPC 를 부르지 않고 같은 결과', [calls.rpc.length, view(off)], [0, view(viaRpc)]);
  delete process.env.SEOSA_PREV_OBS_RPC;

  rpcMode = 'missing'; calls.rpc.length = 0;
  await Shop.loadPrevObservations(keys, today);
  await Shop.loadPrevObservations(keys, today);
  eq('함수가 없으면 한 번만 묻고 그 뒤로는 예전 조회만', calls.rpc.length, 1);

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
