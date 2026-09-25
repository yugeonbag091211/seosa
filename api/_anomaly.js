'use strict';
/*
 * ⑥ 가격 이상 패턴 — 한 상품(옵션)의 가격 기록에서 «이상한 움직임» 을 가려낸다.
 *
 * ── 왜 이 파일이 있는가 ────────────────────────────────────────────
 *
 * 가격 곡선에서 튀는 점 하나는 적어도 세 가지 중 하나다.
 *
 *   ① 진짜 가격 변동       판매자가 값을 바꿨다 (인상·인하·특가)
 *   ② 옵션이 바뀜          같은 product_id 아래 다른 옵션(vendor_item_id)의 값이 왔다
 *   ③ 수집 오류            값 자체가 틀렸다 (파싱 사고·API 필드 불일치·같은 날 충돌)
 *
 * 셋을 섞으면 사용자에게 거짓말을 하게 된다. 실제로 있었던 일들:
 *   · 15,900원 이어폰의 27일 기록 중 이틀이 242,100 / 222,390원이었다 — 옵션이 바뀐
 *     것이었는데 평균·최고가가 통째로 오염돼 "더 내려갈 여지가 있다" 가 붙었다
 *     (_deal.OUTLIER_RATIO 주석).
 *   · 같은 product_id 가 하루 만에 34,500 → 1,528,000 (44배) 로 튀었다
 *     (_price.SUSPECT_RATIO 주석).
 *   · API productPrice 22,320원이 하루만 관측됐는데 "역대 최저 · 지금 사도 좋다" 가
 *     나갔다. 상품 페이지 값은 26,900원이었다 (_pricestat.LOW_CONFIRM_DAYS 주석).
 *
 * 그래서 이 모듈의 핵심은 «탐지» 가 아니라 «구분» 이다.
 *   · OPTION_CHANGE    는 옵션 식별자가 바뀐 «사실» 로만 판정한다. 가격 크기로 추측하지 않는다.
 *   · COLLECTION_ERROR 는 값이 범위 밖이거나, 같은 날 두 배 넘게 충돌하거나, 하루만 크게
 *                      튀었다가 바로 제자리로 돌아온 경우다. 이 점들은 분포에서 뺀다.
 *   · SPIKE / CRASH    는 위 둘을 걷어낸 «이 옵션» 의 계열에서만 본다. 두 번 연속 같은
 *                      수준이면 확정(confirmed) — 확정된 영구 인하는 수집 오류가 아니라
 *                      진짜 가격 인하다.
 *
 * ── 지키는 규칙 ────────────────────────────────────────────────────
 *
 * ★ 순수 함수. DB·네트워크·시계(Date.now)를 쓰지 않는다. 오늘은 호출부가 넘긴다.
 *   같은 입력이면 언제나 같은 출력이다 — digest 로 누구나 다시 계산할 수 있어야 한다.
 * ★ 절대 throw 하지 않는다 (docs/seosa2/CONTRACTS.md §3-7). 입력이 모자라면
 *   INSUFFICIENT 를 담은 같은 모양을 돌려준다.
 * ★ 규칙을 새로 만들지 않는 곳은 기존 값을 그대로 쓴다.
 *     값 범위        _price.isSanePrice / MAX_PRICE
 *     옵션 가르기    _price.sameVendorRows ('' · '__LEGACY__' = 옵션 모름)
 *     날짜           _price.observedKstDate (recorded_at 을 KST 로)
 *     옵션 교체 배수 _price.OPTION_SWITCH_RATIO (2)
 *     급변 배수      _price.SUSPECT_RATIO (5), _deal.ANOMALY_DROP / ANOMALY_JUMP (0.5 / 2.0)
 *     기록 단절      _deal.GAP_WARN_DAYS (14)
 *     최소 관측      _pricestat.FAIR_MIN_OBS (5)
 *   _deal.anomalies() 가 "직전 기록의 절반 이하 → 같은 상품인지 확인" 이라고 말하는 값을
 *   여기서 "진짜 가격 인하" 라고 단정하지 않는다 — 같은 경계에서 같은 말을 붙인다.
 * ★ 모든 금액은 원 단위 정수, 모르는 값은 null.
 */

const crypto = require('crypto');
const {
  isSanePrice, MAX_PRICE, SUSPECT_RATIO, OPTION_SWITCH_RATIO,
  observedKstDate, sameVendorRows
} = require('./_price');
const { ANOMALY_DROP, ANOMALY_JUMP, GAP_WARN_DAYS } = require('./_deal');
const { spanDays, FAIR_MIN_OBS } = require('./_pricestat');

/* ==================================================================
 *  기준값 — 전부 이름을 붙이고 이유를 적는다
 * ================================================================== */

/**
 * 판단에 필요한 최소 유효 관측 일수. _pricestat.FAIR_MIN_OBS(5) 와 같은 값이다.
 * 같은 상품에 대해 "위치" 는 말하면서 "이상 여부" 는 모른다고 하거나, 그 반대가 되면 안 된다.
 */
const MIN_OBS = FAIR_MIN_OBS;

/* ── 급등·급락 (레벨 이동) ───────────────────────────────────────── */

/** 평소 수준 = 직전 7개 관측의 중앙값. 하루 한 번 수집하므로 대략 일주일이다. */
const SHIFT_WINDOW = 7;
/** 비교 대상이 이보다 적으면 «평소» 를 말할 수 없다. */
const SHIFT_MIN_BASE = 3;
/**
 * 평소 수준 대비 ±15% 이상이어야 급등·급락이다.
 * 5% 는 매일 생기는 쿠폰·재고 흔들림이고(_deal.PCTL_MIN_SPREAD), 10% 는 뻥튀기 탐지의
 * 문턱이다(FAKE_RISE_PCT). 급변은 그보다 한 단계 커야 «사건» 이라 부를 만하다.
 */
const SHIFT_PCT = 0.15;
/**
 * robust z 3.5 — Iglewicz & Hoaglin 의 modified z-score 기준(3.5 를 넘으면 이상치).
 * 원래 출렁이던 상품의 15% 는 흔한 일이다. 금액 문턱과 z 를 «둘 다» 넘어야 한다.
 */
const SHIFT_Z = 3.5;
/** MAD → 표준편차 환산 계수 (정규분포 일관성). */
const MAD_K = 1.4826;
/**
 * 평균절대편차 → 표준편차 환산 계수 (√(π/2)).
 *
 * ★ MAD 만 쓰면 안 되는 이유: 가격은 한 값에 오래 머문다. 창 7개 중 4개 이상이 같은
 *   값이면 MAD 가 0 이 되고, 10,000 ↔ 12,000 을 규칙적으로 오가는 상품의 매 등락이
 *   «10 시그마 사건» 이 된다. 평균절대편차는 절반 이상이 같은 값이어도 0 이 되지
 *   않는다. 둘 중 큰 쪽을 척도로 쓴다.
 */
const MEANAD_K = 1.2533;
/**
 * 척도 하한 = 중앙값의 1%. 몇 주째 같은 값인 상품은 MAD·평균절대편차가 모두 0 이라
 * 1원만 움직여도 z 가 무한대가 된다. 1% 아래 움직임은 «움직임» 으로 세지 않는다.
 */
const SCALE_FLOOR = 0.01;
/**
 * 같은 수준으로 보는 폭 ±5%. 새 가격이 «유지됐는가», 튄 값이 «제자리로 돌아왔는가»
 * 를 볼 때 쓴다. 쿠폰·반올림 차이로 생기는 몇 % 흔들림을 새 사건으로 세지 않는다.
 */
const LEVEL_TOL = 0.05;
/**
 * 확정에 필요한 연속 관측 수. _pricestat.LOW_CONFIRM_DAYS(2) 와 같은 이유다 —
 * 한 번 본 값은 가설이고 다시 보면 사실이다.
 */
const CONFIRM_OBS = 2;

/* ── 수집 오류 ───────────────────────────────────────────────────── */

/**
 * 같은 날 같은 옵션의 두 관측이 이 배수 이상 벌어지면 둘 중 하나는 틀린 값이다.
 * _price.OPTION_SWITCH_RATIO · _deal.ANOMALY_JUMP 와 같은 2배. 하루 안에 판매자가 값을
 * 두 배로 바꾸는 일은 없고, 있더라도 우리가 그중 어느 쪽이 «그날의 값» 인지 모른다.
 */
const SAME_DAY_CONFLICT_RATIO = OPTION_SWITCH_RATIO;
/**
 * 하루 튐 — 양쪽 이웃 모두에서 40% 이상 벗어났다가 다음 관측에서 제자리로 돌아오면
 * 수집 오류로 본다. 쿠팡의 하루 특가는 −30% 안팎이 대부분이고, _deal 이 «같은 상품인지
 * 확인» 을 붙이는 50%(ANOMALY_DROP) 보다는 한 단계 낮게 잡았다. 돌아오지 않으면
 * (= 다음 관측도 같은 수준이면) 이 규칙에 걸리지 않고 확정된 급락이 된다.
 */
const BLIP_MIN_DEV = 0.40;
/**
 * 하루 튐의 두 번째 길 — 이웃들의 흔들림 대비 5 시그마 이상(robust z) 이면서 25% 이상.
 * 평소 1% 도 안 움직이던 상품이 하루만 25~40% 벗어났다가 곧장 돌아왔다면 판매자의
 * 가격이 아니라 값이 잘못 들어온 쪽일 가능성이 크다 (22,320 ↔ 26,900 사례).
 * 금액 문턱(25%)을 함께 두는 이유: 평평한 상품에서는 z 가 쉽게 커져서 z 만 보면
 * 짧은 특가(−15% 하루)까지 수집 오류가 된다. 그런 값은 «확인되지 않은 급락» 으로 남긴다.
 */
const BLIP_Z = 5;
const BLIP_Z_MIN_DEV = 0.25;
/** 하루 튐 판정에 쓰는 이웃 수 (앞뒤 각각). */
const BLIP_NEIGHBOURS = 5;
/** «직전 수준» = 튄 점 앞 최대 3개 관측의 중앙값. 하나만 보면 그 하나가 흔들린 값일 수 있다. */
const BLIP_PRE_OBS = 3;
/** 이웃이 이보다 멀면 «하루 튐» 이라 말할 수 없다. _deal.GAP_WARN_DAYS 와 같은 값. */
const BLIP_MAX_GAP_DAYS = GAP_WARN_DAYS;
/**
 * 짧은 이탈 — 2~3일 연속 직전 수준의 5배(_price.SUSPECT_RATIO) 넘게 벗어났다가 돌아오면
 * 수집 오류로 본다. 15,900 → 242,100 · 222,390 → 15,900 (옵션 표시 없는 옛 기록) 이
 * 정확히 이 모양이었다. 5배는 _price 가 «실제 특가는 넘지 않는 선» 으로 정한 값이다.
 */
const EXCURSION_MAX_RUN = 3;

/* ── 뻥튀기 후 할인 ──────────────────────────────────────────────── */

/**
 * 올린 날부터 «할인» 한 날까지 3주 안. _price.SUSPECT_WINDOW_DAYS(21) 와 같은 길이다.
 * 석 달 올려 둔 값을 내리는 것은 «할인 연출» 이 아니라 가격 정책이 두 번 바뀐 것이다.
 */
const FAKE_WINDOW_DAYS = 21;
/** 기준가 = 올리기 직전 최대 7개 관측의 중앙값 (SHIFT_WINDOW 와 같은 이유). */
const FAKE_BASE_WINDOW = 7;
/** 기준가를 말하려면 최소 5개 관측 (MIN_OBS). */
const FAKE_BASE_MIN = MIN_OBS;
/**
 * 기준 구간이 «안정적» 이어야 한다 — 기준 구간 최고가가 기준가 +5% 이내.
 * 원래 오르내리던 상품(SAWTOOTH)의 매 등락을 «뻥튀기» 로 부르지 않기 위해서다.
 * 앞선 일주일에 이미 오른 날이 있었다면 이번 상승은 새 연출이 아니라 원래 흔들림이다.
 */
const FAKE_BASE_TOL = 0.05;
/** 기준가보다 10% 이상 올라야 «올렸다» 고 본다. 5% 안쪽은 평소 흔들림이다. */
const FAKE_RISE_PCT = 0.10;
/**
 * 올린 값이 최소 하루(첫 관측과 마지막 관측 사이 1일 이상) 유지돼야 한다.
 * 하루 한 번 수집이므로 = 올린 값을 두 번 이상 봤다. 한 번 본 값은 SPIKE(미확정) 몫이다.
 */
const FAKE_MIN_UP_DAYS = 1;
/**
 * «할인» 뒤 가격이 기준가 −3% 보다 낮으면 진짜 할인이다 (올리기 전보다 싸졌다).
 * 기준가 ±3% 안이거나 그보다 높으면 할인은 올린 값을 되돌렸을 뿐이다.
 */
const FAKE_AFTER_TOL = 0.03;
/** 올린 값에서 5% 이상 내려야 «할인» 처럼 보인다. 그보다 작으면 할인이라 부르지 않는다. */
const FAKE_MIN_DROP = 0.05;

/* ── 주기적 등락 ─────────────────────────────────────────────────── */

/** 최근 30일을 본다. _pricestat.AVG_DAYS 와 같은 창이다. */
const SAW_WINDOW_DAYS = 30;
/** 8% 이상 오르내려야 한 번의 등락으로 센다 (±3% 잡음이 만드는 최대폭 약 6% 의 바깥). */
const SAW_AMPLITUDE = 0.08;
/** 오르고 내리기를 3번 이상. 두 번은 우연일 수 있고, 세 번이면 «패턴» 이다. */
const SAW_MIN_CYCLES = 3;

/* ── 정가 부풀리기 ───────────────────────────────────────────────── */

/**
 * 표시 정가 대비 30% 이상 «할인» 인데 지금 값이 관측 중앙값 이상이면 할인이 아니다.
 * 30% 는 쇼핑몰이 "특가" 배지를 붙이기 시작하는 흔한 선이다.
 */
const REF_DISCOUNT_MIN = 0.30;
/** 표시 정가가 SEOSA 가 본 최고가의 1.3배를 넘으면 그 정가로 판 적이 없다고 본다. */
const REF_OVER_MAX = 1.3;

/* ── 요약 · 출력 ─────────────────────────────────────────────────── */

/** «최근» = 오늘 포함 7일 전까지. _deal.FRESHNESS 의 'fair'(7일 이하) 와 같은 경계. */
const RECENT_DAYS = 7;
/**
 * 같은 두 옵션 사이의 전환이 이 일수 안에 이어지면 한 사건(에피소드)으로 묶는다.
 * 수집은 하루 세 번(KST 01·03·06시)이라 번갈아 오는 옵션은 하루 안팎 간격으로 바뀐다.
 * 수집이 한두 번 빠져도 같은 에피소드로 보도록 3일.
 */
const OPTION_EPISODE_DAYS = 3;
/** 그래도 옵션 사건이 많으면 표가 수백 줄이 되지 않게 최근 것만 남긴다. */
const MAX_OPTION_EVENTS = 30;
/** 히스토그램 칸 수 상한. 칸 수는 Sturges(⌈log2 n⌉+1). */
const HIST_MAX_BINS = 12;

const KINDS = ['SPIKE', 'CRASH', 'FAKE_DISCOUNT', 'SAWTOOTH', 'OPTION_CHANGE', 'COLLECTION_ERROR', 'REFERENCE_INFLATION'];
const KIND_ORDER = KINDS.reduce((m, k, i) => { m[k] = i; return m; }, {});

const KIND_LABEL = {
  SPIKE: '급등',
  CRASH: '급락',
  FAKE_DISCOUNT: '올렸다가 할인',
  SAWTOOTH: '주기적 등락',
  OPTION_CHANGE: '옵션 변경',
  COLLECTION_ERROR: '수집 오류',
  REFERENCE_INFLATION: '정가 부풀리기'
};

const STATUS_LABEL = {
  NORMAL: '정상',
  WATCH: '지켜볼 필요',
  ANOMALOUS: '이상 패턴 감지',
  INSUFFICIENT: '판단 데이터 부족'
};

/**
 * digest 규칙. 화면·문서·테스트가 이 문장 하나를 보고 같은 값을 다시 계산할 수 있어야 한다.
 */
const CANONICAL = 'sha256( UTF-8( JSON.stringify( observations.map(o => [o.at, o.price, o.vendorItemId]) ) ) ) — '
  + 'observations 순서 그대로(recorded_at 오름차순, 같으면 id 오름차순), 공백 없음, 결과는 소문자 hex. '
  + '관측 행 전부(다른 옵션 포함)를 싣는다. / sha256 of the compact JSON array of [at, price, vendorItemId] '
  + 'per observation, in the listed order.';

/* ==================================================================
 *  작은 도구
 * ================================================================== */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function intOrNull(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function isRow(r) { return !!r && typeof r === 'object' && !Array.isArray(r); }

/** sameVendorRows 와 같은 방식으로 읽는다. */
function vidOf(r) {
  return String((r && (r.vendor_item_id || r.vendorItemId)) || '').trim();
}

/** '' · '__LEGACY__' 는 «옵션을 모른다» 는 뜻이지 다른 옵션이라는 뜻이 아니다. */
function isKnownVid(v) { return !!v && v !== '__LEGACY__'; }

function atOf(r) { return String((r && (r.recorded_at || r.recorded_date)) || ''); }

function dateOf(r) {
  try {
    const d = observedKstDate(r);
    return DATE_RE.test(d) ? d : '';
  } catch (_) {
    return '';   // 범위 밖 시각이면 toISOString 이 RangeError 를 던진다
  }
}

/** _series.byTimeAsc 와 같은 순서 (recorded_at → recorded_date → id). */
function byTimeAsc(a, b) {
  const ta = atOf(a);
  const tb = atOf(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
}

function rowKey(r) {
  return [r && r.id, atOf(r), r && r.price, vidOf(r)].map(v => String(v == null ? '' : v)).join('|');
}

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 선형 보간 분위수 (numpy 기본값 · Excel PERCENTILE.INC 와 같다). sorted 는 오름차순. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** 중앙값 절대 편차 (배율 없음). */
function madOf(values, med) {
  const m = med == null ? median(values) : med;
  if (m == null) return null;
  return median(values.map(v => Math.abs(v - m)));
}

/**
 * 흔들림의 척도 (표준편차 단위). MAD 와 평균절대편차 중 큰 쪽, 하한은 중앙값의 1%.
 * 이유는 MEANAD_K · SCALE_FLOOR 주석.
 */
function robustScale(values, med) {
  const m = med == null ? median(values) : med;
  if (m == null || !values.length) return 1;
  const dev = values.map(v => Math.abs(v - m));
  const mad = median(dev);
  const meanAd = dev.reduce((s, v) => s + v, 0) / dev.length;
  return Math.max(MAD_K * mad, MEANAD_K * meanAd, SCALE_FLOOR * Math.abs(m), 1);
}

function robustZ(value, values) {
  const m = median(values);
  if (m == null) return 0;
  return Math.abs(value - m) / robustScale(values, m);
}

function pct1(x) { return Math.round(x * 1000) / 10; }
function changePct(price, ref) {
  return (price > 0 && ref > 0) ? pct1((price - ref) / ref) : null;
}
function won(n) { return Math.round(Number(n) || 0).toLocaleString('ko-KR'); }

function addDays(date, n) {
  const p = String(date || '').split('-');
  if (p.length !== 3) return '';
  const t = Date.UTC(+p[0], +p[1] - 1, +p[2] + n);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

/**
 * 꺾은선 필터(zigzag). 직전 극값에서 amp 이상 반대로 움직여야 한 번의 등락으로 센다.
 * 오를 때는 저점×(1+amp) 이상, 내릴 때는 고점÷(1+amp) 이하 — 로그 기준으로 대칭이다.
 *
 * @returns {{swings:{dir:number, from:number, to:number}[], peaks:number[], troughs:number[]}}
 */
function zigzag(prices, amp) {
  const up = 1 + amp;
  const swings = [], peaks = [], troughs = [];
  if (!prices || prices.length < 2) return { swings, peaks, troughs };
  let dir = 0, lo = prices[0], hi = prices[0], ext = prices[0];
  for (let i = 1; i < prices.length; i++) {
    const p = prices[i];
    if (dir === 0) {
      if (p >= lo * up) { dir = 1; troughs.push(lo); swings.push({ dir: 1, from: lo, to: p }); ext = p; }
      else if (p * up <= hi) { dir = -1; peaks.push(hi); swings.push({ dir: -1, from: hi, to: p }); ext = p; }
      else { if (p < lo) lo = p; if (p > hi) hi = p; }
    } else if (dir === 1) {
      if (p > ext) { ext = p; swings[swings.length - 1].to = p; }
      else if (p * up <= ext) { peaks.push(ext); swings.push({ dir: -1, from: ext, to: p }); dir = -1; ext = p; }
    } else {
      if (p < ext) { ext = p; swings[swings.length - 1].to = p; }
      else if (p >= ext * up) { troughs.push(ext); swings.push({ dir: 1, from: ext, to: p }); dir = 1; ext = p; }
    }
  }
  return { swings, peaks, troughs };
}

/** history.digest — CANONICAL 규칙 그대로. */
function digestOf(observations) {
  const payload = JSON.stringify((observations || []).map(o => [o.at, o.price, o.vendorItemId]));
  return 'sha256:' + crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/* ==================================================================
 *  분포
 * ================================================================== */

/**
 * 유효 일별 가격의 분포. count 는 하루 한 점(최저가)으로 접은 «일수»,
 * excluded 는 수집 오류로 뺀 원본 «관측(행)» 수다 — 단위가 다르다는 것을 숨기지 않는다.
 */
function distributionOf(prices, excluded) {
  if (!prices.length) return null;
  const s = prices.slice().sort((a, b) => a - b);
  const n = s.length;
  const med = quantile(s, 0.5);
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const r = v => Math.round(v);

  // Sturges 칸 수. 칸 폭은 정수 원, 칸은 [from, to] 양끝 포함, 마지막 칸의 to = max.
  const min = s[0], max = s[n - 1];
  const bins = max === min ? 1 : Math.min(HIST_MAX_BINS, Math.ceil(Math.log2(n)) + 1);
  const width = Math.max(1, Math.ceil((max - min + 1) / bins));
  const histogram = [];
  for (let k = 0; k < bins; k++) {
    const from = min + k * width;
    if (from > max) break;
    const to = k === bins - 1 ? max : Math.min(max, from + width - 1);
    histogram.push({ from, to, count: 0 });
  }
  s.forEach(v => {
    const k = Math.min(histogram.length - 1, Math.floor((v - min) / width));
    histogram[k].count++;
  });

  return {
    count: n,
    min,
    p5: r(quantile(s, 0.05)),
    p25: r(quantile(s, 0.25)),
    median: r(med),
    p75: r(quantile(s, 0.75)),
    p95: r(quantile(s, 0.95)),
    max,
    mean: r(mean),
    mad: r(madOf(s, med)),
    excluded,
    histogram
  };
}

/* ==================================================================
 *  탐지기 — 전부 «이 옵션» 의 정리된 일별 계열 위에서 돈다 (OPTION_CHANGE 만 원본 전체)
 * ================================================================== */

/**
 * 옵션 변경 — 원본 행(옵션 무관)에서 알려진 옵션 식별자가 바뀐 곳.
 * 옵션을 모르는 행('' · '__LEGACY__')은 건너뛴다: A → (모름) → B 는 A → B 다.
 *
 * ★ 같은 두 옵션이 며칠 안에 번갈아 오면 한 사건으로 묶는다. 운영에서 같은 product_id 가
 *   "블루 그레이-GY" 와 "펄 화이트-WT" 로 번갈아 온 적이 있다(_price.OPTION_SWITCH_RATIO 주석).
 *   전환마다 한 줄씩 내면 표가 같은 말로 가득 차고 counts 가 «30번 바뀌었다» 로 부풀려진다.
 *   묶은 사건은 첫 전환 날짜에 두고, 전환 횟수와 마지막 전환 날짜를 근거에 남긴다.
 */
function detectOptionChanges(obs, currentVid) {
  const episodes = [];
  let open = null;
  let prev = null;
  obs.forEach(o => {
    if (!isKnownVid(o.vendorItemId)) return;
    if (prev && prev.vendorItemId !== o.vendorItemId) {
      const pair = [prev.vendorItemId, o.vendorItemId].sort().join('|');
      const before = isSanePrice(prev.price) ? prev.price : null;
      const after = isSanePrice(o.price) ? o.price : null;
      const ratio = before && after ? Math.max(before, after) / Math.min(before, after) : null;
      const near = open && open.pair === pair && !!open.lastDate && !!o.date
        && spanDays(open.lastDate, o.date) <= OPTION_EPISODE_DAYS;
      if (near) {
        open.switches++;
        open.lastDate = o.date;
        if (ratio != null && (open.maxRatio == null || ratio > open.maxRatio)) open.maxRatio = ratio;
      } else {
        open = {
          pair, from: prev, to: o, before, after, ratio,
          maxRatio: ratio, switches: 1, lastDate: o.date
        };
        episodes.push(open);
      }
    }
    prev = o;
  });

  const out = episodes.map(ep => {
    const big = ep.maxRatio != null && ep.maxRatio >= OPTION_SWITCH_RATIO;
    const fromVid = ep.from.vendorItemId, toVid = ep.to.vendorItemId;
    const note = '판매 옵션이 바뀌었다 (' + fromVid + ' → ' + toVid + '). '
      + (ep.before && ep.after
        ? won(ep.before) + '원 → ' + won(ep.after) + '원은 가격 변동이 아니라 다른 옵션의 가격이다.'
        : '두 값은 서로 다른 옵션의 가격이라 견주지 않는다.')
      + (ep.switches > 1 ? ' ' + ep.lastDate + '까지 두 옵션이 ' + ep.switches + '번 번갈아 관측됐다.' : '')
      + (big ? ' 두 옵션 값이 두 배 넘게 달라 한 곡선으로 보면 급등·급락처럼 보인다.' : '')
      + ' 급등·급락은 이 옵션의 기록으로만 판정했다.';
    return {
      date: ep.to.date || null,
      kind: 'OPTION_CHANGE',
      severity: big ? 'warn' : 'info',
      price: ep.after,
      ref: ep.before,
      changePct: changePct(ep.after, ep.before),
      confirmed: true,
      note,
      evidence: {
        fromVendorItemId: fromVid,
        toVendorItemId: toVid,
        before: ep.before,
        after: ep.after,
        beforeAt: ep.from.at,
        afterAt: ep.to.at,
        ratio: ep.ratio == null ? null : Math.round(ep.ratio * 100) / 100,
        switches: ep.switches,
        lastSwitchDate: ep.lastDate || null,
        involvesThisOption: !!currentVid && (fromVid === currentVid || toVid === currentVid)
      }
    };
  });
  return out.length > MAX_OPTION_EVENTS ? out.slice(out.length - MAX_OPTION_EVENTS) : out;
}

/**
 * 수집 오류 (a)·(b) — 값 범위 밖, 같은 날 두 배 넘는 충돌.
 * sObs 의 error 필드를 채우고 사건을 돌려준다.
 */
function detectRowErrors(sObs) {
  const events = [];

  // (a) 값 범위 밖 (0원·음수·1억원 초과·숫자 아님). 날짜를 모르는 행도 여기서 뺀다.
  const insane = [];
  sObs.forEach(o => {
    if (!isSanePrice(o.price)) { o.error = 'insane'; insane.push(o); }
    else if (!o.date) { o.error = 'no_date'; insane.push(o); }
  });
  const byDateBad = new Map();
  insane.forEach(o => {
    const k = o.date || '';
    if (!byDateBad.has(k)) byDateBad.set(k, []);
    byDateBad.get(k).push(o);
  });
  byDateBad.forEach((list, date) => {
    const noDate = !date;
    events.push({
      date: date || null,
      kind: 'COLLECTION_ERROR',
      severity: 'warn',
      price: list[0].price,
      ref: null,
      changePct: null,
      confirmed: true,
      note: noDate
        ? '관측 시각을 알 수 없는 기록이 ' + list.length + '건 있어 수집 오류로 보고 분포에서 뺐다.'
        : '가격 값이 정상 범위(1원~' + won(MAX_PRICE) + '원)를 벗어났다. 수집 오류로 보고 분포에서 뺐다.',
      evidence: {
        reason: noDate ? 'no_date' : 'insane_price',
        values: list.slice(0, 5).map(o => o.price),
        count: list.length,
        maxPrice: MAX_PRICE
      }
    });
  });

  // (b) 같은 날 같은 옵션 두 값이 두 배 넘게 충돌
  const byDate = new Map();
  sObs.forEach(o => {
    if (o.error) return;
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date).push(o);
  });
  const dates = [...byDate.keys()].sort();
  const dayLow = dates.map(d => Math.min.apply(null, byDate.get(d).map(o => o.price)));

  dates.forEach((date, di) => {
    const list = byDate.get(date);
    if (list.length < 2) return;
    const prices = list.map(o => o.price);
    const lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
    if (hi / lo < SAME_DAY_CONFLICT_RATIO) return;

    // 어느 쪽이 그날의 값인가 — 앞뒤 다른 날들의 수준에 가까운 쪽을 남긴다.
    const around = dayLow.slice(Math.max(0, di - SHIFT_WINDOW), di)
      .concat(dayLow.slice(di + 1, di + 1 + SHIFT_WINDOW));
    const ref = around.length ? median(around) : null;
    let kept = null;
    list.forEach(o => {
      if (!kept) { kept = o; return; }
      if (ref) {
        const dk = Math.abs(Math.log(kept.price / ref)), dn = Math.abs(Math.log(o.price / ref));
        if (dn < dk || (dn === dk && o.price < kept.price)) kept = o;
      } else if (o.price < kept.price) {
        kept = o;   // 기준이 없으면 history.js 와 같이 그날 최저가를 남긴다
      }
    });
    const dropped = list.filter(o => o !== kept
      && Math.max(o.price, kept.price) / Math.min(o.price, kept.price) >= SAME_DAY_CONFLICT_RATIO);
    dropped.forEach(o => { o.error = 'same_day_conflict'; });
    if (!dropped.length) return;
    const worst = dropped.reduce((w, o) =>
      (Math.abs(Math.log(o.price / kept.price)) > Math.abs(Math.log(w.price / kept.price)) ? o : w), dropped[0]);
    events.push({
      date,
      kind: 'COLLECTION_ERROR',
      severity: 'warn',
      price: worst.price,
      ref: kept.price,
      changePct: changePct(worst.price, kept.price),
      confirmed: true,
      note: '같은 날 같은 옵션에서 ' + won(lo) + '원과 ' + won(hi) + '원이 함께 관측됐다(두 배 이상 차이). '
        + (ref ? '앞뒤 기록(' + won(ref) + '원)에 가까운 ' : '기준이 될 앞뒤 기록이 없어 낮은 쪽인 ')
        + won(kept.price) + '원만 남기고 나머지는 수집 오류로 보고 분포에서 뺐다.',
      evidence: {
        reason: 'same_day_conflict',
        prices: prices.slice().sort((a, b) => a - b),
        kept: kept.price,
        reference: ref == null ? null : Math.round(ref),
        ratio: Math.round(hi / lo * 100) / 100
      }
    });
  });

  return events;
}

/**
 * 수집 오류 (c) — 하루만 크게 튀었다가 다음 관측에서 제자리로 돌아온 점,
 * 그리고 SUSPECT_RATIO 넘게 2~3일 벗어났다가 돌아온 짧은 이탈.
 *
 * @param {{date,price}[]} daily  (a)(b) 를 걷어낸 일별 최저가
 * @returns {{errDays:Set<number>, events:object[]}}
 */
function detectBlips(daily) {
  const errDays = new Set();
  const events = [];
  const n = daily.length;
  if (n < MIN_OBS) return { errDays, events };

  const cleanBefore = (i, k) => {
    const out = [];
    for (let j = i - 1; j >= 0 && out.length < k; j--) if (!errDays.has(j)) out.push(daily[j]);
    return out.reverse();
  };

  for (let i = 1; i < n - 1; i++) {
    const before = cleanBefore(i, Math.max(BLIP_NEIGHBOURS, BLIP_PRE_OBS));
    if (!before.length) continue;
    const prev = before[before.length - 1];
    const cur = daily[i];
    const pre = median(before.slice(-BLIP_PRE_OBS).map(p => p.price));

    // ── 하루 튐 ──
    const next = daily[i + 1];
    const gapOk = spanDays(prev.date, cur.date) <= BLIP_MAX_GAP_DAYS && spanDays(cur.date, next.date) <= BLIP_MAX_GAP_DAYS;
    if (gapOk) {
      const dev = Math.min(Math.abs(cur.price / prev.price - 1), Math.abs(cur.price / next.price - 1));
      const reverted = Math.abs(next.price / pre - 1) <= LEVEL_TOL;
      const nb = before.slice(-BLIP_NEIGHBOURS).map(p => p.price)
        .concat(daily.slice(i + 1, i + 1 + BLIP_NEIGHBOURS).map(p => p.price));
      const z = robustZ(cur.price, nb);
      const strong = dev >= BLIP_MIN_DEV || (z >= BLIP_Z && dev >= BLIP_Z_MIN_DEV);
      if (strong && reverted) {
        errDays.add(i);
        const drop = cur.price < pre;
        const extreme = drop ? cur.price <= pre * ANOMALY_DROP : cur.price >= pre * ANOMALY_JUMP;
        events.push({
          date: cur.date,
          kind: 'COLLECTION_ERROR',
          severity: 'warn',
          price: cur.price,
          ref: Math.round(pre),
          changePct: changePct(cur.price, pre),
          confirmed: true,
          note: '하루만 ' + Math.abs(pct1(cur.price / pre - 1)) + '% ' + (drop ? '낮게' : '높게')
            + ' 관측됐다가 다음 관측(' + next.date + ')에서 원래 가격(' + won(pre) + '원 부근)으로 돌아왔다. '
            + (extreme ? '직전 수준의 ' + (drop ? '절반 이하' : '두 배 이상') + '라 다른 옵션·구성이 잠깐 잡혔을 수 있다. ' : '')
            + '수집 오류로 보고 분포에서 뺐다.',
          evidence: {
            reason: 'one_day_blip',
            before: prev.price, beforeDate: prev.date,
            after: next.price, afterDate: next.date,
            level: Math.round(pre),
            deviationPct: pct1(dev),
            z: Math.round(z * 10) / 10
          }
        });
        continue;
      }
    }

    // ── 짧은 이탈 (2~3일, SUSPECT_RATIO 이상) ──
    for (let k = 2; k <= EXCURSION_MAX_RUN; k++) {
      if (i + k >= n) break;
      const run = daily.slice(i, i + k);
      const after = daily[i + k];
      const up = run.every(p => p.price >= pre * SUSPECT_RATIO);
      const down = run.every(p => p.price * SUSPECT_RATIO <= pre);
      if (!up && !down) break;   // 첫 점부터 5배가 아니면 더 길게 봐도 소용없다
      if (Math.abs(after.price / pre - 1) > LEVEL_TOL) continue;
      if (spanDays(prev.date, run[0].date) > BLIP_MAX_GAP_DAYS
        || spanDays(run[k - 1].date, after.date) > BLIP_MAX_GAP_DAYS) break;
      for (let j = i; j < i + k; j++) errDays.add(j);
      events.push({
        date: run[0].date,
        kind: 'COLLECTION_ERROR',
        severity: 'warn',
        price: run[0].price,
        ref: Math.round(pre),
        changePct: changePct(run[0].price, pre),
        confirmed: true,
        note: k + '일 동안 평소 가격(' + won(pre) + '원)의 ' + SUSPECT_RATIO + '배 넘게 벗어났다가 '
          + after.date + '에 원래 가격으로 돌아왔다. 실제 특가·인상은 이 폭을 넘지 않아 '
          + '다른 옵션이나 잘못된 값이 섞인 것으로 보고 분포에서 뺐다.',
        evidence: {
          reason: 'short_excursion',
          dates: run.map(p => p.date),
          prices: run.map(p => p.price),
          level: Math.round(pre),
          after: after.price, afterDate: after.date,
          ratioLimit: SUSPECT_RATIO
        }
      });
      i += k - 1;
      break;
    }
  }
  return { errDays, events };
}

/**
 * 급등·급락 — 직전 SHIFT_WINDOW 관측의 중앙값 대비 ±SHIFT_PCT 이고 robust z ≥ SHIFT_Z.
 * 같은 수준이 이어지는 관측은 같은 사건이다 (하나의 인하를 사흘 연속 «급락» 으로 세지 않는다).
 */
function detectShifts(clean) {
  const events = [];
  const n = clean.length;
  let prevEv = null;
  let i = SHIFT_MIN_BASE;
  while (i < n) {
    const baseRows = clean.slice(Math.max(0, i - SHIFT_WINDOW), i);
    const base = baseRows.map(p => p.price);
    const med = median(base);
    const p = clean[i].price;
    const change = (p - med) / med;
    const z = Math.abs(p - med) / robustScale(base, med);
    if (Math.abs(change) < SHIFT_PCT || z < SHIFT_Z) { i++; continue; }

    let j = i + 1;
    while (j < n && Math.abs(clean[j].price / p - 1) <= LEVEL_TOL) j++;
    const runObs = j - i;
    const latestOnly = i === n - 1;
    const confirmed = runObs >= CONFIRM_OBS;
    const reverted = j < n && Math.abs(clean[j].price / med - 1) <= LEVEL_TOL;
    const up = change > 0;
    const kind = up ? 'SPIKE' : 'CRASH';
    const extreme = up ? p >= med * ANOMALY_JUMP : p <= med * ANOMALY_DROP;
    const gapDays = spanDays(baseRows[baseRows.length - 1].date, clean[i].date);
    const verb = up ? '오른' : '내린';
    /*
     * 며칠 이어진 특가가 끝나 원래 값으로 돌아오면, 그 사이 직전 일주일의 중앙값이 특가
     * 가격으로 바뀌어 있어서 «급등» 으로 잡힌다. 사실이지만 «가격 인상» 이라고 부르면
     * 틀린 말이다 — 직전 사건 이전 수준으로의 복귀라고 말한다. (사건을 숨기지는 않는다:
     * 복귀도 최근 7일 안의 확정된 움직임이다.)
     */
    const back = !!prevEv && prevEv.kind !== (up ? 'SPIKE' : 'CRASH')
      && Math.abs(p / prevEv.ref - 1) <= LEVEL_TOL;

    let severity, note;
    const head = '평소 가격(직전 ' + base.length + '회 중앙값 ' + won(med) + '원)보다 '
      + Math.abs(pct1(change)) + '% ' + verb + ' ' + won(p) + '원';
    if (latestOnly) {
      severity = 'warn';
      note = head + '이 가장 최근에 한 번 관측됐다. 아직 확인되지 않았다 — 다음 수집에서 같은 값이 다시 나와야 확정된다.'
        + (back ? ' ' + prevEv.date + ' 이전 가격으로 돌아온 값일 수 있다.' : '');
    } else if (confirmed) {
      severity = extreme && !back ? 'warn' : 'info';
      note = head + '이 ' + runObs + '번 연속 관측됐다. '
        + (back
          ? prevEv.date + '에 시작된 ' + (up ? '인하' : '인상') + '가 끝나고 그 전 가격(' + won(prevEv.ref) + '원)으로 돌아온 것이다.'
          : (up ? '실제 가격 인상으로 보인다.' : '수집 오류가 아니라 실제 가격 인하로 보인다.'))
        + (reverted ? ' 이후 ' + clean[j].date + '에 원래 수준으로 돌아왔다.' : '');
    } else {
      severity = 'info';
      note = head + '이 하루만 관측됐다. '
        + (reverted ? '다음 관측(' + clean[j].date + ')에서 원래 수준으로 돌아왔다. 짧은 특가였거나 일시적인 값일 수 있다.'
          : '같은 수준이 이어지지 않고 다음 관측에서 다시 움직였다.');
    }
    if (extreme && !back) {
      note += ' 직전 수준의 ' + (up ? '두 배 이상' : '절반 이하') + '라 옵션이나 구성이 바뀌었을 수 있어 같은 상품인지 확인이 필요하다.';
    }
    if (gapDays >= GAP_WARN_DAYS) {
      note += ' 직전 관측이 ' + gapDays + '일 전이라 그 사이 언제 바뀌었는지는 알 수 없다.';
    }

    events.push({
      date: clean[i].date,
      kind,
      severity,
      price: p,
      ref: Math.round(med),
      changePct: changePct(p, med),
      confirmed,
      note,
      evidence: {
        baseline: Math.round(med),
        window: base.length,
        z: Math.round(z * 10) / 10,
        runObs,
        lastDate: clean[j - 1].date,
        reverted,
        returnDate: reverted ? clean[j].date : null,
        latestOnly,
        gapDays,
        returnOf: back ? prevEv.date : null
      }
    });
    prevEv = events[events.length - 1];
    i = j;
  }
  return events;
}

/**
 * 뻥튀기 후 할인 — 안정적이던 값을 10% 이상 올려 하루 넘게 두었다가, 3주 안에
 * 원래 값(±3%) 또는 그보다 높은 값으로 «내렸다».
 */
function detectFakeDiscounts(clean) {
  const events = [];
  const n = clean.length;
  for (let r = FAKE_BASE_MIN; r < n; r++) {
    const baseRows = clean.slice(Math.max(0, r - FAKE_BASE_WINDOW), r);
    if (baseRows.length < FAKE_BASE_MIN) continue;
    const base = baseRows.map(p => p.price);
    const baseline = median(base);
    const riseLine = baseline * (1 + FAKE_RISE_PCT);
    if (clean[r].price < riseLine) continue;
    if (Math.max.apply(null, base) > baseline * (1 + FAKE_BASE_TOL)) continue;   // 기준 구간이 이미 출렁였다

    let e = r;
    while (e + 1 < n && clean[e + 1].price >= riseLine) e++;
    const d = e + 1;
    if (d >= n) break;                                            // 아직 올린 값 그대로다 — 할인이 없었다
    if (spanDays(clean[r].date, clean[e].date) < FAKE_MIN_UP_DAYS) continue;
    if (spanDays(clean[r].date, clean[d].date) > FAKE_WINDOW_DAYS) { r = e; continue; }

    const after = clean[d].price;
    const raisedPrices = clean.slice(r, e + 1).map(p => p.price);
    const raised = Math.round(median(raisedPrices));
    const raisedLast = clean[e].price;
    if (after < baseline * (1 - FAKE_AFTER_TOL)) { r = e; continue; }   // 올리기 전보다 싸졌다 — 진짜 할인
    if (after > raisedLast * (1 - FAKE_MIN_DROP)) { r = e; continue; }  // 할인이라 부를 만큼 내리지 않았다

    const discount = pct1((raisedLast - after) / raisedLast);
    const vsBase = pct1((after - baseline) / baseline);
    events.push({
      date: clean[d].date,
      kind: 'FAKE_DISCOUNT',
      severity: 'alert',
      price: after,
      ref: raisedLast,
      changePct: changePct(after, raisedLast),
      confirmed: true,
      note: clean[r].date + '에 ' + won(baseline) + '원이던 값을 ' + won(raised) + '원으로 올렸다가 '
        + clean[d].date + '에 ' + won(after) + '원으로 내렸다. ' + discount + '% 할인처럼 보이지만 '
        + (Math.abs(after / baseline - 1) <= FAKE_AFTER_TOL
          ? '최근에 올린 값을 되돌린 것일 뿐, 올리기 전 가격과 같다.'
          : '올리기 전 가격보다 오히려 ' + vsBase + '% 비싸다.'),
      evidence: {
        baseline: Math.round(baseline),
        raised,
        raisedMax: Math.max.apply(null, raisedPrices),
        raisedLast,
        after,
        riseDate: clean[r].date,
        raisedUntil: clean[e].date,
        raisedObs: e - r + 1,
        raisedDays: spanDays(clean[r].date, clean[e].date),
        apparentDiscountPct: discount,
        vsBaselinePct: vsBase
      }
    });
    r = d;
  }
  return events;
}

/** 주기적 등락 — 최근 SAW_WINDOW_DAYS 일 안에 SAW_AMPLITUDE 이상 오르내리기를 SAW_MIN_CYCLES 번 이상. */
function detectSawtooth(clean, today) {
  const end = today || (clean.length ? clean[clean.length - 1].date : '');
  const cutoff = addDays(end, -(SAW_WINDOW_DAYS - 1));
  const win = clean.filter(p => p.date >= cutoff && p.date <= end);
  if (win.length < MIN_OBS) return [];
  const prices = win.map(p => p.price);
  const zz = zigzag(prices, SAW_AMPLITUDE);
  const cycles = Math.floor(zz.swings.length / 2);
  if (cycles < SAW_MIN_CYCLES) return [];

  const amp = median(zz.swings.map(s => Math.abs(Math.log(s.to / s.from))));
  const ampPct = pct1(Math.exp(amp) - 1);
  const typicalLow = Math.round(median(zz.troughs.length ? zz.troughs : [Math.min.apply(null, prices)]));
  const typicalHigh = Math.round(median(zz.peaks.length ? zz.peaks : [Math.max.apply(null, prices)]));
  const last = win[win.length - 1];
  const nearLow = last.price <= typicalLow * (1 + FAKE_AFTER_TOL);
  return [{
    date: last.date,
    kind: 'SAWTOOTH',
    severity: 'info',
    price: last.price,
    ref: typicalLow,
    changePct: changePct(last.price, typicalLow),
    confirmed: true,
    note: '최근 ' + SAW_WINDOW_DAYS + '일 동안 가격이 ' + cycles + '번 오르내렸다(한 번에 약 ' + ampPct + '%). '
      + '규칙적으로 출렁이는 상품이라 낮은 날(최근 저점 약 ' + won(typicalLow) + '원)을 기다리면 도움이 될 수 있다.'
      + (nearLow ? ' 지금은 저점 부근이다.' : ''),
    evidence: {
      cycles,
      swings: zz.swings.length,
      amplitudePct: ampPct,
      typicalLow,
      typicalHigh,
      low: Math.min.apply(null, prices),
      high: Math.max.apply(null, prices),
      from: win[0].date,
      to: last.date,
      windowDays: SAW_WINDOW_DAYS,
      observations: win.length
    }
  }];
}

/** 정가 부풀리기 — 판매처가 표시한 정가가 SEOSA 가 본 어떤 값보다도 훨씬 높다. */
function detectReferenceInflation(product, clean) {
  const oprice = intOrNull(product && product.oprice);
  if (!isSanePrice(oprice) || clean.length < MIN_OBS) return [];
  const prices = clean.map(p => p.price);
  const last = clean[clean.length - 1];
  const current = last.price;
  const med = median(prices);
  const max = Math.max.apply(null, prices);
  const discount = (oprice - current) / oprice;
  const ruleA = discount >= REF_DISCOUNT_MIN && current >= med;
  const ruleB = oprice > max * REF_OVER_MAX;
  if (!ruleA && !ruleB) return [];

  const parts = [];
  if (ruleB) {
    parts.push('판매처가 표시한 정가(' + won(oprice) + '원)가 SEOSA가 관측한 어떤 가격(최고 ' + won(max) + '원)보다 '
      + pct1(oprice / max - 1) + '% 높다. 그 정가로 팔린 기록이 없어 표시 할인율(' + pct1(discount) + '%)은 부풀려졌을 가능성이 크다.');
  }
  if (ruleA) {
    parts.push('정가 대비 ' + pct1(discount) + '% 할인처럼 보이지만 지금 가격(' + won(current) + '원)은 관측한 기록의 중앙값('
      + won(med) + '원) 이상이라 실제로 싼 가격이 아니다.');
  }
  return [{
    date: last.date,
    kind: 'REFERENCE_INFLATION',
    severity: 'warn',
    price: current,
    ref: oprice,
    changePct: changePct(current, oprice),
    confirmed: true,
    note: parts.join(' '),
    evidence: {
      oprice,
      current,
      median: Math.round(med),
      max,
      impliedDiscountPct: pct1(discount),
      overMaxPct: pct1(oprice / max - 1),
      rule: ruleA && ruleB ? 'both' : (ruleA ? 'discount_not_low' : 'above_observed_max')
    }
  }];
}

/* ==================================================================
 *  요약
 * ================================================================== */

function summarize(events, validDays, today) {
  const counts = {};
  KINDS.forEach(k => { counts[k] = 0; });
  events.forEach(e => { counts[e.kind] = (counts[e.kind] || 0) + 1; });

  const recent = e => !!e.date && !!today && spanDays(e.date, today) <= RECENT_DAYS;
  let status, note;
  if (validDays < MIN_OBS) {
    status = 'INSUFFICIENT';
    note = '이 옵션의 유효한 가격 기록이 ' + validDays + '일치뿐이라 이상 여부를 판단할 수 없다 (최소 ' + MIN_OBS + '일).';
  } else {
    const alert = events.find(e => e.severity === 'alert');
    const hot = events.find(e => recent(e)
      && (e.kind === 'COLLECTION_ERROR' || ((e.kind === 'SPIKE' || e.kind === 'CRASH') && e.confirmed)));
    const warn = events.find(e => e.severity === 'warn');
    if (alert || hot) {
      status = 'ANOMALOUS';
      const e = alert || hot;
      note = (e.date ? e.date + ' ' : '') + KIND_LABEL[e.kind] + ': ' + e.note;
    } else if (warn) {
      status = 'WATCH';
      note = (warn.date ? warn.date + ' ' : '') + KIND_LABEL[warn.kind] + ': ' + warn.note;
    } else {
      status = 'NORMAL';
      note = events.length
        ? '참고할 움직임은 있지만 주의가 필요한 이상 패턴은 없다.'
        : '관측한 기록에서 이상 패턴이 보이지 않는다.';
    }
  }
  return { status, label: STATUS_LABEL[status], counts, validDays, note };
}

function sortEvents(events) {
  return events.slice().sort((a, b) => {
    const da = a.date || '9999-99-99', db = b.date || '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return (Number(a.price) || 0) - (Number(b.price) || 0);
  });
}

/* ==================================================================
 *  본체
 * ================================================================== */

function buildHistory(obs) {
  const observations = obs.map(o => ({ at: o.at, date: o.date || null, price: o.price, vendorItemId: o.vendorItemId, flag: o.flag }));
  return { observations, digest: digestOf(observations), canonical: CANONICAL };
}

function insufficientShape(obs, validDays, events) {
  const evs = sortEvents(events || []);
  return {
    distribution: null,
    events: evs,
    summary: summarize(evs, validDays || 0, ''),
    history: buildHistory(obs || [])
  };
}

function analyzeUnsafe(input) {
  const today = DATE_RE.test(String(input.today || '')) ? String(input.today) : '';
  const vendorItemId = (typeof input.vendorItemId === 'string' || typeof input.vendorItemId === 'number')
    ? String(input.vendorItemId).trim() : '';
  const rawIn = Array.isArray(input.rawRows) ? input.rawRows.filter(isRow) : [];
  const rowsIn = Array.isArray(input.rows) ? input.rows.filter(isRow) : null;
  const pointsIn = Array.isArray(input.points) ? input.points.filter(isRow) : [];

  /* ── 1. 원본 관측 (옵션 무관, 시간 오름차순) ── */
  const rawList = (rawIn.length ? rawIn : (rowsIn || [])).slice().sort(byTimeAsc);
  const obs = rawList.map(r => ({
    row: r,
    at: atOf(r),
    date: dateOf(r),
    price: intOrNull(r.price),
    vendorItemId: vidOf(r),
    flag: 'ok',
    mine: false,
    error: null
  }));

  /* ── 2. 이 옵션의 행 ──
   * 호출부가 준 rows(= sameVendorRows 결과)를 쓴다. 없으면 같은 규칙으로 만든다.
   * rows 안에 알려진 옵션이 둘 이상이면(= 좁힐 근거가 없었다) 가장 최근 옵션으로 좁힌다 —
   * 서로 다른 옵션의 값을 한 곡선으로 보고 급등·급락이라 부르지 않기 위해서다. */
  let series = rowsIn && rowsIn.length ? rowsIn : (rawIn.length ? sameVendorRows(rawIn, vendorItemId) : []);
  let currentVid = vendorItemId;
  const knownVids = new Set(series.map(vidOf).filter(isKnownVid));
  if (knownVids.size >= 2) {
    const latest = series.slice().sort(byTimeAsc).filter(r => isKnownVid(vidOf(r))).pop();
    currentVid = vidOf(latest);
    series = sameVendorRows(series, currentVid);
  } else if (!currentVid && knownVids.size === 1) {
    currentVid = [...knownVids][0];
  }
  const seriesSet = new Set(series);
  const seriesKeys = new Set(series.map(rowKey));
  obs.forEach(o => {
    o.mine = seriesSet.has(o.row) || seriesKeys.has(rowKey(o.row));
    if (!o.mine) o.flag = 'other_option';
  });
  let sObs = obs.filter(o => o.mine);
  if (!sObs.length && series.length) {
    sObs = series.slice().sort(byTimeAsc).map(r => ({ row: r, at: atOf(r), date: dateOf(r), price: intOrNull(r.price), vendorItemId: vidOf(r), flag: 'ok', mine: true, error: null }));
  }
  if (!sObs.length && pointsIn.length) {
    // 원본 행 없이 곡선만 받은 경우 — 분석은 하되 history 에는 싣지 않는다(원본이 아니다).
    sObs = pointsIn.map(p => ({ row: p, at: String(p.date || ''), date: DATE_RE.test(String(p.date || '')) ? String(p.date) : '', price: intOrNull(p.price), vendorItemId: currentVid, flag: 'ok', mine: true, error: null }));
  }

  /* ── 3. 옵션 변경 (원본 전체) ── */
  const events = detectOptionChanges(obs, currentVid);

  /* ── 4. 수집 오류 (a)(b) ── */
  events.push.apply(events, detectRowErrors(sObs));

  /* ── 5. 일별 최저가 (history.js 와 같은 접기) ── */
  const byDate = new Map();
  sObs.forEach(o => {
    if (o.error) return;
    const cur = byDate.get(o.date);
    if (!cur) byDate.set(o.date, { date: o.date, price: o.price, rows: [o] });
    else { cur.rows.push(o); if (o.price < cur.price) cur.price = o.price; }
  });
  const daily = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  /* ── 6. 수집 오류 (c) ── */
  const blips = detectBlips(daily);
  blips.errDays.forEach(i => daily[i].rows.forEach(o => { o.error = 'blip'; }));
  events.push.apply(events, blips.events);
  const clean = daily.filter((_, i) => !blips.errDays.has(i));
  const excluded = sObs.filter(o => o.error).length;

  if (clean.length < MIN_OBS) {
    obs.forEach(o => { if (o.mine && o.error) o.flag = 'collection_error'; });
    const shape = insufficientShape(obs, clean.length, events);
    shape.summary = summarize(shape.events, clean.length, today);
    return shape;
  }

  /* ── 7. 가격 패턴 (정리된 계열) ── */
  const shifts = detectShifts(clean);
  const fakes = detectFakeDiscounts(clean);
  // 뻥튀기 후 할인으로 설명되는 오름·내림은 따로 세지 않는다 (같은 일을 두 번 말하지 않는다).
  const inFake = e => fakes.some(f => e.date >= f.evidence.riseDate && e.date <= f.date);
  events.push.apply(events, shifts.filter(e => !inFake(e)));
  events.push.apply(events, fakes);
  events.push.apply(events, detectSawtooth(clean, today));
  events.push.apply(events, detectReferenceInflation(input.product, clean));

  /* ── 8. 관측 표시 ── */
  const dayFlag = new Map();
  const rank = { spike: 1, crash: 2, fake_discount: 3 };
  events.forEach(e => {
    const f = e.kind === 'SPIKE' ? 'spike' : e.kind === 'CRASH' ? 'crash' : e.kind === 'FAKE_DISCOUNT' ? 'fake_discount' : '';
    if (!f || !e.date) return;
    const cur = dayFlag.get(e.date);
    if (!cur || rank[f] > rank[cur]) dayFlag.set(e.date, f);
  });
  obs.forEach(o => {
    if (!o.mine) return;
    if (o.error) o.flag = 'collection_error';
    else if (dayFlag.has(o.date)) o.flag = dayFlag.get(o.date);
  });

  const sorted = sortEvents(events);
  return {
    distribution: distributionOf(clean.map(p => p.price), excluded),
    events: sorted,
    summary: summarize(sorted, clean.length, today || clean[clean.length - 1].date),
    history: buildHistory(obs)
  };
}

/**
 * 한 상품(옵션)의 가격 이상 패턴.
 *
 * @param {{rawRows?:object[], rows?:object[], points?:{date:string,price:number}[],
 *          product?:object|null, vendorItemId?:string, today?:string}} input
 *   rawRows  이 상품의 price_history 전부 (옵션 무관, 시간 오름차순)
 *   rows     그중 이 옵션 (_price.sameVendorRows)
 *   points   rows 의 KST 일별 최저가 — rows 가 없을 때만 쓴다
 *   product  카탈로그 행 (oprice = 판매처 표시 정가)
 *   today    KST 'YYYY-MM-DD'. 없으면 마지막 관측일을 오늘로 본다 (시계를 읽지 않는다)
 * @returns {{distribution:object|null, events:object[], summary:object, history:object}}
 *   절대 throw 하지 않는다.
 */
function analyze(input) {
  try {
    return analyzeUnsafe(isRow(input) ? input : {});
  } catch (e) {
    try {
      console.warn('[anomaly] analyze 실패 — INSUFFICIENT 로 돌려준다: ' + (e && e.message));
    } catch (_) { /* 로그 실패도 삼킨다 */ }
    return insufficientShape([], 0, []);
  }
}

module.exports = {
  analyze,
  // 도구 (테스트·다른 기능이 같은 규칙을 쓰도록)
  digestOf, median, quantile, madOf, robustScale, robustZ, zigzag, distributionOf,
  detectOptionChanges, detectRowErrors, detectBlips, detectShifts, detectFakeDiscounts,
  detectSawtooth, detectReferenceInflation,
  // 기준값
  KINDS, KIND_LABEL, STATUS_LABEL, CANONICAL,
  MIN_OBS, SHIFT_WINDOW, SHIFT_MIN_BASE, SHIFT_PCT, SHIFT_Z, MAD_K, MEANAD_K, SCALE_FLOOR, LEVEL_TOL, CONFIRM_OBS,
  SAME_DAY_CONFLICT_RATIO, BLIP_MIN_DEV, BLIP_Z, BLIP_Z_MIN_DEV, BLIP_NEIGHBOURS, BLIP_PRE_OBS, BLIP_MAX_GAP_DAYS,
  EXCURSION_MAX_RUN,
  FAKE_WINDOW_DAYS, FAKE_BASE_WINDOW, FAKE_BASE_MIN, FAKE_BASE_TOL, FAKE_RISE_PCT, FAKE_MIN_UP_DAYS,
  FAKE_AFTER_TOL, FAKE_MIN_DROP,
  SAW_WINDOW_DAYS, SAW_AMPLITUDE, SAW_MIN_CYCLES,
  REF_DISCOUNT_MIN, REF_OVER_MAX,
  RECENT_DAYS, OPTION_EPISODE_DAYS, MAX_OPTION_EVENTS, HIST_MAX_BINS
};
