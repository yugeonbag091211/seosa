#!/usr/bin/env node
/**
 * Phase 1 평가 — 성향 가중치 · 다목적 분해 · 파레토 · 예산 탄력성 ·
 * 한계효용 · 대체품 (오프라인, 외부 호출 0회).
 *
 * ── 무엇을 재는가 ───────────────────────────────────────────────
 *
 *   Preference     대화에서 성향을 읽고, 말하지 않은 것은 만들지 않는가
 *   MultiObjective 점수 분해가 합계를 바꾸지 않는가 (= 기존 순위 보존)
 *   Pareto         지배·트레이드오프·파레토를 옳게 가르는가
 *   Elasticity     예산을 바꾸면 답이 어떻게 달라지는가
 *   Returns        더 쓴 돈이 실제로 값어치를 하는가
 *   Substitute     더 싼 대안에서 무엇을 잃는지 계산하는가
 *
 * ── 경계값을 노린다 ─────────────────────────────────────────────
 *
 * 지배 판정 ±1점, 균등 프로필 판정 ±0.02, 한계효용 임계 5점,
 * 후보 1개·0개, 근거 없는 성향, 원본 오염 — 깨질 자리를 고른다.
 *
 * 사용법: node scripts/eval-multiobjective.js [--verbose]
 */
'use strict';

const PF = require('../api/_profile.js');
const PA = require('../api/_pareto.js');
const { parseConstraints, rankItems, scoreItem } = require('../api/_shopintent.js');
const { extractSpecs, specLine, wantedFeatures, matchFeatures } = require('../api/_specs.js');

const VERBOSE = process.argv.includes('--verbose');

/* ── 채점 ─────────────────────────────────────────────────────── */
const metrics = {};
function score(metric, ok, label, detail) {
  if (!metrics[metric]) metrics[metric] = { pass: 0, fail: 0, misses: [] };
  if (ok) metrics[metric].pass++;
  else { metrics[metric].fail++; metrics[metric].misses.push(`${label}${detail ? ` — ${detail}` : ''}`); }
  if (VERBOSE) console.log(`  [${ok ? 'ok' : 'MISS'}] ${metric} · ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ── 픽스처 ───────────────────────────────────────────────────── */
const ago = n => new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
function hist(low, avg, trend) {
  return {
    count: 14, low, lowDate: ago(20), avg30: avg, avg30Days: 14,
    lastPrice: 0, lastDate: ago(1), prevPrice: 0,
    trendPct: trend, trendDays: 7, trendFrom: 0, trendFromDate: ago(7), points: []
  };
}
function item(id, title, price, h) {
  const it = { productId: id, title, mall: '쿠팡', price };
  const sp = extractSpecs(title);
  it.spec = sp; it.specLine = specLine(sp);
  if (h) it.hist = h;
  it.featureHit = []; it.featureMiss = [];
  return it;
}
const clone = it => Object.assign({}, it);

function ranked(items, q) {
  const c = parseConstraints(q);
  const wanted = wantedFeatures(q);
  items.forEach(it => {
    const m = matchFeatures(it.spec, wanted);
    it.featureHit = m.hit; it.featureMiss = m.miss;
  });
  const r = rankItems(items, c, '');
  r.forEach((it, i) => { it.ref = 'P' + (i + 1); });
  return { r, c, wanted };
}

/* ══════════════════════════════════════════════════════════════
   A. 성향 가중치 (28)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[A] 성향 가중치');
{
  const m = p => PF.multipliers(p);

  // 아무 말도 안 하면 균등 — 예전과 완전히 같은 동작
  const empty = PF.emptyProfile();
  score('Preference', PF.isNeutral(empty), '★ 초기 프로필은 균등하다');
  score('Preference', PF.ACTIONABLE.every(d => Math.abs(m(empty)[d] - 1) < 1e-9),
    '★ 균등이면 배수가 정확히 1.0 (기존 랭킹 보존)');
  score('Preference', PF.isNeutral(PF.buildProfile('이어폰 추천해줘', [])),
    '취향을 말하지 않으면 균등 유지');
  score('Preference', PF.isNeutral(PF.buildProfile('', [])), '빈 발화 안전');
  score('Preference', PF.isNeutral(PF.buildProfile(null, null)), 'null 안전');

  // 신호가 실제로 읽히는가
  const SIG = [
    ['가성비 좋은 거',              'price'],
    ['오래 쓰는 게 중요해',          'quality'],
    ['영상편집도 해',               'performance'],
    ['가벼웠으면 좋겠어',            'portability'],
    ['정품 브랜드로',               'brand'],
    ['디자인 예쁜 걸로',            'design']
  ];
  SIG.forEach(([q, dim]) => {
    const sigs = PF.readSignals(q, 'explicit');
    score('Preference', sigs.some(s => s.dim === dim), `"${q}" → ${dim}`,
      sigs.map(s => s.dim).join(',') || '(없음)');
  });

  // 근거가 반드시 붙는다
  {
    const sigs = PF.readSignals('가성비 좋은 거', 'explicit');
    score('Preference', sigs.every(s => s.evidence && s.evidence.length > 0),
      '★ 모든 신호에 근거 문자열이 붙는다', JSON.stringify(sigs.map(s => s.evidence)));
    score('Preference', sigs.every(s => '가성비 좋은 거'.includes(s.evidence)),
      '★ 근거는 사용자가 실제로 쓴 말이다');
  }

  // 한 문장에서 여러 차원
  {
    const sigs = PF.readSignals('가격보다 오래 쓰는 게 중요해', 'explicit');
    score('Preference', sigs.filter(s => s.dim === 'quality').length >= 1,
      '★ 한 문장에서 여러 신호를 모은다(먼저 걸린 하나가 아니라)',
      sigs.map(s => s.dim + ':' + s.evidence).join(' / '));
  }

  // 출처 신뢰도
  {
    const e = PF.readSignals('가성비 좋은 거', 'explicit')[0];
    const c = PF.readSignals('가성비 좋은 거', 'conversation')[0];
    score('Preference', e.delta > c.delta, '★ 이번 발화가 앞 대화보다 무겁다',
      `${e.delta.toFixed(2)} vs ${c.delta.toFixed(2)}`);
    score('Preference', c.delta / e.delta === PF.SOURCE_TRUST.conversation,
      '출처 계수가 그대로 적용된다');
    const bad = PF.readSignals('가성비', 'nonsense')[0];
    score('Preference', bad.source === 'conversation', '모르는 출처는 보수적으로 처리');
  }

  // 누적과 상한
  {
    let p = PF.emptyProfile();
    for (let i = 0; i < 20; i++) p = PF.applySignals(p, PF.readSignals('성능이 중요해', 'explicit'));
    score('Preference', p.weights.performance <= PF.W_MAX,
      '★ 한 차원이 상한을 넘지 않는다', String(p.weights.performance));
    let q = PF.emptyProfile();
    for (let i = 0; i < 20; i++) q = PF.applySignals(q, PF.readSignals('가격은 상관없어', 'explicit'));
    score('Preference', q.weights.price >= PF.W_MIN,
      '★ 한 차원이 하한 아래로 안 내려간다', String(q.weights.price));
    score('Preference', (p.signals || []).length <= 20, '근거 기록이 무한정 쌓이지 않는다');
  }

  // 대화 누적
  {
    const p = PF.buildProfile('가벼웠으면 좋겠어', [
      { role: 'user', text: '100만원 이하 노트북' },
      { role: 'assistant', text: 'A를 권합니다' },
      { role: 'user', text: '영상편집도 해' }
    ]);
    const mm = m(p);
    score('Preference', mm.performance > 1, '앞 대화의 성능 신호가 살아 있다', mm.performance.toFixed(2));
    score('Preference', mm.portability > 1, '이번 발화의 휴대성 신호가 반영된다', mm.portability.toFixed(2));
    score('Preference', !PF.isNeutral(p), '신호가 있으면 균등이 아니다');
  }

  // 우리가 한 말은 성향이 아니다
  {
    const p = PF.buildProfile('추천해줘', [
      { role: 'assistant', text: '가성비 좋은 제품으로 성능도 뛰어난 상품을 권합니다' }
    ]);
    score('Preference', PF.isNeutral(p),
      '★ AI 가 한 말은 사용자 성향으로 세지 않는다');
  }

  // 프롬프트 줄
  {
    const p = PF.buildProfile('성능이 중요하고 가벼웠으면 좋겠어', []);
    const line = PF.profileLine(p);
    score('Preference', /성능/.test(line) && /휴대성/.test(line), '프롬프트 줄에 차원이 적힌다', line);
    score('Preference', /\(".*"\)/.test(line), '★ 근거가 함께 적힌다', line);
    score('Preference', !/[0-9]\.[0-9]/.test(line), '★ 가중치 숫자가 새지 않는다', line);
    score('Preference', !/성향|성격|당신은/.test(line), '★ 사람을 규정하는 말이 없다', line);
    score('Preference', PF.profileLine(PF.emptyProfile()) === '', '균등이면 빈 줄');
    score('Preference', PF.profileLine(null) === '', 'null 안전');
  }

  // 근거 없는 상대적 하락은 말하지 않는다
  {
    const p = PF.buildProfile('성능이 제일 중요해', []);
    const line = PF.profileLine(p);
    score('Preference', !/덜 중요/.test(line),
      '★ 상대적으로 밀린 차원을 "덜 중요하다"고 말하지 않는다', line);
  }

  // 디자인은 랭킹 배수를 만들지 않는다 (데이터가 없으므로)
  {
    const p = PF.buildProfile('디자인 예쁜 걸로', []);
    score('Preference', m(p).design === undefined,
      '★ 디자인은 배수를 만들지 않는다(잴 데이터가 없다)');
    score('Preference', (p.signals || []).some(s => s.dim === 'design'),
      '다만 말했다는 사실은 기록한다');
  }

  // 원본 불변
  {
    const base = PF.emptyProfile();
    const before = JSON.stringify(base);
    PF.applySignals(base, PF.readSignals('가성비', 'explicit'));
    score('Preference', JSON.stringify(base) === before, '★ applySignals 가 원본을 바꾸지 않는다');
  }
}

/* ══════════════════════════════════════════════════════════════
   B. 다목적 분해 (16)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[B] 다목적 분해');
{
  const it = item('A', '무선 이어폰 마이크 노이즈캔슬링', 89000, hist(85000, 101000, -5));
  it.featureHit = ['마이크']; it.featureMiss = [];
  it.trust = { level: 'high' }; it.discountPct = 20;
  const s = scoreItem(it, parseConstraints('10만원 이하'), []);

  score('MultiObjective', !!s.sub, 'sub 점수가 반환된다');
  const sum = Object.values(s.sub).reduce((a, b) => a + b, 0);
  score('MultiObjective', Math.abs(sum - s.score) < 1e-9,
    '★ 분해 합계 = 총점 (기존 순위가 바뀌지 않는다)', `${sum} vs ${s.score}`);
  score('MultiObjective', s.sub.budget === s.budgetScore,
    '예산 축은 budgetScore 와 일치한다');

  PA.AXES.forEach(ax => {
    score('MultiObjective', typeof s.sub[ax] === 'number', `${ax} 축이 숫자다`);
  });

  // 축별로 실제 신호가 반영되는가
  score('MultiObjective', s.sub.feature > 0, '요구 기능 충족이 feature 축에');
  score('MultiObjective', s.sub.value > 0, '30일 평균 대비 저렴이 value 축에');
  score('MultiObjective', s.sub.trust > 0, '신뢰도가 trust 축에');
  score('MultiObjective', s.sub.deal > 0, '할인이 deal 축에');

  // 예산 초과는 budget 축이 음수
  {
    const over = item('B', '이어폰', 300000, null);
    const so = scoreItem(over, parseConstraints('10만원 이하'), []);
    score('MultiObjective', so.sub.budget < 0, '예산 초과는 budget 축이 음수', String(so.sub.budget));
  }

  // rankItems 가 _sub 를 붙인다
  {
    const r = rankItems([item('A', '이어폰', 50000, null), item('B', '이어폰2', 60000, null)],
      parseConstraints('10만원 이하'), '');
    score('MultiObjective', r.every(x => x._sub), '랭킹 결과에 _sub 가 붙는다');
    score('MultiObjective', r.every(x => typeof x._budgetScore === 'number'), '_budgetScore 도 붙는다');
  }
}

/* ══════════════════════════════════════════════════════════════
   C. 파레토 · 지배 (18)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[C] 파레토 · 지배');
{
  const mk = (id, sub) => ({ productId: id, ref: id, price: 10000, _sub: sub });
  const S = o => Object.assign({ budget: 0, feature: 0, value: 0, timing: 0, trust: 0, deal: 0, brand: 0 }, o);

  // 지배 정의
  score('Pareto', PA.dominates(mk('A', S({ budget: 50, feature: 20 })), mk('B', S({ budget: 40, feature: 10 }))),
    '★ 모든 축에서 앞서면 지배');
  score('Pareto', !PA.dominates(mk('A', S({ budget: 50, feature: 10 })), mk('B', S({ budget: 40, feature: 20 }))),
    '★ 한 축이라도 뒤지면 지배가 아니다');
  score('Pareto', !PA.dominates(mk('A', S({ budget: 50 })), mk('B', S({ budget: 50 }))),
    '완전히 같으면 지배가 아니다');
  // 경계값 — AXIS_EPS
  score('Pareto', !PA.dominates(mk('A', S({ budget: 50 + PA.AXIS_EPS })), mk('B', S({ budget: 50 }))),
    `★ ${PA.AXIS_EPS}점 차이는 앞선 것으로 세지 않는다(경계)`);
  score('Pareto', PA.dominates(mk('A', S({ budget: 50 + PA.AXIS_EPS + 0.1 })), mk('B', S({ budget: 50 }))),
    '경계를 넘으면 지배');

  // 분류
  {
    const c = PA.classify([mk('A', S({ budget: 50, feature: 20, value: 10 })),
                           mk('B', S({ budget: 40, feature: 10, value: 5 }))]);
    score('Pareto', c.shape === 'dominant', '1위가 모두 지배하면 dominant', c.shape);
    score('Pareto', c.front.length === 1, 'dominant 면 프론트는 하나');
  }
  {
    const c = PA.classify([mk('A', S({ budget: 50, feature: 10 })),
                           mk('B', S({ budget: 40, feature: 30 }))]);
    score('Pareto', c.shape === 'tradeoff', '장단점이 갈리면 tradeoff', c.shape);
    score('Pareto', c.front.length === 2, 'tradeoff 면 둘 다 프론트');
  }
  score('Pareto', PA.classify([]).shape === 'none', '후보 0개는 none');
  score('Pareto', PA.classify([mk('A', S({}))]).shape === 'single', '후보 1개는 single');
  score('Pareto', PA.classify(null).shape === 'none', 'null 안전');
  score('Pareto', PA.classify([]).front.length === 0, '빈 프론트');

  // 축별 강점
  {
    const st = PA.strengthsByAxis([mk('A', S({ budget: 50, feature: 10 })),
                                   mk('B', S({ budget: 20, feature: 30 }))]);
    score('Pareto', st.length === 2, '둘 다 앞서는 축이 있다', JSON.stringify(st));
    score('Pareto', st[0].axes.includes('예산 적합'), 'A 는 예산 축에서 앞선다');
    score('Pareto', st[1].axes.includes('요구 기능'), 'B 는 기능 축에서 앞선다');
    score('Pareto', !/[a-z]+_[a-z]+|budget|feature/.test(JSON.stringify(st)),
      '★ 내부 축 키가 새지 않는다(한국어 라벨만)');
  }
  score('Pareto', PA.strengthsByAxis([mk('A', S({}))]).length === 0, '후보 1개면 강점 비교 없음');
  score('Pareto', PA.strengthsByAxis(null).length === 0, 'null 안전');
}

/* ══════════════════════════════════════════════════════════════
   D. 예산 탄력성 (16)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[D] 예산 탄력성');
{
  const build = () => [
    item('A', '알파 무선 이어폰 마이크 노이즈캔슬링 500mAh', 150000, hist(140000, 170000, -5)),
    item('B', '베타 무선 이어폰 노이즈캔슬링 방수 1500mAh', 180000, hist(175000, 182000, -2)),
    item('C', '감마 무선 이어폰 마이크', 89000, hist(85000, 95000, -4)),
    item('D', '델타 무선 이어폰 마이크 노이즈캔슬링 방수 2000mAh', 280000, hist(270000, 290000, -6))
  ];
  const q = '20만원 이하 무선 이어폰, 통화 중요해';
  const { r, c } = ranked(build(), q);

  const steps = PA.budgetElasticity(r, c, rankItems, clone);
  score('Elasticity', steps.length >= 2, '전환점이 계산된다', JSON.stringify(steps.map(s => s.budget)));
  score('Elasticity', steps.every(s => r.some(x => x.productId === s.productId)),
    '★ 전환 결과는 실제 후보 안에 있다');
  score('Elasticity', steps.every(s => r.some(x => Math.round(x.price) === s.budget)),
    '★ 예산 경계는 실제 상품 가격이다(임의의 숫자를 만들지 않는다)');
  {
    const ids = steps.map(s => s.productId);
    score('Elasticity', ids.every((id, i) => i === 0 || id !== ids[i - 1]),
      '★ 같은 답이 반복되지 않는다(1위가 바뀌는 지점만)');
  }
  {
    const budgets = steps.map(s => s.budget);
    score('Elasticity', budgets.every((b, i) => i === 0 || b > budgets[i - 1]),
      '예산이 오름차순이다');
  }

  // 원본 오염 없음 — 이게 깨지면 실제 추천이 망가진다
  {
    const before = r.map(x => `${x.ref}:${x._score}:${x.fit}`).join('|');
    PA.budgetElasticity(r, c, rankItems, clone);
    PA.diminishingReturns(r, c, rankItems, clone);
    const after = r.map(x => `${x.ref}:${x._score}:${x.fit}`).join('|');
    score('Elasticity', before === after, '★ 탄력성 계산이 원본 랭킹을 오염시키지 않는다');
  }

  // 한 줄 렌더
  {
    const line = PA.elasticityLine(steps, c, r[0].productId);
    score('Elasticity', typeof line === 'string', '한 줄이 문자열');
    score('Elasticity', !line.includes(r[0].ref) || !/낮추면|늘리면/.test(line.split(r[0].ref)[0] || ''),
      '★ 현재 1위로 가는 지점은 변화로 적지 않는다', line);
    score('Elasticity', PA.elasticityLine([], c) === '', '전환점이 없으면 빈 줄');
    score('Elasticity', PA.elasticityLine(null, null) === '', 'null 안전');
  }

  // 안전성
  score('Elasticity', PA.budgetElasticity([], c, rankItems, clone).length === 0, '빈 목록 안전');
  score('Elasticity', PA.budgetElasticity(r, c, null, clone).length === 0,
    '★ 랭킹 함수가 없으면 조용히 비운다');
  score('Elasticity', PA.budgetElasticity(r, c, rankItems, null).length === 0,
    '복제 함수가 없으면 조용히 비운다');
  score('Elasticity', PA.budgetElasticity(null, null, rankItems, clone).length === 0, 'null 안전');

  // 결정론
  {
    const a = JSON.stringify(PA.budgetElasticity(ranked(build(), q).r, c, rankItems, clone));
    const b = JSON.stringify(PA.budgetElasticity(ranked(build(), q).r, c, rankItems, clone));
    score('Elasticity', a === b, '★ 탄력성 계산은 결정적이다');
  }
}

/* ══════════════════════════════════════════════════════════════
   E. 한계효용 (10)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[E] 한계효용');
{
  const build = () => [
    item('A', '알파 무선 이어폰 마이크 노이즈캔슬링 500mAh', 150000, hist(140000, 170000, -5)),
    item('B', '베타 무선 이어폰 노이즈캔슬링 방수 1500mAh', 180000, hist(175000, 182000, -2)),
    item('C', '감마 무선 이어폰 마이크', 89000, hist(85000, 95000, -4))
  ];
  const q = '20만원 이하 무선 이어폰, 통화 중요해';
  const { r, c } = ranked(build(), q);

  const curve = PA.diminishingReturns(r, c, rankItems, clone);
  score('Returns', Array.isArray(curve), '곡선이 배열로 나온다');
  score('Returns', curve.length === 0 || curve[0].gain === null,
    '★ 첫 구간에는 비교 대상이 없으므로 gain 이 null');
  score('Returns', curve.every(x => x.gain === null || typeof x.gain === 'number'),
    'gain 은 숫자이거나 null');
  score('Returns', curve.every(x => r.some(y => y.ref === x.ref)), '결과는 실제 후보를 가리킨다');

  {
    const line = PA.returnsLine(curve);
    score('Returns', typeof line === 'string', '한 줄이 문자열');
    score('Returns', !/[0-9]+\.[0-9]/.test(line.replace(/[0-9,]+원/g, '')),
      '★ 점수 숫자가 새지 않는다(금액만 나온다)', line);
    score('Returns', PA.returnsLine([]) === '', '빈 곡선은 빈 줄');
    score('Returns', PA.returnsLine(null) === '', 'null 안전');
  }

  score('Returns', PA.diminishingReturns([], c, rankItems, clone).length === 0, '빈 목록 안전');
  {
    const a = JSON.stringify(PA.diminishingReturns(ranked(build(), q).r, c, rankItems, clone));
    const b = JSON.stringify(PA.diminishingReturns(ranked(build(), q).r, c, rankItems, clone));
    score('Returns', a === b, '★ 한계효용 계산은 결정적이다');
  }
}

/* ══════════════════════════════════════════════════════════════
   F. 대체품 (14)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[F] 대체품');
{
  const build = () => [
    item('A', '알파 무선 이어폰 마이크 노이즈캔슬링 방수 500mAh', 150000, hist(140000, 170000, -5)),
    item('B', '베타 무선 이어폰 마이크 노이즈캔슬링', 110000, hist(105000, 118000, -3)),
    item('C', '감마 이어폰', 60000, hist(55000, 65000, -2))
  ];
  const { r } = ranked(build(), '20만원 이하 무선 이어폰, 통화 중요해');

  const sub = PA.substitute(r[0], r);
  score('Substitute', !!sub, '대체품이 계산된다', JSON.stringify(sub));
  score('Substitute', sub.savedMoney > 0, '★ 절약 금액이 양수', String(sub.savedMoney));
  score('Substitute', sub.savedMoney === Math.round(r[0].price) - Math.round(r.find(x => x.ref === sub.ref).price),
    '★ 절약 금액이 실제 가격 차이와 같다');
  score('Substitute', Array.isArray(sub.keptFeatures) && Array.isArray(sub.lostFeatures),
    '지킨 것과 잃는 것이 나뉜다');
  score('Substitute', sub.keptFeatures.every(f => (r[0].spec.features || []).includes(f)),
    '★ 지킨 기능은 원래 상품이 가진 것에서만 나온다');
  score('Substitute', sub.lostFeatures.every(f => (r[0].spec.features || []).includes(f)),
    '★ 잃는 기능도 원래 상품이 가진 것에서만 나온다');
  score('Substitute', r.some(x => x.productId === sub.productId), '실제 후보를 가리킨다');
  score('Substitute', Math.round(r.find(x => x.ref === sub.ref).price) < Math.round(r[0].price),
    '★ 대체품은 반드시 더 싸다');

  // 더 싼 것이 없으면 null
  {
    const only = [item('A', '알파 이어폰', 50000, null), item('B', '베타 이어폰', 90000, null)];
    const { r: rr } = ranked(only, '이어폰');
    const cheapest = rr.reduce((a, b) => (a.price <= b.price ? a : b));
    score('Substitute', PA.substitute(cheapest, rr) === null,
      '★ 이미 최저가면 대체품이 없다');
  }
  score('Substitute', PA.substitute(null, r) === null, 'null 기준 안전');
  score('Substitute', PA.substitute(r[0], []) === null, '빈 후보 안전');
  score('Substitute', PA.substitute(r[0], [r[0]]) === null, '자기 자신뿐이면 없음');
  score('Substitute', PA.substitute({ price: 0 }, r) === null, '가격 0 안전');
  {
    const a = JSON.stringify(PA.substitute(ranked(build(), '20만원 이하 이어폰, 통화 중요해').r[0],
      ranked(build(), '20만원 이하 이어폰, 통화 중요해').r));
    const b = JSON.stringify(PA.substitute(ranked(build(), '20만원 이하 이어폰, 통화 중요해').r[0],
      ranked(build(), '20만원 이하 이어폰, 통화 중요해').r));
    score('Substitute', a === b, '★ 대체품 계산은 결정적이다');
  }
}

/* ══════════════════════════════════════════════════════════════
   G. 프롬프트 블록 (10)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[G] 프롬프트 블록');
{
  const build = () => [
    item('A', '알파 무선 이어폰 마이크 노이즈캔슬링 500mAh', 150000, hist(140000, 170000, -5)),
    item('B', '베타 무선 이어폰 노이즈캔슬링 방수 1500mAh', 180000, hist(175000, 182000, -2)),
    item('C', '감마 무선 이어폰 마이크', 89000, hist(85000, 95000, -4))
  ];
  const q = '20만원 이하 무선 이어폰, 통화 중요해';
  const { r, c } = ranked(build(), q);
  const cls = PA.classify(r);
  const analysis = {
    shape: cls.shape, label: cls.label,
    strengths: PA.strengthsByAxis(r),
    elasticity: PA.elasticityLine(PA.budgetElasticity(r, c, rankItems, clone), c, r[0].productId),
    returns: PA.returnsLine(PA.diminishingReturns(r, c, rankItems, clone)),
    substitute: PA.substitute(r[0], r)
  };
  const block = PA.paretoBlock(analysis);

  score('Block', block.includes('[다목적 분석]'), '블록이 만들어진다');
  score('Block', !/_sub|_score|budget:|feature:/.test(block), '★ 내부 키·점수가 새지 않는다');
  score('Block', !/[a-z]{4,}_[a-z]+/.test(block), '★ snake_case 내부 이름이 없다');
  score('Block', PA.paretoBlock(null) === '', 'null 이면 빈 문자열');
  score('Block', PA.paretoBlock({}) === '', '재료가 없으면 빈 문자열');
  score('Block', PA.paretoBlock({ shape: 'single', label: 'x' }) === '',
    '★ 후보 하나뿐이면 억지로 만들지 않는다');
  score('Block', block.split('\n').length <= 7, '블록이 지나치게 길지 않다',
    String(block.split('\n').length));
  {
    const many = PA.paretoBlock(Object.assign({}, analysis, {
      strengths: [1, 2, 3, 4, 5].map(i => ({ ref: 'P' + i, axes: ['예산 적합'] }))
    }));
    score('Block', (many.match(/P\d\(/g) || []).length <= 3, '★ 강점 목록은 셋까지만');
  }
  score('Block', typeof PA.paretoBlock(analysis) === 'string', '항상 문자열');
  {
    const a = PA.paretoBlock(analysis);
    const b = PA.paretoBlock(analysis);
    score('Block', a === b, '★ 블록 렌더는 결정적이다');
  }
}

/* ══════════════════════════════════════════════════════════════
   결과
   ══════════════════════════════════════════════════════════════ */
console.log('\n' + '='.repeat(66));
console.log('SEOSA AI — 다목적·성향 평가 (오프라인)');
console.log('='.repeat(66));

let totalPass = 0, totalFail = 0;
Object.keys(metrics).forEach(k => {
  const m = metrics[k];
  const n = m.pass + m.fail;
  const pct = n ? Math.round(m.pass / n * 100) : 0;
  const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
  console.log(`  ${k.padEnd(15)} ${bar} ${String(m.pass).padStart(3)}/${String(n).padEnd(3)} (${pct}%)`);
  totalPass += m.pass; totalFail += m.fail;
});
console.log('-'.repeat(66));
console.log(`  측정됨          ${totalPass}/${totalPass + totalFail} (${Math.round(totalPass / (totalPass + totalFail) * 100)}%)`);
console.log('  UNAVAILABLE     LLM 응답 품질 (크레딧 필요) → npm run test:concierge');

const misses = [];
Object.keys(metrics).forEach(k => metrics[k].misses.forEach(t => misses.push(`[${k}] ${t}`)));
if (misses.length) {
  console.log('\n미달 항목:');
  misses.forEach(t => console.log(`  - ${t}`));
}
process.exit(totalFail ? 1 : 0);
