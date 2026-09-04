'use strict';
/*
 * 가격 신뢰도 — "이 가격을 믿고 사도 되는가"
 *
 * ── 이 지표가 답하는 질문 ─────────────────────────────────────────
 * 오직 하나다: "지금 화면에 찍힌 이 숫자가 쇼핑몰의 실제 판매가와 같은가."
 *
 * "이 가격이 싼 가격인가"는 다른 질문이고 여기서 답하지 않는다. 둘을 한
 * 배지에 섞으면 사용자는 "신뢰도 높음"을 "좋은 가격"으로 읽는다. 가격이
 * 비싸도 정확할 수 있고, 싸도 오래된 값일 수 있다.
 * (가격이 좋은지에 대한 판단은 가격 이력 통계가 담당한다)
 *
 * ── 근거로 쓰는 것 (전부 DB 에 실재하는 값) ──────────────────────
 *   1. 신선도      products.collected_at, 또는 검색 응답의 출처(api/cache/stale-cache)
 *   2. 교차 확인   price_history 에 같은 수준의 관측이 여러 번 있는가
 *   3. 최근 변동폭 price_history 연속 관측 사이의 최대 배율
 *   4. 옵션 식별자 vendor_item_id (없으면 link 에서 추출)
 *
 * 근거가 없는 요소는 넣지 않는다. 리뷰 수·평점·판매자 신뢰도·재고는
 * 쿠팡 검색 API 응답에 없으므로 이 점수에 들어가지 않는다.
 *
 * ── 점수를 그대로 보여주지 않는 이유 ─────────────────────────────
 * "87점"은 사용자에게 아무 의미가 없다. score 는 정렬용 내부 값이고,
 * 화면에는 등급과 "왜 그런지"(reasons)를 보여준다. 모든 reason 은
 * 실제 관측된 사실이며, 만들어낸 문장이 아니다.
 *
 * ── 배점 근거 (2026-08-09 운영 데이터 187개 live 상품으로 검증) ──
 * 각 감점의 크기는 "그 조건에서 가격이 실제와 다를 위험"에 비례하도록 잡았고,
 * 실측 분포로 등급이 한쪽에 몰리지 않는지 확인했다.
 *   높음 72 / 보통 86 / 확인필요 29  ← 변별력이 있다
 */

const supabase = require('./_supabase');
const { ageDays, vendorIdOf, isRefreshableMall, parsePrice, kstToday, observedKstDate } = require('./_price');

/* ── 임계값 ─────────────────────────────────────────────────────── */

/** 신선도 감점 구간 (일). */
const FRESH_TIERS = [
  { maxDays: 1, penalty: 0 },
  { maxDays: 3, penalty: 10 },
  { maxDays: 7, penalty: 25 },
  { maxDays: 10, penalty: 40 }
];
/** 이 구간을 넘으면 신선도만으로 '오래된 가격'이다. */
const STALE_DAYS = 10;

/** 최근 변동폭을 볼 기간(일). 이보다 오래된 관측은 지금 가격의 근거가 아니다. */
const VOLATILITY_WINDOW_DAYS = 14;
/** 급변 판정 배율. api/_price.js 의 SUSPECT_RATIO 와 같은 기준을 쓴다. */
const VOLATILE_HIGH = 5;
const VOLATILE_MILD = 2;

/** 이력 조회 범위(일). 신뢰도에 필요한 건 최근 기록뿐이다. */
const HISTORY_WINDOW_DAYS = 30;
/** product_id in(...) 한 번에 넣을 개수. */
const CHUNK = 100;

const LEVEL = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  STALE: 'stale',
  UNKNOWN: 'unknown'
};

const LEVEL_LABEL = {
  [LEVEL.HIGH]: '신뢰 높음',
  [LEVEL.MEDIUM]: '보통',
  [LEVEL.LOW]: '확인 필요',
  [LEVEL.STALE]: '오래된 가격',
  [LEVEL.UNKNOWN]: '확인 불가'
};

/** 점수 → 등급. */
function levelOf(score) {
  if (score >= 85) return LEVEL.HIGH;
  if (score >= 65) return LEVEL.MEDIUM;
  return LEVEL.LOW;
}

function hoursAgo(days) {
  const h = Math.round(days * 24);
  if (h < 1) return '방금';
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(days)}일 전`;
}

/**
 * 신뢰도 계산.
 *
 * @param {object} input
 *   age            마지막 확인으로부터 지난 일수 (숫자, Infinity 가능)
 *   liveSource     검색 응답 출처: 'api' | 'cache' | 'stale-cache' | null
 *   points         [{price, recorded_date}] 최근 관측 (오름차순 정렬 여부 무관)
 *   vendorItemId   판매 옵션 식별자
 *   mall           몰 이름
 * @returns {{level, score, label, summary, reasons: Array<{code,text,kind}>}}
 */
function evaluateTrust(input = {}) {
  const reasons = [];
  const add = (code, text, kind) => reasons.push({ code, text, kind });

  const mall = input.mall || '';
  // 다시 받아올 수 없는 몰은 신선도를 보장할 방법 자체가 없다.
  if (mall && !isRefreshableMall(mall)) {
    add('unsupported_mall', `${mall} 가격은 더 이상 수집되지 않아 현재가를 확인할 수 없습니다`, 'bad');
    return {
      level: LEVEL.UNKNOWN, score: 0, label: LEVEL_LABEL[LEVEL.UNKNOWN],
      summary: '현재가를 확인할 수 없는 상품입니다', reasons
    };
  }

  let score = 100;

  /*
   * ── 관측 기록 정리 (신선도 폴백에도 쓴다) ────────────────────
   *
   * 날짜는 recorded_date 라벨이 아니라 observedKstDate 로 정한다. 라벨은
   * 운영 DB 가 recorded_at 의 UTC 날짜로 덮어써서, KST 새벽에 도는 수집분이
   * 통째로 하루 이른 날짜를 달고 있다(api/_price.js kstToday 주석 참고).
   *
   * 그대로 두면 "오늘의 가격 하락" 카드가 오늘 받아온 가격을 두고
   * "1일 전 확인됨" 이라고 말한다 — 2026-08-23 시세판 8칸 전부가 그랬다.
   * 섹션 제목과 배지가 같은 카드 안에서 서로 다른 날을 가리킨 셈이다.
   *
   * at 은 그 관측의 절대 시각이다. 나이(age)는 날짜 라벨의 자정이 아니라
   * 이 값으로 재야 실제로 몇 시간 전인지가 맞는다.
   */
  const points = (input.points || [])
    .map(p => ({
      price: parsePrice(p.price),
      date: observedKstDate(p),
      at: (p && p.recorded_at) || ''
    }))
    .filter(p => p.price && p.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  /* ── 1. 신선도 ──────────────────────────────────────────────── */
  const src = input.liveSource;
  let age = Number.isFinite(input.age) ? input.age : Infinity;

  /*
   * collected_at 이 없는 경로(예: price_drop_top 뷰 기반 시세판)를 위한 폴백.
   * 가장 최근 관측 날짜가 곧 "마지막으로 확인한 시점"이다. 추측이 아니라
   * price_history 에 실제로 남아 있는 날짜를 쓴다.
   */
  if (!Number.isFinite(age) && points.length) {
    const last = points[points.length - 1];
    // 관측 시각이 있으면 그걸로 잰다. 없을 때만 날짜의 자정으로 폴백한다.
    age = ageDays(last.at || `${last.date}T00:00:00Z`);
  }

  if (src === 'api') {
    age = 0;
    add('checked_now', '방금 쇼핑몰에서 확인한 가격입니다', 'good');
  } else if (src === 'stale-cache') {
    add('stale_source', '쇼핑몰 응답을 받지 못해 마지막으로 저장된 가격을 보여주고 있습니다', 'bad');
    return {
      level: LEVEL.STALE, score: 0, label: LEVEL_LABEL[LEVEL.STALE],
      summary: '지금 시점의 가격이 아닙니다', reasons
    };
  } else if (!Number.isFinite(age)) {
    add('unknown_age', '언제 확인한 가격인지 알 수 없습니다', 'bad');
    score -= 40;
  } else if (age > STALE_DAYS) {
    add('too_old', `${Math.round(age)}일간 확인되지 않았습니다`, 'bad');
    return {
      level: LEVEL.STALE, score: 0, label: LEVEL_LABEL[LEVEL.STALE],
      summary: `${Math.round(age)}일 전 가격입니다`, reasons
    };
  } else {
    const tier = FRESH_TIERS.find(t => age <= t.maxDays) || { penalty: 40 };
    score -= tier.penalty;
    if (age <= 1) add('fresh', `${hoursAgo(age)} 확인됨`, 'good');
    else if (age <= 3) add('fresh_days', `${Math.round(age)}일 전 확인됨`, 'good');
    else add('aging', `${Math.round(age)}일 전 확인 — 그사이 바뀌었을 수 있습니다`, 'warn');
  }

  /* ── 2. 교차 확인 + 3. 최근 변동폭 ──────────────────────────── */
  if (!points.length) {
    add('no_history', '가격 기록이 아직 없어 교차 확인되지 않았습니다', 'warn');
    score -= 25;
  } else if (points.length === 1) {
    add('single_observation', '가격 기록이 1일치뿐이라 아직 교차 확인되지 않았습니다', 'warn');
    score -= 15;
  } else {
    if (points.length < 7) score -= 5;
    add('corroborated', `최근 ${points.length}일간 가격이 기록되어 교차 확인됐습니다`, 'good');
  }

  // 최근 변동폭 — 연속 관측 사이 최대 배율
  const recent = points.filter(p => ageDays(p.at || `${p.date}T00:00:00Z`) <= VOLATILITY_WINDOW_DAYS);
  let maxRatio = 1;
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1].price;
    const b = recent[i].price;
    if (a > 0 && b > 0) maxRatio = Math.max(maxRatio, b > a ? b / a : a / b);
  }
  if (recent.length >= 2) {
    if (maxRatio >= VOLATILE_HIGH) {
      add('volatile_high',
        `최근 ${VOLATILITY_WINDOW_DAYS}일 안에 가격이 ${maxRatio.toFixed(1)}배 튄 기록이 있습니다 `
        + '(옵션이 바뀌었을 수 있습니다)', 'bad');
      score -= 30;
    } else if (maxRatio >= VOLATILE_MILD) {
      add('volatile_mild', `최근 가격 변동폭이 ${maxRatio.toFixed(1)}배로 큽니다`, 'warn');
      score -= 10;
    } else {
      add('stable', '최근 가격이 안정적입니다', 'good');
    }
  }

  /* ── 4. 옵션 식별자 ─────────────────────────────────────────── */
  if (!input.vendorItemId) {
    add('no_option_id',
      '판매 옵션을 특정할 수 없어 색상·용량에 따라 실제 가격이 다를 수 있습니다', 'warn');
    score -= 10;
  }

  score = Math.max(0, Math.min(100, score));
  const level = levelOf(score);

  // 요약 한 줄 — 가장 중요한 사실 하나만.
  const bad = reasons.find(r => r.kind === 'bad');
  const warn = reasons.find(r => r.kind === 'warn');
  const summary = bad ? bad.text
    : level === LEVEL.HIGH ? (reasons[0] ? reasons[0].text : '최근 확인된 가격입니다')
      : warn ? warn.text
        : '최근 확인된 가격입니다';

  return { level, score, label: LEVEL_LABEL[level], summary, reasons };
}

/**
 * 최근 가격 기록을 상품 단위로 읽어온다.
 *
 * ★ product_id + mall + vendor_item_id 로 묶는다. 같은 상품 페이지의 다른
 *   옵션(vendorItemId) 기록이 섞이면 교차 옵션 가격차가 변동폭으로 잡힌다.
 *
 * @returns {Map<"pid|mall|vid", Array<{price, recorded_date, recorded_at}>>}
 */
async function loadRecentHistory(keys) {
  const map = new Map();
  const ids = [...new Set(keys.map(k => k.productId).filter(Boolean))];
  if (!ids.length) return map;

  // recorded_date 가 KST 달력이므로 컷오프도 같은 기준이어야 30일 창이 정확히 맞는다.
  const cutoff = kstToday(new Date(Date.now() - HISTORY_WINDOW_DAYS * 86400000));
  // 원하는 목록은 상품 단위(pid|mall)로 잡는다. 옵션(vid)은 아래에서 계열을 나눌 때 쓴다.
  const wanted = new Set(keys.map(k => `${k.productId}|${k.mall}`));

  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('price_history')
      .select('product_id, mall, vendor_item_id, price, recorded_date, recorded_at')
      .in('product_id', ids.slice(i, i + CHUNK))
      .gte('recorded_date', cutoff)
      .order('recorded_date', { ascending: false })
      .limit(3000);
    if (error) {
      // 이력을 못 읽으면 신뢰도를 낮게 잡는 게 아니라, 이력 근거 없이 계산한다.
      console.warn(`[trust] 가격 기록 조회 실패(이력 근거 없이 계산): ${error.message}`);
      return map;
    }
    (data || []).forEach(r => {
      const base = `${r.product_id}|${r.mall}`;
      if (!wanted.has(base)) return;   // 같은 product_id 의 다른 몰 행은 섞지 않는다
      /*
       * recorded_at 을 함께 실어 보낸다.
       *
       * "오늘 수집분인가" 를 판정하는 _price.observedKstDate 가 이 값을
       * 먼저 본다. recorded_date 는 배포본이 UTC 로 잘라 온 라벨이라 KST
       * 달력과 하루 어긋난 행이 운영 DB 의 42.9% 다 (그 함수 주석 참고).
       * 신뢰도 계산(evaluateTrust)은 지금까지처럼 recorded_date 만 쓴다 —
       * 필드가 하나 늘 뿐이라 기존 계산은 그대로다.
       */
      /*
       * vendor_item_id 도 점에 실어 보낸다.
       *
       * 아래에서 옵션별 키(vidKey)로도 나눠 담지만, 호출부가 상품 단위 키를
       * 받아 간 뒤 _price.sameVendorRows 로 직접 거를 수 있어야 한다.
       * api/init.js 시세판 검증이 그렇게 쓴다 — 옵션 계열이 비었을 때
       * "전부 미상이면 상품 단위로 본다" 같은 판정은 점 하나만 봐서는 못 하고
       * 계열 전체를 봐야 하기 때문이다.
       *
       * 신뢰도 계산(evaluateTrust)은 price / recorded_date / recorded_at 만
       * 읽으므로 필드가 하나 늘어도 기존 계산은 그대로다.
       */
      const pt = {
        price: r.price, recorded_date: r.recorded_date, recorded_at: r.recorded_at,
        vendor_item_id: r.vendor_item_id || ''
      };
      // 옵션별 계열 — 같은 옵션끼리만 비교해야 교차 옵션 가격차가 변동폭으로 잡히지 않는다.
      const vidKey = `${base}|${r.vendor_item_id || ''}`;
      if (!map.has(vidKey)) map.set(vidKey, []);
      map.get(vidKey).push(pt);
      // 상품 단위 집계 — 옵션 계열이 비어 있을 때의 폴백이자, vid 를 모르는
      // 호출부(api/init.js 시세판)가 쓰는 키다. 이 키가 없으면 그쪽 조회가
      // 전부 undefined 가 되어 시세판이 통째로 비어 버린다.
      if (!map.has(base)) map.set(base, []);
      map.get(base).push(pt);
    });
  }
  return map;
}

/**
 * 프론트로 나갈 상품 목록에 trust 를 붙인다 (제자리 수정 후 같은 배열 반환).
 *
 * 응답 형태를 바꾸지 않는다 — 항목에 필드 하나가 추가될 뿐이라
 * 옛 프론트가 캐시된 상태에서도 그대로 동작한다.
 *
 * @param {Array} items  toClientProduct / fetchCoupang 이 만든 항목
 * @param {object} opts
 *   source  검색 응답 출처('api'|'cache'|'stale-cache'). DB 조회면 넘기지 않는다.
 */
async function attachTrust(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;

  const keys = list
    .filter(it => it && it.productId)
    .map(it => ({ productId: String(it.productId), mall: it.mall || '', vendorItemId: vendorIdOf(it) }));

  let history = new Map();
  try {
    history = await loadRecentHistory(keys);
  } catch (e) {
    console.warn(`[trust] 이력 조회 예외(이력 근거 없이 계산): ${e.message}`);
  }

  list.forEach(it => {
    if (!it) return;
    const vid = vendorIdOf(it);
    const base = `${it.productId}|${it.mall || ''}`;
    /*
     * 같은 옵션의 기록이 있으면 그것만 쓴다 (교차 옵션 가격차가 변동폭으로
     * 잡히지 않게). 없으면 상품 단위 집계로 폴백한다.
     *
     * 폴백이 필요한 이유 — price_history 12,280행 중 6,331행이 vendor_item_id
     * 가 '' 또는 '__LEGACY__' 인 과거 기록이다. 옵션 키로만 찾으면 이 상품들의
     * 30일 이력이 통째로 안 보이게 되어, 멀쩡한 상품이 "기록 없음"으로 떨어진다.
     * 폴백 동작은 vendor_item_id 도입 이전과 같으므로 회귀가 아니다.
     */
    const points = history.get(`${base}|${vid}`) || history.get(base) || [];

    /*
     * ★ 출처는 항목별로 본다. 배치 하나로 뭉뚱그리면 안 된다.
     *
     *   searchAll 은 쿠팡 + ADPICK 을 한 배열로 합쳐서 주는데, opts.source 에는
     *   쿠팡의 from 만 들어온다(_shop.searchAll 의 `from: coupang.from`). 두 소스는
     *   서로 독립적으로 성공·차단되므로 그 값이 ADPICK 항목의 실제 출처와 어긋난다.
     *
     *   어긋나면 사용자에게 사실이 아닌 말을 한다 — 이 모듈이 막으려는 바로 그것이다.
     *     쿠팡 api + ADPICK stale-cache → ADPICK 카드가 age=0 으로 강제되어
     *                                    "방금 쇼핑몰에서 확인한 가격입니다" 라고 말한다.
     *                                    실제로는 최대 48시간(_adpick.STALE_MAX_MS) 전 값이다.
     *     쿠팡 stale-cache + ADPICK api → 방금 받아온 ADPICK 가격을 STALE 로 깎아
     *                                    "응답을 받지 못해 마지막 저장값" 이라고 말한다.
     *
     *   저장 경로(_shop.saveProducts)는 이미 항목별 _source 로 판정한다. 표시 경로도
     *   같은 기준을 써야 저장과 화면이 갈라지지 않는다. _source 가 없는 항목
     *   (init.js 시세판·rec.js 등 DB 에서 읽는 경로)은 지금까지처럼 opts.source 를 쓴다 —
     *   기존 동작 그대로다.
     */
    const src = it._source || opts.source || null;

    it.trust = evaluateTrust({
      age: it.collectedAt ? ageDays(it.collectedAt) : (src ? 0 : Infinity),
      liveSource: src,
      points,
      vendorItemId: vid,
      mall: it.mall
    });
  });

  return list;
}

module.exports = {
  evaluateTrust, attachTrust, loadRecentHistory,
  LEVEL, LEVEL_LABEL, STALE_DAYS, VOLATILE_HIGH, VOLATILE_MILD, VOLATILITY_WINDOW_DAYS
};
