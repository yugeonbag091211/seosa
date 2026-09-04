#!/usr/bin/env node
/*
 * 가격 데이터 신뢰성 회귀 테스트 — 쿠팡 호출 0회 / 운영 Supabase 접근 0회.
 *
 *   node scripts/test-price-integrity.js
 *
 * ── 무엇을 지키는 테스트인가 ──────────────────────────────────────
 *
 * 2026-09-04 감사에서 확인한 세 가지가 다시 생기면 이 테스트가 깨진다.
 *
 *   ① 옵션 혼합
 *      같은 product_id 아래 여러 vendor_item_id 의 가격이 한 곡선으로
 *      합쳐졌다. 운영 실측: (product_id, mall) 조합 3,220개 중 714개가
 *      실제 vid 2종 이상, 그중 301개는 "역대 최저" 가 지금 파는 옵션의
 *      값이 아니었다. 대표 사례 8082654809 — 15,900원(28회)과
 *      222,390~242,100원(2회)이 한 상품의 이력으로 섞여 있었다.
 *
 *   ② 하루만 본 값으로 "역대 최저" 확정
 *      대표 사례 7912306911 / vendorItemId 88764198511 —
 *      쿠팡 파트너스 API 가 준 22,320원은 26일 기록 중 그날 하루만
 *      관측된 값인데, 코드가 곧바로 "관측한 26일 기록에서 가장 낮은
 *      가격이다 · 지금 사도 좋다" 로 확정했다. 같은 시각 상품 페이지
 *      가격은 26,900원(와우 쿠폰가 23,610원)이었다.
 *
 *   ③ 가격 종류에 대한 미확인 단정
 *      화면이 "배송비·쿠폰·카드 할인은 포함되지 않았어요" 라고 적었다.
 *      쿠팡 파트너스 검색 API 응답에는 가격 종류를 말해 주는 필드가
 *      없으므로(productPrice 하나뿐) 확인할 수 없는 주장이다.
 *
 * Supabase 는 require 캐시에 가짜 클라이언트를 심어 대체한다. 실제 DB 에
 * 붙지 않으므로 CI 에서도 환경변수 없이 돌아간다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

/* ------------------------------------------------------------------ *
 *  가짜 Supabase (scripts/test-price.js 와 같은 방식)
 * ------------------------------------------------------------------ */
const db = { price_history: [], products: [] };

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function makeQuery(table) {
  const filters = { in: null, eq: [], neq: [], gte: [], lt: [] };
  let sort = null, cap = null, rangeFrom = null, rangeTo = null;
  const q = {
    select() { return q; },
    order(col, opts) { sort = { col, asc: !opts || opts.ascending !== false }; return q; },
    limit(n) { cap = n; return q; },
    in(col, vals) { filters.in = { col, vals: vals.map(String) }; return q; },
    eq(col, v) { filters.eq.push({ col, v }); return q; },
    neq(col, v) { filters.neq.push({ col, v }); return q; },
    gte(col, v) { filters.gte.push({ col, v }); return q; },
    lt(col, v) { filters.lt.push({ col, v }); return q; },
    range(from, to) { rangeFrom = from; rangeTo = to; return q; },
    then(resolve, reject) {
      let rows = db[table] || [];
      if (filters.in) rows = rows.filter(r => filters.in.vals.indexOf(String(r[filters.in.col])) > -1);
      filters.eq.forEach(f => { rows = rows.filter(r => String(r[f.col] || '') === String(f.v)); });
      filters.neq.forEach(f => { rows = rows.filter(r => String(r[f.col] || '') !== String(f.v)); });
      filters.gte.forEach(f => { rows = rows.filter(r => cmp(r[f.col], f.v) >= 0); });
      filters.lt.forEach(f => { rows = rows.filter(r => cmp(r[f.col], f.v) < 0); });
      if (sort) rows = rows.slice().sort((a, b) => (sort.asc ? 1 : -1) * cmp(a[sort.col], b[sort.col]));
      if (cap !== null) rows = rows.slice(0, cap);
      if (rangeFrom !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
  };
  return q;
}

const fakeSupabase = {
  from(table) { return makeQuery(table); },
  rpc() { return Promise.resolve({ data: null, error: null }); }
};

const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

const { sameVendorRows, observedKstDate, kstToday } = require('../api/_price');
const { statsFrom, loadStats, LOW_CONFIRM_DAYS } = require('../api/_pricestat');
const { dealOf, DEAL_ORDER } = require('../api/_deal');
const productPage = require('../api/_product-page');

/* ------------------------------------------------------------------ *
 *  유틸
 * ------------------------------------------------------------------ */
let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function section(name) { console.log(`\n${name}`); }

const TODAY = kstToday();
function daysAgo(n) { return kstToday(new Date(Date.now() - n * 86400000)); }

/**
 * KST 로 n일 전 특정 시각의 절대 시각(ISO).
 *
 * 기본 03:00 은 실제 수집 크론이 도는 시간대다. 그 시각의 UTC 날짜는
 * KST 날짜보다 하루 이르므로, 아래 픽스처는 운영 DB 의 라벨 어긋남을
 * 그대로 재현한다 (읽기 경로가 라벨을 믿지 않는지 검증된다).
 */
function atKst(n, hour) {
  const kstMidnight = Date.parse(daysAgo(n) + 'T00:00:00Z') - 9 * 3600e3;
  return new Date(kstMidnight + (hour == null ? 3 : hour) * 3600e3).toISOString();
}

function row(pid, vid, price, nDaysAgo, hour) {
  const at = atKst(nDaysAgo, hour);
  return {
    product_id: pid, mall: '쿠팡', vendor_item_id: vid, price,
    recorded_at: at,
    // ★ 라벨은 일부러 UTC 로 자른다 — 운영 DB 의 트리거가 아직 그렇다.
    recorded_date: at.slice(0, 10)
  };
}

function pts(list) { return list.map(([date, price]) => ({ date, price })); }

/**
 * 주석을 걷어낸 소스.
 *
 * "이 코드가 없어야 한다" 를 정적으로 검사할 때 필요하다. 이 저장소는 주석에
 * "예전에는 byKey.set(key, r) 이었다" 처럼 옛 코드를 그대로 인용해 두는데,
 * 그걸 그대로 훑으면 고쳐 놓고도 FAIL 이 난다(실제로 났다). 기록을 지우는
 * 대신 검사 쪽에서 주석을 빼고 본다.
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* ================================================================== *
 *  CASE 1. 같은 productId + 다른 vendorItemId → 가격이 섞이지 않는다
 * ================================================================== */
async function case1() {
  section('CASE 1. 같은 productId · 다른 vendorItemId — 곡선이 섞이지 않는다');

  // 운영 실측 8082654809 를 그대로 옮긴 픽스처.
  const PID = '8082654809';
  const MAIN = '95768196637';   // 지금 파는 옵션 15,900원
  const OTHER = '91193685703';  // 다른 옵션 222,390~242,100원
  db.price_history = [
    row(PID, MAIN, 15900, 9), row(PID, MAIN, 15900, 8), row(PID, MAIN, 15900, 7),
    row(PID, OTHER, 242100, 6), row(PID, OTHER, 222390, 5),
    row(PID, MAIN, 15900, 2), row(PID, MAIN, 15900, 1), row(PID, MAIN, 15900, 0)
  ];
  db.products = [{
    product_id: PID, mall: '쿠팡', vendor_item_id: MAIN, item_id: '1',
    title: '테스트 이어폰', lprice: 15900, link: 'https://link.coupang.com/re/AFF?x=1',
    keyword: '이어폰', collected_at: new Date().toISOString(), image: ''
  }];

  const v = await productPage._internal.buildView(PID, '쿠팡');
  const prices = v.points.map(p => p.price);
  check(prices.every(p => p === 15900),
    '상품 페이지 곡선에 다른 옵션 가격이 없다',
    `점 ${v.points.length}개 · 값 ${[...new Set(prices)].join(',')}`);
  check(v.stat.high === 15900, '최고가가 다른 옵션 값(242,100)이 아니다', `high=${v.stat.high}`);
  check(v.stat.low === 15900, '최저가가 다른 옵션 값(222,390)이 아니다', `low=${v.stat.low}`);

  const stats = await loadStats([{ productId: PID, mall: '쿠팡', vendorItemId: MAIN }]);
  const st = stats.get(`${PID}|쿠팡`);
  check(!!st && st.high === 15900 && st.low === 15900,
    'AI 근거(loadStats)도 같은 옵션만 본다', st ? `low=${st.low} high=${st.high}` : '통계 없음');

  // 반대편 옵션으로 물으면 그 옵션의 값만 나와야 한다.
  const other = await loadStats([{ productId: PID, mall: '쿠팡', vendorItemId: OTHER }]);
  const so = other.get(`${PID}|쿠팡`);
  check(!!so && so.low === 222390 && so.high === 242100,
    '다른 옵션으로 물으면 그 옵션의 값만 나온다', so ? `low=${so.low} high=${so.high}` : '통계 없음');
}

/* ================================================================== *
 *  CASE 2. 현재 가격 = 마지막 유효 관측값 (과거 최저로 대체되지 않는다)
 * ================================================================== */
async function case2() {
  section('CASE 2. 현재 가격은 마지막 관측값 — 과거 최저가로 바뀌지 않는다');

  const PID = '700000001', VID = '900000001';
  // 과거에 22,320원을 이틀 봤고(확인된 최저), 지금은 26,900원이다.
  db.price_history = [
    row(PID, VID, 22320, 20), row(PID, VID, 22320, 19),
    row(PID, VID, 24550, 10), row(PID, VID, 26680, 3),
    row(PID, VID, 26900, 0)
  ];
  db.products = [{
    product_id: PID, mall: '쿠팡', vendor_item_id: VID, item_id: '1',
    title: '테스트 샤워기', lprice: 26900, link: 'https://link.coupang.com/re/AFF?x=1',
    keyword: '샤워기', collected_at: new Date().toISOString(), image: ''
  }];

  const v = await productPage._internal.buildView(PID, '쿠팡');
  check(v.price === 26900, '현재가 = 마지막 관측 26,900원', `price=${v.price}`);
  check(v.stat.low === 22320, '과거 최저는 22,320원으로 따로 남는다', `low=${v.stat.low}`);
  check(v.price !== v.stat.low, '현재가와 과거 최저가 서로 다른 값으로 유지된다');
  check(v.stat.lastPrice === 26900, 'lastPrice 도 마지막 관측값이다', `lastPrice=${v.stat.lastPrice}`);

  const meta = productPage._internal.describeForMeta(v);
  check(meta.indexOf('26,900원') > -1 && meta.indexOf('최저 22,320원') > -1,
    '메타 설명이 현재가와 최저가를 구분해 적는다', meta.slice(0, 80));
}

/* ================================================================== *
 *  CASE 3. 가격 종류를 모르면 모른다고 말한다
 * ================================================================== */
function case3() {
  section('CASE 3. 가격 종류(정가/쿠폰가/회원가)를 추측하지 않는다');

  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_product-page.js'), 'utf8');
  const front = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  /*
   * 확인할 수 없는 단정이 화면 문구로 돌아오면 깨진다.
   * 주석에는 "예전에 이런 문구였다" 는 기록이 남아 있어도 되므로,
   * 실제 출력 위치(템플릿 리터럴 · HTML 조각)에 있는지만 본다.
   */
  const bad = '쿠폰·카드 할인은 포함되지 않았어요';
  check(src.indexOf('">' + bad) < 0 && src.indexOf(bad + '</div>') < 0
    && src.indexOf('일, SEOSA 가 매일 수집한 값. 배송비·' + bad) < 0,
    `상품 페이지 문구에 미확인 단정이 없다: "${bad}"`);
  check(front.indexOf('가격은 <b>상품가 기준</b>') < 0,
    '비교표가 "상품가 기준" 이라고 단정하지 않는다');

  check(/PRICE_SOURCE_NOTE/.test(src), '가격 출처 문구가 한 상수로 모여 있다');
  const note = (src.match(/const PRICE_SOURCE_NOTE = ([\s\S]*?);\r?\n/) || [])[1] || '';
  check(/알려주지 않아/.test(note),
    '문구가 "가격 종류를 모른다" 는 사실을 밝힌다');
  check(/실제 결제 금액은 판매처에서 확인/.test(note),
    '문구가 실제 결제 금액 확인을 안내한다');

  // 코드가 응답에 없는 가격 필드를 지어내지 않는지.
  const coupang = fs.readFileSync(path.join(__dirname, '..', 'api', '_coupang.js'), 'utf8');
  ['couponPrice', 'membershipPrice', 'wowPrice', 'finalPrice', 'salePrice'].forEach(f => {
    check(coupang.indexOf(f) < 0, `응답에 없는 가격 필드를 읽지 않는다: ${f}`);
  });
}

/* ================================================================== *
 *  CASE 4. KST 날짜 경계
 * ================================================================== */
function case4() {
  section('CASE 4. KST 날짜 경계 — 라벨이 아니라 관측 시각으로 접는다');

  // 운영 DB 는 recorded_date 를 UTC 로 자른다. KST 04:00 관측은 라벨이 전날이다.
  const at = atKst(0, 4);                       // KST 오늘 04:00
  const label = at.slice(0, 10);                // UTC 로 자른 라벨 = 어제
  const pt = { recorded_at: at, recorded_date: label };
  check(label !== TODAY, '이 픽스처가 실제로 라벨 어긋남을 재현한다', `라벨=${label} / KST=${TODAY}`);
  check(observedKstDate(pt) === TODAY,
    'KST 04:00 관측이 오늘로 접힌다', `라벨=${label} → 판정=${observedKstDate(pt)}`);

  // KST 23:00 관측은 라벨과 KST 가 같다.
  const at2 = atKst(0, 23);
  const pt2 = { recorded_at: at2, recorded_date: at2.slice(0, 10) };
  check(observedKstDate(pt2) === TODAY, 'KST 23:00 관측도 같은 날로 접힌다');

  // 같은 KST 하루에 라벨이 둘로 갈린 두 행이 하루 한 점으로 접히는가.
  const merged = new Set([pt, pt2].map(observedKstDate));
  check(merged.size === 1, '라벨이 갈려도 KST 하루는 한 점이다', `점 ${merged.size}개`);

  // 그 두 행이 실제로 통계에서 하루 한 점이 되는가 (같은 날 최저가 한 점).
  const st = statsFrom([
    { date: observedKstDate(pt), price: 1000 },
    { date: daysAgo(1), price: 900 }
  ]);
  check(st.count === 2, '날짜가 다른 점은 그대로 두 점이다', `count=${st.count}`);
}

/* ================================================================== *
 *  CASE 5. 7일 통계는 정의된 7일만 쓴다
 * ================================================================== */
function case5() {
  section('CASE 5. 7일 통계 — 정의된 창 밖의 값이 들어오지 않는다');

  // 창(오늘 포함 7일) 안: 6일 전 ~ 오늘. 밖: 8일 전 · 30일 전.
  const st = statsFrom(pts([
    [daysAgo(30), 10000],   // 창 밖
    [daysAgo(8), 50000],    // 7일 창 밖 — trend·avg7 에 들어오면 안 된다
    [daysAgo(6), 20000],    // 창 시작
    [daysAgo(3), 20000],
    [daysAgo(0), 19000]
  ]));

  check(st.avg7Days === 3, '7일 평균이 창 안 3점만 쓴다', `avg7Days=${st.avg7Days}`);
  check(st.avg7 === Math.round((20000 + 20000 + 19000) / 3),
    '7일 평균 값이 창 안 점들의 평균이다', `avg7=${st.avg7}`);
  check(st.trendFrom === 20000,
    '추세 시작점이 창 안 첫 점(20,000)이다 — 창 밖 50,000 이 아니다', `trendFrom=${st.trendFrom}`);
  check(st.trendDays === 6, '추세 기간이 창 안 실제 간격이다', `trendDays=${st.trendDays}`);
  check(st.trendFromDate === daysAgo(6), '추세 시작 날짜가 창 시작이다', st.trendFromDate);

  // 창 안 점이 하나뿐이면 직전 점과 비교한다(기존 동작) — 그때도 더 옛 점을 쓰지 않는다.
  const one = statsFrom(pts([[daysAgo(40), 90000], [daysAgo(20), 30000], [daysAgo(0), 28000]]));
  check(one.trendFrom === 30000, '창 안 점이 하나면 바로 직전 점과 비교한다', `trendFrom=${one.trendFrom}`);
}

/* ================================================================== *
 *  CASE 6. 옵션 계열 분리 규칙 자체
 * ================================================================== */
function case6() {
  section('CASE 6. sameVendorRows — 현재 옵션이 아닌 값이 섞이지 않는다');

  const rows = [
    { vendor_item_id: 'A', price: 100 },
    { vendor_item_id: 'B', price: 999 },
    { vendor_item_id: '', price: 500 },
    { vendor_item_id: '__LEGACY__', price: 400 }
  ];

  const a = sameVendorRows(rows, 'A');
  check(a.length === 1 && a[0].price === 100, '① 우리 옵션 행이 있으면 그것만 쓴다', `${a.length}행`);

  const c = sameVendorRows(rows, 'C');
  check(c.length === 0, '② 우리 옵션 행이 없고 남의 옵션 행이 있으면 빈 계열', `${c.length}행`);

  const legacyOnly = [{ vendor_item_id: '', price: 500 }, { vendor_item_id: '__LEGACY__', price: 400 }];
  check(sameVendorRows(legacyOnly, 'A').length === 2,
    '③ 옵션 표시가 하나도 없으면 예전처럼 전부 쓴다');

  check(sameVendorRows(rows, '').length === 4, 'vid 를 모르면 좁히지 않는다');
  check(sameVendorRows(rows, null).length === 4, 'vid 가 null 이어도 좁히지 않는다');
  check(sameVendorRows(null, 'A').length === 0, 'rows 가 없으면 빈 배열');
  check(sameVendorRows(rows, 'A') !== rows, '원본 배열을 제자리에서 바꾸지 않는다');
  check(rows.length === 4, '원본 배열의 내용이 변하지 않는다');

  // camelCase 필드(프론트에서 온 항목)도 같은 규칙을 탄다.
  check(sameVendorRows([{ vendorItemId: 'A', price: 1 }, { vendorItemId: 'B', price: 2 }], 'A').length === 1,
    'vendorItemId(카멜) 필드도 인식한다');
}

/* ================================================================== *
 *  CASE 7. 하루만 관측된 신저가는 "역대 최저" 로 확정하지 않는다
 * ================================================================== */
function case7() {
  section('CASE 7. 1회 관측 신저가 — "확인 중" 으로 다룬다');

  // 7912306911 의 실제 계열을 옮긴 픽스처 (마지막 22,320원은 그날 하루뿐).
  const series = [
    [daysAgo(26), 23350], [daysAgo(25), 25110], [daysAgo(24), 23710],
    [daysAgo(23), 23710], [daysAgo(22), 23710], [daysAgo(21), 24600],
    [daysAgo(16), 24550], [daysAgo(15), 24550], [daysAgo(14), 24550],
    [daysAgo(13), 24550], [daysAgo(12), 24550],
    [daysAgo(5), 26680], [daysAgo(4), 26680],
    [daysAgo(0), 22320]
  ];
  const st = statsFrom(pts(series));
  check(st.low === 22320, '최저가 값 자체는 그대로 보여 준다', `low=${st.low}`);
  check(st.lowCount === 1, '그 값을 하루만 봤다는 사실을 센다', `lowCount=${st.lowCount}`);
  check(st.lowIsLatest === true, '그 최저가 가장 최근 관측임을 표시한다');
  check(st.lowConfirmed === false, '확인되지 않은 최저로 표시된다');

  const deal = dealOf(st, 22320, TODAY);
  const joined = deal.reasons.join(' / ');
  const all = joined + ' / ' + deal.cautions.join(' / ');
  check(joined.indexOf('가장 낮은 가격이다') < 0,
    '"가장 낮은 가격이다" 라고 단정하지 않는다', joined.slice(0, 90));
  check(/확인 중/.test(all), '"확인 중" 이라고 밝힌다');
  check(deal.cautions.some(c => /하루만 관측/.test(c)),
    '하루만 관측됐다는 주의 문구가 붙는다');
  check(DEAL_ORDER[deal.verdict] < DEAL_ORDER.BUY,
    '최고 등급(BUY)을 주지 않는다', `verdict=${deal.verdict} score=${deal.score}`);

  // 같은 값이 다른 날 한 번 더 관측되면 확정된다.
  const confirmedSeries = series.slice(0, -1)
    .concat([[daysAgo(1), 22320], [daysAgo(0), 22320]]);
  const confirmed = statsFrom(pts(confirmedSeries));
  check(confirmed.lowCount >= LOW_CONFIRM_DAYS,
    '두 번 관측되면 lowCount 가 문턱을 넘는다', `lowCount=${confirmed.lowCount}`);
  check(confirmed.lowConfirmed === true, '두 번 관측되면 확인된 최저가 된다');
  const deal2 = dealOf(confirmed, 22320, TODAY);
  check(deal2.reasons.join(' / ').indexOf('가장 낮은 가격이다') > -1,
    '확인된 뒤에는 "가장 낮은 가격이다" 라고 말한다',
    deal2.reasons.join(' / ').slice(0, 90));
  check(deal2.score > deal.score,
    '확인된 최저가 확인 중보다 높은 점수를 받는다', `${deal.score} → ${deal2.score}`);

  // 옛/스텁 통계(lowConfirmed 없음)는 예전 동작 그대로여야 한다.
  const legacy = {
    count: 10, low: 100, lowDate: daysAgo(0), high: 200, highDate: daysAgo(5),
    avg30: 150, avg30Days: 10, avg7: 120, avg7Days: 3, median: 150,
    historyDays: 20, lastPrice: 100, lastDate: TODAY,
    trendPct: -5, trendDays: 5, volatility: 10, firstDate: daysAgo(20)
  };
  const dealLegacy = dealOf(legacy, 100, TODAY);
  check(dealLegacy.cautions.every(c => !/하루만 관측/.test(c)),
    'lowConfirmed 가 없는 통계는 예전대로 판정한다(모르는 것을 단정하지 않는다)');
}

/* ================================================================== *
 *  CASE 8. 정적 검사 — 모든 이력 읽기 경로가 옵션을 가른다
 * ================================================================== */
function case8() {
  section('CASE 8. 이력을 읽는 경로가 모두 옵션 규칙을 쓴다 (정적 검사)');

  [
    ['api/_product-page.js', '상품 페이지 · 딥링크 JSON'],
    ['api/_pricestat.js', 'AI 근거 통계'],
    ['api/history.js', '가격 모달 · 배치'],
    ['scripts/check-alerts.js', '알림 메일']
  ].forEach(([f, label]) => {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    check(/sameVendorRows/.test(src), `${label} (${f}) 가 sameVendorRows 를 쓴다`);
  });

  // 규칙이 한 곳에만 있어야 한다 — 복제되면 한쪽만 고쳐진다.
  const price = fs.readFileSync(path.join(__dirname, '..', 'api', '_price.js'), 'utf8');
  check((price.match(/function sameVendorRows/g) || []).length === 1,
    '옵션 분리 규칙의 구현은 _price.js 한 곳뿐이다');

  // 프론트 배지와 서버 문턱이 같은 값이어야 한다.
  const front = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = front.match(/LOW_CONFIRM_DAYS:\s*(\d+)/);
  check(!!m && Number(m[1]) === LOW_CONFIRM_DAYS,
    '프론트 LOW_CONFIRM_DAYS 가 서버와 같다',
    `front=${m ? m[1] : '없음'} server=${LOW_CONFIRM_DAYS}`);
  check(/확인 중/.test(front) && /atl-badge.unconfirmed/.test(front),
    '카드 배지가 확인되지 않은 최저를 구분해 표시한다');
}

/* ================================================================== *
 *  CASE 9. price_drop_top 소비 경로 — 옵션 정보가 어디서도 새지 않는다
 *
 *  뷰 자체는 (product_id, mall, vendor_item_id) 로 계산하지만 결과 컬럼에
 *  vendor_item_id 가 없다. 그래서 뷰를 나온 뒤에 옵션이 사라졌고,
 *    · api/_facets.js 가 `${pid}|${mall}` 로 덮어써 "마지막 행" 을 붙였다
 *      (운영 실측 2026-09-05: 행 2개 이상 451개 상품, 그중 값이 갈리는 228개)
 *    · api/init.js 의 원장 재검증이 상품 단위(옵션 합산) 이력을 썼다
 *    · 시세판 카드에 vendorItemId 가 없어 모달이 옵션 혼합 곡선을 그렸다
 * ================================================================== */
function case9() {
  section('CASE 9. price_drop_top 소비 경로 — 옵션 정보 유지 (정적 검사)');

  const facets = fs.readFileSync(path.join(__dirname, '..', 'api', '_facets.js'), 'utf8');
  const init = fs.readFileSync(path.join(__dirname, '..', 'api', 'init.js'), 'utf8');
  const front = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // "없어야 한다" 는 실행되는 코드에서만 본다 (stripComments 주석 참고).
  const facetsCode = stripComments(facets);
  const initCode = stripComments(init);

  /* ── TEST D. _facets 가 pid|mall 만으로 마지막 행을 고르지 않는다 ── */
  check(!/byKey\.set\(key,\s*r\)/.test(facetsCode),
    'TEST D · _facets 가 `pid|mall` 키에 행을 덮어쓰지 않는다');
  check(/pickRowForItem/.test(facets), 'TEST D · 행을 고르는 판정 함수가 따로 있다');
  check(/vendorIdOf/.test(facets), 'TEST D · 옵션 식별에 공식 helper(vendorIdOf)를 쓴다');
  check(!/vendorItemId=\(\?:\\d|vendorItemId=\(\\d/.test(facetsCode),
    'TEST D · _facets 안에 vendorItemId 파싱을 새로 만들지 않았다');

  /* ── TEST F. init.js 가 원장 검증에 옵션을 넘긴다 ── */
  check(/vendorItemId:\s*vendorIdOf\(r\)/.test(init),
    'TEST F · loadRecentHistory 호출에 vendorItemId 를 넘긴다');
  check(/sameVendorRows\(points,\s*vendorIdOf\(r\)\)/.test(init),
    'TEST F · todayDropConfirmed 가 옵션 계열 이력으로 판정한다');
  check(!/todayDropConfirmed\(r,\s*hist\.get\(/.test(initCode),
    'TEST F · 상품 단위 이력을 그대로 넘기던 옛 호출이 남아 있지 않다');
  check(/vendorIdOf/.test(initCode) && !/vendorItemId=\(\\d/.test(initCode),
    'TEST F · init.js 도 새 파싱을 만들지 않고 helper 를 쓴다');

  /* ── TEST G. 시세판 drop 객체가 옵션을 잃지 않는다 ── */
  check(/vendorItemId:\s*vendorIdOf\(p\)/.test(init),
    'TEST G · toDropRow 가 vendorItemId 를 싣는다');
  check(/data-vid="/.test(front), 'TEST G · 시세판 카드가 data-vid 를 심는다');
  check(/vendorItemId:\s*row\.dataset\.vid/.test(front),
    'TEST G · Drop.read 가 vendorItemId 를 돌려준다');

  // 실제로 histKey 가 옵션까지 포함하는지 — 프론트 구현을 그대로 옮겨 확인한다.
  const histKey = it => {
    if (!it || !it.productId) return '';
    const base = String(it.productId) + '|' + String(it.mall || '');
    const vid = it.vendorItemId || '';
    return vid ? base + '|' + vid : base;
  };
  check(histKey({ productId: '7912306911', mall: '쿠팡', vendorItemId: '88764198511' })
    === '7912306911|쿠팡|88764198511',
    'TEST G · 옵션이 있으면 이력 키가 옵션까지 포함한다');
  check(histKey({ productId: '7912306911', mall: '쿠팡' }) === '7912306911|쿠팡',
    'TEST G · 옵션을 모르면 예전처럼 상품 단위 키 (legacy 폴백)');
}

/* ================================================================== *
 *  CASE 10. _facets.pickRowForItem — 다른 옵션의 하락 정보를 붙이지 않는다
 * ================================================================== */
function case10() {
  section('CASE 10. 가격 하락 정보가 옵션을 건너뛰지 않는다');

  const { _internal } = require('../api/_facets');
  const pick = _internal.pickRowForItem;

  const L = vid => `https://link.coupang.com/re/AFFSDP?pageKey=8082654809&itemId=1&vendorItemId=${vid}`;
  const A = { product_id: '8082654809', mall: '쿠팡', current_price: 15900, prev_price: 17000,
    drop_pct: 6.5, all_time_low: 15900, is_all_time_low: true, link: L('95768196637') };
  const B = { product_id: '8082654809', mall: '쿠팡', current_price: 222390, prev_price: 242100,
    drop_pct: 8.1, all_time_low: 222390, is_all_time_low: true, link: L('91193685703') };

  const itemA = { productId: '8082654809', mall: '쿠팡', vendorItemId: '95768196637' };
  const itemB = { productId: '8082654809', mall: '쿠팡', vendorItemId: '91193685703' };

  /* ── TEST A / TEST B ── */
  check(pick([A], itemA) === A, 'TEST A · 옵션이 일치하면 붙인다');
  check(pick([B], itemA) === null,
    'TEST B · 222,390원 옵션의 하락 정보가 15,900원 상품에 붙지 않는다 ★');
  check(pick([A], itemB) === null,
    'TEST B · 15,900원 옵션의 하락 정보가 222,390원 상품에 붙지 않는다 ★');
  check(pick([A, B], itemA) === null,
    'TEST A · 행이 여럿이면 어느 것도 붙이지 않는다(추측 금지) ★');
  check(pick([B, A], itemA) === null,
    'TEST A · 순서를 뒤집어도 마지막 행이 이기지 않는다 ★');

  /* ── TEST E. legacy 폴백 ── */
  const noVidRow = { product_id: '9', mall: '쿠팡', current_price: 100, prev_price: 120,
    drop_pct: 16.7, link: 'https://example.com/x' };
  check(pick([noVidRow], { productId: '9', mall: '쿠팡' }) === noVidRow,
    'TEST E · 양쪽 다 옵션을 모르면 예전처럼 붙인다');
  check(pick([A], { productId: '8082654809', mall: '쿠팡' }) === A,
    'TEST E · 상품이 옵션을 모르면 (옛 저장분) 붙인다');
  check(pick([noVidRow], itemA) === noVidRow,
    'TEST E · 뷰 행이 옵션을 모르면 붙인다 (ADPICK 등)');

  /* ── 상품에 vendorItemId 필드가 없어도 link 에서 뽑는다 ── */
  check(pick([B], { productId: '8082654809', mall: '쿠팡', link: L('95768196637') }) === null,
    'TEST B · 상품의 옵션을 link 에서 뽑아도 불일치는 붙이지 않는다');
}

/* ================================================================== *
 *  CASE 11. 대표 사례 — 7912306911 / 8082654809 원장 검증
 * ================================================================== */
function case11() {
  section('CASE 11. 대표 사례 · todayDropConfirmed 가 옵션 계열만 본다');

  const { todayDropConfirmed, sameVendorRows, vendorIdOf } = require('../api/_price');

  /* ── TEST C. 7912306911 — 88764198511 계열만 쓴다 ── */
  const VID_A = '88764198511';
  const linkA = `https://link.coupang.com/re/AFFSDP?pageKey=7912306911&itemId=21714832331&vendorItemId=${VID_A}`;
  const viewA = { product_id: '7912306911', mall: '쿠팡', current_price: 22320,
    prev_price: 26680, drop_pct: 16.3, all_time_low: 22320, is_all_time_low: true, link: linkA };

  check(vendorIdOf(viewA) === VID_A, 'TEST C · 뷰 행의 link 에서 옵션을 뽑는다', vendorIdOf(viewA));

  // 실제 계열: 26,680(4일 전) → 22,320(오늘). 빈 vid 의 26,500원이 섞여 있다.
  const pointsA = [
    { price: 26680, recorded_at: atKst(4), recorded_date: atKst(4).slice(0, 10), vendor_item_id: VID_A },
    { price: 26500, recorded_at: atKst(1), recorded_date: atKst(1).slice(0, 10), vendor_item_id: '' },
    { price: 22320, recorded_at: atKst(0), recorded_date: atKst(0).slice(0, 10), vendor_item_id: VID_A }
  ];
  const scopedA = sameVendorRows(pointsA, vendorIdOf(viewA));
  check(scopedA.length === 2 && scopedA.every(p => p.vendor_item_id === VID_A),
    'TEST C · 빈 vid 의 26,500원이 계열에서 빠진다', `${scopedA.length}점`);
  check(todayDropConfirmed(viewA, scopedA, TODAY) === true,
    'TEST C · 88764198511 계열로 오늘 하락이 확인된다 (26,680 → 22,320)');
  check(scopedA[scopedA.length - 2].price === 26680
    && pointsA[pointsA.length - 2].price === 26500,
    'TEST C · 좁히지 않으면 직전 관측이 다른 옵션 값(26,500)이 된다',
    `혼합 직전=${pointsA[pointsA.length - 2].price} / 옵션 직전=${scopedA[scopedA.length - 2].price}`);
  check(todayDropConfirmed(viewA, pointsA, TODAY) === false,
    'TEST C · 혼합 이력으로는 prev_price(26,680) 가 직전 관측과 달라 판정이 어긋난다 ★');

  /* ── TEST B. 8082654809 — A/B 계열이 서로를 쓰지 않는다 ── */
  const VID_M = '95768196637', VID_O = '91193685703';
  const linkM = `https://link.coupang.com/re/AFFSDP?pageKey=8082654809&itemId=1&vendorItemId=${VID_M}`;
  const pointsB = [
    { price: 242100, recorded_at: atKst(2), recorded_date: atKst(2).slice(0, 10), vendor_item_id: VID_O },
    { price: 222390, recorded_at: atKst(1), recorded_date: atKst(1).slice(0, 10), vendor_item_id: VID_O },
    { price: 15900, recorded_at: atKst(0), recorded_date: atKst(0).slice(0, 10), vendor_item_id: VID_M }
  ];
  // 뷰 행: 15,900원 계열. 옵션을 안 좁히면 직전 관측이 222,390원이라 -92.8% 라는
  // 없던 폭락이 만들어지고, 좁히면 비교할 직전 관측이 없어 판정하지 않는다.
  const viewB = { product_id: '8082654809', mall: '쿠팡', current_price: 15900,
    prev_price: 222390, drop_pct: 92.8, all_time_low: 15900, is_all_time_low: true, link: linkM };
  const scopedB = sameVendorRows(pointsB, VID_M);
  check(scopedB.length === 1 && scopedB[0].price === 15900,
    'TEST B · 15,900원 계열에 222,390원 관측이 들어오지 않는다', `${scopedB.length}점`);
  check(todayDropConfirmed(viewB, scopedB, TODAY) === false,
    'TEST B · 옵션 계열로는 "92.8% 폭락" 이 확인되지 않는다 ★');
  check(todayDropConfirmed(viewB, pointsB, TODAY) === true,
    'TEST B · (대조) 옵션을 안 좁히면 그 거짓 하락이 통과했다 ★');
}

/* ------------------------------------------------------------------ */
(async () => {
  console.log('\nSEOSA 가격 데이터 신뢰성 회귀 테스트 (DB 접근 0회)\n');
  await case1();
  await case2();
  case3();
  case4();
  case5();
  case6();
  case7();
  case8();
  case9();
  case10();
  case11();

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  PASS ${pass}  /  FAIL ${fail}`);
  if (fail) {
    console.log('\n  ✗ 가격 신뢰성 회귀 — 위 FAIL 을 고치기 전에 배포하지 말 것.\n');
    process.exit(1);
  }
  console.log('\n  ✓ 전부 통과\n');
})().catch(e => { console.error('\nFATAL', e); process.exit(1); });
