#!/usr/bin/env node
/*
 * 수집기 대상 행에서 사진 열을 빼고, 저장할 행의 사진만 저장 직전에 읽는다 (2026-10-21) — 외부 API·DB 0회.
 *
 *   node scripts/test-collector-image-lazy.js
 *
 * 운영 실측: 실행마다 대상 14,548개를 읽는 8.4MB 중 사진 주소가 3.6MB 였다(Neon Free 전송 월 5GB).
 * 고정하는 것:
 *   [1] PRODUCT_COLS 에 image 가 없고, 매칭에 필요한 열(vendor_item_id · link · keyword)은 그대로다
 *   [2] fillStoredImages — 카탈로그 사진 우선 → 없으면 응답 사진 (예전 addRow 식과 같다), 조회 실패면 응답 사진
 *   [3] runMallCollection — DB 모양 행(사진 열 없음)을 저장할 때 기존 사진이 그대로 들어간다(ADPICK 임시 사진으로
 *       덮어쓰지 않는다). 사진 열이 있는 행(옛 호출부·테스트)은 예전 그대로이고 조회하지 않는다.
 */
'use strict';

process.env.PRICE_BATCH_INTERVAL_MS = '1';
process.env.COUPANG_ACCESS_KEY = 'test-access';
process.env.COUPANG_SECRET_KEY = 'test-secret';

const path = require('path');
const Module = require('module');
function inject(rel, ex) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p; require.cache[p].loaded = true; require.cache[p].exports = ex;
}
const dbCalls = [];
inject('api/_supabase.js', {
  from: t => { dbCalls.push(t); throw new Error('DB 를 부르면 안 된다 (주입 함수만 써야 한다): ' + t); },
  rpc: n => { dbCalls.push('rpc:' + n); return Promise.resolve({ data: null, error: null }); }
});
inject('api/_notify.js', { send: () => Promise.resolve({ ok: true }) });

const C = require('./collect-all-prices');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}
const eq = (label, a, b) => check(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

(async () => {
  console.log('\n[1] 대상 행 열');
  const cols = C.PRODUCT_COLS.split(',').map(s => s.trim());
  check('image 를 읽지 않는다', cols.indexOf('image') === -1, C.PRODUCT_COLS);
  for (const c of ['product_id', 'mall', 'title', 'keyword', 'link', 'vendor_item_id', 'item_id']) {
    check(`매칭에 쓰는 ${c} 는 그대로`, cols.indexOf(c) > -1);
  }

  console.log('\n[2] fillStoredImages');
  {
    const rows = [
      { productId: 'A', mall: '쿠팡', image: '', freshImage: 'fresh-A', imagePending: true },
      { productId: 'B', mall: '쿠팡', image: '', freshImage: 'fresh-B', imagePending: true },
      { productId: 'C', mall: 'ADPICK', image: '', freshImage: 'tmp-C', imagePending: true },
      { productId: 'D', mall: '쿠팡', image: 'kept-D', freshImage: 'fresh-D' }
    ];
    const asked = [];
    const out = await C.fillStoredImages(rows, async (mall, ids) => {
      asked.push([mall, ids.slice().sort()]);
      return new Map(mall === '쿠팡' ? [['A', 'stored-A'], ['B', '']] : [['C', 'stored-C']]);
    });
    eq('카탈로그 사진이 있으면 그것 (A)', rows[0].image, 'stored-A');
    eq('카탈로그 사진이 비었으면 응답 사진 (B)', rows[1].image, 'fresh-B');
    eq('★ ADPICK 임시 사진으로 기존 사진을 덮지 않는다 (C)', rows[2].image, 'stored-C');
    eq('사진 열이 있던 행은 건드리지 않는다 (D)', rows[3].image, 'kept-D');
    eq('몰마다 한 번, 저장할 상품만 묻는다', asked, [['쿠팡', ['A', 'B']], ['ADPICK', ['C']]]);
    check('표식은 저장 전에 지운다', rows.every(r => !('imagePending' in r)));
    eq('집계', out, { looked: 3, stored: 2, failed: false });
  }
  {
    const rows = [{ productId: 'A', mall: '쿠팡', image: '', freshImage: 'fresh-A', imagePending: true }];
    const out = await C.fillStoredImages(rows, async () => { throw new Error('db down'); });
    eq('조회 실패 → 응답 사진 (가격 저장은 막지 않는다)', rows[0].image, 'fresh-A');
    eq('실패 표시', out.failed, true);
  }
  {
    let called = 0;
    const out = await C.fillStoredImages([{ productId: 'X', mall: '쿠팡', image: 'x' }], async () => { called++; return new Map(); });
    eq('채울 행이 없으면 조회하지 않는다', [called, out.looked], [0, 0]);
  }

  console.log('\n[3] runMallCollection → 저장 행의 사진');
  async function runWith(rows, storedImages) {
    const saved = [];
    const asked = [];
    await C.runMallCollection({
      mallName: 'ADPICK', rows, savedState: null, deadlineTs: Date.now() + 8000,
      fetchAllFn: async () => ({ ok: true, reason: '', items: rows.map(r => ({
        productId: r.product_id, productName: r.title, lprice: 12000, link: 'https://example.com/' + r.product_id, image: 'tmp-' + r.product_id
      })) }),
      recordPricesFn: async obs => { saved.push(...obs.map(o => ({ ...o }))); return { saved: obs.length, recorded: obs.length,
        recordedKeys: obs.map(o => `${o.productId}|${o.mall}`), rejected: 0, suspect: 0, errors: [] }; },
      collectedTodayFn: async () => new Set(),
      cacheHintFn: async () => new Map(),
      storedImageFn: async (mall, ids) => { asked.push(...ids); return new Map(ids.map(id => [id, storedImages[id] || ''])); }
    });
    return { saved, asked };
  }
  {
    // DB 에서 읽은 모양 — PRODUCT_COLS 에 image 가 없으니 행에도 없다.
    const rows = [
      { product_id: 'P1', mall: 'ADPICK', title: '상품 1', keyword: '검색어', link: '', vendor_item_id: '', item_id: '' },
      { product_id: 'P2', mall: 'ADPICK', title: '상품 2', keyword: '검색어', link: '', vendor_item_id: '', item_id: '' }
    ];
    const { saved, asked } = await runWith(rows, { P1: 'https://cdn/stored-P1.jpg' });
    const img = id => (saved.find(o => o.productId === id) || {}).image;
    eq('저장 2건', saved.length, 2);
    eq('★ 기존 사진이 있으면 그대로 저장 (임시 응답 사진이 아니다)', img('P1'), 'https://cdn/stored-P1.jpg');
    eq('기존 사진이 없으면 응답 사진', img('P2'), 'tmp-P2');
    eq('저장할 상품의 사진만 물었다', asked.sort(), ['P1', 'P2']);
    check('저장 행에 표식이 남지 않는다', saved.every(o => !('imagePending' in o)));
  }
  {
    // 사진 열이 있는 옛 모양 — 예전과 같은 식이고 조회하지 않는다.
    const rows = [{ product_id: 'Q1', mall: 'ADPICK', title: '상품 Q', keyword: '검색어', link: '', image: 'catalog-Q1', vendor_item_id: '', item_id: '' }];
    const { saved, asked } = await runWith(rows, {});
    eq('사진 열이 있으면 예전 식 그대로', saved[0] && saved[0].image, 'catalog-Q1');
    eq('그때는 조회하지 않는다', asked.length, 0);
  }
  eq('운영 DB 를 직접 부르지 않았다', dbCalls.filter(t => !String(t).startsWith('rpc:')), []);

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
