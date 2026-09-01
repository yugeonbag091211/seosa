#!/usr/bin/env node
/**
 * SINGULARITY Stage 1 평가 — 피드백 · 부정 선호 · 개인화 랭킹.
 * 오프라인, 외부 호출 0회.
 *
 * ── 무엇을 재는가 ───────────────────────────────────────────────
 *
 *   Feedback        거부의 "이유"를 정확히 읽는가
 *   Exclude         "삼성 빼줘"를 이름으로 정확히 잡는가
 *   Personalization 취향이 실제로 순위를 바꾸는가
 *   Preserve        ★ 취향이 없으면 기존 랭킹과 완전히 동일한가
 *   Truncation      잘린 답변을 안전하게 다듬는가
 *
 * ── 가장 중요한 검사 ────────────────────────────────────────────
 *
 * Preserve 다. 개인화를 넣으면서 취향을 말하지 않은 사용자의 결과가
 * 조금이라도 달라지면 그것은 회귀다. 점수 단위까지 같은지 본다.
 *
 * 사용법: node scripts/eval-feedback.js [--verbose]
 */
'use strict';

const FB = require('../api/_feedback.js');
const PF = require('../api/_profile.js');
const { parseConstraints, rankItems } = require('../api/_shopintent.js');
const { extractSpecs, specLine, matchFeatures, wantedFeatures } = require('../api/_specs.js');
const { trimToSentence } = require('../api/ai.js')._internal;

const VERBOSE = process.argv.includes('--verbose');

const metrics = {};
function score(metric, ok, label, detail) {
  if (!metrics[metric]) metrics[metric] = { pass: 0, fail: 0, misses: [] };
  if (ok) metrics[metric].pass++;
  else { metrics[metric].fail++; metrics[metric].misses.push(`${label}${detail ? ` — ${detail}` : ''}`); }
  if (VERBOSE) console.log(`  [${ok ? 'ok' : 'MISS'}] ${metric} · ${label}${detail ? ` — ${detail}` : ''}`);
}

function item(id, title, price) {
  const it = { productId: id, title, mall: '쿠팡', price };
  const sp = extractSpecs(title);
  it.spec = sp; it.specLine = specLine(sp);
  it.featureHit = []; it.featureMiss = [];
  return it;
}
const sig = list => JSON.stringify(list.map(x => [x.productId, x._score, x.fit]));

/* ══════════════════════════════════════════════════════════════
   A. 피드백 이유 읽기 (26)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[A] 피드백 이유');
{
  const CASES = [
    ['이거 너무 무거운데',        'WEIGHT',      'portability'],
    ['무겁고 들고 다니기 힘들어',  'WEIGHT',      'portability'],
    ['너무 비싸',                'PRICE',       'price'],
    ['가격이 좀 부담돼',          'PRICE',       'price'],
    ['성능이 좀 약하네',          'PERFORMANCE', 'performance'],
    ['느리고 버벅여',            'PERFORMANCE', 'performance'],
    ['품질이 별로일 것 같아',      'QUALITY',     'quality'],
    ['금방 고장 날 것 같은데',     'QUALITY',     'quality'],
    ['디자인이 별로야',           'DESIGN',      'design'],
    ['너무 커서 불편할 듯',       'SIZE',        'portability'],
    ['배송이 너무 느려',          'DELIVERY',    '']
  ];
  CASES.forEach(([q, kind, dim]) => {
    const f = FB.readFeedback(q);
    score('Feedback', f.reasons.some(r => r.kind === kind), `"${q}" → ${kind}`,
      f.reasons.map(r => r.kind).join(',') || '(없음)');
    if (dim) {
      score('Feedback', f.reasons.some(r => r.dim === dim), `"${q}" → ${dim} 축`,
        f.reasons.map(r => r.dim).join(','));
    }
  });

  // 방향 — "너무 비싸"는 가격을 더 중요하게 본다는 뜻이다
  {
    const f = FB.readFeedback('너무 비싸');
    score('Feedback', f.reasons.find(r => r.kind === 'PRICE').dir > 0,
      '★ "비싸다" → 가격을 더 중요하게 (부호가 뒤집히면 정반대가 된다)');
  }

  // 근거가 반드시 붙는다
  {
    const f = FB.readFeedback('이거 너무 무거운데');
    score('Feedback', f.reasons.every(r => r.evidence && '이거 너무 무거운데'.includes(r.evidence)),
      '★ 모든 불만에 사용자가 실제로 쓴 근거가 붙는다',
      JSON.stringify(f.reasons.map(r => r.evidence)));
    score('Feedback', f.reasons.every(r => r.source === 'explicit'), '출처가 explicit 로 기록된다');
  }

  // 거부가 아닌 말
  ['좋아요 이걸로 할게요', '고마워', '이거 살게', ''].forEach(q => {
    score('Feedback', FB.readFeedback(q).isReject === false, `"${q || '(빈 문자열)'}" 은 거부가 아니다`);
  });

  // 이유 없는 거부
  {
    const f = FB.readFeedback('이거 별로야');
    score('Feedback', f.isReject && f.reasons.length === 0,
      '★ 이유 없는 거부는 거부로 잡되 이유를 지어내지 않는다');
    const block = FB.feedbackBlock(f, []);
    score('Feedback', /무엇이 마음에 들지 않았는지/.test(block),
      '★ 이유가 없으면 되묻으라고 명시한다');
  }

  score('Feedback', FB.readFeedback(null).isReject === false, 'null 안전');
  score('Feedback', FB.toProfileSignals(null).length === 0, 'null 신호 안전');
  score('Feedback', FB.feedbackBlock(null, null) === '', 'null 블록은 빈 문자열');

  // 성향 신호 변환
  {
    const s = FB.toProfileSignals(FB.readFeedback('너무 무거운데'));
    score('Feedback', s.length === 1 && s[0].dim === 'portability', '성향 신호로 변환된다');
    score('Feedback', s[0].delta === FB.FEEDBACK_DELTA,
      '★ 거부는 일반 선호보다 강한 신호다', String(s[0].delta));
    score('Feedback', FB.toProfileSignals(FB.readFeedback('배송이 느려')).length === 0,
      '성향 축이 없는 불만은 가중치를 건드리지 않는다');
  }
}

/* ══════════════════════════════════════════════════════════════
   B. 제외 지시 (18)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[B] 제외 지시');
{
  const EX = [
    ['삼성은 빼줘',      '삼성', false],
    ['삼성 절대 빼줘',   '삼성', true],
    ['애플은 말고',      '애플', false],
    ['LG 제외해줘',      'LG',   false],
    ['샤오미는 싫어',    '샤오미', false]
  ];
  EX.forEach(([q, name, hard]) => {
    const f = FB.readFeedback(q);
    const e = f.excludes[0];
    score('Exclude', !!e && e.name === name, `"${q}" → ${name}`, e && e.name);
    score('Exclude', !!e && e.hard === hard, `"${q}" → hard=${hard}`, e && String(e.hard));
  });

  // 이름이 아닌 것
  ['이거 말고 다른 거', '그냥 빼줘', '절대 빼'].forEach(q => {
    score('Exclude', FB.readFeedback(q).excludes.length === 0,
      `★ "${q}" 는 브랜드 이름이 아니다`, JSON.stringify(FB.readFeedback(q).excludes.map(e => e.name)));
  });

  // 소프트 제외는 지우지 않는다
  {
    const items = [item('S1', '삼성 갤럭시 버즈 노이즈캔슬링', 90000), item('B2', '베타 이어폰', 120000)];
    const soft = FB.applyExcludes(items.map(x => Object.assign({}, x)), FB.readFeedback('삼성은 빼줘').excludes);
    score('Exclude', soft.length === 2, '★ 소프트 제외는 후보를 지우지 않는다', String(soft.length));
    score('Exclude', soft.find(x => x.productId === 'S1')._excludePenalty === FB.EXCLUDE_PENALTY,
      '대신 강한 감점이 붙는다');

    const hard = FB.applyExcludes(items.map(x => Object.assign({}, x)), FB.readFeedback('삼성 절대 빼줘').excludes);
    score('Exclude', hard.length === 1 && hard[0].productId === 'B2',
      '★ "절대" 는 목록에서 제거한다', hard.map(x => x.productId).join(','));
  }

  // 순위가 실제로 바뀐다 + 사유가 남는다
  {
    const mk = () => [item('S1', '삼성 갤럭시 버즈 노이즈캔슬링 마이크 방수', 90000),
                      item('B2', '베타 무선 이어폰', 120000)];
    const c = parseConstraints('20만원 이하 이어폰');
    const base = rankItems(mk(), c, '');
    const after = rankItems(FB.applyExcludes(mk(), FB.readFeedback('삼성은 빼줘').excludes), c, '');
    score('Exclude', base[0].productId === 'S1', '기준 1위는 삼성', base[0].productId);
    score('Exclude', after[0].productId !== 'S1', '★ 제외 후 1위가 바뀐다', after[0].productId);
    score('Exclude', after.some(x => x.productId === 'S1'), '그래도 목록에는 남아 있다');
    const notes = (after.find(x => x.productId === 'S1').notes || []).filter(n => /제외/.test(n));
    score('Exclude', notes.length === 1,
      '★ 제외 사유가 프롬프트 사실로 남는다(랭킹이 notes 를 덮어써도)', JSON.stringify(notes));
  }

  score('Exclude', FB.applyExcludes([], []).length === 0, '빈 목록 안전');
  score('Exclude', FB.applyExcludes(null, null).length === 0, 'null 안전');
}

/* ══════════════════════════════════════════════════════════════
   C. ★ 기존 동작 보존 (14) — 가장 중요한 검사
   ══════════════════════════════════════════════════════════════ */
console.log('\n[C] 기존 동작 보존');
{
  const mk = () => [
    item('A', '알파 이어폰 노이즈캔슬링 마이크 방수 500mAh', 150000),
    item('B', '베타 경량 휴대용 이어폰', 80000),
    item('C', '감마 이어폰 마이크', 120000)
  ];
  const c = parseConstraints('20만원 이하 이어폰');

  // opts 를 아예 안 넘긴 경우 = 예전 호출
  const legacy = rankItems(mk(), c, '');
  // 균등 배수를 넘긴 경우 = 취향을 말하지 않은 사용자
  const neutral = rankItems(mk(), c, '', { weights: PF.multipliers(PF.emptyProfile()) });
  score('Preserve', sig(legacy) === sig(neutral),
    '★★ 취향이 없으면 점수·순서·판정이 완전히 동일하다', sig(legacy) + ' vs ' + sig(neutral));

  // undefined / null opts
  score('Preserve', sig(rankItems(mk(), c, '', undefined)) === sig(legacy), 'opts=undefined 동일');
  score('Preserve', sig(rankItems(mk(), c, '', null)) === sig(legacy), 'opts=null 동일');
  score('Preserve', sig(rankItems(mk(), c, '', {})) === sig(legacy), 'opts={} 동일');
  score('Preserve', sig(rankItems(mk(), c, '', { weights: null })) === sig(legacy), 'weights=null 동일');

  // 제외가 없으면 목록이 그대로
  score('Preserve', FB.applyExcludes(mk(), []).length === 3, '제외 지시가 없으면 목록 그대로');
  score('Preserve', sig(rankItems(FB.applyExcludes(mk(), []), c, '')) === sig(legacy),
    '★ 제외 지시가 없으면 점수도 그대로');

  // 여러 번 돌려도 같다 (결정론)
  score('Preserve', sig(rankItems(mk(), c, '')) === sig(legacy), '반복 호출 결정적');
  for (let i = 0; i < 20; i++) {
    if (sig(rankItems(mk(), c, '')) !== sig(legacy)) {
      score('Preserve', false, '20회 반복 중 결과가 흔들림'); break;
    }
    if (i === 19) score('Preserve', true, '★ 20회 반복해도 동일');
  }

  // 원본 오염 없음
  {
    const src = mk();
    const before = src.map(x => `${x.productId}:${x.price}:${x.title}`).join('|');
    rankItems(src.map(x => Object.assign({}, x)), c, '', { weights: PF.multipliers(PF.emptyProfile()) });
    score('Preserve', src.map(x => `${x.productId}:${x.price}:${x.title}`).join('|') === before,
      '★ 원본 상품 데이터가 바뀌지 않는다');
  }

  // 취향이 있어도 하드 조건을 뒤집지 않는다
  {
    const over = [item('X', '초경량 휴대용 이어폰', 500000), item('Y', '보통 이어폰', 100000)];
    let p = PF.emptyProfile();
    for (let i = 0; i < 5; i++) p = PF.applySignals(p, PF.readSignals('가벼운 게 제일 중요해', 'explicit'));
    const r = rankItems(over, parseConstraints('20만원 이하 이어폰'), '', { weights: PF.multipliers(p) });
    score('Preserve', r[0].productId === 'Y',
      '★★ 취향이 아무리 강해도 예산 초과를 1위로 올리지 않는다', r[0].productId);
  }

  score('Preserve', rankItems([], c, '', { weights: {} }).length === 0, '빈 목록 안전');
  score('Preserve', rankItems(null, null, '', null).length === 0, 'null 안전');
}

/* ══════════════════════════════════════════════════════════════
   D. 개인화가 실제로 작동 (12)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[D] 개인화');
{
  const mk = () => [
    item('A', '알파 이어폰 노이즈캔슬링 마이크 방수 500mAh', 150000),
    item('B', '베타 경량 휴대용 이어폰', 80000)
  ];
  const c = parseConstraints('20만원 이하 이어폰');
  const base = rankItems(mk(), c, '');

  // 휴대성 중시 → 경량 상품이 위로
  let p = PF.applySignals(PF.emptyProfile(), PF.readSignals('가벼운 게 제일 중요해', 'explicit'));
  p = PF.applySignals(p, PF.readSignals('들고 다닐 거야', 'explicit'));
  const port = rankItems(mk(), c, '', { weights: PF.multipliers(p) });
  score('Personalization', port[0].productId === 'B',
    '★ 휴대성 중시 → 경량 상품이 1위', `${base[0].productId} → ${port[0].productId}`);
  score('Personalization', typeof port[0]._prefAdj === 'number', '개인화 보정값이 기록된다');
  score('Personalization', port[0]._prefAdj > 0, '휴대성 상품이 가점을 받는다', String(port[0]._prefAdj));

  // 가격 중시 → 싼 쪽이 위로
  let pp = PF.emptyProfile();
  for (let i = 0; i < 3; i++) pp = PF.applySignals(pp, PF.readSignals('가성비가 제일 중요해', 'explicit'));
  const cheap = rankItems(mk(), c, '', { weights: PF.multipliers(pp) });
  score('Personalization', cheap[0].productId === 'B', '★ 가격 중시 → 싼 쪽이 1위', cheap[0].productId);

  // 성능 중시 → 사양이 많은 쪽이 위로
  let pq = PF.emptyProfile();
  for (let i = 0; i < 3; i++) pq = PF.applySignals(pq, PF.readSignals('성능이 제일 중요해', 'explicit'));
  const perf = rankItems(mk(), c, '', { weights: PF.multipliers(pq) });
  score('Personalization', perf[0].productId === 'A',
    '★ 성능 중시 → 사양이 많은 쪽이 1위', perf[0].productId);

  // 피드백 → 성향 → 재랭킹 (전체 사슬)
  {
    const fb = FB.readFeedback('이거 너무 무거운데');
    const prof = PF.applySignals(PF.emptyProfile(), FB.toProfileSignals(fb));
    const after = rankItems(mk(), c, '', { weights: PF.multipliers(prof) });
    score('Personalization', after[0].productId === 'B',
      '★★ "무겁다" 한 마디가 실제 재랭킹까지 이어진다', `${base[0].productId} → ${after[0].productId}`);
  }

  // 결정론
  {
    const w = { weights: PF.multipliers(p) };
    score('Personalization', sig(rankItems(mk(), c, '', w)) === sig(rankItems(mk(), c, '', w)),
      '★ 개인화 랭킹도 결정적이다');
  }

  // 점수가 프롬프트로 새지 않는다 (라벨만 나간다)
  {
    const line = PF.profileLine(p);
    score('Personalization', !/[0-9]\.[0-9]/.test(line), '★ 가중치 숫자가 프롬프트에 새지 않는다', line);
    score('Personalization', /\(".*"\)/.test(line), '근거가 함께 나간다');
  }

  // 취향과 제외가 함께 걸려도 안전
  {
    const items = FB.applyExcludes(mk(), FB.readFeedback('알파는 빼줘').excludes);
    const r = rankItems(items, c, '', { weights: PF.multipliers(p) });
    score('Personalization', r.length === 2 && r[0].productId === 'B', '취향+제외 동시 적용 안전');
    score('Personalization', r.find(x => x.productId === 'A')._score < base.find(x => x.productId === 'A')._score,
      '제외된 상품 점수가 내려간다');
  }
}

/* ══════════════════════════════════════════════════════════════
   E. 응답 잘림 처리 (10)
   ══════════════════════════════════════════════════════════════ */
console.log('\n[E] 응답 잘림');
{
  score('Truncation', trimToSentence('현재 89,000원입니다. 30일 평균보다 12% 낮습니다. 다만 배터리는 확인되지 않')
    === '현재 89,000원입니다. 30일 평균보다 12% 낮습니다.',
    '★ 마지막 완결 문장까지만 남긴다');
  score('Truncation', trimToSentence('현재 89,000원으로 최근 30일 평균보') === '',
    '★ 첫 문장부터 잘렸으면 빈 문자열(폴백이 받는다)');
  score('Truncation', /권합니다\.$/.test(trimToSentence('결론부터 A를 권합니다.\n- 89,000원\n- 배터리는 확')),
    '목록 중간 잘림도 다듬는다', trimToSentence('결론부터 A를 권합니다.\n- 89,000원\n- 배터리는 확'));
  score('Truncation', trimToSentence('') === '', '빈 문자열 안전');
  score('Truncation', trimToSentence(null) === '', 'null 안전');
  score('Truncation', trimToSentence(undefined) === '', 'undefined 안전');
  score('Truncation', !/[가-힣]$/.test(trimToSentence('A를 권합니다. 가격은 좋은 편입니다. 다만 배터리가 조금 아쉬')) ||
    trimToSentence('A를 권합니다. 가격은 좋은 편입니다. 다만 배터리가 조금 아쉬').endsWith('.'),
    '★ 반쪽 낱말로 끝나지 않는다');
  {
    const full = 'A를 권합니다. 가격이 좋습니다.';
    score('Truncation', trimToSentence(full) === full, '이미 완결된 글은 그대로');
  }
  score('Truncation', typeof trimToSentence('짧') === 'string', '아주 짧은 입력 안전');
  score('Truncation', trimToSentence('!'.repeat(500)).length > 0, '기호만 있어도 안전');
}

/* ══════════════════════════════════════════════════════════════
   결과
   ══════════════════════════════════════════════════════════════ */
/* ─────────────────────────────────────────────────────────────
   [F] 제외 지속 — 빼 달라고 한 것은 그 턴에서 끝나지 않는다

   실측으로 찾은 구멍이다. 성향 가중치는 buildProfile 이 앞 대화를 통째로
   읽어 이어지는데 제외만 이번 문장에서 뽑고 있었다. 그래서 "삼성은 빼줘"
   다음 턴에 삼성이 1위로 돌아왔다 — 사용자가 보기에는 말을 안 들은 것이다.
   ───────────────────────────────────────────────────────────── */
console.log('\n[F] 제외 지속');
{
  const HIST = [{ role: 'user', text: '이어폰 추천' }, { role: 'assistant', text: '삼성 버즈' }, { role: 'user', text: '삼성은 빼줘' }, { role: 'assistant', text: '알겠습니다' }];

  const now = FB.collectExcludes('삼성은 빼줘', []);
  score('Persist', now.length === 1 && now[0].name === '삼성', '이번 턴 제외를 잡는다', JSON.stringify(now.map(e => e.name)));
  score('Persist', now[0] && now[0].source === 'explicit', '이번 턴은 출처가 explicit 다');
  score('Persist', now[0] && now[0].turnsAgo === 0, '이번 턴은 turnsAgo 0 이다');

  const later = FB.collectExcludes('예산은 15만원까지야', HIST);
  score('Persist', later.length === 1 && later[0].name === '삼성',
    '★★ 앞 대화의 제외가 다음 턴에도 살아 있다', JSON.stringify(later.map(e => e.name)));
  score('Persist', later[0] && later[0].source === 'conversation',
    '★ 앞 대화에서 온 것은 출처가 conversation 이다 — 이번 턴에 말한 척하지 않는다');
  score('Persist', later[0] && later[0].turnsAgo > 0, '몇 턴 전인지 남는다', String(later[0] && later[0].turnsAgo));

  const dup = FB.collectExcludes('삼성은 빼줘', HIST);
  score('Persist', dup.length === 1, '같은 이름을 두 번 세지 않는다', String(dup.length));
  score('Persist', dup[0] && dup[0].source === 'explicit', '겹치면 이번 턴 쪽(explicit)이 이긴다');

  score('Persist', FB.collectExcludes('이어폰 추천해줘', []).length === 0,
    '★ 아무 말도 안 했으면 제외도 없다');
  score('Persist', FB.collectExcludes('이어폰 추천해줘',
    [{ role: 'user', text: '20만원 이하로' }, { role: 'assistant', text: '삼성 버즈를 권합니다' }]).length === 0,
    '★ 앞 대화에 상품 이름이 나왔다고 제외로 만들지 않는다');

  score('Persist', FB.collectExcludes('추천해줘', HIST, 0).length === 0,
    '거슬러 볼 턴 수를 0 으로 두면 이어오지 않는다');
  score('Persist', FB.collectExcludes(null, null).length === 0, '입력이 없어도 터지지 않는다');

  const blk = FB.feedbackBlock(FB.readFeedback('예산은 15만원까지야'), later);
  score('Persist', /앞 대화에서 사용자가 빼 달라고 한 것/.test(blk),
    '★ 이번 턴 거부가 아니면 머리말을 바꿔 적는다');
  score('Persist', /삼성을 크게 내렸다/.test(blk), '무엇을 어떻게 했는지 밝힌다');
  score('Persist', FB.feedbackBlock(FB.readFeedback('이어폰 추천해줘'), []) === '',
    '★ 제외도 거부도 없으면 블록 자체가 없다 — 기존 사용자에게는 아무 일도 없다');
}


console.log('\n' + '='.repeat(66));
console.log('SEOSA AI — 피드백 · 개인화 평가 (오프라인)');
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
console.log('  UNAVAILABLE      LLM 응답 품질 → npm run test:concierge');

const misses = [];
Object.keys(metrics).forEach(k => metrics[k].misses.forEach(t => misses.push(`[${k}] ${t}`)));
if (misses.length) {
  console.log('\n미달 항목:');
  misses.forEach(t => console.log(`  - ${t}`));
}
process.exit(totalFail ? 1 : 0);
