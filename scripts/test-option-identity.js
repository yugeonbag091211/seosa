#!/usr/bin/env node
/*
 * 판매 단위(옵션) 정체성 회귀 테스트 — 쿠팡 호출 0회 / 운영 Supabase 접근 0회.
 *
 *   node scripts/test-option-identity.js
 *
 * ── 무엇을 지키는 테스트인가 ────────────────────────────────────────
 *
 * 2026-09-03 감사에서 확인된 것: 수집기가 검색 응답을 `productId` 하나로만
 * 대조하고 있었다. 쿠팡의 productId 는 "노출 상품" 이고 실제로 팔리는 단위는
 * 그 아래의 vendorItemId(옵션)인데, 응답 항목의 vendorItemId 를 우리 상품의
 * vendor_item_id 와 비교하는 곳이 어디에도 없었다. 게다가 api/_coupang.js 의
 * collapseOptions 가 같은 productId 를 **최저가 한 건으로 접어** 우리가
 * 추적하는 옵션이 매칭 전에 사라지기까지 했다.
 *
 * 그 결과 다른 옵션의 가격이 그 상품의 오늘 가격으로 기록됐다. 운영
 * price_history 실측: vid 이력이 있는 쿠팡 상품 1,876개 중 605개가 두 개
 * 이상의 vid 로 기록돼 있고, 그중 113개는 최저·최고 차이가 2배를 넘는다.
 *
 * 이 파일은 그 경로가 다시 열리면 깨진다. 세 층을 각각 고정한다.
 *
 *   A. pickOption          — 순수 판정 함수 (DB·네트워크 없음)
 *   B. recordPrices 방어막 — 쓰기 직전 OPTION_MISMATCH 게이트 (가짜 supabase)
 *   C. runMallCollection   — 수집기 전체 경로 (저장 훅으로 관측치를 가로챈다)
 *
 * ★ 운영 DB 에 절대 쓰지 않는다. C 는 recordPricesFn 에 no-write 훅을 넘기고,
 *   B 는 api/_supabase 를 require 캐시에서 가짜로 바꿔치기한다.
 */
'use strict';

const path = require('path');
const Module = require('module');

/* ------------------------------------------------------------------ *
 *  가짜 Supabase — api/_shop.js 가 실제로 쓰는 것만 흉내 낸다.
 *
 *    from(t).select(cols).in().lt().order().limit()  → await 가능
 *    from(t).upsert(rows, opts)                      → await 가능
 *
 *  select 는 항상 빈 결과를 준다(직전 관측 없음). 이 테스트가 보는 것은
 *  "무엇이 upsert 로 넘어갔는가" 하나뿐이라 그것으로 충분하다.
 * ------------------------------------------------------------------ */
const upserts = { products: [], price_history: [] };
function resetUpserts() { upserts.products = []; upserts.price_history = []; }

function makeQuery(table) {
  const q = {
    select: () => q, eq: () => q, in: () => q, lt: () => q, gte: () => q,
    order: () => q, limit: () => q, range: () => q,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (resolve) => resolve({ data: [], error: null }),
    upsert: (rows) => {
      const list = Array.isArray(rows) ? rows : [rows];
      upserts[table] = (upserts[table] || []).concat(list);
      return { then: (resolve) => resolve({ data: list, error: null }) };
    }
  };
  return q;
}
const fakeSupabase = { from: makeQuery, rpc: async () => ({ data: null, error: null }) };

const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

const { recordPrices } = require('../api/_shop');
const { pickOption, runMallCollection } = require('./collect-all-prices');

/* ------------------------------------------------------------------ */
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, got, want) {
  check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

/** 쿠팡 제휴 링크 — vendorItemId / itemId 는 여기서 파싱된다(_price.coupangItemIds). */
function link(pid, itemId, vid) {
  return `https://www.coupang.com/vp/products/${pid}?itemId=${itemId}&vendorItemId=${vid}`;
}
/** products 행 (수집기 타겟) */
function target(pid, itemId, vid, extra = {}) {
  return {
    product_id: String(pid), mall: '쿠팡', title: `상품 ${pid}`, keyword: `kw-${pid}`,
    link: link(pid, itemId, vid), image: '', item_id: String(itemId), vendor_item_id: String(vid),
    ...extra
  };
}
/** 검색 응답 항목 */
function item(pid, itemId, vid, price) {
  return {
    productId: String(pid), title: `상품 ${pid} 옵션 ${vid}`, lprice: price, oprice: price,
    link: link(pid, itemId, vid), image: '', mall: '쿠팡',
    itemId: String(itemId), vendorItemId: String(vid)
  };
}

/* ================================================================== *
 *  A. pickOption — 순수 판정
 * ================================================================== */
console.log('\n=== A. pickOption (순수 판정) ===\n');

/* Test 1 — 같은 productId, 타겟 vid A, 응답 vid B → 채택 금지 */
{
  const t = target('P1', 'I1', 'A');
  const r = pickOption(t, [item('P1', 'I1', 'B', 16500)]);
  eq('[T1] 응답 옵션이 다르면 채택하지 않는다', r.item, null);
  eq('[T1] 사유는 OPTION_MISMATCH', r.reason, 'OPTION_MISMATCH');
  eq('[T1] 우리가 원한 옵션을 사유에 남긴다', r.want, 'A');
  check('[T1] 응답에 있던 옵션도 남긴다', Array.isArray(r.got) && r.got[0] === 'B',
    JSON.stringify(r.got));
}

/* Test 2 — 같은 productId 에 옵션 A/B/C. 우리 타겟은 B → B만 채택.
 *          ★ A 가 최저가라도 A 를 고르면 안 된다. */
{
  const t = target('P2', 'I2', 'B');
  const items = [
    item('P2', 'I2', 'A', 5000),    // 최저가지만 우리 옵션이 아니다
    item('P2', 'I2', 'B', 9930),
    item('P2', 'I2', 'C', 16500)
  ];
  const r = pickOption(t, items);
  check('[T2] 다옵션 응답에서 우리 옵션을 고른다', !!r.item);
  eq('[T2] 고른 옵션의 vendorItemId = B', r.item && r.item.vendorItemId, 'B');
  eq('[T2] 고른 옵션의 가격 = 9930 (최저가 5000 이 아니다)', r.item && r.item.lprice, 9930);
  eq('[T2] 사유는 VID_EXACT', r.reason, 'VID_EXACT');
  eq('[T2] 후보 옵션 수를 센다', r.options, 3);
}

/* Test 3 — 응답에 vendorItemId 가 없다 → 채택 금지.
 *
 * ★ legacy 경로 확인: 운영 캐시 21,762 항목 전부 vendorItemId 를 갖고 있었고
 *   (0건 누락), products 쿠팡 1,554행도 전부 컬럼 또는 link 로 vid 를 얻는다.
 *   즉 "응답에 vid 가 없다" 는 정상 경로가 아니다. 대조할 수 없으면 저장하지
 *   않는 쪽이 맞다 — 다른 옵션일 수 있는 값을 오늘 가격으로 쓰면 안 된다. */
{
  const t = target('P3', 'I3', 'A');
  const noVid = { productId: 'P3', title: '옵션 정보 없음', lprice: 1000, oprice: 1000,
    link: 'https://www.coupang.com/vp/products/P3', image: '', mall: '쿠팡',
    itemId: '', vendorItemId: '' };
  const r = pickOption(t, [noVid]);
  eq('[T3] 응답에 vendorItemId 가 없으면 채택하지 않는다', r.item, null);
  eq('[T3] 사유는 RESPONSE_VID_MISSING', r.reason, 'RESPONSE_VID_MISSING');
}

/* Test 4 — productId·vendorItemId 는 같고 itemId 만 다르다 → 채택한다.
 *
 * ★ itemId 가 판매 단위의 필수 조건인지 먼저 확인했고, 아니었다.
 *   근거 셋:
 *     · UNIQUE 가 (product_id, mall, vendor_item_id[, recorded_date]) 다
 *       — supabase/2026-08-vendor-identity.sql:110,151. itemId 는 키가 아니다.
 *     · 운영 캐시 21,762 항목 실측에서 vid→itemId 는 사실상 1:1(예외 11건),
 *       itemId→vid 는 1:다(151건). vid 가 itemId 보다 세밀한 식별자다.
 *     · 그 예외 11건은 쿠팡이 **같은 옵션에 itemId 를 새로 발급한** 경우다
 *       (예: vendorItemId 90216930268 → itemId 28928096129 / 29077234874).
 *   itemId 를 필수로 걸면 이 11건을 근거 없이 거부하게 된다. */
{
  const t = target('P4', 'OLD_ITEM', 'V4');
  const r = pickOption(t, [item('P4', 'NEW_ITEM', 'V4', 30000)]);
  check('[T4] vid 가 같으면 itemId 가 달라도 채택한다', !!r.item);
  eq('[T4] 사유는 VID_EXACT', r.reason, 'VID_EXACT');
  eq('[T4] 응답의 itemId 를 그대로 들고 온다(이력 추적용)',
    r.item && r.item.itemId, 'NEW_ITEM');
}

/* Test 5 — productId·vendorItemId·itemId 전부 같다 → 정상 채택 */
{
  const t = target('P5', 'I5', 'V5');
  const r = pickOption(t, [item('P5', 'I5', 'V5', 12345)]);
  check('[T5] 전부 일치하면 채택한다', !!r.item);
  eq('[T5] 가격을 그대로 가져온다', r.item && r.item.lprice, 12345);
}

/* Test 6 — 실제 사고 사례(질레트 면도날) 고정.
 *
 * 2026-09-03 재연결 검증 중 실제로 일어난 일이다.
 *   우리가 추적하던 옵션  vendorItemId 91541903564 · 4개입  @9,930
 *   수집이 잡아온 옵션    vendorItemId 94056275142 · 8개입  @16,500
 * productId 는 9186729115 로 같았다. 그 값이 오늘 가격으로 기록됐고
 * (price_history id 43046) 발견 후 되돌렸다. 다시 열리면 안 되는 경로다. */
{
  const t = target('9186729115', '24762055022', '91541903564');
  const r = pickOption(t, [item('9186729115', '25000000000', '94056275142', 16500)]);
  eq('[T6] 질레트 사례 — 같은 productId 라도 다른 옵션은 거부한다', r.item, null);
  eq('[T6] 사유는 OPTION_MISMATCH', r.reason, 'OPTION_MISMATCH');
}

/* 부가 — vendorItemId 개념이 없는 몰(ADPICK)은 product_id 가 판매 단위다.
 * 운영 737행 전부 vid 가 없다. 여기에 게이트를 걸면 전멸한다. */
{
  const ad = { product_id: 'a'.repeat(64), mall: 'ADPICK', title: 'ADPICK 상품',
    keyword: 'kw', link: 'https://adpick.example/x', image: '',
    item_id: '', vendor_item_id: '' };
  const adItem = { productId: 'a'.repeat(64), title: 'ADPICK 상품', lprice: 5000,
    oprice: 5000, link: 'https://adpick.example/x', image: '', mall: 'ADPICK',
    itemId: '', vendorItemId: '' };
  const r = pickOption(ad, [adItem]);
  check('[부가] ADPICK 은 product_id 가 판매 단위 — 게이트를 적용하지 않는다', !!r.item);
  eq('[부가] 사유는 MALL_ID_IS_UNIT', r.reason, 'MALL_ID_IS_UNIT');
}

/* 부가 — productId 자체가 응답에 없으면 당연히 채택 금지 */
{
  const r = pickOption(target('P9', 'I9', 'V9'), [item('OTHER', 'I', 'V', 100)]);
  eq('[부가] 다른 상품만 있는 응답은 채택하지 않는다', r.reason, 'NO_PRODUCT_MATCH');
}

/* ================================================================== *
 *  B. recordPrices 저장 직전 방어막
 * ================================================================== */
console.log('\n=== B. recordPrices 저장 직전 방어막 (OPTION_MISMATCH) ===\n');

function obs(pid, vid, price, targetVid) {
  const o = {
    productId: pid, mall: '쿠팡', title: `상품 ${pid}`, keyword: 'kw', price,
    oprice: price, link: link(pid, 'I', vid), image: '',
    itemId: 'I', vendorItemId: vid
  };
  if (targetVid !== undefined) o.targetVendorItemId = targetVid;
  return o;
}

(async () => {
  /* B-1 — 타겟과 다른 옵션이 넘어오면 한 행도 쓰지 않는다 */
  resetUpserts();
  let r = await recordPrices([obs('B1', '94056275142', 16500, '91541903564')],
    { label: 'opt-guard/B1' });
  eq('[B1] price_history 에 0행', upserts.price_history.length, 0);
  eq('[B1] products 에 0행', upserts.products.length, 0);
  eq('[B1] optionMismatch 로 집계된다', r.optionMismatch, 1);
  eq('[B1] rejected(가격 이상) 과 섞지 않는다', r.rejected, 0);

  /* B-2 — 타겟과 같은 옵션이면 정상 저장된다 (방어막이 정상 경로를 막지 않는다) */
  resetUpserts();
  r = await recordPrices([obs('B2', '91541903564', 9930, '91541903564')],
    { label: 'opt-guard/B2' });
  eq('[B2] price_history 에 1행', upserts.price_history.length, 1);
  eq('[B2] 저장된 vendor_item_id 가 타겟과 같다',
    upserts.price_history[0] && upserts.price_history[0].vendor_item_id, '91541903564');
  eq('[B2] optionMismatch 0', r.optionMismatch, 0);

  /* B-3 — targetVendorItemId 를 안 넘기는 호출부(검색 API 등)는 영향 없다 */
  resetUpserts();
  r = await recordPrices([obs('B3', '111', 5000)], { label: 'opt-guard/B3' });
  eq('[B3] 기준이 없으면 방어막은 작동하지 않는다 (기존 호출부 호환)',
    upserts.price_history.length, 1);
  eq('[B3] optionMismatch 0', r.optionMismatch, 0);

  /* B-4 — 타겟은 있는데 응답 vid 를 못 구하면 저장하지 않는다 */
  resetUpserts();
  const noVid = { productId: 'B4', mall: '쿠팡', title: '옵션 없음', keyword: 'kw',
    price: 1000, oprice: 1000, link: 'https://www.coupang.com/vp/products/B4',
    image: '', itemId: '', vendorItemId: '', targetVendorItemId: '91541903564' };
  r = await recordPrices([noVid], { label: 'opt-guard/B4' });
  eq('[B4] 응답 옵션을 확인할 수 없으면 저장하지 않는다', upserts.price_history.length, 0);
  eq('[B4] optionMismatch 로 집계', r.optionMismatch, 1);

  /* ================================================================ *
   *  C. runMallCollection 전체 경로
   * ================================================================ */
  console.log('\n=== C. runMallCollection 전체 경로 ===\n');

  /* C 단계는 저장 훅으로만 관측치를 받는다 — 여기서부터 upsert 는 0 이어야 한다. */
  resetUpserts();

  const NO_HINT = async () => new Map();
  /** 저장 훅 — 운영 DB 에 쓰지 않고 관측치만 가로챈다. */
  function captureHook(bucket) {
    return async (observations) => {
      bucket.push(...observations);
      return {
        saved: observations.length, recorded: observations.length,
        recordedKeys: [...new Set(observations.map(o => `${o.productId}|${o.mall}`))],
        rejected: 0, suspect: 0, optionMismatch: 0, errors: []
      };
    };
  }

  /* C-1 — 다옵션 응답. 타겟은 B, 응답은 A(최저가)/B/C.
   *        collapseOptions 를 흉내 내어 items 에는 최저가 A 만 남기고,
   *        allItems 에 세 옵션을 전부 담는다 — 실제 searchCoupang 과 같은 모양이다. */
  {
    const rows = [target('C1', 'I', 'B')];
    const all = [
      item('C1', 'I', 'A', 5000),
      item('C1', 'I', 'B', 9930),
      item('C1', 'I', 'C', 16500)
    ];
    const captured = [];
    const res = await runMallCollection({
      mallName: '쿠팡', rows, savedState: null, deadlineTs: Date.now() + 5000,
      recordPricesFn: captureHook(captured), cacheHintFn: NO_HINT,
      // collapseOptions 는 최저가 한 건만 남긴다 — 우리 옵션 B 는 items 에 없다.
      fetchAllFn: async () => ({ ok: true, reason: '', items: [all[0]], allItems: all })
    });
    eq('[C1] 관측치 1건', captured.length, 1);
    eq('[C1] ★ 접힌 items(최저가 A) 가 아니라 우리 옵션 B 를 채택한다',
      captured[0] && captured[0].vendorItemId, 'B');
    eq('[C1] 가격도 B 의 것이다', captured[0] && captured[0].price, 9930);
    eq('[C1] 방어막용 타겟 옵션이 관측치에 실린다',
      captured[0] && captured[0].targetVendorItemId, 'B');
    eq('[C1] 수집 성공 상품 1개', res.collectorSuccessProducts, 1);
  }

  /* C-2 — 응답에 우리 옵션이 아예 없다 → 한 건도 저장 경로로 넘어가지 않는다 */
  {
    const rows = [target('C2', 'I', 'MINE')];
    const all = [item('C2', 'I', 'OTHER', 16500)];
    const captured = [];
    const res = await runMallCollection({
      mallName: '쿠팡', rows, savedState: null, deadlineTs: Date.now() + 5000,
      recordPricesFn: captureHook(captured), cacheHintFn: NO_HINT,
      fetchAllFn: async () => ({ ok: true, reason: '', items: all, allItems: all })
    });
    eq('[C2] ★ 저장 경로에 0건 — 다른 옵션 가격을 대신 쓰지 않는다', captured.length, 0);
    eq('[C2] 수집 성공 상품 0개', res.collectorSuccessProducts, 0);
    /* 1차 패스와 회수 패스가 각각 시도했다가 각각 거부한다 — 거부는 호출 단위로 센다. */
    check('[C2] 거부 사유가 OPTION_MISMATCH 로 남는다',
      res.optionRejects && res.optionRejects.OPTION_MISMATCH >= 1,
      JSON.stringify(res.optionRejects));
    check('[C2] 미수집으로 남는다 (성공률을 부풀리지 않는다)',
      res.uncoveredProducts === 1, `uncoveredProducts=${res.uncoveredProducts}`);
  }

  /* C-3 — 교차 매칭(absorbCrossMatches)에도 같은 게이트가 걸린다.
   *        C3B 는 자기 검색어가 없고, C3A 의 응답에 섞여 들어온다. */
  {
    const rows = [target('C3A', 'I', 'VA'), target('C3B', 'I', 'MINE')];
    const all = [
      item('C3A', 'I', 'VA', 1000),
      item('C3B', 'I', 'OTHER', 2000)     // 우리 옵션이 아니다
    ];
    const captured = [];
    await runMallCollection({
      mallName: '쿠팡', rows, savedState: null, deadlineTs: Date.now() + 5000,
      recordPricesFn: captureHook(captured), cacheHintFn: NO_HINT,
      fetchAllFn: async (kw) => (String(kw) === 'kw-C3A'
        ? { ok: true, reason: '', items: all, allItems: all }
        : { ok: false, items: [], reason: '없음' })
    });
    const ids = captured.map(o => o.productId).sort();
    check('[C3] 교차 매칭도 옵션을 확인한다 — C3A 만 채택',
      ids.length === 1 && ids[0] === 'C3A', JSON.stringify(ids));
  }

  /* C-4 — ADPICK 은 게이트 없이 그대로 수집된다 (회귀 방지) */
  {
    const pid = 'b'.repeat(64);
    const rows = [{ product_id: pid, mall: 'ADPICK', title: 'ADPICK 상품', keyword: 'kw-ad',
      link: 'https://adpick.example/y', image: '', item_id: '', vendor_item_id: '' }];
    const it = { productId: pid, title: 'ADPICK 상품', lprice: 7000, oprice: 7000,
      link: 'https://adpick.example/y', image: '', mall: 'ADPICK', itemId: '', vendorItemId: '' };
    const captured = [];
    const res = await runMallCollection({
      mallName: 'ADPICK', rows, savedState: null, deadlineTs: Date.now() + 5000,
      recordPricesFn: captureHook(captured), cacheHintFn: NO_HINT,
      fetchAllFn: async () => ({ ok: true, reason: '', items: [it] })
    });
    eq('[C4] ADPICK 은 그대로 수집된다', captured.length, 1);
    eq('[C4] 수집 성공 상품 1개', res.collectorSuccessProducts, 1);
  }

  /* C-5 — 운영 DB 쓰기가 한 번도 없었다 (가짜 supabase 의 upsert 기록으로 확인).
   *        C 단계는 전부 capture 훅을 썼으므로 upsert 가 늘면 안 된다. */
  {
    const total = upserts.price_history.length + upserts.products.length;
    eq('[C5] ★ C 단계에서 저장 경로 upsert 0회', total, 0);
  }

  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('테스트 실행 오류:', e.message, e.stack);
  process.exit(1);
});
