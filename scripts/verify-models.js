#!/usr/bin/env node
/*
 * 모델 사슬의 id 가 OpenRouter 에 실제로 존재하는지 확인한다 (읽기 전용).
 *
 * ── 왜 필요한가 (2026-08-30 실제 사고) ─────────────────────────
 *
 * api/_llm.js 의 무료 사슬 초판에 흔히 알려진 id 세 개를 적었는데,
 * /api/v1/models 를 받아 보니 **셋 다 존재하지 않았다.** 그대로 배포했으면
 * 매 요청이 404 를 세 번 거친 뒤 결정론 답변으로만 떨어졌을 것이다 —
 * 서비스가 멈추지는 않지만 AI 설명이 조용히 사라진다.
 *
 * 무료 모델 id 는 공급자 사정으로 계속 바뀐다. 그래서 이 확인은 코드가
 * 아니라 시점의 문제이고, 테스트 체인(오프라인)에 넣을 수 없다.
 * 배포 전에 한 번 손으로 돌린다.
 *
 *   node scripts/verify-models.js
 *
 * ★ 생성 호출을 하지 않는다. 모델 목록만 받으므로 비용이 들지 않는다.
 */
'use strict';

require('./_env.js');

const llm = require('../api/_llm');

(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY 없음 — .env.local 을 확인하세요');
    process.exit(1);
  }

  const r = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
  });
  if (!r.ok) {
    console.error(`모델 목록 조회 실패: ${r.status}`);
    process.exit(1);
  }
  const data = await r.json();
  const ids = new Set((data.data || []).map(m => m.id));
  console.log(`OpenRouter 모델 ${ids.size}종 (무료 ${[...ids].filter(llm.isFree).length}종)\n`);

  let missing = 0;
  ['answer', 'classify'].forEach(role => {
    console.log(`[${role}] 사슬`);
    llm.chainFor(role).forEach((m, i) => {
      const ok = ids.has(m);
      if (!ok) missing++;
      console.log(`  ${i + 1}. ${ok ? '[OK]  ' : '[없음]'} ${m}`);
    });
    console.log('');
  });

  if (missing) {
    console.log(`[FAIL] 사슬에 없는 모델 ${missing}개.`);
    console.log('       api/_llm.js 의 FREE_* 목록을 고치거나 OPENROUTER_MODELS 로 덮어쓰세요.');
    console.log('\n지금 쓸 수 있는 무료 모델:');
    [...ids].filter(llm.isFree).forEach(m => console.log(`   ${m}`));
    process.exit(1);
  }
  console.log('[PASS] 사슬의 모든 모델이 존재한다.');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
