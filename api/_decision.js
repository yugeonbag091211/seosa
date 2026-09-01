/*
 * Shopping Decision Brain — "무엇을 살까"를 코드가 먼저 결정한다.
 *
 * ── 이 파일이 생긴 이유 ─────────────────────────────────────────
 *
 * 지금까지 SEOSA 는 상품을 잘 찾고, 조건에 맞게 줄 세우고, 가격이 좋은지
 * 판정하는 데까지 왔다. 그런데 거기서 멈추면 모델이 그 재료를 받아 "무엇을
 * 살지"를 스스로 결정한다. 그 결정은 물을 때마다 흔들리고, 무엇을 포기하는
 * 선택인지 말해 주지 않으며, 확신이 없을 때도 확신 있게 말한다.
 *
 * 쇼핑에서 사용자가 진짜로 원하는 것은 목록이 아니라 결정이다. 그리고 좋은
 * 결정에는 늘 대가가 있다 — "A 를 고르면 B 의 이것을 포기한다". 그 대가를
 * 말해 주지 않는 추천은 광고와 구분되지 않는다.
 *
 * 그래서 결정 자체를 코드로 옮긴다.
 *
 *   계산은 코드 · 사실은 데이터 · 비교는 구조 · 판단은 이 파일 · 설명은 LLM
 *
 * ── 여기서 하지 않는 것 ─────────────────────────────────────────
 *
 * ★ 없는 데이터로 판단하지 않는다. 근거가 없으면 null 이나 'unknown' 을
 *   돌려주고, 호출부는 그것을 그대로 "확인되지 않았다"로 옮긴다.
 * ★ 사용자의 성격·심리를 추측하지 않는다. 후회 위험은 구조적 위험
 *   (예산 초과·요구 기능 미확인·가격 타이밍·정보 부족)으로만 계산한다.
 * ★ 미래 가격을 예측하지 않는다. 지나간 기록이 무엇을 말하는지만 옮긴다.
 * ★ 점수를 사용자에게 보여주지 않는다. 점수는 순서를 정하는 내부 값이다.
 *
 * ── 결정론 ──────────────────────────────────────────────────────
 *
 * 같은 입력이면 언제나 같은 결정이 나와야 한다. 난수도, 시각 의존도,
 * 외부 호출도 없다. (scripts/eval-decision-brain.js 가 100회 반복으로 검증)
 */

/*
 * 조사 헬퍼 — 기능 라벨을 문장에 끼울 때 "마이크이" 같은 어긋남을 막는다.
 * _specs 는 순수 정규식 모듈이라 최상단 require 가 안전하다.
 */
const { iga, eunn, eulr, detectCategory, specMatters } = require('./_specs');

/* ==================================================================
 *  1) 격차 (Decision Margin) — 1위가 얼마나 확실하게 이겼는가
 * ================================================================== */

/*
 * 임계값은 랭킹 점수(_shopintent.scoreItem)의 실제 크기에서 나왔다.
 *   예산 적합 +40 · 요구 기능 확인 +12~24 · 30일 평균 대비 +최대 20
 *   검색어 일치 +12 · 신뢰도 ±8
 * 즉 25점 차이는 "조건 하나가 통째로 갈렸다"는 뜻이고, 4점 차이는
 * 사실상 같은 상품이라는 뜻이다.
 */
const MARGIN_DOMINANT = 25;
const MARGIN_CLEAR    = 12;
const MARGIN_CLOSE    = 4;

const MARGIN_LABEL = {
  dominant: '1위가 뚜렷하게 앞선다',
  clear:    '1위가 앞선다',
  close:    '1·2위 차이가 작다',
  tieLike:  '1·2위가 사실상 대등하다',
  only:     '후보가 하나뿐이다',
  none:     '비교할 후보가 없다'
};

/**
 * @param {Array} ranked 랭킹된 상품 (it._score 를 가진다)
 * @returns {{margin:string, points:number, label:string}}
 */
function computeMargin(ranked) {
  const list = (ranked || []).filter(Boolean);
  if (!list.length) return { margin: 'none', points: 0, label: MARGIN_LABEL.none };
  if (list.length === 1) return { margin: 'only', points: 0, label: MARGIN_LABEL.only };

  const a = Number(list[0]._score) || 0;
  const b = Number(list[1]._score) || 0;
  const points = Math.round((a - b) * 10) / 10;

  let margin;
  if (points >= MARGIN_DOMINANT) margin = 'dominant';
  else if (points >= MARGIN_CLEAR) margin = 'clear';
  else if (points >= MARGIN_CLOSE) margin = 'close';
  else margin = 'tieLike';

  return { margin, points, label: MARGIN_LABEL[margin] };
}

/* ==================================================================
 *  2) 후회 위험 (Regret Engine)
 *
 *  ★ 심리를 추측하지 않는다. "꼼꼼한 성격이라 후회하실 것" 같은 말은
 *    근거가 없고, 틀리면 불쾌하다. 구조적으로 확인 가능한 위험만 센다.
 * ================================================================== */

const RISK_ORDER = { low: 1, medium: 2, high: 3 };
const REGRET_LABEL = {
  low: '낮음', medium: '중간', high: '높음', unknown: '판단 불가'
};

function worse(a, b) {
  return (RISK_ORDER[b] || 0) > (RISK_ORDER[a] || 0) ? b : a;
}

/**
 * 상품 하나의 구매 후 후회 위험.
 *
 * @param {object} it          랭킹·스펙·판정을 거친 상품
 * @param {object} c           조건 (parseConstraints/mergeConstraints)
 * @param {Array}  wanted      사용자가 요구한 기능 라벨
 * @returns {{level:string, reasons:string[]}}
 */
function computeRegret(it, c, wanted) {
  if (!it) return { level: 'unknown', reasons: [] };

  const cons = c || {};
  const reasons = [];
  let level = 'low';

  const price = Math.round(Number(it.price) || 0);

  /* ① 예산 압박 — 가장 확실하고 가장 흔한 후회 요인 */
  if (cons.budgetMax && price > cons.budgetMax) {
    const overPct = Math.round((price / cons.budgetMax - 1) * 100);
    if (cons.budgetSoft) {
      level = worse(level, 'medium');
      reasons.push(`말한 예산보다 ${overPct}% 높음`);
    } else {
      level = worse(level, 'high');
      reasons.push(`예산 상한을 ${overPct}% 초과`);
    }
  }

  /* ② 요구 기능 미확인 — 사용자가 중요하다고 말한 것이 확인되지 않는다 */
  const miss = Array.isArray(it.featureMiss) ? it.featureMiss : [];
  const hit = Array.isArray(it.featureHit) ? it.featureHit : [];
  if (miss.length) {
    // 요구한 것을 하나도 확인하지 못했으면 목적 자체가 어긋날 수 있다.
    const allMissed = hit.length === 0 && wanted && wanted.length > 0;
    level = worse(level, allMissed ? 'high' : 'medium');
    reasons.push(`중요하다고 한 ${eulr(miss.join('·'))} 상품 정보에서 확인할 수 없음`);
  }

  /* ③ 가격 타이밍 — 기록상 지금이 불리한 때인가 */
  const v = it.verdict;
  if (v && v.verdict === 'wait') {
    level = worse(level, 'medium');
    reasons.push('가격 기록상 지금이 유리한 시점은 아님');
  }

  /* ④ 정보 부족 — 판단할 재료 자체가 없다 */
  const noSpec = !it.specLine;
  const noHist = !it.hist || !(it.hist.count > 0);

  /*
   * ★ 여기서 갈린다.
   *
   *   위험을 찾지 못한 것  ≠  위험이 없는 것
   *
   * 사양도 가격 기록도 없으면 우리는 이 상품에 대해 아는 것이 거의 없다.
   * 그 상태에서 "후회 위험 낮음"이라고 말하면, 모르는 것을 안전하다고
   * 말하는 셈이다 — 쇼핑에서 그건 가장 나쁜 종류의 거짓말이다.
   *
   * 다만 다른 위험(예산 초과·기능 미확인)이 이미 잡혀 있으면 그것은 실제로
   * 확인된 위험이므로 그대로 둔다. 근거 부족은 그 위에 덧붙이지 않는다.
   */
  if (noSpec && noHist) {
    if (!reasons.length) {
      return { level: 'unknown', reasons: ['사양도 가격 기록도 없어 위험을 판단할 근거가 없음'] };
    }
    reasons.push('사양도 가격 기록도 없어 비교 근거가 부족함');
  } else if (noHist && (cons.budgetMax || cons.budgetMin)) {
    // 예산을 말한 사람에게 "이 값이 좋은 값인가"를 답할 수 없다.
    reasons.push('가격 기록이 없어 지금 값이 좋은지 판단할 수 없음');
  }

  return { level, reasons };
}

/* ==================================================================
 *  3) 가격 기회 (Price Opportunity)
 *
 *  _pricestat.assess 의 판정을 "지금 사는 것이 기회인가"의 언어로 옮기고,
 *  근거와 주의점을 나눈다. 미래는 말하지 않는다.
 * ================================================================== */

const OPPORTUNITY_LABEL = {
  strong:  '지금 가격이 기록 대비 뚜렷하게 유리',
  fair:    '기록 대비 무난한 가격',
  weak:    '기록 대비 유리한 시점은 아님',
  unknown: '가격 기록이 부족해 판단 불가'
};

/**
 * @returns {{opportunity:string, label:string, reasons:string[], caution:string|null}}
 */
function priceOpportunity(it) {
  const out = { opportunity: 'unknown', label: OPPORTUNITY_LABEL.unknown, reasons: [], caution: null };
  if (!it) return out;

  const h = it.hist;
  const v = it.verdict;
  const price = Math.round(Number(it.price) || 0);
  if (!h || !(h.count > 0) || price <= 0) return out;

  // 기록이 멈춰 있으면 지금을 말할 수 없다 — 판정을 만들지 않는다.
  if (v && v.verdict === 'unknown') {
    out.caution = `가격 기록이 ${v.staleDays}일 전에 멈춰 있어 현재 시점 판단은 어려움`;
    return out;
  }

  if (h.low > 0) {
    if (price <= h.low) out.reasons.push('기록상 최저가 수준');
    else if (price <= Math.round(h.low * 1.03)) out.reasons.push('기록상 최저가에 근접');
    else out.caution = `기록상 ${h.low.toLocaleString('en-US')}원까지 내려간 적 있음`;
  }
  if (h.avg30 > 0) {
    const pct = Math.round((1 - price / h.avg30) * 100);
    if (pct >= 3) out.reasons.push(`30일 평균보다 ${pct}% 낮음`);
    else if (pct <= -3) out.reasons.push(`30일 평균보다 ${-pct}% 높음`);
  }
  if (h.trendPct != null && h.trendDays >= 1) {
    if (h.trendPct <= -3) out.reasons.push(`최근 ${h.trendDays}일 ${Math.abs(h.trendPct)}% 하락`);
    else if (h.trendPct >= 5) out.reasons.push(`최근 ${h.trendDays}일 ${h.trendPct}% 상승`);
  }

  if (v) {
    if (v.verdict === 'good') out.opportunity = (h.low > 0 && price <= Math.round(h.low * 1.03)) ? 'strong' : 'fair';
    else if (v.verdict === 'wait') out.opportunity = 'weak';
    else out.opportunity = 'fair';
  }
  out.label = OPPORTUNITY_LABEL[out.opportunity];
  return out;
}

/* ==================================================================
 *  4) 확신도 (Confidence Engine)
 *
 *  91 대 90 을 "확실히 A" 라고 말하는 것은 사용자를 속이는 것이다.
 *  확신은 점수가 아니라 "판단 근거가 얼마나 갖춰졌는가"에서 나온다.
 * ================================================================== */

const CONFIDENCE_LABEL = { high: '높음', medium: '보통', low: '낮음' };

/** 확신 등급 비교표. 값이 클수록 확신이 낮다. */
const CONF_RANK = { high: 1, medium: 2, low: 3 };

/** 확신도를 이루는 축. 사용자가 "무엇이 부족해서 확신이 낮은가"를 알 수 있게 한다. */
const CONF_AXES = ['ranking', 'price', 'spec', 'freshness', 'preference', 'data'];
const CONF_AXIS_LABEL = {
  ranking:    '순위 판정',
  price:      '가격 데이터',
  spec:       '사양 데이터',
  freshness:  '가격 최신성',
  preference: '사용자 취향',
  data:       '전체 데이터'
};

/**
 * 확신도.
 *
 * ── 왜 축을 나누는가 ────────────────────────────────────────────────
 *
 * "확신도 보통" 한 줄만 주면 사용자는 무엇이 부족한지 모른다. 가격 데이터가
 * 없어서 보통인 것과, 1·2위가 붙어서 보통인 것은 사용자가 취할 행동이 다르다.
 * 앞의 경우는 기다리면 나아지고, 뒤의 경우는 취향을 한 줄 더 말하면 갈린다.
 *
 * ★ 기존 반환값(confidence·label·reasons)은 글자 하나 달라지지 않는다.
 *   축(axes)은 덧붙는 정보다. 기존 호출부와 테스트는 그대로 돈다.
 *
 * ★ 종합 확신도는 축 중 가장 낮은 것이다 — 한 축이 무너지면 결론도 무너진다.
 *   이 값이 예전 계산과 같다는 것을 test-ai.js 가 잠근다.
 *
 * @param {Array}  ranked  랭킹된 상품
 * @param {object} margin  computeMargin 결과
 * @param {object} c       조건
 * @param {Array}  wanted  요구 기능
 * @param {object} [opts]  { deal, profile } — 없으면 그 축은 판정하지 않는다
 * @returns {{confidence:string, label:string, reasons:string[], axes:object}}
 */
function computeConfidence(ranked, margin, c, wanted, opts) {
  const list = (ranked || []).filter(Boolean);
  const reasons = [];

  if (!list.length) {
    return {
      confidence: 'low', label: CONFIDENCE_LABEL.low, reasons: ['후보가 없음'],
      axes: emptyAxes('low', '후보가 없음')
    };
  }

  const top = list[0];
  let level = 'high';

  // 축별 등급. 판정할 근거가 없는 축은 null 로 남는다 — 모르는 것을 높음으로
  // 채우면 종합 확신도가 근거 없이 올라간다.
  const axes = {};
  CONF_AXES.forEach(a => { axes[a] = { level: null, reasons: [] }; });

  /**
   * 확신을 낮춘다.
   * @param {string} axis 어느 축이 무너졌는가
   * @param {string} to   낮출 등급
   * @param {string} why  근거
   */
  const lower = (axis, to, why) => {
    if (CONF_RANK[to] > CONF_RANK[level]) level = to;
    reasons.push(why);
    const ax = axes[axis];
    if (!ax.level || CONF_RANK[to] > CONF_RANK[ax.level]) ax.level = to;
    ax.reasons.push(why);
  };
  /** 축이 확인됐다 — 낮출 이유가 없다. */
  const okAxis = (axis, why) => {
    const ax = axes[axis];
    if (!ax.level) ax.level = 'high';
    if (why) ax.reasons.push(why);
  };

  if (margin.margin === 'tieLike') lower('ranking', 'low', '1·2위 차이가 거의 없음');
  else if (margin.margin === 'close') lower('ranking', 'medium', '1·2위 차이가 작음');
  else if (margin.margin === 'only') lower('ranking', 'medium', '비교할 다른 후보가 없음');
  else okAxis('ranking', '1위가 뚜렷하게 앞섬');

  if (!top.hist || !(top.hist.count > 0)) lower('price', 'medium', '1위 상품의 가격 기록이 없음');
  else if (top.verdict && top.verdict.verdict === 'unknown') lower('price', 'medium', '가격 기록이 오래 멈춰 있음');
  else okAxis('price', `가격 기록 ${top.hist.count}일치 확인됨`);

  if (wanted && wanted.length) {
    const miss = Array.isArray(top.featureMiss) ? top.featureMiss : [];
    if (miss.length) lower('spec', 'medium', `요구한 ${eulr(miss.join('·'))} 확인하지 못함`);
  }

  if (!top.specLine) lower('spec', 'medium', '1위 상품의 사양을 상품명에서 확인하지 못함');
  else okAxis('spec', '상품명에서 사양을 확인함');

  if ((c && (c.budgetMax || c.budgetMin)) && top.fit && /초과|미만/.test(top.fit)) {
    lower('data', 'medium', '1위 상품이 말한 예산을 벗어남');
  }

  /* ── 아래 두 축은 근거가 주어졌을 때만 판정한다 ──────────────────
   *
   * opts 를 넘기지 않으면 level 이 null 로 남고 종합 확신도에 영향을 주지
   * 않는다. 그래서 기존 호출부의 결과가 달라지지 않는다.
   */
  const deal = opts && opts.deal;
  if (deal && deal.freshness) {
    if (!deal.freshness.trusted) lower('freshness', 'medium', deal.freshness.label);
    else okAxis('freshness', deal.freshness.label);
  }

  const profile = opts && opts.profile;
  if (profile) {
    if (profile.neutral) okAxis('preference', '취향을 말하지 않아 일반 기준으로 판단함');
    else if (profile.weak) lower('preference', 'medium', '취향 신호가 약해 반영 폭이 작음');
    else okAxis('preference', '사용자가 말한 취향을 반영함');
  }

  // 데이터 축은 다른 축들의 요약이다 — 따로 낮출 일이 없었으면 나머지 중 최악.
  if (!axes.data.level) {
    let worst = null;
    CONF_AXES.forEach(a => {
      if (a === 'data') return;
      const l = axes[a].level;
      if (l && (!worst || CONF_RANK[l] > CONF_RANK[worst])) worst = l;
    });
    axes.data.level = worst;
  }

  CONF_AXES.forEach(a => { axes[a].label = axes[a].level ? CONFIDENCE_LABEL[axes[a].level] : ''; });

  if (!reasons.length) reasons.push('예산·요구 조건·가격 기록이 모두 확인됨');
  return { confidence: level, label: CONFIDENCE_LABEL[level], reasons, axes };
}

function emptyAxes(level, why) {
  const axes = {};
  CONF_AXES.forEach(a => {
    axes[a] = { level, label: CONFIDENCE_LABEL[level], reasons: why ? [why] : [] };
  });
  return axes;
}

/**
 * 축별 확신도를 프롬프트에 실을 문장으로.
 *
 * ★ 모델이 확신도를 스스로 만들지 못하게, 여기서 계산한 값만 준다.
 */
function confidenceBlock(conf) {
  if (!conf || !conf.axes) return '';
  const rows = CONF_AXES
    .filter(a => a !== 'data' && conf.axes[a] && conf.axes[a].level)
    .map(a => `    ${CONF_AXIS_LABEL[a]}: ${conf.axes[a].label}` +
      (conf.axes[a].reasons.length ? ` — ${conf.axes[a].reasons[0]}` : ''));
  if (!rows.length) return '';

  const L = ['[확신도 — 코드가 계산했다. 다시 매기지 마라]'];
  L.push(`  종합: ${conf.label}`);
  L.push('  근거별:');
  rows.forEach(r => L.push(r));
  L.push('- ★ 종합 확신도는 가장 약한 근거를 따른다. 좋은 축만 골라 말하지 마라.');
  return L.join('\n');
}

/* ==================================================================
 *  5) 반사실 대안 (Counterfactual)
 *
 *  "지금 기준으로는 A 지만, 가격만 본다면 C 다."
 *  사용자가 자기 기준을 이해하게 만드는 것이 1위 하나보다 쓸모 있다.
 *
 *  ★ 계산할 데이터가 없으면 null. 성능 비교는 수치 사양이 둘 이상
 *    맞물릴 때만 한다 — 없는 근거로 "성능 최고"를 만들지 않는다.
 * ================================================================== */

/** 크면 좋은 수치 사양 (성능 비교에 쓸 수 있는 것) */
/** 사람이 읽는 사양 이름 (프롬프트 문장에 그대로 들어간다) */
const SPEC_NAME = {
  ram_gb: '램', storage_gb: '저장 용량', battery_mah: '배터리 용량',
  refresh_hz: '주사율', capacity_ml: '용량'
};

const HIGHER_IS_BETTER = ['ram_gb', 'storage_gb', 'battery_mah', 'refresh_hz', 'capacity_ml'];

/*
 * 이번 후보들의 대표 카테고리.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────
 *
 * 사양 비교에 카테고리가 없으면 "이 노트북은 용량이 더 큽니다"(텀블러의 ml
 * 규칙) 같은 말이 나온다. 숫자는 상품명에서 온 진짜 값이라 firewall 에도
 * 안 걸린다 — 사실이지만 무의미한 비교라 더 나쁘다.
 *
 * 후보 다수가 같은 카테고리면 그것을 기준으로 삼는다. 제각각이면 빈 문자열을
 * 돌려 제한하지 않는다(모르면 좁히지 않는다).
 */
function dominantCategory(list) {
  const count = {};
  (list || []).forEach(it => {
    const c = detectCategory(it && it.title);
    if (c) count[c] = (count[c] || 0) + 1;
  });
  const keys = Object.keys(count);
  if (!keys.length) return '';
  const top = keys.reduce((a, b) => (count[b] > count[a] ? b : a));
  // 과반이 같은 카테고리일 때만 믿는다.
  return count[top] * 2 >= (list || []).length ? top : '';
}

function alternatives(ranked, c) {
  const list = (ranked || []).filter(it => it && Math.round(Number(it.price) || 0) > 0);
  const out = { cheapest: null, bestValue: null, bestPerformance: null,
    bestPriceTiming: null, ifBudgetFlexible: null };
  if (list.length < 2) return out;

  const top = list[0];

  /* 가장 싼 것 — 1위와 다를 때만 의미가 있다 */
  const cheap = list.reduce((a, b) => (b.price < a.price ? b : a), list[0]);
  if (cheap !== top) out.cheapest = { ref: cheap.ref, why: `현재가 ${won(cheap.price)}원으로 후보 중 가장 낮음` };

  /* 가격 대비 — 30일 평균 대비 할인폭이 가장 큰 것 */
  const valued = list.filter(it => it.hist && it.hist.avg30 > 0);
  if (valued.length >= 2) {
    const best = valued.reduce((a, b) => {
      const ra = 1 - a.price / a.hist.avg30;
      const rb = 1 - b.price / b.hist.avg30;
      return rb > ra ? b : a;
    });
    const pct = Math.round((1 - best.price / best.hist.avg30) * 100);
    if (best !== top && pct >= 3) {
      out.bestValue = { ref: best.ref, why: `30일 평균보다 ${pct}% 낮아 기록 대비 폭이 가장 큼` };
    }
  }

  /*
   * 성능 — 수치 사양이 비교 가능할 때만.
   *
   * 두 상품 이상이 같은 사양 항목을 가지고 있어야 "더 좋다"를 말할 수 있다.
   * 한쪽에만 있는 값으로 순위를 매기면 "제목에 안 쓴 상품"이 자동으로 진다.
   */
  const category = dominantCategory(list);
  const comparable = HIGHER_IS_BETTER.filter(k =>
    specMatters(category, k) &&
    list.filter(it => it.spec && it.spec.specs && it.spec.specs[k] !== undefined).length >= 2);
  if (comparable.length) {
    let best = null, bestWins = -1, evidence = '';
    list.forEach(it => {
      if (!it.spec || !it.spec.specs) return;
      let wins = 0;
      const parts = [];
      comparable.forEach(k => {
        const v = it.spec.specs[k];
        if (v === undefined) return;
        const others = list
          .filter(o => o !== it && o.spec && o.spec.specs && o.spec.specs[k] !== undefined)
          .map(o => o.spec.specs[k]);
        // 내부 키(battery_mah)가 아니라 사람이 읽는 이름으로 남긴다 —
        // 이 문자열은 프롬프트를 거쳐 답변에 그대로 나올 수 있다.
        if (others.length && v > Math.max.apply(null, others)) { wins++; parts.push(SPEC_NAME[k] || k); }
      });
      if (wins > bestWins) { bestWins = wins; best = it; evidence = parts.join('·'); }
    });
    if (best && best !== top && bestWins > 0) {
      out.bestPerformance = { ref: best.ref, why: `확인된 수치 사양(${evidence})이 후보 중 가장 높음` };
    }
  }

  /*
   * 가격 시점 — 기록상 지금이 가장 좋은 때인 상품.
   *
   * "지금 사기 좋은 것만 본다면?" 에 답한다. verdict 는 코드가 이미
   * 결정해 두었으므로(assess) 그것을 그대로 쓴다. good 이 여럿이면
   * 최저가에 가장 가까운 쪽을 고른다.
   */
  const timely = list.filter(it => it.verdict && it.verdict.verdict === 'good'
    && it.hist && it.hist.low > 0);
  if (timely.length) {
    const best = timely.reduce((a, b) => {
      const ra = a.price / a.hist.low;
      const rb = b.price / b.hist.low;
      return rb < ra ? b : a;
    });
    if (best !== top) {
      const pct = Math.round((best.price / best.hist.low - 1) * 100);
      out.bestPriceTiming = {
        ref: best.ref,
        why: pct <= 0 ? '기록상 최저가 수준' : `기록상 최저가보다 ${pct}%밖에 높지 않음`
      };
    }
  }

  /*
   * 예산을 풀면 — 예산 때문에 밀린 상품이 있는가.
   *
   * 예산 감점을 뺀 점수로 다시 세워, 1위가 바뀌면 그것이 답이다.
   * 예산이 없으면 이 질문 자체가 성립하지 않는다.
   */
  if (c && c.budgetMax) {
    const over = list.filter(it => it.price > c.budgetMax);
    if (over.length) {
      /*
       * 예산 성분을 정확히 걷어낸 점수로 다시 세운다.
       *
       * 처음에는 초과 감점만 대략 되돌렸는데(+45), 그러면 예산 안 상품이
       * 받은 가점(+50)이 그대로 남아 예산이 여전히 이긴다. 결국 이 대안이
       * 거의 나오지 않았다. 양쪽 모두에서 예산 몫을 빼야 "예산을 빼고 보면
       * 무엇이 낫나"라는 질문에 답이 된다.
       * (_shopintent.scoreItem 이 budgetScore 를 함께 돌려준다)
       */
      const neutral = it => (Number(it._score) || 0) - (Number(it._budgetScore) || 0);
      const flex = list.reduce((a, b) => (neutral(b) > neutral(a) ? b : a), list[0]);
      if (flex !== top && flex.price > c.budgetMax) {
        out.ifBudgetFlexible = {
          ref: flex.ref,
          why: `예산을 ${won(flex.price - c.budgetMax)}원 더 쓰면 조건 적합도가 가장 높아짐`
        };
      }
    }
  }

  return out;
}

/* ==================================================================
 *  5.5) 추천을 뒤집는 조건 (Flip Conditions)
 *
 *  ── 이것이 SEOSA 의 핵심 기능이다 ──────────────────────────────
 *
 *  "A를 추천합니다"는 답이다. 그런데 사용자가 정말 알고 싶은 것은 종종
 *  그 다음이다 — "내가 뭘 다르게 생각하면 답이 달라지지?"
 *
 *  쇼핑에서 진짜 어려운 것은 상품을 찾는 게 아니라 자기 기준을 정하는
 *  일이다. 예산을 조금 더 쓸지, 배터리를 포기할지, 성능을 포기할지.
 *  그 기준이 정해지면 상품은 따라온다.
 *
 *    "배터리를 더 중요하게 보면 B"
 *    "예산을 30만원까지 늘리면 D"
 *    "가격을 15만원 이하로 낮추면 C"
 *
 *  이 세 줄이 있으면 사용자는 목록을 다시 훑지 않아도 자기 선택을 이해한다.
 *  가격비교 사이트가 못 하는 일이고, 일반 챗봇은 지어낼 수밖에 없는 일이다.
 *
 *  ── 어떻게 계산하는가 ──────────────────────────────────────────
 *
 *  가정을 하나씩 바꿔서 실제로 다시 줄 세운다. 1위가 바뀌면 그것이 답이다.
 *  모델에게 "만약에"를 상상시키지 않는다 — 같은 랭킹 코드를 다시 돌린다.
 *
 *  ★ 원본을 건드리지 않는다. rankItems 는 상품에 fit·notes·_score 를
 *    써 넣으므로, 반드시 복제본으로 돌려야 실제 추천이 오염되지 않는다.
 * ================================================================== */

/** 랭킹이 읽고 쓰는 필드만 복제한다. 원본은 그대로 둔다. */
function cloneForRank(it) {
  return {
    productId: it.productId, title: it.title, mall: it.mall, price: it.price,
    listPrice: it.listPrice, discountPct: it.discountPct, refHighPrice: it.refHighPrice,
    trust: it.trust, hist: it.hist, spec: it.spec, specLine: it.specLine,
    featureHit: it.featureHit, featureMiss: it.featureMiss, ref: it.ref
  };
}

/** 프롬프트에 실을 만한 가정만 고른다. 너무 많으면 읽히지 않는다. */
const MAX_FLIPS = 3;

/**
 * 조건을 바꾸면 1위가 무엇이 되는가.
 *
 * @param {Array}  ranked  현재 랭킹 (1위가 ranked[0])
 * @param {object} c       현재 조건
 * @param {Array}  wanted  현재 요구 기능
 * @param {Function} rank  랭킹 함수 (_shopintent.rankItems) — 순환 참조를 피해 주입받는다
 * @param {Function} match 기능 대조 함수 (_specs.matchFeatures)
 * @returns {Array<{change:string, ref:string, productId:string}>}
 */
function flipConditions(ranked, c, wanted, rank, match) {
  const list = (ranked || []).filter(Boolean);
  if (list.length < 2 || typeof rank !== 'function') return [];

  const cons = c || {};
  const want = wanted || [];
  const topId = list[0].productId;
  const out = [];

  /** 가정 하나를 돌려 본다. 1위가 바뀌면 기록한다. */
  const tryFlip = (label, newCons, newWanted) => {
    if (out.length >= MAX_FLIPS) return;
    const copies = list.map(cloneForRank);
    // 요구 기능이 바뀌면 충족 여부도 다시 계산해야 한다.
    if (newWanted && typeof match === 'function') {
      copies.forEach(it => {
        const m = match(it.spec, newWanted);
        it.featureHit = m.hit;
        it.featureMiss = m.miss;
      });
    }
    let re;
    try { re = rank(copies, newCons, ''); }
    catch (e) { return; }                      // 가정 하나가 실패해도 나머지는 계속
    if (!re.length || re[0].productId === topId) return;
    if (out.some(x => x.productId === re[0].productId)) return;   // 같은 상품 중복 금지
    // ref 는 현재 랭킹 기준으로 되찾는다(복제본의 ref 는 옛 자리다).
    const orig = list.find(x => x.productId === re[0].productId);
    out.push({ change: label, ref: (orig && orig.ref) || re[0].ref, productId: re[0].productId });
  };

  /* ── ① 예산을 늘리면 ── */
  if (cons.budgetMax && list.some(it => it.price > cons.budgetMax)) {
    // 실제로 존재하는 상품 가격에 맞춰 제안한다 — 임의의 숫자를 만들지 않는다.
    const overPrices = list.filter(it => it.price > cons.budgetMax).map(it => it.price).sort((a, b) => a - b);
    const target = overPrices[0];
    tryFlip(`예산을 ${won(target)}원까지 늘리면`,
      Object.assign({}, cons, { budgetMax: target, budgetSoft: true }), null);
  }

  /* ── ② 예산을 낮추면 ── */
  if (cons.budgetMax) {
    const under = list.filter(it => it.price > 0 && it.price < cons.budgetMax).map(it => it.price).sort((a, b) => a - b);
    // 1위보다 싼 상품이 있어야 "낮추면"이 뜻을 가진다.
    if (under.length && under[0] < list[0].price) {
      tryFlip(`예산을 ${won(under[0])}원 이하로 낮추면`,
        Object.assign({}, cons, { budgetMax: under[0], budgetSoft: false }), null);
    }
  }

  /* ── ③ 취향을 바꾸면 ── */
  if (cons.priority !== 'price') {
    tryFlip('가격을 최우선으로 보면', Object.assign({}, cons, { priority: 'price' }), null);
  }
  if (cons.priority !== 'quality') {
    tryFlip('성능·품질을 최우선으로 보면', Object.assign({}, cons, { priority: 'quality' }), null);
  }

  /* ── ④ 다른 기능을 중요하게 보면 ── */
  if (typeof match === 'function') {
    /*
     * 후보 중 일부만 가진 기능이 후보를 가르는 기능이다.
     * 전부 가졌거나 아무도 없는 기능은 순위를 바꾸지 못하므로 시도하지 않는다.
     */
    const tally = {};
    list.forEach(it => {
      ((it.spec && it.spec.features) || []).forEach(f => { tally[f] = (tally[f] || 0) + 1; });
    });
    Object.keys(tally)
      .filter(f => tally[f] > 0 && tally[f] < list.length && want.indexOf(f) < 0)
      .sort()                                  // 결정론 — 객체 키 순서에 기대지 않는다
      .forEach(f => tryFlip(`${eulr(f)} 더 중요하게 보면`, cons, want.concat([f])));
  }

  /* ── ⑤ 요구 기능을 빼면 ── */
  if (want.length) {
    tryFlip('요구 기능을 빼고 가격·기록만 보면', cons, []);
  }

  return out.slice(0, MAX_FLIPS);
}

/* ==================================================================
 *  6) 왜 저건 아닌가 (Why Not Engine)
 *
 *  ★ 추천하지 않은 상품의 장점을 숨기지 않는다.
 *    "이걸 권하지만 저건 이 부분이 낫다"를 말할 수 있어야 신뢰가 생긴다.
 * ================================================================== */

function won(v) {
  return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 1위와 다른 후보 하나를 가른 결정적 요인.
 * @returns {{ref:string, decisive:Array<{factor:string,evidence:string}>, strengths:string[]}}
 */
function whyNotOne(top, other, c) {
  const decisive = [];
  const strengths = [];
  // ref 는 늘 문자열이다 — 호출부가 `w.ref` 를 그대로 문장에 끼운다.
  if (!top || !other) return { ref: (other && other.ref) || '', decisive, strengths };

  const cons = c || {};
  const tp = Math.round(Number(top.price) || 0);
  const op = Math.round(Number(other.price) || 0);

  /* 예산 */
  if (cons.budgetMax) {
    const topIn = tp <= cons.budgetMax;
    const otherIn = op <= cons.budgetMax;
    if (topIn && !otherIn) {
      decisive.push({ factor: '예산', evidence: `${won(op)}원으로 예산 ${won(cons.budgetMax)}원을 넘음` });
    }
  }

  /* 가격 자체 */
  if (tp > 0 && op > 0 && tp !== op) {
    if (op > tp) decisive.push({ factor: '가격', evidence: `${won(op - tp)}원 더 비쌈` });
    else strengths.push(`${won(tp - op)}원 더 저렴`);
  }

  /* 요구 기능 */
  const tHit = new Set(Array.isArray(top.featureHit) ? top.featureHit : []);
  const oHit = new Set(Array.isArray(other.featureHit) ? other.featureHit : []);
  const onlyTop = [...tHit].filter(f => !oHit.has(f));
  const onlyOther = [...oHit].filter(f => !tHit.has(f));
  if (onlyTop.length) {
    decisive.push({ factor: '요구 기능', evidence: `${iga(onlyTop.join('·'))} 상품명에서 확인되지 않음` });
  }
  if (onlyOther.length) strengths.push(`${eunn(onlyOther.join('·'))} 이쪽에서 확인됨`);

  /* 가격 기록 */
  const tv = top.verdict && top.verdict.verdict;
  const ov = other.verdict && other.verdict.verdict;
  if (tv === 'good' && ov === 'wait') {
    decisive.push({ factor: '가격 시점', evidence: '기록 대비 지금이 유리한 시점이 아님' });
  } else if (ov === 'good' && tv !== 'good') {
    strengths.push('가격 기록상으로는 이쪽이 더 유리한 시점');
  }

  /* 수치 사양 — 양쪽 모두 값이 있을 때만 */
  const ts = (top.spec && top.spec.specs) || {};
  const os = (other.spec && other.spec.specs) || {};
  // 이 카테고리에서 의미 있는 사양만 비교한다(노트북에 ml 을 들이대지 않는다).
  const cat = detectCategory(top.title) || detectCategory(other.title);
  HIGHER_IS_BETTER.forEach(k => {
    if (!specMatters(cat, k)) return;
    if (ts[k] === undefined || os[k] === undefined) return;
    if (os[k] > ts[k]) strengths.push(`${iga(SPEC_NAME[k] || k)} 더 큼`);
  });

  return { ref: other.ref, decisive, strengths };
}

/* ==================================================================
 *  7) 종합 — decide()
 * ================================================================== */

const RECOMMEND_LABEL = {
  strong:   '자신 있게 권함',
  moderate: '권할 만함',
  caution:  '조건은 맞지만 주의할 점 있음',
  weak:     '지금은 권하기 어려움'
};

/** 1위에게 붙일 추천 강도. 확신도와 후회 위험을 함께 본다. */
function recommendLevel(confidence, regret, fitOk) {
  if (!fitOk || regret.level === 'high') return 'weak';
  if (confidence === 'high' && regret.level === 'low') return 'strong';
  if (regret.level === 'medium') return 'caution';
  return 'moderate';
}

/**
 * 결정 데이터를 만든다.
 *
 * @param {Array}  ranked  랭킹된 상품 (ref·fit·notes·_score·spec·verdict 포함)
 * @param {object} c       조건
 * @param {Array}  wanted  요구 기능
 * @param {string} prevTop 직전 응답의 1위 productId (없으면 '')
 * @returns {object|null}  후보가 없으면 null
 */
function decide(ranked, c, wanted, prevTop, deps) {
  const list = (ranked || []).filter(Boolean);
  if (!list.length) return null;

  const cons = c || {};
  const want = wanted || [];
  const top = list[0];

  const margin = computeMargin(list);
  const confidence = computeConfidence(list, margin, cons, want);
  const regret = computeRegret(top, cons, want);
  const opportunity = priceOpportunity(top);

  // 예산을 벗어났는가 (추천 강도에 쓴다)
  const fitOk = !(cons.budgetMax && top.price > cons.budgetMax && !cons.budgetSoft);

  /* 상위 후보 2개까지만 "왜 저건 아닌가"를 만든다. 그 아래는 사용자가 묻지 않는다. */
  const whyNot = list.slice(1, 3).map(o => whyNotOne(top, o, cons));

  /* 포기하는 것 — 추천 상품에도 아쉬운 점이 있다 */
  const tradeoffs = [];
  (Array.isArray(top.featureMiss) ? top.featureMiss : []).forEach(f => {
    tradeoffs.push(`${eunn(f)} 상품명에서 확인되지 않음(없다는 뜻은 아님)`);
  });
  if (!top.specLine) tradeoffs.push('상품명에 사양 표기가 없어 성능 비교가 어려움');
  if (!top.hist || !(top.hist.count > 0)) tradeoffs.push('가격 기록이 없어 지금 값이 좋은지 판단할 수 없음');
  whyNot.forEach(w => w.strengths.forEach(s => {
    const t = `다른 후보(${w.ref})가 나은 점: ${s}`;
    if (tradeoffs.indexOf(t) < 0) tradeoffs.push(t);
  }));

  /* 결정적 이유 — 실제로 점수를 만든 것들만 */
  const decisive = [];
  if (top.fit) decisive.push(top.fit);
  (Array.isArray(top.notes) ? top.notes : []).forEach(n => {
    if (n && !/확인 안 됨/.test(n) && decisive.length < 4) decisive.push(n);
  });

  /* 추천이 바뀌었는가 — 직전 1위와 비교 */
  let change = null;
  if (prevTop && top.productId && String(prevTop) !== String(top.productId)) {
    change = {
      changed: true,
      previousTop: String(prevTop),
      currentTop: String(top.productId),
      cause: want.length ? `요구 조건(${want.join('·')}) 반영`
        : (cons.budgetMax ? '예산 조건 반영' : '조건 변경')
    };
  }

  /* 결정 근거 추적 — "왜 이걸 추천했어?"에 다시 추측하지 않고 답하기 위해 */
  const constraintsUsed = [];
  if (cons.budgetMax) constraintsUsed.push(`budget<=${cons.budgetMax}${cons.budgetSoft ? '(soft)' : ''}`);
  if (cons.budgetMin) constraintsUsed.push(`budget>=${cons.budgetMin}`);
  if (cons.priority) constraintsUsed.push(`priority=${cons.priority}`);
  if (cons.recipient) constraintsUsed.push(`recipient=${cons.recipient}`);
  if (cons.brand) constraintsUsed.push(`brand=${cons.brand}`);
  want.forEach(f => constraintsUsed.push(`feature=${f}`));

  const evidenceUsed = ['current_price'];
  if (list.some(it => it.hist)) evidenceUsed.push('price_history');
  if (list.some(it => it.specLine)) evidenceUsed.push('product_title_spec');
  if (list.some(it => it.trust)) evidenceUsed.push('price_trust');

  return {
    top: { ref: top.ref, productId: top.productId },
    recommendation: recommendLevel(confidence.confidence, regret, fitOk),
    recommendationLabel: RECOMMEND_LABEL[recommendLevel(confidence.confidence, regret, fitOk)],
    margin,
    confidence,
    regret: { level: regret.level, label: REGRET_LABEL[regret.level], reasons: regret.reasons },
    opportunity,
    decisive,
    tradeoffs,
    whyNot,
    alternatives: alternatives(list, cons),
    /*
     * 추천을 뒤집는 조건 (flipConditions 주석 참고).
     *
     * rank/match 를 주입받는다 — _decision 이 _shopintent 를 직접 require 하면
     * 순환 참조가 된다(_shopintent → _specs, _decision → _specs). 호출부가
     * 넘겨주지 않으면 이 항목만 비고 나머지 결정은 그대로 나온다.
     */
    flips: flipConditions(list, cons, want,
      deps && deps.rank, deps && deps.matchFeatures),
    change,
    trace: {
      constraintsUsed,
      evidenceUsed,
      rankingFactors: ['budgetFit', 'featureFit', 'priceTiming', 'priceTrust', 'keywordMatch'],
      decisiveReason: decisive.slice(0, 3).join(' + ') || '조건 대조 결과'
    }
  };
}

/* ==================================================================
 *  8) 프롬프트용 렌더
 *
 *  ★ 점수를 적지 않는다. 사용자에게 "AI Score 91.42" 는 아무 뜻이 없고,
 *    모델이 그 숫자를 답변에 옮기면 근거 없는 권위가 된다.
 *    라벨과 사실 문장만 넘긴다.
 * ================================================================== */

const REF_NAME = {
  cheapest: '가격만 본다면',
  bestValue: '기록 대비 폭만 본다면',
  bestPerformance: '확인된 사양만 본다면',
  bestPriceTiming: '지금 사기 좋은 때만 본다면',
  ifBudgetFlexible: '예산을 더 쓸 수 있다면'
};

/** 결정 데이터를 프롬프트 블록 한 덩어리로. 없으면 빈 문자열. */
function decisionBlock(d) {
  if (!d) return '';
  const L = ['[결정 데이터]  ※ 코드가 계산한 결론이다. 다시 계산하거나 뒤집지 마라.'];

  L.push(`  1위: ${d.top.ref} — ${d.recommendationLabel}`);
  if (d.decisive.length) L.push(`  결정적 이유: ${d.decisive.join(' / ')}`);
  L.push(`  1·2위 격차: ${d.margin.label}`);
  L.push(`  추천 확신도: ${d.confidence.label} (${d.confidence.reasons.join(' / ')})`);
  L.push(`  후회 위험: ${d.regret.label}${d.regret.reasons.length ? ` — ${d.regret.reasons.join(' / ')}` : ''}`);

  if (d.opportunity.opportunity !== 'unknown' || d.opportunity.caution) {
    L.push(`  가격 기회: ${d.opportunity.label}`
      + (d.opportunity.reasons.length ? ` (${d.opportunity.reasons.join(' / ')})` : '')
      + (d.opportunity.caution ? ` ※ ${d.opportunity.caution}` : ''));
  }

  if (d.tradeoffs.length) L.push(`  포기하는 것: ${d.tradeoffs.slice(0, 3).join(' / ')}`);

  const alt = [];
  Object.keys(REF_NAME).forEach(k => {
    const a = d.alternatives[k];
    if (a) alt.push(`${REF_NAME[k]} ${a.ref}(${a.why})`);
  });
  if (alt.length) L.push(`  다른 기준이라면: ${alt.join(' / ')}`);

  /*
   * ★ 이 줄이 SEOSA 를 가격비교 사이트와 가르는 자리다.
   *   "무엇을 바꾸면 답이 달라지는가" 는 코드가 실제로 다시 줄 세워 본 결과다.
   *   모델이 상상해서 지어내면 안 되므로 계산된 것만 그대로 싣는다.
   */
  if (d.flips && d.flips.length) {
    L.push('  추천을 바꿀 수 있는 조건: '
      + d.flips.map(f => `${f.change} ${f.ref}`).join(' / '));
  }

  d.whyNot.forEach(w => {
    if (!w.decisive.length && !w.strengths.length) return;
    const parts = [];
    if (w.decisive.length) parts.push(w.decisive.map(x => `${x.factor}: ${x.evidence}`).join(', '));
    if (w.strengths.length) parts.push(`다만 ${w.strengths.join(', ')}`);
    L.push(`  ${w.ref}를 고르지 않은 이유: ${parts.join(' — ')}`);
  });

  if (d.change) L.push(`  ★ 추천이 바뀌었다: 이전 1위와 다르다 (원인: ${d.change.cause}). 왜 바뀌었는지 한 줄로 밝혀라.`);

  return L.join('\n');
}

module.exports = {
  decide, decisionBlock,
  computeMargin, computeConfidence, computeRegret, priceOpportunity,
  confidenceBlock, CONF_AXES, CONF_AXIS_LABEL,
  alternatives, whyNotOne, recommendLevel, flipConditions, dominantCategory,
  MARGIN_LABEL, CONFIDENCE_LABEL, REGRET_LABEL, OPPORTUNITY_LABEL, RECOMMEND_LABEL,
  MARGIN_DOMINANT, MARGIN_CLEAR, MARGIN_CLOSE
};
