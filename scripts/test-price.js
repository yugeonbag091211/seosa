#!/usr/bin/env node
/*
 * 가격 정확도 회귀 테스트 — 쿠팡 호출 0회 / 운영 Supabase 접근 0회.
 *
 *   node scripts/test-price.js
 *
 * 무엇을 지키는 테스트인가
 *   2026-08-09 감사에서 "SEOSA 75,000원 / 쿠팡 39,900원"의 원인이
 *   ① 일일 수집기가 products 를 갱신하지 않음
 *   ② 저장 단계에 가격 검증이 없음
 *   ③ 같은 product_id 에 옵션이 섞여 들어옴
 *   ④ 다시 수집되지 않는 몰의 옛 가격이 현재가로 노출됨
 *   이었다. 아래 테스트는 그 네 가지가 다시 생기면 깨진다.
 *
 * Supabase 는 require 캐시에 가짜 클라이언트를 심어 대체한다. 실제 DB 에
 * 붙지 않으므로 CI 에서도 환경변수 없이 돌아간다.
 */
'use strict';

const path = require('path');
const Module = require('module');

/* ------------------------------------------------------------------ *
 *  가짜 Supabase
 *
 *  api/_shop.js 가 쓰는 것만 흉내 낸다.
 *    from(t).select(...).in(...).lt(...).order(...).limit(...)  → await 가능
 *    from(t).upsert(rows, opts)                                 → await 가능
 * ------------------------------------------------------------------ */
const db = {
  price_history: [],   // {product_id, mall, price, recorded_date, recorded_at}
  products: [],        // {product_id, mall, vendor_item_id, ...}
  alerts: [],          // {id, email, title, mall, product_id, target_price, sent}
  upserts: { products: [], price_history: [] },
  updates: [],         // {table, patch, eq}
  /** products 에 vendor_item_id 컬럼이 없는 환경을 흉내 낼 때 true */
  noItemIdColumns: false
};

function reset() {
  db.price_history = [];
  db.products = [];
  db.alerts = [];
  db.upserts = { products: [], price_history: [] };
  db.updates = [];
  db.noItemIdColumns = false;
}

/** Postgres 처럼 정렬·자르기까지 흉내 낸다. 안 그러면 .order().limit(1) 검증이 무의미해진다. */
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function makeQuery(table) {
  const filters = { in: null, lt: null, gte: [], eq: [] };
  let sort = null;
  let cap = null;
  let rangeFrom = null;
  let rangeTo = null;
  const q = {
    select() { return q; },
    order(col, opts) { sort = { col, asc: !opts || opts.ascending !== false }; return q; },
    limit(n) { cap = n; return q; },
    in(col, vals) { filters.in = { col, vals: vals.map(String) }; return q; },
    lt(col, v) { filters.lt = { col, v }; return q; },
    gte(col, v) { filters.gte.push({ col, v }); return q; },
    eq(col, v) { filters.eq.push({ col, v }); return q; },
    range(from, to) { rangeFrom = from; rangeTo = to; return q; },
    then(resolve, reject) {
      let rows = db[table] || [];
      if (filters.in) rows = rows.filter(r => filters.in.vals.indexOf(String(r[filters.in.col])) > -1);
      if (filters.lt) rows = rows.filter(r => String(r[filters.lt.col]) < String(filters.lt.v));
      filters.gte.forEach(f => { rows = rows.filter(r => cmp(r[f.col], f.v) >= 0); });
      filters.eq.forEach(f => { rows = rows.filter(r => String(r[f.col]) === String(f.v)); });
      if (sort) {
        rows = rows.slice().sort((a, b) => (sort.asc ? 1 : -1) * cmp(a[sort.col], b[sort.col]));
      }
      if (cap !== null) rows = rows.slice(0, cap);
      if (rangeFrom !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
      if (table === 'products' && db.noItemIdColumns) {
        return Promise.resolve({
          data: null,
          error: { message: `column products.vendor_item_id does not exist` }
        }).then(resolve, reject);
      }
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
  };
  return q;
}

const fakeSupabase = {
  from(table) {
    return Object.assign(makeQuery(table), {
      update(patch) {
        const eqs = [];
        const u = {
          eq(col, v) {
            eqs.push({ col, v });
            db.updates.push({ table, patch, eq: eqs.slice() });
            (db[table] || []).forEach(r => {
              if (eqs.every(f => String(r[f.col]) === String(f.v))) Object.assign(r, patch);
            });
            return Promise.resolve({ data: null, error: null });
          }
        };
        return u;
      },
      upsert(rows, opts) {
        const list = Array.isArray(rows) ? rows : [rows];
        if (table === 'products' && db.noItemIdColumns
            && list.some(r => 'vendor_item_id' in r)) {
          return Promise.resolve({
            data: null,
            error: { message: 'column products.vendor_item_id does not exist' }
          });
        }
        db.upserts[table].push(...list);
        // 실제 upsert 와 같게 메모리 테이블에도 반영해 둔다.
        list.forEach(r => {
          const key = table === 'price_history'
            ? ['product_id', 'mall', 'recorded_date']
            : ['product_id', 'mall'];
          const idx = (db[table] || []).findIndex(x => key.every(k => String(x[k]) === String(r[k])));
          if (idx > -1) db[table][idx] = { ...db[table][idx], ...r };
          else db[table].push({ ...r });
        });
        void opts;
        return Promise.resolve({ data: list, error: null });
      }
    });
  },
  rpc() { return Promise.resolve({ data: null, error: null }); }
};

// api/_supabase 를 가짜로 바꿔치기 — _shop.js 가 require 하기 전에 해야 한다.
const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

/*
 * api/_notify 도 가로챈다 — 이 테스트는 메일을 보내는 코드를 직접 부르지
 * 않지만, 나중에 부르는 경로가 생겨도 실제 발송이 나가면 안 된다.
 * (알림 발송 자체의 검증은 이 파일의 범위가 아니다 — check-alerts.js 쪽이다)
 */
const notifyPath = require.resolve(path.join(__dirname, '..', 'api', '_notify.js'));
require.cache[notifyPath] = new Module(notifyPath, null);
require.cache[notifyPath].filename = notifyPath;
require.cache[notifyPath].loaded = true;
require.cache[notifyPath].exports = {
  send() { return Promise.resolve({ ok: true }); }
};

const {
  recordPrices, freshRows, saveProducts, searchPhraseFromTitle, isRecordableSource
} = require('../api/_shop');
const {
  parsePrice, isSanePrice, classifyPrice, coupangItemIds, isRefreshableMall,
  vendorIdOf, itemIdOf, productLifecycle, isDisplayable, LIFECYCLE,
  plausibleDrop, MAX_PLAUSIBLE_DROP_PCT
} = require('../api/_price');

/* ------------------------------------------------------------------ *
 *  테스트 유틸
 * ------------------------------------------------------------------ */
let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function section(name) { console.log(`\n${name}`); }

const TODAY = new Date().toISOString().slice(0, 10);
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

/** price_history 에 과거 관측을 심는다. */
function seedHistory(productId, mall, price, dayOffset) {
  db.price_history.push({
    product_id: productId, mall, title: 't', price,
    recorded_date: daysAgo(dayOffset), recorded_at: isoDaysAgo(dayOffset)
  });
}

function obs(productId, price, extra) {
  return Object.assign({
    productId, mall: '쿠팡', keyword: '테스트', title: '테스트 상품',
    price, oprice: 0, link: 'https://link.coupang.com/re/AFFSDP?pageKey=' + productId,
    image: '', itemId: '', vendorItemId: ''
  }, extra || {});
}

/** 이번 실행에서 products 에 반영된 현재가. 없으면 null. */
function currentPrice(productId) {
  const row = db.upserts.products.filter(r => String(r.product_id) === String(productId)).pop();
  return row ? row.lprice : null;
}
/** 이번 실행에서 price_history 에 기록된 가격. 없으면 null. */
function recordedPrice(productId) {
  const row = db.upserts.price_history.filter(r => String(r.product_id) === String(productId)).pop();
  return row ? row.price : null;
}

/* ================================================================== *
 *  0. 파싱
 * ================================================================== */
(async () => {
  section('0. 가격 파싱 (문자열 / 쉼표 / 원화 / 비정상 값)');
  check(parsePrice(30000) === 30000, '숫자 30000');
  check(parsePrice('30,000') === 30000, '쉼표 문자열 "30,000"');
  check(parsePrice('30,000원') === 30000, '원화 표기 "30,000원"');
  check(parsePrice('₩ 30,000') === 30000, '통화 기호 "₩ 30,000"');
  check(parsePrice('29900') === 29900, '숫자 문자열 "29900"');
  check(parsePrice(0) === null, '0 → null (0원 상품과 파싱 실패를 구분)');
  check(parsePrice(-5000) === null, '음수 → null');
  check(parsePrice(undefined) === null, 'undefined → null');
  check(parsePrice(null) === null, 'null → null');
  check(parsePrice(NaN) === null, 'NaN → null');
  check(parsePrice(Infinity) === null, 'Infinity → null');
  check(parsePrice('무료') === null, '숫자 없는 문자열 → null');
  check(parsePrice(200000000) === null, '2억원 → null (상한 초과)');
  check(parsePrice('30000.7') === 30001, '소수점 반올림');

  section('0-b. 쿠팡 링크에서 판매 단위 식별자 추출');
  const ids = coupangItemIds(
    'https://link.coupang.com/re/AFFSDP?lptag=AF1&pageKey=9389891009&itemId=27883665963&vendorItemId=95693783961&traceid=x');
  check(ids.itemId === '27883665963', 'itemId 추출', ids.itemId);
  check(ids.vendorItemId === '95693783961', 'vendorItemId 추출', ids.vendorItemId);
  check(coupangItemIds('').itemId === '', '빈 링크 → 빈 문자열');

  section('0-c. 다시 수집 가능한 몰인가');
  check(isRefreshableMall('쿠팡') === true, '쿠팡 → true');
  check(isRefreshableMall('네이버') === false, '네이버 → false (연동 제거됨)');
  check(isRefreshableMall('네이버쇼핑') === false, '네이버쇼핑 → false');

  section('0-d. isSanePrice — 저장해도 되는 값인가');
  check(isSanePrice(30000) === true, '정수 30,000 → true');
  check(isSanePrice(0) === false, '0 → false');
  check(isSanePrice(-1) === false, '음수 → false');
  check(isSanePrice(30000.5) === false, '소수는 원 단위가 아니다 → false');
  check(isSanePrice(100000001) === false, '1억 초과 → false (파싱 사고로 본다)');
  check(isSanePrice(null) === false, 'null → false');
  check(isSanePrice('30000') === false, '문자열은 parsePrice 를 먼저 거쳐야 한다 → false');

  section('0-e. isDisplayable — 현재가로 보여줘도 되는가');
  check(isDisplayable({ product_id: '1', mall: '쿠팡', lprice: 30000, collected_at: isoDaysAgo(0) }) === true,
        '오늘 확인한 쿠팡 행 → 노출 가능');
  check(isDisplayable({ product_id: '1', mall: '쿠팡', lprice: 30000, collected_at: isoDaysAgo(30) }) === false,
        '30일 전 확인 → 노출 불가');
  check(isDisplayable({ product_id: '1', mall: '네이버', lprice: 30000, collected_at: isoDaysAgo(0) }) === false,
        '오늘 확인했어도 재수집 불가 몰이면 노출 불가');

  /* ================================================================ *
   *  요청받은 시나리오 7개
   * ================================================================ */

  // ── Test 1: 정상 가격 30,000 → 30,000 ───────────────────────────
  section('Test 1. 정상 가격 30,000 → 30,000 (그대로 저장)');
  reset();
  seedHistory('1001', '쿠팡', 30000, 1);
  let r = await recordPrices([obs('1001', 30000)], { label: 't1' });
  check(r.rejected === 0 && r.suspect === 0, '거부·보류 없음', JSON.stringify(r));
  check(recordedPrice('1001') === 30000, 'price_history = 30,000', String(recordedPrice('1001')));
  check(currentPrice('1001') === 30000, 'products 현재가 = 30,000', String(currentPrice('1001')));

  // ── Test 2: 대폭 할인 75,000 → 30,000 ───────────────────────────
  section('Test 2. 대폭 할인 75,000 → 30,000 (정상 변동이므로 저장돼야 함)');
  reset();
  seedHistory('1002', '쿠팡', 75000, 1);
  r = await recordPrices([obs('1002', 30000)], { label: 't2' });
  check(r.rejected === 0, '거부되지 않음');
  check(r.suspect === 0, '보류되지 않음 (2.5배는 정상 할인 범위)');
  check(recordedPrice('1002') === 30000, 'price_history = 30,000');
  check(currentPrice('1002') === 30000, 'products 현재가 = 30,000', String(currentPrice('1002')));

  // ── Test 3: 가격 0 ──────────────────────────────────────────────
  section('Test 3. 가격 0 → 저장하지 않음');
  reset();
  seedHistory('1003', '쿠팡', 30000, 1);
  r = await recordPrices([obs('1003', 0)], { label: 't3' });
  check(r.rejected === 1, '거부 1건', JSON.stringify(r));
  check(recordedPrice('1003') === null, 'price_history 에 쓰지 않음');
  check(currentPrice('1003') === null, 'products 에 쓰지 않음');
  check(db.upserts.price_history.length === 0 && db.upserts.products.length === 0,
        '어떤 테이블에도 행이 나가지 않음');

  // ── Test 4: undefined / null ────────────────────────────────────
  section('Test 4. 가격 undefined / null / 문자열 파싱 실패 → 저장하지 않음');
  reset();
  seedHistory('1004', '쿠팡', 30000, 1);
  r = await recordPrices([
    obs('1004', undefined),
    obs('1005', null),
    obs('1006', '가격문의'),
    obs('1007', -1)
  ], { label: 't4' });
  check(r.rejected === 4, '4건 모두 거부', JSON.stringify(r));
  check(db.upserts.price_history.length === 0, 'price_history 0행');
  check(db.upserts.products.length === 0, 'products 0행');

  // ── Test 5: 다른 상품의 가격이 섞이는 상황 ──────────────────────
  section('Test 5. 다른 상품 가격 혼입 (34,500 → 1,528,000) → 현재가로 승격하지 않음');
  // 실제로 있었던 사건: product_id 9579684471 (노트북 보호필름) 의 가격이
  // 2026-07-30 에 1,528,000 원(= 노트북 본체 값)으로 기록됐다.
  reset();
  seedHistory('9579684471', '쿠팡', 34500, 1);
  db.products.push({ product_id: '9579684471', mall: '쿠팡', vendor_item_id: '111' });
  r = await recordPrices([obs('9579684471', 1528000)], { label: 't5' });
  check(r.suspect === 1, '보류 1건', JSON.stringify(r));
  check(currentPrice('9579684471') === null, 'products 현재가는 34,500 그대로 (승격 안 함)');
  check(recordedPrice('9579684471') === 1528000,
        'price_history 에는 관측 사실을 남김 (다음 관측에서 확인 가능하도록)');

  section('Test 5-b. 옵션이 바뀌면서 가격이 튀는 경우 (vendorItemId 변경)');
  // 같은 product_id 인데 "블루 그레이-GY" → "펄 화이트-WT" 처럼 옵션이 바뀌면
  // 2배만 벌어져도 같은 상품의 가격 변동으로 볼 수 없다.
  reset();
  seedHistory('9536222150', '쿠팡', 100000, 1);
  db.products.push({ product_id: '9536222150', mall: '쿠팡', vendor_item_id: 'AAA' });
  r = await recordPrices([obs('9536222150', 40000, { vendorItemId: 'BBB' })], { label: 't5b' });
  check(r.suspect === 1, '옵션 교체 + 2.5배 변동 → 보류', JSON.stringify(r));
  check(currentPrice('9536222150') === null, 'products 현재가를 덮어쓰지 않음');

  section('Test 5-c. 같은 옵션이면 2.5배 변동은 정상 할인으로 통과');
  reset();
  seedHistory('9536222150', '쿠팡', 100000, 1);
  db.products.push({ product_id: '9536222150', mall: '쿠팡', vendor_item_id: 'AAA' });
  r = await recordPrices([obs('9536222150', 40000, { vendorItemId: 'AAA' })], { label: 't5c' });
  check(r.suspect === 0, '보류되지 않음');
  check(currentPrice('9536222150') === 40000, 'products 현재가 = 40,000');

  section('Test 5-d. 보류된 값이 다음 수집에서 다시 나오면 현재가로 승격');
  // 오염값은 왔다 갔다 하지만, 진짜 가격 변동은 다음 날에도 같은 값이 나온다.
  // 그때는 직전 관측이 이미 그 값이라 비율이 1 이 되어 통과한다.
  reset();
  seedHistory('9579684471', '쿠팡', 34500, 2);
  seedHistory('9579684471', '쿠팡', 1528000, 1);   // 어제 보류되며 기록된 관측
  r = await recordPrices([obs('9579684471', 1528000)], { label: 't5d' });
  check(r.suspect === 0, '두 번째 관측은 보류되지 않음', JSON.stringify(r));
  check(currentPrice('9579684471') === 1528000, '이제 현재가로 승격됨');

  section('Test 5-f. 한 배치에 같은 product_id 가 여러 옵션으로 오면 최저가가 남는다');
  reset();
  r = await recordPrices([
    obs('7001', 109000),
    obs('7001', 75000),
    obs('7001', 39900)   // 쿠팡 상품 페이지가 보여주는 값
  ], { label: 't5f' });
  check(db.upserts.products.length === 1, '한 행으로 접힘', String(db.upserts.products.length));
  check(currentPrice('7001') === 39900, '최저가 39,900 이 현재가', String(currentPrice('7001')));
  check(recordedPrice('7001') === 39900, 'price_history 도 39,900');

  section('Test 5-g. 순서가 반대여도 결과가 같다 (마지막 승자 방식이 아님)');
  reset();
  r = await recordPrices([obs('7002', 39900), obs('7002', 75000)], { label: 't5g' });
  check(currentPrice('7002') === 39900, '순서 무관하게 39,900', String(currentPrice('7002')));

  section('Test 5-e. product_id 없는 항목은 상품명을 키로 저장하지 않는다');
  reset();
  r = await recordPrices([{ productId: '', mall: '쿠팡', title: '이름만 있는 상품', price: 1000 }],
                         { label: 't5e' });
  check(db.upserts.products.length === 0 && db.upserts.price_history.length === 0,
        '식별자 없으면 아무 것도 저장하지 않음', JSON.stringify(r));

  // ── Test 6: 최신 가격이 DB 현재가를 갱신 ────────────────────────
  section('Test 6. 75,000 → 30,000 이 들어오면 DB 현재가가 30,000 이 되어야 함');
  reset();
  db.products.push({ product_id: '2001', mall: '쿠팡', lprice: 75000, vendor_item_id: '' });
  seedHistory('2001', '쿠팡', 75000, 1);
  r = await recordPrices([obs('2001', 30000)], { label: 't6' });
  const row6 = db.upserts.products.find(x => x.product_id === '2001');
  check(!!row6, 'products upsert 발생');
  check(row6 && row6.lprice === 30000, 'products.lprice = 30,000', row6 && String(row6.lprice));
  check(!!(row6 && row6.collected_at), 'collected_at 을 함께 갱신 (수집 기준일 표기가 사실이 되도록)');
  check(db.products.find(x => x.product_id === '2001').lprice === 30000,
        '반영 후 조회해도 30,000');

  section('Test 6-b. 오래된 관측(30일 전)과는 급변을 비교하지 않는다');
  reset();
  seedHistory('2002', '쿠팡', 500000, 30);
  r = await recordPrices([obs('2002', 30000)], { label: 't6b' });
  check(r.suspect === 0, '21일 창 밖이면 보류하지 않음', JSON.stringify(r));
  check(currentPrice('2002') === 30000, '현재가 = 30,000');

  section('Test 6-c. 하루에 두 번 저장해도 두 번째가 첫 번째를 검증 통과 통로로 쓰지 못한다');
  reset();
  seedHistory('2003', '쿠팡', 30000, 1);
  await recordPrices([obs('2003', 900000)], { label: 't6c-1' });   // 30배 → 보류
  db.upserts = { products: [], price_history: [] };
  r = await recordPrices([obs('2003', 900000)], { label: 't6c-2' });
  check(r.suspect === 1, '같은 날 두 번째 시도도 보류 (직전 관측은 어제 값이어야 함)', JSON.stringify(r));
  check(currentPrice('2003') === null, '현재가로 승격되지 않음');

  // ── Test 7: price_history 최신 정상 가격 조회 ───────────────────
  section('Test 7. price_history — 가장 최신 정상 가격이 조회되어야 함');
  // api/history.js 와 api/history-batch.js 가 쓰는 접기 규칙을 그대로 검증한다.
  // (내림차순으로 가져와 자른 뒤 날짜 오름차순으로 되돌리는 부분)
  const { collapse } = loadHistoryCollapse();
  const rows = [
    { recorded_date: '2026-08-08', price: 30000 },
    { recorded_date: '2026-08-07', price: 41000 },
    { recorded_date: '2026-08-07', price: 39000 },   // 같은 날 두 행 → 최저가
    { recorded_date: '2026-08-06', price: 75000 }
  ];
  const pts = collapse(rows, 365);
  check(pts.length === 3, '날짜당 한 점으로 접힘', JSON.stringify(pts));
  check(pts[0].date === '2026-08-06' && pts[pts.length - 1].date === '2026-08-08',
        '오름차순 정렬 (마지막이 최신)', pts.map(p => p.date).join(','));
  check(pts[pts.length - 1].price === 30000, '가장 최근 가격 = 30,000', String(pts[pts.length - 1].price));
  check(pts[1].price === 39000, '같은 날 여러 행은 최저가 한 점');

  section('Test 7-b. 저장 직후 price_history 의 최신 값이 products 현재가와 일치');
  reset();
  seedHistory('3001', '쿠팡', 75000, 1);
  await recordPrices([obs('3001', 30000)], { label: 't7b' });
  const hist = db.price_history.filter(x => x.product_id === '3001')
    .sort((a, b) => a.recorded_date.localeCompare(b.recorded_date));
  const latest = hist[hist.length - 1];
  check(latest.recorded_date === TODAY, '최신 기록이 오늘 날짜', latest.recorded_date);
  check(latest.price === currentPrice('3001'),
        '현재 가격 = 가장 최근 정상 수집 가격', `${latest.price} / ${currentPrice('3001')}`);

  /* ================================================================ *
   *  /api/history — 상품명 폴백은 productId 를 안 보낸 경우에만
   * ================================================================ */
  section('이력. 이름만 같은 다른 상품의 가격을 가져오지 않는다');
  reset();
  // 같은 이름의 서로 다른 상품 두 개. 하나는 기록이 있고, 하나는 없다.
  db.price_history.push(
    { product_id: '8001', mall: '쿠팡', title: '무선 이어폰', price: 990000, recorded_date: daysAgo(1), recorded_at: isoDaysAgo(1) },
    { product_id: '8001', mall: '쿠팡', title: '무선 이어폰', price: 980000, recorded_date: daysAgo(2), recorded_at: isoDaysAgo(2) }
  );

  const history = require('../api/history.js');
  const callHistory = async query => {
    const res = {
      code: 200, payload: null, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(b) { this.payload = b; return this; },
      end() { return this; }
    };
    await history({ method: 'GET', headers: {}, query, socket: { remoteAddress: '9.9.9.' + Math.floor(Math.random() * 250) } }, res);
    return res;
  };

  // 기록이 없는 다른 상품(8002)을 productId 로 조회 → 8001 의 99만원 곡선이 붙으면 안 된다.
  let hres = await callHistory({ title: '무선 이어폰', productId: '8002', mall: '쿠팡' });
  check(hres.code === 200, 'HTTP 200', String(hres.code));
  check(Array.isArray(hres.payload) && hres.payload.length === 0,
        'productId 로 조회해 기록이 없으면 빈 배열 (이름으로 추측하지 않음)',
        JSON.stringify(hres.payload));

  // 기록이 있는 상품은 정상 조회된다 (기능이 죽지 않았는지)
  hres = await callHistory({ title: '무선 이어폰', productId: '8001', mall: '쿠팡' });
  check(hres.payload.length === 2, 'productId 로 조회하면 자기 기록은 나온다', JSON.stringify(hres.payload));
  check(hres.payload[hres.payload.length - 1].price === 990000, '마지막 점이 최신 가격');

  /*
   * productId 가 없는 옛 항목도 상품명으로 찾지 않는다.
   *
   * 상품명으로 모은 이력은 이름이 같은 여러 상품의 기록이 날짜별 최저가로
   * 합쳐진 값이라 어느 상품의 것도 아니다. 그 마지막 점이 가격 모달의
   * 헤드라인 가격이 되므로, 모르면 모른다고 답해야 한다.
   */
  hres = await callHistory({ title: '무선 이어폰' });
  check(Array.isArray(hres.payload) && hres.payload.length === 0,
        'productId 없으면 상품명으로 찾지 않고 빈 배열', JSON.stringify(hres.payload));
  check(hres.code === 200, '오류가 아니라 200 + 빈 배열 (차트가 조용히 비도록)', String(hres.code));

  section('이력. /api/history-batch 는 titles 를 받아도 이력을 주지 않는다');
  // 배포 직후 옛 index.html 을 캐시한 브라우저가 여전히 titles 를 보낸다.
  reset();
  db.price_history.push(
    { product_id: '8001', mall: '쿠팡', title: '무선 이어폰', price: 990000, recorded_date: daysAgo(1), recorded_at: isoDaysAgo(1) }
  );
  const batch = require('../api/history-batch.js');
  const bres = {
    code: 200, payload: null, setHeader() {}, status(c) { this.code = c; return this; },
    json(b) { this.payload = b; return this; }, end() { return this; }
  };
  await batch({
    method: 'GET', headers: {},
    query: { titles: JSON.stringify(['무선 이어폰']), keys: JSON.stringify([]) },
    socket: { remoteAddress: '9.9.8.7' }
  }, bres);
  check(bres.code === 200, 'HTTP 200', String(bres.code));
  check(Array.isArray(bres.payload['무선 이어폰']) && bres.payload['무선 이어폰'].length === 0,
        '옛 클라이언트가 titles 를 보내도 빈 배열 (키는 유지)', JSON.stringify(bres.payload));

  /* ================================================================ *
   *  P1-a 데이터 품질 — 라이프사이클 분류 + 식별자 링크 폴백
   * ================================================================ */
  const COUPANG_LINK = 'https://link.coupang.com/re/AFFSDP?pageKey=1&itemId=27883665963&vendorItemId=95693783961';

  section('품질. vendor_item_id 컬럼이 비어도 link 에서 식별자를 뽑는다');
  check(vendorIdOf({ vendor_item_id: '', link: COUPANG_LINK }) === '95693783961',
        '컬럼 비었으면 link 폴백', vendorIdOf({ vendor_item_id: '', link: COUPANG_LINK }));
  check(itemIdOf({ item_id: '', link: COUPANG_LINK }) === '27883665963', 'itemId 도 link 폴백');
  check(vendorIdOf({ vendor_item_id: 'COLUMN', link: COUPANG_LINK }) === 'COLUMN',
        '컬럼에 값이 있으면 컬럼이 우선 (수집으로 채워진 값이 최신)');
  check(vendorIdOf({ vendorItemId: 'CAMEL' }) === 'CAMEL', '관측 객체의 camelCase 도 인식');
  check(vendorIdOf({ link: 'https://example.com/x' }) === '', '쿠팡 링크가 아니면 빈 문자열');
  check(vendorIdOf(null) === '', 'null 안전');

  section('품질. 링크 폴백 덕분에 옵션 교체 감지가 기존 행에도 즉시 적용된다');
  reset();
  seedHistory('7100', '쿠팡', 100000, 1);
  // 마이그레이션 직후처럼 컬럼은 비어 있고 link 에만 식별자가 있는 기존 행
  db.products.push({ product_id: '7100', mall: '쿠팡', vendor_item_id: '', link: COUPANG_LINK });
  r = await recordPrices([obs('7100', 40000, { vendorItemId: 'DIFFERENT' })], { label: 'p1a' });
  check(r.suspect === 1, '컬럼이 비어 있어도 옵션 교체(2.5배)를 잡아낸다', JSON.stringify(r));
  check(currentPrice('7100') === null, '현재가를 덮어쓰지 않음');

  section('품질. 저장 시 link 에서 item_id / vendor_item_id 를 채운다');
  reset();
  seedHistory('7200', '쿠팡', 30000, 1);
  await recordPrices([{
    productId: '7200', mall: '쿠팡', keyword: 'k', title: 't', price: 29000, link: COUPANG_LINK
  }], { label: 'p1a2' });
  const idRow = db.upserts.products.find(x => x.product_id === '7200');
  check(idRow && idRow.vendor_item_id === '95693783961',
        '호출부가 안 넘겨도 link 에서 추출해 저장', idRow && idRow.vendor_item_id);
  check(idRow && idRow.item_id === '27883665963', 'item_id 도 저장');

  section('품질. 제목에서 재수집용 검색어 유도 (운영 DB 실제 제목으로 검증)');
  const phrase = (title, expect) => {
    const got = searchPhraseFromTitle(title);
    check(got === expect, `"${title.slice(0, 38)}…" → "${expect}"`, `실제: "${got}"`);
  };
  // 아래 제목은 전부 products 에서 keyword 가 비어 있던 실제 행이다.
  phrase('아이스팩토리 12가지 아이스크림 세트, 12개, 60g', '아이스팩토리 아이스크림 세트');
  phrase('누베크 남자 무지 쿨토시 팔토시 자외선차단 대형 빅사이즈, 3세트, 블랙', '누베크 남자 무지');
  phrase('로보락 S10 MaxV Ultra 직배수 로봇청소기, 화이트, RRE0VES+EWFD56HRR', '로보락 S10 MaxV');
  // 한 글자 토큰(오/드)은 검색에 방해만 되므로 빠진다. 남은 3토큰이 검색어가 된다.
  phrase('[브랜드인증] 존바바토스 아티산 오 드 뚜왈렛', '존바바토스 아티산 뚜왈렛');
  phrase('[국내배송] 지브리 LP 오케스트라 앨범 히사이시조 (한정판/옐로우컬러반)', '지브리 LP 오케스트라');
  check(searchPhraseFromTitle('') === '', '빈 제목 → 빈 문자열');
  check(searchPhraseFromTitle(null) === '', 'null 안전');
  check(searchPhraseFromTitle('12개 60g 1p') === '', '수량·단위만 있으면 검색어 없음 (호출 낭비 방지)');
  check(searchPhraseFromTitle('정품 무료배송 삼성전자 노트북') === '삼성전자 노트북',
        '어느 상품에나 붙는 말은 제외', searchPhraseFromTitle('정품 무료배송 삼성전자 노트북'));

  section('품질. 유도 검색어는 실제로 찾아낸 상품에만 채운다 (기존 keyword 는 불변)');
  reset();
  seedHistory('7300', '쿠팡', 30000, 1);
  await recordPrices([{
    productId: '7300', mall: '쿠팡', keyword: '유도된검색어', title: 't', price: 29000, link: COUPANG_LINK
  }], { label: 'p1b' });
  let kwRow = db.upserts.products.find(x => x.product_id === '7300');
  check(kwRow && kwRow.keyword === '유도된검색어', 'keyword 가 비어 있던 행에는 유도 검색어가 채워진다', kwRow && kwRow.keyword);

  reset();
  seedHistory('7301', '쿠팡', 30000, 1);
  await recordPrices([{
    productId: '7301', mall: '쿠팡', keyword: '원래검색어', title: 't', price: 29000, link: COUPANG_LINK
  }], { label: 'p1b2' });
  kwRow = db.upserts.products.find(x => x.product_id === '7301');
  check(kwRow && kwRow.keyword === '원래검색어', '기존 keyword 는 그대로 유지', kwRow && kwRow.keyword);

  section('품질. 상품 라이프사이클 분류');
  const lc = (row, label, expect) => {
    const got = productLifecycle(row);
    check(got.state === expect, label, `${got.state}${got.reason ? ' — ' + got.reason : ''}`);
  };
  lc({ product_id: '1', mall: '쿠팡', keyword: '마우스', lprice: 1000, collected_at: isoDaysAgo(0) },
     'live — 쿠팡 + keyword + 최근 확인', LIFECYCLE.LIVE);
  lc({ product_id: '1', mall: '쿠팡', keyword: '마우스', lprice: 1000, collected_at: isoDaysAgo(30) },
     'stale — 확인이 오래됨', LIFECYCLE.STALE);
  lc({ product_id: '1', mall: '쿠팡', keyword: '', lprice: 1000, collected_at: isoDaysAgo(0) },
     'keyword 가 없어도 오늘 확인한 값이면 live (노출 판정과 수집 판정은 별개)', LIFECYCLE.LIVE);
  lc({ product_id: '1', mall: '네이버', keyword: '마우스', lprice: 1000, collected_at: isoDaysAgo(0) },
     'dead-mall — 연동 끊긴 몰', LIFECYCLE.DEAD_MALL);
  lc({ product_id: '1', mall: '쿠팡', keyword: '마우스', lprice: 0, collected_at: isoDaysAgo(0) },
     'invalid — 가격 값 이상', LIFECYCLE.INVALID);
  lc({ mall: '쿠팡', keyword: '마우스', lprice: 1000, collected_at: isoDaysAgo(0) },
     'invalid — product_id 없음', LIFECYCLE.INVALID);
  check(productLifecycle({ product_id: '1', mall: '쿠팡', keyword: 'k', lprice: 1, collected_at: null }).state === LIFECYCLE.STALE,
        'collected_at 이 없으면 stale (신선하다고 가정하지 않는다)');

  section('품질. reachable — 수집기가 다시 찾아갈 수 있는가 (노출과 별개)');
  check(productLifecycle({ product_id: '1', mall: '쿠팡', keyword: '마우스', lprice: 1, collected_at: isoDaysAgo(0) }).reachable === true,
        '쿠팡 + keyword → reachable');
  check(productLifecycle({ product_id: '1', mall: '쿠팡', keyword: '', lprice: 1, collected_at: isoDaysAgo(0) }).reachable === false,
        'keyword 없으면 unreachable (수집 대상에서 빠지던 287행)');
  check(productLifecycle({ product_id: '1', mall: '네이버', keyword: 'k', lprice: 1, collected_at: isoDaysAgo(0) }).reachable === false,
        '연동 끊긴 몰은 unreachable');

  section('품질. freshRows 는 live 만 통과시킨다');
  const lcRows = freshRows([
    { product_id: 'a', mall: '쿠팡', keyword: 'k', lprice: 1000, collected_at: isoDaysAgo(0) },
    { product_id: 'b', mall: '쿠팡', keyword: 'k', lprice: 1000, collected_at: isoDaysAgo(30) },
    { product_id: 'c', mall: '쿠팡', keyword: '',  lprice: 1000, collected_at: isoDaysAgo(0) },
    { product_id: 'd', mall: '네이버', keyword: 'k', lprice: 1000, collected_at: isoDaysAgo(0) },
    { product_id: 'e', mall: '쿠팡', keyword: 'k', lprice: 0,    collected_at: isoDaysAgo(0) }
  ]);
  check(lcRows.map(r => r.product_id).join(',') === 'a,c',
        'live 한 행만 남는다 (c 는 keyword 없지만 오늘 확인해서 통과)',
        lcRows.map(r => r.product_id).join(',') || '(없음)');

  /* ================================================================ *
   *  노출 단계
   * ================================================================ */
  section('노출. 다시 수집되지 않는 몰 / 오래 확인 못 한 행은 현재가로 내보내지 않는다');
  const display = freshRows([
    { product_id: 'a', mall: '쿠팡',       lprice: 30000, collected_at: isoDaysAgo(0) },
    { product_id: 'b', mall: '쿠팡',       lprice: 30000, collected_at: isoDaysAgo(30) },
    { product_id: 'c', mall: '네이버',     lprice: 75000, collected_at: isoDaysAgo(0) },
    { product_id: 'd', mall: '네이버쇼핑', lprice: 75000, collected_at: isoDaysAgo(0) },
    { product_id: 'e', mall: '쿠팡',       lprice: 0,     collected_at: isoDaysAgo(0) },
    { product_id: 'f', mall: '쿠팡',       lprice: 30000, collected_at: null }
  ]);
  const kept = display.map(r => r.product_id).join(',');
  check(kept === 'a', '오늘 확인한 쿠팡 행만 남는다', `남은 행: ${kept || '(없음)'}`);
  check(!display.some(r => r.mall === '네이버'),
        '네이버 갤럭시 핏3 유형(75,000원 고정) 차단');

  /* ================================================================ *
   *  마이그레이션 미적용 환경
   * ================================================================ */
  section('호환. item_id / vendor_item_id 컬럼이 없어도 저장은 성공해야 한다');
  reset();
  db.noItemIdColumns = true;
  seedHistory('4001', '쿠팡', 30000, 1);
  r = await recordPrices([obs('4001', 29000, { vendorItemId: 'ZZZ' })], { label: 'compat' });
  const savedRow = db.upserts.products.find(x => x.product_id === '4001');
  check(r.errors.length === 0, '오류 없음', JSON.stringify(r.errors));
  check(!!savedRow, 'products 저장됨');
  check(savedRow && !('vendor_item_id' in savedRow), '컬럼 없이 재시도됨');
  check(savedRow && savedRow.lprice === 29000, '가격은 정상 저장', savedRow && String(savedRow.lprice));

  /* ================================================================ *
   *  stale-cache 는 저장하지 않는다 (기존 동작 회귀)
   * ================================================================ */
  section('회귀. stale-cache / none 출처는 저장하지 않는다');
  reset();
  let s = await saveProducts('테스트', [{ productId: '5001', mall: '쿠팡', title: 't', lprice: 1000 }],
                             { from: 'stale-cache' });
  check(s.skipped === true && db.upserts.price_history.length === 0,
        'stale-cache 는 기록하지 않음', JSON.stringify(s));
  s = await saveProducts('테스트', [{ productId: '5001', mall: '쿠팡', title: 't', lprice: 1000 }],
                         { from: 'api' });
  check(db.upserts.price_history.length === 1, 'api 출처는 기록함');

  /* ================================================================ *
   *  시세판 하락 판정 — api/init.js 에서 _price.js 로 옮기면서 조건이 늘었다.
   *
   *  ★ 이건 단순 이동(refactor)이 아니다. 동작이 실제로 바뀐다.
   *
   *  2026-08-11 운영 DB price_drop_top 상위 48행 전수 대조:
   *      구 조건 통과 43 / 48
   *      신 조건 통과 29 / 48   (-14행, -32.6%)
   *  새로 탈락한 14행의 내역
   *      쿠팡이 아닌 몰            6행  → 네이버 연동 제거 후 재수집 불가.
   *                                     price_history 의 네이버 최신 기록이
   *                                     2026-07-30 에 멈춰 있다.
   *      product_id 가 상품명인 행  8행  → 전부 link = NULL.
   *                                     "구매" 버튼이 이미 죽어 있던 행이다.
   *  홈 시세판 정원은 SECTION_SIZE = 8 이므로 29행이면 채우고도 남는다
   *  (init.js 는 DROP_FETCH = 48 행을 받아서 8칸을 채운다).
   *
   *  아래 케이스는 그 48행에서 실제로 뽑은 대표 행이다. 조건을 되돌리거나
   *  느슨하게 만들면 여기서 깨진다.
   * ================================================================ */
  section('시세판. plausibleDrop — 운영 DB 실제 행으로 검증 (43/48 → 29/48)');

  const COUPANG_DROP_LINK = 'https://link.coupang.com/re/A?itemId=1&vendorItemId=11';

  // 통과해야 하는 행 (신 조건 29행의 대표)
  check(plausibleDrop({
    product_id: '8440751841', mall: '쿠팡', current_price: 19900, prev_price: 68640,
    drop_pct: 71, link: COUPANG_DROP_LINK
  }) === true, '쿠팡 · 숫자 pid · 링크 있음 · 71% 하락 → 통과 (방수 백팩)');

  check(plausibleDrop({
    product_id: '7958974', mall: '쿠팡', current_price: 12450, prev_price: 27870,
    drop_pct: 55.3, link: COUPANG_DROP_LINK
  }) === true, '같은 "신라면 120g" 이라도 숫자 pid 행은 통과');

  // 새로 탈락해야 하는 행 — 원인별로 하나씩
  check(plausibleDrop({
    product_id: '신라면 120g', mall: '쿠팡', current_price: 4150, prev_price: 7470,
    drop_pct: 44.4, link: null
  }) === false, 'product_id 자리에 상품명 → 제외 (link 도 NULL 이라 클릭 불가)');

  check(plausibleDrop({
    product_id: '89993790947', mall: '네이버쇼핑', current_price: 11900, prev_price: 22000,
    drop_pct: 45.9, link: 'https://search.shopping.naver.com/catalog/1'
  }) === false, '링크가 있어도 재수집 불가 몰이면 제외 (네이버쇼핑 양상추)');

  check(plausibleDrop({
    product_id: '로보락 Q8 Max Pro+ 화이트, 단품', mall: '네이버', current_price: 424140,
    prev_price: 499000, drop_pct: 15, link: null
  }) === false, '몰·식별자·링크가 전부 문제인 행 → 제외');

  check(plausibleDrop({
    product_id: '9999999999', mall: '쿠팡', current_price: 19900, prev_price: 68640,
    drop_pct: 71, link: ''
  }) === false, '쿠팡·숫자 pid 라도 link 가 없으면 제외 (눌러도 갈 곳이 없다)');

  // 구 조건에서도 이미 걸러지던 것들 — 기준이 느슨해지지 않았는지 확인
  check(plausibleDrop({
    product_id: '1', mall: '쿠팡', current_price: 18500, prev_price: 733950,
    drop_pct: 97.5, link: COUPANG_DROP_LINK
  }) === false, `${MAX_PLAUSIBLE_DROP_PCT}% 이상 하락은 매칭 오류로 본다 (로보락 733,950→18,500)`);
  check(plausibleDrop({
    product_id: '1', mall: '쿠팡', current_price: 30000, prev_price: 20000,
    drop_pct: 10, link: COUPANG_DROP_LINK
  }) === false, '올랐으면 하락이 아니다');
  check(plausibleDrop({
    product_id: '1', mall: '쿠팡', current_price: 0, prev_price: 20000,
    drop_pct: 100, link: COUPANG_DROP_LINK
  }) === false, '현재가 0 은 하락이 아니다');
  check(plausibleDrop(null) === false, 'null 을 넣어도 throw 하지 않는다');

  /* ================================================================ *
   *  캐시 출처별 기록 정책 (api/_shop.isRecordableSource)
   * ================================================================ */
  section('캐시. 출처별로 "오늘 관측"으로 기록할지 결정한다');
  check(isRecordableSource('api') === true, 'api        → 기록 (방금 받아왔다)');
  check(isRecordableSource('cache') === true,
        'cache      → 기록 (TTL 6시간 이내라 같은 날의 가격이다)');
  check(isRecordableSource('stale-cache') === false,
        'stale-cache → 기록 안 함 (확인하지 못한 날에 거짓 기록을 남기지 않는다)');
  check(isRecordableSource('none') === false, 'none       → 기록 안 함');
  check(isRecordableSource(undefined) === false, '알 수 없는 출처는 기록하지 않는다');

  /* ================================================================ *
   *  classifyPrice 단위 확인
   * ================================================================ */
  section('단위. classifyPrice 경계');
  check(classifyPrice(30000, null, {}).status === 'ok', '직전 값 없으면 통과 (첫 관측)');
  check(classifyPrice(21000, { price: 100000, observedAt: isoDaysAgo(1) }, {}).status === 'ok',
        '-79% (4.76배) 는 통과 — 실제 특가는 여기 안에 들어온다');
  check(classifyPrice(20000, { price: 100000, observedAt: isoDaysAgo(1) }, {}).status === 'suspect',
        '정확히 5배(-80%) 는 경계 포함 → 보류');
  check(classifyPrice(19000, { price: 100000, observedAt: isoDaysAgo(1) }, {}).status === 'suspect',
        '5배 초과는 보류');
  check(classifyPrice(500000, { price: 100000, observedAt: isoDaysAgo(1) }, {}).status === 'suspect',
        '상승 방향도 5배 이상이면 보류');
  check(classifyPrice(0, { price: 100000, observedAt: isoDaysAgo(1) }, {}).status === 'invalid',
        '0 은 invalid');

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('테스트 실행 오류:', e.message, e.stack);
  process.exit(1);
});

/**
 * api/history.js 의 collapseToDaily 는 export 되지 않는다.
 * 규칙이 갈라지지 않도록 파일에서 그대로 읽어 평가한다.
 */
function loadHistoryCollapse() {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'history.js'), 'utf8');
  const m = src.match(/function collapseToDaily[\s\S]*?\n}/);
  if (!m) throw new Error('history.js 에서 collapseToDaily 를 찾지 못했습니다');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${m[0]}; return collapseToDaily;`)();
  return { collapse: fn };
}
