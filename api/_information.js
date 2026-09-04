/*
 * 정보 가치 엔진 — "지금 무엇을 물어야 답이 가장 크게 달라지는가".
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────
 *
 * 쇼핑 AI 가 가장 쉽게 무너지는 지점은 되묻기다.
 *
 *   "예산은요? 용도는요? 브랜드는요? 색상은요?"
 *
 * 사용자는 답을 원해서 물었는데 질문만 네 개를 받는다. 그렇다고 아무것도
 * 묻지 않으면 엉뚱한 것을 추천한다. 문제는 "묻느냐 마느냐"가 아니라
 * "어느 질문이 값어치가 있느냐"다.
 *
 * 값어치는 계산할 수 있다. 질문의 답이 갈릴 수 있는 경우를 각각 넣고
 * 실제로 다시 줄 세워서, 1위가 바뀌는지 보면 된다.
 *
 *   답이 어느 쪽이든 1위가 같다  → 물어봐야 소용없다. 묻지 않는다.
 *   답에 따라 1위가 갈린다        → 이 질문 하나가 추천을 바꾼다. 묻는다.
 *
 * ── 지켜야 할 선 ────────────────────────────────────────────────
 *
 * ★ 후보가 실제로 갈리는 것만 묻는다. 모든 후보가 노이즈캔슬링을 가졌으면
 *   "노캔 필요하세요?"는 물어봐야 답이 안 바뀐다.
 * ★ 선택지는 실제 후보 데이터에서 만든다. "가벼운 쪽 / 성능 좋은 쪽"이라고
 *   물으려면 후보에 실제로 그 차이가 있어야 한다.
 * ★ 하나만 묻는다. 가장 값어치 있는 질문 하나.
 * ★ 결정적이다. 같은 후보면 같은 질문이 나온다.
 * ★ 원본을 건드리지 않는다 — 랭킹 함수는 상품에 점수를 써 넣으므로
 *   반드시 복제본으로 돌린다.
 */

const { iga, eulr } = require('./_specs');

/** 랭킹이 읽고 쓰는 필드만 복제한다 (원본 오염 방지). */
function cloneForRank(it) {
  return {
    productId: it.productId, title: it.title, mall: it.mall, price: it.price,
    listPrice: it.listPrice, discountPct: it.discountPct, refHighPrice: it.refHighPrice,
    trust: it.trust, hist: it.hist, spec: it.spec, specLine: it.specLine,
    featureHit: it.featureHit, featureMiss: it.featureMiss, ref: it.ref
  };
}

function won(v) {
  return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/*
 * 질문 하나가 값어치를 가지려면 답에 따라 1위가 갈려야 한다.
 * 이 값보다 낮으면 묻지 않는다 — 물어도 답이 같으면 시간 낭비다.
 */
const MIN_VALUE = 0.5;

/**
 * 한 가정으로 다시 줄 세운다.
 * @returns {{topId:string, order:string[]}|null}
 */
function rerank(list, cons, wanted, deps) {
  if (!deps || typeof deps.rank !== 'function') return null;
  const copies = list.map(cloneForRank);
  if (wanted && typeof deps.matchFeatures === 'function') {
    copies.forEach(it => {
      const m = deps.matchFeatures(it.spec, wanted);
      it.featureHit = m.hit;
      it.featureMiss = m.miss;
    });
  }
  let re;
  try { re = deps.rank(copies, cons, ''); }
  catch (e) { return null; }
  if (!re.length) return null;
  return { topId: re[0].productId, order: re.map(x => x.productId) };
}

/** 두 순서가 얼마나 다른가 (0 = 같음, 1 = 완전히 다름) */
function churn(a, b) {
  if (!a || !b || !a.length) return 0;
  let moved = 0;
  a.forEach((id, i) => {
    const j = b.indexOf(id);
    if (j < 0 || j !== i) moved++;
  });
  return moved / a.length;
}

/*
 * ── 질문 후보 ──────────────────────────────────────────────────
 *
 * 각 질문은 "답이 갈릴 수 있는 상태들"을 만든다. 그 상태로 각각 다시
 * 줄 세워서 1위가 갈리면 값어치가 있다.
 *
 * applicable 은 "이 질문이 애초에 성립하는가"다. 이미 답을 아는 것은
 * 묻지 않는다(예산을 말했으면 예산을 묻지 않는다).
 */
function priceSpread(list) {
  const ps = list.map(it => Math.round(Number(it.price) || 0)).filter(p => p > 0);
  if (ps.length < 2) return 0;
  const lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
  return lo > 0 ? (hi - lo) / hi : 0;
}

/** 후보 중 일부만 가진 기능 — 이런 기능이라야 물어볼 값어치가 있다. */
function splittingFeatures(list) {
  const tally = {};
  list.forEach(it => {
    ((it.spec && it.spec.features) || []).forEach(f => { tally[f] = (tally[f] || 0) + 1; });
  });
  return Object.keys(tally)
    .filter(f => tally[f] > 0 && tally[f] < list.length)
    .sort();                                   // 결정론 — 객체 키 순서에 기대지 않는다
}

const QUESTIONS = [
  {
    id: 'budget',
    /*
     * 예산.
     *
     * 가장 강한 조건이므로 모르면 대개 물어볼 값어치가 있다. 다만 후보
     * 가격이 다 비슷하면(스프레드가 작으면) 물어도 답이 안 바뀐다.
     */
    applicable: (list, c) => !c.budgetMax && !c.budgetMin && priceSpread(list) >= 0.35,
    states(list, c, wanted) {
      const ps = [...new Set(list.map(it => Math.round(Number(it.price) || 0)))]
        .filter(p => p > 0).sort((a, b) => a - b);
      if (ps.length < 2) return [];
      // 실제 후보 가격 중 낮은 쪽과 높은 쪽을 가정으로 쓴다(임의의 숫자를 만들지 않는다).
      return [
        { label: `${won(ps[0])}원까지`, cons: Object.assign({}, c, { budgetMax: ps[0], budgetSoft: false }), wanted },
        { label: `${won(ps[ps.length - 1])}원까지`, cons: Object.assign({}, c, { budgetMax: ps[ps.length - 1], budgetSoft: false }), wanted }
      ];
    },
    ask(list) {
      const ps = list.map(it => Math.round(Number(it.price) || 0)).filter(p => p > 0);
      const lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
      return {
        text: `예산을 어느 정도로 보고 계세요? 지금 후보가 ${won(lo)}원부터 ${won(hi)}원까지 있어요.`,
        options: [`${won(lo)}원대`, `${won(hi)}원대`]
      };
    }
  },
  {
    id: 'price_vs_quality',
    /*
     * 가격이냐 성능이냐.
     *
     * 예산은 말했지만 그 안에서 무엇을 우선할지 모를 때다. 후보 가격이
     * 갈려 있어야 이 질문이 뜻을 가진다.
     */
    applicable: (list, c) => !c.priority && priceSpread(list) >= 0.25,
    states(list, c, wanted) {
      return [
        { label: '가격 우선', cons: Object.assign({}, c, { priority: 'price' }), wanted },
        { label: '성능 우선', cons: Object.assign({}, c, { priority: 'quality' }), wanted }
      ];
    },
    ask(list) {
      const ps = list.map(it => Math.round(Number(it.price) || 0)).filter(p => p > 0);
      const lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
      return {
        text: `가격을 아끼는 쪽(${won(lo)}원대)이 좋으세요, 성능이 나은 쪽(${won(hi)}원대)이 좋으세요?`,
        options: ['가격 우선', '성능 우선']
      };
    }
  },
  {
    id: 'feature',
    /*
     * 특정 기능.
     *
     * 후보 중 일부만 가진 기능이라야 물어볼 값어치가 있다. 전부 가졌거나
     * 아무도 없으면 답이 어느 쪽이든 순위가 안 바뀐다.
     */
    applicable: (list, c, wanted) => splittingFeatures(list).some(f => (wanted || []).indexOf(f) < 0),
    states(list, c, wanted) {
      const f = splittingFeatures(list).filter(x => (wanted || []).indexOf(x) < 0)[0];
      if (!f) return [];
      return [
        { label: `${f} 필요`, cons: c, wanted: (wanted || []).concat([f]), tag: f },
        { label: `${f} 상관없음`, cons: c, wanted: wanted || [], tag: f }
      ];
    },
    ask(list, c, wanted) {
      const f = splittingFeatures(list).filter(x => (wanted || []).indexOf(x) < 0)[0];
      const have = list.filter(it => ((it.spec && it.spec.features) || []).includes(f)).length;
      return {
        text: `${iga(f)} 꼭 필요하세요? 지금 후보 ${list.length}개 중 ${have}개에서만 확인돼요.`,
        options: [`${f} 필요`, '상관없음']
      };
    }
  }
];

/**
 * 질문마다 정보 가치를 계산한다.
 *
 * @returns {Array<{id, value, topChanges, churn, tops, ask}>} 값 높은 순
 */
function evaluateQuestions(ranked, c, wanted, deps) {
  const list = (ranked || []).filter(Boolean);
  if (list.length < 2 || !deps || typeof deps.rank !== 'function') return [];

  const cons = c || {};
  const want = wanted || [];
  const out = [];

  QUESTIONS.forEach(q => {
    let ok = false;
    try { ok = q.applicable(list, cons, want); } catch (e) { ok = false; }
    if (!ok) return;

    let states = [];
    try { states = q.states(list, cons, want) || []; } catch (e) { return; }
    if (states.length < 2) return;

    const results = states.map(st => rerank(list, st.cons, st.wanted, deps)).filter(Boolean);
    if (results.length < 2) return;

    const tops = [...new Set(results.map(r => r.topId))];
    const topChanges = tops.length > 1;

    // 순서가 얼마나 흔들리는가 — 1위가 같아도 아래가 크게 바뀌면 값이 있다.
    let maxChurn = 0;
    for (let i = 1; i < results.length; i++) {
      maxChurn = Math.max(maxChurn, churn(results[0].order, results[i].order));
    }

    /*
     * 값어치.
     *
     * 1위가 갈리는 것이 압도적으로 중요하다 — 그게 사용자가 실제로 받는
     * 답이기 때문이다. 순서 흔들림은 보조 지표로만 쓴다.
     */
    const value = (topChanges ? 1 : 0) + maxChurn * 0.3;

    let asked = null;
    try { asked = q.ask(list, cons, want); } catch (e) { asked = null; }
    if (!asked || !asked.text) return;

    out.push({
      id: q.id,
      value: Math.round(value * 100) / 100,
      topChanges,
      churn: Math.round(maxChurn * 100) / 100,
      tops,
      ask: asked
    });
  });

  // 값 높은 순. 같으면 id 순으로 — 결정론을 위해서.
  return out.sort((a, b) => (b.value - a.value) || (a.id < b.id ? -1 : 1));
}

/**
 * 물어볼 값어치가 있는 질문 하나. 없으면 null.
 *
 * ★ null 이 정상이다. 이미 충분한 정보가 있으면 묻지 않고 바로 답하는 것이
 *   좋은 쇼핑 상담이다.
 */
function bestQuestion(ranked, c, wanted, deps) {
  const all = evaluateQuestions(ranked, c, wanted, deps);
  const top = all[0];
  if (!top || top.value < MIN_VALUE) return null;
  return top;
}

/**
 * 프롬프트에 실을 블록. 질문할 것이 없으면 빈 문자열.
 *
 * ★ "물어봐도 된다"가 아니라 "이것만 물어라"로 적는다. 모델에게 재량을
 *   주면 질문을 늘린다.
 */
function questionBlock(q) {
  if (!q || !q.ask) return '';
  return [
    '[되물을 값어치가 있는 질문 — 딱 하나]',
    `  ${q.ask.text}`,
    q.ask.options && q.ask.options.length
      ? `  선택지: ${q.ask.options.join(' / ')}`
      : '',
    '- 이 질문의 답에 따라 1위 추천이 실제로 바뀐다(코드가 다시 줄 세워 확인했다).',
    '- ★ 이 질문 하나만 해라. 다른 것을 덧붙여 묻지 마라.',
    '- ★ 질문만 하고 끝내지 마라. 지금 데이터로 답할 수 있는 추천을 먼저 하고,',
    '  그 뒤에 "이것만 알려주시면 더 정확해진다"는 식으로 한 줄 덧붙인다.'
  ].filter(Boolean).join('\n');
}

/**
 * 되물을 것이 없을 때 프롬프트에 실을 한 줄.
 *
 * 이것도 정보다 — 모델이 괜히 질문을 만들어내지 않게 한다.
 */
const NO_QUESTION_LINE = [
  '[되물을 것 없음]',
  '- 지금 조건만으로 추천이 갈리지 않는다는 것을 코드가 확인했다.',
  '- ★ 되묻지 마라. 예산·용도·브랜드를 묻지 말고 바로 답한다.'
].join('\n');

module.exports = {
  evaluateQuestions, bestQuestion, questionBlock, NO_QUESTION_LINE,
  cloneForRank, churn, splittingFeatures, priceSpread,
  MIN_VALUE, QUESTIONS
};
