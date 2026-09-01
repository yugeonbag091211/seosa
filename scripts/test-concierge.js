#!/usr/bin/env node
/*
 * SEOSA Concierge 조립 테스트 (api/_concierge.js) — 순수 함수, 외부 호출 0회.
 *
 * ── 무엇을 고정하는가 ───────────────────────────────────────────
 *
 * 이 모듈은 LLM 없이 답을 만든다. 그래서 "말이 데이터를 앞지르지 않는가" 가
 * 전부다. 아래 성질을 고정한다.
 *
 *   · 새 사실을 만들지 않는다 — 답변의 모든 금액이 입력에 실제로 있는 값이다
 *   · 근거가 없으면 단정하지 않는다 — 판정 UNKNOWN 을 "괜찮다" 로 바꾸지 않는다
 *   · 확신이 낮으면 문장도 낮춘다
 *   · 비싸면 비싸다고 말한다 — 팔려고 밀지 않는다 (지시 6항)
 *   · 후속 질문은 답할 수 있는 것만, 재촉 없이 (지시 8·17항)
 *
 *   node scripts/test-concierge.js
 */
'use strict';

const CG = require('../api/_concierge');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ── 픽스처 ─────────────────────────────────────────────────── */
function items() {
  return [
    { title: '베타 무선 이어폰 노이즈캔슬링', price: 89000,
      fit: '조건 대조: 예산 적합', notes: ['이번 후보 중 최저가'] },
    { title: '감마 무선 이어폰', price: 95000 },
    { title: '알파 무선 이어폰', price: 250000 }
  ];
}
function deal(verdict, over) {
  return Object.assign({
    verdict,
    label: { BUY: '지금 사도 좋다', GOOD_BUY: '싼 편이다', NORMAL: '평범한 가격이다',
      WATCH: '지켜볼 만하다', WAIT: '기다리는 편이 낫다', DONT_BUY: '지금은 비싸다',
      UNKNOWN: '판정할 근거가 없다' }[verdict],
    reasons: ['30일 평균 101,000원보다 12% 낮다'],
    cautions: [], anomalies: [],
    freshness: { level: 'excellent', label: '오늘 확인된 가격', days: 0 }
  }, over || {});
}
function decision(over) {
  return Object.assign({
    recommendation: 'strong',
    confidence: { confidence: 'high' },
    decisive: ['조건 대조: 예산 적합', '이번 후보 중 최저가'],
    tradeoffs: []
  }, over || {});
}

/** 문장에 나온 "N원" 을 전부 뽑는다. */
function wonsIn(t) { return (t.match(/[0-9][0-9,]*(?=\s*원)/g) || []).map(s => s.replace(/,/g, '')); }

(async () => {
  console.log('=== SEOSA Concierge 조립 (오프라인) ===\n');

  /* ── 1. 지어내지 않는다 ─────────────────────────────────────── */
  console.log('[1] 새 사실을 만들지 않는다');
  {
    const r = CG.compose({ items: items(), cards: [1], decision: decision(),
      deal: deal('BUY'), constraints: { budgetMax: 100000 } });
    /*
     * 답변에 나오는 금액은 셋 중 하나여야 한다.
     *   상품 가격 · 예산 · 판정 근거 문장이 원래 들고 있던 값
     * 그 밖의 숫자가 나오면 이 모듈이 계산을 하고 있다는 뜻이다.
     */
    const known = ['89000', '95000', '250000', '100000', '101000'];
    const unknown = wonsIn(r.text).filter(w => known.indexOf(w) < 0);
    check('★★ 답변의 모든 금액이 입력에 있는 값이다', unknown.length === 0, unknown.join(', '));
    check('추천 상품과 가격을 말한다', /추천: .*89,000원/.test(r.text), r.text.split('\n')[0]);
    check('다른 후보도 알린다 (1위만 밀지 않는다)', /다른 후보:/.test(r.text));
    check('사용자 조건을 지켰다고 밝힌다', /예산 100,000원은 그대로 반영/.test(r.text));
  }
  {
    const r = CG.compose({ items: [], cards: [], decision: null, deal: null, constraints: null });
    check('★ 상품이 없으면 있는 척하지 않는다',
      /찾지 못했어요/.test(r.text) && !/추천: /.test(r.text), r.text);
  }

  /* ── 2. 근거가 없으면 단정하지 않는다 ───────────────────────── */
  console.log('\n[2] 근거 없는 단정 금지');
  {
    const r = CG.compose({ items: items(), cards: [1], decision: decision(),
      deal: deal('UNKNOWN', { reasons: ['가격 기록이 2일치뿐이라 판단할 근거가 부족하다'] }) });
    check('★★ 판정 불가를 "괜찮다" 로 바꾸지 않는다',
      /판단할 근거가 부족합니다/.test(r.text), (r.text.match(/구매 시점: [^\n]*/) || [])[0]);
    check('★ 사도 좋다는 말을 하지 않는다', !/사도 좋은 값/.test(r.text));
    check('왜 판단할 수 없는지도 밝힌다', /2일치뿐/.test(r.text));
  }
  {
    const r = CG.compose({ items: items(), cards: [1], decision: decision(), deal: null });
    check('가격 기록 자체가 없으면 그렇게 말한다',
      /가격 기록이 없어 판단하지 않았습니다/.test(r.text));
  }

  /* ── 3. 확신도에 따라 문장의 세기가 바뀐다 ──────────────────── */
  console.log('\n[3] 확신도 반영 (지시 7항)');
  {
    const hi = CG.compose({ items: items(), cards: [1], deal: deal('BUY'),
      decision: decision({ confidence: { confidence: 'high' } }) }).text;
    const lo = CG.compose({ items: items(), cards: [1], deal: deal('BUY'),
      decision: decision({ confidence: { confidence: 'low' } }) }).text;
    check('확신이 높으면 권한다', /권해요/.test(hi));
    check('★ 확신이 낮으면 단정하지 않는다', !/이 상품을 권해요/.test(lo), lo.split('\n')[1]);
    check('★ 확신이 낮다는 사실을 숨기지 않는다', /확신이 낮아요/.test(lo));
    check('두 답의 세기가 실제로 다르다', hi !== lo);
  }
  {
    const w = CG.compose({ items: items(), cards: [1], deal: deal('BUY'),
      decision: decision({ recommendation: 'weak' }) }).text;
    check('★ 추천 강도가 weak 면 권하는 말로 시작하지 않는다',
      /자신 있게 권하기는 어려워요/.test(w) && !/이 상품을 권해요/.test(w), w.split('\n')[1]);
  }

  /* ── 4. 팔려고 밀지 않는다 ──────────────────────────────────── */
  console.log('\n[4] "안 사도 됩니다" (지시 6항)');
  for (const [v, want] of [['WAIT', /서두르지 않는/], ['DONT_BUY', /권하지 않아요/]]) {
    const r = CG.compose({ items: items(), cards: [1], decision: decision(), deal: deal(v) });
    check(`★★ ${v} 이면 지금 사지 말라고 말한다`, want.test(r.text),
      r.text.split('\n').filter(l => want.test(l))[0] || r.text.split('\n')[2]);
  }
  {
    const r = CG.compose({ items: items(), cards: [1], decision: decision(),
      deal: deal('BUY', { cautions: ['최근 7일 가격 변동이 크다'] }) });
    check('★ 판정이 좋아도 주의는 빠뜨리지 않는다', /주의:/.test(r.text) && /변동이 크다/.test(r.text));
  }

  /* ── 5. 후속 질문 ───────────────────────────────────────────── */
  console.log('\n[5] 후속 질문 (지시 8항)');
  {
    const f = CG.followups({ items: items(), decision: decision(), deal: deal('BUY'),
      constraints: { budgetMax: 100000 } });
    check('후속 질문을 준다', f.length > 0, f.join(' / '));
    check('상한을 지킨다', f.length <= CG.MAX_FOLLOWUPS, String(f.length));
    check('중복이 없다', new Set(f).size === f.length);
    check('근거를 다시 물을 수 있다', f.indexOf('이거 왜 추천했어?') >= 0);
    check('비교로 이어진다', f.some(q => /비교/.test(q)));
    check('★ 상품명을 잘라 넣지 않는다 (다음 턴 검색어가 망가진다)',
      !f.some(q => /무선 이어폰 노이즈/.test(q)), f.join(' / '));
  }
  {
    // 1위가 가장 싸다 → "더 싼 건 없어?" 는 답할 수 없는 질문이다.
    const f = CG.followups({ items: items(), decision: decision(), deal: deal('BUY') });
    check('★ 더 싼 후보가 없으면 "더 싼 건?" 을 권하지 않는다',
      f.indexOf('더 싼 건 없어?') < 0, f.join(' / '));

    const desc = [{ title: 'A', price: 250000 }, { title: 'B', price: 89000 }];
    const f2 = CG.followups({ items: desc, decision: decision(), deal: deal('BUY') });
    check('더 싼 후보가 있으면 권한다', f2.indexOf('더 싼 건 없어?') >= 0, f2.join(' / '));
  }
  {
    const f = CG.followups({ items: items(), decision: decision(), deal: deal('UNKNOWN') });
    check('★ 판정이 없으면 구매 시점을 묻지 않는다 (답할 수 없다)',
      !f.some(q => /지금 사는 게/.test(q)), f.join(' / '));
  }
  {
    check('맥락이 없으면 아무것도 권하지 않는다',
      CG.followups({}).length === 0);
  }
  {
    /*
     * 다크 패턴 검사 (지시 17항).
     * 재촉·가짜 긴급성·근거 없는 최상급이 칩 문구에 섞이면 안 된다.
     */
    const all = [];
    [['BUY', true], ['WAIT', false], ['UNKNOWN', false]].forEach(([v]) => {
      all.push.apply(all, CG.followups({ items: items(), decision: decision(), deal: deal(v),
        constraints: { budgetMax: 100000 }, noResult: {} }));
    });
    const bad = /지금 사세요|서두르|놓치|마감|품절 임박|곧 오릅|최고|무조건/;
    check('★★ 후속 질문에 재촉·가짜 긴급성이 없다', !all.some(q => bad.test(q)),
      all.filter(q => bad.test(q)).join(' / '));
    /*
     * 칩에 들어갈 말이므로 짧아야 하고, 사용자가 실제로 할 법한 말이어야 한다.
     * (물음표를 강제하지는 않는다 — "비교해줘" 처럼 부탁하는 말도 자연스럽다)
     */
    check('칩 한 줄에 들어갈 길이다', all.every(q => q.length <= 24), all.filter(q => q.length > 24).join(' / '));
    check('빈 문자열이 섞이지 않는다', all.every(q => q && q.trim() === q));
  }

  /* ── 6. degraded 모드 ───────────────────────────────────────── */
  console.log('\n[6] LLM 실패 뒤 (degraded)');
  {
    const d = CG.compose({ items: items(), cards: [1], decision: decision(),
      deal: deal('BUY'), degraded: true }).text;
    const n = CG.compose({ items: items(), cards: [1], decision: decision(),
      deal: deal('BUY') }).text;
    check('★ 왜 짧은지 밝힌다 — AI 가 정상인 척하지 않는다', /AI 응답이 실패했기 때문/.test(d));
    check('정상 경로에는 그 말을 붙이지 않는다', !/AI 응답이 실패했기 때문/.test(n));
    check('★ 판정·근거는 두 경로가 똑같다',
      /구매 시점: 지금 사도 좋다/.test(d) && /구매 시점: 지금 사도 좋다/.test(n));
  }

  /* ── 7. 문자열 위생 ─────────────────────────────────────────── */
  console.log('\n[7] 문자열 위생');
  {
    check('긴 상품명은 자른다', CG.shortTitle('가'.repeat(80), 20).length <= 21);
    check('공백을 정리한다', CG.shortTitle('  A   B  ', 20) === 'A B');
    check('금액에 자릿점을 넣는다', CG.won(1234567) === '1,234,567');
    check('숫자가 아니면 0 으로', CG.won('abc') === '0' && CG.won(null) === '0');
    const r = CG.compose({ items: [{ title: 'X', price: 0 }], cards: [1], deal: null });
    check('★ 가격이 0 이면 금액을 지어내지 않는다', !/0원/.test(r.text), r.text.split('\n')[0]);
  }

  /* ── 7-b. "이유" 자리에 부정형이 들어가지 않는다 ─────────────── */
  console.log('\n[7-b] 이유 자리의 부정형 (2026-08-30 실측 회귀)');
  {
    /*
     * 실측: decide().decisive 에 "검색어와 상품명이 일치하지 않음" 이 들어
     * 있었고, 그것이 사용자 화면의 "이유:" 첫 줄로 나갔다.
     * 추천하는 근거가 부정형이면 읽는 사람이 어리둥절해진다.
     */
    const d = decision({ decisive: ['검색어와 상품명이 일치하지 않음', '30일 평균보다 3.5% 저렴'] });
    const r = CG.compose({ items: items(), cards: [1], decision: d, deal: deal('NORMAL') });
    check('★★ 부정형은 이유로 쓰지 않는다', !/이유:[\s\S]*일치하지 않음/.test(r.text),
      (r.text.match(/이유:\n[^\n]*/) || [])[0]);
    check('긍정 근거는 그대로 남는다', /3\.5% 저렴/.test(r.text));

    const only = CG.reasons(null, decision({ decisive: ['확인 안 됨', '예산 초과'] }));
    check('쓸 수 있는 이유가 하나도 없으면 빈 목록', only.length === 0, only.join(' / '));
  }

  /* ── 7-c. 품질 게이트 ───────────────────────────────────────── */
  console.log('\n[7-c] 품질 게이트 — 모델이 내부 블록을 베꼈는가');
  {
    const dump = [
      'P1을 권합니다.',
      '결정적 이유: 예산 적합 / 30일 평균보다 3.5% 저렴',
      '포기하는 것: 다른 후보가 나은 점: 10,000원 더 저렴',
      '다른 기준이라면: 가격만 본다면 P3'
    ].join('\n');
    check('★★ 내부 라벨이 여럿이면 덤프로 판정한다', CG.looksLikeBlockDump(dump),
      String(CG.blockLabelCount(dump)));

    const good = '알파 노트북을 권해요. 289,000원으로 30일 평균보다 3.7% 낮습니다. 다만 역대 최저가는 아니에요.';
    check('★ 사람이 쓴 것 같은 답변은 건드리지 않는다', !CG.looksLikeBlockDump(good));

    // 우리 조립본 자신이 덤프로 오판되면 무한 대체가 된다.
    const ours = CG.compose({ items: items(), cards: [1], decision: decision(), deal: deal('BUY'),
      constraints: { budgetMax: 100000 } }).text;
    check('★★ 우리 조립본은 덤프로 판정되지 않는다', !CG.looksLikeBlockDump(ours),
      String(CG.blockLabelCount(ours)));

    const one = '가격 수준 판정: 평범한 가격이에요.';
    check('라벨 하나가 스치는 것으로는 바꾸지 않는다 (보수적 판정)', !CG.looksLikeBlockDump(one));
  }

  /* ── 8. 분류기 출력 파싱 ────────────────────────────────────── */
  console.log('\n[8] 분류기 출력 파싱 (api/ai.js parseClassification)');
  {
    const P = require('../api/ai.js')._internal.parseClassification;

    check('한 글자만 오면 그대로', P('A').intent === 'A');
    check('검색어가 붙으면 함께 뽑는다',
      P('C|무선 이어폰').intent === 'C' && P('C|무선 이어폰').query === '무선 이어폰');
    check('마침표·공백이 붙어도 통과', P(' C. ').intent === 'C');
    check('물음표는 문맥 필요 신호', P('?').intent === '?');
    check('A·B 에 딸려온 검색어는 버린다', P('B|노트북').query === '');

    /*
     * ★★ 2026-08-30 실측 회귀.
     *
     * 무료 모델이 reasoning 을 켠 채로 32토큰을 전부 생각에 써서 이런 것을 냈다.
     * 예전 파서(`\b([A-E])\b`)는 이런 문장에서도 글자를 주워 담아 엉뚱한
     * 의도로 답하게 만들 수 있었다. 분류 실패(예외)가 옳은 결과다 —
     * 호출부가 전체 맥락으로 답한다.
     */
    const noisy = 'We need to classify the user\'s last message: "30만원 이하 노트북 추천해줘". This is a request for recommendation';
    let threw = false;
    try { P(noisy); } catch (e) { threw = true; }
    check('★★ 모델이 생각을 늘어놓으면 의도를 지어내지 않고 실패한다', threw);

    let threw2 = false;
    try { P('이 메시지는 추천 요청입니다'); } catch (e) { threw2 = true; }
    check('★ 한국어 설명문도 통과시키지 않는다', threw2);

    let threw3 = false;
    try { P(''); } catch (e) { threw3 = true; }
    check('빈 응답도 실패로 다룬다', threw3);
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
