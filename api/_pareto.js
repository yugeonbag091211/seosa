/*
 * 다목적 분석 — 지배 구조 · 예산 탄력성 · 한계효용 · 대체품.
 *
 * ── 왜 순위 하나로는 부족한가 ───────────────────────────────────
 *
 * 랭킹은 "이게 1등"이라고 답한다. 그런데 사용자가 실제로 막히는 지점은
 * 그게 아니다.
 *
 *   "5만원 더 쓰면 뭐가 달라져?"
 *   "이거 너무 비싼데 비슷한 거 없어?"
 *   "그래서 A가 다 나은 거야, 아니면 취향 문제야?"
 *
 * 이건 순위가 아니라 후보 집합 전체의 모양에 대한 질문이다. 한 상품이
 * 모든 면에서 나은지(지배), 서로 장단점이 갈리는지(트레이드오프),
 * 돈을 더 쓰면 실제로 좋아지는지(탄력성) — 전부 계산할 수 있는 것들이고,
 * 계산하지 않으면 모델이 지어낸다.
 *
 * ── 지켜야 할 선 ────────────────────────────────────────────────
 *
 * ★ 없는 축으로 비교하지 않는다. 비교하려면 양쪽 모두 값이 있어야 한다.
 * ★ 후보가 실제로 있을 때만 만든다. 자리를 채우려고 억지로 5개를 만들지 않는다.
 * ★ 점수를 사용자에게 보이지 않는다. 여기 나가는 것은 사실 문장뿐이다.
 * ★ 결정적이다. 같은 입력이면 같은 결과가 나온다.
 */

/*
 * 비교에 쓰는 축.
 *
 * _shopintent.scoreItem 이 남긴 sub 점수를 그대로 쓴다. 여기서 다시
 * 계산하면 랭킹과 어긋날 수 있고, 어긋나면 "1등인데 어느 축에서도
 * 이기지 않는" 이상한 결과가 나온다.
 */
const AXES = ['budget', 'feature', 'value', 'timing', 'trust', 'deal', 'brand'];

/** 축 이름 → 사람이 읽는 말 */
const AXIS_LABEL = {
  budget: '예산 적합', feature: '요구 기능', value: '가격 대비',
  timing: '구매 시점', trust: '가격 신뢰도', deal: '할인폭', brand: '브랜드'
};

/** 두 점수가 "의미 있게" 다른가. 소수점 흔들림을 차이로 세지 않는다. */
const AXIS_EPS = 1;

function subOf(it) {
  return (it && it._sub) || {};
}

/**
 * a 가 b 를 지배하는가 — 모든 축에서 뒤지지 않고, 하나 이상에서 앞선다.
 *
 * 다목적 최적화의 표준 정의다. 지배당하는 상품은 "어느 기준으로 봐도
 * 저것보다 나을 게 없는" 상품이므로 대안으로 제시할 이유가 없다.
 */
function dominates(a, b) {
  const sa = subOf(a), sb = subOf(b);
  let better = false;
  for (const ax of AXES) {
    const va = Number(sa[ax]) || 0;
    const vb = Number(sb[ax]) || 0;
    if (va < vb - AXIS_EPS) return false;      // 하나라도 뒤지면 지배가 아니다
    if (va > vb + AXIS_EPS) better = true;
  }
  return better;
}

/**
 * 후보 집합의 모양을 분류한다 (지시 6항).
 *
 *   dominant  1위가 다른 모두를 지배한다 — 고민할 것이 없다
 *   tradeoff  서로 장단점이 갈린다 — 사용자의 기준이 답을 정한다
 *   pareto    어느 것도 뚜렷이 낫지 않다 — 취향 문제다
 *
 * @returns {{shape:string, label:string, front:Array}}
 *   front — 아무에게도 지배당하지 않는 후보(파레토 프론트)
 */
const SHAPE_LABEL = {
  dominant: '1위가 모든 기준에서 앞선다',
  tradeoff: '기준에 따라 답이 갈린다',
  pareto:   '후보들이 서로 다른 장점을 가진다',
  single:   '후보가 하나뿐이다',
  none:     '후보가 없다'
};

function classify(ranked) {
  const list = (ranked || []).filter(Boolean);
  if (!list.length) return { shape: 'none', label: SHAPE_LABEL.none, front: [] };
  if (list.length === 1) return { shape: 'single', label: SHAPE_LABEL.single, front: list.slice() };

  const front = list.filter(a => !list.some(b => b !== a && dominates(b, a)));
  const top = list[0];
  const topDominatesAll = list.every(b => b === top || dominates(top, b));

  const shape = topDominatesAll ? 'dominant' : (front.length > 1 ? 'tradeoff' : 'pareto');
  return { shape, label: SHAPE_LABEL[shape], front };
}

/**
 * 각 상품이 어느 축에서 앞서는가 — "이건 이게 낫다"의 근거.
 *
 * @returns {Array<{ref, axes:string[]}>} 축이 하나도 없으면 목록에서 뺀다
 */
function strengthsByAxis(ranked) {
  const list = (ranked || []).filter(Boolean);
  if (list.length < 2) return [];
  return list.map(it => {
    const s = subOf(it);
    const axes = AXES.filter(ax => {
      const v = Number(s[ax]) || 0;
      // 이 축에서 자기가 최고여야 "앞선다"고 말할 수 있다.
      const best = Math.max.apply(null, list.map(o => Number(subOf(o)[ax]) || 0));
      return v > 0 && v >= best - AXIS_EPS && list.some(o => o !== it && (Number(subOf(o)[ax]) || 0) < v - AXIS_EPS);
    }).map(ax => AXIS_LABEL[ax]);
    return { ref: it.ref, axes };
  }).filter(x => x.axes.length);
}

/* ==================================================================
 *  예산 탄력성 (지시 14항)
 *
 *  "얼마 더 쓰면 뭐가 달라지나."
 *
 *  이 질문은 추천 하나보다 의사결정에 훨씬 크게 기여한다. 사용자가
 *  진짜로 정하지 못하는 것은 상품이 아니라 예산이기 때문이다.
 * ================================================================== */

function won(v) {
  return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 예산을 바꾸면 1위가 어떻게 달라지는가.
 *
 * ★ 임의의 금액을 만들지 않는다. 실제 후보 가격을 구간 경계로 쓴다 —
 *   "13만원으로 늘리면" 같은 말은 그 가격의 상품이 있을 때만 뜻이 있다.
 *
 * @param {Array}  ranked 현재 랭킹
 * @param {object} c      현재 조건
 * @param {Function} rank 랭킹 함수 (_shopintent.rankItems) — 주입받는다
 * @param {Function} clone 상품 복제 함수 (원본 오염 방지)
 * @returns {Array<{budget:number, ref:string, productId:string, price:number}>}
 */
function budgetElasticity(ranked, c, rank, clone) {
  const list = (ranked || []).filter(it => it && Math.round(Number(it.price) || 0) > 0);
  if (list.length < 2 || typeof rank !== 'function' || typeof clone !== 'function') return [];

  const cons = c || {};
  // 후보 가격을 오름차순으로 — 이것이 의미 있는 예산 구간의 경계다.
  const points = [...new Set(list.map(it => Math.round(it.price)))].sort((a, b) => a - b);
  if (points.length < 2) return [];

  const steps = [];
  let lastId = null;
  points.forEach(budget => {
    let re;
    try {
      re = rank(list.map(clone), Object.assign({}, cons, { budgetMax: budget, budgetSoft: false }), '');
    } catch (e) { return; }
    if (!re.length) return;
    const winner = re[0];
    // 1위가 바뀌는 지점만 기록한다. 같은 답이 반복되면 정보가 아니다.
    if (winner.productId === lastId) return;
    lastId = winner.productId;
    const orig = list.find(x => x.productId === winner.productId);
    steps.push({
      budget,
      ref: (orig && orig.ref) || winner.ref,
      productId: winner.productId,
      price: Math.round(winner.price)
    });
  });

  return steps;
}

/**
 * 탄력성을 사람이 읽는 한 줄로.
 *
 * "5만원 더 쓰면 B로 바뀌지만, 2만원만 늘리는 것은 차이가 없다" 를
 * 만들기 위한 재료다.
 */
function elasticityLine(steps, cons, currentTopId) {
  if (!steps || steps.length < 2) return '';
  const cur = (cons && cons.budgetMax) || 0;

  /*
   * 양쪽을 다 본다.
   *
   * 처음에는 현재 예산보다 위만 보여 줬는데, 그러면 "예산을 낮추면 뭐가
   * 되나"에 답할 수 없었다. 실제로 후보 전환점은 대부분 현재 예산 아래에
   * 몰려 있다(예산 안 상품들이 거기 있으므로). 낮추는 쪽이 오히려 더 자주
   * 쓸모 있는 정보다 — "8만원으로 줄이면 C" 는 바로 행동으로 이어진다.
   */
  const parts = [];
  steps.forEach(s => {
    if (parts.length >= 3) return;
    if (cur && s.budget === cur) return;                 // 현재와 같은 지점은 정보가 아니다
    /*
     * ★ 지금 1위와 같은 상품으로 가는 지점은 변화가 아니다.
     *   "150,000원까지 낮추면 P1" — 이미 P1 이 답인데 이런 말을 하면
     *   사용자는 무엇이 달라진다는 것인지 알 수 없다.
     */
    if (currentTopId && s.productId === currentTopId) return;
    if (!cur) { parts.push(`${won(s.budget)}원이면 ${s.ref}`); return; }
    parts.push(s.budget < cur
      ? `${won(s.budget)}원까지 낮추면 ${s.ref}`
      : `${won(s.budget)}원까지 늘리면 ${s.ref}`);
  });
  return parts.join(' / ');
}

/* ==================================================================
 *  한계효용 (지시 15항)
 *
 *  "12만원까지는 더 쓸 값어치가 있는데, 15만원부터는 체감이 작다."
 *
 *  ★ "체감"은 심리 표현이 아니라 실제 점수 변화다. 점수가 안 오르면
 *    안 오른다고 말하고, 오르면 얼마나 오르는지 말한다.
 * ================================================================== */

/** 이 정도 점수 상승은 "거의 같다"고 본다. 랭킹 점수 눈금 기준. */
const FLAT_GAIN = 5;

/**
 * 예산 구간별로 1위 상품의 점수가 얼마나 오르는가.
 *
 * @returns {Array<{budget, ref, gain}>} gain 은 직전 구간 대비 상승폭
 */
function diminishingReturns(ranked, c, rank, clone) {
  const steps = budgetElasticity(ranked, c, rank, clone);
  if (steps.length < 2) return [];

  const list = (ranked || []).filter(Boolean);
  const out = [];
  let prevScore = null;

  steps.forEach(s => {
    let re;
    try {
      re = rank(list.map(clone), Object.assign({}, c || {}, { budgetMax: s.budget, budgetSoft: false }), '');
    } catch (e) { return; }
    if (!re.length) return;
    /*
     * 예산 성분을 뺀 점수로 본다.
     *
     * 예산을 올리면 예산 적합 점수가 저절로 오른다 — 그건 "상품이 좋아진
     * 것"이 아니라 "우리가 조건을 푼 것"이다. 그것까지 이득으로 세면
     * 돈을 쓸수록 무조건 좋아진다는 거짓 결론이 나온다.
     */
    const score = (Number(re[0]._score) || 0) - (Number(re[0]._budgetScore) || 0);
    out.push({
      budget: s.budget,
      ref: s.ref,
      gain: prevScore == null ? null : Math.round((score - prevScore) * 10) / 10
    });
    prevScore = score;
  });

  return out;
}

/**
 * 한계효용을 한 줄로. 상승이 멈추는 지점을 짚는다.
 */
function returnsLine(curve) {
  if (!curve || curve.length < 2) return '';
  const parts = [];
  for (let i = 1; i < curve.length && parts.length < 3; i++) {
    const c = curve[i];
    if (c.gain == null) continue;
    parts.push(c.gain >= FLAT_GAIN
      ? `${won(c.budget)}원까지 늘리면 ${c.ref}로 뚜렷하게 나아짐`
      : `${won(c.budget)}원까지 늘려도 나아지는 폭은 작음`);
  }
  return parts.join(' / ');
}

/* ==================================================================
 *  대체품 (지시 13항)
 *
 *  "이거 너무 비싼데" → 조건을 최대한 지키면서 더 싼 것.
 *
 *  ★ 단순히 싼 것을 고르지 않는다. 무엇을 잃고 무엇을 지키는지 계산해서
 *    함께 준다. 잃는 것을 말하지 않는 대체품 제안은 강매와 같다.
 * ================================================================== */

/**
 * @param {object} target 기준 상품 (보통 현재 1위)
 * @param {Array}  ranked 후보 전체
 * @param {object} opts   { cheaperOnly:true } 등
 * @returns {{ref, productId, savedMoney, keptFeatures, lostFeatures, keptAxes, lostAxes}|null}
 */
function substitute(target, ranked, opts) {
  const list = (ranked || []).filter(Boolean);
  if (!target || list.length < 2) return null;

  const tPrice = Math.round(Number(target.price) || 0);
  if (tPrice <= 0) return null;

  const cheaper = list.filter(it => it !== target && Math.round(Number(it.price) || 0) > 0
    && Math.round(it.price) < tPrice);
  if (!cheaper.length) return null;

  /*
   * 조건을 가장 적게 잃는 쪽을 고른다.
   *
   * 잃는 기능 하나가 아낀 돈보다 중요할 수 있으므로, 가격이 아니라
   * "지킨 기능 수"를 먼저 본다. 같으면 더 싼 쪽.
   */
  const tf = new Set(((target.spec && target.spec.features) || []));
  const scored = cheaper.map(it => {
    const f = new Set(((it.spec && it.spec.features) || []));
    const kept = [...tf].filter(x => f.has(x));
    const lost = [...tf].filter(x => !f.has(x));
    return { it, kept, lost };
  }).sort((a, b) => (b.kept.length - a.kept.length) || (a.it.price - b.it.price));

  const best = scored[0];
  if (!best) return null;

  // 어느 축에서 잃고 지켰는가 (기능 말고 점수 축)
  const ts = subOf(target), bs = subOf(best.it);
  const lostAxes = AXES.filter(ax => (Number(bs[ax]) || 0) < (Number(ts[ax]) || 0) - AXIS_EPS)
    .map(ax => AXIS_LABEL[ax]);
  const keptAxes = AXES.filter(ax => (Number(bs[ax]) || 0) >= (Number(ts[ax]) || 0) - AXIS_EPS
    && (Number(ts[ax]) || 0) > 0).map(ax => AXIS_LABEL[ax]);

  return {
    ref: best.it.ref,
    productId: best.it.productId,
    savedMoney: tPrice - Math.round(best.it.price),
    keptFeatures: best.kept,
    lostFeatures: best.lost,
    keptAxes, lostAxes
  };
}

/* ==================================================================
 *  프롬프트 블록
 * ================================================================== */

/**
 * 다목적 분석을 프롬프트 한 덩어리로. 재료가 없으면 빈 문자열.
 *
 * ★ 억지로 채우지 않는다. 계산된 것만 적는다.
 */
function paretoBlock(analysis) {
  if (!analysis) return '';
  const L = [];

  if (analysis.shape && analysis.shape !== 'none' && analysis.shape !== 'single') {
    L.push(`  후보 구조: ${analysis.label}`);
  }
  if (analysis.strengths && analysis.strengths.length) {
    // 상위 셋까지만. 전부 늘어놓으면 읽히지 않고 토큰만 먹는다.
    L.push('  후보별 앞서는 점: '
      + analysis.strengths.slice(0, 3).map(s => `${s.ref}(${s.axes.join('·')})`).join(' / '));
  }
  if (analysis.elasticity) L.push(`  예산을 바꾸면: ${analysis.elasticity}`);
  if (analysis.returns) L.push(`  추가 지출 가치: ${analysis.returns}`);
  if (analysis.substitute) {
    const s = analysis.substitute;
    const lost = s.lostFeatures.length ? `${s.lostFeatures.join('·')}은 확인되지 않음`
      : (s.lostAxes.length ? `${s.lostAxes.join('·')}에서 뒤짐` : '뚜렷이 잃는 것은 없음');
    L.push(`  더 싼 대안: ${s.ref} — ${won(s.savedMoney)}원 절약, 다만 ${lost}`);
  }

  if (!L.length) return '';
  return ['[다목적 분석]  ※ 코드가 계산했다. 여기 없는 비교는 만들지 마라.'].concat(L).join('\n');
}

module.exports = {
  dominates, classify, strengthsByAxis,
  budgetElasticity, elasticityLine,
  diminishingReturns, returnsLine,
  substitute, paretoBlock,
  AXES, AXIS_LABEL, SHAPE_LABEL, AXIS_EPS, FLAT_GAIN
};
