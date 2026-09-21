'use strict';
/*
 * 홈 «핫딜» 의 기본 목록 — 오늘(KST) 실제로 가격이 내려간 상품.
 *
 * ── 왜 이 파일이 생겼나 (2026-09-21) ────────────────────────────────
 *
 * 홈은 /api/hotdeals 의 검증 통과분(VERIFIED_HOT / GOOD_DEAL)만 보여 주고
 * 있었다. 그 관문은 «이 값을 믿을 수 있는가» 를 아주 엄격하게 따지므로
 * 통과하는 행이 극히 적다.
 *
 *   2026-09-21 09:07 KST 운영 실측
 *     price_history 오늘 관측 계열            2,134
 *     그중 직전 관측보다 내려간 계열(타당)        40
 *     그중 노출 기준(5% 또는 1,000원) 통과        24
 *     ────────────────────────────────────────────
 *     hotdeals 에서 홈에 뜨던 검증 통과분           2   ← 화면에 보이던 전부
 *
 * 즉 «오늘 내려간 상품» 24개 중 22개가 화면에 오르지 못했다. 사용자가 홈에
 * 오는 이유가 바로 그 22개인데도 그렇다.
 *
 * 그래서 노출의 «기본» 을 바꾼다.
 *
 *   기본 목록 = 오늘 실제로 내려간 상품 (이 파일)
 *   그중 기존 엔진까지 통과한 것 = «SEOSA 검증» 배지 (applyVerified)
 *
 * 엔진을 지우지 않는다. VERIFIED_HOT / GOOD_DEAL 판정도 그대로다. 달라지는
 * 것은 «검증을 통과해야 목록에 오른다» → «목록에 오르되 검증은 배지로
 * 구분한다» 뿐이다. 검증된 것이 항상 먼저 온다(compareCards).
 *
 * ── api/_dailydrop.js 와 무엇이 다른가 ──────────────────────────────
 *
 * _dailydrop.js 는 수집기(scripts/collect-hotdeals.js)가 «핫딜 후보» 를 고를
 * 때 쓰는 정의다. 그쪽은 비교 대상이 «어제» 로 못 박혀 있고(NO_YESTERDAY),
 * 관문이 «5% 그리고 500원» 이다. 그 규칙은 그대로 둔다 — 수집기의 판정을
 * 흔들면 hotdeals 표의 뜻이 달라진다.
 *
 * 홈 목록은 다른 두 가지가 필요하다.
 *
 *   ① 비교 대상은 «오늘보다 이전의 가장 최근 유효 관측» 이다.
 *      수집기는 카탈로그를 나눠 돌기 때문에(PR #56 전체 회전) 어제 관측이
 *      없는 계열이 흔하다. 어제로 못 박으면 그 계열은 통째로 사라진다.
 *      2026-09-21 실측: 오늘 관측 2,134 계열 중 직전 관측을 찾을 수 있는
 *      것이 2,002 개였고, 그 안에서 하락 40 건이 나왔다.
 *
 *   ② 관문이 «5% 또는 1,000원» 이다 (AND 가 아니라 OR).
 *      100,000 → 99,000 은 1% 지만 1,000원이다. 비싼 물건의 천 원 단위
 *      인하를 퍼센트만으로 버리면 «실제로 내려간 상품» 이라는 이름과
 *      맞지 않는다.
 *
 * ── 절대 어기지 않는 선 ─────────────────────────────────────────────
 *
 *   · 비교는 (product_id, mall, 옵션) 이 «모두» 같은 관측끼리만 한다.
 *     다른 옵션의 가격을 비교하면 하락이 아니라 다른 상품이다.
 *   · KST 날짜는 recorded_date 라벨이 아니라 recorded_at 에서 다시 뽑는다
 *     (_price.observedKstDate — 라벨은 UTC 로 잘려 저장된다).
 *   · 80% 이상 하락은 인하가 아니라 매칭 오류로 본다
 *     (_price.MAX_PLAUSIBLE_DROP_PCT — 저장 단계와 같은 잣대).
 *   · 0·음수·파싱 불가는 관측으로 치지 않는다.
 *   · 이 파일은 읽지도 쓰지도 않는다. 순수 계산만 한다 (시험이 쉬워진다).
 */

const {
  parsePrice, observedKstDate, kstToday,
  vendorIdOf, itemIdOf, coupangItemIds, MAX_PLAUSIBLE_DROP_PCT
} = require('./_price');

/** 하락률이 이 이상이면 노출. 하락액 기준과 «또는» 으로 묶인다. */
const MIN_DROP_PCT = Number(process.env.HOME_DROP_MIN_PCT) || 5;
/** 하락액이 이 이상이면 노출. 비싼 물건의 천 원 단위 인하를 살린다. */
const MIN_DROP_AMOUNT = Number(process.env.HOME_DROP_MIN_AMOUNT) || 1000;

/** «SEOSA 검증» 배지를 붙일 수 있는 판정. 기존 엔진의 값 그대로다. */
const VERIFIED_STATUS = ['VERIFIED_HOT', 'GOOD_DEAL'];
/** 살아 있는 딜만 검증으로 친다. COOLING 은 식은 딜이라 배지를 주지 않는다. */
const VERIFIED_LIFECYCLE = ['NEW', 'ACTIVE'];

const BADGE_VERIFIED = 'SEOSA 검증';
const BADGE_TODAY = '오늘 가격 하락';

/**
 * 왜 후보가 아닌지. 화면에 나가는 값이 아니라 «되짚을 수 있게» 남기는 값이다.
 * 새 이유는 반드시 여기에 이름을 먼저 만든다 — 호출부에서 문자열을 지어내면
 * 집계가 되지 않는다 (_dailydrop.REASON 과 같은 규칙).
 */
const REASON = {
  OK: 'OK',
  NO_POINTS: 'NO_POINTS',            // 계열에 관측이 하나도 없다
  NO_TODAY: 'NO_TODAY',              // 오늘(KST) 유효 관측이 없다 → stale
  NO_PREVIOUS: 'NO_PREVIOUS',        // 오늘 이전의 유효 관측이 없다 → 비교 불가
  NOT_LOWER: 'NOT_LOWER',            // 같거나 올랐다
  IMPLAUSIBLE: 'IMPLAUSIBLE',        // 80%↑ — 인하가 아니라 매칭 오류
  BELOW_THRESHOLD: 'BELOW_THRESHOLD' // 5% 도 1,000원도 아니다
};

/**
 * '' 와 '__LEGACY__' 는 «옵션을 모른다» 는 뜻이지 «다른 옵션» 이라는 뜻이
 * 아니다 (_price.sameVendorRows 주석의 규칙). 둘 다 빈 값으로 접는다.
 */
function normId(v) {
  const s = String(v == null ? '' : v).trim();
  return (s && s !== '__LEGACY__') ? s : '';
}

/**
 * 이 관측의 옵션 식별자. 비교는 반드시 이 값이 같은 것끼리만 한다.
 *
 * 순서는 프로젝트의 공식 규칙 그대로다.
 *   1) vendor_item_id 컬럼 → 없으면 link 의 vendorItemId  (_price.vendorIdOf)
 *   2) item_id 컬럼        → 없으면 link 의 itemId        (_price.itemIdOf)
 *
 * ★ itemId 계열에는 'i:' 를 붙인다. 접두사가 없으면 «vendorItemId 12345» 와
 *   «itemId 12345» 가 같은 계열로 접힌다 — 서로 다른 옵션이다.
 *
 * ★ vendorIdOf 는 컬럼에 '__LEGACY__' 가 들어 있으면 그 값을 그대로 돌려준다.
 *   그건 «마이그레이션이 link 에서도 못 뽑았다» 는 표시지 옵션 값이 아니므로
 *   여기서는 한 번 더 link 를 본다 (_shop.js 433행 주석 참고).
 */
function optionIdOf(row) {
  if (!row) return '';
  const link = row.link;
  const vid = normId(vendorIdOf(row)) || normId(coupangItemIds(link).vendorItemId);
  if (vid) return vid;
  const iid = normId(itemIdOf(row)) || normId(coupangItemIds(link).itemId);
  return iid ? 'i:' + iid : '';
}

/** 화면·이력 조회에 그대로 쓰는 진짜 vendor_item_id. 모르면 빈 문자열이다. */
function vendorItemIdOf(row) {
  if (!row) return '';
  return normId(vendorIdOf(row)) || normId(coupangItemIds(row.link).vendorItemId);
}

/** 옵션 계열 키 — 이 값이 같은 관측끼리만 비교한다. */
function seriesKeyOf(row) {
  if (!row) return '||';
  return `${row.product_id || ''}|${row.mall || ''}|${optionIdOf(row)}`;
}

/** 사용자에게 보여줄 단위 — 같은 상품·같은 몰은 옵션이 달라도 카드 한 장이다. */
function productKeyOf(row) {
  if (!row) return '|';
  return `${row.product_id || ''}|${row.mall || ''}`;
}

/** 0·음수·파싱 불가는 «관측» 으로 치지 않는다 (_dailydrop.validPrice 와 같다). */
function validPrice(v) {
  if (typeof v === 'string' && /^\s*[-−–]/.test(v)) return 0;
  const n = parsePrice(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 같은 날 여러 관측이 있으면 늦게 본 쪽이 그날의 값이다. 순서는 recorded_at. */
function atOf(pt) {
  return String((pt && (pt.recorded_at || pt.observedAt || pt.recorded_date)) || '');
}

/**
 * 오늘(KST)의 «마지막» 유효 관측.
 *
 * 같은 날 수집기와 사용자 검색이 둘 다 기록을 남길 수 있다. 나중에 본 값이
 * 지금 팔리는 값이므로 그것이 오늘의 가격이다.
 */
function lastOn(points, day) {
  let best = null, bestAt = '';
  for (const pt of points || []) {
    if (!pt || observedKstDate(pt) !== day) continue;
    const price = validPrice(pt.price);
    if (!price) continue;
    const at = atOf(pt);
    if (best === null || at > bestAt) { best = { price, at, point: pt }; bestAt = at; }
  }
  return best;
}

/**
 * 오늘보다 «이전» 의 가장 최근 유효 관측.
 *
 * ★ 어제로 못 박지 않는다. 수집기가 카탈로그를 나눠 돌기 때문에 어제 관측이
 *   없는 계열이 흔하고, 그때 «비교 불가» 로 버리면 실제로 내려간 상품이
 *   화면에서 사라진다. 대신 «언제의 값인지» 를 previousAt 으로 함께 싣는다 —
 *   화면이 필요하면 그 날짜를 말할 수 있다.
 * ★ 미래 날짜는 근거가 아니다 (_price.todayDropConfirmed 와 같은 규칙).
 */
function latestBefore(points, day) {
  let best = null, bestAt = '';
  for (const pt of points || []) {
    if (!pt) continue;
    const d = observedKstDate(pt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d >= day) continue;
    const price = validPrice(pt.price);
    if (!price) continue;
    const at = atOf(pt);
    if (best === null || at > bestAt) { best = { price, at, point: pt }; bestAt = at; }
  }
  return best;
}

/** 노출 관문. 퍼센트 «또는» 금액 — 둘 중 하나만 넘으면 된다. */
function meetsThreshold(pct, amount, minPct, minAmount) {
  const p = minPct == null ? MIN_DROP_PCT : Number(minPct);
  const a = minAmount == null ? MIN_DROP_AMOUNT : Number(minAmount);
  return pct >= p || amount >= a;
}

/**
 * 한 옵션 계열의 «오늘 vs 직전 관측».
 *
 * @param {object[]} points  같은 (product_id, mall, 옵션)의 price_history 행
 * @param {object}   opts    { today, minPct, minAmount }
 * @returns {{ok:boolean, reason:string, lowered:boolean,
 *            todayPrice:number, previousPrice:number, amount:number, pct:number,
 *            todayAt:string, previousAt:string, todayPoint:object|null}}
 */
function todayDrop(points, opts = {}) {
  const today = opts.today || kstToday();
  const out = {
    ok: false, reason: REASON.NO_POINTS, lowered: false,
    todayPrice: 0, previousPrice: 0, amount: 0, pct: 0,
    todayAt: '', previousAt: '', todayPoint: null
  };
  if (!points || !points.length) return out;

  const t = lastOn(points, today);
  if (!t) { out.reason = REASON.NO_TODAY; return out; }
  out.todayPrice = t.price; out.todayAt = t.at; out.todayPoint = t.point;

  const p = latestBefore(points, today);
  if (!p) { out.reason = REASON.NO_PREVIOUS; return out; }
  out.previousPrice = p.price; out.previousAt = p.at;

  if (t.price >= p.price) { out.reason = REASON.NOT_LOWER; return out; }

  out.amount = p.price - t.price;
  // 소수 한 자리. 화면과 정렬이 같은 값을 보도록 여기서 한 번만 반올림한다.
  out.pct = Math.round((out.amount / p.price) * 1000) / 10;

  /*
   * 값이 틀렸을 가능성을 임계값보다 먼저 본다. 80% 넘는 하락은 인하가 아니라
   * 옵션·묶음 매칭 오류다 (_price.MAX_PLAUSIBLE_DROP_PCT 주석의 실측 참고).
   */
  if (out.pct >= MAX_PLAUSIBLE_DROP_PCT) { out.reason = REASON.IMPLAUSIBLE; return out; }

  out.lowered = true;
  if (!meetsThreshold(out.pct, out.amount, opts.minPct, opts.minAmount)) {
    out.reason = REASON.BELOW_THRESHOLD;
    return out;
  }

  out.ok = true; out.reason = REASON.OK;
  return out;
}

/**
 * 같은 상품(product_id + mall)의 여러 옵션 중 카드에 올릴 대표 하나.
 *
 * ★ 하락은 «옵션 계열 안에서» 이미 계산해 두고 여기서는 고르기만 한다.
 *   옵션을 먼저 합쳐서 계산하면 A 옵션의 어제와 B 옵션의 오늘을 비교하게 된다.
 *
 *   1) 하락률이 큰 것      — 목록 정렬 기준과 같아야 한다
 *   2) 하락액이 큰 것
 *   3) 오늘 관측이 늦은 것
 *   4) 계열 키 사전순      — 마지막 동점 해소. 같은 입력에 같은 결과를 보장한다
 */
function pickPrimary(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (b.dropPct !== a.dropPct) return b.dropPct > a.dropPct ? b : a;
  if (b.dropAmount !== a.dropAmount) return b.dropAmount > a.dropAmount ? b : a;
  if (b.recordedAt !== a.recordedAt) return b.recordedAt > a.recordedAt ? b : a;
  return String(b.key || '') < String(a.key || '') ? b : a;
}

/**
 * 홈 목록 정렬.
 *
 *   1) verified DESC       검증된 것이 먼저
 *   2) 하락률 DESC
 *   3) 하락액 DESC
 *   4) 오늘 관측 시각 DESC (신선도)
 *   5) 계열 키 ASC         — 결정론. 이것이 없으면 새로고침마다 순서가 흔들려
 *                            방금 본 카드를 다시 찾지 못한다
 */
function compareCards(a, b) {
  if (a.verified !== b.verified) return a.verified ? -1 : 1;
  if (b.dropPct !== a.dropPct) return b.dropPct - a.dropPct;
  if (b.dropAmount !== a.dropAmount) return b.dropAmount - a.dropAmount;
  if (b.recordedAt !== a.recordedAt) return b.recordedAt > a.recordedAt ? 1 : -1;
  return String(a.key || '') < String(b.key || '') ? -1 : 1;
}

/**
 * price_history 원장 행 묶음 → 오늘 내려간 상품 카드.
 *
 * @param {object[]} rows  price_history 행. 오늘치와 그 이전치가 섞여 있어도 된다.
 * @param {object}   opts  { today, minPct, minAmount }
 * @returns {{items:object[], stats:object}}
 */
function buildDrops(rows, opts = {}) {
  const today = opts.today || kstToday();

  const bySeries = new Map();
  for (const row of rows || []) {
    if (!row || !row.product_id) continue;
    const key = seriesKeyOf(row);
    let bucket = bySeries.get(key);
    if (!bucket) { bucket = []; bySeries.set(key, bucket); }
    bucket.push(row);
  }

  const stats = { series: bySeries.size, lowered: 0, passed: 0, cards: 0, reasons: {} };
  const byProduct = new Map();

  for (const [key, points] of bySeries) {
    const d = todayDrop(points, { today, minPct: opts.minPct, minAmount: opts.minAmount });
    if (d.lowered) stats.lowered++;
    stats.reasons[d.reason] = (stats.reasons[d.reason] || 0) + 1;
    if (!d.ok) continue;
    stats.passed++;

    const src = d.todayPoint || points[0];
    const card = {
      key,
      productId: String(src.product_id || ''),
      mall: String(src.mall || ''),
      vendorItemId: vendorItemIdOf(src),
      optionId: optionIdOf(src),
      title: String(src.title || ''),
      // 원장의 link 는 마지막 수단이다. 호출부가 products / hotdeals 의
      // 제휴 링크를 우선해서 덮어쓴다 (api/hotdeals.js linkFor).
      historyLink: String(src.link || ''),
      currentPrice: d.todayPrice,
      previousPrice: d.previousPrice,
      dropAmount: d.amount,
      dropPct: d.pct,
      recordedAt: d.todayAt,
      previousAt: d.previousAt,
      // 검증 정보는 applyVerified 가 채운다. 여기서는 «아직 모른다» 가 아니라
      // «검증되지 않았다» 로 두어, 병합을 건너뛰어도 계약이 성립하게 한다.
      verified: false,
      badge: BADGE_TODAY,
      dealStatus: null,
      hotScore: null,
      dealId: null,
      dealUrl: '',
      dealImage: ''
    };

    const pk = productKeyOf(src);
    byProduct.set(pk, pickPrimary(byProduct.get(pk), card));
  }

  const items = Array.from(byProduct.values()).sort(compareCards);
  stats.cards = items.length;
  return { items, stats };
}

/** 이 hotdeals 행이 지금 «검증됨» 이라고 말할 수 있는가. */
function isVerifiedDeal(row, now) {
  if (!row) return false;
  if (VERIFIED_STATUS.indexOf(row.deal_status) < 0) return false;
  if (VERIFIED_LIFECYCLE.indexOf(row.lifecycle) < 0) return false;
  if (row.is_primary !== true) return false;
  if (row.expires_at) {
    const t = Date.parse(row.expires_at);
    if (Number.isFinite(t) && t <= now) return false;
  }
  return true;
}

/** 같은 상품에 검증 행이 여럿이면 더 센 판정 → 높은 점수 → 작은 id 순으로 고른다. */
function betterDeal(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rank = r => (r.deal_status === 'VERIFIED_HOT' ? 1 : 0);
  if (rank(b) !== rank(a)) return rank(b) > rank(a) ? b : a;
  const score = r => Number(r.hot_score) || 0;
  if (score(b) !== score(a)) return score(b) > score(a) ? b : a;
  return Number(b.id) < Number(a.id) ? b : a;
}

/**
 * 오늘 하락 카드에 기존 엔진의 검증 여부를 «덧붙인다».
 *
 * ★ 검증되지 않았다고 목록에서 빼지 않는다. 그게 이 변경의 전부다.
 *
 * ── 어떤 hotdeals 행을 이 카드의 것으로 볼 것인가 ────────────────────
 *
 *   ① 양쪽 다 옵션을 알고 그 값이 같다        → 붙인다 (정확한 일치)
 *   ② 한쪽이 옵션을 모른다                     → 붙인다. '' 는 «모른다» 는
 *      (product_id + mall 이 같을 때)             뜻이지 «다른 옵션» 이라는
 *                                                 뜻이 아니다
 *                                                 (_price.sameVendorRows 규칙)
 *   ③ 양쪽 다 알고 값이 다르다                 → 붙이지 않는다. 다른 옵션의
 *                                                 판정을 이 카드의 검증이라고
 *                                                 말하면 그건 거짓말이다
 *
 * @param {object[]} cards  buildDrops 가 만든 카드
 * @param {object[]} deals  hotdeals 행
 * @param {object}   opts   { now }
 */
function applyVerified(cards, deals, opts = {}) {
  const now = opts.now == null ? Date.now() : Number(opts.now);

  const exact = new Map();   // pid|mall|vid  → 행
  const anyOpt = new Map();  // pid|mall      → 행 (옵션을 모르는 행 포함)
  const noOpt = new Map();   // pid|mall      → 옵션을 «모르는» 행만

  for (const d of deals || []) {
    if (!isVerifiedDeal(d, now)) continue;
    const base = `${d.product_id || ''}|${d.mall || ''}`;
    const vid = normId(d.vendor_item_id);
    if (vid) exact.set(`${base}|${vid}`, betterDeal(exact.get(`${base}|${vid}`), d));
    else noOpt.set(base, betterDeal(noOpt.get(base), d));
    anyOpt.set(base, betterDeal(anyOpt.get(base), d));
  }

  return (cards || []).map(c => {
    const base = `${c.productId}|${c.mall}`;
    const vid = normId(c.vendorItemId);
    const hit = (vid ? exact.get(`${base}|${vid}`) : null)
      || (vid ? noOpt.get(base) : anyOpt.get(base))
      || null;

    if (!hit) return Object.assign({}, c, { verified: false, badge: BADGE_TODAY });
    return Object.assign({}, c, {
      verified: true,
      badge: BADGE_VERIFIED,
      // 내부 판정은 잃지 않는다. 배지는 두 갈래지만 원래 상태는 그대로 나간다.
      dealStatus: hit.deal_status || null,
      hotScore: Number.isFinite(Number(hit.hot_score)) ? Number(hit.hot_score) : null,
      dealId: hit.id == null ? null : hit.id,
      // 엔진이 이미 정리해 둔 제휴 링크·이미지. 호출부의 우선순위 규칙이 쓴다
      // (api/hotdeals.js linkFor / imageFor) — 여기서 고르지는 않는다.
      dealUrl: String(hit.affiliate_url || ''),
      dealImage: String(hit.image || '')
    });
  }).sort(compareCards);
}

module.exports = {
  MIN_DROP_PCT, MIN_DROP_AMOUNT, MAX_PLAUSIBLE_DROP_PCT,
  VERIFIED_STATUS, VERIFIED_LIFECYCLE, BADGE_VERIFIED, BADGE_TODAY, REASON,
  normId, optionIdOf, vendorItemIdOf, seriesKeyOf, productKeyOf,
  validPrice, lastOn, latestBefore, meetsThreshold, todayDrop,
  pickPrimary, compareCards, buildDrops,
  isVerifiedDeal, betterDeal, applyVerified
};
