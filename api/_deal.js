/*
 * TRUE DEAL ENGINE — "지금 이 가격에 사도 되는가" 를 코드가 판정한다.
 *
 * ── 왜 이 파일이 따로 있는가 ────────────────────────────────────────
 *
 * _pricestat.assess() 가 이미 good/neutral/wait 을 낸다. 그것은 "요즘 시세
 * 대비 싼가" 한 축의 판정이고, 지금도 그대로 쓴다(지우지 않는다).
 *
 * 그런데 사용자가 실제로 묻는 것은 그것보다 넓다.
 *
 *   "이 가격 진짜 싼 거야?"        → 할인율이 아니라 관측 기록 대비 위치
 *   "지금 사도 돼?"                → 추세까지 봐야 한다
 *   "기다리면 더 싸져?"            → 변동성과 방향
 *   "이 데이터 믿어도 돼?"         → 최신성과 기록 단절
 *
 * 할인율은 근거가 되지 못한다. 정가를 부풀린 상품에서 "50% 할인" 은 거짓말이고,
 * 늘 ±30% 로 출렁이던 상품에서 "평균보다 10% 싸다" 는 흔한 일이다. 그래서
 * 이 엔진은 오직 우리가 실제로 관측한 price_history 만 근거로 쓴다.
 *
 * ── 절대 규칙 ───────────────────────────────────────────────────────
 *
 * 1. 근거가 부족하면 UNKNOWN 이다. 모르는 것을 "괜찮다" 로 바꾸지 않는다.
 * 2. assess() 와 결론이 어긋나지 않는다. assess 가 wait 인데 여기서 BUY 가
 *    나오면 같은 데이터로 두 개의 답을 말하는 것이다. 코드로 막는다.
 * 3. 이유를 함께 낸다. 판정만 있고 근거가 없으면 LLM 이 이유를 지어낸다.
 * 4. 주의사항을 숨기지 않는다. BUY 라도 "역대 최저가는 아님" 은 말한다.
 */

const { spanDays, assess, ASSESS_MIN_DAYS, ASSESS_MAX_STALE } = require('./_pricestat');

/* ── 판정 ──────────────────────────────────────────────────────────
 *
 * BUY        기록 대비 확실히 싸고, 데이터도 최신이다
 * GOOD_BUY   싼 편이다. 다만 최저가는 아니거나 근거가 조금 약하다
 * NORMAL     평범한 가격이다. 서두르거나 미룰 이유가 없다
 * WATCH      지금은 애매하다. 움직임이 있어 지켜볼 만하다
 * WAIT       평소보다 비싸다. 기다리는 편이 낫다
 * DONT_BUY   기록 대비 확연히 비싸다
 * UNKNOWN    판정할 근거가 없다
 */
const DEAL_LABEL = {
  BUY:      '지금 사도 좋다',
  GOOD_BUY: '싼 편이다',
  NORMAL:   '평범한 가격이다',
  WATCH:    '지켜볼 만하다',
  WAIT:     '기다리는 편이 낫다',
  DONT_BUY: '지금은 비싸다',
  UNKNOWN:  '판정할 근거가 없다'
};

/** 판정 강도 순서. assess 와 어긋나지 않는지 검사할 때 쓴다. */
const DEAL_ORDER = {
  DONT_BUY: 0, WAIT: 1, WATCH: 2, NORMAL: 3, GOOD_BUY: 4, BUY: 5, UNKNOWN: -1
};

/** 데이터 최신성 등급. [등급, 이 일수 이하, 사람이 읽는 말] */
const FRESHNESS = [
  ['excellent', 0,  '오늘 확인된 가격'],
  ['good',      3,  '최근 3일 안에 확인된 가격'],
  ['fair',      7,  '일주일 안에 확인된 가격'],
  ['weak',      14, '2주 가까이 갱신되지 않은 가격'],
  ['stale',     Infinity, '2주 넘게 갱신되지 않은 가격']
];

/** 이 등급부터는 "현재 가격" 이라고 단정하지 않는다. */
const FRESHNESS_DOUBT = 'weak';
const FRESHNESS_ORDER = { excellent: 0, good: 1, fair: 2, weak: 3, stale: 4 };

/**
 * 며칠 전 데이터인가 → 등급.
 * @param {number} staleDays
 * @returns {{level:string, days:number, label:string, trusted:boolean}}
 */
function freshness(staleDays) {
  const d = Math.max(0, Math.round(Number(staleDays) || 0));
  for (let i = 0; i < FRESHNESS.length; i++) {
    const level = FRESHNESS[i][0], max = FRESHNESS[i][1], label = FRESHNESS[i][2];
    if (d <= max) {
      return {
        level, days: d, label,
        trusted: FRESHNESS_ORDER[level] < FRESHNESS_ORDER[FRESHNESS_DOUBT]
      };
    }
  }
  return { level: 'stale', days: d, label: '오래된 가격', trusted: false };
}

/**
 * 현재가가 기록 안에서 어느 위치인가 (0 = 역대 최저, 100 = 역대 최고).
 *
 * 백분위를 쓰는 이유는 할인율과 달리 정가 부풀리기에 흔들리지 않기 때문이다.
 *
 * @returns {number|null} 최저·최고가 같거나 기록이 없으면 null
 */
function pricePercentile(stat, price) {
  const p = Math.round(Number(price) || 0);
  if (!stat || p <= 0) return null;
  const lo = Math.round(Number(stat.low) || 0);
  const hi = Math.round(Number(stat.high) || 0);
  if (!(lo > 0) || !(hi > 0) || hi === lo) return null;
  const v = (p - lo) / (hi - lo) * 100;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/* ── 가격 이상 탐지 ─────────────────────────────────────────────────
 *
 * "평균 79,000원인데 지금 39,900원" 을 그냥 "50% 할인" 이라고 말하면 안 된다.
 * 옵션이 바뀌었거나, 다른 상품이 같은 자리에 들어왔거나, 수집이 잘못됐을 수
 * 있다. 우리가 구분할 수 없으면 구분할 수 없다고 말한다.
 */

/** 직전 기록 대비 이 배수를 넘게 튀면 이상으로 본다. */
const ANOMALY_DROP = 0.5;    // 절반 이하로 떨어짐
const ANOMALY_JUMP = 2.0;    // 두 배 이상 뛰어오름
/** 기록이 이만큼 끊겼으면 그 사이에 무슨 일이 있었는지 알 수 없다. */
const GAP_WARN_DAYS = 14;

function won(n) { return Math.round(Number(n) || 0).toLocaleString('ko-KR'); }
function pct(n) { return Math.round(n * 1000) / 10; }

/**
 * 가격·기록의 이상 징후.
 * @returns {Array<{kind:string, note:string}>} 없으면 빈 배열
 */
function anomalies(stat, price, today) {
  const out = [];
  const p = Math.round(Number(price) || 0);
  if (!stat || p <= 0) return out;

  const last = Math.round(Number(stat.lastPrice) || 0);
  if (last > 0) {
    if (p <= last * ANOMALY_DROP) {
      out.push({
        kind: 'price_drop',
        note: '직전 기록(' + won(last) + '원)의 절반 이하다. 옵션이나 구성이 바뀌었을 수 있어 같은 상품인지 확인이 필요하다'
      });
    } else if (p >= last * ANOMALY_JUMP) {
      out.push({
        kind: 'price_jump',
        note: '직전 기록(' + won(last) + '원)의 두 배 이상이다. 같은 상품이 맞는지 확인이 필요하다'
      });
    }
  }

  if (stat.maxGapDays >= GAP_WARN_DAYS) {
    out.push({
      kind: 'history_gap',
      note: '가격 기록이 최대 ' + stat.maxGapDays + '일 끊긴 구간이 있어 그 사이 움직임은 알 수 없다'
    });
  }

  const stale = (today && stat.lastDate) ? Math.max(0, spanDays(stat.lastDate, today)) : 0;
  if (!freshness(stale).trusted) {
    out.push({
      kind: 'stale_price',
      note: '가격 기록이 ' + stale + '일 전에서 멈춰 있어 지금 가격이 실제 특가인지 확신하기 어렵다'
    });
  }

  return out;
}

/* ── 판정 기준 ──────────────────────────────────────────────────────
 *
 * 백분위와 평균 대비 거리를 함께 본다. 어느 한쪽만 보면 속는다.
 *   · 백분위만 → 늘 좁은 폭으로 움직인 상품에서 과장된다
 *   · 평균만   → 최근 급등락에 휘둘린다
 */
const P_VERY_LOW  = 15;    // 백분위 이 아래면 기록 대비 확연히 싸다
const P_LOW       = 35;
const P_HIGH      = 70;
const P_VERY_HIGH = 85;

/** 평균 대비 이만큼 벌어지면 의미 있는 차이로 본다. */
const AVG_CHEAP = 0.08;
const AVG_DEAR  = 0.08;

/** 변동성이 이보다 크면 "싸 보이는 것" 이 흔한 일일 수 있다. */
const VOLATILE_PCT = 20;

/** 기록이 이 일수보다 짧으면 백분위를 믿지 않는다. */
const PCTL_MIN_DAYS = 7;

/*
 * 가격 폭이 이보다 좁으면 백분위를 쓰지 않는다.
 *
 * ── 실제 데이터에서 찾은 문제 ────────────────────────────────────────
 * product_id=1519617460 은 29일 동안 38,520~39,800원이었다. 폭이 3.3%,
 * 변동성 0.8% 인 사실상 고정가 상품이다. 그런데 현재가가 그 좁은 폭의
 * 위쪽 끝이라는 이유로 백분위 99% 가 나왔고, 판정이 WAIT 이 됐다.
 *
 * 사용자에게 "기다리는 편이 낫다" 고 말한 셈인데, 끝까지 기다려도 아낄 수
 * 있는 돈은 1,280원이고 그 가격은 29일 동안 한 번도 크게 움직인 적이 없다.
 * 백분위는 순위일 뿐 금액이 아니다 — 폭이 좁으면 순위에 의미가 없다.
 *
 * 그래서 폭이 좁으면 백분위를 계산은 하되(화면에는 보여줄 수 있다)
 * 판정 점수에는 반영하지 않고, "가격이 안정적이다" 로 말한다.
 */
const PCTL_MIN_SPREAD = 0.05;

/*
 * 기록 안에 이상치가 섞였는지 가르는 배수.
 *
 * ── 실제 데이터에서 찾은 문제 ────────────────────────────────────────
 * 15,900원짜리 이어폰의 27일 기록 중 25일이 15,900원인데 이틀만 242,100 /
 * 222,390원이었다(2026-07-30·31). 옵션이 바뀌었거나 같은 자리에 다른 상품이
 * 들어온 것으로 보인다.
 *
 * 그 이틀 때문에 high 가 15배로 뛰고 avg30 이 32,656원이 됐다. 그래서
 * 25일째 값이 한 번도 안 움직인 상품에 "최근 일주일 시세가 30일 평균보다
 * 35% 낮아 더 내려갈 여지가 있다" 는 근거가 붙었다 — 사실이 아니다.
 *
 * 평균과 최고가만으로는 이 상황을 알 수 없다. 중앙값과 비교해야 안다.
 * 이상치가 보이면 그 값들에 기댄 계산(백분위·평균 대비 거리)을 쓰지 않고,
 * 왜 못 쓰는지 사용자에게 말한다.
 */
const OUTLIER_RATIO = 3;

/**
 * 지금 사도 되는가.
 *
 * @param {object} stat   _pricestat.statsFrom 결과
 * @param {number} price  현재가
 * @param {string} today  KST 오늘 'YYYY-MM-DD'
 * @returns {object} verdict/label/score/percentile/freshness/reasons/cautions/anomalies/evidence
 *   근거가 없으면 verdict='UNKNOWN'. 절대 null 을 돌려주지 않는다 —
 *   호출부가 "판정이 없다" 와 "판정할 수 없다" 를 구분해야 하기 때문이다.
 */
function dealOf(stat, price, today) {
  const p = Math.round(Number(price) || 0);
  const base = {
    verdict: 'UNKNOWN', label: DEAL_LABEL.UNKNOWN, score: null,
    percentile: null, freshness: freshness(0),
    reasons: [], cautions: [], anomalies: [], evidence: {}
  };

  if (!stat || p <= 0) {
    base.reasons.push('가격 기록이 없어 지금 가격이 싼지 판단할 수 없다');
    return base;
  }

  const staleDays = (today && stat.lastDate) ? Math.max(0, spanDays(stat.lastDate, today)) : 0;
  const fresh = freshness(staleDays);
  const anom = anomalies(stat, p, today);
  const percentile = (stat.historyDays >= PCTL_MIN_DAYS) ? pricePercentile(stat, p) : null;

  const evidence = {
    price: p,
    low: stat.low, lowDate: stat.lowDate,
    high: stat.high, highDate: stat.highDate,
    avg7: stat.avg7, avg30: stat.avg30,
    trendPct: stat.trendPct, trendDays: stat.trendDays,
    volatility: stat.volatility,
    historyDays: stat.historyDays, count: stat.count,
    staleDays
  };
  base.freshness = fresh;
  base.anomalies = anom;
  base.evidence = evidence;
  base.percentile = percentile;

  /* ── 판정 불가 ── 모르는 것을 "괜찮다" 로 바꾸지 않는다 ──
   *
   * ★ count 를 "부족한가" 로 묻지 않고 "충분한가" 로 묻는다.
   *   undefined < 3 은 false 다. 부족한지 물으면 빈 객체가 관문을 통과해서
   *   근거 하나 없이 NORMAL 판정을 받는다 — eval-deal 이 실제로 잡아냈다.
   *   모르는 값은 "충분하지 않다" 쪽에 세운다.
   */
  if (!(Number(stat.count) >= ASSESS_MIN_DAYS)) {
    base.percentile = null;   // 기록이 부족하면 위치도 말하지 않는다
    base.reasons.push('가격 기록이 ' + (Number(stat.count) || 0) + '일치뿐이라 판단할 근거가 부족하다');
    return base;
  }
  if (staleDays > ASSESS_MAX_STALE) {
    base.reasons.push('가격 기록이 ' + staleDays + '일 전에서 멈춰 있어 지금 가격을 판정할 수 없다');
    return base;
  }
  if (anom.some(a => a.kind === 'price_drop' || a.kind === 'price_jump')) {
    base.reasons.push('직전 기록과 가격 차이가 너무 커서 같은 상품인지 확인되기 전에는 판정하지 않는다');
    return base;
  }

  /* ── 점수 ── */
  const reasons = [];
  const cautions = [];
  let score = 50;

  /*
   * 기록에 이상치가 섞였는가 (OUTLIER_RATIO 주석 참고).
   * 중앙값과 견줘서 판단한다 — 평균은 이상치에 같이 끌려간다.
   */
  const med = Math.round(Number(stat.median) || 0);
  const outlier = med > 0 && (
    (stat.high > 0 && stat.high >= med * OUTLIER_RATIO) ||
    (stat.low > 0 && stat.low * OUTLIER_RATIO <= med)
  );
  if (outlier) {
    cautions.push('기록 중 일부가 평소 가격(' + won(med) + '원)과 크게 달라 ' +
      '옵션이 바뀌었거나 다른 상품이 섞였을 수 있다. 그 값들에 기댄 계산은 쓰지 않았다');
  }

  /*
   * 가격 폭이 좁으면 백분위로 판정하지 않는다 (PCTL_MIN_SPREAD 주석 참고).
   * 순위는 맞아도 금액이 무의미하다.
   */
  const spread = (stat.low > 0 && stat.high > 0) ? (stat.high - stat.low) / stat.low : 0;
  const pctlUsable = percentile != null && spread >= PCTL_MIN_SPREAD && !outlier;

  /*
   * 아직 확인되지 않은 신저가인가.
   *
   * ── 왜 가르는가 (2026-09-04 감사) ─────────────────────────────
   *
   * 우리가 가진 가격은 쿠팡 파트너스 검색 API 의 productPrice 하나뿐이고,
   * 그 값이 상품 페이지의 실제 구매가와 항상 같지는 않다는 것이 실측으로
   * 확인됐다 (7912306911: API 22,320원 ↔ 페이지 26,900원).
   *
   * 그런 값이 하루만 관측돼도 코드는 곧바로 "관측한 26일 기록에서 가장 낮은
   * 가격이다 · 지금 사도 좋다" 로 단정했다. 운영 전체로 쿠팡 상품 1,515개 중
   * 1,024개가 "최신 관측 = 역대 최저" 였고 그중 159개는 하루만 본 값이다.
   *
   * 한 번 본 값은 가설이다. 다음 관측에서 같은 값이 다시 나오면 그때
   * 확정한다 — 그 사이에는 "확인 중" 이라고 말한다. 값을 숨기지도, 없는
   * 확신을 붙이지도 않는다.
   *
   * stat.lowConfirmed 가 undefined 인 옛/스텁 통계는 예전대로 둔다
   * (=== false 로만 걸린다). 모르는 것을 "확인 안 됨" 으로 바꾸지 않는다.
   */
  const unconfirmedLow = stat.lowConfirmed === false && !!stat.lowIsLatest && p <= stat.low;
  if (unconfirmedLow) {
    cautions.push('이 가격은 ' + stat.lowDate + ' 하루만 관측됐다. '
      + '다음 수집에서 같은 값이 다시 나와야 최저가로 확정된다');
  }

  if (percentile != null && !pctlUsable && !outlier) {
    reasons.push('이 상품은 가격이 거의 움직이지 않는다(' +
      Math.round(spread * 1000) / 10 + '% 폭). 기다려서 아낄 수 있는 금액이 크지 않다');
  }

  if (pctlUsable) {
    /*
     * 양 끝은 백분율로 말하지 않는다.
     *
     * 백분위 100 에서 "상위 0%" 는 말이 되지 않고, 0 에서 "하위 0%" 도
     * 읽는 사람에게 아무 뜻이 아니다. 끝값은 끝값이라고 말한다.
     */
    if (percentile <= 0) {
      // 확인되지 않은 신저가는 "가장 낮다" 고 단정하지 않는다 (unconfirmedLow 주석).
      if (unconfirmedLow) {
        score += 10;
        reasons.push('관측한 ' + stat.historyDays + '일 기록에서 가장 낮은 값이지만, '
          + '하루만 관측돼 아직 확인 중이다');
      } else {
        score += 22;
        reasons.push('관측한 ' + stat.historyDays + '일 기록에서 가장 낮은 가격이다');
      }
    } else if (percentile <= P_VERY_LOW) {
      score += 22;
      reasons.push('관측한 ' + stat.historyDays + '일 기록에서 하위 ' + percentile + '% 가격이다');
    } else if (percentile <= P_LOW) {
      score += 10;
      reasons.push('관측한 기록에서 하위 ' + percentile + '% 가격이다');
    } else if (percentile >= 100) {
      score -= 22;
      reasons.push('관측한 ' + stat.historyDays + '일 기록에서 가장 비싼 가격이다');
    } else if (percentile >= P_VERY_HIGH) {
      score -= 22;
      reasons.push('관측한 기록에서 상위 ' + (100 - percentile) + '% 에 드는 비싼 가격이다');
    } else if (percentile >= P_HIGH) {
      score -= 10;
      reasons.push('관측한 기록에서 비싼 축(상위 ' + (100 - percentile) + '%)이다');
    }
  }

  /*
   * 평균 대비 거리.
   *
   * ★ 이상치가 섞였으면 쓰지 않는다. 평균은 이상치에 그대로 끌려가기 때문에,
   *   이틀치 튄 값이 "30일 평균보다 51% 싸다" 같은 없는 근거를 만들어 낸다.
   *   대신 중앙값과 견줘서 말한다 — 그쪽은 이틀에 흔들리지 않는다.
   */
  if (outlier && med > 0) {
    const dm = (med - p) / med;
    if (dm >= AVG_CHEAP) {
      score += 18;
      reasons.push('평소 가격 ' + won(med) + '원보다 ' + pct(dm) + '% 낮다');
    } else if (dm <= -AVG_DEAR) {
      score -= 18;
      reasons.push('평소 가격 ' + won(med) + '원보다 ' + pct(-dm) + '% 높다');
    } else {
      reasons.push('평소 가격 ' + won(med) + '원과 비슷하다');
    }
  } else if (stat.avg30 > 0) {
    const d = (stat.avg30 - p) / stat.avg30;
    if (d >= AVG_CHEAP) {
      score += 18;
      reasons.push('30일 평균 ' + won(stat.avg30) + '원보다 ' + pct(d) + '% 낮다');
    } else if (d <= -AVG_DEAR) {
      score -= 18;
      reasons.push('30일 평균 ' + won(stat.avg30) + '원보다 ' + pct(-d) + '% 높다');
    }
  }

  // 최근 일주일 흐름. 여기도 평균이 재료라 이상치가 있으면 말하지 않는다.
  if (!outlier && stat.avg7 > 0 && stat.avg30 > 0 && stat.avg7Days >= 2) {
    const shift = (stat.avg7 - stat.avg30) / stat.avg30;
    if (shift <= -0.05) {
      cautions.push('최근 일주일 시세가 30일 평균보다 ' + pct(-shift) + '% 낮아 더 내려갈 여지가 있다');
    } else if (shift >= 0.05) {
      cautions.push('최근 일주일 시세가 30일 평균보다 ' + pct(shift) + '% 높아 오르는 중이다');
    }
  }

  if (stat.trendPct != null && stat.trendDays >= 1) {
    if (stat.trendPct <= -3) {
      score += 6;
      reasons.push('최근 ' + stat.trendDays + '일 동안 ' + Math.abs(stat.trendPct) + '% 내렸다');
    } else if (stat.trendPct >= 5) {
      score -= 6;
      reasons.push('최근 ' + stat.trendDays + '일 동안 ' + stat.trendPct + '% 올랐다');
    }
  }

  if (stat.low > 0 && p > stat.low) {
    const over = (p - stat.low) / stat.low;
    if (over > 0.02) {
      cautions.push('역대 최저가는 아니다(' + stat.lowDate + ' ' + won(stat.low) + '원, ' + pct(over) + '% 위)');
    }
  } else if (stat.low > 0 && p < stat.low) {
    /*
     * 관측한 어떤 값보다도 낮다 — 백분위로는 표현되지 않는 사실이다.
     *
     * 다만 이건 방금 받아온 값 하나다. 기록으로 확인된 바닥이 아니라는 것을
     * 같은 문장 안에서 밝힌다. "역대 최저" 라고 부르지 않는다.
     */
    reasons.push('우리가 관측한 어떤 날의 가격보다도 낮다(기록상 최저 ' + won(stat.low) + '원). '
      + '다만 이번 한 번만 본 값이라 확인 중이다');
    cautions.push('기록에 없던 값이라 아직 확인되지 않았다. '
      + '판매처에서 실제 결제 금액을 확인해 달라');
  }

  if (stat.volatility != null && stat.volatility >= VOLATILE_PCT) {
    cautions.push('이 상품은 가격 변동이 큰 편(±' + stat.volatility + '%)이라 이 정도 가격이 드물지 않을 수 있다');
    // 변동이 크면 확신을 줄인다 — 싸 보여도 흔한 일일 수 있다.
    if (score > 50) score -= 8;
  }

  if (!fresh.trusted) {
    cautions.push(fresh.label);
    if (score > 50) score -= 6;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict;
  if (score >= 78) verdict = 'BUY';
  else if (score >= 64) verdict = 'GOOD_BUY';
  else if (score >= 44) verdict = 'NORMAL';
  else if (score >= 34) verdict = 'WATCH';
  else if (score >= 22) verdict = 'WAIT';
  else verdict = 'DONT_BUY';

  /*
   * BUY 는 근거가 확실할 때만 쓴다.
   *
   * 점수만으로 BUY 를 내면 "평균보다 조금 싸고 기록도 짧은" 상품이 BUY 가
   * 된다. 사용자가 이 말을 믿고 돈을 쓰는 이상, 확실할 때만 말해야 한다.
   */
  if (verdict === 'BUY') {
    const solid = fresh.trusted && stat.historyDays >= PCTL_MIN_DAYS && pctlUsable;
    if (!solid) {
      verdict = 'GOOD_BUY';
      cautions.push('근거가 확실하다고 말하기에는 기록이 짧거나 오래되어 한 단계 낮춰 판단했다');
    } else if (unconfirmedLow) {
      /*
       * 확인되지 않은 신저가 위에서는 최고 등급을 주지 않는다.
       *
       * BUY 는 "지금 사도 좋다" 다. 그 말의 근거가 하루만 본 값 하나라면
       * 근거가 틀렸을 때 사용자가 돈을 쓴 뒤다. 한 단계 낮춰서, 값은 그대로
       * 보여 주되 확신만 뺀다.
       */
      verdict = 'GOOD_BUY';
      cautions.push('가장 낮은 값이지만 하루치 관측뿐이라 한 단계 낮춰 판단했다');
    }
  }

  /*
   * assess() 와 어긋나지 않게 한다.
   *
   * 같은 데이터로 두 개의 결론을 말하면 어느 쪽도 믿을 수 없다.
   * assess 가 wait 이라고 한 것을 여기서 BUY 로 뒤집지 않는다.
   */
  const a = assess(stat, p, today);
  if (a && a.verdict === 'wait' && DEAL_ORDER[verdict] > DEAL_ORDER.NORMAL) {
    verdict = 'NORMAL';
    cautions.push('다른 기준(30일 평균·역대 최저가)에서는 싸지 않아 낮춰 판단했다');
  }
  if (a && a.verdict === 'good' && DEAL_ORDER[verdict] < DEAL_ORDER.WATCH) {
    verdict = 'WATCH';
  }

  if (!reasons.length) reasons.push('기록 대비 특별히 싸지도 비싸지도 않다');

  return {
    verdict, label: DEAL_LABEL[verdict], score,
    percentile, freshness: fresh,
    // 이상치가 섞였다는 사실은 판정 밖에서도 필요하다 — 프롬프트가 모델에게
    // "그 평균은 쓰지 마라" 고 말해야 하기 때문이다 (dealBlock 참고).
    outlier, median: outlier ? med : 0,
    reasons, cautions, anomalies: anom, evidence
  };
}

/**
 * 판정을 프롬프트에 실을 문장으로.
 *
 * ★ 모델은 이 블록을 풀어 말할 뿐, 판정을 다시 내리지 않는다.
 */
function dealBlock(deal) {
  if (!deal) return '';
  const L = ['[구매 시점 판정 — 코드가 계산했다. 다시 판단하지 마라]'];
  L.push('  판정: ' + deal.verdict + ' (' + deal.label + ')');
  if (deal.score != null) L.push('  점수: ' + deal.score + '/100');
  if (deal.percentile != null) L.push('  기록 내 위치: 하위 ' + deal.percentile + '%');
  L.push('  가격 최신성: ' + deal.freshness.label + ' (' + deal.freshness.days + '일 전)');

  if (deal.reasons.length) {
    L.push('  근거:');
    deal.reasons.forEach(r => L.push('    · ' + r));
  }
  if (deal.cautions.length) {
    L.push('  주의:');
    deal.cautions.forEach(r => L.push('    · ' + r));
  }
  if (deal.anomalies.length) {
    L.push('  이상 징후:');
    deal.anomalies.forEach(a => L.push('    · ' + a.note));
  }

  L.push('- ★ 위 판정을 그대로 쓴다. 더 좋게도 더 나쁘게도 바꾸지 마라.');
  if (deal.verdict === 'UNKNOWN') {
    L.push('- ★ 판정할 수 없다는 사실을 숨기지 마라. "괜찮다" 로 바꾸면 거짓말이다.');
  }
  /*
   * 이상치가 섞였으면 평균을 인용하지 못하게 막는다.
   *
   * 판정만 고쳐서는 부족했다. 실측으로, 판정이 NORMAL 로 내려간 뒤에도 모델이
   * 상품 사실 블록에 남아 있는 "30일 평균 24,504원" 을 집어서 "평균보다 35%
   * 낮습니다" 라고 말했다. 그 평균은 이틀치 오수집으로 부풀려진 값이다.
   */
  if (deal.outlier) {
    L.push('- ★ 이 상품의 30일/7일 평균은 잘못 수집된 값에 오염되어 있다.');
    L.push('  "평균보다 몇 % 싸다/비싸다" 를 말하지 마라. 상품 사실에 그 숫자가 적혀 있어도 쓰지 마라.');
    if (deal.median > 0) {
      L.push('  대신 평소 가격 ' + won(deal.median) + '원과 견주어 말한다.');
    }
  }
  if (deal.cautions.length) {
    L.push('- ★ 주의 항목을 빠뜨리지 마라. 좋은 소식만 말하면 사용자가 손해를 본다.');
  }
  return L.join('\n');
}

module.exports = {
  dealOf, dealBlock, freshness, pricePercentile, anomalies,
  DEAL_LABEL, DEAL_ORDER, FRESHNESS, FRESHNESS_ORDER, FRESHNESS_DOUBT,
  P_VERY_LOW, P_LOW, P_HIGH, P_VERY_HIGH,
  AVG_CHEAP, AVG_DEAR,
  ANOMALY_DROP, ANOMALY_JUMP, GAP_WARN_DAYS, PCTL_MIN_DAYS, PCTL_MIN_SPREAD, OUTLIER_RATIO, VOLATILE_PCT
};
