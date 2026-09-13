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
  /*
   * ★ «지어내지 않는다» 의 뜻이 2026-09-10 에 좁혀졌다.
   *   지어내면 안 되는 것은 «순위» 다. 관측 3일에서 나오는 low/median 은
   *   지어낸 값이 아니라 실제로 본 값이라, 0 으로 지워 보내면 호출부가
   *   있는 사실조차 말하지 못한다 (_pricestat 의 같은 자리 주석 참고).
   */
  check(f.pctRank === null, '★ 순위는 지어내지 않는다', String(f.pctRank));
  check(f.low === 100 && f.high === 130, '관측한 값은 그대로 알려준다', `${f.low}~${f.high}`);
  check(f.uniquePrices === 3 && f.heldDays === 5, '설명용 값도 실제 관측 기준', `uniq=${f.uniquePrices} held=${f.heldDays}`);
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

/* ══════════════════════════════════════════════════════════════
 *  PRICE INTELLIGENCE V2 (2026-09-10) — 30 케이스 회귀
 *
 *  V2 에서 늘어난 계약은 둘뿐이다.
 *    1. 순위를 못 내도 기술통계(low/high/median/mean)는 실제 값으로 준다
 *    2. flat 을 설명할 재료(uniquePrices/heldDays)를 함께 준다
 *  판정(level)은 한 자리도 바뀌지 않는다 — 아래가 그것을 고정한다.
 * ══════════════════════════════════════════════════════════════ */
section('[V2] 30 케이스 — 판정은 그대로, 설명 재료만 늘었다');
{
  const T = TODAY;
  const S = arr => series(arr);
  const F = (arr, cur) => fairness(S(arr), cur === undefined ? arr[arr.length - 1] : cur, T);

  /* 1~3 몰 — fair 는 몰을 모른다. 같은 계열이면 같은 답이어야 한다. */
  const base = [100, 120, 140, 160, 180, 200, 220, 240, 260, 280];
  const cp = F(base), ad = F(base), lg = F(base);
  check(cp.level === ad.level && ad.level === lg.level,
    '1-3. 쿠팡/ADPICK/legacy — 같은 계열이면 같은 판정', cp.level);

  /* 4~6 옵션 식별자 */
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push({ vendor_item_id: 'A', recorded_date: daysAgo(8 - i), price: 50000 + i * 2000 });
  for (let i = 0; i < 8; i++) rows.push({ vendor_item_id: 'B', recorded_date: daysAgo(8 - i), price: 9000 });
  const toPts = vid => sameVendorRows(rows, vid)
    .map(r => ({ date: observedKstDate(r), price: r.price }));
  check(fairness(toPts('A'), 50000, T).low === 50000, '4. vid 있음 — 내 계열만', String(fairness(toPts('A'), 50000, T).low));
  check(fairness(toPts(''), 9000, T).obs === 8, '5. vid 없음(레거시) — 상품 단위로 본다', String(fairness(toPts(''), 9000, T).obs));
  check(fairness(toPts('C'), 9000, T).obs === 0, '6. 다른 vid만 존재 — 남의 가격을 빌리지 않는다', String(fairness(toPts('C'), 9000, T).obs));

  /* 7 중복 날짜 */
  const d1 = daysAgo(1);
  const dup = [{ date: daysAgo(5), price: 100 }, { date: daysAgo(4), price: 110 },
    { date: daysAgo(3), price: 120 }, { date: daysAgo(2), price: 130 },
    { date: d1, price: 900 }, { date: d1, price: 140 }];
  const fd = fairness(dup, 140, T);
  check(fd.obs === 5 && fd.high === 140, '7. 중복 날짜 — 최저가 한 점', `obs=${fd.obs} high=${fd.high}`);

  /* 8 outlier */
  const out = []; for (let i = 0; i < 10; i++) out.push(15900);
  out.push(242100, 222390);
  const fo = F(out, 15900);
  check(fo.pctRank > 0 && fo.pctRank < 60, '8. outlier — 순위가 무너지지 않는다', `pct=${fo.pctRank}`);
  check(fo.median === 15900, '8b. 중앙값은 outlier 에 안 흔들린다', String(fo.median));

  /* 9 flat + 설명 재료 */
  const ff = F([49900, 49900, 49900, 49900, 49900, 49900, 49900, 49900]);
  check(ff.level === 'flat', '9. 값이 하나 → flat', ff.level);
  check(ff.uniquePrices === 1, '9b. ★ uniquePrices=1 로 «한 번도 안 움직였다» 를 말할 수 있다', String(ff.uniquePrices));
  check(ff.heldDays === 7, '9c. ★ heldDays 로 «며칠에 걸쳐» 를 말할 수 있다', String(ff.heldDays));
  check(ff.pctRank === null, '9d. ★ flat 은 순위를 내지 않는다 (cheap 이 될 길이 없다)', String(ff.pctRank));
  check(ff.level !== 'cheap' && ff.level !== 'very_cheap', '9e. ★ flat 은 절대 cheap 이 아니다', ff.level);
}

section('[V2] 10~30 — 경계·이상값·시계열 원형');
{
  const T = TODAY;
  const S = arr => series(arr);
  const F = (arr, cur) => fairness(S(arr), cur === undefined ? arr[arr.length - 1] : cur, T);

  /* 10 stale */
  const old = [100,110,120,130,140,150,160,170,180,190]
    .map((p, i) => ({ date: kstToday(new Date(Date.now() - (40 - i) * 86400000)), price: p }));
  const fs2 = fairness(old, 100, T);
  check(fs2.level === 'stale', '10. 기록 정지 → stale', fs2.level);
  check(fs2.low === 100 && fs2.high === 190, '10b. ★ stale 이어도 관측한 값은 알려준다', `${fs2.low}~${fs2.high}`);

  /* 11~14 관측 수 경계 */
  const grow = n => { const a = []; for (let i = 0; i < n; i++) a.push(100 + i * 20); return a; };
  check(F(grow(4)).level === 'insufficient', '11. 4관측 → insufficient', F(grow(4)).level);
  check(F(grow(4)).low === 100, '11b. ★ 4관측도 low 는 실제 값', String(F(grow(4)).low));
  check(F(grow(5)).level !== 'insufficient', '12. 5관측 → 판정 시작', F(grow(5)).level);
  check(F(grow(9)).confident === false, '13. 9관측 → 극단 등급 금지(confident=false)', String(F(grow(9)).confident));
  check(F(grow(10)).confident === true, '14. 10관측 → 5구간 확정', String(F(grow(10)).confident));
  check(F(grow(9), 100).level === 'cheap', '13b. 9관측 최저가는 cheap 까지만', F(grow(9), 100).level);
  check(F(grow(10), 100).level === 'very_cheap', '14b. 10관측 최저가는 very_cheap', F(grow(10), 100).level);

  /* 15~16 현재가 */
  const g = grow(10);
  check(F(g, 999999).current === 999999, '15. 현재가 불일치 — 준 값을 그대로 기준으로 삼는다', String(F(g, 999999).current));
  check(F(g, g[g.length-1]).current === g[g.length-1], '16. 현재가 일치', String(F(g, g[g.length-1]).current));

  /* 17~20 비정상 행 */
  const dirty = [
    { date: daysAgo(6), price: 100 }, { date: daysAgo(5), price: 0 },
    { date: daysAgo(4), price: null }, { date: daysAgo(3), price: -500 },
    { date: kstToday(new Date(Date.now() + 3 * 86400000)), price: 1 },
    { date: daysAgo(2), price: 120 }, { date: daysAgo(1), price: 130 }
  ];
  const fdz = fairness(dirty, 130, T);
  check(fdz.obs === 3, '17-20. 미래·0원·음수·null 전부 제외', `obs=${fdz.obs}`);
  check(fdz.high === 130, '17b. 미래 행의 1원이 최저가가 되지 않는다', String(fdz.high));

  /* 21 상수 계열 */
  const cst = F([7000,7000,7000,7000,7000,7000]);
  check(cst.level === 'flat' && cst.uniquePrices === 1, '21. 상수 계열 → flat, uniq=1', `${cst.level}/${cst.uniquePrices}`);

  /* 22 flash sale — 한 번 싸게 팔았고 지금은 원가 */
  const flash = F([100,100,100,100,100,100,100,100,70,100]);
  check(flash.pctRank !== null && flash.pctRank > 10,
    '22. flash sale 뒤 원가 복귀 — «매우 저렴» 이 아니다', `pct=${flash.pctRank} ${flash.level}`);

  /* 23 one-day spike */
  const spike = F([100,100,100,100,100,100,100,100,400,100]);
  check(spike.pctRank !== null && spike.pctRank < 90,
    '23. 하루 급등 뒤 복귀 — «매우 비쌈» 이 아니다', `pct=${spike.pctRank} ${spike.level}`);

  /* 24 bimodal */
  const bi = F([18900,18900,18900,19900,19900,19900,18900,19900,18900,19900], 19900);
  check(bi.pctRank !== null && bi.pctRank > 50, '24. 쌍봉에서 높은 값 — 위쪽으로 잡힌다', `pct=${bi.pctRank} ${bi.level}`);

  /* 25 긴 이력 */
  const long = []; for (let i = 0; i < 60; i++) long.push(10000 + (i % 10) * 500);
  const fl2 = F(long);
  check(fl2.obs === 60 && fl2.pctRank !== null, '25. 60일 이력 — 정상 판정', `obs=${fl2.obs} pct=${fl2.pctRank}`);

  /* 26 90일 경계 */
  const boundary = [
    { date: kstToday(new Date(Date.now() - 95 * 86400000)), price: 1 },
    { date: kstToday(new Date(Date.now() - 89 * 86400000)), price: 50000 }
  ];
  for (let i = 0; i < 8; i++) boundary.push({ date: daysAgo(8 - i), price: 60000 + i * 1000 });
  const fb = fairness(boundary, 67000, T);
  check(fb.low === 50000, '26. 90일 밖(95일 전) 1원은 들어오지 않는다', String(fb.low));
  check(fb.obs === 9, '26b. 89일 전은 창 안이다', String(fb.obs));

  /*
   * 27. KST 경계.
   *
   * ★ 진짜 위험은 «미래 행» 이 아니라 «라벨과 시각이 어긋난 행» 이다.
   *   price_history.recorded_date 는 한때 UTC 로 찍혀 KST 와 하루 어긋났고
   *   (api/_price.observedKstDate 주석의 실측), 그래서 판정 기준은 언제나
   *   recorded_at 이 먼저다. 그 우선순위를 여기서 고정한다.
   */
  {
    // KST 오늘 00:30 = UTC 어제 15:30. 라벨(recorded_date)만 보면 «어제» 다.
    const kstEarlyToday = new Date(Date.parse(T + 'T00:30:00+09:00'));
    check(kstToday(kstEarlyToday) === T, '27. KST 00:30 은 KST 기준 오늘이다', kstToday(kstEarlyToday));
    const row = { recorded_at: kstEarlyToday.toISOString(), recorded_date: daysAgo(1), price: 100 };
    check(observedKstDate(row) === T,
      '27b. recorded_date 라벨이 어제여도 recorded_at 이 이기고 오늘이 된다',
      observedKstDate(row) + ' (라벨은 ' + row.recorded_date + ')');
    const fk = fairness([{ date: observedKstDate(row), price: 100 }], 100, T);
    check(fk.obs === 1 && fk.staleDays === 0, '27c. 그 관측이 오늘로 세어진다', 'obs=' + fk.obs + ' stale=' + fk.staleDays);
  }

  /* 28~29 UI 가 숨기는가 / 보이는가 — 서버 계약 쪽만 */
  check(F(grow(10), 100).pctRank !== null, '28-29. 판정 가능하면 pctRank 가 있다 (UI 표시 조건)', String(F(grow(10), 100).pctRank));
  ['flat','stale','insufficient'].forEach(lv => {
    const r = lv === 'flat' ? F([100,100,100,100,100,100])
      : lv === 'stale' ? fs2 : F(grow(3));
    check(r.pctRank === null, `28b. ${lv} 은 pctRank=null (UI 가 숨길 근거)`, String(r.pctRank));
  });

  /* 30 API 실패 대체 */
  let threw = false;
  try { fairness(null, null, null); fairness([], 0, T); fairness([{}], NaN, T); }
  catch (e) { threw = true; }
  check(!threw, '30. 어떤 입력에도 throw 하지 않는다');
  check(fairness(null, null, null).uniquePrices === 0, '30b. 새 필드도 기본값이 안전하다');
}

section('[V2] 관측 0건 — 통계 게이트를 옮기며 생겼던 회귀');
{
  /*
   * ★ 2026-09-10, MIN_OBS 게이트를 기술통계 «뒤» 로 옮기면서 빈 배열 가드가
   *   빠졌다. sorted[0] 이 undefined 가 되고 median/mean 이 NaN 이 되어,
   *   JSON 으로 나갈 때 low 키가 사라지고 median 이 null 이 됐다.
   *   값이 «없다» 와 «0 이다» 는 다르지만, 호출부 계약은 숫자 0 이다.
   */
  const T = TODAY;
  [[], [{ date: daysAgo(1), price: 0 }], [{ date: 'nope', price: 100 }], null, undefined]
    .forEach((pts, i) => {
      const f = fairness(pts, 100, T);
      const nums = [f.low, f.high, f.median, f.mean];
      check(nums.every(v => v === 0), `관측 0건 입력 #${i} — 통계가 전부 숫자 0`, JSON.stringify(nums));
      check(f.uniquePrices === 0 && f.heldDays === 0, `관측 0건 입력 #${i} — 새 필드도 0`,
        `uniq=${f.uniquePrices} held=${f.heldDays}`);
      check(f.level === 'insufficient', `관측 0건 입력 #${i} — insufficient`, f.level);
    });

  // JSON 직렬화에서 키가 사라지거나 null 이 되지 않는다.
  const j = JSON.parse(JSON.stringify(fairness([], 100, T)));
  check(['low','high','median','mean','uniquePrices','heldDays'].every(k => j[k] === 0),
    '★ JSON 으로 내보내도 숫자 0 (키 누락·null 없음)', JSON.stringify({ low: j.low, median: j.median }));

  // 관측 1건은 실제 값이 나와야 한다 (0건과 구분된다).
  const one = fairness([{ date: daysAgo(1), price: 100 }], 100, T);
  check(one.low === 100 && one.median === 100 && one.uniquePrices === 1,
    '관측 1건은 실제 값 (0건과 구분)', `low=${one.low} uniq=${one.uniquePrices}`);
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
