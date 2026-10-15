#!/usr/bin/env node
/*
 * 수집기 이어 붙이기 판정(continuationDecision) 테스트 — 외부 API·운영 DB 를 부르지 않는다.
 *
 *   node scripts/test-collector-continuation.js
 *
 * 2026-10-16 실측: GitHub 가 예약 칸을 버려 ADPICK(분당 5회)이 하루 예산 3,000 중 2,388만 쓰고
 * 534개를 시도도 못 했다. 레인 종료 사유는 매 실행 'time'. 수집기는 «시간이 모자라 멈췄고,
 * 하루 예산이 남았고, 이번에 실제로 호출했을 때» 만 다음 실행을 붙이라는 표식을 남긴다.
 * 여기서는 그 판정이 호출 총량의 천장(하루 예산)·차단·실패·헛도는 사슬을 넘지 않음을 고정한다.
 */
'use strict';

const C = require('./collect-all-prices');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); }
}
function eq(name, got, want) { check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const DAY_END = Date.parse('2026-10-15T15:00:00Z');        // KST 10-16 00:00
const NOON = Date.parse('2026-10-15T03:00:00Z');           // KST 12:00

// 10-15 낮 실행의 실제 모양: 쿠팡은 하루 예산 소진(호출 0), ADPICK 은 시간으로 멈춤.
function lanes(over = {}) {
  return [
    { mall: '쿠팡', stopCause: 'none', apiCalls: 0, dayUsedAfter: 3400, dayBudget: 3400, hasKey: true, refused: false,
      ...(over.coupang || {}) },
    { mall: 'ADPICK', stopCause: 'time', apiCalls: 244, dayUsedAfter: 1972, dayBudget: 3000, hasKey: true, refused: false,
      ...(over.adpick || {}) }
  ];
}
const decide = (over, extra = {}) => C.continuationDecision({ lanes: lanes(over), nowMs: NOON, dayEndMs: DAY_END, ...extra });

console.log('\n── 이어 붙이는 경우 ──');
{
  const d = decide();
  eq('ADPICK 시간 종료 + 하루 예산 남음 → 이어 붙인다', d.continue, true);
  eq('사유에 제공자와 종료 사유가 남는다', d.reason, 'ADPICK:time');
  eq('낮이면 기다리지 않는다', d.notBeforeMs, 0);
}
{
  // 10-16 05:39 실행: 쿠팡이 실행 예산 700 에서 멈췄지만 하루 예산은 2,040/3,400.
  const d = decide({ coupang: { stopCause: 'budget', apiCalls: 700, dayUsedAfter: 2040 }, adpick: { apiCalls: 245, dayUsedAfter: 734 } });
  eq('실행 예산으로 멈췄고 하루 예산이 남음 → 이어 붙인다', d.continue, true);
  eq('두 제공자 모두 열린 레인으로 센다', (d.malls || []).join(','), '쿠팡,ADPICK');
}

console.log('\n── 호출 총량의 천장: 하루 예산 ──');
{
  const d = decide({ adpick: { stopCause: 'budget', dayUsedAfter: 3000 } });
  eq('ADPICK 하루 예산 소진 → 이어 붙이지 않는다', d.continue, false);
  eq('사유 nothing_left', d.reason, 'nothing_left');
}
{
  const d = decide({ adpick: { stopCause: 'time', dayUsedAfter: 3001 } });
  eq('시간 종료여도 하루 예산을 넘었으면 이어 붙이지 않는다', d.continue, false);
}
{
  const d = decide({ coupang: { stopCause: 'budget', apiCalls: 60, dayUsedAfter: 3400 }, adpick: { stopCause: 'none', apiCalls: 10 } });
  eq('쿠팡 하루 예산 소진 + ADPICK 끝까지 돎 → 이어 붙이지 않는다', d.continue, false);
}

console.log('\n── 실패·차단·잠금 상실·대기 ──');
eq('실패한 실행(exitCode 1)은 이어 붙이지 않는다', decide({}, { exitCode: 1 }).continue, false);
eq('제공자 거절(래치) 레인은 열린 레인이 아니다', decide({ adpick: { refused: true } }).continue, false);
eq('키 없는 레인은 열린 레인이 아니다', decide({ adpick: { hasKey: false } }).continue, false);
['pending', 'blocked', 'lock_lost', 'noKeys', '', 'none'].forEach(s => {
  eq(`종료 사유 '${s}' → 이어 붙이지 않는다 (다음 예약 칸 몫)`, decide({ adpick: { stopCause: s } }).continue, false);
});

console.log('\n── 헛도는 사슬 끊기 ──');
{
  const d = decide({ adpick: { apiCalls: 0 } });
  eq('이번 실행 외부 호출 0회 → 이어 붙이지 않는다', d.continue, false);
  eq('사유 no_progress', d.reason, 'no_progress');
}
{
  // 자정 2분 전 마감 창 안에서 바로 떠서 호출 없이 끝난 실행 — 사슬이 여기서 끊겨야 한다.
  const d = C.continuationDecision({ lanes: lanes({ adpick: { apiCalls: 0, stopCause: 'time' } }), nowMs: DAY_END - 60000, dayEndMs: DAY_END });
  eq('마감이 이미 지난 실행(호출 0)은 이어 붙이지 않는다', d.continue, false);
}
eq('레인 정보가 없으면 이어 붙이지 않는다', C.continuationDecision({ nowMs: NOON, dayEndMs: DAY_END }).continue, false);

console.log('\n── 자정 ──');
{
  const now = DAY_END - 2 * 60 * 1000;     // 마감(자정 − 2분)에 끝난 실행
  const d = C.continuationDecision({ lanes: lanes(), nowMs: now, dayEndMs: DAY_END });
  eq('자정 직전에 끝나면 이어 붙이되', d.continue, true);
  eq('자정 30초 뒤부터 붙인다 (TODAY 가 어제로 뜨지 않게)', d.notBeforeMs, DAY_END + 30000);
}
{
  const now = DAY_END - C.CONTINUE_MIDNIGHT_WINDOW_MS - 1;
  eq('자정 창 밖이면 기다리지 않는다',
    C.continuationDecision({ lanes: lanes(), nowMs: now, dayEndMs: DAY_END }).notBeforeMs, 0);
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
