#!/usr/bin/env node
/*
 * 캐시 힌트의 옵션 확인 회귀 테스트 (2026-10-21) — 외부 API·운영 DB 호출 0회.
 *
 *   node scripts/test-collector-hint-options.js
 *
 * 운영 실측(KST 10-21): 쿠팡 hint 패스 419회(전부 오늘 캐시) → 회수 0개. 미수집 대상이 검색 캐시에
 * 나온 1,626쌍이 전부 «다른 vendorItemId» 였다 — 같은 응답을 다시 읽으면 옵션 게이트가 또 거절한다.
 * 고정하는 것:
 *   [1] 추적 옵션 그대로 실린 검색어만 남고, 다른 옵션뿐인 검색어는 빠진다 (순서 유지)
 *   [2] 캐시 행을 «한 번에 묶어» 읽는다 — 검색어마다 왕복하지 않는다
 *   [3] 판단 근거가 없으면(조회 실패 · 행 없음) 예전처럼 걸러내지 않는다
 *   [4] ADPICK(옵션 개념 없음)과 대상 정보 없는 호출은 그대로 — 예전 동작
 *   [5] runMallCollection 이 hint 함수에 대상 행(vendor_item_id 포함)을 넘긴다
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

/* 가짜 DB — search_cache_hints RPC 와 coupang_search_cache 의 .in('keyword', …) 만 흉내 낸다. */
const db = { hints: [], rows: [], reads: [], failRead: false };
function cacheQuery() {
  const q = { cols: '', keys: null };
  const chain = {
    select(cols) { q.cols = cols; return chain; },
    in(col, values) { q.keys = values; return chain; },
    then(resolve) {
      db.reads.push({ cols: q.cols, keys: q.keys });
      if (db.failRead) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
      const want = new Set(q.keys || []);
      return Promise.resolve({ data: db.rows.filter(r => want.has(r.keyword)), error: null }).then(resolve);
    }
  };
  return chain;
}
inject('api/_supabase.js', {
  from: () => cacheQuery(),
  rpc: n => Promise.resolve(n === 'search_cache_hints' ? { data: db.hints, error: null } : { data: null, error: null })
});
inject('api/_notify.js', { send: () => Promise.resolve({ ok: true }) });

const C = require('./collect-all-prices');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}
const eq = (label, a, b) => check(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const item = (pid, vid) => ({ productId: pid, vendorItemId: vid, productName: 'x', lprice: 1000 });
const target = (pid, vid, link = '') => ({ product_id: pid, mall: '쿠팡', vendor_item_id: vid, link });

(async () => {
  console.log('\n[1] 옵션까지 같은 검색어만 남긴다');
  {
    db.reads = []; db.failRead = false;
    db.hints = [['A', ['다른옵션뿐', '맞는옵션', '행없음']], ['B', ['맞는옵션']], ['N', ['맞는옵션']]];
    db.rows = [
      { keyword: '다른옵션뿐', items: [item('A', '22'), item('A', '33')] },
      { keyword: '맞는옵션', items: [item('A', '11'), item('B', '99'), item('N', '7')] }
    ];
    const targets = new Map([['A', target('A', '11')], ['B', target('B', '55')], ['N', target('N', '')]]);
    const out = await C.cacheHintQueries(new Set(['A', 'B', 'N']), '쿠팡', targets);
    eq('A: 다른 옵션뿐인 검색어는 빠지고, 맞는 검색어·근거 없는 검색어는 남는다 (순서 유지)', out.get('A'), ['맞는옵션', '행없음']);
    check('B: 응답에 B 는 있지만 옵션(99)이 추적 옵션(55)과 달라 힌트가 없다', !out.has('B'));
    check('N: 추적 옵션을 모르는 대상은 옵션 게이트가 어차피 거절한다 → 힌트 없음', !out.has('N'));
    eq('[2] 캐시 행은 한 번에 묶어 읽는다 (검색어 3종 → 조회 1회)', db.reads.length, 1);
    eq('[2] 읽는 열은 keyword, items 뿐', db.reads[0] && db.reads[0].cols, 'keyword, items');
  }
  {
    // link 에만 vendorItemId 가 있는 옛 행도 _price.vendorIdOf 와 같은 규칙으로 읽는다.
    db.reads = []; db.hints = [['L', ['링크옵션']]];
    db.rows = [{ keyword: '링크옵션', items: [item('L', '44')] }];
    const out = await C.cacheHintQueries(new Set(['L']), '쿠팡',
      new Map([['L', target('L', '', 'https://link.coupang.com/re/AFFSDP?pageKey=L&itemId=1&vendorItemId=44')]]));
    eq('vendor_item_id 가 비어 있으면 link 의 vendorItemId 로 확인한다', out.get('L'), ['링크옵션']);
  }

  console.log('\n[3] 판단 근거가 없으면 걸러내지 않는다');
  {
    db.reads = []; db.failRead = true;
    db.hints = [['A', ['다른옵션뿐']]];
    const out = await C.cacheHintQueries(new Set(['A']), '쿠팡', new Map([['A', target('A', '11')]]));
    eq('캐시 조회 실패 → 예전처럼 그대로', out.get('A'), ['다른옵션뿐']);
    db.failRead = false;
  }
  {
    const hints = new Map([['A', ['x', 'y']]]);
    const out = await C.verifyHintOptions(hints, '쿠팡', new Map([['A', target('A', '11')]]), async () => []);
    eq('캐시 행이 이미 정리됨 → 그대로', out.get('A'), ['x', 'y']);
  }

  console.log('\n[4] 예전 동작 유지');
  {
    db.reads = []; db.hints = [['H', ['아무거나']]];
    const adpick = await C.cacheHintQueries(new Set(['H']), 'ADPICK', new Map([['H', { product_id: 'H', mall: 'ADPICK' }]]));
    eq('ADPICK 은 옵션 확인 없이 그대로', adpick.get('H'), ['아무거나']);
    db.hints = [['A', ['다른옵션뿐']]];
    db.rows = [{ keyword: '다른옵션뿐', items: [item('A', '22')] }];
    const legacy = await C.cacheHintQueries(new Set(['A']), '쿠팡');
    eq('대상 정보 없이 부르면(옛 호출부·테스트 스텁) 예전처럼 그대로', legacy.get('A'), ['다른옵션뿐']);
    eq('그때는 캐시 행을 읽지 않는다', db.reads.length, 0);
  }

  console.log('\n[5] runMallCollection → hint 함수에 대상 행을 넘긴다');
  {
    const rows = [{ product_id: 'P1', mall: '쿠팡', title: '상품 P1', keyword: '첫검색', link: '', image: '',
      vendor_item_id: '11', item_id: '' }];
    let seenArgs = null;
    const calls = [];
    await C.runMallCollection({
      mallName: '쿠팡', rows, savedState: null, deadlineTs: Date.now() + 8000,
      fetchAllFn: async kw => { calls.push(kw); return { ok: true, reason: '', items: [item('P1', '22')] }; },
      recordPricesFn: async () => ({ saved: 0, recorded: 0, recordedKeys: [], rejected: 0, suspect: 0 }),
      collectedTodayFn: async () => new Set(),
      cacheHintFn: async (...args) => { seenArgs = args; return new Map(); }
    });
    check('hint 함수가 불렸다 (1차에서 다른 옵션만 와서 미수집)', !!seenArgs, calls.join(' | '));
    const t = seenArgs && seenArgs[2] && seenArgs[2].get('P1');
    check('세 번째 인자: product_id → 대상 행, vendor_item_id 포함', !!t && t.vendor_item_id === '11',
      seenArgs && JSON.stringify([...seenArgs[2] || []]));
  }

  console.log('\n[6] 공급자가 더 부를 수 없다고 하면(하루 예산 소진) hint 패스와 캐시 확인 읽기를 하지 않는다');
  {
    // 운영 10-21: 쿠팡 3,400/3,400 소진 뒤에도 실행마다 513쌍 캐시 확인(≈4.7MB) → 전부 제외, API 0회.
    const rows = [{ product_id: 'P1', mall: '쿠팡', title: '상품 P1', keyword: '첫검색', link: '', image: '',
      vendor_item_id: '11', item_id: '' }];
    const runOnce = async stop => {
      let hintCalls = 0;
      await C.runMallCollection({
        mallName: '쿠팡', rows, savedState: null, deadlineTs: Date.now() + 8000,
        fetchAllFn: async () => ({ ok: true, reason: '', items: [item('P1', '22')] }),
        recordPricesFn: async () => ({ saved: 0, recorded: 0, recordedKeys: [], rejected: 0, suspect: 0 }),
        collectedTodayFn: async () => new Set(),
        cacheHintFn: async () => { hintCalls++; return new Map(); },
        laneGate: { stopReason: () => stop(), blockedUntilMs: () => 0 }
      });
      return hintCalls;
    };
    let callsSoFar = 0;
    // 1차 검색은 하게 두고(예산 남음), 회수 단계에 들어설 때 예산이 끝난 상황.
    const spent = await runOnce(() => (++callsSoFar > 1 ? 'budget' : ''));
    eq('★ 예산 소진 → hint 함수(캐시 확인 읽기 포함) 0회', spent, 0);
    const open = await runOnce(() => '');
    eq('예산이 남아 있으면 예전처럼 hint 를 찾는다', open, 1);
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
