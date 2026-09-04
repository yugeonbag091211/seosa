/*
 * 서버에서 가격 기록 → "지금 이 가격이 어느 정도인가" 통계.
 *
 * ── 왜 이 파일이 생겼는가 ────────────────────────────────────────
 *
 * SEOSA 가 일반 챗봇과 다른 유일한 근거는 매일 쌓은 실제 가격 기록이다.
 * 그런데 AI 가 스스로 검색해서 찾아온 상품에는 그 기록이 한 줄도 붙지
 * 않았다(api/ai.js fromSearchResult 가 현재가·정가·신뢰도만 옮겼다).
 *
 * 화면에서 온 상품(contextProducts)에는 프론트가 /api/history-batch 를
 * 불러 PriceStat 으로 만든 hist 가 붙어 있었다. 그래서 이런 갈림이 있었다.
 *
 *   "이 화면의 상품 어때?"   → 역대 최저가·30일 평균·추세로 답한다
 *   "무선 이어폰 추천해줘"   → 현재가만 나열한다 (검색해서 찾아온 것이므로)
 *
 * 정작 추천을 부탁할 때 우리 데이터가 통째로 빠져 있었다. 그 자리에서
 * 모델이 할 수 있는 말은 "89,000원입니다" 뿐이고, 그건 ChatGPT 도 한다.
 *
 * 이 파일은 프론트 PriceStat 을 서버로 옮긴 것이다. 계산식은 같다 —
 * 같은 상품을 화면에서 보든 AI 가 찾아오든 숫자가 달라지면 안 된다.
 *
 * ★ 지어내지 않는다. 기록이 없으면 null 을 돌려주고, 호출부는 "기록 없음"
 *   으로 프롬프트에 적는다. 빈 통계를 0 으로 채워 넣지 않는다.
 */
const supabase = require('./_supabase');
const { observedKstDate, kstToday } = require('./_price');

/** 조회 창. 역대 최저가를 말하려면 30일(_trust)보다는 길어야 한다. */
const WINDOW_DAYS = 180;
/** product_id in(...) 한 번에 넣을 개수 (URL 길이 제한). */
const CHUNK = 60;
/** 한 번의 조회에서 훑을 최대 행 수. 상품 8개 × 180일 × 몰 여러 개 여유. */
const MAX_ROWS = 4000;

/** 30일 평균을 낼 창. 프론트 CONST.AI_AVG_DAYS 와 같은 값이어야 한다. */
const AVG_DAYS = 30;
/** 추세를 볼 창. 프론트 CONST.AI_TREND_DAYS 와 같은 값이어야 한다. */
const TREND_DAYS = 7;
/** 단기 평균을 낼 창. 30일 평균과 함께 보면 "요즘 갑자기" 를 가른다. */
const SHORT_AVG_DAYS = 7;
/** 프롬프트에 실을 최근 기록 점 개수. */
const MAX_POINTS = 6;

function int(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
}

/*
 * 날짜 라벨은 KST 기준이다.
 *
 * 여기서 UTC(toISOString)로 자르면 KST 00:00~09:00 사이 9시간 동안
 * 창의 시작일이 프론트보다 하루 이르다. 실측으로 KST 03:00 에
 * "30일 평균"이 31일치를 평균했다 — 화면과 AI 가 다른 숫자를 말하게 된다.
 *
 * price_history 의 날짜(observedKstDate)도, 프론트 PriceStat.ymd 의
 * 로컬 시간도 전부 KST 다. 여기만 UTC 였다.
 */
function ymd(d) {
  return kstToday(d);
}

/** 'YYYY-MM-DD' 두 개 사이의 일수 (파싱 실패면 0) */
function spanDays(a, b) {
  const pa = String(a || '').split('-');
  const pb = String(b || '').split('-');
  if (pa.length !== 3 || pb.length !== 3) return 0;
  const ta = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]);
  const tb = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

/**
 * [{date, price}] 오름차순 → AI 가 판단에 쓸 통계.
 *
 * 프론트 PriceStat.from 과 같은 계산이다. 한쪽만 고치지 말 것.
 *
 * @returns {object|null} 기록이 없으면 null
 */
function statsFrom(points) {
  const pts = (points || []).filter(h => h && h.date && int(h.price) > 0);
  if (!pts.length) return null;

  const prices = pts.map(h => int(h.price));

  // 역대 최저가. 같은 값이 여러 번이면 가장 최근 날짜를 쓴다
  // ("가장 최근에 그 가격이었던 때"가 사용자에게 더 쓸모 있다).
  const low = Math.min.apply(null, prices);
  let lowDate = '';
  for (let i = pts.length - 1; i >= 0; i--) {
    if (prices[i] === low) { lowDate = pts[i].date; break; }
  }

  // 30일 평균은 슬라이스가 아니라 날짜로 자른다 — 수집이 끊긴 구간이 있으면
  // "최근 30개 점"이 30일이 아니게 되어 평균 설명이 사실과 달라진다.
  const avgCut = ymd(new Date(Date.now() - (AVG_DAYS - 1) * 86400000));
  const recent = pts.filter(h => String(h.date) >= avgCut);
  let avg30 = 0;
  if (recent.length) {
    avg30 = Math.round(recent.reduce((s, h) => s + int(h.price), 0) / recent.length);
  }

  const trendCut = ymd(new Date(Date.now() - (TREND_DAYS - 1) * 86400000));
  let win = pts.filter(h => String(h.date) >= trendCut);
  if (win.length < 2) win = pts.slice(-2);   // 최근 구간에 기록이 하나뿐이면 직전 기록과 비교

  let trendPct = null, trendDays = 0, trendFrom = 0, trendFromDate = '';
  if (win.length >= 2) {
    const f = int(win[0].price);
    const l = int(win[win.length - 1].price);
    trendDays = spanDays(win[0].date, win[win.length - 1].date);
    if (f > 0 && trendDays >= 1) {
      trendPct = Math.round(((l - f) / f) * 1000) / 10;
      trendFrom = f;
      trendFromDate = win[0].date;
    }
  }


  // 역대 최고가 — "50% 할인" 이 정가 부풀리기인지 가르는 데 쓴다.
  const high = Math.max.apply(null, prices);
  let highDate = '';
  for (let k = pts.length - 1; k >= 0; k--) {
    if (prices[k] === high) { highDate = pts[k].date; break; }
  }

  // 7일 평균. 30일 평균과 갈리면 "요즘 들어" 움직였다는 뜻이다.
  const shortCut = ymd(new Date(Date.now() - (SHORT_AVG_DAYS - 1) * 86400000));
  const recent7 = pts.filter(h => String(h.date) >= shortCut);
  let avg7 = 0;
  if (recent7.length) {
    avg7 = Math.round(recent7.reduce((s, h) => s + int(h.price), 0) / recent7.length);
  }

  /*
   * 변동성 — 표준편차를 평균으로 나눈 값(변동계수).
   *
   * 왜 필요한가: 같은 "평균보다 10% 싸다" 라도, 늘 ±1% 로 움직이던 상품에서는
   * 드문 기회이고 ±30% 로 출렁이던 상품에서는 흔한 일이다. 이 구분 없이
   * 할인율만 말하면 흔한 가격을 특가라고 부르게 된다.
   */
  let volatility = null;
  if (prices.length >= 2) {
    const mean = prices.reduce((s, v) => s + v, 0) / prices.length;
    if (mean > 0) {
      const varSum = prices.reduce((s, v) => s + (v - mean) * (v - mean), 0) / prices.length;
      volatility = Math.round(Math.sqrt(varSum) / mean * 1000) / 10;
    }
  }

  /*
   * 중앙값 — 이상치에 흔들리지 않는 "보통 가격".
   *
   * 실측(2026-08-29, product_id 로 조회한 15,900원짜리 이어폰): 27일 중 25일이
   * 15,900원인데 이틀만 242,100 / 222,390원이었다. 옵션이 바뀌었거나 같은 자리에
   * 다른 상품이 들어온 것으로 보인다. 그 이틀 때문에 high 와 avg30 이 통째로
   * 망가져서, 25일째 값이 고정된 상품에 "더 내려갈 여지가 있다" 는 거짓 근거가
   * 붙었다. 평균과 최고가만으로는 이 상황을 알 수 없다 — 중앙값이 있어야 안다.
   */
  const sortedPrices = prices.slice().sort((a, b) => a - b);
  const mid = Math.floor(sortedPrices.length / 2);
  const median = sortedPrices.length % 2
    ? sortedPrices[mid]
    : Math.round((sortedPrices[mid - 1] + sortedPrices[mid]) / 2);

  // 기록이 실제로 덮는 기간과, 가장 크게 끊겼던 구간.
  const historyDays = spanDays(pts[0].date, pts[pts.length - 1].date);
  let maxGapDays = 0;
  for (let k = 1; k < pts.length; k++) {
    const g = spanDays(pts[k - 1].date, pts[k].date);
    if (g > maxGapDays) maxGapDays = g;
  }

  return {
    count:     pts.length,
    lastPrice: prices[prices.length - 1],
    lastDate:  pts[pts.length - 1].date,
    prevPrice: pts.length >= 2 ? prices[prices.length - 2] : 0,
    low,
    lowDate,
    avg30,
    avg30Days: recent.length,
    trendPct,
    trendDays,
    trendFrom,
    trendFromDate,
    points: pts.slice(-MAX_POINTS).map(h => ({ d: h.date, p: int(h.price) })),

    /* ── 아래는 Deal Engine(api/_deal.js)이 쓰는 값이다 ───────────
     * 기존 필드는 하나도 바꾸지 않는다. 화면과 AI 의 숫자가 갈리면 안 되므로
     * 프론트 PriceStat 과 공유하는 값(low·avg30·trendPct)은 그대로 두고,
     * 서버 판정에만 쓰는 값을 덧붙인다. */
    high,
    highDate,
    avg7,
    avg7Days: recent7.length,
    volatility,       // 변동성(%) — 표준편차 / 평균. 기록 2개 미만이면 null
    historyDays,      // 기록이 실제로 덮는 일수
    maxGapDays,       // 기록이 가장 오래 끊겼던 구간(일)
    median,           // 이상치에 흔들리지 않는 대표값
    firstDate: pts[0].date
  };
}

/**
 * 상품 여러 건의 가격 기록을 한 번에 읽어 통계로 만든다.
 *
 * 키는 `${productId}|${mall}` 이다. /api/history-batch 와 같은 기준으로
 * 상품 단위로만 묶는다 — 상품명으로 묶으면 이름이 같은 다른 상품·다른 몰의
 * 기록이 날짜별 최저가로 합쳐져서, 어느 상품의 것도 아닌 곡선이 나온다.
 * 그 위에서 "역대 최저가입니다" 를 말하면 남의 가격으로 판단하는 것이다.
 *
 * ★ 실패해도 throw 하지 않는다. 기록을 못 읽는 것은 답변을 막을 이유가
 *   아니다 — 통계 없이 현재가만으로 답하면 된다(예전과 같은 동작).
 *
 * @param {Array<{productId:string, mall:string}>} keys
 * @returns {Promise<Map<string, object>>} key → statsFrom 결과
 */
async function loadStats(keys) {
  const out = new Map();
  const list = (keys || []).filter(k => k && k.productId);
  if (!list.length) return out;

  const ids = [...new Set(list.map(k => String(k.productId)))];
  const wanted = new Set(list.map(k => `${k.productId}|${k.mall || ''}`));
  const cutoff = kstToday(new Date(Date.now() - WINDOW_DAYS * 86400000));

  // key → Map<날짜, 그날의 최저가>
  const byKey = new Map();

  for (let i = 0; i < ids.length; i += CHUNK) {
    let data;
    try {
      const r = await supabase
        .from('price_history')
        .select('product_id, mall, price, recorded_date, recorded_at')
        .in('product_id', ids.slice(i, i + CHUNK))
        .gte('recorded_date', cutoff)
        // 잘릴 때 오래된 쪽이 버려지도록 최신순으로 가져온다.
        .order('recorded_date', { ascending: false })
        .limit(MAX_ROWS);
      if (r.error) throw new Error(r.error.message);
      data = r.data;
    } catch (e) {
      console.warn(`[pricestat] 가격 기록 조회 실패(통계 없이 진행): ${e.message}`);
      return out;
    }

    (data || []).forEach(r => {
      const key = `${r.product_id}|${r.mall || ''}`;
      if (!wanted.has(key)) return;   // 같은 product_id 의 다른 몰 행은 섞지 않는다
      const date = observedKstDate(r);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const price = int(r.price);
      if (price <= 0) return;
      if (!byKey.has(key)) byKey.set(key, new Map());
      const m = byKey.get(key);
      const cur = m.get(date);
      // 같은 날 여러 행이면 최저가 한 점만 (history-batch keepLowest 와 같은 기준)
      if (cur === undefined || price < cur) m.set(date, price);
    });
  }

  byKey.forEach((byDate, key) => {
    const points = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, price]) => ({ date, price }));
    const st = statsFrom(points);
    if (st) out.set(key, st);
  });

  return out;
}

/* ==================================================================
 *  구매 시점 판단 (Deal Assessment)
 *
 *  "지금 사도 돼?" 에 대한 판정을 모델이 아니라 여기서 내린다.
 *
 *  ── 왜 코드가 판정하는가 ────────────────────────────────────────
 *  같은 데이터를 주고 판단을 모델에게 맡기면 물을 때마다 결론이 흔들린다
 *  (temperature 0.2 에서도 문장 구성에 따라 "좋은 가격" ↔ "애매한 가격" 이
 *  갈렸다). 구매 판단은 같은 데이터면 같은 결론이 나와야 사용자가 믿는다.
 *  그래서 판정은 여기서 내리고, 모델은 그 판정을 근거 수치로 풀어 말한다.
 *
 *  ── 점수 설계 ──────────────────────────────────────────────────
 *  단순 할인율을 쓰지 않는다 — 정가를 부풀린 상품에서 할인율은 거짓말이다.
 *  실제 관측 기록(price_history) 기준으로만 잰다.
 *    · 역대 최저가와의 거리          (기록상 이 값보다 싼 적이 있는가)
 *    · 30일 평균과의 거리            (요즘 시세보다 싼가)
 *    · 최근 추세                     (내려가는 중인가 올라가는 중인가)
 *  기록이 3일치 미만이면 판정하지 않는다 — 근거가 부족한 확신은
 *  틀린 확신보다 나쁘지 않지만, 없는 확신보다는 나쁘다.
 * ================================================================== */

/** 판정을 내리기에 필요한 최소 기록 일수. */
const ASSESS_MIN_DAYS = 3;
/** 기록이 이보다 오래 멈춰 있으면(일) 판정을 보류한다. */
const ASSESS_MAX_STALE = 7;
/** 프롬프트에 "기록이 멈춰 있다"고 알리기 시작하는 기준(일). */
const STALE_WARN_DAYS = 4;

const VERDICT_LABEL = {
  good:    '지금 사도 좋은 편(기록 대비 저렴)',
  neutral: '평범한 가격(기록 대비 특별히 싸지 않음)',
  wait:    '평소보다 비싼 편(서두를 이유 없음)'
};

/**
 * @param {object} stat   statsFrom 결과 (hist)
 * @param {number} price  현재가
 * @param {string} today  KST 오늘 'YYYY-MM-DD'
 * @returns {{score:number, verdict:string, label:string, staleDays:number}|null}
 *   판정 불가(기록 부족·가격 없음)면 null. 기록이 오래 멈췄으면 verdict='unknown'
 *   으로 돌려주되 staleDays 를 실어, 호출부가 "판정 보류 + 이유"를 만들 수 있게 한다.
 */
function assess(stat, price, today) {
  const p = int(price);
  if (!stat || !(stat.count >= ASSESS_MIN_DAYS) || p <= 0) return null;

  // 기록이 며칠 전에 멈췄는가. lastDate 가 오늘보다 미래면(시계 어긋남) 0으로.
  const staleDays = (today && stat.lastDate) ? Math.max(0, spanDays(stat.lastDate, today)) : 0;

  let score = 50;

  if (stat.low > 0) {
    const dLow = (p - stat.low) / stat.low;    // 0 = 역대 최저가와 같음
    if (p <= stat.low) score += 25;
    else if (dLow <= 0.03) score += 18;
    else if (dLow >= 0.25) score -= 15;
    else if (dLow >= 0.12) score -= 6;
  }

  if (stat.avg30 > 0) {
    const dAvg = (stat.avg30 - p) / stat.avg30;   // + = 평균보다 쌈
    if (dAvg >= 0.10) score += 20;
    else if (dAvg >= 0.03) score += 8;
    else if (dAvg <= -0.08) score -= 18;
    else if (dAvg <= -0.03) score -= 8;
  }

  if (stat.trendPct != null && stat.trendDays >= 1) {
    if (stat.trendPct <= -3) score += 6;
    else if (stat.trendPct >= 5) score -= 6;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict;
  if (staleDays > ASSESS_MAX_STALE) verdict = 'unknown';   // 근거가 낡았다 — 단정 금지
  else if (score >= 72) verdict = 'good';
  else if (score <= 40) verdict = 'wait';
  else verdict = 'neutral';

  return {
    score,
    verdict,
    label: VERDICT_LABEL[verdict] || '',
    staleDays
  };
}

module.exports = {
  statsFrom, loadStats, spanDays, assess,
  WINDOW_DAYS, AVG_DAYS, TREND_DAYS, SHORT_AVG_DAYS,
  ASSESS_MIN_DAYS, ASSESS_MAX_STALE, STALE_WARN_DAYS, VERDICT_LABEL
};
