/*
 * 조건을 만족하는 상품이 없을 때 — "무엇을 가장 적게 포기하면 되는가".
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────
 *
 * 지금까지 조건에 맞는 상품이 없으면 이렇게 끝났다.
 *
 *   "조건에 맞는 상품을 찾지 못했어요."
 *
 * 사용자 입장에서 이건 답이 아니라 벽이다. 무엇을 바꿔야 하는지 알 수
 * 없으니 처음부터 다시 시작해야 한다. 그런데 우리는 후보를 이미 손에
 * 들고 있다 — 어느 조건 하나를 조금만 풀면 몇 개가 생기는지 셀 수 있다.
 *
 *   예산 5만원 늘리면      → 3개
 *   방수 조건을 빼면       → 7개
 *   둘 다 풀면            → 11개
 *
 * 이 중 "가장 적게 포기하는 것"을 찾아 주는 것이 답이다.
 *
 * ── 지켜야 할 선 ────────────────────────────────────────────────
 *
 * ★ 조건을 조용히 바꾸지 않는다. 계산해서 제안할 뿐, 실제 추천은
 *   사용자가 말한 조건 그대로 돈다. 완화는 사용자가 고를 선택지다.
 * ★ 실제 후보 가격으로만 완화폭을 만든다. "5만원만 더" 같은 임의의
 *   숫자를 지어내지 않는다 — 그 가격의 상품이 있어야 뜻이 있다.
 * ★ 후보가 늘지 않는 완화는 제안하지 않는다. 포기만 하고 얻는 게 없다.
 * ★ 결정적이다.
 */

function won(v) {
  return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const { iga, eulr } = require('./_specs');

/**
 * 이 상품이 하드 조건을 전부 만족하는가.
 *
 * ── 무엇이 하드 조건인가 ────────────────────────────────────────
 *
 *   예산 상한/하한   — 사용자가 "이하"라고 말했으면 하드
 *   요구 기능        — "통화 중요해"는 요구이지만 상품명에서 확인 안 될 뿐
 *                     실제로는 있을 수 있다. 그래서 소프트로 다룬다.
 *
 * ★ 기능 미확인을 하드 탈락으로 처리하지 않는다. 판매자가 제목에 안 썼을
 *   뿐인 상품을 "조건 불만족"으로 지우면, 멀쩡한 후보가 통째로 사라진다.
 *   여기서는 예산만 하드로 본다.
 */
function satisfies(it, c) {
  const cons = c || {};
  const price = Math.round(Number(it && it.price) || 0);
  if (price <= 0) return false;
  if (cons.budgetMax && !cons.budgetSoft && price > cons.budgetMax) return false;
  if (cons.budgetMax && cons.budgetSoft && price > cons.budgetMax) return false;
  if (cons.budgetMin && price < cons.budgetMin) return false;
  return true;
}

/** 하드 조건 + 요구 기능까지 전부 만족하는 상품 수 */
function matchCount(items, c, wanted) {
  const want = wanted || [];
  return (items || []).filter(it => {
    if (!satisfies(it, c)) return false;
    if (!want.length) return true;
    const hit = new Set(Array.isArray(it.featureHit) ? it.featureHit : []);
    return want.every(f => hit.has(f));
  }).length;
}

/**
 * 조건을 하나씩 풀어 후보가 몇 개 생기는지 센다.
 *
 * @param {Array}  items  검색으로 찾은 상품 전체 (지우지 않은 원본)
 * @param {object} c      사용자 조건
 * @param {Array}  wanted 요구 기능
 * @returns {Array<{id, label, gained, total, lost, cost}>} 포기가 적은 순
 */
/*
 * 기능 하나를 포기하는 비용.
 *
 * ★ 예산 완화보다 싸게 잡는다. 우리가 "확인하지 못한" 것과 "없는" 것은
 *   다르기 때문이다 — 판매자가 제목에 안 썼을 뿐 실제로는 있을 수 있다.
 *   다만 사용자가 명시한 요구이므로 공짜는 아니다.
 */
const FEATURE_COST = 0.3;

/** 예산 완화 후보를 몇 단계까지 볼 것인가. 너무 많이 늘리라는 제안은 조언이 아니다. */
const BUDGET_STEPS = 3;

function relaxations(items, c, wanted) {
  const list = (items || []).filter(Boolean);
  const cons = c || {};
  const want = wanted || [];
  const base = matchCount(list, cons, want);

  /*
   * ── 왜 조합까지 봐야 하는가 ──────────────────────────────────
   *
   * 처음에는 조건을 하나씩만 풀어 봤다. 그런데 실제로 막히는 상황은
   * 대개 둘 이상이 동시에 막는다.
   *
   *   "80만원 이하 + 방수 노트북"
   *   → 85만원짜리는 예산에서 막히고, 방수 없는 것은 기능에서 막힌다.
   *   → 예산만 풀어도 0개, 기능만 풀어도 0개.
   *   → 하나씩만 보면 "풀어도 소용없다"는 잘못된 결론이 나온다.
   *
   * 실제 답은 "예산을 85만원까지 늘리고 방수를 빼면 1개"다. 조합을 봐야
   * 그 답이 나온다.
   */
  const budgetTargets = [null];
  if (cons.budgetMax) {
    const over = [...new Set(list
      .filter(it => Math.round(Number(it.price) || 0) > cons.budgetMax)
      .map(it => Math.round(it.price)))].sort((a, b) => a - b);
    over.slice(0, BUDGET_STEPS).forEach(t => budgetTargets.push(t));
  }

  // 기능 조합 — 전부 유지 / 하나씩 빼기 / 전부 빼기
  const featureSets = [want.slice()];
  want.forEach(f => featureSets.push(want.filter(x => x !== f)));
  if (want.length > 1) featureSets.push([]);

  const seen = new Set();
  const out = [];

  budgetTargets.forEach(target => {
    featureSets.forEach(fs => {
      // 아무것도 안 푼 것은 현재 상태 그 자체다.
      if (target === null && fs.length === want.length) return;

      const key = `${target || 0}|${fs.slice().sort().join(',')}`;
      if (seen.has(key)) return;
      seen.add(key);

      const relaxed = target === null ? cons : Object.assign({}, cons, { budgetMax: target });
      const n = matchCount(list, relaxed, fs);
      if (n <= base) return;                    // 얻는 것이 없으면 제안하지 않는다

      const droppedFeatures = want.filter(f => fs.indexOf(f) < 0);
      const budgetAdd = target === null ? 0 : target - cons.budgetMax;
      const cost = (cons.budgetMax > 0 && budgetAdd > 0 ? budgetAdd / cons.budgetMax : 0)
        + droppedFeatures.length * FEATURE_COST;

      /* 사람이 읽는 설명 — 무엇을 얼마나 포기하는지 */
      const parts = [];
      if (budgetAdd > 0) parts.push(`예산을 ${won(target)}원까지(${won(budgetAdd)}원 더) 늘리고`);
      if (droppedFeatures.length) parts.push(`${eulr(droppedFeatures.join('·'))} 조건에서 빼면`);
      // 하나뿐이면 "~고"로 끝나지 않게 다듬는다.
      let label = parts.join(' ');
      if (parts.length === 1 && budgetAdd > 0) {
        label = `예산을 ${won(target)}원까지(${won(budgetAdd)}원 더) 늘리면`;
      }

      out.push({
        id: key,
        label,
        gained: n - base,
        total: n,
        lost: [budgetAdd > 0 ? '예산 상한' : null]
          .concat(droppedFeatures).filter(Boolean).join(' · '),
        cost: Math.round(cost * 1000) / 1000
      });
    });
  });

  /* ── 예산 하한 (있을 때만) ── */
  if (cons.budgetMin) {
    const under = list
      .filter(it => Math.round(Number(it.price) || 0) < cons.budgetMin)
      .map(it => Math.round(it.price))
      .sort((a, b) => b - a);
    if (under.length) {
      const target = under[0];
      const n = matchCount(list, Object.assign({}, cons, { budgetMin: target }), want);
      if (n > base) {
        out.push({
          id: `budgetMin:${target}`,
          label: `하한을 ${won(target)}원까지 낮추면`,
          gained: n - base, total: n, lost: '예산 하한',
          cost: cons.budgetMin > 0 ? (cons.budgetMin - target) / cons.budgetMin : 1
        });
      }
    }
  }

  /*
   * 정렬 — 포기가 적은 순. 같은 비용이면 더 많이 얻는 쪽.
   * 그것이 "가장 작은 변경"이다.
   */
  return out.sort((a, b) => (a.cost - b.cost) || (b.gained - a.gained) || (a.id < b.id ? -1 : 1));
}

/**
 * 조건을 만족하는 상품이 있는가 / 없으면 어떻게 풀 것인가.
 *
 * @returns {{matched:number, total:number, options:Array}|null}
 *   matched > 0 이면 null 을 돌려준다 — 문제가 없으므로 말할 것도 없다.
 */
function analyze(items, c, wanted) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;

  const matched = matchCount(list, c, wanted);
  if (matched > 0) return null;                  // 후보가 있으면 이 엔진은 침묵한다

  const options = relaxations(list, c, wanted).slice(0, 3);
  return { matched: 0, total: list.length, options };
}

/**
 * 프롬프트 블록. 완화안이 없으면 그 사실만 적는다.
 *
 * ★ "상품이 없다"로 끝내지 못하게 한다. 무엇을 바꾸면 되는지가 답이다.
 */
function noResultBlock(a) {
  if (!a) return '';
  const L = ['[조건을 모두 만족하는 상품이 없다]',
    `  찾아온 ${a.total}개 중 조건을 전부 만족하는 것은 0개다.`];

  if (a.options.length) {
    L.push('  가장 적게 포기하는 순서로:');
    a.options.forEach(o => {
      L.push(`    · ${o.label} → ${o.total}개 (${o.gained}개 생김, 포기: ${o.lost})`);
    });
    L.push('- ★ 이 숫자는 코드가 실제로 세어 본 것이다. 지어내거나 바꾸지 마라.');
    L.push('- ★ 조건을 우리 마음대로 바꾸지 마라. 어떤 선택지가 있는지 알리고,');
    L.push('  가장 작은 변경을 먼저 권한 뒤 사용자가 고르게 한다.');
    L.push('- 조건에 가장 가까운 상품 몇 개는 함께 보여 줘도 된다. 다만 조건을');
    L.push('  만족한다고 말하지 마라 — 얼마나 차이 나는지 사실대로 밝힌다.');
  } else {
    L.push('- 조건을 풀어도 후보가 늘지 않는다. 사실대로 말하고,');
    L.push('  어떤 조건을 바꿀 수 있는지 사용자에게 물어라.');
  }
  return L.join('\n');
}

module.exports = { satisfies, matchCount, relaxations, analyze, noResultBlock };
