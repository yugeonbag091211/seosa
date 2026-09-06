'use strict';
/*
 * SEOSA HOT — 검증된 핫딜 판정 엔진.
 *
 * ── 이 파일이 존재하는 이유 ────────────────────────────────────────
 *
 * 쇼핑몰이 "60% 할인"이라고 적어도 그것은 우리 근거가 아니다. 정가는 판매자가
 * 정하고 부풀릴 수 있다. SEOSA 가 가진 유일한 진짜 근거는 우리가 직접 매일
 * 관측해 저장한 price_history 다.
 *
 *   쇼핑몰 표시 할인율 60%      ← 쓰지 않는다 (참고 표시만)
 *   SEOSA 관측 대비 실제 18%↓   ← 이것으로 판정한다
 *
 * ── 왜 _deal.js 를 그대로 쓰지 않는가 ─────────────────────────────
 *
 * _deal.js 는 "지금 보고 있는 이 상품, 사도 되나"에 답하는 엔진이고 실제로
 * 잘 만들어져 있다. 그런데 핫딜은 판정을 **우리가 먼저 골라서 사용자에게
 * 들이미는** 것이라 틀렸을 때의 비용이 다르다. 그래서 같은 데이터를 쓰되
 * 더 보수적인 별도 관문을 둔다. 특히 아래 네 가지를 상속하지 않는다.
 *
 *   1) 이상치 감지의 자기비교
 *      _deal.anomalies 는 현재가를 stat.lastPrice 와 견준다. 그런데 수집
 *      크론이 KST 01시에 오늘 값을 이미 넣어 두므로 lastPrice === 현재가가
 *      되어 `p <= last*0.5` 가 영원히 거짓이 된다. 여기서는 **오늘을 제외한**
 *      직전 관측(prevObserved)과 견준다.
 *   2) 관측된 적 없는 가격을 "기록상 최저"라고 말하는 것
 *      라이브 가격이 아직 기록에 없으면 그 값은 관측이 아니라 가설이다.
 *      currentObserved 로 구분하고, 관측되지 않은 값에는 최저가 문구를
 *      절대 붙이지 않는다.
 *   3) 관측이 성기거나 공백이 큰데도 높은 확신을 주는 것
 *      GATE 2~4 가 관측 수·기간·공백을 각각 따로 본다. 셋 다 필요하다 —
 *      "3점이 30일에 흩어진 것"과 "3점이 연속 3일"은 전혀 다르다.
 *   4) 다른 상품의 이력이 붙는 것
 *      evaluate() 는 후보 하나와 그 후보의 이력만 받는다. 목록에서 아무
 *      상품의 이력을 끌어다 쓸 구조 자체를 만들지 않는다.
 *
 * ── 가중치를 어떻게 정했나 (2026-09-06 운영 데이터 read-only 실측) ──
 *
 * price_history 27,420행 / 계열(상품·옵션) 5,220개 / 관측 2회 이상 4,285개.
 *
 *   변동성 ≤0.5% 인 계열      3,276 / 4,285  (76%)
 *   중앙값 대비 할인 ≤0%      3,622 / 4,285  (85%)
 *   현재가 = 관측 최저가       3,702 / 4,285  (86%)
 *     그중 그 최저를 하루만 본 것            295
 *
 * 여기서 두 가지가 정해졌다.
 *
 *   · **"역대 최저가"는 신호가 아니다.** 86% 가 최저가인 것은 값이 안 움직여서다.
 *     최저가 근접 보너스를 크게 주면 평범한 고정가 상품이 전부 핫딜이 된다.
 *     그래서 D 축은 8점으로 묶고, 그것도 **확인된**(다른 날에도 같은 값을 본)
 *     최저가일 때만 준다.
 *   · **중앙값 대비 할인이 유일한 변별축이다.** 85% 가 0% 이므로 8% 만 되어도
 *     상위 1.5% 다. 그래서 A 축(30일 중앙값 대비)에 가장 큰 몫을 준다.
 *     평균이 아니라 중앙값을 쓰는 이유는 이틀치 튄 값에 평균이 통째로
 *     끌려가기 때문이다(_deal.js OUTLIER_RATIO 주석의 실측과 같은 이유).
 *
 * 같은 실측으로 노출 규모도 재 봤다.
 *   Aggressive  (n≥3, ≥5%)                 120개  평균할인 15.2%  하루짜리최저 45
 *   Balanced    (n≥5, span≥7, gap≤14, ≥8%)  51개  평균할인 17.5%  하루짜리최저 12
 *   Conservative(n≥7, span≥14, gap≤7, ≥10%) 14개  평균할인 19.3%  하루짜리최저  3
 * v1 은 Balanced 를 기준선으로 잡되, 하루짜리 최저는 threshold 가 아니라
 * GATE 5 로 따로 막는다 — 숫자를 조여서 막는 것보다 이유를 갖고 막는 편이
 * 나중에 고치기 쉽다.
 */

const { parsePrice } = require('./_price');

/* ==================================================================
 *  0) 어휘
 * ================================================================== */

/** 후보가 우리 기록 속 그 상품과 같은 물건인가. */
const IDENTITY = { EXACT: 'EXACT', STRONG: 'STRONG', WEAK: 'WEAK', REJECT: 'REJECT' };

/** 사용자에게 보여줄 상태. REJECTED 는 절대 노출하지 않는다. */
const STATUS = {
  VERIFIED_HOT: 'VERIFIED_HOT',
  GOOD_DEAL: 'GOOD_DEAL',
  POTENTIAL_DEAL: 'POTENTIAL_DEAL',
  NORMAL: 'NORMAL',
  REJECTED: 'REJECTED'
};

/** 이력이 얼마나 믿을 만한가. 점수를 더하는 값이 아니라 점수의 천장이다. */
const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', INSUFFICIENT: 'INSUFFICIENT' };

/** confidence 별 HOT SCORE 상한. 근거가 약하면 아무리 싸도 최고점을 주지 않는다. */
const SCORE_CEILING = { HIGH: 100, MEDIUM: 84, LOW: 69, INSUFFICIENT: 0 };

/** 상태 경계 (위 실측 분포 기준). */
const VERIFIED_HOT_MIN = 70;
const GOOD_DEAL_MIN = 35;

/* ==================================================================
 *  1) 정규화 보조 — PHASE 3
 * ================================================================== */

/**
 * 가격 문자열 → 정수 KRW. "1,590,000원" · " 159000 " · 숫자 전부 처리한다.
 * 0·음수·파싱 불가는 null 이다 (api/_price.parsePrice 규칙 그대로 재사용).
 */
function toKRW(v) { return parsePrice(v); }

/** 앞뒤 공백·제어문자·연속 공백을 정리한 상품명. */
function cleanTitle(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 300);
}

/** http(s) 만 통과. 그 외 스킴(javascript:, data:)은 빈 문자열. */
function safeUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^https?:\/\/[^\s<>"']+$/i.test(s)) return '';
  return s.slice(0, 1000);
}

/* ==================================================================
 *  2) 상품 정체성 — PHASE 4 / GATE 1 · 7
 *
 *  새로 만들지 않는다. 이미 있는 두 모듈을 잇는다.
 *    api/_identity.js  모델코드·연식·세대·용량·색상·매체(중고/리퍼/LP)·번들
 *    api/_search.js    ACCESSORY_TIER (부속 낱말 40종, 실측으로 오탐을 걷어낸 목록)
 * ================================================================== */

let identityMod = null;
function identity() {
  if (identityMod === null) {
    try { identityMod = require('./_identity'); }
    catch (e) { console.warn(`[hotdeal] _identity 로드 실패: ${e.message}`); identityMod = false; }
  }
  return identityMod || null;
}

let searchMod = null;
function searchSide() {
  if (searchMod === null) {
    try { searchMod = require('./_search'); }
    catch (e) { console.warn(`[hotdeal] _search 로드 실패: ${e.message}`); searchMod = false; }
  }
  return searchMod || null;
}

/**
 * 이 제목이 부속(액세서리·소모품·교체부품)인가.
 *
 * _search.ACCESSORY_TIER 를 그대로 쓴다. 그 목록은 실사용 검색에서 오탐을
 * 하나씩 걷어내며 만든 것이라(그 파일 주석 참고) 여기서 다시 만들면 그 학습이
 * 통째로 버려진다.
 */
function isAccessoryTitle(title) {
  const sh = searchSide();
  const t = String(title || '');
  if (!sh || !Array.isArray(sh.ACCESSORY_TIER)) return false;
  return sh.ACCESSORY_TIER.some(pair => t.indexOf(pair[0]) > -1);
}

/**
 * 우리 기록 속 상품(stored)과 외부 후보(candidate)가 같은 물건인가.
 *
 * @param {string} storedTitle    products.title (이력을 가진 쪽)
 * @param {string} candidateTitle 외부 source 상품명
 * @returns {{level:string, reason:string}}
 */
function identityOf(storedTitle, candidateTitle) {
  const a = cleanTitle(storedTitle);
  const b = cleanTitle(candidateTitle);
  if (!a || !b) return { level: IDENTITY.REJECT, reason: '상품명이 비어 있다' };

  /*
   * 본체 ↔ 부속은 유사도를 보기 전에 끊는다.
   * "아이폰 17" 과 "아이폰 17 케이스" 는 낱말이 거의 겹쳐서 유사도만 보면
   * 통과한다 — 실제로 그렇게 케이스가 본체의 대안으로 비교된 적이 있다.
   */
  const accA = isAccessoryTitle(a);
  const accB = isAccessoryTitle(b);
  if (accA !== accB) {
    return { level: IDENTITY.REJECT, reason: accB ? '후보가 부속(액세서리)이다' : '기록 쪽이 부속이다' };
  }

  const id = identity();
  if (!id) return { level: IDENTITY.WEAK, reason: '동일상품 판정 모듈을 쓸 수 없다' };

  // A 동일확실 · B 동일유력 · C 모호 · D 다른 상품
  const j = id.judgeSameProduct(a, b);
  const map = { A: IDENTITY.EXACT, B: IDENTITY.STRONG, C: IDENTITY.WEAK, D: IDENTITY.REJECT };
  return { level: map[j.tier] || IDENTITY.WEAK, reason: (j.reasons && j.reasons[0]) || '' };
}

/* ==================================================================
 *  3) 이력 기준선 — PHASE 5
 * ================================================================== */

function toDay(s) { return String(s || '').slice(0, 10); }
function daysBetween(a, b) {
  const x = Date.parse(toDay(a) + 'T00:00:00Z');
  const y = Date.parse(toDay(b) + 'T00:00:00Z');
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return Math.round((y - x) / 86400000);
}
function medianOf(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function meanOf(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
}

/**
 * 관측 점들에서 판정에 필요한 기준선을 만든다.
 *
 * @param {Array<{date:string, price:number}>} points 날짜별 1점 (오름차순 아니어도 됨)
 * @param {number} currentPrice 지금 source 가 말하는 판매가
 * @param {string} today KST 오늘 'YYYY-MM-DD'
 */
function baselineFrom(points, currentPrice, today) {
  /*
   * 날짜별 1점으로 접는다 (같은 날 여러 행이면 최저가).
   *
   * 호출부(_pricestat.loadStats)가 이미 접어서 주지만 여기서 한 번 더 한다 —
   * 접지 않은 배열이 들어오면 count 가 부풀어 GATE 2(최소 관측)가 통째로
   * 무력해진다. 관측 "횟수"는 날짜 수여야 한다.
   */
  const byDate = new Map();
  (points || []).forEach(p => {
    const date = toDay(p && p.date);
    const price = Math.round(Number(p && p.price) || 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || price <= 0) return;
    const cur = byDate.get(date);
    if (cur === undefined || price < cur) byDate.set(date, price);
  });
  const pts = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(e => ({ date: e[0], price: e[1] }));

  const cur = Math.round(Number(currentPrice) || 0);
  const base = {
    count: pts.length, prices: [], firstDate: '', lastDate: '', span: 0, maxGap: 0,
    staleDays: 0, low: 0, lowCount: 0, lowConfirmed: false, high: 0,
    median: 0, median30: 0, median90: 0, mean30: 0, n30: 0, n90: 0,
    prevObserved: 0, prevObservedDate: '', currentObserved: false,
    pctRank: null, volatility: null, current: cur
  };
  if (!pts.length) return base;

  const prices = pts.map(p => p.price);
  base.prices = prices;
  base.firstDate = pts[0].date;
  base.lastDate = pts[pts.length - 1].date;
  base.span = daysBetween(base.firstDate, base.lastDate);
  for (let i = 1; i < pts.length; i++) {
    const g = daysBetween(pts[i - 1].date, pts[i].date);
    if (g > base.maxGap) base.maxGap = g;
  }
  base.staleDays = today ? Math.max(0, daysBetween(base.lastDate, today)) : 0;

  base.low = Math.min.apply(null, prices);
  base.lowCount = prices.filter(v => v === base.low).length;
  // 다른 날에도 같은 값을 봤을 때만 "확인된" 최저가다. 하루만 본 값은 가설이다.
  base.lowConfirmed = base.lowCount >= 2;
  base.high = Math.max.apply(null, prices);
  base.median = medianOf(prices);

  const cut = n => {
    const d = new Date(Date.parse(toDay(today) + 'T00:00:00Z') - (n - 1) * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const p30 = today ? pts.filter(p => p.date >= cut(30)).map(p => p.price) : prices;
  const p90 = today ? pts.filter(p => p.date >= cut(90)).map(p => p.price) : prices;
  base.n30 = p30.length; base.n90 = p90.length;
  base.median30 = medianOf(p30);
  base.median90 = medianOf(p90);
  base.mean30 = meanOf(p30);

  /*
   * ★ 오늘 관측을 뺀 직전 값.
   *   이것이 있어야 이상치 감지가 자기 자신과 비교하지 않는다. 수집 크론은
   *   KST 01시에 돌기 때문에, 사용자가 낮에 볼 때는 오늘 값이 이미 기록에
   *   들어가 있다. 그것을 "직전"으로 삼으면 어떤 급락도 잡히지 않는다.
   */
  const before = today ? pts.filter(p => p.date < toDay(today)) : pts.slice(0, -1);
  if (before.length) {
    base.prevObserved = before[before.length - 1].price;
    base.prevObservedDate = before[before.length - 1].date;
  }

  // 현재가가 실제로 관측된 값인가. 아니면 "기록상 최저"라고 말할 수 없다.
  base.currentObserved = prices.indexOf(cur) > -1;

  /*
   * 진짜 백분위(순위 기반). (p-low)/(high-low) 같은 min-max 위치를 쓰면
   * 편향된 분포에서 뜻이 뒤집힌다 — 값이 [100,100,100,100,200] 이고 현재가가
   * 125 일 때 min-max 는 25% 를 주지만 실제로는 관측의 80% 보다 비싸다.
   */
  if (cur > 0) {
    const below = prices.filter(v => v < cur).length;
    base.pctRank = Math.round(below / prices.length * 100);
  }

  if (prices.length >= 2) {
    const m = prices.reduce((s, v) => s + v, 0) / prices.length;
    if (m > 0) {
      const varSum = prices.reduce((s, v) => s + (v - m) * (v - m), 0) / prices.length;
      base.volatility = Math.round(Math.sqrt(varSum) / m * 1000) / 10;
    }
  }
  return base;
}

/* ==================================================================
 *  4) 확신도 — PHASE 5 / 8
 * ================================================================== */

/** 관측이 이보다 적으면 점수를 매기지 않는다. */
const MIN_OBS = 3;
/** 이 정도는 되어야 "핫딜"이라고 부를 수 있다 (Balanced 기준선). */
const SCORE_OBS = 5;
/** 하루짜리 데이터로 역대급을 말하지 않는다. */
const MIN_SPAN_DAYS = 3;
/** 이보다 오래 끊긴 구간이 있으면 그 사이를 모른다. */
const MAX_GAP_DAYS = 14;
/** 현재가와 마지막 관측이 이보다 벌어지면 지금 값을 보증할 수 없다. */
const MAX_STALE_DAYS = 7;

function confidenceOf(b) {
  if (!b || b.count < MIN_OBS || b.span < 1) return CONFIDENCE.INSUFFICIENT;
  if (b.count >= 7 && b.span >= 14 && b.maxGap <= 7 && b.staleDays <= 2 && b.n30 >= 3) return CONFIDENCE.HIGH;
  if (b.count >= SCORE_OBS && b.span >= 7 && b.maxGap <= MAX_GAP_DAYS && b.staleDays <= 4) return CONFIDENCE.MEDIUM;
  if (b.count >= MIN_OBS && b.span >= MIN_SPAN_DAYS && b.staleDays <= MAX_STALE_DAYS) return CONFIDENCE.LOW;
  return CONFIDENCE.INSUFFICIENT;
}

/* ==================================================================
 *  5) 하드 게이트 — PHASE 6
 *
 *  점수를 매기기 전에 통과해야 한다. 각 게이트는 왜 막혔는지를 남긴다 —
 *  운영에서 "왜 이 상품이 안 뜨나"를 되짚을 수 있어야 하기 때문이다.
 * ================================================================== */

/** 직전 관측 대비 이 배수를 넘게 떨어지면 같은 상품인지 의심한다. */
const OUTLIER_DROP_RATIO = 0.5;
/** 중앙값 대비 이 배수 밖이면 옵션이 바뀌었거나 다른 상품이 섞였다. */
const OUTLIER_MEDIAN_RATIO = 3;

/**
 * @returns {{passed:boolean, gates:Array<{id:string,ok:boolean,note:string}>}}
 */
function runGates(ctx) {
  const { identityLevel, baseline: b, candidate: c } = ctx;
  const gates = [];
  const add = (id, ok, note) => gates.push({ id, ok: !!ok, note: note || '' });

  // GATE 8 먼저 — 가격이 말이 안 되면 나머지 판단이 전부 무의미하다.
  const priceOk = Number.isFinite(c.salePrice) && c.salePrice > 0;
  add('PRICE_VALID', priceOk, priceOk ? '' : '판매가를 읽지 못했다');

  add('IDENTITY', identityLevel === IDENTITY.EXACT || identityLevel === IDENTITY.STRONG,
    identityLevel === IDENTITY.REJECT ? '다른 상품이거나 부속이다' : (identityLevel === IDENTITY.WEAK ? '동일상품 확신 부족' : ''));

  // GATE 7 은 IDENTITY 안에서 이미 끊기지만, 이유를 따로 남긴다.
  add('PRODUCT_TYPE', !(isAccessoryTitle(c.title) && !isAccessoryTitle(ctx.storedTitle || '')),
    '본체 자리에 부속이 올라왔다');

  add('MIN_OBSERVATIONS', b.count >= MIN_OBS, `관측 ${b.count}회`);
  add('OBSERVATION_SPAN', b.span >= MIN_SPAN_DAYS, `관측 기간 ${b.span}일`);
  add('MAX_GAP', b.maxGap <= MAX_GAP_DAYS, `최대 공백 ${b.maxGap}일`);
  add('FRESHNESS', b.staleDays <= MAX_STALE_DAYS, `마지막 관측 ${b.staleDays}일 전`);

  /*
   * GATE 5 이상치.
   *
   * 두 가지를 본다.
   *   · 오늘을 뺀 직전 관측 대비 절반 이하로 떨어졌다 → 옵션 교체·미끼 의심
   *   · 중앙값의 1/3 아래다 → 같은 자리에 다른 상품이 들어왔을 가능성
   * 둘 다 "싸다"가 아니라 "같은 상품이 맞는지 모르겠다"는 뜻이므로 막는다.
   */
  const suddenDrop = b.prevObserved > 0 && c.salePrice <= b.prevObserved * OUTLIER_DROP_RATIO;
  const belowMedian = b.median > 0 && c.salePrice * OUTLIER_MEDIAN_RATIO <= b.median;
  add('OUTLIER', !suddenDrop && !belowMedian,
    suddenDrop ? `직전 관측(${b.prevObserved}원)의 절반 이하` : (belowMedian ? '평소 가격의 1/3 미만' : ''));

  return { passed: gates.every(g => g.ok), gates };
}

/* ==================================================================
 *  6) HOT SCORE — PHASE 8
 * ================================================================== */

/** 이 할인율에서 각 축이 만점이 된다 (실측 분포상 20%면 상위 0.5% 안쪽). */
const SATURATE = 0.20;
const AX = { MEDIAN30: 45, MEDIAN_ALL: 20, MEDIAN90: 10, LOW_PROXIMITY: 8, RECENT_DROP: 12 };

function discountVs(ref, cur) {
  if (!(ref > 0) || !(cur > 0)) return 0;
  return (ref - cur) / ref;               // + 면 싸다
}
function axis(disc, max) {
  if (disc <= 0) return 0;
  return Math.round(Math.min(1, disc / SATURATE) * max);
}

/**
 * @returns {{score:number, ceiling:number, raw:number, parts:object}}
 */
function hotScore(baseline, confidence) {
  const b = baseline;
  const cur = b.current;
  const parts = { median30: 0, medianAll: 0, median90: 0, lowProximity: 0, recentDrop: 0, volatility: 0 };

  parts.median30 = axis(discountVs(b.median30, cur), AX.MEDIAN30);
  parts.medianAll = axis(discountVs(b.median, cur), AX.MEDIAN_ALL);
  parts.median90 = axis(discountVs(b.median90, cur), AX.MEDIAN90);

  /*
   * 최저가 근접 보너스. 조건이 셋이다.
   *
   *   1) 확인된 최저가일 것 (다른 날에도 같은 값을 봤다)
   *   2) 값이 실제로 움직인 계열일 것 (high > low)
   *      실측에서 계열의 86% 가 "현재가 = 관측 최저"였는데, 76% 가 변동성
   *      0.5% 이하라 값이 안 움직여서 생긴 착시다. 고정가 상품에 최저가
   *      보너스를 주면 평범한 가격이 전부 핫딜이 된다.
   *   3) 최저가 «근처»일 것 — 아래로 한참 벗어난 값은 "확인된 최저가 수준"이
   *      아니라 아직 확인되지 않은 새 값이다. 위아래 2% 띠로 묶는다.
   */
  if (b.lowConfirmed && b.high > b.low && b.low > 0 && cur > 0
    && cur >= Math.round(b.low * 0.98) && cur <= Math.round(b.low * 1.02)) {
    parts.lowProximity = AX.LOW_PROXIMITY;
  }

  // 오늘을 뺀 직전 관측 대비 실제 하락폭. 자기비교가 아니다.
  parts.recentDrop = axis(discountVs(b.prevObserved, cur), AX.RECENT_DROP);

  /*
   * 변동성 감점. 늘 출렁이는 상품에서는 이 정도 가격이 드문 일이 아니다.
   * 실측상 76% 가 변동성 0.5% 이하라 이 감점은 소수에게만 걸린다.
   */
  if (b.volatility != null) {
    if (b.volatility >= 20) parts.volatility = -12;
    else if (b.volatility >= 10) parts.volatility = -6;
  }

  const raw = Math.max(0, Math.min(100,
    parts.median30 + parts.medianAll + parts.median90 + parts.lowProximity + parts.recentDrop + parts.volatility));
  const ceiling = SCORE_CEILING[confidence] === undefined ? 0 : SCORE_CEILING[confidence];
  return { score: Math.min(raw, ceiling), ceiling, raw, parts };
}

/* ==================================================================
 *  7) 상태 판정 — PHASE 7
 * ================================================================== */

function statusOf(ctx) {
  const { gateResult, identityLevel, confidence, score, scoreRaw, currentObserved, sourceFlagged, observationCount } = ctx;

  // 가격·상품 자체가 어긋난 것은 사용자에게 보이지 않는다.
  const hardFail = gateResult.gates.some(g =>
    !g.ok && ['PRICE_VALID', 'IDENTITY', 'PRODUCT_TYPE', 'OUTLIER'].indexOf(g.id) > -1);
  if (hardFail) return STATUS.REJECTED;

  /*
   * ★ POTENTIAL_DEAL 은 "싼 것 같은데 아직 확인을 못 했다"는 뜻이다.
   *   "우리가 그 상품을 잘 모른다"는 뜻이 아니다.
   *
   *   실측(2026-09-06 dry-run, 상품 2,230건)에서 이 구분이 없으면
   *   POTENTIAL_DEAL 이 938건 나왔다. 전부 관측 1회짜리 신규 상품이라
   *   가격 신호가 0인데도 "가능성 있는 딜"로 올라갔다. 그런 목록은
   *   사용자에게 아무것도 알려 주지 않으면서 검증된 8건의 무게만 깎는다.
   *
   *   그래서 둘 중 하나를 요구한다.
   *     · 외부 source 가 스스로 핫딜이라고 표시했거나(sourceFlagged)
   *     · 우리 기준선 대비 실제 할인 신호가 있거나(scoreRaw)
   *   둘 다 없으면 그냥 평범한 상품(NORMAL)이다.
   */
  /*
   * ★ 관측이 1회뿐이면 «신호» 로 치지 않는다.
   *   그 한 점이 그대로 기준선(중앙값)이 되므로 어떤 값을 넣어도 할인율이
   *   계산되지만, 비교 대상이 없어서 GATE 5(이상치)가 아예 돌지 않는다
   *   — prevObserved 가 없기 때문이다. 즉 그 한 점이 잘못 수집된 값이어도
   *   걸러낼 방법이 없는 채로 "20% 저렴"이 만들어진다.
   *   최소 2회는 있어야 값끼리 견줄 수 있다.
   */
  const hasSignal = !!sourceFlagged
    || (observationCount >= 2 && (Number(scoreRaw) || 0) >= GOOD_DEAL_MIN);
  const unverified = identityLevel === IDENTITY.WEAK
    || confidence === CONFIDENCE.INSUFFICIENT
    || !gateResult.passed;
  if (unverified) return hasSignal ? STATUS.POTENTIAL_DEAL : STATUS.NORMAL;

  /*
   * ★ 우리가 아직 관측하지 못한 가격은 VERIFIED 가 아니다.
   *
   * 핫딜 후보의 판매가는 외부 source 가 방금 준 값이라 첫 발견 시점에는
   * price_history 에 없다. 그 값은 관측이 아니라 «주장» 이다 — 옵션이
   * 바뀌었을 수도, source 가 잘못 줬을 수도 있다(실측: 쿠팡 검색 API
   * productPrice 22,320원 ↔ 상품 페이지 26,900원).
   *
   * "VERIFIED" 라는 말은 우리 관측으로 확인했다는 뜻이어야 한다. 그래서
   * 관측되지 않은 값은 아무리 싸도 GOOD_DEAL 까지만 준다. 다음 수집에서
   * 같은 값이 관측되면 그때 VERIFIED_HOT 으로 올라간다 —
   * 이것이 lifecycle 의 NEW → ACTIVE 가 뜻하는 바이기도 하다.
   */
  if (score >= VERIFIED_HOT_MIN && currentObserved
    && (confidence === CONFIDENCE.HIGH || confidence === CONFIDENCE.MEDIUM)) return STATUS.VERIFIED_HOT;
  if (score >= GOOD_DEAL_MIN) return STATUS.GOOD_DEAL;
  return STATUS.NORMAL;
}

/* ==================================================================
 *  8) 근거 문장 — PHASE 9
 *
 *  ★ 전부 DB 값으로 되짚을 수 있어야 한다. 확인되지 않은 것은 말하지 않는다.
 *  ★ "무조건 사세요" 같은 재촉을 넣지 않는다.
 * ================================================================== */

function won(v) { return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function pct(x) { return Math.round(x * 1000) / 10; }

/**
 * @returns {Array<{text:string, kind:string}>} 최대 4개
 */
function reasonsFor(b, status) {
  const out = [];
  const add = (kind, text) => { if (out.length < 4 && text) out.push({ kind, text }); };
  const cur = b.current;

  const d30 = discountVs(b.median30, cur);
  if (b.n30 >= 3 && d30 >= 0.03) {
    add('median30', `최근 30일 중앙값(${won(b.median30)}원)보다 ${pct(d30)}% 저렴`);
  }

  /*
   * 순위 문장은 두 조건을 다 만족할 때만 쓴다.
   *   · 현재가가 실제로 관측된 값일 것 — 기록에 없는 값을 "N번 중 1번째"라고
   *     말하면 세지 않은 것을 센 것이 된다.
   *   · 값이 실제로 움직인 계열일 것 — 30번 모두 같은 가격인데 "30번 중
   *     1번째로 낮음"이라고 하면 사실이지만 아무 뜻이 없고, 싸다는 인상만 준다.
   */
  if (b.currentObserved && b.high > b.low && b.count >= 3 && b.pctRank != null) {
    const rank = b.prices.filter(v => v < cur).length + 1;
    if (rank <= 3) add('rank', `SEOSA가 확인한 ${b.count}번의 가격 중 ${rank}번째로 낮음`);
  } else if (!b.currentObserved && cur > 0 && b.low > 0 && cur < b.low) {
    // 관측 밖의 더 낮은 값 — 사실대로 "아직 확인 중"이라고 말한다.
    add('unconfirmed', `기록상 최저 ${won(b.low)}원보다 낮지만 이번에 처음 본 값이라 확인 중`);
  }

  if (b.prevObserved > 0 && cur > 0 && cur < b.prevObserved) {
    add('drop', `직전 확인(${b.prevObservedDate})보다 ${won(b.prevObserved - cur)}원 하락`);
  }

  // 점수 쪽 lowProximity 와 같은 조건을 쓴다 — 문장과 점수가 갈리면 안 된다.
  if (b.lowConfirmed && b.high > b.low && b.low > 0
    && cur >= Math.round(b.low * 0.98) && cur <= Math.round(b.low * 1.02)) {
    add('low', `확인된 최저가(${won(b.low)}원) 수준`);
  }

  if (status === STATUS.POTENTIAL_DEAL) {
    if (b.count < MIN_OBS) add('data', `SEOSA 가격 기록이 ${b.count}회뿐이라 아직 검증 중`);
    else if (b.staleDays > MAX_STALE_DAYS) add('data', `마지막 확인이 ${b.staleDays}일 전이라 검증 중`);
  }

  if (!out.length) add('neutral', '평소 가격과 큰 차이가 없음');
  return out;
}

/* ==================================================================
 *  9) 종합
 * ================================================================== */

/**
 * 후보 하나를 판정한다.
 *
 * @param {object} input
 *   candidate    normalizeCandidate() 결과 {title, salePrice, referencePrice, ...}
 *   storedTitle  우리 products.title (이력의 주인)
 *   points       [{date, price}] 그 상품·그 옵션의 관측 점
 *   today        KST 'YYYY-MM-DD'
 * @returns {object} 저장·노출에 필요한 전부
 */
function evaluate(input) {
  const c = (input && input.candidate) || {};
  const storedTitle = (input && input.storedTitle) || '';
  const today = (input && input.today) || '';

  const idr = identityOf(storedTitle, c.title);
  const baseline = baselineFrom((input && input.points) || [], c.salePrice, today);
  const gateResult = runGates({ identityLevel: idr.level, baseline, candidate: c, storedTitle });
  const confidence = confidenceOf(baseline);
  const scored = hotScore(baseline, confidence);
  const status = statusOf({
    gateResult, identityLevel: idr.level, confidence,
    score: scored.score, scoreRaw: scored.raw, observationCount: baseline.count,
    currentObserved: baseline.currentObserved,
    // 외부 source 가 스스로 "핫딜"이라고 표시해서 온 후보인가.
    sourceFlagged: !!(input && input.sourceFlagged)
  });

  return {
    status,
    hotScore: status === STATUS.REJECTED ? 0 : scored.score,
    scoreRaw: scored.raw,
    scoreCeiling: scored.ceiling,
    scoreParts: scored.parts,
    confidence,
    identityConfidence: idr.level,
    identityReason: idr.reason,
    gates: gateResult.gates,
    baseline,
    reasons: status === STATUS.REJECTED ? [] : reasonsFor(baseline, status)
  };
}

module.exports = {
  IDENTITY, STATUS, CONFIDENCE, SCORE_CEILING,
  VERIFIED_HOT_MIN, GOOD_DEAL_MIN,
  MIN_OBS, SCORE_OBS, MIN_SPAN_DAYS, MAX_GAP_DAYS, MAX_STALE_DAYS,
  toKRW, cleanTitle, safeUrl,
  isAccessoryTitle, identityOf,
  baselineFrom, confidenceOf, runGates, hotScore, statusOf, reasonsFor,
  evaluate
};
