#!/usr/bin/env node
/*
 * 수집기 V3 테스트 — 외부 API·운영 DB 를 전혀 부르지 않는다.
 *
 *   1) 계획기(api/_collectplan.js) 단위 테스트
 *   2) 계획기 속성 테스트 — 순열 보존 / 결정성 / 기아 상한 (시드 고정 난수)
 *   3) runMallCollection V3 경로 — 가짜 fetch·가짜 저장으로 순서·이어받기·체크포인트·중단
 *   4) 체크포인트 기록기 — 잠금 조건부 쓰기, 잠금 상실, 최소 간격, 일시 오류
 *   5) 플래그 기본값과 상태 서명 호환 규칙
 *
 *   node scripts/test-collector-v3.js
 */
'use strict';

process.env.PRICE_BATCH_INTERVAL_MS = '1';   // 0 은 Number(x) || 15000 에 걸려 기본값이 된다

const Planner = require('../api/_collectplan');
const C = require('./collect-all-prices');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); }
}
function eq(name, got, want) { check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const DAY = 86400000;
const DAY_START = Date.parse('2026-09-23T00:00:00+09:00');
const ago = d => (d == null ? null : new Date(DAY_START - d * DAY).toISOString());

/* 시드 고정 난수 (mulberry32) — 속성 테스트가 매번 같은 입력을 본다. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(async () => {
  console.log('=== 수집기 V3 테스트 ===\n');

  /* ── 1. 계획기 단위 ─────────────────────────────────────────── */
  console.log('[1] 신선도·긴급도·채점');
  eq('daily 0.9일 = fresh', Planner.freshnessClass(0.9, 'daily'), 'fresh');
  eq('daily 1.5일 = fresh (경계 포함)', Planner.freshnessClass(1.5, 'daily'), 'fresh');
  eq('daily 2일 = lapsed', Planner.freshnessClass(2, 'daily'), 'lapsed');
  eq('daily 5일 = stale', Planner.freshnessClass(5, 'daily'), 'stale');
  eq('rotation 7일 = fresh (한 바퀴)', Planner.freshnessClass(7, 'rotation'), 'fresh');
  eq('rotation 14일 = lapsed', Planner.freshnessClass(14, 'rotation'), 'lapsed');
  eq('rotation 40일 = stale', Planner.freshnessClass(40, 'rotation'), 'stale');
  eq('기록 없음 = never', Planner.freshnessClass(null, 'daily'), 'never');
  eq('주기 안 긴급도 1', Planner.urgencyOf(0.9, 'daily'), 1);
  eq('daily 3일 긴급도 3', Planner.urgencyOf(3, 'daily'), 3);
  eq('긴급도 상한', Planner.urgencyOf(100, 'daily'), Planner.URGENCY_CAP);
  eq('기록 없음 긴급도 = 상한', Planner.urgencyOf(null, 'rotation'), Planner.URGENCY_CAP);
  eq('ageDaysOf 는 오늘 0시 기준', Planner.ageDaysOf(ago(2), DAY_START), 2);
  eq('ageDaysOf 오늘 기록은 0', Planner.ageDaysOf(new Date(DAY_START + 3600e3).toISOString(), DAY_START), 0);

  {
    const ctx = { mall: '쿠팡', dayStartMs: DAY_START, tierOf: () => 'daily', limit: 10 };
    const fresh = Planner.scoreGroup([{ collected_at: ago(0.8) }], ctx);
    const stale = Planner.scoreGroup([{ collected_at: ago(8) }], ctx);
    const almost = Planner.scoreGroup([{ collected_at: ago(6) }], ctx);
    check('fresh daily 가 stale daily 보다 가치가 크다', fresh.score > stale.score, `${fresh.score} vs ${stale.score}`);
    eq('fresh daily 기대 회수 = 보정표 값', fresh.expected, Planner.PRIOR['쿠팡'].daily.fresh);
    check('daily 8일 = 굶은 상품, fresh 는 아니다', stale.starving && !fresh.starving);
    check('daily 6일은 아직 굶은 상품이 아니다 (기준 7일)', !almost.starving);
    const big = Planner.scoreGroup(Array.from({ length: 30 }, () => ({ collected_at: ago(0.8) })), ctx);
    check('★ 응답 상한(limit=10)개까지만 센다 — 30개 그룹의 기대 회수 ≤ 10', big.expected <= 10 + 1e-9, String(big.expected));
  }
  console.log('');

  /* ── 2. 속성 테스트 ─────────────────────────────────────────── */
  console.log('[2] 속성 — 순열 보존 · 결정성 · 기아 예약');
  {
    const r = rng(20260923);
    const groups = Array.from({ length: 400 }, (_, i) => ({
      kw: `kw${String(i).padStart(4, '0')}`,
      rows: Array.from({ length: 1 + Math.floor(r() * 6) }, (_, j) => ({
        product_id: `P${i}-${j}`, mall: 'ADPICK',
        collected_at: r() < 0.1 ? null : ago(r() * 40)
      }))
    }));
    const tierOf = p => (p.product_id.endsWith('-0') ? 'daily' : 'rotation');
    const ctx = { mall: 'ADPICK', date: '2026-09-23', dayStartMs: DAY_START, tierOf, limit: 20 };
    const a = Planner.orderGroups(groups, ctx);
    const b = Planner.orderGroups(groups, ctx);
    eq('출력 개수 = 입력 개수', a.length, groups.length);
    eq('중복 없음', new Set(a.map(g => g.kw)).size, groups.length);
    check('같은 입력 → 같은 순서 (결정적)', a.map(g => g.kw).join() === b.map(g => g.kw).join());
    const starving = a.filter(g => g.starving);
    const firstStarveSlot = Planner.STARVE_EVERY - 1;
    check('첫 예약 슬롯은 굶은 그룹 중 hash 가 가장 작은 것 (커서 없음)',
      a[firstStarveSlot].lane === 'starve'
        && a[firstStarveSlot].hash === Math.min(...starving.map(g => g.hash)),
      `${a[firstStarveSlot].lane} ${a[firstStarveSlot].hash}`);
    const cur = a[firstStarveSlot].hash;
    const a2 = Planner.orderGroups(groups, { ...ctx, starveAfter: cur });
    check('커서를 주면 그 다음 hash 부터 잇는다',
      a2[firstStarveSlot].hash === Math.min(...starving.filter(g => g.hash > cur).map(g => g.hash)));
    const maxH = Math.max(...starving.map(g => g.hash));
    const a3 = Planner.orderGroups(groups, { ...ctx, starveAfter: maxH });
    eq('끝까지 돌면 처음으로 감는다', a3[firstStarveSlot].hash, Math.min(...starving.map(g => g.hash)));
    eq('advanceStarveCursor: 예약 레인의 마지막 그룹으로 옮긴다',
      Planner.advanceStarveCursor(null, a.slice(0, Planner.STARVE_EVERY * 2)),
      a.slice(0, Planner.STARVE_EVERY * 2).filter(g => g.lane === 'starve').pop().hash);
    eq('advanceStarveCursor: 예약 레인이 없으면 그대로', Planner.advanceStarveCursor(42, [{ lane: 'value', hash: 7 }]), 42);
    const k = 5, head = a.slice(0, Planner.STARVE_EVERY * k);
    check(`★ 앞 ${Planner.STARVE_EVERY * k}개 중 기아 예약이 ${k}개 이상`, head.filter(g => g.lane === 'starve').length >= k);
    const nonStarveValues = a.filter(g => g.lane === 'value').map(g => g.score);
    check('value 레인은 가치 내림차순', nonStarveValues.every((v, i) => i === 0 || nonStarveValues[i - 1] >= v));

    /* 동점 그룹은 날짜가 바뀌면 순서가 바뀐다 — 가나다 앞쪽 고정 편향이 없다 */
    const ties = Array.from({ length: 50 }, (_, i) => ({ kw: `tie${i}`, rows: [{ product_id: `T${i}`, mall: 'ADPICK', collected_at: ago(0.5) }] }));
    const d1 = Planner.orderGroups(ties, { ...ctx, tierOf: () => 'daily', date: '2026-09-23' }).map(g => g.kw).join();
    const d2 = Planner.orderGroups(ties, { ...ctx, tierOf: () => 'daily', date: '2026-09-24' }).map(g => g.kw).join();
    check('동점 순서는 날짜마다 바뀐다', d1 !== d2);
  }
  {
    /*
     * ★ 기아 상한 시뮬레이션. 하루 예산이 그룹 수보다 작은 세계에서 매일 다시 계획해도
     *   «확보 확률이 거의 0인» 상품까지 결국 불린다. 예약 슬롯이 없으면 그런 상품은
     *   영원히 value 레인 뒤에 남는다(대조군으로 같이 확인).
     */
    const r = rng(7);
    const N = 300, BUDGET = 60, DAYS = 40;
    const mk = () => Array.from({ length: N }, (_, i) => ({
      kw: `g${i}`, rows: [{ product_id: `S${i}`, mall: '쿠팡', collected_at: ago(i < 30 ? 30 : r() * 2) }]
    }));
    function simulate(starveEvery) {
      const groups = mk();
      const lastCall = new Map();
      let cursor = null;
      for (let d = 0; d < DAYS; d++) {
        const dayStart = DAY_START + d * DAY;
        const order = Planner.orderGroups(groups, { mall: '쿠팡', date: `d${d}`, dayStartMs: dayStart, tierOf: () => 'daily', limit: 10, starveEvery, starveAfter: cursor });
        const called = order.slice(0, BUDGET);
        cursor = Planner.advanceStarveCursor(cursor, called);
        called.forEach(g => {
          lastCall.set(g.kw, d);
          // 스텁 세계: 처음 30개(오래된 것)는 절대 확보되지 않는다. 나머지는 부르면 확보된다.
          if (Number(g.kw.slice(1)) >= 30) groups[Number(g.kw.slice(1))].rows[0].collected_at = new Date(dayStart + 3600e3).toISOString();
        });
      }
      const never = groups.filter(g => !lastCall.has(g.kw)).length;
      return { never };
    }
    const withReserve = simulate(Planner.STARVE_EVERY);
    const without = simulate(0);
    eq('★ 예약 슬롯 ON: 40일 동안 한 번도 안 불린 그룹 0', withReserve.never, 0);
    check('대조군(예약 OFF)에서는 굶는 그룹이 생긴다 — 예약 슬롯이 실제로 일을 한다', without.never > 0, `never=${without.never}`);
  }
  {
    /*
     * ★ 원형 순회 상한: 굶은 그룹 S개(전부 영원히 확보 불가), 하루 예약 호출 s회면
     *   모든 그룹이 ⌈S/s⌉일 안에 불린다. 가치 레인이 전부 fresh 로 가득해도 성립해야 한다.
     */
    const S = 97, BUDGET = 64;                       // 하루 64호출 → 예약 8회
    const s = Math.floor(BUDGET / Planner.STARVE_EVERY);
    const bound = Math.ceil(S / s);
    const groups = [
      ...Array.from({ length: S }, (_, i) => ({ kw: `dead${i}`, rows: [{ product_id: `D${i}`, collected_at: ago(60 + i) }] })),
      ...Array.from({ length: 500 }, (_, i) => ({ kw: `live${i}`, rows: [{ product_id: `L${i}`, collected_at: ago(0.5) }] }))
    ];
    const firstSeen = new Map();
    let cursor = null;
    for (let d = 0; d < bound; d++) {
      const order = Planner.orderGroups(groups, { mall: '쿠팡', date: `d${d}`, dayStartMs: DAY_START, tierOf: () => 'daily', limit: 10, starveAfter: cursor });
      const called = order.slice(0, BUDGET);
      cursor = Planner.advanceStarveCursor(cursor, called);
      called.filter(g => g.kw.startsWith('dead')).forEach(g => { if (!firstSeen.has(g.kw)) firstSeen.set(g.kw, d); });
    }
    eq(`★ 굶은 ${S}개가 전부 ${bound}일(=⌈S/s⌉) 안에 불렸다`, firstSeen.size, S);
  }
  console.log('');

  /* ── 3. runMallCollection V3 경로 ─────────────────────────────── */
  console.log('[3] runMallCollection V3 — 순서 · 이어받기 · 오늘 제외 · 체크포인트 · 중단');
  const mkRows = spec => spec.map(([id, kw, ageD]) => ({
    product_id: id, mall: 'ADPICK', title: `상품 ${id}`, keyword: kw,
    link: '', image: '', vendor_item_id: '', item_id: '', collected_at: ago(ageD)
  }));
  const recordStub = async (obs) => ({
    saved: obs.length, recorded: obs.length, rejected: 0, suspect: 0, optionMismatch: 0, errors: [],
    recordedKeys: obs.map(o => `${o.productId}|${o.mall}`)
  });
  const NO_HINT = async () => new Map();
  const planner = { tierOf: () => 'daily', dayStartMs: DAY_START, limit: 20 };
  const rows = mkRows([
    ['A1', '가방', 6], ['A2', '가방', 6],            // stale — 확보 확률 낮음
    ['B1', '나무', 0.8],                              // fresh
    ['C1', '다리미', 0.8], ['C2', '다리미', 0.8],     // fresh ×2 — 가장 가치 큼
    ['D1', '라면', 2]                                 // lapsed
  ]);
  const makeFetch = (log) => async (kw) => {
    log.push(kw);
    const ids = rows.filter(p => p.keyword === kw).map(p => p.product_id);
    return { ok: true, reason: '', items: ids.map(id => ({ productId: id, title: id, lprice: 1000, oprice: 1000, link: '', image: '', mall: 'ADPICK', itemId: '', vendorItemId: '' })) };
  };
  {
    const calls = [];
    const snaps = [];
    const r = await C.runMallCollection({
      mallName: 'ADPICK', rows, fetchAllFn: makeFetch(calls), savedState: null, deadlineTs: Date.now() + 8000,
      recordPricesFn: recordStub, cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set(),
      planner, onCheckpoint: s => snaps.push(s)
    });
    eq('★ V3: 가치 순 — 첫 호출은 fresh 2개짜리 그룹', calls[0], '다리미');
    check('★ V3: stale 그룹(가방)은 fresh·lapsed 보다 뒤', calls.indexOf('가방') > calls.indexOf('나무') && calls.indexOf('가방') > calls.indexOf('라면'), calls.join(','));
    eq('모든 그룹이 한 번씩 불렸다', calls.length, 4);
    eq('수집 성공 6개', r.collectorSuccessProducts, 6);
    eq('V3 는 커서를 쓰지 않는다', r.cursorKey, '');
    check('체크포인트가 배치마다 호출됐다', snaps.length >= 1, `n=${snaps.length}`);
    check('체크포인트 status 는 항상 running', snaps.every(s => s.status === 'running'));
    const last = snaps[snaps.length - 1];
    check('체크포인트 attempted 가 누적된다', last.collectorAttempted.length === 6, String(last.collectorAttempted.length));
  }
  {
    /* 레거시가 같은 날 이미 찾아본 상품은 V3 가 다시 부르지 않는다 */
    const calls = [];
    const saved = {
      job_date: C.kstToday(), cursor_key: '나무', processed: 3, total: 6, status: 'running',
      last_result: { collectorAttempted: ['A1|ADPICK', 'A2|ADPICK', 'B1|ADPICK'], collectorCovered: ['B1|ADPICK'], failedKeywords: [] }
    };
    const r = await C.runMallCollection({
      mallName: 'ADPICK', rows, fetchAllFn: makeFetch(calls), savedState: saved, deadlineTs: Date.now() + 8000,
      recordPricesFn: recordStub, cacheHintFn: NO_HINT,
      // B1 은 레거시가 이미 확보했으니 오늘 원장에도 있다. D1 은 다른 경로(검색)가 오늘 기록했다.
      collectedTodayFn: async () => new Set(['B1|ADPICK', 'D1|ADPICK']),
      planner
    });
    const groupKw = new Set(rows.map(p => p.keyword));
    const pass1 = calls.filter(kw => groupKw.has(kw));
    check('★ 레거시 상태 이어받기: 이미 찾아본 가방·나무는 1차로 다시 안 부른다', !pass1.includes('가방') && !pass1.includes('나무'), pass1.join(','));
    check('★ 오늘 다른 경로로 가격이 생긴 라면 그룹은 안 부른다', !pass1.includes('라면'), pass1.join(','));
    eq('1차는 남은 다리미 하나뿐', pass1.join(','), '다리미');
    const recovery = calls.filter(kw => !groupKw.has(kw));
    check('회수 패스는 «찾아봤지만 무매칭» 인 A1·A2 만 노린다 (레거시와 같은 자격)',
      recovery.length > 0 && recovery.every(kw => /A1|A2/.test(kw)), recovery.join(','));
    check('이어받은 확보 목록이 보존된다', r.collectorCovered.includes('B1|ADPICK'));
  }
  {
    /* 잠금 상실 신호 → 첫 배치 뒤 멈춘다 */
    const calls = [];
    const many = mkRows(Array.from({ length: 60 }, (_, i) => [`M${i}`, `kw${String(i).padStart(2, '0')}`, 0.8]));
    const abortSignal = { aborted: false };
    const r = await C.runMallCollection({
      mallName: 'ADPICK', rows: many, fetchAllFn: async kw => { calls.push(kw); return { ok: true, reason: '', items: [] }; },
      savedState: null, deadlineTs: Date.now() + 8000,
      recordPricesFn: recordStub, cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set(),
      planner, onCheckpoint: () => { abortSignal.aborted = true; }, abortSignal
    });
    eq('★ 중단 신호: 첫 배치(20개)만 부르고 멈춘다', calls.length, 20);
    eq('중단된 실행은 running', r.status, 'running');
    check('중단된 실행은 stoppedEarly', r.stoppedEarly === true);
  }
  {
    /* 레거시(planner 없음)는 그대로 가나다순 */
    const calls = [];
    await C.runMallCollection({
      mallName: 'ADPICK', rows, fetchAllFn: makeFetch(calls), savedState: null, deadlineTs: Date.now() + 8000,
      recordPricesFn: recordStub, cacheHintFn: NO_HINT, collectedTodayFn: async () => new Set()
    });
    eq('★ 레거시: 가나다순 그대로', calls.join(','), '가방,나무,다리미,라면');
  }
  console.log('');

  /* ── 4. 체크포인트 기록기 ─────────────────────────────────────── */
  console.log('[4] 체크포인트 기록기 — 잠금 조건 · 상실 · 간격 · 일시 오류');
  function fakeDb(behavior) {
    const log = [];
    return {
      log,
      from(table) {
        const q = { table, filters: [], body: null };
        const api = {
          update(body) { q.body = body; return api; },
          eq(col, val) { q.filters.push([col, val]); return api; },
          select() { log.push(q); return Promise.resolve(behavior(q, log.length)); }
        };
        return api;
      }
    };
  }
  const base = {
    jobDate: '2026-09-23', targetSignature: 'rotation-v1:2026-09-23:7:6:planner-v3',
    prevLastResult: { recorded: 10, failureCategories: { noMatch: 3 } },
    malls: { '쿠팡': { cursor_key: '힙시트', processed: 4949, total: 4937, status: 'completed', collectorCovered: ['c1|쿠팡'] } }
  };
  const snap = { cursorKey: '', processed: 5, total: 9, status: 'running', failedKeywords: ['x'],
    collectorCovered: ['a|ADPICK'], collectorAttempted: ['a|ADPICK', 'b|ADPICK'], secondPassDone: [], facetDryGroups: [],
    terminalOptionFailures: [], optionMissStreaks: {} };
  {
    const p = C.checkpointPayload({ base, snaps: { ADPICK: snap }, lockToken: 'T1', nowMs: DAY_START, ttlMs: 80 * 60000 });
    eq('top-level 은 쿠팡 상태(이어받은 completed 를 지우지 않는다)', p.status, 'completed');
    eq('쿠팡 커서 보존', p.cursor_key, '힙시트');
    eq('ADPICK 스냅숏 반영', p.last_result.malls.ADPICK.processed, 5);
    eq('ADPICK 스냅숏 status running', p.last_result.malls.ADPICK.status, 'running');
    eq('잠금 토큰', p.last_result.lock.runId, 'T1');
    eq('잠금 연장 = now + TTL', Date.parse(p.last_result.lock.until) - DAY_START, 80 * 60000);
    eq('이전 리포트 필드 보존', p.last_result.recorded, 10);
    eq('서명 기록', p.last_result.targetSignature, base.targetSignature);
    const p2 = C.checkpointPayload({
      base: { ...base, plannerStarveCursor: { '쿠팡': 11, 'ADPICK': 22 } },
      snaps: { ADPICK: { ...snap, starveCursor: 99 } }, lockToken: 'T1', nowMs: DAY_START, ttlMs: 1
    });
    eq('기아 커서: 스냅숏 값으로 갱신', p2.last_result.plannerStarveCursor.ADPICK, 99);
    eq('기아 커서: 스냅숏이 없는 몰은 이전 값 유지', p2.last_result.plannerStarveCursor['쿠팡'], 11);
  }
  {
    let t = 0;
    const db = fakeDb(() => ({ data: [{ id: 1 }], error: null }));
    const w = C.createCheckpointWriter({ db, lockToken: 'T1', base, minIntervalMs: 1000, now: () => t });
    w.note('ADPICK', snap);
    eq('시작 직후(간격 전)에는 쓰지 않는다', db.log.length, 0);
    t = 1500; w.note('ADPICK', { ...snap, processed: 6 });
    await w.flush();
    eq('간격이 지나면 쓴다', db.log.length, 1);
    check('★ 잠금 조건이 걸려 있다 (last_result->lock->>runId = 토큰)',
      db.log[0].filters.some(([c, v]) => c === 'last_result->lock->>runId' && v === 'T1'));
    eq('최신 스냅숏을 쓴다', db.log[0].body.last_result.malls.ADPICK.processed, 6);
    t = 1600; w.note('ADPICK', { ...snap, processed: 7 });
    eq('간격 안의 note 는 바로 쓰지 않는다', db.log.length, 1);
    await w.flush();
    eq('flush 는 밀린 값을 쓴다', db.log.length, 2);
    const ok = await w.finalize({ job_date: '2026-09-23', status: 'completed', last_result: { lock: { runId: 'T1' } } });
    check('finalize 성공', ok === true);
    eq('finalize 도 잠금 조건', db.log[2].filters.filter(([c]) => c === 'last_result->lock->>runId').length, 1);
  }
  {
    let t = 0, lostCalled = 0;
    const db = fakeDb(() => ({ data: [], error: null }));   // 0행 = 잠금이 남의 것
    const w = C.createCheckpointWriter({ db, lockToken: 'T1', base, minIntervalMs: 0, now: () => t, onLost: () => { lostCalled++; } });
    t = 10; w.note('ADPICK', snap); await w.flush();
    check('★ 0행 갱신 = 잠금 상실', w.stats.lost === true);
    check('★ 중단 신호가 켜진다', w.abortSignal.aborted === true);
    eq('onLost 1회', lostCalled, 1);
    const before = db.log.length;
    t = 20; w.note('ADPICK', snap); await w.flush();
    eq('잠금을 잃은 뒤에는 더 쓰지 않는다', db.log.length, before);
    check('★ 잠금을 잃은 실행의 최종 저장은 거부된다', (await w.finalize({})) === false);
  }
  {
    let t = 0;
    let n = 0;
    const db = fakeDb(() => (++n === 1 ? { data: null, error: { message: '504 Gateway Timeout' } } : { data: [{ id: 1 }], error: null }));
    const w = C.createCheckpointWriter({ db, lockToken: 'T1', base, minIntervalMs: 0, now: () => t });
    t = 1; w.note('ADPICK', snap); await w.flush();
    eq('일시 오류는 실패로 세고', w.stats.failures, 1);
    check('잠금 상실로 보지 않는다', w.stats.lost === false);
    t = 2; w.note('ADPICK', snap); await w.flush();
    eq('다음 체크포인트에서 다시 쓴다', w.stats.writes, 1);
  }
  console.log('');

  /* ── 5. 플래그 기본값 · 서명 호환 ───────────────────────────── */
  console.log('[5] 플래그 기본값 · 상태 서명 호환');
  if (process.env.PRICE_COLLECTOR_V3 === '1') {
    check('PRICE_COLLECTOR_V3=1 이면 하위 기능이 전부 켜진다', C.V3 && C.V3_PLANNER && C.V3_PARALLEL && C.V3_CHECKPOINT);
  } else {
    check('★ 환경변수가 없으면 V3 는 꺼져 있다 (레거시 그대로)', C.V3 === false && C.V3_PLANNER === false && C.V3_PARALLEL === false && C.V3_CHECKPOINT === false);
  }
  eq('ADPICK 하루 상한 기본값 1,800', C.ADPICK_DAY_BUDGET, 1800);
  const meta = { signature: 'rotation-v1:2026-09-23:7:6' };
  eq('V3 서명', C.targetSignatureFor(meta, true), 'rotation-v1:2026-09-23:7:6:planner-v3');
  eq('레거시 서명 그대로', C.targetSignatureFor(meta, false), 'rotation-v1:2026-09-23:7:6');
  check('★ V3 는 같은 날 레거시 상태를 이어받는다', C.resumeCompatible('rotation-v1:2026-09-23:7:6', meta, true));
  check('★ 레거시는 V3 상태를 이어받지 않는다 (커서가 비어 있다)', !C.resumeCompatible('rotation-v1:2026-09-23:7:6:planner-v3', meta, false));
  check('다른 날/버킷 서명은 둘 다 거부', !C.resumeCompatible('rotation-v1:2026-09-22:7:5', meta, true));

  console.log(`\n====================================================\nPASS ${pass}  /  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
