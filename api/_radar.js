'use strict';
/*
 * SEOSA 레이더 — 저장한 상품이 «지금 어떤 상태인가» 를 판정한다.
 *
 * ── 이 파일이 있는 이유 ────────────────────────────────────────────
 *
 * SEOSA 의 목표는 방문자 수가 아니라 «SEOSA 를 거쳐 실제로 산 금액» 이다.
 * 그 금액은 이 고리가 돌아야 생긴다.
 *
 *     발견 → 판단 → 저장 → (가격이 움직임) → 다시 옴 → 구매
 *
 * 앞의 둘은 이미 있다(검색·핫딜·_deal.js). 없는 것은 «저장한 뒤» 다.
 * 사용자가 저장해 둔 상품이 싸졌는지 아무도 알려 주지 않으면 다시 올 이유가
 * 없고, 다시 오지 않으면 구매도 없다. 이 파일은 그 «다시 올 이유» 를 만든다.
 *
 * ── 저장은 어디에 하는가 (auth 를 새로 만들지 않는다) ──────────────
 *
 * 이 저장소에는 이미 이메일 인증(api/auth.js)과 위시 백업(user_data.wish)이
 * 있다. 그러나 레이더의 «가치» 는 목록을 서버가 갖고 있는 데서 나오지 않는다.
 * 값이 변했는지 계산해 주는 데서 나온다.
 *
 * 그래서 이 모듈은 **아무것도 저장하지 않는다.** 목록은 브라우저가 들고
 * (익명 사용자도 그대로 쓴다), 서버는 그 목록을 받아 지금 상태만 계산해
 * 돌려준다. 로그인한 사용자는 기존 /api/sync 가 그 목록을 백업해 주므로
 * 기기 간 동기화까지 공짜로 따라온다.
 *
 *   · 새 표 없음 · 새 auth 없음 · 익명도 전 기능 사용 가능
 *   · 서버는 «누가» 무엇을 저장했는지 알지 못한다
 *
 * ── 판정은 전부 결정론이다 ─────────────────────────────────────────
 *
 * 목표가 도달은 `현재가 <= 목표가` 하나로 정한다. LLM 을 부르지 않는다.
 * BUY/WAIT/WATCH 도 api/_deal.js 의 판정을 옮겨 담을 뿐 다시 판단하지 않는다.
 * 같은 입력이면 언제나 같은 출력이어야 한다 — 알림이 걸린 값이기 때문이다.
 */

const { dealOf, DEAL_ORDER, FRESHNESS_DOUBT, FRESHNESS_ORDER } = require('./_deal');

/* ==================================================================
 *  1) 사용자에게 보여 줄 세 갈래 — TASK 5
 *
 *  _deal.js 는 일곱 갈래로 판정한다(BUY/GOOD_BUY/NORMAL/WATCH/WAIT/
 *  DONT_BUY/UNKNOWN). 그 세밀함은 상품 상세에서 쓸모가 있지만, 저장 목록에서
 *  사용자가 실제로 하는 행동은 셋뿐이다 — 산다 / 기다린다 / 지켜본다.
 *
 *  ★ 판정을 다시 하지 않는다. 접기만 한다. 두 곳에서 판단하면 언젠가 갈리고,
 *    그때 사용자는 상세와 목록에서 서로 다른 말을 듣는다.
 * ================================================================== */

const ACTION = { BUY: 'BUY', WAIT: 'WAIT', WATCH: 'WATCH' };

/** _deal.js 판정 → 사용자 행동. */
const ACTION_OF = {
  BUY: ACTION.BUY,
  GOOD_BUY: ACTION.BUY,
  NORMAL: ACTION.WATCH,
  WATCH: ACTION.WATCH,
  WAIT: ACTION.WAIT,
  DONT_BUY: ACTION.WAIT,
  UNKNOWN: ACTION.WATCH
};

const ACTION_LABEL = {
  BUY: '지금 사도 좋아요',
  WAIT: '기다리는 편이 나아요',
  WATCH: '지켜보는 중이에요'
};

/*
 * 근거의 상태. 판정과 «따로» 둔다 — TASK 5 가 요구하는 분리다.
 *
 * 예전에는 이 둘이 섞여 있었다. 기록이 부족해도 WATCH 가 나오고, 값이
 * 오래돼도 WATCH 가 나온다. 사용자에게는 전혀 다른 상황인데 같은 말이 뜬다.
 *
 *   SUFFICIENT    판단할 만큼 봤다
 *   INSUFFICIENT  아직 덜 봤다 — 판정을 믿지 말라는 뜻
 *   STALE         봤지만 오래됐다 — 지금 값이 그 값이라는 보장이 없다
 */
const DATA = { SUFFICIENT: 'SUFFICIENT', INSUFFICIENT: 'INSUFFICIENT', STALE: 'STALE' };

/** 이만큼은 봐야 «봤다» 고 한다. _pricestat.ASSESS_MIN_DAYS(7) 와 같은 눈높이. */
const MIN_HISTORY_DAYS = 7;
const MIN_OBSERVATIONS = 5;

/**
 * 근거가 어떤 상태인가.
 *
 * ★ 순서가 중요하다. 부족한 것이 먼저다 — 기록이 3개뿐인데 그 3개가 오늘
 *   것이면 STALE 은 아니지만 그렇다고 믿을 수 있는 것도 아니다.
 */
function dataStateOf(stat, deal) {
  if (!stat || !deal) return DATA.INSUFFICIENT;

  /*
   * ★ 순서가 뜻을 정한다.
   *
   *   얇다(thin)  먼저다. 기록이 3개뿐이면 그게 오늘 것이어도 못 믿는다.
   *   오래됐다(stale) 그다음. 충분히 봤지만 최근 값이 아니다.
   *
   * UNKNOWN 판정을 맨 앞에 두면 안 된다. _deal.js 는 값이 오래되면 판정을
   * UNKNOWN 으로 내리는데, 그걸 «기록이 없다» 로 접으면 30일치를 가진 상품이
   * 기록 0개인 상품과 같은 말을 듣는다. 그 둘은 사용자에게 전혀 다른 상황이다
   * (하나는 기다리면 되고, 하나는 SEOSA 가 더 봐야 한다).
   */
  const thin = (stat.count || 0) < MIN_OBSERVATIONS
    || (stat.historyDays || 0) < MIN_HISTORY_DAYS;
  if (thin) return DATA.INSUFFICIENT;

  const level = deal.freshness && deal.freshness.level;
  if (level && FRESHNESS_ORDER[level] >= FRESHNESS_ORDER[FRESHNESS_DOUBT]) return DATA.STALE;

  // 기록은 두꺼운데 판정이 서지 않는 경우(분포가 평평한 등)만 여기 온다.
  if (deal.verdict === 'UNKNOWN') return DATA.INSUFFICIENT;
  return DATA.SUFFICIENT;
}

/**
 * 이 판정을 얼마나 믿어도 되는가.
 *
 * 근거 상태를 천장으로 쓴다 — 아무리 기록이 많아도 오래됐으면 HIGH 를
 * 주지 않는다. (api/_hotdeal.js 의 SCORE_CEILING 과 같은 생각이다)
 */
function confidenceOf(stat, deal, dataState) {
  if (dataState === DATA.INSUFFICIENT) return 'LOW';
  if (dataState === DATA.STALE) return 'LOW';
  const days = stat.historyDays || 0, n = stat.count || 0;
  const level = (deal.freshness && deal.freshness.level) || 'stale';
  if (days >= 30 && n >= 20 && FRESHNESS_ORDER[level] <= FRESHNESS_ORDER.good) return 'HIGH';
  if (days >= 14 && n >= 10) return 'MEDIUM';
  return 'LOW';
}

/* ==================================================================
 *  2) "얼마면 사도 좋은가" — TASK 6
 *
 *  ★ 숫자를 지어내지 않는다. 아래 값은 전부 price_history 에서 나오고,
 *    사용자에게 그대로 설명할 수 있어야 한다.
 * ================================================================== */

/** 이보다 적게 봤으면 «좋은 가격» 을 말하지 않는다. */
const GOODBUY_MIN_OBS = 10;
const GOODBUY_MIN_DAYS = 14;

/**
 * 관측한 날들의 하위 25% 지점.
 *
 * ── 왜 하필 25%인가 ────────────────────────────────────────────────
 *
 * 최저가를 기준으로 삼으면 거의 도달하지 않아 아무 도움이 안 되고, 평균을
 * 기준으로 삼으면 절반이 «좋은 가격» 이 되어 뜻이 없다. 사분위는 그 사이이고
 * 무엇보다 **한 문장으로 설명된다** — "이 값 이하로 본 날이 넷 중 하나".
 *
 * ── 왜 최저가로 바닥을 막는가 ──────────────────────────────────────
 *
 * 값이 거의 안 움직인 계열에서는 p25 가 최저가보다 낮게 나올 수 있다(보간).
 * 그러면 «관측된 적 없는 가격» 을 목표로 제시하게 된다. 우리가 본 적 없는
 * 값을 "이 정도면 좋다" 고 말하지 않는다.
 *
 * @param {object} stat _pricestat.statsFrom 결과
 * @returns {{price:number, basis:string, explain:string}|null} 근거가 얇으면 null
 */
function goodBuyPrice(stat) {
  if (!stat) return null;
  /*
   * ★ stat.points 로 계산하지 않는다. 그 배열은 MAX_POINTS(6) 로 잘린
   *   스파크라인 표본이라 분포가 아니다 — 그것으로 사분위를 내면 «최근 6일의
   *   하위 25%» 가 되어 전혀 다른 말이 된다.
   *   전체 관측에서 나온 p25 는 _pricestat.statsFrom 이 계산해 준다.
   */
  const n = Number(stat.count) || 0;
  if (n < GOODBUY_MIN_OBS) return null;
  if ((stat.historyDays || 0) < GOODBUY_MIN_DAYS) return null;

  /*
   * 값이 움직이지 않은 계열에는 «좋은 가격» 이 없다. 늘 같은 값이면 어떤
   * 값을 제시해도 "그 가격이면 좋다" 가 아니라 "그 가격이다" 일 뿐이다.
   */
  if (!(stat.high > stat.low)) return null;

  const p25 = Number(stat.p25) || 0;
  if (!(p25 > 0)) return null;               // 옛 stat 모양(마이그레이션 전 캐시 등)

  /*
   * 최저가로 바닥을 막는다. 값이 거의 안 움직인 계열에서는 p25 가 최저가
   * 아래로 내려갈 수 있는데, 그러면 «관측된 적 없는 가격» 을 목표로 제시하게
   * 된다. 우리가 본 적 없는 값을 "이 정도면 좋다" 고 말하지 않는다.
   */
  const price = Math.max(Number(stat.low) || 0, p25);
  if (!(price > 0)) return null;

  return {
    price,
    basis: 'p25',
    explain: `SEOSA가 관측한 ${n}번의 가격 중 하위 25% 지점이에요`
  };
}

/* ==================================================================
 *  3) 단위 가격 — TASK 8
 *
 *  ★ 확실할 때만 말한다. 제목 파싱은 틀리기 쉬운 일이고, 틀린 단위가는
 *    "이게 더 싸다" 를 뒤집어 버린다. false precision 은 없느니만 못하다.
 * ================================================================== */

/*
 * 아주 좁게 잡는다. «수량/용량이 제목에 단 한 번, 명확한 형태로» 나올 때만.
 *
 *   "…, 500ml, 12개"   → 애매하다(둘 중 무엇이 단위인가) → null
 *   "생수 2L 6개입"     → 애매하다 → null
 *   "…무선이어폰 2개"   → 개당
 *   "…샴푸 500ml"       → 100ml당
 *
 * 규칙: 잡히는 단위 «종류» 가 정확히 하나여야 하고, 그 값도 하나여야 한다.
 * 둘 이상 잡히면 무엇을 나눠야 할지 우리가 모른다는 뜻이므로 포기한다.
 */
const UNIT_PATTERNS = [
  { unit: '개', per: 1, re: /(\d+(?:\.\d+)?)\s*(?:개입|개|정|캡슐|매|포|팩|병|캔|입)(?![a-z가-힣])/gi },
  { unit: '100ml', per: 100, re: /(\d+(?:\.\d+)?)\s*(ml|밀리리터)(?![a-z가-힣])/gi },
  { unit: '100ml', per: 100, re: /(\d+(?:\.\d+)?)\s*(l|리터)(?![a-z가-힣])/gi, scale: 1000 },
  { unit: '100g', per: 100, re: /(\d+(?:\.\d+)?)\s*(g|그램)(?![a-z가-힣])/gi },
  { unit: '100g', per: 100, re: /(\d+(?:\.\d+)?)\s*(kg|킬로그램)(?![a-z가-힣])/gi, scale: 1000 }
];

/**
 * @returns {{unitPrice:number, unit:string, amount:number}|null} 확실하지 않으면 null
 */
function unitPriceOf(title, price) {
  const p = Math.round(Number(price) || 0);
  const t = String(title || '');
  if (p <= 0 || !t) return null;

  const hits = [];
  UNIT_PATTERNS.forEach(pat => {
    const re = new RegExp(pat.re.source, pat.re.flags);
    let m;
    const values = [];
    while ((m = re.exec(t)) !== null) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n > 0) values.push(n * (pat.scale || 1));
    }
    // 같은 단위가 여러 번 다른 값으로 나오면 무엇이 총량인지 모른다.
    const uniq = [...new Set(values)];
    if (uniq.length === 1) hits.push({ unit: pat.unit, per: pat.per, amount: uniq[0] });
  });

  // 단위 «종류» 가 둘 이상이면(예: ml 과 개가 함께) 나눌 기준을 정할 수 없다.
  const kinds = [...new Set(hits.map(h => h.unit))];
  if (kinds.length !== 1 || hits.length !== 1) return null;

  const h = hits[0];
  if (!(h.amount > 0)) return null;
  // 1개짜리에 "개당"을 붙이면 아무 정보가 없다.
  if (h.unit === '개' && h.amount < 2) return null;

  const unitPrice = Math.round(p / (h.amount / h.per));
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;
  return { unitPrice, unit: h.unit, amount: h.amount };
}

/* ==================================================================
 *  4) 판정 하나로 묶기 — TASK 5 · 6
 * ================================================================== */

function pct(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  return Math.round((a - b) / a * 1000) / 10;
}

/**
 * 저장한 상품 하나의 «지금 상태».
 *
 * @param {object} stat  _pricestat.statsFrom 결과 (없을 수 있다)
 * @param {number} price 현재가
 * @param {string} today KST 오늘
 * @param {string} title 상품명 (단위가 계산용)
 */
function decisionOf(stat, price, today, title) {
  const deal = dealOf(stat, price, today);
  const dataState = dataStateOf(stat, deal);
  const action = ACTION_OF[deal.verdict] || ACTION.WATCH;
  const confidence = confidenceOf(stat || {}, deal, dataState);
  const e = deal.evidence || {};
  const good = dataState === DATA.SUFFICIENT ? goodBuyPrice(stat) : null;

  return {
    decision: action,
    label: ACTION_LABEL[action],
    /* 원래 판정도 함께 낸다 — 상세 화면은 일곱 갈래를 그대로 쓴다. */
    verdict: deal.verdict,
    confidence,
    dataState,
    reason: deal.reasons && deal.reasons[0] ? deal.reasons[0] : '',
    reasons: (deal.reasons || []).slice(0, 3),
    cautions: (deal.cautions || []).slice(0, 2),
    evidence: {
      currentPrice: Math.round(Number(price) || 0) || null,
      median30: e.avg30 || null,
      observedLow: e.low || null,
      observedHigh: e.high || null,
      dropPercent: pct(e.avg30, price),
      historyCount: (stat && stat.count) || 0,
      historyDays: (stat && stat.historyDays) || 0,
      lastCheckedDate: (stat && stat.lastDate) || null,
      staleDays: (deal.freshness && deal.freshness.days) || 0,
      percentile: deal.percentile
    },
    /* 근거가 충분할 때만. 부족하면 null — 없는 목표가를 지어내지 않는다. */
    goodBuyPrice: good ? good.price : null,
    goodBuyExplain: good ? good.explain : null,
    unit: unitPriceOf(title, price)
  };
}

/* ==================================================================
 *  5) 무엇이 달라졌는가 — TASK 3 · 11
 *
 *  ★ «사용자가 마지막으로 본 값» 은 브라우저가 들고 있다가 보내 준다.
 *    서버가 사용자별 상태를 갖지 않는 대신, 비교 기준을 클라이언트가 준다.
 *    그래서 익명 사용자도 변화 감지를 그대로 쓴다.
 *
 *  ★ 이벤트는 «사실» 만 담는다. 재촉하는 말(지금 안 사면 놓친다)을 넣지 않고,
 *    없는 희소성을 만들지 않는다.
 * ================================================================== */

const EVENT = {
  TARGET_PRICE_REACHED: 'TARGET_PRICE_REACHED',
  PRICE_DROP: 'PRICE_DROP',
  PRICE_RISE: 'PRICE_RISE',
  NEW_LOW: 'NEW_LOW',
  DECISION_BUY: 'DECISION_BUY',
  HOT_DEAL: 'HOT_DEAL',
  CHEAPER_MALL: 'CHEAPER_MALL'
};

/** 이 비율 미만의 변동은 «변했다» 고 말하지 않는다 (반올림·소수 노이즈). */
const CHANGE_MIN_PCT = 0.5;

/**
 * @param {object} saved   사용자가 저장할 때/마지막으로 본 값
 *                         {seenPrice, targetPrice, seenDecision}
 * @param {object} now     {price, decision, isNewLow, hotDeal, cheaper}
 * @returns {Array<object>} 이벤트 목록 (없으면 빈 배열)
 */
function changesFor(saved, now) {
  const out = [];
  const s = saved || {}, n = now || {};
  const cur = Math.round(Number(n.price) || 0);
  const seen = Math.round(Number(s.seenPrice) || 0);
  const target = Math.round(Number(s.targetPrice) || 0);
  if (cur <= 0) return out;

  /*
   * ★ 목표가는 딱 이 한 줄이다. 모델에게 묻지 않는다.
   *   알림이 걸리는 판정이라 같은 입력에 늘 같은 답이어야 한다.
   */
  if (target > 0 && cur <= target) {
    out.push({
      type: EVENT.TARGET_PRICE_REACHED,
      currentPrice: cur, targetPrice: target,
      previousPrice: seen || null,
      text: `목표 가격 ${target.toLocaleString('ko-KR')}원에 도달했어요`
    });
  }

  if (seen > 0 && cur !== seen) {
    const diff = seen - cur;
    const changePct = Math.abs(diff) / seen * 100;
    if (changePct >= CHANGE_MIN_PCT) {
      const dropped = diff > 0;
      out.push({
        type: dropped ? EVENT.PRICE_DROP : EVENT.PRICE_RISE,
        currentPrice: cur, previousPrice: seen,
        changeAmount: Math.abs(diff),
        changePercent: Math.round(changePct * 10) / 10,
        text: dropped
          ? `${Math.abs(diff).toLocaleString('ko-KR')}원 내렸어요`
          : `${Math.abs(diff).toLocaleString('ko-KR')}원 올랐어요`
      });
    }
  }

  if (n.isNewLow === true) {
    out.push({ type: EVENT.NEW_LOW, currentPrice: cur, text: 'SEOSA가 관측한 가장 낮은 가격이에요' });
  }

  /* 저장할 때는 BUY 가 아니었는데 지금 BUY 로 바뀐 것만 «변화» 다. */
  if (n.decision === ACTION.BUY && s.seenDecision && s.seenDecision !== ACTION.BUY) {
    out.push({
      type: EVENT.DECISION_BUY, currentPrice: cur,
      previousDecision: s.seenDecision,
      text: '구매 판단이 «지금 사도 좋다» 로 바뀌었어요'
    });
  }

  if (n.hotDeal) {
    out.push({ type: EVENT.HOT_DEAL, currentPrice: cur, hotDealId: n.hotDeal.id || null,
      text: 'SEOSA 핫딜로 올라왔어요' });
  }

  if (n.cheaper && Number(n.cheaper.price) > 0 && Number(n.cheaper.price) < cur) {
    out.push({
      type: EVENT.CHEAPER_MALL, currentPrice: cur,
      mall: String(n.cheaper.mall || ''), price: Math.round(Number(n.cheaper.price)),
      text: `${n.cheaper.mall || '다른 판매처'}에서 ${Math.round(Number(n.cheaper.price)).toLocaleString('ko-KR')}원이에요`
    });
  }

  return out;
}

/** 이벤트 중 «다시 올 이유» 가 되는 것들. 재방문 요약이 이것만 센다. */
const ACTIONABLE = [EVENT.TARGET_PRICE_REACHED, EVENT.PRICE_DROP, EVENT.NEW_LOW,
  EVENT.DECISION_BUY, EVENT.HOT_DEAL, EVENT.CHEAPER_MALL];

function summarize(items) {
  const sum = { total: 0, actionable: 0, byType: {}, decisions: { BUY: 0, WAIT: 0, WATCH: 0 } };
  (items || []).forEach(it => {
    sum.total++;
    if (it.decision && sum.decisions[it.decision] != null) sum.decisions[it.decision]++;
    let hit = false;
    (it.events || []).forEach(ev => {
      sum.byType[ev.type] = (sum.byType[ev.type] || 0) + 1;
      if (ACTIONABLE.indexOf(ev.type) > -1) hit = true;
    });
    if (hit) sum.actionable++;
  });
  return sum;
}

/* ==================================================================
 *  6) 대체 상품 후보 — TASK 7
 *
 *  ★ 추천 AI 를 새로 만들지 않는다. 이미 있는 카탈로그와 이미 있는 판정
 *    모듈(_identity · _search.ACCESSORY_TIER)로 «비교할 만한 것» 만 고른다.
 *  ★ 순수 함수다. 후보 행은 부르는 쪽이 DB 에서 가져와 넘긴다.
 * ================================================================== */

/** 가격이 이 배수 밖이면 «대안» 이 아니다. 3만원짜리의 대안은 30만원짜리가 아니다. */
const ALT_MIN_RATIO = 0.5;
const ALT_MAX_RATIO = 1.8;

let searchMod = null;
function accessoryPairs() {
  if (searchMod === null) {
    try { searchMod = require('./_search'); }
    catch (e) { searchMod = false; }
  }
  return (searchMod && Array.isArray(searchMod.ACCESSORY_TIER)) ? searchMod.ACCESSORY_TIER : [];
}
function isAccessory(title) {
  const t = String(title || '');
  return accessoryPairs().some(pair => t.indexOf(pair[0]) > -1);
}

/**
 * 비교해 볼 만한 상품을 고른다.
 *
 * @param {object} base       기준 상품 {productId, title, price}
 * @param {Array} candidates  같은 검색어/카테고리에서 온 상품 행
 * @param {number} limit
 * @returns {Array<object>}
 */
function alternativesFor(base, candidates, limit) {
  const b = base || {};
  const basePrice = Math.round(Number(b.price) || 0);
  const max = Math.max(1, Math.min(10, limit || 5));
  if (!basePrice || !b.title) return [];

  /*
   * ★ 본체를 보고 있는데 부속을 대안이라고 내놓지 않는다.
   *   반대로 부속을 보고 있으면 부속끼리 비교하는 것이 맞다.
   */
  const baseAcc = isAccessory(b.title);

  const seen = new Set();
  const out = [];
  (candidates || []).forEach(c => {
    if (!c) return;
    const price = Math.round(Number(c.price) || 0);
    const pid = String(c.productId || '');
    const title = String(c.title || '');
    if (!pid || !title || price <= 0) return;              // 현재 가격이 있어야 비교가 된다
    if (pid === String(b.productId || '')) return;         // 자기 자신
    if (seen.has(pid)) return;
    if (isAccessory(title) !== baseAcc) return;            // 본체 ↔ 부속 금지
    const ratio = price / basePrice;
    if (ratio < ALT_MIN_RATIO || ratio > ALT_MAX_RATIO) return;
    seen.add(pid);
    out.push({
      productId: pid, title, price,
      mall: String(c.mall || ''),
      image: String(c.image || ''),
      url: String(c.url || ''),
      priceDiff: price - basePrice,
      priceDiffPercent: Math.round((price - basePrice) / basePrice * 1000) / 10,
      cheaper: price < basePrice
    });
  });

  /* 싼 순이 아니라 «기준가에 가까운 순». 대안은 대체재이지 저가품이 아니다. */
  out.sort((x, y) => Math.abs(x.priceDiff) - Math.abs(y.priceDiff)
    || (x.productId < y.productId ? -1 : 1));
  return out.slice(0, max);
}

module.exports = {
  ACTION, ACTION_LABEL, ACTION_OF, DATA, EVENT, ACTIONABLE,
  MIN_HISTORY_DAYS, MIN_OBSERVATIONS, GOODBUY_MIN_OBS, GOODBUY_MIN_DAYS,
  ALT_MIN_RATIO, ALT_MAX_RATIO, CHANGE_MIN_PCT,
  dataStateOf, confidenceOf, goodBuyPrice, unitPriceOf,
  decisionOf, changesFor, summarize, alternativesFor, isAccessory
};
