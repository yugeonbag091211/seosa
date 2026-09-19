'use strict';
/*
 * SEOSA 일일 가격 하락 — "어제보다 오늘 실제로 내려갔는가".
 *
 * ── 왜 이 파일이 생겼나 (2026-09-20 감사) ────────────────────────────
 *
 * 화면의 «핫딜» 창이 며칠째 같은 얼굴이었다. 원인은 캐시가 아니라 정의였다.
 *
 *   api/_hotdeal.js 의 HOT SCORE 는 100점 중 83점이 중앙값 비교에서 나온다
 *   (median30 45 · medianAll 20 · median90 10 · lowProximity 8). 30·90일
 *   중앙값은 하루 사이에 거의 움직이지 않으므로 순위도 거의 움직이지 않는다.
 *   «어제보다 내려갔는가» 를 보는 축(recentDrop)은 12점뿐이고, 그나마
 *   «오늘/어제» 가 아니라 «오늘을 뺀 직전 관측» 이라 며칠 전 값일 수 있다.
 *
 * 그래서 노출의 «정의» 를 여기로 옮긴다.
 *
 *   HOT DEAL = 어제의 정상가보다 오늘의 정상가가 실제로 내려간 상품 중
 *              하락폭이 큰 상품
 *
 * _hotdeal.js 는 그대로 둔다. 그쪽은 여전히 «이 값이 믿을 만한가»(동일성·
 * 이상치·관측 충분성)를 판정하는 정밀도 관문이고, 이 파일은 «무엇을 위로
 * 올릴 것인가»를 정하는 정의다. 둘 다 통과해야 노출된다.
 *
 * ── 비교 규칙 (하나라도 어긋나면 비교하지 않는다) ────────────────────
 *
 *   같은 product_id · 같은 mall · 같은 옵션(vendor_item_id/item_id) 끼리만.
 *   오늘   = KST 오늘의 «마지막» 유효 관측
 *   어제   = KST 어제의 «마지막» 유효 관측
 *
 *   날짜는 recorded_date 라벨이 아니라 recorded_at 에서 KST 로 다시 뽑는다.
 *   2026-08-27 이전 행 9,040개가 UTC 라벨을 달고 있어서 라벨을 믿으면 하루가
 *   밀린다 (api/_shop.js recordPrices 주석의 실측 참고).
 *
 * ── 임계값은 실측 분포에서 정했다 (2026-09-09 ~ 09-19, 11일) ──────────
 *
 *   하루에 오늘·어제 둘 다 관측된 계열 약 2,050개, 그중 내려간 계열:
 *
 *     기준        11일 합계   하루 후보 (최소/중앙/최대)
 *     pct ≥  0      1,374        52 /  91 / 364
 *     pct ≥  1        996        36 /  65 / 296
 *     pct ≥  3        763        30 /  42 / 222
 *     pct ≥  5        544        22 /  32 / 175   ← 채택
 *     pct ≥ 10        302        12 /  20 /  96
 *
 *   MIN_PCT=5 를 고른 이유: 하루 22~175개라 24칸짜리 목록이 비지 않으면서,
 *   그날 관측된 계열의 상위 2.4% 만 남는다. 3% 로 내리면 중앙값 근처의
 *   평범한 등락이 섞이고, 10% 로 올리면 최소 12개까지 줄어 목록이 빈다.
 *
 *   MIN_AMOUNT=500 을 고른 이유: pct≥5 후보 544개 중 500원 미만은 17개
 *   (3.1%) 뿐이라 진짜 딜을 거의 지우지 않으면서, 7,590→7,490 같은 반올림
 *   수준의 잔변동만 걸러낸다. 1,000원으로 올리면 11.4%(62개)가 사라진다 —
 *   그건 거르는 게 아니라 버리는 것이다.
 *
 *   ★ «퍼센트만 보면 싼 물건이 상단을 독점하는가» 도 실측으로 확인했다.
 *     pct≥5 후보 544개 중 오늘 가격 10,000원 미만은 63개(11.6%),
 *     5,000원 미만은 18개(3.3%) 뿐이다. 독점이 일어나지 않으므로
 *     최소 «가격» 기준은 두지 않는다 (없는 문제를 막는 규칙은 두지 않는다).
 */

const { parsePrice, observedKstDate, kstToday, vendorIdOf, MAX_PLAUSIBLE_DROP_PCT } = require('./_price');

/** 하락률이 이 아래면 «딜» 이라고 부르지 않는다. 위 실측 분포 참고. */
const MIN_DROP_PCT = Number(process.env.HOTDEAL_MIN_DROP_PCT) || 5;

/** 하락액이 이 아래면 반올림 수준의 잔변동으로 본다. 위 실측 분포 참고. */
const MIN_DROP_AMOUNT = Number(process.env.HOTDEAL_MIN_DROP_AMOUNT) || 500;

/**
 * 왜 후보가 아닌지. 화면에 내보내는 값이 아니라 «되짚을 수 있게» 남기는 값이다.
 * 새 이유를 추가할 때는 반드시 여기에 이름을 먼저 만든다 — 문자열을 호출부에서
 * 지어내면 집계가 되지 않는다.
 */
const REASON = {
  OK: 'OK',
  NO_POINTS: 'NO_POINTS',                 // 이력이 아예 없다
  NO_TODAY: 'NO_TODAY',                   // 오늘(KST) 유효 관측이 없다 → stale
  NO_YESTERDAY: 'NO_YESTERDAY',           // 어제(KST) 유효 관측이 없다 → 비교 불가
  NOT_LOWER: 'NOT_LOWER',                 // 같거나 올랐다
  BELOW_MIN_PCT: 'BELOW_MIN_PCT',
  BELOW_MIN_AMOUNT: 'BELOW_MIN_AMOUNT',
  IMPLAUSIBLE: 'IMPLAUSIBLE'              // 80%↑ — 인하가 아니라 매칭 오류로 본다
};

/** KST 로 하루 전 날짜 문자열. 문자열 → 문자열이라 시간대가 끼어들 자리가 없다. */
function kstYesterday(today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return '';
  return new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}

/** 0·음수·파싱 불가는 «관측» 으로 치지 않는다. */
function validPrice(v) {
  if (typeof v === 'string' && /^\s*[-−–]/.test(v)) return 0;
  const n = parsePrice(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 한 날짜의 «마지막» 유효 관측.
 *
 * 같은 날 여러 번 관측되면(수집기 + 사용자 검색) 늦게 본 쪽이 그날의 값이다.
 * 순서는 recorded_at 으로 가른다 — 라벨(recorded_date)은 같은 날 안에서
 * 순서를 말해 주지 않는다.
 */
function lastOn(points, day) {
  let best = null, bestAt = '';
  for (const pt of points || []) {
    if (!pt) continue;
    if (observedKstDate(pt) !== day) continue;
    const price = validPrice(pt.price);
    if (!price) continue;
    const at = String(pt.recorded_at || pt.observedAt || pt.recorded_date || '');
    if (best === null || at > bestAt) { best = { price, at, point: pt }; bestAt = at; }
  }
  return best;
}

/**
 * 한 옵션 계열의 오늘 vs 어제.
 *
 * @param {object[]} points  같은 (product_id, mall, 옵션)의 price_history 행들.
 *                           행은 { price, recorded_at, recorded_date } 모양이면 된다.
 * @param {object}   opts    { today, minPct, minAmount }
 * @returns {{ok:boolean, reason:string, todayPrice:number, yesterdayPrice:number,
 *            amount:number, pct:number, todayAt:string, yesterdayAt:string}}
 */
function dailyDrop(points, opts = {}) {
  const today = opts.today || kstToday();
  const yesterday = kstYesterday(today);
  const minPct = opts.minPct == null ? MIN_DROP_PCT : Number(opts.minPct);
  const minAmount = opts.minAmount == null ? MIN_DROP_AMOUNT : Number(opts.minAmount);

  const out = {
    ok: false, reason: REASON.NO_POINTS,
    todayPrice: 0, yesterdayPrice: 0, amount: 0, pct: 0,
    todayAt: '', yesterdayAt: ''
  };
  if (!points || !points.length || !yesterday) return out;

  const t = lastOn(points, today);
  if (!t) { out.reason = REASON.NO_TODAY; return out; }
  out.todayPrice = t.price; out.todayAt = t.at;

  const y = lastOn(points, yesterday);
  if (!y) { out.reason = REASON.NO_YESTERDAY; return out; }
  out.yesterdayPrice = y.price; out.yesterdayAt = y.at;

  if (t.price >= y.price) { out.reason = REASON.NOT_LOWER; return out; }

  out.amount = y.price - t.price;
  // 소수 한 자리. 화면과 정렬이 같은 값을 보도록 여기서 한 번만 반올림한다.
  out.pct = Math.round((out.amount / y.price) * 1000) / 10;

  /*
   * 80% 넘는 하락은 인하가 아니라 매칭 오류로 본다 — 저장 단계의
   * SUSPECT_RATIO 와 같은 선이다 (_price.MAX_PLAUSIBLE_DROP_PCT 주석 참고).
   * 이 관문을 먼저 둔다. 임계값 미달보다 «값이 틀렸다» 가 더 중요한 이유다.
   */
  if (out.pct >= MAX_PLAUSIBLE_DROP_PCT) { out.reason = REASON.IMPLAUSIBLE; return out; }
  if (out.pct < minPct) { out.reason = REASON.BELOW_MIN_PCT; return out; }
  if (out.amount < minAmount) { out.reason = REASON.BELOW_MIN_AMOUNT; return out; }

  out.ok = true; out.reason = REASON.OK;
  return out;
}

/**
 * 옵션 계열 키. 비교는 반드시 이 키가 같은 것끼리만 한다.
 *
 * 옵션 식별자는 _price.vendorIdOf 로 구한다 — 컬럼이 비면 link 에서 뽑는
 * 바로 그 규칙이다. 저장 키와 비교 키가 다른 함수에서 나오면, 옵션이 바뀐
 * 상품에서 «다른 옵션의 어제 가격» 이 붙는다.
 */
function seriesKey(row) {
  if (!row) return '';
  return `${row.product_id || row.productId || ''}|${row.mall || ''}|${vendorIdOf(row) || ''}`;
}

/**
 * 같은 product_id 의 여러 옵션 중 목록에 올릴 대표 하나를 고른다.
 *
 * ★ 옵션별 하락은 «옵션 계열 안에서» 이미 계산해 두고, 여기서는 고르기만 한다.
 *   옵션을 먼저 합쳐서 계산하면 A 옵션의 어제와 B 옵션의 오늘을 비교하게 된다.
 *
 * 고르는 기준(동점이면 다음 기준으로):
 *   1) 하락률이 큰 것          — 목록의 정렬 기준과 같아야 한다
 *   2) 하락액이 큰 것
 *   3) 오늘 관측이 늦은 것     — 같은 값이면 더 최근에 확인한 쪽
 *   4) 계열 키 사전순          — 마지막 동점 해소. 같은 입력에 같은 결과를 보장한다
 */
function pickPrimary(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (b.pct !== a.pct) return b.pct > a.pct ? b : a;
  if (b.amount !== a.amount) return b.amount > a.amount ? b : a;
  if (b.todayAt !== a.todayAt) return b.todayAt > a.todayAt ? b : a;
  return String(b.key || '') < String(a.key || '') ? b : a;
}

/**
 * 하락 후보 정렬. 사용자에게 «어제보다 많이 깎인 것» 이 위로 온다.
 *
 *   1) 하락률 DESC
 *   2) 하락액 DESC
 *   3) 오늘 관측 시각 DESC (신선도)
 *   4) 키 ASC — 같은 입력에 같은 순서
 */
function compareDrops(a, b) {
  if (b.pct !== a.pct) return b.pct - a.pct;
  if (b.amount !== a.amount) return b.amount - a.amount;
  if (b.todayAt !== a.todayAt) return b.todayAt > a.todayAt ? 1 : -1;
  return String(a.key || '') < String(b.key || '') ? -1 : 1;
}

module.exports = {
  MIN_DROP_PCT, MIN_DROP_AMOUNT, REASON,
  kstYesterday, lastOn, dailyDrop, seriesKey, pickPrimary, compareDrops
};
