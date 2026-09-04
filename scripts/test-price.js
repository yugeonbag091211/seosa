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

/** check-alerts.js 가 보낸 메일을 가로챈다 (실제 발송 없음) */
const sentMail = [];

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
        /*
         * upsert 시 실제로 매칭되는 UNIQUE 로 메모리 테이블에도 반영한다.
         * price_history 는 vendor_item_id 를 포함한 4-컬럼 UNIQUE 이므로
         * 옵션이 다르면 별도 행이 남아야 한다.
         *
         * onConflict 문자열도 함께 검증한다 — 값이 예상과 다르면 실 DB 에서
         * 42P10 을 만나 모든 가격 쓰기가 실패하므로 여기서 조용히 지나가면 안 된다.
         */
        const expectedConflict = {
          price_history: 'product_id,mall,vendor_item_id,recorded_date',
          products: 'product_id,mall'
        }[table];
        if (opts && opts.onConflict && expectedConflict && opts.onConflict !== expectedConflict) {
          return Promise.resolve({
            data: null,
            error: {
              message: `there is no unique or exclusion constraint matching the ON CONFLICT specification (got '${opts.onConflict}', expected '${expectedConflict}')`
            }
          });
        }
        list.forEach(r => {
          const key = table === 'price_history'
            ? ['product_id', 'mall', 'vendor_item_id', 'recorded_date']
            : ['product_id', 'mall'];
          const idx = (db[table] || []).findIndex(x => key.every(k => String(x[k] || '') === String(r[k] || '')));
          if (idx > -1) db[table][idx] = { ...db[table][idx], ...r };
          else db[table].push({ ...r });
        });
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

// api/_notify 도 가로챈다 — 테스트가 실제 메일을 보내면 안 된다.
const notifyPath = require.resolve(path.join(__dirname, '..', 'api', '_notify.js'));
require.cache[notifyPath] = new Module(notifyPath, null);
require.cache[notifyPath].filename = notifyPath;
require.cache[notifyPath].loaded = true;
require.cache[notifyPath].exports = {
  send(channel, payload) { sentMail.push({ channel, payload }); return Promise.resolve({ ok: true }); }
};

const {
  recordPrices, freshRows, saveProducts, searchPhraseFromTitle, isRecordableSource
} = require('../api/_shop');
const {
  parsePrice, isSanePrice, classifyPrice, coupangItemIds, isRefreshableMall,
  vendorIdOf, itemIdOf, productLifecycle, isDisplayable, LIFECYCLE,
  plausibleDrop, MAX_PLAUSIBLE_DROP_PCT,
  recentlyObserved, latestObservedDate, observedKstDate, todayDropConfirmed, kstDayStartUtc,
  kstToday
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

// recordPrices 가 이제 KST 를 쓰므로 테스트 기준도 같은 달력으로 맞춘다.
// (예전에는 여기서만 UTC 를 쓰고 있어서, KST 로 이미 다음 날인 UTC 15~24시대에
//  테스트를 돌리면 "최신 기록이 오늘 날짜" 같은 확인이 실패했다)
const TODAY = kstToday();
function daysAgo(n) { return kstToday(new Date(Date.now() - n * 86400000)); }
function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

/** price_history 에 과거 관측을 심는다. */
/**
 * @param {object} [extra]  vendor_item_id / link 등 그 관측 행의 부가 정보.
 *   옵션 교체 감지는 이 행의 vendor_item_id(없으면 link)를 직전 옵션으로 쓴다.
 */
function seedHistory(productId, mall, price, dayOffset, extra) {
  db.price_history.push(Object.assign({
    product_id: productId, mall, title: 't', price,
    recorded_date: daysAgo(dayOffset), recorded_at: isoDaysAgo(dayOffset)
  }, extra || {}));
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
  /*
   * 직전 옵션은 price_history 의 그 관측 행에 있다 — products 가 아니다.
   * (products 는 오늘 이미 갱신됐을 수 있어서 어제 가격과 시점이 어긋난다.
   *  api/_shop.js loadPrevObservations 주석 참고)
   */
  seedHistory('9536222150', '쿠팡', 100000, 1, { vendor_item_id: 'AAA' });
  db.products.push({ product_id: '9536222150', mall: '쿠팡', vendor_item_id: 'AAA' });
  r = await recordPrices([obs('9536222150', 40000, { vendorItemId: 'BBB' })], { label: 't5b' });
  check(r.suspect === 1, '옵션 교체 + 2.5배 변동 → 보류', JSON.stringify(r));
  check(currentPrice('9536222150') === null, 'products 현재가를 덮어쓰지 않음');

  section('Test 5-b2. 직전 옵션은 원장에서 읽는다 — products 의 현재 옵션에 좌우되지 않는다');
  reset();
  // 원장의 직전 관측은 AAA. products 는 이미 다른 옵션(ZZZ)으로 갱신된 상태.
  seedHistory('9536222150', '쿠팡', 100000, 1, { vendor_item_id: 'AAA' });
  db.products.push({ product_id: '9536222150', mall: '쿠팡', vendor_item_id: 'ZZZ' });
  r = await recordPrices([obs('9536222150', 40000, { vendorItemId: 'AAA' })], { label: 't5b2' });
  check(r.suspect === 0 && r.saved === 1,
        '원장 직전 관측과 같은 옵션이면 2.5배 인하는 정상 통과', JSON.stringify(r));
  check(currentPrice('9536222150') === 40000, '현재가가 갱신된다');

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

  section('Test 5-h. vendor_item_id 가 다르면 price_history 에 별도 행으로 남는다');
  // 예전에는 배치 접기 키가 (pid, mall) 이라서 옵션이 다른 관측이 하나로 접혀
  // 사라졌다. 실측에서 같은 (pid, mall, date) 에 vid 가 두 종 이상 남은 사례가
  // 0건이었다 — 새 UNIQUE 를 도입한 취지가 실현되지 않았다는 뜻이었다.
  reset();
  r = await recordPrices([
    obs('7100', 10000, { vendorItemId: 'V1', title: '옵션 A' }),
    obs('7100', 20000, { vendorItemId: 'V2', title: '옵션 B' })
  ], { label: 't5h' });
  const ph7100 = db.upserts.price_history.filter(x => x.product_id === '7100');
  check(ph7100.length === 2, 'price_history 에 두 옵션 모두 저장', String(ph7100.length));
  const vids = ph7100.map(x => x.vendor_item_id).sort();
  check(vids[0] === 'V1' && vids[1] === 'V2', '두 vendor_item_id 가 모두 남음', vids.join(','));
  check(db.upserts.products.length === 1,
        'products 는 (pid, mall) 로 한 행 (최저가 우선)', String(db.upserts.products.length));
  check(currentPrice('7100') === 10000,
        'products 현재가는 두 옵션 중 최저 10,000', String(currentPrice('7100')));

  section('Test 5-i. 같은 vendor_item_id 안에서 여러 번 관측되면 최저가만 남는다');
  reset();
  r = await recordPrices([
    obs('7101', 50000, { vendorItemId: 'V1' }),
    obs('7101', 30000, { vendorItemId: 'V1' }),
    obs('7101', 40000, { vendorItemId: 'V1' })
  ], { label: 't5i' });
  const ph7101 = db.upserts.price_history.filter(x => x.product_id === '7101');
  check(ph7101.length === 1, '같은 vid 는 한 행으로 접힘', String(ph7101.length));
  check(ph7101[0].price === 30000, '최저가 30,000', String(ph7101[0].price));

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

  section('Test 7-a. recorded_date 는 KST 달력 기준으로 남는다');
  // UTC 로 남기던 시절, KST 01:xx 크론이 오늘 수집한 행이 UTC 로는 어제 자정 이후라
  // 통째로 어제 날짜로 저장돼서 price_job_state.job_date 와 하루 어긋나 있었다.
  // 이제 recordPrices({ now }) 가 KST 를 쓰는지 특정 시각으로 못박아 검증한다.
  reset();
  // UTC 2026-08-13T15:00Z == KST 2026-08-14T00:00
  await recordPrices([obs('7200', 30000, { vendorItemId: 'VX' })],
    { label: 't7a', now: new Date('2026-08-13T15:00:00Z') });
  const ph7200 = db.upserts.price_history.find(x => x.product_id === '7200');
  check(!!ph7200, '기록됨');
  check(ph7200 && ph7200.recorded_date === '2026-08-14',
        'recorded_date = KST 2026-08-14 (UTC 15:00Z 이지만)',
        ph7200 && ph7200.recorded_date);
  // recorded_at 은 UTC 인스턴트 그대로여야 한다 (달력 하루만 KST, 시각은 UTC)
  check(ph7200 && ph7200.recorded_at === '2026-08-13T15:00:00.000Z',
        'recorded_at 은 UTC 그대로 유지',
        ph7200 && ph7200.recorded_at);

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
  // history-batch.js는 history.js로 흡수됐다 — vercel.json의 rewrite가 붙이는
  // __route=batch 쿼리로 같은 핸들러를 부른다 (실제 배포 경로와 동일하게 테스트).
  const bres = {
    code: 200, payload: null, setHeader() {}, status(c) { this.code = c; return this; },
    json(b) { this.payload = b; return this; }, end() { return this; }
  };
  await history({
    method: 'GET', headers: {},
    query: { __route: 'batch', titles: JSON.stringify(['무선 이어폰']), keys: JSON.stringify([]) },
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
  // 마이그레이션 직후처럼 컬럼은 비어 있고 link 에만 식별자가 있는 기존 관측 행
  seedHistory('7100', '쿠팡', 100000, 1, { vendor_item_id: '', link: COUPANG_LINK });
  db.products.push({ product_id: '7100', mall: '쿠팡', vendor_item_id: '', link: COUPANG_LINK });
  r = await recordPrices([obs('7100', 40000, { vendorItemId: 'DIFFERENT' })], { label: 'p1a' });
  check(r.suspect === 1, '컬럼이 비어 있어도 옵션 교체(2.5배)를 잡아낸다', JSON.stringify(r));
  check(currentPrice('7100') === null, '현재가를 덮어쓰지 않음');

  section("품질. '__LEGACY__' 관측은 옵션 비교의 근거로 쓰지 않는다");
  reset();
  // 마이그레이션이 "link 에서도 식별자를 못 뽑았다" 고 표시해 둔 행
  seedHistory('7150', '쿠팡', 100000, 1, { vendor_item_id: '__LEGACY__', link: '' });
  r = await recordPrices([obs('7150', 40000, { vendorItemId: 'NEW' })], { label: 'p1b' });
  check(r.suspect === 0 && r.saved === 1,
        "'__LEGACY__' 를 옵션으로 오인해 교체로 판정하지 않는다", JSON.stringify(r));

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
   *  P2 가격 신뢰도
   * ================================================================ */
  const { evaluateTrust, attachTrust, loadRecentHistory, LEVEL } = require('../api/_trust.js');
  const obsPts = (...specs) => specs.map(([price, dayOffset]) => ({ price, recorded_date: daysAgo(dayOffset) }));
  const reasonCodes = t => t.reasons.map(r => r.code);

  section('신뢰도. 신선도가 등급을 좌우한다');
  let t = evaluateTrust({ age: 0.2, points: obsPts([1000, 1], [1000, 2]), vendorItemId: 'V', mall: '쿠팡' });
  check(t.level === LEVEL.HIGH, '오늘 확인 + 교차 확인 + 안정 → 신뢰 높음', `${t.level} ${t.score}`);
  check(reasonCodes(t).indexOf('fresh') > -1, '근거에 신선도 포함', reasonCodes(t).join(','));

  t = evaluateTrust({ age: 5, points: obsPts([1000, 5], [1000, 6]), vendorItemId: 'V', mall: '쿠팡' });
  check(t.level === LEVEL.MEDIUM, '5일 전 확인 → 보통', `${t.level} ${t.score}`);
  check(reasonCodes(t).indexOf('aging') > -1, '"그사이 바뀌었을 수 있다" 근거', reasonCodes(t).join(','));

  t = evaluateTrust({ age: 20, points: obsPts([1000, 20]), vendorItemId: 'V', mall: '쿠팡' });
  check(t.level === LEVEL.STALE, '10일 초과 → 오래된 가격', t.level);
  check(t.score === 0 && /20일/.test(t.summary), '요약이 실제 경과일을 말한다', t.summary);

  section('신뢰도. 검색 출처를 신선도 근거로 쓴다');
  t = evaluateTrust({ liveSource: 'api', points: obsPts([1000, 1]), vendorItemId: 'V', mall: '쿠팡' });
  check(reasonCodes(t).indexOf('checked_now') > -1, "from=api → '방금 확인'", t.summary);
  t = evaluateTrust({ liveSource: 'stale-cache', points: obsPts([1000, 1]), vendorItemId: 'V', mall: '쿠팡' });
  check(t.level === LEVEL.STALE, 'from=stale-cache → 오래된 가격 (점수 무관하게 즉시)', t.level);
  check(reasonCodes(t).indexOf('stale_source') > -1, '이유를 밝힌다', t.summary);

  section('신뢰도. 교차 확인 — 관측이 1건뿐이면 낮춘다');
  t = evaluateTrust({ age: 0.2, points: obsPts([1000, 1]), vendorItemId: 'V', mall: '쿠팡' });
  check(reasonCodes(t).indexOf('single_observation') > -1, '기록 1일치 → 교차 확인 안 됨', t.summary);
  const single = t.score;
  t = evaluateTrust({ age: 0.2, points: obsPts([1000, 1], [1000, 2], [1000, 3]), vendorItemId: 'V', mall: '쿠팡' });
  check(t.score > single, '기록이 여러 건이면 점수가 더 높다', `${single} → ${t.score}`);
  check(reasonCodes(t).indexOf('corroborated') > -1, '교차 확인 근거 표시');

  t = evaluateTrust({ age: 0.2, points: [], vendorItemId: 'V', mall: '쿠팡' });
  check(reasonCodes(t).indexOf('no_history') > -1, '기록 0건도 근거로 밝힌다', t.summary);

  section('신뢰도. 최근 급변은 신뢰도를 크게 떨어뜨린다');
  t = evaluateTrust({ age: 0.2, points: obsPts([1000, 3], [40000, 1]), vendorItemId: 'V', mall: '쿠팡' });
  check(reasonCodes(t).indexOf('volatile_high') > -1, '40배 급변 → volatile_high', t.summary);
  check(t.level !== LEVEL.HIGH, '급변이 있으면 신뢰 높음이 될 수 없다', `${t.level} ${t.score}`);
  t = evaluateTrust({ age: 0.2, points: obsPts([1000, 3], [2500, 1]), vendorItemId: 'V', mall: '쿠팡' });
  check(reasonCodes(t).indexOf('volatile_mild') > -1, '2.5배 변동 → volatile_mild', t.summary);
  t = evaluateTrust({ age: 0.2, points: obsPts([1000, 3], [1050, 1]), vendorItemId: 'V', mall: '쿠팡' });
  check(reasonCodes(t).indexOf('stable') > -1, '안정적이면 그것도 근거로 밝힌다');

  section('신뢰도. 오래된 관측은 급변 판정에 쓰지 않는다');
  // 40일 전과 39일 전 사이의 급변은 지금 가격의 신뢰도와 무관하다.
  t = evaluateTrust({ age: 0.2, points: obsPts([1000, 40], [40000, 39], [40000, 1]), vendorItemId: 'V', mall: '쿠팡' });
  check(reasonCodes(t).indexOf('volatile_high') === -1,
        '14일 창 밖의 급변은 반영하지 않는다', reasonCodes(t).join(','));

  section('신뢰도. 옵션 식별자가 없으면 낮춘다');
  const withId = evaluateTrust({ age: 0.2, points: obsPts([1000, 1], [1000, 2]), vendorItemId: 'V', mall: '쿠팡' }).score;
  t = evaluateTrust({ age: 0.2, points: obsPts([1000, 1], [1000, 2]), vendorItemId: '', mall: '쿠팡' });
  check(t.score < withId, '식별자 없으면 감점', `${withId} → ${t.score}`);
  check(reasonCodes(t).indexOf('no_option_id') > -1, '색상·용량에 따라 다를 수 있다고 밝힌다');

  section('신뢰도. 수집이 끊긴 몰은 확인 불가');
  t = evaluateTrust({ age: 0.2, points: obsPts([1000, 1]), vendorItemId: 'V', mall: '네이버' });
  check(t.level === LEVEL.UNKNOWN, '네이버 → 확인 불가', t.level);
  check(reasonCodes(t).indexOf('unsupported_mall') > -1, '이유를 밝힌다', t.summary);

  section('신뢰도. 모든 근거는 실제 관측에서 나온다 (문장 생성 금지)');
  t = evaluateTrust({ age: 0.2, points: obsPts([1000, 1], [1000, 2]), vendorItemId: 'V', mall: '쿠팡' });
  check(t.reasons.length > 0 && t.reasons.every(r => r.code && r.text && r.kind),
        '모든 reason 에 code/text/kind 가 있다', JSON.stringify(reasonCodes(t)));
  check(['good', 'warn', 'bad'].indexOf(t.reasons[0].kind) > -1, 'kind 는 정해진 값만');
  check(!evaluateTrust({}).level || true, '입력이 비어도 throw 하지 않는다');
  const empty = evaluateTrust({});
  check(empty.level === LEVEL.STALE || empty.level === LEVEL.LOW,
        '근거가 전혀 없으면 높은 등급을 주지 않는다', `${empty.level} ${empty.score}`);

  section('신뢰도. attachTrust — 상품 단위로만 이력을 붙인다');
  reset();
  db.price_history.push(
    { id: 1, product_id: 'T1', mall: '쿠팡', price: 1000, recorded_date: daysAgo(1) },
    { id: 2, product_id: 'T1', mall: '쿠팡', price: 1000, recorded_date: daysAgo(2) },
    // 같은 product_id 의 다른 몰 — 섞이면 안 된다
    { id: 3, product_id: 'T1', mall: '네이버', price: 9, recorded_date: daysAgo(1) }
  );
  const enriched = await attachTrust([
    { productId: 'T1', mall: '쿠팡', collectedAt: isoDaysAgo(0), link: COUPANG_LINK },
    { productId: 'T2', mall: '쿠팡', collectedAt: isoDaysAgo(0), link: COUPANG_LINK }
  ]);
  check(enriched[0].trust.level === LEVEL.HIGH, 'T1 은 교차 확인되어 신뢰 높음', enriched[0].trust.level);
  check(reasonCodes(enriched[0].trust).indexOf('volatile_high') === -1,
        '다른 몰의 9원짜리 기록이 섞이지 않았다', reasonCodes(enriched[0].trust).join(','));
  check(reasonCodes(enriched[1].trust).indexOf('no_history') > -1, 'T2 는 기록 없음');
  check(!!enriched[0].trust.reasons.find(r => r.code === 'fresh'), 'collectedAt 으로 신선도 계산');

  section('신뢰도. collected_at 이 없으면 최신 관측일을 확인 시점으로 쓴다');
  // price_drop_top 뷰 기반 시세판 행에는 collected_at 이 없다.
  reset();
  db.price_history.push(
    { id: 1, product_id: 'T3', mall: '쿠팡', price: 1000, recorded_date: daysAgo(1) },
    { id: 2, product_id: 'T3', mall: '쿠팡', price: 1000, recorded_date: daysAgo(2) }
  );
  const dropLike = await attachTrust([{ productId: 'T3', mall: '쿠팡', link: COUPANG_LINK }]);
  check(dropLike[0].trust.level !== LEVEL.UNKNOWN && dropLike[0].trust.score > 0,
        'collectedAt 없어도 이력으로 신선도를 판정', `${dropLike[0].trust.level} ${dropLike[0].trust.score}`);
  check(reasonCodes(dropLike[0].trust).indexOf('unknown_age') === -1,
        '"언제인지 모름"으로 떨어지지 않는다', reasonCodes(dropLike[0].trust).join(','));

  section('신뢰도. 이력 조회가 실패해도 응답을 죽이지 않는다');
  reset();
  const savedFrom = fakeSupabase.from;
  fakeSupabase.from = () => { throw new Error('DB 폭발'); };
  const survived = await attachTrust([{ productId: 'T9', mall: '쿠팡', collectedAt: isoDaysAgo(0), link: COUPANG_LINK }]);
  fakeSupabase.from = savedFrom;
  check(!!survived[0].trust, '이력 없이라도 신뢰도를 계산해 붙인다', survived[0].trust && survived[0].trust.level);

  section('신뢰도. loadRecentHistory 는 vid 를 모르는 호출부를 위해 상품 단위 키도 채운다');
  /*
   * 회귀 방지 — api/init.js 의 시세판은 price_drop_top 행에 vendor_item_id 가
   * 없어서 `pid|mall` 2단 키로 조회한다. loadRecentHistory 가 `pid|mall|vid`
   * 3단 키만 채우면 그 조회가 항상 undefined 가 되고, recentlyObserved 가
   * 전부 false 를 돌려줘 홈 시세판이 통째로 빈다. 실제로 그 상태였다.
   */
  reset();
  db.price_history.push(
    // 옵션 식별자가 없는 과거 기록 (운영 12,280행 중 6,331행이 이 형태다)
    { id: 1, product_id: 'D1', mall: '쿠팡', vendor_item_id: '',    price: 1000, recorded_date: daysAgo(1) },
    // 옵션 식별자가 채워진 새 기록
    { id: 2, product_id: 'D2', mall: '쿠팡', vendor_item_id: 'V9', price: 2000, recorded_date: daysAgo(1) }
  );
  const dropHist = await loadRecentHistory([
    { productId: 'D1', mall: '쿠팡' },   // init.js 처럼 vendorItemId 를 넘기지 않는다
    { productId: 'D2', mall: '쿠팡' }
  ]);
  check(!!dropHist.get('D1|쿠팡'), 'vid 없는 과거 기록도 상품 단위 키로 찾힌다');
  check(!!dropHist.get('D2|쿠팡'), 'vid 있는 새 기록도 상품 단위 키로 찾힌다 (시세판이 비지 않는다)');
  check(!!dropHist.get('D2|쿠팡|V9'), '옵션 단위 키도 그대로 유지된다');
  check(recentlyObserved(dropHist.get('D2|쿠팡'), TODAY) === true,
        'init.js 의 recentlyObserved 판정이 통과한다');

  /* ================================================================ *
   *  P1-c 데이터 품질 지표
   * ================================================================ */
  section('품질지표. 라이프사이클 / 도달성 / 식별자 / 신선도를 정확히 센다');
  reset();
  db.products.push(
    { id: 1, product_id: 'A', mall: '쿠팡', keyword: 'k', lprice: 1000, collected_at: isoDaysAgo(0), link: COUPANG_LINK, vendor_item_id: '' },
    { id: 2, product_id: 'B', mall: '쿠팡', keyword: 'k', lprice: 1000, collected_at: isoDaysAgo(30), link: COUPANG_LINK, vendor_item_id: 'V2' },
    { id: 3, product_id: 'C', mall: '쿠팡', keyword: '',  lprice: 1000, collected_at: isoDaysAgo(0), link: COUPANG_LINK, vendor_item_id: '' },
    { id: 4, product_id: 'D', mall: '네이버', keyword: 'k', lprice: 1000, collected_at: isoDaysAgo(0), link: '', vendor_item_id: '' },
    { id: 5, product_id: 'E', mall: '쿠팡', keyword: 'k', lprice: 0,    collected_at: isoDaysAgo(0), link: COUPANG_LINK, vendor_item_id: '' }
  );
  db.price_history.push(
    { id: 1, product_id: 'A', mall: '쿠팡', price: 1000, recorded_date: daysAgo(1) },
    { id: 2, product_id: 'A', mall: '쿠팡', price: 900,  recorded_date: TODAY },
    { id: 3, product_id: 'B', mall: '쿠팡', price: 1000, recorded_date: daysAgo(1) },
    // 40배 급변 — 의심 관측쌍으로 잡혀야 한다
    { id: 4, product_id: 'B', mall: '쿠팡', price: 40000, recorded_date: TODAY }
  );

  const { qualitySnapshot } = require('../api/_quality.js');
  const snap = await qualitySnapshot();
  check(!snap.error, '스냅샷 생성 성공', snap.error || '');
  check(snap.상품.전체 === 5, '상품 전체 5', String(snap.상품.전체));
  check(snap.상품.노출가능_live === 2, 'live 2 (A, C — C 는 keyword 없어도 오늘 확인됨)', String(snap.상품.노출가능_live));
  check(snap.상품.묵음_stale === 1, 'stale 1 (B)', String(snap.상품.묵음_stale));
  check(snap.상품.수집중단몰 === 1, 'dead-mall 1 (D)', String(snap.상품.수집중단몰));
  check(snap.상품.값이상_invalid === 1, 'invalid 1 (E, 가격 0)', String(snap.상품.값이상_invalid));
  check(snap.수집도달성.수집기가_못찾는행 === 1,
        '수집기가 못 찾는 행 1 (C) — 네이버 행은 여기 안 센다', String(snap.수집도달성.수집기가_못찾는행));
  check(snap.식별자.보유율_쿠팡기준 === '100%',
        '옵션식별자 보유율은 쿠팡 기준 (네이버 행을 분모에 넣지 않는다)', snap.식별자.보유율_쿠팡기준);
  check(snap.식별자.링크에서_추출 === 3, 'link 폴백으로 3건 확보 (A, C, E)', String(snap.식별자.링크에서_추출));
  check(snap.가격값.급변_의심_관측쌍 === 1, '40배 급변 1건을 의심으로 집계', String(snap.가격값.급변_의심_관측쌍));
  check(snap.가격이력.오늘_기록 === 2, '오늘 기록 2건', String(snap.가격이력.오늘_기록));

  section('품질지표. price_history 는 최신순으로 표본을 잡는다');
  // 오래된 순으로 자르면 "오늘 기록 0건" 같은 정반대 결론이 나온다 (실제로 겪은 버그).
  check(snap.표본.price_history.indexOf('전량') === 0,
        '표본이 안 잘렸으면 전량이라고 밝힌다', snap.표본.price_history);

  section('품질지표. DB 오류가 나도 진단 전체를 죽이지 않는다');
  const origFrom = fakeSupabase.from;
  fakeSupabase.from = () => { throw new Error('DB 폭발'); };
  const broken = await qualitySnapshot();
  fakeSupabase.from = origFrom;
  check(!!broken.error, '오류를 { error } 로 돌려준다 (throw 하지 않음)', broken.error);

  /* ================================================================ *
   *  check-alerts.js — 알림은 상품 식별자로만 매칭한다
   * ================================================================ */
  section('알림. 이름만 같은 다른 상품의 가격으로 메일을 보내지 않는다');
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key';
  const { run: runAlerts } = require('./check-alerts.js');

  reset();
  sentMail.length = 0;
  // 오늘 가격: 값이 아주 싼 "동명이물" B상품만 수집됐다.
  db.price_history.push({
    product_id: 'B-9999', mall: '쿠팡', title: '무선 이어폰',
    price: 5000, recorded_date: TODAY, recorded_at: new Date().toISOString(), link: ''
  });
  // 알림 신청: 사용자가 원한 것은 A상품(10만원대)이다.
  db.alerts.push({
    id: 1, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 90000, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 0,
        'A상품 알림에 B상품(5,000원) 가격으로 "목표가 달성" 메일이 나가지 않는다',
        sentMail.length ? JSON.stringify(sentMail[0].payload.product) : '발송 0건');

  section('알림. product_id 없는 옛 신청은 발송하지 않는다');
  reset();
  sentMail.length = 0;
  db.price_history.push({
    product_id: 'B-9999', mall: '쿠팡', title: '무선 이어폰',
    price: 5000, recorded_date: TODAY, recorded_at: new Date().toISOString(), link: ''
  });
  db.alerts.push({
    id: 2, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: '', target_price: 90000, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 0, '식별자 없는 신청은 건너뛴다 (잘못 보내느니 안 보낸다)',
        sentMail.length ? JSON.stringify(sentMail[0].payload.product) : '발송 0건');
  check(db.updates.length === 0, 'sent 플래그도 건드리지 않는다 (나중에 식별자가 채워지면 발송 가능)');

  section('알림. 정상 신청은 그대로 발송된다 (기능이 죽지 않았는지)');
  reset();
  sentMail.length = 0;
  db.price_history.push(
    { product_id: 'A-1111', mall: '쿠팡', title: '무선 이어폰', price: 80000, recorded_date: TODAY, recorded_at: new Date().toISOString(), link: 'https://x' },
    { product_id: 'A-1111', mall: '쿠팡', title: '무선 이어폰', price: 120000, recorded_date: daysAgo(1), recorded_at: isoDaysAgo(1), link: 'https://x' },
    // 같은 이름의 다른 상품 — 통계에 섞이면 안 된다
    { product_id: 'B-9999', mall: '쿠팡', title: '무선 이어폰', price: 5000, recorded_date: daysAgo(1), recorded_at: isoDaysAgo(1), link: '' }
  );
  db.alerts.push({
    id: 3, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 90000, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 1, '목표가 달성 → 메일 1건 발송', String(sentMail.length));
  check(sentMail[0] && sentMail[0].payload.product.currentPrice === 80000,
        '현재가는 그 상품(A)의 80,000원', sentMail[0] && String(sentMail[0].payload.product.currentPrice));
  check(sentMail[0] && sentMail[0].payload.analysis.min30 === 80000,
        '30일 최저가에 동명 B상품의 5,000원이 섞이지 않는다',
        sentMail[0] && String(sentMail[0].payload.analysis.min30));
  check(db.updates.some(u => u.table === 'alerts' && u.patch.sent === true),
        '발송 후 sent 갱신 (중복 발송 방지)');

  /* ================================================================ *
   *  알림 조건 4 — "AI 가 사도 좋다고 하면 알려줘" (alerts.on_deal)
   *
   *  목표가·전일 하락·역대 최저가는 전부 "가격이 얼마인가" 만 본다.
   *  목표가를 정하려면 사용자가 적정가를 미리 알아야 하는데, 모르니까
   *  알림을 신청하는 것이다. 이 조건은 api/_deal.js 판정을 그대로 쓴다.
   *
   *  ★ 판정을 여기서 다시 만들지 않는다 — 화면·AI 답변·알림 메일이 같은
   *    상품을 두고 다른 말을 하면 안 된다.
   * ================================================================ */

  /** 하루 한 점씩 days 일치 기록을 넣는다. price(i) 는 i 일 전 가격. */
  const pushDaily = (pid, days, price) => {
    for (let i = days - 1; i >= 0; i--) {
      db.price_history.push({
        product_id: pid, mall: '쿠팡', title: '무선 이어폰', price: price(i),
        recorded_date: daysAgo(i), recorded_at: isoDaysAgo(i), link: 'https://x'
      });
    }
  };

  section('알림. AI 판정 조건 — 싼 시점이면 목표가 없이도 발송한다');
  reset();
  sentMail.length = 0;
  // 30일 동안 100,000~140,000 을 오가다 오늘 98,000 — 기록 대비 확실히 싸다.
  pushDaily('A-1111', 30, i => (i === 0 ? 98000 : 100000 + (i % 7) * 6000));
  db.alerts.push({
    id: 10, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 0, on_deal: true, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 1, '★★ 목표가 0 이어도 AI 판정으로 발송된다', String(sentMail.length));
  check(sentMail[0] && /구매 시점 판정이 "(BUY|GOOD_BUY)"/.test(sentMail[0].payload.analysis.timing),
        '★ 메일에 판정 글자가 그대로 실린다',
        sentMail[0] && sentMail[0].payload.analysis.timing);
  check(sentMail[0] && sentMail[0].payload.product.currentPrice === 98000,
        '현재가는 오늘 관측값', sentMail[0] && String(sentMail[0].payload.product.currentPrice));

  /*
   * ★ 아래 fixture 들은 "deal 조건만" 검사한다.
   *
   *   오늘 가격을 기록상 최저로 만들면 기존 atl(역대 최저가) 조건이 먼저
   *   발동해서 메일이 나가 버린다. 그러면 이 테스트는 deal 조건이 죽어 있어도
   *   통과한다 — 실제로 처음 작성했을 때 그렇게 통과했다.
   *   그래서 오늘 값은 항상 기록 최저보다 위에 두고, 전일 대비 하락폭도
   *   DROP_THRESHOLD(5%) 아래로 둔다.
   */
  section('알림. AI 판정 조건 — 평범한 가격이면 보내지 않는다');
  reset();
  sentMail.length = 0;
  // 99,000~101,000 을 오가는 상품. 오늘 100,000 — 최저도 아니고 급락도 아니다.
  pushDaily('A-1111', 30, i => (i === 0 ? 100000 : 99000 + (i % 3) * 1000));
  db.alerts.push({
    id: 11, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 0, on_deal: true, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 0, '★★ NORMAL 에는 메일을 보내지 않는다 — 알림이 소음이 되면 안 된다',
        sentMail.length ? sentMail[0].payload.analysis.timing : '발송 0건');

  section('알림. AI 판정 조건 — 기록이 부족하면 보내지 않는다');
  reset();
  sentMail.length = 0;
  // 2일치뿐. 오늘이 최저도 아니고 급락도 아니라 다른 조건은 발동하지 않는다.
  pushDaily('A-1111', 2, i => (i === 0 ? 51000 : 50000));
  db.alerts.push({
    id: 12, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 0, on_deal: true, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 0,
        '★★ 근거가 없으면(UNKNOWN) 판정으로 메일을 만들지 않는다',
        sentMail.length ? sentMail[0].payload.analysis.timing : '발송 0건');

  section('알림. on_deal 을 안 켰으면 예전과 똑같이 동작한다');
  reset();
  sentMail.length = 0;
  // 위 "발송된다" 케이스와 같은 데이터인데 on_deal 만 없다.
  // 오늘이 최저가 되지 않도록 기록 안에 더 싼 날을 하나 둔다.
  pushDaily('A-1111', 30, i => (i === 0 ? 98000 : i === 1 ? 99000 : (i === 15 ? 90000 : 118000)));
  db.alerts.push({
    id: 13, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 0, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 0,
        '★ on_deal 없는 기존 알림은 목표가 0 이면 그대로 발송되지 않는다',
        sentMail.length ? sentMail[0].payload.analysis.timing : '발송 0건');

  section('알림. 같은 데이터에서 on_deal 을 켜면 발송된다 (조건이 실제로 일한다)');
  reset();
  sentMail.length = 0;
  pushDaily('A-1111', 30, i => (i === 0 ? 98000 : i === 1 ? 99000 : (i === 15 ? 90000 : 118000)));
  db.alerts.push({
    id: 16, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 0, on_deal: true, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 1,
        '★★ on_deal 만 켜면 같은 데이터가 발송된다 — 다른 조건이 대신 발동한 게 아니다',
        sentMail.length ? sentMail[0].payload.analysis.timing : '발송 0건');
  check(sentMail[0] && /구매 시점 판정/.test(sentMail[0].payload.analysis.timing),
        '★ 발송 사유가 AI 판정이다', sentMail[0] && sentMail[0].payload.analysis.timing);

  section('알림. 목표가와 AI 조건을 같이 켤 수 있다');
  reset();
  sentMail.length = 0;
  pushDaily('A-1111', 30, i => (i === 0 ? 98000 : 100000 + (i % 7) * 6000));
  db.alerts.push({
    id: 14, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 99000, on_deal: true, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 1, '두 조건이 동시에 맞아도 메일은 한 통', String(sentMail.length));
  {
    const t = sentMail[0] ? sentMail[0].payload.analysis.timing : '';
    check(/목표 가격에 도달/.test(t) && /구매 시점 판정/.test(t),
          '★ 두 조건을 한 메일에 모아 적는다', t);
  }

  section('알림. 판정에 쓰는 기록도 그 상품 것이어야 한다');
  reset();
  sentMail.length = 0;
  pushDaily('A-1111', 30, i => (i === 10 ? 99000 : 100000));  // A는 거의 안 움직이고 오늘이 최저도 아니다
  pushDaily('B-9999', 30, i => 300000 - i * 5000);  // 동명이물 B는 크게 떨어졌다
  db.alerts.push({
    id: 15, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 0, on_deal: true, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 0,
        '★★ 이름만 같은 B상품의 하락으로 A상품 알림이 나가지 않는다',
        sentMail.length ? sentMail[0].payload.analysis.timing : '발송 0건');

  /* ================================================================ *
   *  KST 하루 경계 — recorded_date 라벨을 믿지 않는다
   *
   *  운영 DB 는 recorded_date 를 recorded_at 의 UTC 날짜로 덮어쓴다
   *  (2026-08-23 실측, price_history 15,155행 전부). 수집 크론이 KST
   *  01·03·06시에 도는 탓에 "KST 로 오늘 관측된 행" 의 라벨은 어제다.
   *
   *  아래 세 섹션은 그 실제 데이터 모양을 그대로 만들어 두고, 라벨을 KST 로
   *  착각하던 코드가 되살아나면 바로 깨지도록 고정한다. 예전 테스트는
   *  recorded_date === KST 날짜인 데이터만 써서 이 사고를 못 잡았다.
   * ================================================================ */
  section('KST 경계. kstDayStartUtc — KST 하루의 시작을 절대 시각으로');
  check(kstDayStartUtc('2026-08-23') === '2026-08-22T15:00:00.000Z',
        'KST 08-23 00:00 == UTC 08-22 15:00', kstDayStartUtc('2026-08-23'));
  check(kstDayStartUtc('2026-01-01') === '2025-12-31T15:00:00.000Z',
        '해가 바뀌어도 동일 (서머타임 없음)', kstDayStartUtc('2026-01-01'));
  check(kstDayStartUtc('') === '' && kstDayStartUtc('2026/08/23') === ''
        && kstDayStartUtc(null) === '', '형식이 아니면 빈 문자열 (경계를 지어내지 않는다)');
  // 경계 자신은 그날에 포함되고, 1ms 앞은 전날이다.
  check(kstToday(new Date(Date.parse(kstDayStartUtc('2026-08-23')))) === '2026-08-23',
        '경계 시각은 그날의 첫 순간');
  check(kstToday(new Date(Date.parse(kstDayStartUtc('2026-08-23')) - 1)) === '2026-08-22',
        '경계 1ms 전은 전날');

  /*
   * 회귀: 같은 KST 하루 안에서 자기 자신을 "직전 관측" 으로 삼으면 안 된다.
   *
   * 사고 경로 — KST 01시 수집에서 오염값(30배)이 들어와 suspect 로 보류된다.
   * price_history 에는 남으므로, KST 03시 수집이 그 행을 직전 값으로 집으면
   * ratio≈1 이 되어 오염값이 스스로를 승인하고 products 현재가로 올라간다.
   *
   * _shop.loadPrevObservations 가 .lt('recorded_date', kstToday()) 로 자르던
   * 시절에는 그 행의 라벨이 UTC 기준 '어제' 라서 그대로 딸려 들어왔다.
   * 이제는 .lt('recorded_at', kstDayStartUtc(today)) 로 잘라 확실히 빠진다.
   */
  section('KST 경계. 오늘 새벽에 쓴 행(라벨은 어제)을 직전 관측으로 쓰지 않는다');
  reset();
  const kstNow      = kstToday();
  const kstStartMs  = Date.parse(kstDayStartUtc(kstNow));
  const at0311      = new Date(kstStartMs + (3 * 60 + 11) * 60000);   // KST 03:11
  const at0600      = new Date(kstStartMs + 6 * 60 * 60000);          // KST 06:00
  // 이 행이 문제의 모양이다 — KST 로는 오늘인데 라벨(UTC)은 어제다.
  const utcLabelOf  = d => d.toISOString().slice(0, 10);
  check(utcLabelOf(at0311) !== kstNow,
        '전제 확인: KST 03:11 관측의 UTC 라벨은 오늘이 아니다',
        `${utcLabelOf(at0311)} vs KST ${kstNow}`);

  // 이틀 전의 정상 관측 + 오늘 새벽에 보류된 오염값(30배)
  seedHistory('7300', '쿠팡', 30000, 2);
  db.price_history.push({
    product_id: '7300', mall: '쿠팡', title: 't', price: 900000,
    recorded_date: utcLabelOf(at0311), recorded_at: at0311.toISOString()
  });

  const dayBoundary = await recordPrices([obs('7300', 900000)],
    { label: 'kst-boundary', now: at0600 });
  check(dayBoundary.suspect === 1,
        '같은 KST 하루의 오염값은 여전히 보류된다 (자기 자신과 비교하지 않는다)',
        JSON.stringify(dayBoundary));
  check(currentPrice('7300') === null,
        '오염값이 products 현재가로 승격되지 않는다',
        String(currentPrice('7300')));

  /*
   * 회귀: 알림 스크립트가 "오늘 가격" 을 찾지 못하던 문제.
   *
   * .eq('recorded_date', kstToday()) 는 GitHub Actions 실행 시각(KST 01·03·06시)
   * 에 아직 존재할 수 없는 라벨을 찾는 질의라 항상 0건이었고, 모든 알림이
   * "오늘 가격 없음" 으로 조용히 건너뛰어졌다.
   */
  section('KST 경계. 알림은 라벨이 어제인 오늘 관측분도 찾는다');
  reset();
  sentMail.length = 0;
  db.price_history.push(
    // 오늘(KST) 새벽 03:11 관측 — 라벨은 UTC 기준 어제다
    { product_id: 'A-1111', mall: '쿠팡', title: '무선 이어폰', price: 80000,
      recorded_date: utcLabelOf(at0311), recorded_at: at0311.toISOString(), link: 'https://x' },
    // 어제(KST) 관측
    { product_id: 'A-1111', mall: '쿠팡', title: '무선 이어폰', price: 120000,
      recorded_date: daysAgo(1), recorded_at: isoDaysAgo(1), link: 'https://x' }
  );
  db.alerts.push({
    id: 4, email: 'u@example.com', title: '무선 이어폰', mall: '쿠팡',
    product_id: 'A-1111', target_price: 90000, sent: false, link: '', image: ''
  });
  await runAlerts();
  check(sentMail.length === 1,
        '라벨이 어제여도 오늘(KST) 관측분으로 판정해 메일이 나간다',
        `발송 ${sentMail.length}건`);
  check(sentMail[0] && sentMail[0].payload.product.currentPrice === 80000,
        '현재가는 오늘 새벽에 관측한 80,000원',
        sentMail[0] && String(sentMail[0].payload.product.currentPrice));

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

  /* ================================================================
   *  시세판 최신성 — recentlyObserved
   *
   *  plausibleDrop 은 "하락폭이 그럴듯한가"만 본다. 언제 관측된 하락인지는
   *  price_drop_top 뷰에 날짜 컬럼이 없어서 알 수 없다. 그래서 2026-08-12
   *  운영 DB 기준으로 홈 상위 8행 중 4행이 2026-07-30(13일 전) 기록인데도
   *  "현재가"로 나가고 있었다.
   *
   *  아래는 그 판정을 고정한다. 날짜는 전부 'YYYY-MM-DD' 문자열 비교다.
   * ================================================================ */
  section('시세판. recentlyObserved — 오래된 기록을 현재가로 쓰지 않는다');

  // 모듈 상단의 TODAY 와 겹치지 않게 이름을 달리한다 — 여기서는 날짜를 고정해서 본다.
  const DROP_TODAY = '2026-08-12';
  const histPts = (...dates) => dates.map(d => ({ price: 1000, recorded_date: d }));

  check(recentlyObserved(histPts('2026-08-12'), DROP_TODAY) === true, '오늘 기록 → 통과');
  check(recentlyObserved(histPts('2026-08-05'), DROP_TODAY) === true, '정확히 7일 전 → 경계 포함, 통과');
  check(recentlyObserved(histPts('2026-08-04'), DROP_TODAY) === false, '8일 전 → 제외');
  check(recentlyObserved(histPts('2026-07-30'), DROP_TODAY) === false,
        '13일 전 → 제외 (실제로 홈에 떠 있던 방수 백팩 사례)');

  check(recentlyObserved(histPts('2026-07-30', '2026-08-10', '2026-07-27'), DROP_TODAY) === true,
        '여러 점 중 가장 최근 것으로 판단한다 (정렬 순서에 기대지 않는다)');

  check(recentlyObserved([], DROP_TODAY) === false, '기록이 빈 배열이면 제외');
  check(recentlyObserved(undefined, DROP_TODAY) === false, '기록이 없으면(undefined) 제외');
  /*
   * maxAgeDays 를 넘기면 기본값(7일) 대신 그 값을 쓴다.
   *
   * ★ 기준 날짜는 DROP_TODAY(고정)여야 한다. 예전에는 실행 시각의 TODAY 를
   *   썼는데, 고정된 과거 날짜 '2026-07-30' 과 견주는 구조라 시간이 지나면
   *   반드시 깨진다. 실제로 2026-08-30 에 31일 차이가 되면서 FAIL 이 났고,
   *   npm test 체인이 여기서 멈춰 뒤의 17개 스크립트가 통째로 돌지 않았다.
   *   같은 날짜로 위(1338줄)에서 기본값 7일이면 탈락하는 것을 이미 확인하므로,
   *   이 줄은 "30 을 주면 통과한다" 를 그대로 검사한다 — 검사 내용은 같고
   *   실행 날짜에만 의존하지 않게 됐다.
   */
  check(recentlyObserved(histPts('2026-07-30'), DROP_TODAY, 30) === true,
        'maxAgeDays 를 넘기면 그 값을 쓴다');

  /*
   * 미래 날짜.
   *
   * 수집기 시각이 어긋나거나 손으로 넣은 행이 내일 날짜로 들어오면, 그게
   * 최신값이 되어 아무리 묵은 상품도 "방금 확인됨"이 된다. 오늘까지만 현재로 친다.
   */
  check(recentlyObserved(histPts('2026-09-01'), DROP_TODAY) === false,
        '미래 날짜 하나뿐이면 → 현재 기록으로 치지 않는다');
  check(recentlyObserved(histPts('2026-09-01', '2026-07-30'), DROP_TODAY) === false,
        '미래 날짜를 빼고 나면 13일 전이 최신 → 제외');
  check(recentlyObserved(histPts('2026-09-01', '2026-08-11'), DROP_TODAY) === true,
        '미래 날짜를 빼도 8-11 이 남으면 → 통과');

  check(latestObservedDate(histPts('2026-08-01', '2026-08-09', '2026-08-03'), DROP_TODAY) === '2026-08-09',
        'latestObservedDate — 가장 최근 날짜를 고른다');
  check(latestObservedDate(histPts('2026-09-09'), DROP_TODAY) === '',
        'latestObservedDate — 미래뿐이면 빈 문자열');
  check(latestObservedDate(histPts('', null, 'abc'), DROP_TODAY) === '',
        'latestObservedDate — 형식이 깨진 값은 무시');

  // today 가 이상하면 통과시키지 않는다 (판단 근거가 없는데 최신이라고 하면 안 된다).
  check(recentlyObserved(histPts('2026-08-12'), '') === false, 'today 가 비면 제외');
  check(recentlyObserved(histPts('2026-08-12'), '2026/08/12') === false, 'today 형식이 다르면 제외');

  /* ================================================================
   *  오늘의 하락 — latestObservedDate === today 판정
   *
   *  기존 recentlyObserved 는 7일 이내면 통과시켰다. 그래서 8/17 하락이
   *  8/21에도 "오늘의 하락"으로 노출됐다.
   *  init.js 의 새 로직은 latestObservedDate(points, today) === today 로
   *  오늘 수집분만 보여준다.
   * ================================================================ */
  section('오늘의 하락. latestObservedDate === today — 오늘 수집분만 노출');

  // 오늘 수집된 상품만 통과
  check(latestObservedDate(histPts(DROP_TODAY), DROP_TODAY) === DROP_TODAY,
        '오늘 기록이 있으면 통과');

  // 어제 수집 → 오늘 아님 → 탈락
  check(latestObservedDate(histPts('2026-08-11'), DROP_TODAY) !== DROP_TODAY,
        '어제 기록만 있으면 탈락 (기존 recentlyObserved 는 통과시켰던 케이스)');

  // 7일 전 기록만 → 탈락 (기존에는 경계에서 통과)
  check(latestObservedDate(histPts('2026-08-05'), DROP_TODAY) !== DROP_TODAY,
        '7일 전 기록만 → 탈락 (기존 recentlyObserved 는 통과시켰던 케이스)');

  // 유저 시나리오: 8/17 하락, 이후 수집 없음 → 8/21에 표시되면 안 됨
  const DROP_AUG21 = '2026-08-21';
  check(latestObservedDate(histPts('2026-08-17', '2026-08-16'), DROP_AUG21) !== DROP_AUG21,
        '8/17 하락이 8/21에 표시되지 않는다 (유저 시나리오)');

  // 오늘 수집 + 과거 기록 → 오늘이 최신이므로 통과
  check(latestObservedDate(histPts('2026-08-05', DROP_TODAY, '2026-07-30'), DROP_TODAY) === DROP_TODAY,
        '과거 기록이 섞여 있어도 오늘 것이 있으면 통과');

  // 미래 날짜만 → 빈 문자열 → 탈락
  check(latestObservedDate(histPts('2026-09-01'), DROP_TODAY) !== DROP_TODAY,
        '미래 날짜만 → 탈락');

  // 빈/undefined → 탈락
  check(latestObservedDate([], DROP_TODAY) !== DROP_TODAY, '빈 배열 → 탈락');
  check(latestObservedDate(undefined, DROP_TODAY) !== DROP_TODAY, 'undefined → 탈락');

  /* ================================================================
   *  관측일 판정 — observedKstDate
   *
   *  recorded_date 는 배포본이 UTC 로 잘라 온 라벨이라 KST 달력과 하루
   *  어긋난 행이 운영 DB 의 42.9% 다 (2026-08-22 실측). recorded_at 이
   *  있으면 그쪽을 KST 로 환산해 쓴다.
   * ================================================================ */
  section('관측일. observedKstDate — recorded_at(KST) 이 recorded_date 보다 우선');

  // 운영 실측: KST 08-22 02:10 수집분이 recorded_date=2026-08-21 로 저장돼 있다.
  check(observedKstDate({ recorded_date: '2026-08-21', recorded_at: '2026-08-21T17:10:22.742+00:00' }) === '2026-08-22',
        'UTC 라벨이 하루 이르면 recorded_at 의 KST 달력일로 바로잡는다');

  check(observedKstDate({ recorded_date: '2026-08-22', recorded_at: '2026-08-22T01:00:00.000+00:00' }) === '2026-08-22',
        'KST 로 저장된 라벨과도 답이 같다 (수집기 수정 후에도 그대로 맞는다)');

  check(observedKstDate({ recorded_date: '2026-08-20' }) === '2026-08-20',
        'recorded_at 이 없으면 recorded_date 로 폴백한다 (기존 동작)');

  check(observedKstDate({ recorded_date: '2026-08-20', recorded_at: 'not-a-date' }) === '2026-08-20',
        '깨진 recorded_at 은 무시하고 recorded_date 를 쓴다');

  check(observedKstDate(null) === '', 'null 은 빈 문자열');

  // latestObservedDate 도 같은 기준을 쓴다 (init.js 시세판이 이 판정에 의존한다).
  check(latestObservedDate([{ price: 1, recorded_date: '2026-08-21', recorded_at: '2026-08-21T17:10:22.742+00:00' }],
                          '2026-08-22') === '2026-08-22',
        'latestObservedDate 가 UTC 라벨 행을 오늘로 인정한다 (시세판이 통째로 비던 원인)');

  /* ================================================================
   *  오늘의 하락 확정 — todayDropConfirmed
   *
   *  price_drop_top 은 (pid, mall, vid) 안에서 최신 두 기록을 날짜와
   *  무관하게 비교한다. 그래서 두 가지가 새어 나왔다.
   *    (1) prev_price 가 어제가 아니라 며칠 전 값
   *    (2) current_price 가 오늘 값이 아니라 다른 옵션의 묵은 값
   *  원장(price_history)으로 다시 확인해서 둘 다 막는다.
   * ================================================================ */
  section('오늘의 하락. todayDropConfirmed — 오늘 실제로 내려간 것만');

  const TD = '2026-08-22';
  // KST day 의 hhmm 을 UTC 인스턴트로 환산해 recorded_at 을 만든다 (KST = UTC+9).
  const pt = (price, day, hhmm) => ({
    price,
    recorded_date: day,
    recorded_at: new Date(Date.parse(day + 'T' + hhmm + ':00Z') - 9 * 3600 * 1000).toISOString()
  });

  check(todayDropConfirmed({ current_price: 9900, prev_price: 12900 }, [pt(9900, TD, '02:10'), pt(12900, '2026-08-21', '02:10')], TD) === true,
        '오늘 9,900 / 어제 12,900 → 하락 확정');

  // 운영 실측 위양성: pid=8085515094 — 옵션 식별자만 바뀌고 값은 그대로였다.
  check(todayDropConfirmed({ current_price: 59800, prev_price: 64800 }, [pt(59800, TD, '02:00'), pt(59800, '2026-08-21', '02:00')], TD) === false,
        '직전 관측과 값이 같으면 하락이 아니다 (뷰는 -7.7% 라고 했던 실제 사례)');

  check(todayDropConfirmed({ current_price: 9900, prev_price: 12900 }, [pt(9900, '2026-08-21', '02:00'), pt(12900, '2026-08-20', '02:00')], TD) === false,
        '오늘 수집분이 없으면 탈락 (며칠 전 하락이 계속 뜨던 원인)');

  check(todayDropConfirmed({ current_price: 50000, prev_price: 70000 }, [pt(60000, TD, '02:00'), pt(70000, '2026-08-21', '02:00')], TD) === false,
        '뷰 현재가가 오늘 관측가와 다르면 탈락 (묵은 옵션 값을 현재가로 찍지 않는다)');

  check(todayDropConfirmed({ current_price: 9900, prev_price: 12900 }, [pt(9900, TD, '02:00')], TD) === false,
        '비교할 직전 관측이 없으면 탈락');

  check(todayDropConfirmed({ current_price: 9900, prev_price: 8000 }, [pt(9900, TD, '02:00'), pt(8000, '2026-08-21', '02:00')], TD) === false,
        '직전보다 올랐으면 탈락');

  check(todayDropConfirmed({ current_price: 9500, prev_price: 12900 }, [pt(9900, TD, '02:00'), pt(9500, TD, '06:00'), pt(12900, '2026-08-21', '02:00')], TD) === true,
        '같은 날 여러 기록이면 늦게 관측된 값을 오늘 가격으로 본다');

  check(todayDropConfirmed({ current_price: 9900, prev_price: 12900 }, [pt(9900, TD, '02:00'), pt(5000, '2026-08-23', '02:00'), pt(12900, '2026-08-21', '02:00')], TD) === true,
        '미래 날짜 기록은 근거로 쓰지 않는다');

  check(todayDropConfirmed({ current_price: 9900, prev_price: 12900 }, [], TD) === false, '기록이 없으면 탈락');
  check(todayDropConfirmed({ current_price: 9900, prev_price: 12900 }, undefined, TD) === false, 'undefined 면 탈락');
  check(todayDropConfirmed({ current_price: 0, prev_price: 100 }, [pt(0, TD, '02:00')], TD) === false, '현재가가 0 이면 탈락');
  check(todayDropConfirmed({ current_price: 9900, prev_price: 12900 }, [pt(9900, TD, '02:00')], '') === false, 'today 가 비면 탈락');

  /*
   * 조건 D — 화면에 찍을 이전 기록가가 원장의 직전 관측과 같아야 한다.
   *
   * 뷰의 prev_price 는 같은 vid 의 직전 관측이라 날짜를 보지 않는다. 옵션이
   * 바뀌면 며칠~몇 주 전 값이 이전 기록가 자리에 온다.
   */
  // 운영 실측: pid=9500290355 샤오미 패드 — 뷰 prev 219,800 은 같은 vid 의 7/31 값,
  // 원장의 직전 관측(8/21)은 229,800 이었다. 카드는 -0.4%, 실제는 -4.7%.
  check(todayDropConfirmed({ current_price: 219000, prev_price: 219800 },
                           [pt(219000, TD, '02:00'), pt(229800, '2026-08-21', '02:00')], TD) === false,
        '뷰 prev_price 가 원장의 직전 관측과 다르면 탈락 (샤오미 패드 실제 사례)');

  // 운영 실측: pid=7014943794 크리넥스 — 뷰 prev 4,470 은 8/20 값, 직전 관측(8/21)은 5,580.
  check(todayDropConfirmed({ current_price: 4460, prev_price: 4470 },
                           [pt(4460, TD, '02:00'), pt(5580, '2026-08-21', '02:00'), pt(4470, '2026-08-20', '02:00')], TD) === false,
        '직전 관측을 건너뛴 더 오래된 값이 prev_price 면 탈락 (크리넥스 실제 사례)');

  // 같은 상황에서 뷰가 실제 직전 관측을 가리키면 통과한다 (근거가 맞으면 막지 않는다).
  check(todayDropConfirmed({ current_price: 4460, prev_price: 5580 },
                           [pt(4460, TD, '02:00'), pt(5580, '2026-08-21', '02:00'), pt(4470, '2026-08-20', '02:00')], TD) === true,
        'prev_price 가 원장의 직전 관측과 일치하면 통과');

  // 옵션이 바뀌었어도 값 근거만 맞으면 통과한다 (vid 변경 자체를 벌하지 않는다).
  check(todayDropConfirmed({ current_price: 9900, prev_price: 12900 },
                           [pt(9900, TD, '02:00'), pt(12900, '2026-08-21', '02:00')], TD) === true,
        '옵션 교체 여부와 무관하게 근거가 맞으면 통과');

  check(todayDropConfirmed({ current_price: 9900 }, [pt(9900, TD, '02:00'), pt(12900, '2026-08-21', '02:00')], TD) === false,
        'prev_price 가 아예 없는 행은 탈락 (근거 없이 이전 기록가를 찍지 않는다)');

  /* ================================================================
   *  수집 리포트 HTML — buildReportHtml
   * ================================================================ */
  /* ================================================================
   *  price_history.source — 기록 경로 추적
   *
   *  Daily Collection Report 의 수집 성공률은 collector 가 확보한 상품만
   *  세어야 한다. 그 전제로, 모든 쓰기 경로가 자기 출처를 남기는지 고정한다.
   *  (supabase/2026-09-01-price-history-source.sql)
   * ================================================================ */
  section('price_history.source — 경로별 출처 기록');

  /** 마지막으로 price_history 에 기록된 행의 source. */
  function recordedSource(productId) {
    const row = db.upserts.price_history.filter(r => String(r.product_id) === String(productId)).pop();
    return row ? row.source : undefined;
  }

  reset();
  await recordPrices([obs('9001', 30000)], { label: 'collect:쿠팡', source: 'collect' });
  check(recordedSource('9001') === 'collect', "★ collector 가 쓴 행은 source='collect'", recordedSource('9001'));

  reset();
  await saveProducts('수영복', [{ productId: '9002', mall: '쿠팡', title: '수영복 상품', lprice: 30000 }], { from: 'api', source: 'search' });
  check(recordedSource('9002') === 'search', "★ 사용자 검색이 쓴 행은 source='search'", recordedSource('9002'));

  reset();
  await saveProducts('추천', [{ productId: '9003', mall: '쿠팡', title: '추천 상품', lprice: 30000 }], { from: 'api', source: 'ai' });
  check(recordedSource('9003') === 'ai', "★ AI 가 쓴 행은 source='ai'", recordedSource('9003'));

  reset();
  await saveProducts('키워드', [{ productId: '9004', mall: '쿠팡', title: '키워드 상품', lprice: 30000 }], { from: 'api', source: 'cron' });
  check(recordedSource('9004') === 'cron', "★ Vercel cron 이 쓴 행은 source='cron'", recordedSource('9004'));

  reset();
  await recordPrices([obs('9005', 30000)], { label: 'import', source: 'import' });
  check(recordedSource('9005') === 'import', "★ 수동 임포트가 쓴 행은 source='import'", recordedSource('9005'));

  reset();
  await recordPrices([obs('9006', 30000)], { label: '출처 미지정' });
  check(recordedSource('9006') === '', '출처를 안 넘기면 빈 문자열 (임의로 collect 로 채우지 않는다)',
        JSON.stringify(recordedSource('9006')));

  /*
   * ★ Test 7 — 같은 상품·같은 날에 두 경로가 쓰면 source 는 마지막 것만 남는다.
   *
   *   활성 UNIQUE (pid, mall, vid, recorded_date) 때문에 뒤 쓰기가 앞 행을
   *   덮기 때문이다. 이건 버그가 아니라 이 컬럼의 한계이고, 그래서 수집기
   *   성공률의 근거로 쓰지 않는다(근거는 price_job_state.collectorCovered).
   *   이 테스트는 그 한계를 문서가 아니라 코드로 고정해 둔다.
   */
  reset();
  await recordPrices([obs('9007', 30000)], { label: 'collect:쿠팡', source: 'collect' });
  await recordPrices([obs('9007', 29000)], { label: '수영복', source: 'search' });
  check(recordedSource('9007') === 'search',
        '★ 같은 날 뒤에 쓴 경로가 source 를 덮는다 — source 는 "마지막 기록자"다');
  check(db.upserts.price_history.filter(r => String(r.product_id) === '9007').length === 2,
        '  (두 번의 쓰기가 같은 행을 대상으로 나갔다)');

  /* ================================================================
   *  recordPrices.recordedKeys — "가격을 확보했다" 의 판정 근거
   *
   *  수집기의 collectorCovered 가 이 값만 보고 채워진다. 그래서 여기서
   *  suspect / rejected / 저장 실패의 처리 기준을 못 박는다.
   * ================================================================ */
  section('recordedKeys — 원장에 실제로 남은 상품만 "확보"로 센다');

  reset();
  r = await recordPrices([obs('8001', 30000)], { label: 'collect:쿠팡', source: 'collect' });
  check(Array.isArray(r.recordedKeys) && r.recordedKeys.includes('8001|쿠팡'),
        '★ 정상 저장된 상품은 recordedKeys 에 들어간다', JSON.stringify(r.recordedKeys));

  /*
   * ★ Test 14-a — rejected 는 "확보 실패" 다.
   *   값이 거부되면 price_history 에 행이 남지 않는다. 응답에 상품이
   *   나왔다는 이유로 성공률에 세면 "확보했다" 가 거짓이 된다.
   */
  reset();
  seedHistory('8002', '쿠팡', 30000, 1);
  r = await recordPrices([obs('8002', 0)], { label: 'collect:쿠팡', source: 'collect' });
  check(r.rejected === 1 && r.recordedKeys.length === 0,
        '★★ rejected 는 recordedKeys 에 들어가지 않는다 (= 확보 실패)', JSON.stringify(r));

  /*
   * ★ Test 14-b — suspect 는 "확보 성공" 이다.
   *   급변이라 products 현재가 반영만 보류할 뿐, price_history 에는
   *   관측이 정상적으로 기록된다. 원장에 오늘 가격이 있으므로 확보가 맞다.
   */
  reset();
  seedHistory('8003', '쿠팡', 34500, 1);
  db.products.push({ product_id: '8003', mall: '쿠팡', vendor_item_id: '111' });
  r = await recordPrices([obs('8003', 1528000)], { label: 'collect:쿠팡', source: 'collect' });
  check(r.suspect === 1 && r.recordedKeys.includes('8003|쿠팡'),
        '★★ suspect 는 recordedKeys 에 들어간다 (원장에 기록되므로 확보 성공)', JSON.stringify(r));
  check(currentPrice('8003') === null,
        '  (products 현재가는 여전히 보류 — 두 개념을 섞지 않는다)');

  reset();
  r = await recordPrices([obs('8004', 30000), obs('8004', 30000)], { label: 'collect:쿠팡', source: 'collect' });
  check(r.recordedKeys.length === 1,
        '★ 같은 상품이 여러 번 들어와도 recordedKeys 는 1개 (중복 제거)', JSON.stringify(r.recordedKeys));

  /* ================================================================ */
  section('수집 리포트. buildReportHtml — 필수 항목 포함');

  const { buildReportHtml, reportInvariantErrors, productSuccessRate } = require('./collect-all-prices');

  /*
   * ★ 픽스처는 반드시 불변조건을 만족하는 값이어야 한다 (2026-09-01).
   *   예전 픽스처는 실패 원인 합계(20)와 실패 수가 아예 무관한 값이었고,
   *   그래서 운영 메일의 "실패 26 / 원인 합계 151" 모순을 테스트가 못 잡았다.
   *
   *   상품:    성공 824 + 미수집 126 = 대상 950
   *   attempt: 성공 280 + 실패 20 = 300,  실패 20 = 2+15+3
   *   행:      저장 680 ≥ 갱신 674
   */
  const sampleReport = {
    execAt: '2026-08-21 01:15 KST',
    date: '2026-08-21',
    productsTotal: 800,
    otherTotal: 30,
    otherByMall: { '네이버': 30 },
    malls: [
      { mallName: '쿠팡', targetProducts: 750, collectorSuccessProducts: 630, todayPriceProducts: 650, uncoveredProducts: 100,
        attemptCalls: 230, attemptSuccess: 215, attemptFailed: 15, recorded: 620, status: 'completed' },
      { mallName: 'ADPICK', targetProducts: 200, collectorSuccessProducts: 170, todayPriceProducts: 174, uncoveredProducts: 26,
        attemptCalls: 70, attemptSuccess: 65, attemptFailed: 5, recorded: 60, status: 'completed' }
    ],
    failCats: { blocked: 2, noMatch: 15, network: 3 },
    targetProducts: 950,
    collectorSuccessProducts: 800,
    collectorMissingProducts: 150,
    todayPriceProducts: 824,
    uncoveredProducts: 126,
    attemptCalls: 300,
    attemptSuccess: 280,
    attemptFailed: 20,
    recorded: 680,
    saved: 674,
    suspect: 6,
    rejected: 0,
    processedProducts: 900
  };

  check(reportInvariantErrors(sampleReport).length === 0,
        '★ 샘플 리포트가 불변조건을 전부 만족한다',
        JSON.stringify(reportInvariantErrors(sampleReport)));

  const html = buildReportHtml(sampleReport);
  check(typeof html === 'string' && html.length > 100, 'HTML 문자열을 반환한다');
  check(html.includes('2026-08-21'), '기준 날짜(KST)가 포함된다');
  check(html.includes('01:15 KST'), '실행 시각(KST)이 포함된다');
  check(html.includes('84.2% (800/950)'),
        '★ 헤드라인은 collector 전용 수집 성공률(800/950)이다');
  check(html.includes('86.7% (824/950)'),
        '★ 오늘 가격 보유율(824/950)은 별도 지표로 함께 표시된다');
  check(html.includes('상품 기준 수집 성공률') && html.includes('오늘 가격 보유율'),
        '★ 두 지표를 서로 다른 이름으로 표시한다 (같은 이름 금지)');
  check(html.includes('사용자 검색 · Vercel cron · AI 가 남긴 가격은 포함하지 않는다'),
        '★ 수집 성공률이 무엇을 제외하는지 메일에 명시한다');
  check(html.includes('단위: 상품') && html.includes('단위: attempt'),
        '★ 상품 단위 / attempt 단위 섹션이 각각 단위를 밝힌다');
  check(html.includes('수집 attempt (실제 API 호출)') && !html.includes('가격 수집 시도'),
        '★ 시도 항목의 이름이 attempt 단위임을 드러낸다 (옛 명칭 "가격 수집 시도" 는 쓰지 않는다)');
  check(html.includes('처리 상품 수') && html.includes('>900<'),
        '★ 상품 처리량은 "처리 상품 수" 로 따로 표기된다 (호출 수와 섞지 않는다)');
  check(html.includes('price_history upsert 행 (신규+갱신)') && !html.includes('price_history 신규 저장'),
        '★ 저장 행은 upsert 대상 행임을 밝힌다 (DB 신규 row 수와 다를 수 있다)');
  check(html.includes('UNIQUE 제약'),
        '같은 날 재수집이 기존 행을 덮을 수 있다는 주석이 메일에 있다');
  check(html.includes('성공 attempt 280 + 실패 attempt 20 = 수집 attempt 300'),
        '★ 성공/실패 attempt 합이 전체 attempt 와 같음을 메일에 직접 적는다');

  /* ── 집계 검증 블록 — 세 항등식이 전부 OK 로 찍힌다 ────────────── */
  check(html.includes('집계 검증'), '집계 검증 블록이 있다');
  check(html.includes('수집 성공 상품 + 수집 미확보 상품 = 대상 상품')
     && html.includes('오늘 가격 보유 + 미보유 = 대상 상품')
     && html.includes('수집 성공 상품 ≤ 오늘 가격 보유 상품')
     && html.includes('성공 attempt + 실패 attempt = 전체 attempt')
     && html.includes('모든 failure reason 합계 = 실패 attempt'),
        '★ 다섯 불변조건이 메일에 각각 표시된다');
  check((html.match(/>OK</g) || []).length === 5 && !html.includes('>NG<'),
        '★ 정상 리포트에서는 다섯 검증이 모두 OK 로 찍힌다');
  check(html.includes('총 실패 attempt'), '실패 항목이 attempt 단위로 표기된다');
  check(html.includes('실패 원인 합계 20 = 총 실패 attempt 20'),
        '★ 실패 원인 합계와 총 실패 attempt 가 같음을 메일에 직접 적는다');
  check(html.includes('수집 성공 800 + 수집 미확보 150 = 대상 950'),
        '★ collector 축 합이 대상과 같음을 메일에 직접 적는다');
  check(html.includes('가격 보유 824 + 미보유 126 = 대상 950'),
        '★ 모든 경로 축 합이 대상과 같음을 메일에 직접 적는다');
  check(html.includes('두 축의 차이 24개는 이 수집기가 아닌 경로'),
        '★ 두 축의 차이가 어디서 왔는지 메일이 설명한다');
  check(html.includes('800'), 'products 전체 수가 포함된다');
  check(html.includes('680'), '전체 저장 수가 포함된다');
  check(html.includes('쿠팡') && html.includes('ADPICK'), '몰별 결과에 쿠팡·ADPICK 이 각각 표시된다');
  check(html.includes('620') && html.includes('60'), '몰별 저장 수가 각각 표시된다');
  check(html.includes('blocked'), '실패 원인별 카테고리가 포함된다');
  check(html.includes('noMatch'), 'noMatch 카테고리가 포함된다');
  check(html.includes('SEOSA'), 'SEOSA 브랜딩이 포함된다');

  // 실패 attempt 가 하나도 없는 실행
  const cleanReport = { ...sampleReport, failCats: {}, attemptFailed: 0, attemptSuccess: 300 };
  const cleanHtml = buildReportHtml(cleanReport);
  check(cleanHtml.includes('실패 attempt 없음'), '실패 원인이 없으면 "실패 attempt 없음" 표시');
  check(reportInvariantErrors(cleanReport).length === 0, '실패 0인 리포트도 불변조건을 만족한다');

  /* ── 불변조건 위반은 반드시 검출되고 메일에 경고가 붙는다 ────────── */
  section('수집 리포트. 불변조건 위반 검출 — 2026-09-01 실제 사고 재현');

  /*
   * 2026-09-01 21:19Z 실행이 실제로 보낸 메일의 형태:
   *   실패(검색어) 26  ↔  실패 원인 blocked 23 / staleCache 3 / noMatch 125
   * 실패 수는 검색어 단위, noMatch 는 상품 단위였다. 이제 이런 리포트는
   * 검사에서 걸리고, 메일 맨 위에 경고 배너가 붙는다.
   */
  const mixedUnits = {
    ...sampleReport,
    attemptFailed: 26,
    attemptSuccess: 310,
    attemptCalls: 336,
    failCats: { blocked: 23, staleCache: 3, noMatch: 125 }
  };
  const mixedErrors = reportInvariantErrors(mixedUnits);
  check(mixedErrors.length > 0, '★ 실패 26 ↔ 원인 합계 151 인 리포트를 위반으로 잡는다');
  check(mixedErrors.some(e => e.includes('151')), '위반 메시지가 실제 합계(151)를 알려준다', mixedErrors.join(' | '));
  const mixedHtml = buildReportHtml({ ...mixedUnits, invariantErrors: mixedErrors });
  check(mixedHtml.includes('집계 불변조건 위반'),
        '★ 위반이 있으면 메일 맨 위에 경고 배너가 붙는다');
  check(mixedHtml.includes('>NG<'),
        '★ 집계 검증 블록이 해당 항목을 NG 로 찍는다');

  const brokenProducts = { ...sampleReport, collectorSuccessProducts: 824, collectorMissingProducts: 873, targetProducts: 1455 };
  check(reportInvariantErrors(brokenProducts).some(e => e.includes('상품 단위(collector)')),
        '★ 수집 성공 + 미확보 ≠ 대상 이면 위반으로 잡는다');

  check(Math.abs(productSuccessRate({ targetProducts: 1455, collectorSuccessProducts: 582 }) - 40.0) < 0.05,
        '★ 성공률 계산식은 그대로다 — 582/1455 = 40.0%');
  check(productSuccessRate({ targetProducts: 0, collectorSuccessProducts: 0 }) === 100,
        '대상이 0이면 100% (0으로 나누지 않는다)');

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
  /*
   * collapseToDaily 는 이제 _price.observedKstDate 를 쓴다 (KST 관측일 기준).
   * 잘라낸 조각만 평가하므로 그 의존성을 인자로 넣어 준다 — 실제 함수를
   * 그대로 주입하기 때문에 판정 규칙이 갈라질 여지는 없다.
   */
  // eslint-disable-next-line no-new-func
  const fn = new Function('observedKstDate', `${m[0]}; return collapseToDaily;`)(observedKstDate);
  return { collapse: fn };
}
