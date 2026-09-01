#!/usr/bin/env node
/*
 * SEOSA AI — CONFIDENCE 2.0 평가 (오프라인, 외부 호출 0회)
 *
 * 무엇을 재는가:
 *   A. 하위호환      기존 반환값(confidence·label·reasons)이 달라지지 않았는가
 *   B. 축 분해       무엇이 부족해서 확신이 낮은지 축으로 갈리는가
 *   C. 근거 없음     판정할 근거가 없는 축을 "높음" 으로 채우지 않는가
 *   D. 종합          종합 확신도가 가장 약한 축을 따르는가
 *   E. 프롬프트      모델이 확신도를 스스로 만들지 못하게 막는가
 *   F. 결정론        같은 입력이면 언제나 같은 확신도인가
 *
 * ── 왜 축을 나누는가 ────────────────────────────────────────────────
 * "확신도 보통" 한 줄로는 사용자가 취할 행동이 정해지지 않는다. 가격 데이터가
 * 없어서 보통인 것과 1·2위가 붙어서 보통인 것은 다르다 — 앞은 기다리면
 * 나아지고, 뒤는 취향을 한 줄 더 말하면 갈린다.
 */
const DEC = require('../api/_decision.js');
const DEAL = require('../api/_deal.js');

const VERBOSE = process.argv.includes('--verbose');
const metrics = {};
function score(metric, ok, label, detail) {
  if (!metrics[metric]) metrics[metric] = { pass: 0, fail: 0, misses: [] };
  if (ok) metrics[metric].pass++;
  else { metrics[metric].fail++; metrics[metric].misses.push(`${label}${detail ? ` — ${detail}` : ''}`); }
  if (VERBOSE) console.log(`  [${ok ? 'ok' : 'MISS'}] ${metric} · ${label}${detail ? ` — ${detail}` : ''}`);
}

const TODAY = '2026-08-28';

/** 랭킹을 거친 상품 하나. 기본은 "근거가 다 갖춰진" 상태다. */
function item(o) {
  return Object.assign({
    productId: 'P1', title: '알파 노트북', mall: '쿠팡', price: 95000,
    _score: 80, specLine: '램 16GB · 저장 512GB', fit: '예산 적합',
    featureHit: [], featureMiss: [],
    hist: { count: 30, low: 90000, avg30: 100000, lastDate: TODAY },
    verdict: { verdict: 'good', staleDays: 0 }
  }, o);
}
/** 1위와 2위. gap 만큼 점수 차이를 준다. */
function pair(gap, o1, o2) {
  return [item(Object.assign({ productId: 'P1', _score: 80 }, o1)),
          item(Object.assign({ productId: 'P2', _score: 80 - gap }, o2))];
}
const cons = { budgetMax: 100000 };

console.log('=== SEOSA AI — Confidence 2.0 평가 (외부 호출 0회) ===');

/* ══════════════════════════════════════════════════════════════
   A. 하위호환 — 기존 호출부가 예전과 똑같이 돈다
   ══════════════════════════════════════════════════════════════ */
console.log('\n[A] 하위호환');
{
  const list = pair(30);
  const m = DEC.computeMargin(list);

  // opts 를 안 넘기는 것이 기존 호출 방식이다.
  const legacy = DEC.computeConfidence(list, m, cons, []);
  score('Compat', typeof legacy.confidence === 'string', 'confidence 를 그대로 낸다', legacy.confidence);
  score('Compat', typeof legacy.label === 'string' && legacy.label.length > 0, 'label 을 그대로 낸다', legacy.label);
  score('Compat', Array.isArray(legacy.reasons) && legacy.reasons.length > 0, 'reasons 를 그대로 낸다');
  score('Compat', legacy.confidence === 'high', '근거가 다 갖춰지면 높음', legacy.confidence);

  // 인자를 더 줘도 기존 세 값은 달라지지 않는다.
  const deal = DEAL.dealOf(list[0].hist, list[0].price, TODAY);
  const rich = DEC.computeConfidence(list, m, cons, [], { deal, profile: { neutral: false } });
  score('Compat', rich.confidence === legacy.confidence,
    '★★ opts 를 줘도 종합 확신도가 달라지지 않는다', `${legacy.confidence} → ${rich.confidence}`);
  score('Compat', JSON.stringify(rich.reasons) === JSON.stringify(legacy.reasons),
    '★★ opts 를 줘도 reasons 가 글자 하나 달라지지 않는다');

  // 후보가 없을 때의 기존 동작
  const none = DEC.computeConfidence([], DEC.computeMargin([]), cons, []);
  score('Compat', none.confidence === 'low', '후보가 없으면 낮음');
  score('Compat', none.reasons[0] === '후보가 없음', '이유도 예전 그대로', none.reasons[0]);
  score('Compat', !!none.axes, '후보가 없어도 축은 채워 준다');

  // 기존 확신 하락 조건들이 그대로 동작하는가
  const cases = [
    ['1·2위가 대등', pair(1), 'low'],
    ['1·2위가 근소', pair(6), 'medium'],
    ['후보 하나뿐', [item({})], 'medium'],
    ['가격 기록 없음', pair(30, { hist: null, verdict: null }), 'medium'],
    ['사양 확인 못 함', pair(30, { specLine: '' }), 'medium']
  ];
  cases.forEach(([label, list2, want]) => {
    const c = DEC.computeConfidence(list2, DEC.computeMargin(list2), cons, []);
    score('Compat', c.confidence === want, `${label} → ${want}`, c.confidence);
  });
}

/* ══════════════════════════════════════════════════════════════
   B. 축 분해 — 무엇이 무너졌는지 갈린다
   ══════════════════════════════════════════════════════════════ */
console.log('\n[B] 축 분해');
{
  // 순위만 애매한 경우: ranking 만 낮고 나머지는 높아야 한다.
  const tie = pair(1);
  const c1 = DEC.computeConfidence(tie, DEC.computeMargin(tie), cons, []);
  score('Axes', c1.axes.ranking.level === 'low', '★ 1·2위가 대등하면 순위 축이 낮다', c1.axes.ranking.level);
  score('Axes', c1.axes.price.level === 'high', '★ 그때 가격 축은 그대로 높다', c1.axes.price.level);
  score('Axes', c1.axes.spec.level === 'high', '★ 사양 축도 그대로 높다', c1.axes.spec.level);

  // 가격 기록만 없는 경우: price 만 낮아야 한다.
  const noHist = pair(30, { hist: null, verdict: null });
  const c2 = DEC.computeConfidence(noHist, DEC.computeMargin(noHist), cons, []);
  score('Axes', c2.axes.price.level === 'medium', '★ 기록이 없으면 가격 축이 내려간다', c2.axes.price.level);
  score('Axes', c2.axes.ranking.level === 'high', '★ 그때 순위 축은 멀쩡하다', c2.axes.ranking.level);

  // 사양만 없는 경우
  const noSpec = pair(30, { specLine: '' });
  const c3 = DEC.computeConfidence(noSpec, DEC.computeMargin(noSpec), cons, []);
  score('Axes', c3.axes.spec.level === 'medium', '★ 사양이 없으면 사양 축이 내려간다', c3.axes.spec.level);
  score('Axes', c3.axes.price.level === 'high', '그때 가격 축은 멀쩡하다', c3.axes.price.level);

  // 요구 기능을 확인 못 한 경우도 사양 축이다.
  const miss = pair(30, { featureMiss: ['방수'] });
  const c4 = DEC.computeConfidence(miss, DEC.computeMargin(miss), cons, ['방수']);
  score('Axes', c4.axes.spec.level === 'medium', '★ 요구 기능 미확인도 사양 축이다', c4.axes.spec.level);
  score('Axes', c4.axes.spec.reasons.some(r => /방수/.test(r)), '무엇을 확인 못 했는지 남긴다');

  // 축마다 근거 문장이 붙는다.
  DEC.CONF_AXES.forEach(a => {
    score('Axes', typeof DEC.CONF_AXIS_LABEL[a] === 'string' && DEC.CONF_AXIS_LABEL[a].length > 0,
      `${a} 에 사람이 읽는 이름이 있다`);
  });
}

/* ══════════════════════════════════════════════════════════════
   C. 근거 없는 축을 "높음" 으로 채우지 않는가
   ══════════════════════════════════════════════════════════════ */
console.log('\n[C] 모르는 축은 비워 둔다');
{
  const list = pair(30);
  const c = DEC.computeConfidence(list, DEC.computeMargin(list), cons, []);
  score('Unknown', c.axes.freshness.level === null,
    '★★ 최신성 근거를 안 줬으면 최신성 축은 비어 있다', String(c.axes.freshness.level));
  score('Unknown', c.axes.preference.level === null,
    '★★ 취향 근거를 안 줬으면 취향 축은 비어 있다', String(c.axes.preference.level));
  score('Unknown', c.axes.freshness.label === '', '비어 있으면 라벨도 없다');

  // 근거를 주면 채워진다.
  const deal = DEAL.dealOf(list[0].hist, list[0].price, TODAY);
  const c2 = DEC.computeConfidence(list, DEC.computeMargin(list), cons, [], { deal, profile: { neutral: true } });
  score('Unknown', c2.axes.freshness.level === 'high', '★ 최신 데이터면 최신성 축이 높다', c2.axes.freshness.level);
  score('Unknown', c2.axes.preference.level === 'high',
    '★ 취향을 말하지 않은 것도 판정이다 — 일반 기준으로 봤다', c2.axes.preference.level);
  score('Unknown', c2.axes.preference.reasons.some(r => /취향을 말하지 않아/.test(r)),
    '왜 그렇게 판정했는지 남긴다');

  // 오래된 가격이면 최신성 축이 내려간다.
  const staleDeal = DEAL.dealOf({
    count: 30, low: 90000, high: 120000, avg30: 100000, lastDate: '2026-08-14',
    avg7: 100000, avg7Days: 7, historyDays: 29, maxGapDays: 1, lastPrice: 95000, trendPct: 0, trendDays: 6
  }, 95000, TODAY);
  const c3 = DEC.computeConfidence(list, DEC.computeMargin(list), cons, [], { deal: staleDeal, profile: { neutral: true } });
  score('Unknown', c3.axes.freshness.level === 'medium',
    '★★ 2주 가까이 안 갱신된 가격이면 최신성 축이 내려간다', c3.axes.freshness.level);
  score('Unknown', c3.confidence === 'medium',
    '★★ 그러면 종합 확신도도 내려간다 — 낡은 데이터로 확신하지 않는다', c3.confidence);
}

/* ══════════════════════════════════════════════════════════════
   D. 종합 — 가장 약한 축을 따른다
   ══════════════════════════════════════════════════════════════ */
console.log('\n[D] 종합은 가장 약한 축');
{
  const RANK = { high: 1, medium: 2, low: 3 };
  const lists = [
    pair(30), pair(6), pair(1), [item({})],
    pair(30, { hist: null, verdict: null }),
    pair(30, { specLine: '' }),
    pair(30, { specLine: '', hist: null, verdict: null }),
    pair(1, { specLine: '' })
  ];
  let allOk = true, detail = '';
  lists.forEach(l => {
    const c = DEC.computeConfidence(l, DEC.computeMargin(l), cons, []);
    let worst = 'high';
    DEC.CONF_AXES.forEach(a => {
      const lv = c.axes[a].level;
      if (lv && RANK[lv] > RANK[worst]) worst = lv;
    });
    if (worst !== c.confidence) { allOk = false; detail = `축 최악=${worst} 종합=${c.confidence}`; }
  });
  score('Overall', allOk, '★★ 종합 확신도가 언제나 가장 약한 축과 같다', detail);

  // 좋은 축이 많아도 나쁜 축 하나가 종합을 끌어내린다.
  const one = pair(1);
  const c = DEC.computeConfidence(one, DEC.computeMargin(one), cons, []);
  score('Overall', c.confidence === 'low' && c.axes.price.level === 'high',
    '★ 가격·사양이 높아도 순위가 무너지면 종합은 낮다', `${c.confidence} / price=${c.axes.price.level}`);

  // data 축은 다른 축의 요약이다.
  const c2 = DEC.computeConfidence(pair(30), DEC.computeMargin(pair(30)), cons, []);
  score('Overall', c2.axes.data.level === 'high', '근거가 다 갖춰지면 데이터 축도 높다', c2.axes.data.level);
  const c3 = DEC.computeConfidence(pair(30, { specLine: '' }), DEC.computeMargin(pair(30)), cons, []);
  score('Overall', c3.axes.data.level === 'medium', '한 축이 무너지면 데이터 축도 따라 내려간다', c3.axes.data.level);
}

/* ══════════════════════════════════════════════════════════════
   E. 프롬프트 블록
   ══════════════════════════════════════════════════════════════ */
console.log('\n[E] 프롬프트 블록');
{
  const list = pair(6, { specLine: '' });
  const deal = DEAL.dealOf(list[0].hist, list[0].price, TODAY);
  const c = DEC.computeConfidence(list, DEC.computeMargin(list), cons, [], { deal, profile: { neutral: false } });
  const b = DEC.confidenceBlock(c);

  score('Block', /다시 매기지 마라/.test(b), '★★ 모델이 확신도를 스스로 만들지 못하게 막는다');
  score('Block', /종합: /.test(b), '종합 확신도를 싣는다');
  score('Block', /순위 판정: /.test(b), '순위 축을 싣는다');
  score('Block', /가격 데이터: /.test(b), '가격 축을 싣는다');
  score('Block', /사양 데이터: /.test(b), '사양 축을 싣는다');
  score('Block', /가격 최신성: /.test(b), '최신성 축을 싣는다');
  score('Block', /가장 약한 근거를 따른다/.test(b), '★ 좋은 축만 골라 말하지 말라고 지시한다');
  score('Block', !/전체 데이터/.test(b), 'data 축은 요약이라 따로 싣지 않는다 — 같은 말을 두 번 하지 않는다');

  // 근거가 없는 축은 블록에도 안 나온다.
  const bare = DEC.confidenceBlock(DEC.computeConfidence(list, DEC.computeMargin(list), cons, []));
  score('Block', !/사용자 취향/.test(bare), '★ 판정하지 않은 축은 블록에 쓰지 않는다');

  score('Block', DEC.confidenceBlock(null) === '', 'null 이면 빈 문자열 — 토큰을 쓰지 않는다');
  score('Block', DEC.confidenceBlock({}) === '', '축이 없으면 빈 문자열');
}

/* ══════════════════════════════════════════════════════════════
   F. 결정론
   ══════════════════════════════════════════════════════════════ */
console.log('\n[F] 결정론');
{
  const list = pair(6, { specLine: '' });
  const deal = DEAL.dealOf(list[0].hist, list[0].price, TODAY);
  const opts = { deal, profile: { neutral: false } };
  const first = JSON.stringify(DEC.computeConfidence(list, DEC.computeMargin(list), cons, [], opts));
  let same = true;
  for (let i = 0; i < 100; i++) {
    if (JSON.stringify(DEC.computeConfidence(list, DEC.computeMargin(list), cons, [], opts)) !== first) same = false;
  }
  score('Determinism', same, '★★ 100회 반복해도 확신도·축·근거가 완전히 같다');

  const before = JSON.stringify(list);
  DEC.computeConfidence(list, DEC.computeMargin(list), cons, [], opts);
  score('Determinism', JSON.stringify(list) === before, '★ 넘겨받은 상품 목록을 수정하지 않는다');

  score('Determinism', DEC.computeConfidence(null, DEC.computeMargin([]), null, null).confidence === 'low',
    'null 입력 안전');
}

/* ══════════════════════════════════════════════════════════════ */
console.log('\n' + '='.repeat(66));
console.log('SEOSA AI — Confidence 2.0 평가');
console.log('='.repeat(66));

let totalPass = 0, totalFail = 0;
Object.keys(metrics).forEach(k => {
  const m = metrics[k];
  const n = m.pass + m.fail;
  const pct = n ? Math.round(m.pass / n * 100) : 0;
  const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
  console.log(`  ${k.padEnd(16)} ${bar} ${String(m.pass).padStart(3)}/${String(n).padEnd(3)} (${pct}%)`);
  totalPass += m.pass; totalFail += m.fail;
});
console.log('-'.repeat(66));
console.log(`  측정됨           ${totalPass}/${totalPass + totalFail} (${Math.round(totalPass / (totalPass + totalFail) * 100)}%)`);
console.log('  UNAVAILABLE      LLM 이 확신도를 그대로 옮기는가 → npm run test:concierge');

const misses = [];
Object.keys(metrics).forEach(k => metrics[k].misses.forEach(t => misses.push(`[${k}] ${t}`)));
if (misses.length) {
  console.log('\n미달 항목:');
  misses.forEach(t => console.log(`  - ${t}`));
}
process.exit(totalFail ? 1 : 0);
