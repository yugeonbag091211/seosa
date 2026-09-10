#!/usr/bin/env node
/*
 * 구매 적정가(_pricestat.fairness) 테스트 — 외부 호출 0회, DB 접근 0회.
 *
 *   node scripts/test-price-fairness.js
 *
 * ── 이 테스트가 지키는 불변식 ────────────────────────────────────────
 *   1. 위치는 «순위» 다. outlier 하나가 결론을 뒤집지 못한다.
 *   2. 관측이 모자라면 말하지 않는다. 없는 확신을 만들지 않는다.
 *   3. 옵션(vendor_item_id)이 다른 가격은 절대 같은 분포에 들어가지 않는다.
 *   4. dealOf 의 결론을 덮어쓰지 않는다 — 위치와 행동은 다른 축이다.
 */
'use strict';

const PS = require('../api/_pricestat');
const { fairness, FAIR_WINDOW_DAYS, FAIR_MIN_OBS, FAIR_FULL_OBS } = PS;
const { sameVendorRows, observedKstDate, kstToday } = require('../api/_price');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function section(name) {
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(name);
  console.log(`──────────────────────────────────────────────────────────────`);
}

const TODAY = kstToday();
/** n일 전 KST 날짜. 테스트가 «오늘» 에 붙어 있어야 staleDays 가 0 이 된다. */
function daysAgo(n) {
  return kstToday(new Date(Date.now() - n * 86400000));
}
/** 가격 배열 → 오래된 것부터 오늘까지 하루 간격 관측 */
function series(prices) {
  const n = prices.length;
  return prices.map((p, i) => ({ date: daysAgo(n - 1 - i), price: p }));
}

/* ── 1) 현재가가 최저권인 상품 ─────────────────────────────────── */
section('[1] 현재가가 최저권 — 매우 저렴함');
{
  // 12일 관측, 폭 넉넉(50%). 현재가가 가장 싸다.
  const pts = series([150, 145, 140, 138, 135, 132, 130, 128, 125, 120, 110, 100]);
  const f = fairness(pts, 100, TODAY);
  check(f.level === 'very_cheap', '최저가면 very_cheap', `${f.level} pct=${f.pctRank}`);
  // midrank 는 관측에 실재하는 값에 0% 를 주지 않는다 — (0 + 1/2)/12 = 4%.
  // «아래에 아무것도 없다» 와 «가장 싼 관측 하나가 나다» 는 다른 말이다.
  check(f.pctRank > 0 && f.pctRank < 10, '★ 최저가라도 0% 라고 말하지 않는다 (midrank)', String(f.pctRank));
  check(f.obs === 12, '관측 12일', String(f.obs));
  check(f.low === 100 && f.high === 150, 'low/high 정확', `${f.low}/${f.high}`);
  check(f.confident === true, '관측 10일 이상이라 확정 판정', String(f.confident));
}

/* ── 2) 평균권 상품 ────────────────────────────────────────────── */
section('[2] 평균권 — 보통');
{
  const pts = series([100, 110, 120, 130, 140, 150, 160, 170, 180, 190]);
  const f = fairness(pts, 145, TODAY);
  check(f.level === 'normal', '중간값이면 normal', `${f.level} pct=${f.pctRank}`);
  check(f.pctRank >= 30 && f.pctRank <= 70, '백분위가 30~70 구간', String(f.pctRank));
  check(f.median === 145, '중앙값 145', String(f.median));
}

/* ── 3) 최고권 상품 ────────────────────────────────────────────── */
section('[3] 현재가가 최고권 — 매우 비쌈');
{
  const pts = series([100, 105, 110, 115, 120, 125, 130, 135, 140, 145]);
  const f = fairness(pts, 145, TODAY);
  check(f.level === 'very_expensive', '최고가면 very_expensive', `${f.level} pct=${f.pctRank}`);
  check(f.pctRank >= 90, '백분위 90 이상', String(f.pctRank));
}

/* ── 4) 이력 1건뿐인 상품 ──────────────────────────────────────── */
section('[4] 관측 부족 — 확정 판정 금지');
{
  const one = fairness(series([50000]), 50000, TODAY);
  check(one.level === 'insufficient', '1건 → insufficient', one.level);
  check(one.pctRank === null, '★ 백분위를 만들어내지 않는다', String(one.pctRank));
  check(one.obs === 1, 'obs=1 은 그대로 알려준다', String(one.obs));

  const two = fairness(series([50000, 49000]), 49000, TODAY);
  check(two.level === 'insufficient', '2건 → insufficient', two.level);

  const four = fairness(series([100, 200, 300, 400]), 100, TODAY);
  check(four.level === 'insufficient', `${FAIR_MIN_OBS}건 미만은 전부 insufficient`, four.level);

  const zero = fairness([], 50000, TODAY);
  check(zero.level === 'insufficient', '이력 0건 → insufficient', zero.level);
  check(zero.obs === 0, 'obs=0', String(zero.obs));
}

/* ── 5) 관측 5~9일 — 극단 라벨을 쓰지 않는다 ───────────────────── */
section('[5] 해상도 부족 — 극단 두 칸 금지');
{
  // 6일 관측에서 최저가. 5구간이면 very_cheap 이지만 해상도(1/6=17%p)가 없다.
  const f = fairness(series([100, 120, 140, 160, 180, 60]), 60, TODAY);
  check(f.pctRank > 0 && f.pctRank < 10, '백분위 자체는 하위 10% 안', String(f.pctRank));
  check(f.level === 'cheap', `★ 관측 ${FAIR_FULL_OBS}일 미만이면 very_cheap 대신 cheap`, f.level);
  check(f.confident === false, 'confident=false 로 알린다', String(f.confident));

  const hi = fairness(series([100, 120, 140, 160, 180, 300]), 300, TODAY);
  check(hi.level === 'expensive', '★ very_expensive 도 쓰지 않는다', hi.level);
}

/* ── 6) outlier 포함 상품 ──────────────────────────────────────── */
section('[6] outlier — 순위는 흔들리지 않는다');
{
  /*
   * _pricestat median 주석의 실측 재현: 대부분 15,900원인데 이틀만 20만원대.
   * min-max 위치면 15,900원이 백분위 0% = «매일이 역대 최저» 가 된다.
   */
  const base = [];
  for (let i = 0; i < 10; i++) base.push(15900);
  base.push(242100, 222390);
  const pts = series(base);
  const f = fairness(pts, 15900, TODAY);

  check(f.pctRank > 0, '★ outlier 2건 때문에 «매우 저렴» 이 되지 않는다', `pct=${f.pctRank}`);
  check(f.level === 'cheap' || f.level === 'normal',
    '★ 25일 내내 같던 값을 특가로 부르지 않는다', `${f.level} pct=${f.pctRank}`);
  check(f.median === 15900, '중앙값은 outlier에 흔들리지 않는다', String(f.median));
  check(f.mean > f.median, '평균은 outlier에 끌려간다(그래서 median 을 함께 낸다)',
    `mean=${f.mean} median=${f.median}`);

  // min-max 방식과의 대조 — 같은 데이터에서 결론이 갈린다는 사실 자체를 고정한다.
  const minmax = Math.round((15900 - 15900) / (242100 - 15900) * 100);
  check(minmax === 0 && f.pctRank !== 0,
    '★ min-max 였다면 0% 였을 값이 순위로는 다르다', `min-max=${minmax}% 순위=${f.pctRank}%`);
}

/* ── 7) 중복 날짜 이력 ─────────────────────────────────────────── */
section('[7] 같은 날짜 중복 — 최저가 한 점으로 접는다');
{
  const d = daysAgo(1);
  const dup = [
    { date: daysAgo(6), price: 100 }, { date: daysAgo(5), price: 110 },
    { date: daysAgo(4), price: 120 }, { date: daysAgo(3), price: 130 },
    { date: daysAgo(2), price: 140 },
    { date: d, price: 200 }, { date: d, price: 150 }, { date: d, price: 900 }
  ];
  const f = fairness(dup, 150, TODAY);
  check(f.obs === 6, '★ 8행이 6일로 접힌다', `obs=${f.obs}`);
  check(f.high === 150, '★ 같은 날 최저가만 남아 900원이 high 가 되지 않는다', String(f.high));
}

/* ── 8) 0원 / null / 음수 / 미래 날짜 ──────────────────────────── */
section('[8] 비정상 값 제외');
{
  const dirty = [
    { date: daysAgo(6), price: 100 }, { date: daysAgo(5), price: 0 },
    { date: daysAgo(4), price: null }, { date: daysAgo(3), price: -500 },
    { date: daysAgo(2), price: 120 }, { date: daysAgo(1), price: 130 },
    { date: kstToday(new Date(Date.now() + 3 * 86400000)), price: 1 }
  ];
  const f = fairness(dirty, 130, TODAY);
  check(f.obs === 3, '0원·null·음수·미래 날짜가 전부 빠진다', `obs=${f.obs}`);
  check(f.level === 'insufficient', '남은 3건은 판정 불가', f.level);
  check(f.low === 0 && f.pctRank === null, '값을 지어내지 않는다', `low=${f.low}`);
}

/* ── 9) 폭이 좁은 상품 (실측 75.4%가 여기 해당) ────────────────── */
section('[9] 사실상 고정가 — flat');
{
  // _deal.PCTL_MIN_SPREAD 주석의 실측 재현: 38,520~39,800원 (폭 3.3%)
  const pts = series([38520, 38900, 39000, 39200, 39400, 39600, 39700, 39800, 39800, 39800]);
  const f = fairness(pts, 39800, TODAY);
  check(f.level === 'flat', '★ 폭 5% 미만이면 비쌈이라고 말하지 않는다', `${f.level} spread=${f.spreadPct}%`);
  check(f.pctRank === null, '순위를 내지 않는다 (뜻이 없다)', String(f.pctRank));
  check(f.spreadPct < 5, '폭은 알려준다', `${f.spreadPct}%`);
  check(f.low === 38520 && f.high === 39800, '최저·최고는 그대로 낸다', `${f.low}~${f.high}`);
}

/* ── 10) 기록이 멈춘 상품 ──────────────────────────────────────── */
section('[10] 기록이 오래됨 — 단정 보류');
{
  const old = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190]
    .map((p, i) => ({ date: kstToday(new Date(Date.now() - (40 - i) * 86400000)), price: p }));
  const f = fairness(old, 100, TODAY);
  check(f.level === 'stale', '★ 30일 전에서 멈춘 기록으로 «지금» 을 단정하지 않는다', f.level);
  check(f.staleDays >= 14, `staleDays 를 알려준다`, String(f.staleDays));
  check(f.pctRank === null, '위치를 말하지 않는다', String(f.pctRank));
}

/* ── 11) 옵션(vid)이 다른 상품 ─────────────────────────────────── */
section('[11] 옵션 identity — 다른 vid 는 절대 섞이지 않는다');
{
  /*
   * fairness 자체는 점 배열을 받는다. 옵션을 가르는 일은 호출부가 쓰는
   * _price.sameVendorRows 가 한다 (loadStats·history-batch·_product-page 공용).
   * 그 두 단계를 이어 붙인 채로 고정한다 — 한쪽만 맞으면 소용이 없다.
   */
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ vendor_item_id: 'A', recorded_at: null, recorded_date: daysAgo(10 - i), price: 100000 + i * 1000 });
  }
  for (let i = 0; i < 10; i++) {
    rows.push({ vendor_item_id: 'B', recorded_at: null, recorded_date: daysAgo(10 - i), price: 9000 });
  }

  const toPts = vid => {
    const byDate = new Map();
    sameVendorRows(rows, vid).forEach(r => {
      const d = observedKstDate(r);
      const p = Math.round(Number(r.price) || 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || p <= 0) return;
      const cur = byDate.get(d);
      if (cur === undefined || p < cur) byDate.set(d, p);
    });
    return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(e => ({ date: e[0], price: e[1] }));
  };

  const a = fairness(toPts('A'), 100000, TODAY);
  check(a.low === 100000, '★ 옵션 A 분포에 9,000원이 들어오지 않는다', `low=${a.low}`);
  check(a.obs === 10, 'A 관측 10일', String(a.obs));
  check(a.level === 'very_cheap', 'A 기준 100,000원은 최저권', `${a.level} pct=${a.pctRank}`);

  const b = fairness(toPts('B'), 9000, TODAY);
  check(b.high === 9000, '★ 옵션 B 분포에 10만원대가 들어오지 않는다', `high=${b.high}`);
  check(b.level === 'flat', 'B 는 값이 하나뿐이라 flat', b.level);

  // 우리 옵션 행이 없고 다른 옵션에 귀속된 행만 있으면 빈 배열이어야 한다.
  const c = fairness(toPts('C'), 9000, TODAY);
  check(c.obs === 0 && c.level === 'insufficient',
    '★ 모르는 옵션이면 남의 가격을 빌려 쓰지 않는다', `obs=${c.obs}`);
}

/* ── 12) 몰별 — ADPICK / 쿠팡 ──────────────────────────────────── */
section('[12] ADPICK · 쿠팡 — 계산은 몰과 무관하게 같다');
{
  /*
   * ADPICK 에는 vendor_item_id 개념이 없다(api/_shop.js fetchAdpick 주석).
   * 그래서 행에 옵션 표시가 전혀 없고, sameVendorRows 의 레거시 폴백이
   * 상품 단위로 본다. 그 경로에서도 같은 결론이 나와야 한다.
   */
  const prices = [50000, 48000, 47000, 46000, 45000, 44000, 43000, 42000, 41000, 40000];

  const adpickRows = prices.map((p, i) => ({
    vendor_item_id: '', recorded_at: null, recorded_date: daysAgo(10 - i), price: p
  }));
  const coupangRows = prices.map((p, i) => ({
    vendor_item_id: 'VID1', recorded_at: null, recorded_date: daysAgo(10 - i), price: p
  }));

  const toPts = (rows, vid) => sameVendorRows(rows, vid)
    .map(r => ({ date: observedKstDate(r), price: Math.round(Number(r.price) || 0) }))
    .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.price > 0);

  const ad = fairness(toPts(adpickRows, ''), 40000, TODAY);
  const cp = fairness(toPts(coupangRows, 'VID1'), 40000, TODAY);

  check(ad.level === 'very_cheap', 'ADPICK — 최저권', `${ad.level} pct=${ad.pctRank}`);
  check(cp.level === 'very_cheap', '쿠팡 — 최저권', `${cp.level} pct=${cp.pctRank}`);
  check(ad.pctRank === cp.pctRank && ad.median === cp.median,
    '★ 같은 가격 계열이면 몰이 달라도 같은 숫자', `${ad.pctRank} vs ${cp.pctRank}`);
}

/* ── 13) 90일 창 ───────────────────────────────────────────────── */
section('[13] 창 — 90일 밖은 분포에 넣지 않는다');
{
  const old = [];
  for (let i = 0; i < 10; i++) {
    old.push({ date: kstToday(new Date(Date.now() - (150 - i) * 86400000)), price: 9000 });
  }
  const recent = [];
  for (let i = 0; i < 10; i++) {
    recent.push({ date: daysAgo(10 - i), price: 50000 + i * 1000 });
  }
  const f = fairness(old.concat(recent), 50000, TODAY);
  check(f.obs === 10, `★ ${FAIR_WINDOW_DAYS}일 밖 10건이 빠진다`, `obs=${f.obs}`);
  check(f.low === 50000, '옛 9,000원이 최저가로 잡히지 않는다', String(f.low));
  check(f.windowDays === 90, '창을 응답에 밝힌다', String(f.windowDays));
}

/* ── 14) 기존 판정을 덮어쓰지 않는다 ───────────────────────────── */
section('[14] 회귀 — 기존 엔진은 한 줄도 바뀌지 않았다');
{
  const pts = series([150, 145, 140, 138, 135, 132, 130, 128, 125, 100]);
  const stat = PS.statsFrom(pts);

  check(stat !== null && stat.count === 10, 'statsFrom 은 그대로 동작', `count=${stat && stat.count}`);
  check(stat.fair === undefined && stat.fairness === undefined,
    '★ statsFrom 반환 모양을 건드리지 않았다', Object.keys(stat).length + '개 필드');

  const D = require('../api/_deal');
  const mm = D.pricePercentile(stat, 100);
  check(mm === 0, '★ 기존 min-max pricePercentile 은 그대로 0%', String(mm));

  const f = fairness(pts, 100, TODAY);
  // ★ 두 축이 «다른 값» 을 낸다는 사실 자체를 고정한다. 하나로 합치려 들면
  //   dealOf 의 판정이 조용히 바뀐다 — 그래서 새 필드로 병행한다.
  check(f.pctRank === 5, '순위 백분위는 5% (min-max 0% 와 다르다)', String(f.pctRank));

  const a = PS.assess(stat, 100, TODAY);
  check(a && typeof a.verdict === 'string', 'assess 도 그대로 동작', a && a.verdict);
}

/* ── 15) 계약 ──────────────────────────────────────────────────── */
section('[15] 응답 계약 — 절대 throw 하지 않는다');
{
  let threw = false;
  try {
    fairness(null, null, null);
    fairness(undefined, 0, '');
    fairness([{ date: 'nope', price: 'x' }], NaN, TODAY);
    fairness([{}, null, 5], -1, TODAY);
  } catch (e) { threw = true; }
  check(!threw, '★ 어떤 입력에도 throw 하지 않는다');

  const f = fairness(null, null, null);
  check(f && f.level === 'insufficient', '망가진 입력도 구조는 온전하다', f && f.level);
  check(typeof f.label === 'string' && f.label.length > 0, 'label 은 항상 사람이 읽을 수 있다', f.label);
  check(f.minObs === FAIR_MIN_OBS && f.fullObs === FAIR_FULL_OBS,
    '문턱을 응답에 밝힌다 (프론트가 문구를 지어내지 않게)', `${f.minObs}/${f.fullObs}`);
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
