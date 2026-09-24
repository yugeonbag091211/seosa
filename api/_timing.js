'use strict';
/*
 * ① AI 구매 타이밍 — "지금 살까, 기다릴까" 를 이 상품의 실제 가격 기록으로 답한다.
 *
 * ── 이 파일이 답하는 세 질문 ─────────────────────────────────────────
 *
 *   1) 지금 가격은 기록에서 어디쯤인가      → _pricestat.fairness (이미 있다 — 다시 만들지 않는다)
 *   2) 기다리면 더 내려갈 확률은 얼마인가  → 아래 forecast
 *   3) 그 확률을 믿어도 되는가              → 아래 backtest (이 상품의 과거로 검증)
 *
 * ── 왜 «과거의 비슷한 날» 로 예측하는가 (empirical analog) ──────────────
 *
 * 쿠팡 가격은 추세를 그리는 주가가 아니다. 대부분 평소 가격에 머물다가
 * 행사·쿠폰으로 며칠 내려갔다가 돌아온다. 그 모양은 상품마다 전부 다르다.
 * 그래서 모든 상품에 한 모형(선형 추세·ARIMA)을 씌우지 않는다. 대신 이 상품이
 * «지금과 비슷한 가격 위치였던 과거의 날들» 에 그 뒤 H일 동안 실제로 무슨 일이
 * 있었는지를 센다.
 *
 *   예) 지금이 최근 90일 중 상위 20%(비싼 편)다.
 *       과거에 상위 10~30% 였던 날이 23번 있었고, 그중 15번은 14일 안에
 *       5% 이상 내려갔다 → "14일 안 5% 이상 하락 확률 65% (표본 23)".
 *
 * 이 방식은 설명이 된다. 확률 뒤에 «실제로 있었던 날들» 이 있고, 사용자에게
 * 그 수를 그대로 말할 수 있다. 모형 계수는 사용자에게 설명할 수 없다.
 *
 * ── 지키는 선 ──────────────────────────────────────────────────────
 *
 * 1. 표본이 모자라면 확률을 만들지 않는다. 방법을 한 단계 낮추고(volatility-band),
 *    그것도 모자라면 INSUFFICIENT 다. 모르는 것을 50% 로 채우지 않는다.
 * 2. _deal.dealOf 와 모순되지 않는다. 기록상 비싸다(WAIT/DONT_BUY)는 상품에
 *    BUY_NOW 를 내지 않는다 — 같은 화면에서 두 엔진이 반대 말을 하면 둘 다 못 믿는다.
 * 3. 백테스트가 기본값(무조건 과거 평균 하락률)보다 못하면 행동을 권하지 않는다.
 *    이 상품에서 통하지 않는 예측을 «AI 가 기다리래요» 로 포장하지 않는다.
 * 4. 백테스트에는 미래가 새지 않는다. 시점 t 의 예측은 t 까지 «완전히 관측된»
 *    과거 표본만 쓴다 (scripts/test-v2-timing.js 가 접두 구간 재계산과 같음을 고정).
 *
 * ★ 순수 함수만 있다. DB 도 네트워크도 모른다 (핸들러는 api/_timing-api.js).
 * ★ 절대 throw 하지 않는다 (docs/seosa2/CONTRACTS.md §3-7).
 */

const { fairness, statsFrom, FAIR_WINDOW_DAYS, FAIR_MIN_OBS, FAIR_MIN_SPREAD } = require('./_pricestat');
const { dealOf } = require('./_deal');
const { kstToday } = require('./_kst');

/* ── 기간 ─────────────────────────────────────────────────────────── */

/** 허용하는 예측 기간(일). 하루·사흘은 수집 간격(하루 1회)에 비해 너무 짧아 뜻이 없다. */
const HORIZONS = [7, 14, 30];
const DEFAULT_HORIZON = 14;

/* ── 예측을 시작할 최소 조건 ─────────────────────────────────────── */

/**
 * 관측이 이보다 적으면 어떤 예측도 하지 않는다.
 * 10일치는 «평소 가격» 이 무엇인지 겨우 보이는 수준이다 (fairness 의 FULL_OBS 와 같은 값).
 */
const MIN_OBS = 10;
/** 기록이 덮는 기간이 이보다 짧으면 예측하지 않는다 — 10점이 사흘에 몰려 있으면 기록이 아니다. */
const MIN_SPAN_DAYS = 14;
/** 마지막 관측이 이보다 오래됐으면 «지금» 에 대해 말하지 않는다 (_pricestat.ASSESS_MAX_STALE 와 같다). */
const MAX_STALE_DAYS = 7;

/* ── 과거 표본 ───────────────────────────────────────────────────── */

/**
 * 한 표본(과거의 하루)의 «그 뒤 H일» 이 제대로 관측됐는가.
 *
 * 수집은 하루 한 번이지만 빠지는 날이 있다 (GitHub Actions 예약 누락 — daily-prices.yml 주석).
 * 창 안의 관측이 너무 적으면 그 창의 최저가는 «그 기간 최저가» 가 아니라 «우연히 본 날의 값»
 * 이라 실제보다 높게 나온다 → 하락 확률을 낮게 속인다. 그래서 창의 40% 이상이 관측되고,
 * 창의 끝 30% 안에 관측이 하나는 있어야 표본으로 쓴다.
 */
const WINDOW_MIN_COVER = 0.4;
const WINDOW_TAIL_SLACK = 0.3;

/** 비슷한 가격 위치로 좁힌 표본(analog)이 이만큼은 있어야 그것만으로 확률을 낸다. */
const MIN_ANALOGS = 12;
/** 좁히지 않은 전체 표본이 이만큼은 있어야 경험적 확률을 낸다. 이보다 적으면 변동성 밴드로 내려간다. */
const MIN_SAMPLES = 8;
/** 「비슷한 가격 위치」 의 폭 — 백분위 ±20. 5구간 등급(fairness)의 한 칸 폭과 같다. */
const ANALOG_BAND = 20;

/** 하락 기준(현재가 대비). 3% 는 쿠폰 한 장, 5% 는 행사, 10% 는 큰 할인 정도다. */
const DROP_LEVELS = { pct3: 0.03, pct5: 0.05, pct10: 0.10 };

/* ── 권고 규칙 ───────────────────────────────────────────────────── */

/** 5% 이상 하락 확률이 이 이상이고… */
const WAIT_MIN_PROB = 0.5;
/** …그 기간 최저가의 중앙값이 현재가보다 이만큼 이상 낮을 때만 «기다리세요». */
const WAIT_MIN_SAVING = 0.03;
/** 지금 사라고 하려면 5% 이상 하락 확률이 이보다 낮아야 하고… */
const BUY_MAX_PROB = 0.25;
/** …가격 위치가 하위 이 백분위 안이어야 한다 (fairness 의 cheap 경계 30 과 같다). */
const BUY_MAX_PCT = 30;

/* ── 백테스트 ────────────────────────────────────────────────────── */

/** 검증한 날이 이보다 적으면 신뢰도를 말하지 않는다. */
const MIN_BACKTEST = 20;
/** 브라이어 기술점수(skill)가 이 이상이어야 «기본값보다 낫다» 로 본다. */
const MIN_SKILL = 0.05;
/*
 * 기술점수만으로 판정하지 않는 이유.
 *
 * skill 은 «가격 위치로 좁힌 것» 이 «평소 하락 빈도» 보다 얼마나 나은지를 잰다. 그런데
 * 꾸준히 내려가는 상품에서는 평소 하락 빈도 자체가 거의 100% 라서 좁혀도 더 나아질 수가
 * 없다 — skill 이 0 인데 예측은 거의 완벽하다(실측: brier 0.022). 그런 상품에 «예측이 안
 * 맞는다» 고 말하면 거짓말이다. 그래서 절대 정확도(브라이어)가 충분히 낮고 기본값보다
 * 나빠지지만 않았으면 믿을 만하다고 본다. 무작위 보행(실측 brier 0.29, skill −0.16)은
 * 두 조건 모두에서 떨어진다.
 */
/** 이 브라이어 이하면 절대 정확도로 충분하다 (동전 던지기 0.25 의 40%). */
const ABS_BRIER_OK = 0.10;
/** 그때도 기본값보다 이만큼 넘게 나빠지면 안 된다. */
const MIN_SKILL_WHEN_ACCURATE = -0.05;
/** 권고(WAIT/BUY_NOW)가 이만큼 이상 맞아야 믿을 만하다. */
const MIN_HIT_RATE = 0.55;
/** 적중률을 따지려면 권고가 이만큼은 나왔어야 한다. */
const MIN_DECISIONS = 5;

/* ── 불확실성 ────────────────────────────────────────────────────── */

/** 예상 최저가 구간(p10~p90)의 폭이 현재가의 이 비율을 넘으면 불확실성이 높다. */
const BAND_WIDE = 0.15;
const BAND_MEDIUM = 0.07;

const ACTION_LABEL = {
  BUY_NOW: '지금 사도 좋아요',
  WAIT: '조금 기다려 보세요',
  NEUTRAL: '서두를 이유도, 기다릴 이유도 뚜렷하지 않아요',
  INSUFFICIENT: '판단할 가격 기록이 부족해요'
};

/* ================================================================== *
 *  작은 도구
 * ================================================================== */

function int(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; }
function won(n) { return int(n).toLocaleString('ko-KR') + '원'; }
function round2(x) { return Math.round(x * 100) / 100; }
function pctText(x) { return Math.round(x * 100) + '%'; }

/** 'YYYY-MM-DD' → 날짜 일련번호(UTC 일). 형식이 틀리면 NaN. */
function dayNum(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return NaN;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

/** 정렬된 배열의 분위(선형 보간, R type 7). */
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

/** 표준정규 누적분포 (Abramowitz–Stegun 7.1.26 erf 근사, 오차 < 1.5e-7). */
function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * 관측을 정리한다. 날짜당 최저가 한 점, 오늘 이후 라벨 제외, 날짜 오름차순.
 * (_series.toDailyPoints · fairness 와 같은 규칙 — 여기서 한 번 더 해도 멱등이다)
 */
function cleanPoints(points, today) {
  const td = dayNum(today);
  const byDate = new Map();
  (Array.isArray(points) ? points : []).forEach(h => {
    if (!h || typeof h !== 'object') return;
    const date = String(h.date || '').slice(0, 10);
    const d = dayNum(date);
    const price = int(h.price);
    if (!Number.isFinite(d) || price <= 0) return;
    if (Number.isFinite(td) && d > td) return;
    const cur = byDate.get(date);
    if (cur === undefined || price < cur) byDate.set(date, price);
  });
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, price]) => ({ date, price, d: dayNum(date) }));
}

/* ================================================================== *
 *  표본 준비 — 각 과거 날의 «가격 위치» 와 «그 뒤 H일»
 * ================================================================== */

/**
 * 그날의 가격 위치(0~100). 그날까지의 최근 FAIR_WINDOW_DAYS 일 관측만 쓴다 — 미래를 보지 않는다.
 * fairness() 와 같은 중간순위(midrank) 식이고, 관측이 모자라거나 폭이 좁으면 null 이다.
 */
function positionsOf(pts) {
  const out = new Array(pts.length).fill(null);
  let start = 0;
  for (let i = 0; i < pts.length; i++) {
    while (pts[start].d < pts[i].d - (FAIR_WINDOW_DAYS - 1)) start++;
    const win = pts.slice(start, i + 1).map(p => p.price);
    if (win.length < FAIR_MIN_OBS) continue;
    const lo = Math.min.apply(null, win), hi = Math.max.apply(null, win);
    if (!(lo > 0) || (hi - lo) / lo < FAIR_MIN_SPREAD) continue;
    const cur = pts[i].price;
    const below = win.filter(v => v < cur).length;
    const equal = win.filter(v => v === cur).length;
    out[i] = Math.round((below + equal / 2) / win.length * 100);
  }
  return out;
}

/**
 * 각 날 i 의 «그 뒤 H일»: (d_i, d_i + H] 안의 최저가·관측 수·마지막 관측.
 * complete=false 면 표본으로도, 채점 대상으로도 쓰지 않는다 (WINDOW_MIN_COVER 주석).
 */
function futuresOf(pts, H) {
  const needCount = Math.max(2, Math.ceil(H * WINDOW_MIN_COVER));
  const tailFrom = H - Math.ceil(H * WINDOW_TAIL_SLACK);
  /*
   * 창이 «다 지나간» 날만 표본이다. 꼬리 여유(WINDOW_TAIL_SLACK)는 수집이 빠진 날을 위한
   * 것이지, 아직 오지 않은 날을 위한 것이 아니다. 마지막 관측 직전의 날은 창의 뒷부분을
   * 아직 못 봤으므로, 그 최저가는 실제보다 높게 나와 하락 확률을 낮게 속인다.
   * (이 조건 덕에 실시간 예측과 백테스트의 시점별 예측이 정확히 같아진다 — 누설 검사)
   */
  const endDay = pts.length ? pts[pts.length - 1].d : -Infinity;
  return pts.map((p, i) => {
    if (p.d + H > endDay) return { complete: false };
    let min = Infinity, count = 0, lastD = -Infinity, lastPrice = 0;
    for (let j = i + 1; j < pts.length && pts[j].d <= p.d + H; j++) {
      count++;
      if (pts[j].price < min) min = pts[j].price;
      lastD = pts[j].d;
      lastPrice = pts[j].price;
    }
    const complete = count >= needCount && lastD >= p.d + tailFrom;
    return complete
      ? { complete: true, min, count, endPrice: lastPrice, ratio: min / p.price }
      : { complete: false };
  });
}

/* ================================================================== *
 *  예측
 * ================================================================== */

/**
 * 표본에서 확률·분위를 낸다.
 * @param {{ratio:number, pos:number|null}[]} samples  그 뒤 H일 최저가 / 그날 가격
 * @param {number|null} posNow  지금 가격 위치
 * @param {number} current      지금 가격
 * @returns {object|null} 표본이 모자라면 null
 */
function empirical(samples, posNow, current) {
  let used = null, conditioned = false;
  if (posNow != null) {
    const near = samples.filter(s => s.pos != null && Math.abs(s.pos - posNow) <= ANALOG_BAND);
    if (near.length >= MIN_ANALOGS) { used = near; conditioned = true; }
  }
  if (!used && samples.length >= MIN_SAMPLES) used = samples;
  if (!used) return null;

  const ratios = used.map(s => s.ratio).sort((a, b) => a - b);
  const prob = x => round2(ratios.filter(r => r <= 1 - x + 1e-9).length / ratios.length);
  return {
    method: 'empirical-analog',
    conditioned,
    samples: used.length,
    dropProbability: { pct3: prob(DROP_LEVELS.pct3), pct5: prob(DROP_LEVELS.pct5), pct10: prob(DROP_LEVELS.pct10) },
    expectedMin: {
      p10: Math.round(current * quantile(ratios, 0.1)),
      p50: Math.round(current * quantile(ratios, 0.5)),
      p90: Math.round(current * quantile(ratios, 0.9))
    }
  };
}

/**
 * 표본이 모자랄 때 — 일간 변동성으로 «H일 안의 최저가» 폭만 낸다.
 *
 * 방향 없는 무작위 보행을 가정하고 반사 원리로 최저가 분포를 구한다:
 *   P(H일 안 최저가 ≤ p·(1−x)) = 2·Φ( ln(1−x) / (σ·√H) )
 * 방향 정보가 없으므로 이 방법으로는 WAIT/BUY_NOW 를 내지 않는다 (recommend 참고).
 */
function volatilityBand(pts, current, H) {
  const rets = [];
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].d - pts[i - 1].d;
    if (gap <= 0) continue;
    rets.push(Math.log(pts[i].price / pts[i - 1].price) / Math.sqrt(gap));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const sigma = Math.sqrt(rets.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rets.length);
  const s = sigma * Math.sqrt(H);
  const prob = x => (s > 0 ? round2(Math.min(1, 2 * normCdf(Math.log(1 - x) / s))) : 0);
  // 최저가의 q 분위: 2Φ(ln(m/p)/s) = q → m = p·exp(s·Φ⁻¹(q/2)). Φ⁻¹(0.05)=-1.645, Φ⁻¹(0.25)=-0.674, Φ⁻¹(0.45)=-0.126
  const at = z => Math.round(current * Math.exp(s * z));
  return {
    method: 'volatility-band',
    conditioned: false,
    samples: rets.length,
    dailyVolatility: round2(sigma * 100),
    dropProbability: { pct3: prob(DROP_LEVELS.pct3), pct5: prob(DROP_LEVELS.pct5), pct10: prob(DROP_LEVELS.pct10) },
    expectedMin: { p10: at(-1.645), p50: at(-0.674), p90: at(-0.126) }
  };
}

/**
 * 규칙으로 행동을 정한다 (백테스트와 실제 답이 «같은 함수» 를 쓴다).
 * @returns {'BUY_NOW'|'WAIT'|'NEUTRAL'}
 */
function coreAction(fc, pos, current) {
  if (!fc || fc.method !== 'empirical-analog') return 'NEUTRAL';
  const p5 = fc.dropProbability.pct5;
  const saving = (current - fc.expectedMin.p50) / current;
  if (p5 >= WAIT_MIN_PROB && saving >= WAIT_MIN_SAVING) return 'WAIT';
  if (pos != null && pos <= BUY_MAX_PCT && p5 < BUY_MAX_PROB) return 'BUY_NOW';
  return 'NEUTRAL';
}

/* ================================================================== *
 *  백테스트 — 이 상품의 과거 기록으로 한 walk-forward 검증
 * ================================================================== */

/**
 * 과거의 각 날 t 에 서서, 그날까지 «완전히 관측된» 표본만으로 예측하고,
 * 그 뒤 실제로 일어난 일과 맞춰 본다.
 *
 * 누설 방지: 표본 s 는 그 뒤 H일이 t 이전에 다 끝나야(d_s + H ≤ d_t) 쓴다.
 * 가격 위치(pos)도 그날까지의 관측만으로 계산돼 있다 (positionsOf).
 *
 * 절약액의 가정은 낙관하지 않는다. «기다려라» 를 따른 사람은 예측 중앙값(p50)을
 * 목표가로 걸어 두고(② 대기실이 하는 일), 창 안에 그 값에 닿으면 그 값에 사고,
 * 끝내 안 닿으면 창의 마지막 날 가격에 산다. 그래서 절약은 음수일 수 있다.
 *
 * @returns {{summary:object, trace:object[]}}
 */
function backtestOf(pts, positions, futures, H) {
  const trace = [];
  for (let t = 0; t < pts.length; t++) {
    const ft = futures[t];
    if (!ft.complete) continue;
    const samples = [];
    for (let s = 0; s < t; s++) {
      if (!futures[s].complete || pts[s].d + H > pts[t].d) continue;
      samples.push({ ratio: futures[s].ratio, pos: positions[s] });
    }
    const current = pts[t].price;
    const fc = empirical(samples, positions[t], current);
    if (!fc) continue;
    const base = samples.filter(s => s.ratio <= 1 - DROP_LEVELS.pct5 + 1e-9).length / samples.length;
    const actual = ft.ratio <= 1 - DROP_LEVELS.pct5 + 1e-9 ? 1 : 0;
    const action = coreAction(fc, positions[t], current);
    let saving = null;
    if (action === 'WAIT') {
      const target = fc.expectedMin.p50;
      const paid = ft.min <= target ? target : ft.endPrice;
      saving = (current - paid) / current;
    }
    trace.push({
      date: pts[t].date, current, prob: fc.dropProbability.pct5, base, actual,
      band: [fc.expectedMin.p10, fc.expectedMin.p90], realizedMin: ft.min,
      action, saving,
      hit: action === 'WAIT' ? ft.ratio <= 1 - WAIT_MIN_SAVING + 1e-9
        : action === 'BUY_NOW' ? ft.ratio > 1 - WAIT_MIN_SAVING : null
    });
  }

  const n = trace.length;
  if (n < MIN_BACKTEST) {
    return {
      trace,
      summary: {
        horizonDays: H, samples: n, brier: null, brierBaseline: null, skill: null,
        bandCoverage: null, decisions: 0, decisionHitRate: null, avgSavingPct: null,
        verdict: 'insufficient',
        note: `검증할 수 있는 과거 날이 ${n}일뿐이라(최소 ${MIN_BACKTEST}일) 정확도를 말할 수 없어요.`
      }
    };
  }

  const brier = trace.reduce((s, r) => s + (r.prob - r.actual) ** 2, 0) / n;
  const brierBaseline = trace.reduce((s, r) => s + (r.base - r.actual) ** 2, 0) / n;
  const skill = brierBaseline > 1e-9 ? 1 - brier / brierBaseline : null;
  const covered = trace.filter(r => r.realizedMin >= r.band[0] && r.realizedMin <= r.band[1]).length;
  const decided = trace.filter(r => r.hit !== null);
  const hits = decided.filter(r => r.hit).length;
  const waits = trace.filter(r => r.saving !== null);
  const hitRate = decided.length ? hits / decided.length : null;
  const avgSaving = waits.length ? waits.reduce((s, r) => s + r.saving, 0) / waits.length : null;

  const probOk = (skill != null && skill >= MIN_SKILL)
    || (brier <= ABS_BRIER_OK && (skill == null || skill >= MIN_SKILL_WHEN_ACCURATE));
  const decisionsOk = decided.length < MIN_DECISIONS || hitRate >= MIN_HIT_RATE;
  const verdict = probOk && decisionsOk ? 'reliable' : 'weak';

  return {
    trace,
    summary: {
      horizonDays: H,
      samples: n,
      brier: Math.round(brier * 1000) / 1000,
      brierBaseline: Math.round(brierBaseline * 1000) / 1000,
      skill: skill == null ? null : Math.round(skill * 1000) / 1000,
      bandCoverage: round2(covered / n),
      decisions: decided.length,
      decisionHitRate: hitRate == null ? null : round2(hitRate),
      avgSavingPct: avgSaving == null ? null : Math.round(avgSaving * 1000) / 10,
      verdict,
      note: verdict === 'reliable'
        ? `이 상품의 과거 ${n}일에 같은 방법을 적용했을 때 기본값(평소 하락 빈도)보다 잘 맞았어요.`
        : `이 상품의 과거 ${n}일에 같은 방법을 적용했을 때 기본값보다 낫다고 보기 어려웠어요.`
    }
  };
}

/* ================================================================== *
 *  권고 · 불확실성
 * ================================================================== */

/**
 * 규칙 행동을 최종 권고로 다듬는다 — 판정 엔진과의 모순, 백테스트 결과를 반영한다.
 */
function reconcile(action, ctx) {
  const notes = [];
  let out = action;
  if (out === 'BUY_NOW' && ctx.dealVerdict && ['WAIT', 'DONT_BUY'].indexOf(ctx.dealVerdict) > -1) {
    out = 'NEUTRAL';
    notes.push('가격 판정 엔진은 지금 가격을 비싼 편으로 봐서, 지금 사라고 권하지 않아요.');
  }
  if ((out === 'WAIT' || out === 'BUY_NOW') && ctx.backtest && ctx.backtest.verdict === 'weak') {
    out = 'NEUTRAL';
    notes.push('이 상품의 과거 기록으로 검증했을 때 예측이 기본값보다 낫지 않아서 행동을 권하지 않아요.');
  }
  /*
   * 반대 방향은 막지 않고 밝힌다. 판정 엔진이 «싼 편» 이라도 계속 내려가는 중이면
   * 기다리는 편이 이득일 수 있다 — 두 말이 모순처럼 보이지 않게 이유를 붙인다.
   */
  if (out === 'WAIT' && ctx.dealVerdict && ['BUY', 'GOOD_BUY'].indexOf(ctx.dealVerdict) > -1) {
    notes.push('기록상 이미 싼 편이지만, 비슷한 과거 흐름에서는 더 내려간 경우가 많았어요.');
  }
  return { action: out, notes };
}

function uncertaintyOf(fc, backtest, current, extra) {
  const notes = (extra || []).slice();
  if (!fc) return { level: 'unknown', notes: notes.concat(['예측에 쓸 기록이 부족해요.']) };
  const width = current > 0 ? (fc.expectedMin.p90 - fc.expectedMin.p10) / current : 0;
  let level = 'low';
  const raise = l => { const order = ['low', 'medium', 'high']; if (order.indexOf(l) > order.indexOf(level)) level = l; };

  if (fc.method === 'volatility-band') {
    raise('high');
    notes.push('비슷한 과거 사례가 모자라 변동 폭만 추정했어요 — 방향은 알 수 없어요.');
  }
  if (fc.samples < 20) { raise('high'); notes.push(`예측에 쓴 과거 사례가 ${fc.samples}개뿐이에요.`); }
  else if (fc.samples < 40) raise('medium');
  if (!fc.conditioned && fc.method === 'empirical-analog') {
    raise('medium');
    notes.push('지금과 비슷한 가격 위치의 사례가 모자라 전체 기록의 평균적인 움직임으로 추정했어요.');
  }
  if (width > BAND_WIDE) { raise('high'); notes.push(`예상 최저가 범위가 현재가의 ${pctText(width)}만큼 넓어요.`); }
  else if (width > BAND_MEDIUM) raise('medium');
  if (!backtest || backtest.verdict === 'insufficient') { raise('medium'); notes.push('과거 기록으로 정확도를 검증할 만큼 기록이 쌓이지 않았어요.'); }
  else if (backtest.verdict === 'weak') { raise('high'); notes.push('이 상품에서는 과거에 이 방법이 잘 맞지 않았어요.'); }
  return { level, notes };
}

/* ================================================================== *
 *  진입점
 * ================================================================== */

function insufficient(base, reason, extraCaution) {
  return Object.assign(base, {
    forecast: {
      method: 'insufficient', horizonDays: base._H, currentPrice: base._current || null,
      dropProbability: null, expectedMin: null, samples: 0
    },
    recommendation: {
      action: 'INSUFFICIENT', label: ACTION_LABEL.INSUFFICIENT,
      reasons: [reason], cautions: extraCaution ? [extraCaution] : []
    },
    backtest: {
      horizonDays: base._H, samples: 0, brier: null, brierBaseline: null, skill: null, bandCoverage: null,
      decisions: 0, decisionHitRate: null, avgSavingPct: null, verdict: 'insufficient',
      note: '검증할 기록이 없어요.'
    },
    uncertainty: { level: 'unknown', notes: [reason] }
  });
}

function strip(o) { delete o._H; delete o._current; return o; }

/**
 * @param {{date:string, price:number}[]} points  날짜 오름차순 일별 관측 (_series.loadSeries().points)
 * @param {{today?:string, horizon?:number, product?:object}} [opts]
 * @returns {object} CONTRACTS.md §3-7 모양. 절대 throw 하지 않는다.
 */
function analyze(points, opts) {
  const o = opts || {};
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || '')) ? o.today : kstToday();
  const H = HORIZONS.indexOf(Number(o.horizon)) > -1 ? Number(o.horizon) : DEFAULT_HORIZON;
  let pts;
  try { pts = cleanPoints(points, today); } catch (e) { pts = []; }

  const current = pts.length ? pts[pts.length - 1].price : 0;
  const lastDate = pts.length ? pts[pts.length - 1].date : null;
  const staleDays = lastDate ? Math.max(0, dayNum(today) - dayNum(lastDate)) : null;
  const plain = pts.map(p => ({ date: p.date, price: p.price }));

  const base = {
    _H: H, _current: current,
    observations: pts.length,
    firstDate: pts.length ? pts[0].date : null,
    lastDate,
    staleDays,
    level: null,
    deal: null
  };

  try {
    if (pts.length) {
      base.level = fairness(plain, current, today);
      const d = dealOf(statsFrom(plain), current, today);
      base.deal = d ? { verdict: d.verdict, label: d.label } : null;
    }

    if (!pts.length) return strip(insufficient(base, '이 상품의 가격 기록이 아직 없어요.'));
    if (staleDays > MAX_STALE_DAYS) {
      return strip(insufficient(base, `마지막 가격 기록이 ${staleDays}일 전이라 지금 가격에 대해 말할 수 없어요.`));
    }
    const span = pts[pts.length - 1].d - pts[0].d;
    if (pts.length < MIN_OBS || span < MIN_SPAN_DAYS) {
      return strip(insufficient(base,
        `가격 기록이 ${pts.length}일치(${span}일에 걸쳐)뿐이에요 — 최소 ${MIN_OBS}일치, ${MIN_SPAN_DAYS}일 이상이 필요해요.`));
    }

    const positions = positionsOf(pts);
    const futures = futuresOf(pts, H);
    const samples = [];
    for (let s = 0; s < pts.length; s++) {
      if (futures[s].complete) samples.push({ ratio: futures[s].ratio, pos: positions[s] });
    }
    const posNow = positions[pts.length - 1];
    const fc = empirical(samples, posNow, current) || volatilityBand(pts, current, H);
    const bt = backtestOf(pts, positions, futures, H).summary;

    const forecast = fc
      ? Object.assign({ horizonDays: H, currentPrice: current }, fc)
      : { method: 'insufficient', horizonDays: H, currentPrice: current, dropProbability: null, expectedMin: null, samples: 0 };

    const reasons = [];
    const cautions = [];
    const lv = base.level;
    if (lv && lv.pctRank != null) {
      reasons.push(`지금 가격 ${won(current)}은 최근 ${lv.windowDays}일 관측 ${lv.obs}일 중 하위 ${lv.pctRank}%예요 (${lv.label}).`);
    } else if (lv && lv.level === 'flat') {
      reasons.push(`최근 ${lv.windowDays}일 가격 폭이 ${lv.spreadPct}%라 언제 사도 비슷한 가격이에요.`);
    }

    let action;
    if (fc && fc.method === 'empirical-analog') {
      const n5 = Math.round(fc.dropProbability.pct5 * fc.samples);
      reasons.push(`${fc.conditioned ? '지금과 비슷한 가격 위치였던' : '기록된'} 과거 ${fc.samples}일 중 ${n5}일은 `
        + `${H}일 안에 5% 이상 내려갔어요 (${pctText(fc.dropProbability.pct5)}).`);
      reasons.push(`${H}일 안 최저가는 ${won(fc.expectedMin.p10)} ~ ${won(fc.expectedMin.p90)} 사이일 가능성이 높고, `
        + `가운데 값은 ${won(fc.expectedMin.p50)}이에요.`);
      action = coreAction(fc, posNow, current);
    } else {
      action = 'NEUTRAL';
      if (fc) {
        reasons.push(`비슷한 과거 사례가 모자라 변동 폭만 추정했어요 — 하루 변동성 ${fc.dailyVolatility}%.`);
        cautions.push('이 추정은 가격이 오를지 내릴지 방향을 알려 주지 않아요.');
      }
    }
    if (lv && lv.level === 'flat' && action !== 'WAIT') {
      action = 'NEUTRAL';
    }

    const rc = reconcile(action, { dealVerdict: base.deal && base.deal.verdict, backtest: bt });
    rc.notes.forEach(n => cautions.push(n));
    if (staleDays > 1) cautions.push(`마지막 가격 확인이 ${staleDays}일 전이에요.`);

    const unc = uncertaintyOf(fc, bt, current);
    return strip(Object.assign(base, {
      forecast,
      recommendation: { action: rc.action, label: ACTION_LABEL[rc.action], reasons, cautions },
      backtest: bt,
      uncertainty: unc
    }));
  } catch (e) {
    // 계약상 throw 하지 않는다. 계산이 깨지면 모른다고 말한다.
    return strip(insufficient(base, '가격 기록을 분석하지 못했어요.', String(e && e.message || e).slice(0, 120)));
  }
}

module.exports = {
  analyze, HORIZONS, DEFAULT_HORIZON, ACTION_LABEL,
  MIN_OBS, MIN_SPAN_DAYS, MAX_STALE_DAYS, MIN_ANALOGS, MIN_SAMPLES, ANALOG_BAND, ABS_BRIER_OK,
  WAIT_MIN_PROB, WAIT_MIN_SAVING, BUY_MAX_PROB, BUY_MAX_PCT, MIN_BACKTEST, MIN_SKILL,
  _internal: {
    cleanPoints, positionsOf, futuresOf, empirical, volatilityBand, coreAction,
    backtestOf, reconcile, uncertaintyOf, quantile, normCdf, dayNum
  }
};
