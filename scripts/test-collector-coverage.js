#!/usr/bin/env node
/*
 * 수집 커버리지 회귀 테스트 (2026-09-29) — 외부 API·운영 DB 를 전혀 부르지 않는다.
 *
 *   node scripts/test-collector-coverage.js
 *
 * 2026-09-29 운영 실측으로 드러난 «시도조차 못 한 상품» 의 원인을 하나씩 고정한다.
 *
 *   [1] 순수 판정 — 일시 장애 vs 공급자 거절, 분당 제한 vs 예산 소진, 기본값
 *   [2] ★ 대상 100개 · 실행당 호출 20회 · 5회 실행 → 100개 전부 최소 1회 시도
 *       (V3 계획기 / 레거시 둘 다, 같은 그룹 재호출 0, 오늘 수집된 상품 재검색 0)
 *   [3] 우선순위 P0 → P1(힌트) → P2(일시 실패 재시도) → P3(사다리), P4 는 부르지 않는다
 *   [4] 공급자 일시 쿨다운은 기다렸다 이어가고, 거절은 남은 그룹을 건드리지 않고 멈춘다
 *   [5] 예산 소진 즉시 정지 — 남은 그룹을 «보류» 로 훑지 않는다 (laneGate 없이도)
 *   [6] 체크포인트 → 이어받기: 중단된 실행의 스냅숏으로 다음 실행이 중복 없이 잇는다
 *   [7] fetchCoupangAll/fetchAdpickAll — 일시 장애는 래치하지 않고 거절만 래치, 당일 캐시 TTL
 */
'use strict';

process.env.PRICE_BATCH_INTERVAL_MS = '1';   // 0 은 Number(x) || 15000 에 걸려 기본값이 된다
process.env.COUPANG_ACCESS_KEY = 'test-access';
process.env.COUPANG_SECRET_KEY = 'test-secret';

const path = require('path');
const Module = require('module');

function inject(rel, ex) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p; require.cache[p].loaded = true; require.cache[p].exports = ex;
}

/* 운영 DB 대신 — 이 테스트는 상태·원장을 전부 주입 함수로 넘기므로 호출되면 안 된다. */
const dbCalls = [];
const fakeChain = () => {
  const c = new Proxy({}, {
    get(_t, k) {
      if (k === 'then') return r => Promise.resolve({ data: [], error: null, count: 0 }).then(r);
      return () => c;
    }
  });
  return c;
};
inject('api/_supabase.js', {
  from: t => { dbCalls.push(t); return fakeChain(); },
  rpc: n => { dbCalls.push('rpc:' + n); return Promise.resolve({ data: null, error: null }); }
});
inject('api/_notify.js', { send: () => Promise.resolve({ ok: true }) });

/* 공급자 모듈 — [7] 에서 fetchCoupangAll/fetchAdpickAll 의 판정만 본다. */
const coupangFake = {
  script: [], calls: [], blockedUntil: 0, blockReason: '',
  async searchCoupang(kw, opts) {
    coupangFake.calls.push({ kw, opts });
    const next = coupangFake.script.shift() || { items: [], from: 'api', apiCalled: true, blocked: false };
    return typeof next === 'function' ? next(kw, opts) : next;
  },
  isBlocked: () => coupangFake.blockedUntil > Date.now(),
  localStats: () => ({ calls: coupangFake.calls.length, cacheHits: 0, denied: 0,
    blocked: coupangFake.blockedUntil > Date.now(), blockReason: coupangFake.blockReason,
    blockedForSec: Math.max(0, Math.ceil((coupangFake.blockedUntil - Date.now()) / 1000)) })
};
const adpickFake = {
  script: [], calls: [],
  async searchAdpick(kw, opts) {
    adpickFake.calls.push({ kw, opts });
    return adpickFake.script.shift() || { items: [], from: 'api', apiCalled: true, blocked: false };
  },
  isBlocked: () => false,
  localStats: () => ({ calls: adpickFake.calls.length, cacheHits: 0, denied: 0, blocked: false, blockReason: '', blockedForSec: 0 }),
  hasKey: () => true,
  recordExternalCall: async () => {},
  redact: s => s
};
inject('api/_coupang.js', coupangFake);
inject('api/_adpick.js', adpickFake);

const C = require('./collect-all-prices');
const { isTransientBlockReason } = require('../api/_blockreason');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); }
}
function eq(name, got, want) { check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const TODAY = C.kstToday();
const DAY_START = Date.parse(`${TODAY}T00:00:00+09:00`);
const pad = i => String(i).padStart(3, '0');
const recordStubFor = ledger => async (obs) => {
  obs.forEach(o => ledger.add(`${o.productId}|${o.mall}`));
  return { saved: obs.length, recorded: obs.length, rejected: 0, suspect: 0, optionMismatch: 0, errors: [],
    recordedKeys: obs.map(o => `${o.productId}|${o.mall}`) };
};
const NO_HINT = async () => new Map();
const item = pid => ({ productId: pid, title: pid, lprice: 1000, oprice: 1000, link: '', image: '',
  mall: 'ADPICK', itemId: '', vendorItemId: '' });

/* runLocked 가 price_job_state.last_result.malls[몰] 에 적는 모양 그대로 이어받기 상태를 만든다. */
function savedFrom(r) {
  return {
    job_date: TODAY, cursor_key: r.cursorKey, processed: r.processed, total: r.total, status: r.status,
    last_result: {
      failedKeywords: r.failedKeywords || [], collectorCovered: r.collectorCovered || [],
      collectorAttempted: r.collectorAttempted || [], collectorOptionMismatches: r.collectorOptionMismatches || [],
      secondPassDone: r.secondPassDone || [], facetDryGroups: r.facetDryGroups || [],
      terminalOptionFailures: r.terminalOptionFailures || [], optionMissStreaks: r.optionMissStreaks || {}
    }
  };
}

/*
 * 대상 n개, 상품마다 검색어 그룹 하나. 짝수 번호는 1차 검색에서 잡히고 홀수는 안 잡힌다.
 * 실행당 외부 호출 budget 회 — 넘으면 fetch 가 운영과 같은 사유로 거절한다.
 */
function world(n, budget) {
  const rows = Array.from({ length: n }, (_, i) => ({
    product_id: `P${pad(i)}`, mall: 'ADPICK', title: `브랜드${i} 무선 청소기 MX${100 + i}`,
    keyword: `검색어${pad(i)}`, link: '', image: '', vendor_item_id: '', item_id: '',
    collected_at: new Date(DAY_START - 86400000).toISOString()
  }));
  const ledger = new Set();
  const log = [];          // 실제로 나간 호출 (검색어, 실행 번호)
  let run = 0, used = 0;
  const fetchAllFn = async kw => {
    if (used >= budget) return { ok: false, items: [], reason: `실행당 호출 예산 ${budget}회 소진` };
    used++;
    log.push({ kw, run });
    const m = /^검색어(\d{3})$/.exec(kw);
    const i = m ? Number(m[1]) : -1;
    return { ok: true, reason: '', items: i >= 0 && i % 2 === 0 ? [item(`P${pad(i)}`)] : [item('OTHER')] };
  };
  return {
    rows, ledger, log, fetchAllFn,
    startRun() { run++; used = 0; },
    get run() { return run; },
    get used() { return used; },
    laneGate: { stopReason: () => (used >= budget ? 'budget' : ''), blockedUntilMs: () => 0 }
  };
}

(async () => {
  console.log('=== 수집 커버리지 회귀 테스트 ===\n');

  /* ── 1. 순수 판정 ───────────────────────────────────────────── */
  console.log('[1] 일시 장애 vs 거절 · 분당 제한 vs 예산 · 기본값');
  const transient = [
    '네트워크 응답 시간 초과 (8000ms)',
    '전역 제한: 호출 중단 중 (재개 2026-09-28 19:48:52+00) 네트워크 응답 시간 초과 (8000ms)',
    '대기 중 차단됨: HTTP 504: {"message":"Gateway Timeout"}',
    '쿠팡 API 504: gateway',
    '연속 3회 실패: 네트워크 오류: fetch failed',
    'ADPICK 응답 파싱 실패'
  ];
  const refusal = [
    'HTTP 429: Retry-After=60s', '쿠팡 API 403: Access denied', 'rCode=500: 요청 거부',
    'HTML 차단 응답(HTTP 200): Sorry! Access denied', 'ADPICK API 429: 사용 횟수를 초과하였습니다',
    '전역 제한: 호출 중단 중 (재개 2026-09-28 19:48:52+00) HTTP 403: forbidden',
    'success=false: API key invalid', '', '알 수 없는 사유'
  ];
  transient.forEach(s => check(`일시 장애로 본다: ${s.slice(0, 50)}`, isTransientBlockReason(s) === true));
  refusal.forEach(s => check(`거절(래치)로 본다: ${s.slice(0, 50) || '(빈 문자열)'}`, isTransientBlockReason(s) === false));
  eq('★ DB 게이트 분당 거절은 예산 소진이 아니라 속도 제한',
    C.categorizeFailure('호출 생략: 전역 제한: collector/background 분당 budget 15/15'), 'rateLimit');
  eq('상품 단위도 rate_limited', C.outcomeFromReason('호출 생략: 전역 제한: collector/background 분당 budget 15/15'), 'rate_limited');
  eq('Search 분당 운영 budget 도 속도 제한', C.categorizeFailure('전역 제한: Search 분당 운영 budget 35/35'), 'rateLimit');
  eq('하루 호출 예산 소진은 그대로 budget', C.categorizeFailure('하루 호출 예산 3400회 소진'), 'budget');
  eq('실행당 호출 예산 소진은 그대로 budget', C.categorizeFailure('실행당 호출 예산 700회 소진'), 'budget');
  check('★ «실행 시간 부족» 칸이 «호출 예산 소진» 과 따로 있다',
    C.OUTCOME_KEYS.includes('time') && C.OUTCOME_KEYS.includes('budget'));
  check('★ 잠금 조건부 체크포인트는 레거시에도 기본 ON', C.STATE_CHECKPOINT === true);
  eq('수집기는 같은 KST 날짜의 캐시를 인정한다 (24시간 — 날짜 검사는 공급자 모듈)', C.COLLECT_CACHE_TTL_MS, 24 * 3600 * 1000);
  eq('일시 쿨다운 대기 한도 기본 10분/실행', C.PASS_BLOCK_MAX_WAIT_MS, 10 * 60 * 1000);
  {
    const s = { coupangUsed: 3400, coupangBudget: 3400, coupangKeys: true, adpickUsed: 3000, adpickBudget: 3000, adpickKey: true };
    check('★ 두 제공자 모두 하루 예산을 다 썼으면 대상을 읽지 않고 끝낸다', C.nothingLeftToCall(s) === true);
    check('ADPICK 이 남았으면 돈다', C.nothingLeftToCall({ ...s, adpickUsed: 2999 }) === false);
    check('쿠팡이 남았으면 돈다', C.nothingLeftToCall({ ...s, coupangUsed: 10 }) === false);
    check('키가 없는 제공자는 «남은 것 없음» 으로 본다', C.nothingLeftToCall({ ...s, coupangUsed: 0, coupangKeys: false }) === true);
  }
  console.log('');

  /* ── 2. 100개 / 호출 20회 / 5회 실행 ───────────────────────────── */
  for (const mode of ['V3', '레거시']) {
    for (const gated of [true, false]) {
      const label = `${mode}${gated ? '' : ' · laneGate 없음'}`;
      console.log(`[2] 대상 100개 · 실행당 호출 20회 · 5회 — ${label}`);
      const w = world(100, 20);
      let saved = null;
      const perRun = [];
      let r = null;
      for (let k = 1; k <= 6; k++) {
        w.startRun();
        r = await C.runMallCollection({
          mallName: 'ADPICK', rows: w.rows, fetchAllFn: w.fetchAllFn, savedState: saved,
          deadlineTs: Date.now() + 20000, recordPricesFn: recordStubFor(w.ledger), cacheHintFn: NO_HINT,
          collectedTodayFn: async () => new Set(w.ledger),
          planner: mode === 'V3' ? { tierOf: () => 'daily', dayStartMs: DAY_START, limit: 20, dailyFirst: true, pass1GroupCap: 0 } : null,
          laneGate: gated ? w.laneGate : null
        });
        saved = savedFrom(r);
        perRun.push({ k, pass1: w.log.filter(x => x.run === k && /^검색어\d{3}$/.test(x.kw)).map(x => x.kw),
          other: w.log.filter(x => x.run === k && !/^검색어\d{3}$/.test(x.kw)).length,
          attempted: r.attemptedProducts, stop: r.stopCause });
      }
      const run1 = new Set(perRun[0].pass1);
      eq(`${label}: 1회차는 외부 호출 20회 전부를 1차(미시도) 검색에 쓴다`, perRun[0].pass1.length, 20);
      check(`${label}: ★ 2회차는 1회차의 20개를 다시 부르지 않고 다음 20개를 부른다`,
        perRun[1].pass1.length === 20 && perRun[1].pass1.every(kw => !run1.has(kw)), JSON.stringify(perRun[1].pass1.slice(0, 5)));
      const allPass1 = perRun.slice(0, 5).flatMap(x => x.pass1);
      eq(`${label}: ★ 5회 실행 뒤 100개 전부 최소 1회 시도`, perRun[4].attempted, 100);
      eq(`${label}: 5회 동안 부른 1차 검색어 = 고유 100종`, new Set(allPass1).size, 100);
      eq(`${label}: ★ 같은 1차 검색어를 두 번 부른 적이 없다`, allPass1.length, 100);
      check(`${label}: 1~4회차는 회수 호출 0 (미시도가 남아 있는 동안 P3 로 가지 않는다)`,
        perRun.slice(0, 4).every(x => x.other === 0), JSON.stringify(perRun.map(x => x.other)));
      // 5회차는 마지막 1차 그룹이 정확히 20번째 호출이라 1차가 «끝까지» 돈다 — 멈춤이 아니다.
      check(`${label}: 1~4회차 레인은 «호출 예산 소진» 으로 멈춘다 (다음 실행이 잇는다)`,
        perRun.slice(0, 4).every(x => x.stop === 'budget'), JSON.stringify(perRun.map(x => x.stop)));
      eq(`${label}: 짝수 50개 수집`, [...w.ledger].length, 50);
      const collectedKw = new Set(w.rows.filter((_, i) => i % 2 === 0).map(p => p.keyword));
      const afterCollect = w.log.filter(x => x.run >= 2 && collectedKw.has(x.kw)
        && perRun.findIndex(p => p.pass1.includes(x.kw)) + 1 < x.run);
      eq(`${label}: ★ 오늘 이미 수집된 상품의 검색어는 다시 부르지 않는다 (P4)`, afterCollect.length, 0);
      check(`${label}: 6회차는 1차 없이 회수(P3)만 — 무매칭 홀수 상품의 다른 검색어`,
        perRun[5].pass1.length === 0 && perRun[5].other > 0, JSON.stringify(perRun[5]));
      console.log('');
    }
  }

  /* ── 3. 우선순위 P0 → P1 → P2 → P3, P4 제외 ───────────────────── */
  console.log('[3] 우선순위 — P0 미시도 → P1 힌트 → P2 일시 실패 → P3 사다리 · P4 는 부르지 않음');
  {
    const mk = (cls, i) => ({ product_id: `${cls}${i}`, mall: 'ADPICK', title: `브랜드${cls}${i} 전동 칫솔 TB${cls}${i}0`,
      keyword: `${cls}-검색어${i}`, link: '', image: '', vendor_item_id: '', item_id: '',
      collected_at: new Date(DAY_START - 86400000).toISOString() });
    const rows = [];
    for (let i = 0; i < 5; i++) ['P0', 'P1', 'P2', 'P3', 'P4'].forEach(cls => rows.push(mk(cls, i)));
    const key = p => `${p.product_id}|${p.mall}`;
    const byCls = cls => rows.filter(p => p.product_id.startsWith(cls));
    const saved = {
      job_date: TODAY, cursor_key: '', processed: 0, total: rows.length, status: 'running',
      last_result: {
        failedKeywords: byCls('P2').map(p => p.keyword),
        collectorCovered: byCls('P4').map(key),
        collectorAttempted: [...byCls('P1'), ...byCls('P3'), ...byCls('P4')].map(key),
        collectorOptionMismatches: [], secondPassDone: [], facetDryGroups: [], terminalOptionFailures: [], optionMissStreaks: {}
      }
    };
    const calls = [];
    const r = await C.runMallCollection({
      mallName: 'ADPICK', rows, savedState: saved, deadlineTs: Date.now() + 20000,
      fetchAllFn: async kw => { calls.push(kw); return { ok: true, reason: '', items: [item('OTHER')] }; },
      recordPricesFn: recordStubFor(new Set()),
      cacheHintFn: async want => new Map(byCls('P1').filter(p => want.has(p.product_id)).map(p => [p.product_id, [`힌트 ${p.product_id}`]])),
      collectedTodayFn: async () => new Set(byCls('P4').map(key)),
      planner: { tierOf: () => 'daily', dayStartMs: DAY_START, limit: 20, dailyFirst: true, pass1GroupCap: 0 },
      laneGate: { stopReason: () => '', blockedUntilMs: () => 0 }
    });
    const idx = pred => calls.map((q, i) => (pred(q) ? i : -1)).filter(i => i >= 0);
    const p0 = idx(q => /^P0-검색어/.test(q)), p1 = idx(q => /^힌트 P1/.test(q)), p2 = idx(q => /^P2-검색어/.test(q));
    const p4 = idx(q => /^P4-검색어/.test(q));
    const p3 = idx(q => !/^P\d-검색어/.test(q) && !/^힌트 /.test(q));
    eq('P0 미시도 그룹 5종 전부 호출', p0.length, 5);
    eq('P1 캐시 힌트 5종 전부 호출', p1.length, 5);
    eq('P2 일시 실패 그룹 5종 전부 재시도', p2.length, 5);
    check('★ P0 전부가 P1 보다 먼저', Math.max(...p0) < Math.min(...p1), calls.join(' | '));
    check('★ P1 전부가 P2 보다 먼저', Math.max(...p1) < Math.min(...p2), calls.join(' | '));
    check('★ P2 전부가 P3(사다리) 보다 먼저', p3.length > 0 && Math.max(...p2) < Math.min(...p3), calls.join(' | '));
    eq('★ P4(오늘 이미 가격 있음)는 한 번도 부르지 않는다', p4.length, 0);
    eq('같은 검색어를 한 실행에서 두 번 부르지 않는다', new Set(calls).size, calls.length);
    eq('P0·P2 가 전부 시도로 잡힌다 (P4 포함 25개)', r.attemptedProducts, 25);
    eq('시작 시 우선순위 대기열: P0 5 / P2 5 / P4 5', JSON.stringify([r.priorityAtStart.p0Products, r.priorityAtStart.p2Products, r.priorityAtStart.p4Products]), '[5,5,5]');
    eq('P2 재시도가 성공하면 실패 목록이 비워진다', r.failedKeywords.length, 0);
  }
  {
    /* 레거시도 P2 재시도는 P0 뒤에 돈다 (예전에는 맨 앞) */
    const rows = ['가', '나', '다', '라'].map((k, i) => ({ product_id: `L${i}`, mall: 'ADPICK', title: `상품 L${i}`,
      keyword: k, link: '', image: '', vendor_item_id: '', item_id: '' }));
    const calls = [];
    const saved = { job_date: TODAY, cursor_key: '나', processed: 2, total: 4, status: 'running',
      last_result: { failedKeywords: ['가'], collectorCovered: [], collectorAttempted: ['L1|ADPICK'] } };
    await C.runMallCollection({
      mallName: 'ADPICK', rows, savedState: saved, deadlineTs: Date.now() + 8000,
      fetchAllFn: async kw => { calls.push(kw); return { ok: true, reason: '', items: [] }; },
      recordPricesFn: recordStubFor(new Set()), cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set()
    });
    const pass1 = calls.filter(q => ['가', '나', '다', '라'].includes(q));
    eq('★ 레거시: 커서 뒤 미시도(다·라) 먼저, 일시 실패(가) 재시도는 그 뒤', pass1.join(','), '다,라,가');
  }
  console.log('');

  /* ── 4. 공급자 쿨다운 대기 · 거절 시 정지 ─────────────────────── */
  console.log('[4] 일시 쿨다운은 기다렸다 이어가고, 거절은 남은 그룹을 건드리지 않고 멈춘다');
  {
    const rows = Array.from({ length: 12 }, (_, i) => ({ product_id: `T${i}`, mall: 'ADPICK', title: `상품 T${i}`,
      keyword: `쿨다운${pad(i)}`, link: '', image: '', vendor_item_id: '', item_id: '' }));
    let blockedUntil = 0, n = 0;
    const calls = [];
    const r = await C.runMallCollection({
      mallName: 'ADPICK', rows, savedState: null, deadlineTs: Date.now() + 20000,
      fetchAllFn: async kw => {
        n++;
        calls.push(kw);
        if (n === 3) { blockedUntil = Date.now() + 400; return { ok: false, items: [], reason: '쿠팡 차단: 네트워크 응답 시간 초과 (8000ms)' }; }
        if (blockedUntil > Date.now()) return { ok: false, items: [], reason: '쿠팡 차단 상태' };
        return { ok: true, reason: '', items: [item(kw.replace('쿨다운', 'T').replace(/^T0+(\d)/, 'T$1'))] };
      },
      recordPricesFn: recordStubFor(new Set()), cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set(),
      laneGate: { stopReason: () => '', blockedUntilMs: () => blockedUntil }
    });
    eq('★ 짧은 쿨다운 뒤 12개 전부 한 실행 안에서 시도된다', r.attemptedProducts, 12);
    check('쿨다운을 실제로 기다렸다', r.blockWaitMs > 0, String(r.blockWaitMs));
    eq('레인은 끝까지 돌았다 (멈춤 사유 없음)', r.stopCause, '');
    eq('★ 쿨다운에 걸렸던 그룹은 같은 실행의 P2 재시도로 회수된다', r.failedKeywords.length, 0);
    check('쿨다운 동안 헛호출이 12개를 훑지 않는다 (동시 묶음 4개 이내)',
      calls.filter(q => calls.indexOf(q) !== calls.lastIndexOf(q)).length <= 8, calls.join(','));
  }
  {
    const rows = Array.from({ length: 40 }, (_, i) => ({ product_id: `B${i}`, mall: 'ADPICK', title: `상품 B${i}`,
      keyword: `거절${pad(i)}`, link: '', image: '', vendor_item_id: '', item_id: '' }));
    let refused = false;
    const calls = [];
    const r = await C.runMallCollection({
      mallName: 'ADPICK', rows, savedState: null, deadlineTs: Date.now() + 20000,
      fetchAllFn: async kw => {
        calls.push(kw);
        if (calls.length === 6) { refused = true; return { ok: false, items: [], reason: '쿠팡 차단: 쿠팡 API 403: Access denied' }; }
        if (refused) return { ok: false, items: [], reason: '쿠팡 차단 상태' };
        return { ok: true, reason: '', items: [] };
      },
      recordPricesFn: recordStubFor(new Set()), cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set(),
      laneGate: { stopReason: () => (refused ? 'blocked' : ''), blockedUntilMs: () => 0 }
    });
    eq('★ 거절 뒤 레인이 멈춘다', r.stopCause, 'blocked');
    check('★ 남은 그룹을 훑지 않는다 (거절 전후 동시 묶음까지만 호출)', calls.length <= 8, `calls=${calls.length}`);
    check('실패 목록에는 실제로 부른 그룹만 들어간다', r.failedKeywords.length <= 3, String(r.failedKeywords.length));
    check('못 간 상품은 blocked 칸 (pending·unknown 으로 새지 않는다)', r.outcomes.blocked >= 30 && r.outcomes.unknown === 0,
      JSON.stringify(r.outcomes));
    eq('상품 단위 합 = 대상', C.OUTCOME_KEYS.reduce((t, k) => t + r.outcomes[k], 0), 40);
  }
  console.log('');

  /* ── 5. 예산 소진 즉시 정지 (laneGate 없이 사유만으로) ─────────── */
  console.log('[5] 예산 소진 — 남은 그룹을 «보류» 로 훑지 않는다');
  {
    const rows = Array.from({ length: 60 }, (_, i) => ({ product_id: `X${i}`, mall: 'ADPICK', title: `상품 X${i}`,
      keyword: `예산${pad(i)}`, link: '', image: '', vendor_item_id: '', item_id: '' }));
    const calls = [];
    const r = await C.runMallCollection({
      mallName: 'ADPICK', rows, savedState: null, deadlineTs: Date.now() + 20000,
      fetchAllFn: async kw => {
        calls.push(kw);
        return calls.length > 10 ? { ok: false, items: [], reason: '하루 호출 예산 3000회 소진' } : { ok: true, reason: '', items: [] };
      },
      recordPricesFn: recordStubFor(new Set()), cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set()
    });
    check('★ 예산 소진 뒤 부른 그룹은 동시 묶음 하나(4개) 이내', calls.length <= 14, `calls=${calls.length}`);
    eq('멈춤 사유 = budget', r.stopCause, 'budget');
    check('실패 목록은 거절된 묶음뿐', r.failedKeywords.length <= 4, String(r.failedKeywords.length));
    check('★ 못 간 상품은 budget 칸, time 이 아니다', r.outcomes.budget >= 40 && r.outcomes.time === 0, JSON.stringify(r.outcomes));
    eq('완료로 오판하지 않는다', r.status, 'running');
  }
  {
    /* 레거시 커서: 멈춘 배치를 넘기지 않는다 — 부르지 않은 그룹이 오늘 영영 건너뛰어지지 않게 */
    const rows = Array.from({ length: 40 }, (_, i) => ({ product_id: `Y${i}`, mall: 'ADPICK', title: `상품 Y${i}`,
      keyword: `커서${pad(i)}`, link: '', image: '', vendor_item_id: '', item_id: '' }));
    let n = 0;
    const r = await C.runMallCollection({
      mallName: 'ADPICK', rows, savedState: null, deadlineTs: Date.now() + 20000,
      fetchAllFn: async () => (++n > 26 ? { ok: false, items: [], reason: '실행당 호출 예산 26회 소진' } : { ok: true, reason: '', items: [] }),
      recordPricesFn: recordStubFor(new Set()), cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set()
    });
    check('★ 레거시 커서는 끝까지 처리한 배치까지만 (20번째 그룹)', r.cursorKey === '커서019', r.cursorKey);
  }
  console.log('');

  /* ── 6. 체크포인트 → 이어받기 ─────────────────────────────────── */
  console.log('[6] 체크포인트 — 중단된 실행의 스냅숏으로 다음 실행이 중복 없이 잇는다');
  {
    const w = world(80, 1000);
    const snaps = [];
    const abortSignal = { aborted: false };
    w.startRun();
    const planner = { tierOf: () => 'daily', dayStartMs: DAY_START, limit: 20, dailyFirst: true, pass1GroupCap: 0 };
    await C.runMallCollection({
      mallName: 'ADPICK', rows: w.rows, fetchAllFn: w.fetchAllFn, savedState: null, deadlineTs: Date.now() + 20000,
      recordPricesFn: recordStubFor(w.ledger), cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set(w.ledger),
      planner, abortSignal,
      onCheckpoint: s => { snaps.push(s); if (snaps.length === 2) abortSignal.aborted = true; }   // 두 배치 뒤 잠금 상실
    });
    const firstRun = w.log.map(x => x.kw);
    const last = snaps[snaps.length - 1];
    check('스냅숏에 시도 목록이 누적된다', last.collectorAttempted.length === firstRun.length, `${last.collectorAttempted.length}/${firstRun.length}`);
    // runLocked 의 이어받기 모양 = mallStateFromSnapshot + last_result 로 조립 (coupangSaved/adpickSaved 참고)
    const m = C.mallStateFromSnapshot(last);
    const resumed = { job_date: TODAY, ...m, last_result: { ...m.last_result, failedKeywords: m.failedKeywords,
      collectorCovered: m.collectorCovered, collectorAttempted: m.collectorAttempted, collectorOptionMismatches: m.collectorOptionMismatches } };
    w.startRun();
    const r2 = await C.runMallCollection({
      mallName: 'ADPICK', rows: w.rows, fetchAllFn: w.fetchAllFn, savedState: resumed, deadlineTs: Date.now() + 20000,
      recordPricesFn: recordStubFor(w.ledger), cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set(w.ledger), planner
    });
    const secondPass1 = w.log.filter(x => x.run === 2 && /^검색어\d{3}$/.test(x.kw)).map(x => x.kw);
    check('★ 이어받은 실행은 중단 전에 부른 1차 검색어를 다시 부르지 않는다',
      secondPass1.every(kw => !firstRun.includes(kw)), secondPass1.filter(kw => firstRun.includes(kw)).join(','));
    eq('★ 두 실행 합쳐 80개 전부 시도', r2.attemptedProducts, 80);
    const recoveryQueries = w.log.filter(x => x.run === 2 && !/^검색어\d{3}$/.test(x.kw)).map(x => x.kw);
    check('회수 호출이 있었다', recoveryQueries.length > 0);
    check('★ 회수 중에도 스냅숏(=잠금 연장)이 나가고 부른 회수 검색어가 실린다',
      r2.secondPassDone.length >= recoveryQueries.length && recoveryQueries.every(q => r2.secondPassDone.includes(q)));
  }
  {
    /* 회수 도중 스냅숏이 이번 실행의 회수 검색어를 싣는다 (중간에 끊겨도 다음 실행이 반복하지 않게) */
    const w = world(10, 1000);
    const snaps = [];
    w.startRun();
    await C.runMallCollection({
      mallName: 'ADPICK', rows: w.rows, fetchAllFn: w.fetchAllFn, savedState: null, deadlineTs: Date.now() + 20000,
      recordPricesFn: recordStubFor(w.ledger), cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set(w.ledger),
      onCheckpoint: s => snaps.push(s)
    });
    const withRecovery = snaps.filter(s => s.secondPassDone.some(q => !/^검색어\d{3}$/.test(q)));
    check('★ 회수 패스 도중에도 체크포인트가 호출되고 회수 검색어가 실린다 (heartbeat)', withRecovery.length > 0,
      `snaps=${snaps.length}`);
  }
  console.log('');

  /* ── 7. fetchCoupangAll / fetchAdpickAll ──────────────────────── */
  console.log('[7] 공급자 경로 — 일시 장애는 래치하지 않고, 거절만 실행 끝까지 멈춘다');
  {
    const warn = console.warn, err = console.error;
    console.warn = () => {}; console.error = () => {};
    coupangFake.script.push({ items: [], allItems: [], from: 'none', blocked: true, apiCalled: false,
      error: '전역 제한: 호출 중단 중 (재개 2026-09-28 19:48:52+00) 네트워크 응답 시간 초과 (8000ms)' });
    const a = await C.fetchCoupangAll('일시 장애 검색어');
    check('일시 장애 응답은 실패로 돌려준다', a.ok === false && /차단/.test(a.reason), a.reason);
    eq('★ 수집기는 같은 날 캐시를 인정한다 (cacheTtlMs 24h 전달)', coupangFake.calls[0].opts.cacheTtlMs, 24 * 3600 * 1000);
    coupangFake.script.push({ items: [{ productId: 'CP1', title: 't', lprice: 100, oprice: 100, link: '', image: '', itemId: '1', vendorItemId: '2' }],
      allItems: null, from: 'api', blocked: false, apiCalled: true });
    const b = await C.fetchCoupangAll('다음 검색어');
    check('★ 일시 장애 뒤 다음 호출은 막히지 않는다 (래치 없음)', b.ok === true && coupangFake.calls.length === 2, JSON.stringify(b).slice(0, 80));
    coupangFake.script.push({ items: [], from: 'none', blocked: true, apiCalled: true, error: '쿠팡 API 403: Access denied' });
    const c = await C.fetchCoupangAll('거절 검색어');
    check('거절 응답은 실패', c.ok === false);
    const before = coupangFake.calls.length;
    const d = await C.fetchCoupangAll('거절 뒤 검색어');
    check('★ 거절 뒤에는 공급자 모듈을 부르지도 않는다 (래치)', d.ok === false && coupangFake.calls.length === before, d.reason);
    adpickFake.script.push({ items: [], from: 'api', blocked: false, apiCalled: true });
    await C.fetchAdpickAll('애드픽 검색어');
    eq('ADPICK 도 같은 날 캐시 TTL 을 넘긴다', adpickFake.calls[0].opts.cacheTtlMs, 24 * 3600 * 1000);
    console.warn = warn; console.error = err;
  }
  eq('이 테스트는 운영 DB 를 한 번도 부르지 않았다', dbCalls.length, 0);

  console.log(`\n====================================================\nPASS ${pass}  /  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
