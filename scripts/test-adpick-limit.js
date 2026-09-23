#!/usr/bin/env node
/*
 * ADPICK 리미터 테스트 (api/_adpicklimit.js) — 가상 시계, 외부 호출·DB 0회.
 *
 *   1) 한 프로세스: 타이머가 무작위로 늦어도 «기록된 시작 시각» 기준으로
 *      임의의 연속 60초(양 끝 포함) ≤ maxPerMin, 연속 간격 ≥ minGapMs
 *   2) 대조군: 예전 reserveSlot(예약 시각 기준) 은 같은 조건에서 60초에 6회를 기록한다
 *   3) maxWaitMs=0 호출은 앞 호출의 대기 뒤에 줄 서지 않고 바로 거절된다
 *   4) 세 프로세스 + 전역 예약(adpick_acquire 와 같은 규칙): 합이 전역 상한 이하.
 *      전역 예약이 없으면 같은 부하에서 공식 10회를 넘는다 (대조군)
 *   5) 전역 리미터 실패 모드: 함수 없음 → 건너뜀 / DB 오류 → 거절 / rpc 가 던짐 → 건너뜀
 *   6) 전역 예약 뒤 한참 늦게 깨면(멈춤) 부르지 않는다
 *
 *   node scripts/test-adpick-limit.js
 */
'use strict';

const L = require('../api/_adpicklimit');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail != null ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail != null ? '  — ' + detail : ''}`); }
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 가상 시계: sleep 은 요청한 시각 «이후» 에 깬다 (lateness 만큼 늦게). */
function virtualClock(lateness) {
  let t = 1_000_000;
  const timers = [];
  let seq = 0;
  return {
    now: () => t,
    sleep: ms => new Promise(res => { timers.push({ at: t + Math.max(0, ms) + (lateness ? lateness() : 0), res, seq: seq++ }); }),
    async run(maxSteps = 5_000_000) {
      for (let i = 0; i < maxSteps; i++) {
        await flush();
        if (!timers.length) return;
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const x = timers.shift();
        t = Math.max(t, x.at);
        x.res();
      }
    }
  };
}
async function flush() { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); }

/** 예전 _adpick.js reserveSlot 을 그대로 옮긴 대조군 (예약 시각 기준). */
function oldLimiter(clock, maxPerMin) {
  const st = { window: [], lastCallAt: 0 };
  let chain = Promise.resolve();
  return function acquire(minGapMs, maxWaitMs) {
    const p = chain.then(() => {
      const now = clock.now();
      while (st.window.length && st.window[0] <= now - 60000) st.window.shift();
      const at = Math.max(now, st.lastCallAt + minGapMs);
      const windowFreeAt = st.window.length >= maxPerMin ? st.window[st.window.length - maxPerMin] + 60000 : 0;
      const slotAt = Math.max(at, windowFreeAt);
      const waitMs = slotAt - now;
      if (waitMs > maxWaitMs) return { ok: false };
      st.lastCallAt = slotAt; st.window.push(slotAt);
      return { ok: true, waitMs };
    });
    chain = p.then(() => {}, () => {});
    return p.then(async r => { if (r.ok && r.waitMs > 0) await clock.sleep(r.waitMs); return r.ok ? { ok: true, startMs: clock.now() } : r; });
  };
}

/** adpick_acquire(SQL) 와 같은 규칙의 가짜 전역 예약. 응답 왕복 지연을 흉내낸다. */
function fakeGlobal(clock, { maxPerMin, marginMs, rand }) {
  const slots = [];
  const calls = { n: 0 };
  async function rpc(fn, a) {
    calls.n++;
    await clock.sleep(20 + Math.floor(rand() * 60));          // 요청이 DB 에 닿기까지
    const now = clock.now();
    let slot = now + (a.p_not_before_ms || 0);
    if (slots.length) slot = Math.max(slot, slots[slots.length - 1]);
    if (slots.length >= a.p_max_per_min) slot = Math.max(slot, slots[slots.length - a.p_max_per_min] + 60000 + a.p_margin_ms + 1);
    const used = slots.filter(s => s > slot - 60000).length;
    let row;
    if (slot - now > a.p_max_wait_ms) row = { allowed: false, wait_ms: slot - now, reason: 'global', used };
    else { slots.push(slot); slots.sort((x, y) => x - y); row = { allowed: true, wait_ms: slot - now, reason: '', used: used + 1 }; }
    await clock.sleep(20 + Math.floor(rand() * 60));          // 응답이 돌아오기까지
    return { data: [row], error: null };
  }
  return { rpc, slots, calls };
}

/** 워커 여러 개가 호출을 반복한다. 요청 자체도 시간이 걸린다 (응답 지연 5초 안팎). */
async function drive(clock, acquire, { workers, total, maxWaitMs, minGapMs, rand, reqMs = 5000 }) {
  const starts = [];
  let issued = 0, denied = 0;
  const worker = async () => {
    while (issued < total) {
      issued++;
      const r = await acquire({ maxWaitMs, minGapMs });
      if (!r.ok) { denied++; await clock.sleep(1000); continue; }
      starts.push(r.startMs);
      await clock.sleep(reqMs * (0.6 + rand() * 0.8));
    }
  };
  const all = Promise.all(Array.from({ length: workers }, worker));
  await clock.run();
  await all;
  return { starts, denied };
}

(async () => {
  console.log('=== ADPICK 리미터 테스트 ===\n');

  console.log('[1] 한 프로세스 — 타이머가 늦어도 기록 기준으로 한도를 지킨다');
  for (const seed of [1, 2, 3]) {
    const rand = rng(seed);
    const clock = virtualClock(() => (rand() < 0.02 ? 1500 + rand() * 2000 : rand() * 400));
    const lim = L.createLimiter({ maxPerMin: 5, minGapMs: 12000, now: clock.now, sleep: clock.sleep });
    const { starts, denied } = await drive(clock, a => lim.acquire(a), { workers: 4, total: 600, maxWaitMs: 60000, minGapMs: 12000, rand });
    const s = L.rollingStats(starts);
    check(`seed ${seed}: 임의의 60초(양 끝 포함) ≤ 5회`, s.maxIn60s <= 5, `${s.count}회 · 60초 최대 ${s.maxIn60s} · 거절 ${denied}`);
    check(`seed ${seed}: 연속 간격 ≥ 12,000ms`, s.minGapMs >= 12000, `최소 ${s.minGapMs}ms`);
  }

  console.log('\n[2] 대조군 — 예전 reserveSlot 은 같은 조건에서 한도를 넘겨 기록한다');
  {
    let worst = 0, worstGap = Infinity;
    for (const seed of [1, 2, 3]) {
      const rand = rng(seed);
      const clock = virtualClock(() => (rand() < 0.02 ? 1500 + rand() * 2000 : rand() * 400));
      const old = oldLimiter(clock, 5);
      const { starts } = await drive(clock, a => old(a.minGapMs, a.maxWaitMs), { workers: 4, total: 600, maxWaitMs: 60000, minGapMs: 12000, rand });
      const s = L.rollingStats(starts);
      worst = Math.max(worst, s.maxIn60s); worstGap = Math.min(worstGap, s.minGapMs);
    }
    check('★ 예전 방식은 기록상 60초에 6회 이상이 나온다 (운영 59.991초 6회와 같은 모양)', worst >= 6, `최대 ${worst}회`);
    check('예전 방식은 기록상 간격이 12초보다 짧아진다', worstGap < 12000, `최소 ${worstGap}ms`);
  }

  console.log('\n[3] 사용자 요청(maxWaitMs=0)은 줄 서지 않고 바로 거절된다');
  {
    const clock = virtualClock(() => 0);
    const lim = L.createLimiter({ maxPerMin: 5, minGapMs: 12000, now: clock.now, sleep: clock.sleep });
    const first = lim.acquire({ maxWaitMs: 60000 });
    const second = lim.acquire({ maxWaitMs: 60000 });       // 12초 뒤 슬롯을 기다린다
    await flush();
    const t0 = clock.now();
    let liveDone = null;
    lim.acquire({ maxWaitMs: 0 }).then(r => { liveDone = { r, at: clock.now() }; });
    await flush();
    check('★ 즉시 결론이 난다 (가상 시간이 흐르지 않았다)', liveDone && liveDone.at === t0, liveDone ? `${liveDone.at - t0}ms` : '대기 중');
    check('거절 사유를 말한다', liveDone && !liveDone.r.ok && /간격|한도/.test(liveDone.r.reason), liveDone && liveDone.r.reason);
    await clock.run(); await first; await second;
    const idle = virtualClock(() => 0);
    const lim2 = L.createLimiter({ maxPerMin: 5, minGapMs: 12000, now: idle.now, sleep: idle.sleep });
    const r = await lim2.acquire({ maxWaitMs: 0 });
    check('한가하면 maxWaitMs=0 도 바로 통과한다', r.ok && r.waitMs === 0);
  }

  console.log('\n[4] 세 프로세스 — 전역 예약이 합을 묶는다');
  {
    const rand = rng(11);
    const clock = virtualClock(() => (rand() < 0.02 ? 300 + rand() * 500 : rand() * 150));
    const G = fakeGlobal(clock, { rand });
    const mk = (cap, gap, source) => {
      const lim = L.createLimiter({ maxPerMin: cap, minGapMs: gap, now: clock.now, sleep: clock.sleep });
      const g = L.createGlobalAcquire({ rpc: G.rpc, bucket: 'search', maxPerMin: 8, marginMs: 1000, isMissingObject: () => false });
      return a => lim.acquire({ ...a, global: x => g({ ...x, source }) });
    };
    const procs = [mk(5, 12000, 'collect'), mk(3, 10000, 'cron'), mk(3, 10000, 'external-hotdeal')];
    const all = [];
    const runs = procs.map((acq, i) => drive(clock, acq, { workers: i ? 2 : 4, total: [400, 150, 150][i], maxWaitMs: 60000, minGapMs: [12000, 10000, 10000][i], rand }));
    const res = await Promise.all(runs);
    res.forEach(r => all.push(...r.starts));
    const s = L.rollingStats(all);
    check('★ 세 프로세스 합: 임의의 60초 ≤ 전역 8회 (공식 10회 아래)', s.maxIn60s <= 8, `${s.count}회 · 60초 최대 ${s.maxIn60s}`);
    res.forEach((r, i) => {
      const x = L.rollingStats(r.starts);
      check(`프로세스 ${i} 자기 한도도 지킨다`, x.maxIn60s <= [5, 3, 3][i], `60초 최대 ${x.maxIn60s}`);
    });

    const rand2 = rng(11);
    const clock2 = virtualClock(() => (rand2() < 0.02 ? 300 + rand2() * 500 : rand2() * 150));
    const mk2 = (cap, gap) => { const lim = L.createLimiter({ maxPerMin: cap, minGapMs: gap, now: clock2.now, sleep: clock2.sleep }); return a => lim.acquire(a); };
    const noG = await Promise.all([mk2(5, 12000), mk2(20, 1000), mk2(20, 1000)].map((acq, i) =>
      drive(clock2, acq, { workers: i ? 2 : 4, total: [400, 150, 150][i], maxWaitMs: 60000, minGapMs: [12000, 1000, 1000][i], rand: rand2 })));
    const s2 = L.rollingStats(noG.flatMap(r => r.starts));
    check('대조군: 전역 예약 없이 예전 기본값(20회/1초)이면 공식 10회를 넘는다', s2.maxIn60s > 10, `60초 최대 ${s2.maxIn60s}`);
  }

  console.log('\n[5] 전역 리미터 실패 모드');
  {
    let warned = 0; const warn = console.warn; console.warn = () => { warned++; };
    const missing = L.createGlobalAcquire({ rpc: async () => ({ data: null, error: { message: 'Could not find the function public.adpick_acquire' } }),
      bucket: 'search', maxPerMin: 8, marginMs: 1000, isMissingObject: m => /could not find the function/i.test(m) });
    const a = await missing({ notBeforeMs: 0, maxWaitMs: 0 });
    const b = await missing({ notBeforeMs: 0, maxWaitMs: 0 });
    check('함수 없음(마이그레이션 전) → 건너뛰고 프로세스 안 한도만', a.ok && a.skipped && b.skipped);
    const dbErr = L.createGlobalAcquire({ rpc: async () => ({ data: null, error: { message: 'canceling statement due to statement timeout' } }),
      bucket: 'search', maxPerMin: 8, marginMs: 1000, isMissingObject: () => false });
    const c = await dbErr({ notBeforeMs: 0, maxWaitMs: 0 });
    check('★ 함수는 있는데 DB 가 답하지 못함 → 거절 (합을 확인할 수 없으면 부르지 않는다)', !c.ok && /전역 리미터/.test(c.reason), c.reason);
    const throws = L.createGlobalAcquire({ rpc: () => { throw new Error('Supabase 환경변수 누락'); },
      bucket: 'search', maxPerMin: 8, marginMs: 1000, isMissingObject: () => false });
    const d = await throws({ notBeforeMs: 0, maxWaitMs: 0 });
    check('rpc 가 요청 전에 던짐(설정 없는 환경) → 건너뜀', d.ok && d.skipped);
    const denyRow = L.createGlobalAcquire({ rpc: async () => ({ data: [{ allowed: false, wait_ms: 9000, used: 8, reason: 'global' }], error: null }),
      bucket: 'search', maxPerMin: 8, marginMs: 1000, isMissingObject: () => false });
    const e = await denyRow({ notBeforeMs: 0, maxWaitMs: 0 });
    check('전역 한도 초과 → 거절 + 대기 시간', !e.ok && e.waitMs === 9000, e.reason);
    console.warn = warn;
    check('경고는 한 번씩만', warned <= 2, `경고 ${warned}회`);
  }

  console.log('\n[6] 전역 예약을 받고 한참 늦게 깨면 부르지 않는다');
  {
    let late = 0;
    const clock = virtualClock(() => late);
    const lim = L.createLimiter({ maxPerMin: 5, minGapMs: 0, now: clock.now, sleep: clock.sleep });
    const g = async () => ({ ok: true, waitMs: 5000 });
    late = 3000;   // 5초 뒤 예약인데 8초 뒤에 깬다
    const p = lim.acquire({ maxWaitMs: 60000, global: g });
    await clock.run();
    const r = await p;
    check('★ 멈춤 한도(기본 500ms)보다 늦으면 호출을 건너뛴다', !r.ok && r.kind === 'stall', r.reason);
    late = 0;
    const p2 = lim.acquire({ maxWaitMs: 60000, global: g });
    await clock.run();
    const r2 = await p2;
    check('제때 깨면 부른다', r2.ok);
  }

  console.log(`\n====================================================\nPASS ${pass}  /  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
