'use strict';

/*
 * 점심·저녁 가격 재확인의 «예약 → 실행 → 상태 → 보고» 회귀.
 *
 * 2026-10-26 사고를 케이스로 박아 둔다. 그날 점심은 예약 12:05 에 17:47 로,
 * 저녁은 예약 19:05 에 다음 날 01:38 로 깨어나 둘 다 수집 0건이었는데
 * GitHub 은 SUCCESS 를 찍고 메일도 오지 않았다. 아래 케이스 ③~⑦ 이 그
 * 시간들을 그대로 쓴다.
 *
 * ★ 외부 API·운영 DB 를 건드리지 않는다. fetch 를 막고, DB 는 가짜 클라이언트를
 *   끼운다 (프로젝트의 오프라인 테스트 관례 — tests.yml 머리말 참고).
 * ★ 통과시키려고 창(window)이나 안전장치를 끄지 않는다. 창은 그대로 두고
 *   «창을 놓쳤다» 를 MISSED 로 관측한다.
 */

const assert = require('assert');

const realFetch = global.fetch;
global.fetch = () => { throw new Error('테스트에서 외부 호출 금지'); };

const {
  STATUS, MAX_SLOT_ATTEMPTS, slotPlan, slotWindow, kstDay, delayMinutes,
  isServed, ledgerGet, ledgerPut, missedSlots, decideStatus, exitCodeFor
} = require('./_price-volatility');
const { subjectFor, buildVolatileReportHtml, statusName } = require('./_volatile-report');
const vol = require('./collect-volatile-prices');
const { volatileSlotFor, VOLATILE_SCHEDULES } = require('../api/cron');

/** KST 시각 문자열 → Date. 테스트를 읽을 때 UTC 로 환산하지 않게. */
const kst = s => new Date(Date.parse(s.replace(' ', 'T') + '+09:00'));
let n = 0;
const check = (label, fn) => { fn(); n++; console.log('  ✓ ' + label); };

console.log('\n[1] 예약 시각 — 정상·지연·창 밖');

// ① 점심 12:05 정상 실행
check('① 점심 12:05 → noon 슬롯, 지연 0분', () => {
  const p = slotPlan(kst('2026-10-26 12:05'));
  assert.strictEqual(p.slot, 'noon');
  assert.strictEqual(p.day, '2026-10-26');
  assert.strictEqual(p.minChanges, 3);
  assert.strictEqual(delayMinutes(p, kst('2026-10-26 12:05')), 0);
});

// ② 저녁 19:05 정상 실행
check('② 저녁 19:05 → evening 슬롯, 변동 1회 이상', () => {
  const p = slotPlan(kst('2026-10-26 19:05'));
  assert.strictEqual(p.slot, 'evening');
  assert.strictEqual(p.minChanges, 1);
  assert.strictEqual(delayMinutes(p, kst('2026-10-26 19:05')), 0);
});

// ③ 5분 지연
check('③ 12:10 (5분 지연) → 수집한다', () => {
  const p = slotPlan(kst('2026-10-26 12:10'));
  assert.strictEqual(p.slot, 'noon');
  assert.strictEqual(delayMinutes(p, kst('2026-10-26 12:10')), 5);
});

// ④ 30분 지연
check('④ 12:35 (30분 지연) → 수집한다', () => {
  const p = slotPlan(kst('2026-10-26 12:35'));
  assert.strictEqual(p.slot, 'noon');
  assert.strictEqual(delayMinutes(p, kst('2026-10-26 12:35')), 30);
});

// ⑤ 3시간 이상 지연 — 창(12:00~15:00)을 넘겼다
check('⑤ 15:06 (3시간 1분 지연) → 창 밖, 수집하지 않는다', () => {
  assert.strictEqual(slotPlan(kst('2026-10-26 15:06')), null);
  assert.strictEqual(slotPlan(kst('2026-10-26 15:06'), 'noon'), null);
});

// ⑥ 6시간 지연 — 실제 사고 시각 (점심 예약이 17:47 에 깨어났다)
check('⑥ 17:47 (실측 +5h42m) → 점심을 저녁에 수집하지 않는다', () => {
  assert.strictEqual(slotPlan(kst('2026-10-26 17:47'), 'noon'), null);
  assert.strictEqual(slotPlan(kst('2026-10-26 17:47')), null);
});

// ⑦ 다음 날 새벽에 전날 작업 실행 — 실제 사고 시각 (저녁 예약이 01:38)
check('⑦ 다음 날 01:38 (실측 +6h33m) → 전날 저녁을 새벽에 수집하지 않는다', () => {
  assert.strictEqual(slotPlan(kst('2026-10-27 01:38'), 'evening'), null);
  assert.strictEqual(kstDay(kst('2026-10-27 01:38')), '2026-10-27');
});

check('창 경계 — 11:59 은 아직, 12:00 부터, 15:00 은 이미 닫힘', () => {
  assert.strictEqual(slotPlan(kst('2026-10-26 11:59')), null);
  assert.strictEqual(slotPlan(kst('2026-10-26 12:00')).slot, 'noon');
  assert.strictEqual(slotPlan(kst('2026-10-26 14:59')).slot, 'noon');
  assert.strictEqual(slotPlan(kst('2026-10-26 15:00')), null);
  assert.strictEqual(slotPlan(kst('2026-10-26 18:59')), null);
  assert.strictEqual(slotPlan(kst('2026-10-26 21:59')).slot, 'evening');
  assert.strictEqual(slotPlan(kst('2026-10-26 22:00')), null);
});

check('날짜 변경 직전·직후 — KST 자정 경계에서 슬롯이 어제로 새지 않는다', () => {
  assert.strictEqual(kstDay(kst('2026-10-26 23:59')), '2026-10-26');
  assert.strictEqual(kstDay(kst('2026-10-27 00:00')), '2026-10-27');
  // KST 00:30 은 어느 창에도 없다 — 전날 저녁을 이어받지 않는다.
  assert.strictEqual(slotPlan(kst('2026-10-27 00:30')), null);
  assert.strictEqual(slotPlan(kst('2026-10-27 00:30'), 'evening'), null);
  // 창 경계는 그 KST 날짜의 경계로 계산된다.
  const w = slotWindow('2026-10-27', 'noon');
  assert.strictEqual(new Date(w.startMs).toISOString(), '2026-10-27T03:00:00.000Z');
  assert.strictEqual(new Date(w.targetMs).toISOString(), '2026-10-27T03:05:00.000Z');
  assert.strictEqual(new Date(w.endMs).toISOString(), '2026-10-27T06:00:00.000Z');
});

console.log('\n[2] 중복 실행 방지 — 슬롯 원장');

// ⑧ 같은 슬롯 중복 실행
check('⑧ 같은 (KST 날짜, 슬롯) 은 두 번째 실행을 통과시키지 않는다', () => {
  let ledger = {};
  assert.strictEqual(isServed(ledgerGet(ledger, '2026-10-26', 'noon')), false);
  ledger = ledgerPut(ledger, '2026-10-26', 'noon', { status: STATUS.COMPLETED, at: 'x' });
  assert.strictEqual(isServed(ledgerGet(ledger, '2026-10-26', 'noon')), true);
  // NO_CHANGE 도 «이미 확인했다» 다 — 다시 부르면 호출만 두 배다.
  const l2 = ledgerPut({}, '2026-10-26', 'noon', { status: STATUS.NO_CHANGE });
  assert.strictEqual(isServed(ledgerGet(l2, '2026-10-26', 'noon')), true);
  // 예산 소진도 재시도 대상이 아니다 (예산은 그 사이 늘지 않는다).
  const l3 = ledgerPut({}, '2026-10-26', 'noon', { status: STATUS.QUOTA_EXHAUSTED });
  assert.strictEqual(isServed(ledgerGet(l3, '2026-10-26', 'noon')), true);
});

// ⑨ 수집기 잠금 충돌 → 재시도 대상이다
check('⑨ 잠금 충돌(LOCKED)은 창이 열려 있으면 다시 시도한다', () => {
  const l = ledgerPut({}, '2026-10-26', 'noon', { status: STATUS.LOCKED, attempts: 1 });
  assert.strictEqual(isServed(ledgerGet(l, '2026-10-26', 'noon')), false);
  assert.strictEqual(exitCodeFor(STATUS.LOCKED), 0, 'LOCKED 은 빨간 X 가 아니다');
  assert.strictEqual(vol.shouldEmail(STATUS.LOCKED, false), false, 'LOCKED 은 메일을 보내지 않는다');
});

check('첫 실행 실패 후 안전한 재시도 — 단 ' + MAX_SLOT_ATTEMPTS + '회로 멈춘다', () => {
  for (let a = 1; a < MAX_SLOT_ATTEMPTS; a++) {
    const l = ledgerPut({}, '2026-10-26', 'noon', { status: STATUS.FAILED, attempts: a });
    assert.strictEqual(isServed(ledgerGet(l, '2026-10-26', 'noon')), false, a + '회째는 재시도');
  }
  const stop = ledgerPut({}, '2026-10-26', 'noon', { status: STATUS.FAILED, attempts: MAX_SLOT_ATTEMPTS });
  assert.strictEqual(isServed(ledgerGet(stop, '2026-10-26', 'noon')), true,
    '상한을 넘으면 더 부르지 않는다 — 실패 루프가 API 예산을 태우지 않게');
});

// ⑮ 점심 수집 성공 후 저녁 수집
check('⑮ 점심 성공이 저녁을 막지 않는다 (슬롯은 서로 독립)', () => {
  const ledger = ledgerPut({}, '2026-10-26', 'noon', { status: STATUS.COMPLETED });
  const evening = slotPlan(kst('2026-10-26 19:05'));
  assert.strictEqual(evening.slot, 'evening');
  assert.strictEqual(isServed(ledgerGet(ledger, '2026-10-26', 'evening')), false);
  // 그리고 다음 날 점심도 막지 않는다.
  assert.strictEqual(isServed(ledgerGet(ledger, '2026-10-27', 'noon')), false);
});

check('원장은 KST 4일분만 남긴다 (last_result 가 무한정 커지지 않게)', () => {
  let l = {};
  for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']) {
    l = ledgerPut(l, d, 'noon', { status: STATUS.COMPLETED });
  }
  assert.deepStrictEqual(Object.keys(l).sort(),
    ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.strictEqual(ledgerGet(l, '2026-10-20', 'noon'), null);
});

check('ledgerPut 은 입력을 바꾸지 않는다 (CAS 재시도가 섞이지 않게)', () => {
  const before = { '2026-10-26': { noon: { status: STATUS.COMPLETED } } };
  const frozen = JSON.stringify(before);
  ledgerPut(before, '2026-10-26', 'evening', { status: STATUS.NO_CHANGE });
  assert.strictEqual(JSON.stringify(before), frozen);
});

console.log('\n[3] 예약 누락 감지');

// ⑯ 스케줄러가 아예 실행되지 않은 경우
check('⑯ 창이 닫혔는데 원장이 비어 있으면 MISSED 로 잡아낸다', () => {
  // KST 2026-10-27 01:38 — 전날 점심·저녁 창이 모두 닫혔고 원장은 비어 있다.
  const missed = missedSlots(kst('2026-10-27 01:38'), {});
  const got = missed.map(w => w.day + ' ' + w.slot).sort();
  assert.deepStrictEqual(got, ['2026-10-26 evening', '2026-10-26 noon']);
});

check('한 슬롯에 경고는 한 번만 (칸 23개가 메일 23통이 되지 않게)', () => {
  let l = ledgerPut({}, '2026-10-26', 'noon',
    { status: STATUS.MISSED, notifiedMissAt: '2026-10-26T06:10:00Z' });
  l = ledgerPut(l, '2026-10-26', 'evening',
    { status: STATUS.MISSED, notifiedMissAt: '2026-10-26T13:10:00Z' });
  assert.deepStrictEqual(missedSlots(kst('2026-10-27 01:38'), l), []);
});

check('수집한 슬롯은 누락이 아니다', () => {
  let l = ledgerPut({}, '2026-10-26', 'noon', { status: STATUS.COMPLETED });
  l = ledgerPut(l, '2026-10-26', 'evening', { status: STATUS.NO_CHANGE });
  assert.deepStrictEqual(missedSlots(kst('2026-10-27 01:38'), l), []);
});

check('아직 열린 창은 누락이라고 하지 않는다', () => {
  // KST 12:30 — 점심 창이 열려 있다. 오늘 점심은 아직 기회가 있다.
  const missed = missedSlots(kst('2026-10-26 12:30'), {});
  assert.ok(!missed.some(w => w.day === '2026-10-26' && w.slot === 'noon'),
    '열린 창을 MISSED 로 보고하면 안 된다');
  // 오늘 저녁 창도 아직 오지 않았다.
  assert.ok(!missed.some(w => w.day === '2026-10-26' && w.slot === 'evening'));
});

check('그날 점심 누락은 저녁 창 전에 발견된다 (KST 18:10 감시 칸)', () => {
  const missed = missedSlots(kst('2026-10-26 18:10'), {
    '2026-10-25': { noon: { status: STATUS.COMPLETED }, evening: { status: STATUS.COMPLETED } }
  });
  assert.deepStrictEqual(missed.map(w => w.day + ' ' + w.slot), ['2026-10-26 noon']);
});

check('창이 아직 열리지 않은 이른 실행은 MISSED 가 아니다 (거짓 경보 금지)', () => {
  // KST 00:13 에 slot=noon 으로 수동 dispatch — 오늘 점심 창은 아직 안 열렸다.
  const w = slotWindow('2026-10-27', 'noon');
  assert.ok(kst('2026-10-27 00:13').getTime() < w.endMs, '창이 아직 닫히지 않았다');
  const got = missedSlots(kst('2026-10-27 00:13'), {}).map(x => x.day + ' ' + x.slot).sort();
  assert.deepStrictEqual(got, ['2026-10-26 evening', '2026-10-26 noon'],
    '어제 두 건만 누락이고 오늘 점심은 아니다');
});

console.log('\n[4] 상태 판정 · 종료코드 · 메일 정책');

// ⑩ API 한도 소진
check('⑩ 예산 소진은 QUOTA_EXHAUSTED — 초록이지만 메일로 알린다', () => {
  assert.strictEqual(exitCodeFor(STATUS.QUOTA_EXHAUSTED), 0);
  assert.strictEqual(vol.shouldEmail(STATUS.QUOTA_EXHAUSTED, false), true);
  assert.match(subjectFor({ day: '2026-10-26', slot: 'noon', status: STATUS.QUOTA_EXHAUSTED }),
    /API 예산 소진$/);
});

// ⑬ 가격 변동 없음
check('⑬ 확인은 했고 변경이 0건이면 NO_CHANGE (실패가 아니다)', () => {
  assert.strictEqual(decideStatus({ spent: 8, checked: 20, changedApplied: 0 }), STATUS.NO_CHANGE);
  assert.strictEqual(exitCodeFor(STATUS.NO_CHANGE), 0);
  assert.strictEqual(vol.shouldEmail(STATUS.NO_CHANGE, false), true);
  assert.match(subjectFor({ day: '2026-10-26', slot: 'evening', status: STATUS.NO_CHANGE,
    results: { '쿠팡': { checked: 20 }, 'ADPICK': {} } }), /확인 20건 \/ 가격 변경 0건/);
});

check('변경이 있으면 COMPLETED', () => {
  assert.strictEqual(decideStatus({ spent: 8, checked: 20, changedApplied: 3 }), STATUS.COMPLETED);
  assert.strictEqual(exitCodeFor(STATUS.COMPLETED), 0);
});

// ⑭ 옵션 불일치
check('⑭ 옵션 불일치만 나와 기록 0건이면 NO_CHANGE + 사유가 메일에 남는다', () => {
  // 호출은 했는데 같은 상품·옵션이 매칭되지 않은 경우 (checked 0, spent >0).
  assert.strictEqual(decideStatus({ spent: 6, checked: 0, changedApplied: 0 }), STATUS.NO_CHANGE);
  const html = buildVolatileReportHtml({
    day: '2026-10-26', slot: 'noon', status: STATUS.NO_CHANGE,
    reason: '검색 응답에서 동일 상품·옵션이 매칭되지 않아 기록한 가격이 없습니다',
    scheduledAt: '2026-10-26 12:05 KST', startedAt: '2026-10-26 12:07 KST', delayMinutes: 2,
    results: { '쿠팡': { spent: 6, checked: 0, optionMiss: 4 }, 'ADPICK': { spent: 0 } }
  });
  assert.match(html, /옵션 불일치/);
  assert.match(html, /동일 상품·옵션이 매칭되지 않아/);
  assert.match(html, /가격 변경 없음/);
});

check('대상이 아예 없으면 SKIPPED — 외부 호출 0회', () => {
  assert.strictEqual(decideStatus({ spent: 0, checked: 0, changedApplied: 0 }), STATUS.SKIPPED);
  assert.strictEqual(exitCodeFor(STATUS.SKIPPED), 0);
  assert.strictEqual(vol.shouldEmail(STATUS.SKIPPED, false), false,
    '중복분·대상없음으로 메일을 보내면 창마다 여덟 통이 된다');
});

check('MISSED 와 FAILED 만 빨간 X — 침묵이 성공처럼 보이지 않게', () => {
  assert.strictEqual(exitCodeFor(STATUS.MISSED), 1);
  assert.strictEqual(exitCodeFor(STATUS.FAILED), 1);
  for (const s of [STATUS.COMPLETED, STATUS.NO_CHANGE, STATUS.SKIPPED,
    STATUS.LOCKED, STATUS.QUOTA_EXHAUSTED]) {
    assert.strictEqual(exitCodeFor(s), 0, s + ' 는 초록이어야 한다');
  }
  assert.strictEqual(vol.shouldEmail(STATUS.MISSED, false), true);
  assert.strictEqual(vol.shouldEmail(STATUS.MISSED, true), false,
    'sweepMissed 가 이미 보냈으면 두 번 보내지 않는다');
});

check('7가지 상태 전부 사람이 읽을 이름이 있다 (옛 소문자 값도)', () => {
  for (const s of Object.keys(STATUS)) {
    assert.ok(statusName(s) && statusName(s) !== undefined, s);
  }
  assert.strictEqual(statusName('MISSED'), '예약 실행 누락');
  assert.strictEqual(statusName('completed'), '완료');
  assert.strictEqual(statusName('skipped'), '건너뜀');
  assert.match(subjectFor({ day: '2026-10-26', slot: 'noon', status: STATUS.MISSED,
    scheduledAt: '2026-10-26 12:05 KST' }), /⚠️.*예약 실행 누락 — 예정 2026-10-26 12:05 KST, 수집 0건/);
});

console.log('\n[5] 보고서 — 예정·실제·지연이 반드시 들어간다');

check('메일에 예정 시각·실제 시작·지연·실제 API 호출 수가 있다', () => {
  const html = buildVolatileReportHtml({
    day: '2026-10-26', slot: 'evening', status: STATUS.COMPLETED,
    scheduledAt: '2026-10-26 19:05 KST', startedAt: '2026-10-26 19:12 KST',
    finishedAt: '2026-10-26 19:31 KST', delayMinutes: 7,
    usage: { '쿠팡': 3000, 'ADPICK': 2500 }, caps: { '쿠팡': 3400, 'ADPICK': 3000 },
    results: { '쿠팡': { spent: 12, checked: 30, changedApplied: 2, optionMiss: 1 },
      'ADPICK': { spent: 9, checked: 11, changedApplied: 1 } }
  });
  assert.match(html, /예정 시각 \(KST\)/);
  assert.match(html, /2026-10-26 19:05 KST/);
  assert.match(html, /실제 시작 시각 \(KST\)/);
  assert.match(html, /2026-10-26 19:12 KST/);
  assert.match(html, /7분/);
  assert.match(html, /쿠팡 API 실제 호출/);
  assert.match(html, /12회/);
  assert.match(html, /ADPICK API 실제 호출/);
  assert.match(html, /9회/);
});

check('MISSED 메일도 같은 틀로 나온다 (호출 0회가 명시된다)', () => {
  const html = buildVolatileReportHtml({
    day: '2026-10-26', slot: 'noon', status: STATUS.MISSED,
    scheduledAt: '2026-10-26 12:05 KST', startedAt: '2026-10-26 18:10 KST', delayMinutes: 365,
    reason: '예약 시각의 재확인이 창 안에 한 번도 실행되지 않았습니다',
    results: { '쿠팡': { spent: 0 }, 'ADPICK': { spent: 0 } }
  });
  assert.match(html, /예약 실행 누락/);
  assert.match(html, /365분/);
  assert.match(html, /한 번도 실행되지 않았습니다/);
});

check('newReport 는 창 밖에서도 같은 모양을 만든다 (2026-10-26 의 침묵 재발 방지)', () => {
  const out = vol.newReport(kst('2026-10-26 17:47'), null, 'noon');
  assert.strictEqual(out.slot, 'noon');
  assert.strictEqual(out.day, '2026-10-26');
  assert.strictEqual(out.status, STATUS.SKIPPED, '기본값이 있어야 상태 없는 보고가 안 나온다');
  assert.ok(out.startedAt.endsWith('KST'));
  assert.deepStrictEqual(Object.keys(out.results).sort(), ['ADPICK', '쿠팡'].sort());
  // 창을 아는 경우에는 예정 시각이 채워진다.
  const planned = vol.newReport(kst('2026-10-26 12:35'), slotWindow('2026-10-26', 'noon'), '');
  assert.ok(planned.scheduledAt.includes('12:05'), planned.scheduledAt);
  assert.strictEqual(planned.delayMinutes, 30);
});

console.log('\n[6] Vercel Cron → workflow_dispatch 트리거');

check('rewrite 의 ?volatile= 로 슬롯이 갈린다', () => {
  assert.strictEqual(volatileSlotFor({ query: { volatile: 'noon' }, headers: {} }), 'noon');
  assert.strictEqual(volatileSlotFor({ query: { volatile: 'EVENING' }, headers: {} }), 'evening');
});

check('쿼리가 사라져도 x-vercel-cron-schedule 헤더로 갈린다', () => {
  assert.strictEqual(volatileSlotFor({ query: {},
    headers: { 'x-vercel-cron-schedule': '5 3 * * *' } }), 'noon');
  assert.strictEqual(volatileSlotFor({ query: {},
    headers: { 'x-vercel-cron-schedule': '5 10 * * *' } }), 'evening');
});

check('아침 전체 수집 크론은 재확인으로 새지 않는다 (쿼터 보호)', () => {
  assert.strictEqual(volatileSlotFor({ query: {},
    headers: { 'x-vercel-cron-schedule': '0 18 * * *' } }), '');
  assert.strictEqual(volatileSlotFor({ query: {}, headers: {} }), '');
  assert.strictEqual(volatileSlotFor({ query: { volatile: 'morning' }, headers: {} }), '');
});

check('크론 표현식이 vercel.json 과 일치한다', () => {
  const crons = require('../vercel.json').crons;
  const paths = Object.fromEntries(crons.map(c => [c.path, c.schedule]));
  assert.strictEqual(paths['/api/volatile-noon'], '5 3 * * *', '점심 12:05 KST');
  assert.strictEqual(paths['/api/volatile-evening'], '5 10 * * *', '저녁 19:05 KST');
  assert.strictEqual(paths['/api/cron'], '0 18 * * *', '아침 수집은 그대로');
  for (const [schedule, slot] of Object.entries(VOLATILE_SCHEDULES)) {
    assert.ok(Object.values(paths).includes(schedule),
      `핸들러가 아는 ${slot} 예약(${schedule}) 이 vercel.json 에 없다`);
  }
  // Hobby 플랜은 하루 1회만 허용한다 — 분/시가 * 이면 배포가 실패한다.
  for (const c of crons) {
    const [min, hour] = c.schedule.split(' ');
    assert.ok(!min.includes('*') && !hour.includes('*') && !min.includes(',') && !hour.includes(','),
      `Vercel Hobby 는 하루 1회만 허용한다: ${c.path} ${c.schedule}`);
  }
  // 재확인 트리거는 rewrite 를 거쳐 /api/cron 으로 간다 (새 함수를 만들지 않는다).
  const rewrites = require('../vercel.json').rewrites;
  for (const slot of ['noon', 'evening']) {
    const r = rewrites.find(x => x.source === `/api/volatile-${slot}`);
    assert.ok(r, `/api/volatile-${slot} rewrite 가 없다`);
    assert.strictEqual(r.destination, `/api/cron?volatile=${slot}`);
  }
});

check('GitHub cron 칸이 두 창 안에만, 그리고 감시 칸이 깔려 있다', () => {
  const yml = require('fs').readFileSync(
    require('path').join(__dirname, '..', '.github', 'workflows', 'volatile-prices.yml'), 'utf8');
  // 점심 창 UTC 03~05, 저녁 창 UTC 10~12. 창 밖으로 넓히면 이 테스트가 깨진다.
  assert.match(yml, /cron: '5,25,45 3-5 \* \* \*'/, '점심 창(UTC 03~05) 칸');
  assert.match(yml, /cron: '5,25,45 10-12 \* \* \*'/, '저녁 창(UTC 10~12) 칸');
  assert.match(yml, /cron: '10 9,16,18,20,22 \* \* \*'/, '누락 감시 칸');
  // schedule 에서는 슬롯을 박지 않는다 — 어느 칸이 언제 발화할지 모른다.
  assert.match(yml, /inputs\.slot != 'auto'/);
  // 상태가 Summary 와 annotation 으로 나가는지.
  assert.match(yml, /\$GITHUB_STEP_SUMMARY/);
  assert.match(yml, /::error title=예약 수집 누락::/);
  assert.match(yml, /steps\.recheck\.outputs\.status == 'COMPLETED'/);
});

console.log('\n[7] DB · 메일 실패 내성 (가짜 클라이언트)');

/** price_job_state 한 줄을 흉내내는 가짜 DB. CAS 조건까지 재현한다. */
function fakeDb(row, opts = {}) {
  const state = { last_result: row };
  const calls = { reads: 0, writes: 0 };
  const client = {
    state, calls,
    from(table) {
      assert.strictEqual(table, 'price_job_state');
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  calls.reads++;
                  if (opts.readError) return { data: null, error: { message: opts.readError } };
                  return { data: { last_result: state.last_result }, error: null };
                }
              };
            }
          };
        },
        update(payload) {
          const chain = {
            eq(field, value) {
              // 두 번째 eq 가 CAS 조건: last_result->lock->>runId = 우리 토큰
              if (field === 'last_result->lock->>runId') chain._token = value;
              return chain;
            },
            select() {
              calls.writes++;
              if (opts.writeError) return { data: null, error: { message: opts.writeError } };
              const holder = state.last_result && state.last_result.lock
                && state.last_result.lock.runId;
              if (chain._token && chain._token !== holder) return { data: [], error: null };
              state.last_result = payload.last_result;
              return { data: [{ id: 1 }], error: null };
            }
          };
          return chain;
        }
      };
    }
  };
  return client;
}

(async () => {
  // ⑪ DB 연결 실패 — 원장을 못 읽으면 안전 중단(던진다), 못 쓰면 false(던지지 않는다)
  check('⑪ 원장 조회 실패는 안전 중단 — 추측으로 수집하지 않는다', () => {
    const client = fakeDb({}, { readError: 'database unavailable' });
    return assert.rejects(() => vol.readLedger(client), /슬롯 원장 조회 실패\(안전 중단\)/);
  });
  await assert.rejects(() => vol.readLedger(fakeDb({}, { readError: 'ECONNREFUSED' })),
    /안전 중단/);
  n++; console.log('  ✓ ⑪-2 readLedger 가 DB 오류를 삼키지 않는다');

  const w1 = await vol.writeSlot('tok', '2026-10-26', 'noon',
    { status: STATUS.COMPLETED }, fakeDb({ lock: { runId: 'tok' } }, { writeError: 'timeout' }));
  assert.strictEqual(w1, false, '원장 기록 실패가 예외로 번지면 저장된 가격까지 잃는다');
  n++; console.log('  ✓ ⑪-3 원장 기록 실패는 false 를 돌려주고 던지지 않는다');

  // 두 러너가 같은 순간 — 잠금을 쥔 쪽만 원장에 쓴다
  const shared = fakeDb({ lock: { runId: 'runnerA' } });
  const okA = await vol.writeSlot('runnerA', '2026-10-26', 'noon', { status: STATUS.COMPLETED }, shared);
  const okB = await vol.writeSlot('runnerB', '2026-10-26', 'noon', { status: STATUS.COMPLETED }, shared);
  assert.strictEqual(okA, true);
  assert.strictEqual(okB, false, '잠금을 잃은 러너가 원장을 덮어쓰면 안 된다');
  assert.strictEqual(shared.state.last_result.volatileSlots['2026-10-26'].noon.status, STATUS.COMPLETED);
  assert.ok(shared.state.last_result.lock, '원장 기록이 기존 lock 을 지우지 않는다');
  n++; console.log('  ✓ 두 스케줄러가 같은 시각 실행 — 잠금 CAS 로 한 쪽만 슬롯을 가져간다');

  // ⑯ sweepMissed 통합 — 경고는 한 번, 원장에 표식이 남는다
  const sweepDb = fakeDb({ lock: { runId: 'tok' } });
  const sent = [];
  const got = await vol.sweepMissed(kst('2026-10-27 01:38'), {}, 'tok',
    { client: sweepDb, send: async r => { sent.push(r); return { ok: true }; } });
  assert.strictEqual(got.length, 2, '전날 점심·저녁 두 건');
  assert.strictEqual(sent.length, 2);
  assert.ok(sent.every(r => r.status === STATUS.MISSED));
  assert.ok(sent.every(r => r.results['쿠팡'].spent === 0 && r.results.ADPICK.spent === 0),
    'MISSED 는 외부 호출 0회여야 한다');
  const marks = sweepDb.state.last_result.volatileSlots['2026-10-26'];
  assert.ok(marks.noon.notifiedMissAt && marks.evening.notifiedMissAt);
  // 두 번째 sweep 은 아무 것도 보내지 않는다.
  const again = await vol.sweepMissed(kst('2026-10-27 01:38'),
    sweepDb.state.last_result.volatileSlots, 'tok',
    { client: sweepDb, send: async () => { throw new Error('두 번 보내면 안 된다'); } });
  assert.deepStrictEqual(again, []);
  n++; console.log('  ✓ ⑯-2 누락 경고는 슬롯당 한 번, 원장에 표식이 남는다');

  // 표식을 못 남기면 경고를 보류한다 (메일 폭주 방지)
  const stuck = fakeDb({ lock: { runId: 'otherRunner' } });
  const none = await vol.sweepMissed(kst('2026-10-27 01:38'), {}, 'tok',
    { client: stuck, send: async () => { throw new Error('보내면 안 된다'); } });
  assert.deepStrictEqual(none, [], '원장에 표시하지 못하면 메일을 보내지 않는다');
  n++; console.log('  ✓ 원장 표식 실패 시 경고 보류 — 다음 감시 칸이 다시 시도한다');

  // ⑫ Resend 발송 실패가 수집 결과를 뒤집지 않는다
  const { sendVolatileReport } = require('./_volatile-report');
  const boom = await sendVolatileReport(
    { day: '2026-10-26', slot: 'noon', status: STATUS.COMPLETED, results: {} },
    { to: 'x@example.com', send: async () => { throw new Error('Resend 503'); } });
  assert.strictEqual(boom.ok, false);
  assert.match(boom.error, /Resend 503/);
  n++; console.log('  ✓ ⑫ Resend 발송 실패는 {ok:false} 로 돌아오고 예외로 번지지 않는다');

  const noKey = await sendVolatileReport({ day: '2026-10-26', slot: 'noon', status: STATUS.COMPLETED },
    { to: 'x@example.com' });
  assert.strictEqual(noKey.ok, false);
  n++; console.log('  ✓ ⑫-2 RESEND_API_KEY 가 없으면 조용히 실패하고 사유를 남긴다');

  global.fetch = realFetch;
  console.log(`\nVolatile schedule stability regression PASS (${n} cases)\n`);
})().catch(e => { console.error(e); process.exitCode = 1; });
