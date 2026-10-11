#!/usr/bin/env node
'use strict';
/*
 * 오늘의 하락(view=today-drop) — 서버리스 시간·동시성 상한 (2026-10-04 독립 리뷰 측정 기준).
 *
 *   리뷰 측정(수정 전): 오늘 4,136 id → 79 질의 · 12,000 id → 214 질의 · 동시 25 ·
 *   prior 지연 1초 → 약 4.7초 · today 6초 + prior 5초 → 약 10.5초 · 예산 뒤 진행 중 요청 미취소.
 *
 * 여기서 지키는 것
 *   ① 질의 수: RPC 가 있으면 500 id 당 1 회, 없으면 URL 길이 기준 조각
 *   ② 동시 요청: 직전 관측 단계 ≤ 6 (RPC ≤ 3)
 *   ③ 요청 전체 시간: 어떤 지연에서도 상한(+여유) 안에서 답한다
 *   ④ 상한에 걸리면 진행 중 요청을 취소한다
 *   ⑤ 느림·오류·부분·상한(1,000행) 어느 경우에도 «틀린 하락» 을 만들지 않는다 —
 *      나온 카드의 직전 가격은 전부 진짜 직전 관측과 같다(fail-closed)
 *
 * 가짜 Supabase 위에서 실제 loadTodayDrops 를 돌린다. 운영 DB 0회.
 *
 *   node scripts/test-today-drop-bounds.js                 시험
 *   node scripts/test-today-drop-bounds.js --measure <hotdeals.js 경로>   지표만 출력(수정 전후 비교용)
 */
const path = require('path');
const Module = require('module');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

const MEASURE = process.argv[2] === '--measure' ? path.resolve(process.argv[3]) : null;

/* ── 가짜 Supabase: 지연·실패·취소·동시성 계측 ─────────────────────── */
const db = { price_history: [], hotdeals: [], products: [] };
const ctl = {
  latency: () => 0,          // (kind, n) => ms
  fail: () => false,         // (kind, n) => bool
  rpc: 'missing',            // 'missing' | 'present'
  rowCap: 1000
};
const meter = { queries: { today: 0, prior: 0, rpc: 0, other: 0 }, inflight: 0, peak: 0, priorInflight: 0, priorPeak: 0, abortedSignals: 0, lateResolves: 0 };
function resetMeter() {
  meter.queries = { today: 0, prior: 0, rpc: 0, other: 0 };
  meter.inflight = 0; meter.peak = 0; meter.priorInflight = 0; meter.priorPeak = 0; meter.abortedSignals = 0; meter.lateResolves = 0;
}
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function respond(kind, compute, signal) {
  const n = ++meter.queries[kind];
  meter.inflight++; if (meter.inflight > meter.peak) meter.peak = meter.inflight;
  const isPrior = kind === 'prior' || kind === 'rpc';
  if (isPrior) { meter.priorInflight++; if (meter.priorInflight > meter.priorPeak) meter.priorPeak = meter.priorInflight; }
  return new Promise(resolve => {
    let done = false;
    const finish = r => {
      if (done) return; done = true;
      meter.inflight--; if (isPrior) meter.priorInflight--;
      resolve(r);
    };
    const t = setTimeout(() => {
      if (ctl.fail(kind, n)) return finish({ data: null, error: { message: 'connection reset (fake)' } });
      finish({ data: compute(), error: null });
    }, ctl.latency(kind, n));
    if (signal) {
      if (signal.aborted) { clearTimeout(t); meter.abortedSignals++; return finish({ data: null, error: { message: 'AbortError: aborted' } }); }
      // 끝난 요청에 온 abort 는 세지 않는다 — «진행 중» 이던 요청만 취소된 것이다.
      signal.addEventListener('abort', () => { if (done) return; clearTimeout(t); meter.abortedSignals++; finish({ data: null, error: { message: 'AbortError: aborted' } }); });
    }
  });
}
function from(table) {
  const filters = []; const orders = []; let limitN = null, rFrom = null, rTo = null, signal = null;
  let kind = 'other';
  const q = {
    select() { return q; },
    eq(c, v) { filters.push(r => String(r[c]) === String(v)); return q; },
    in(c, vs) { const set = new Set(vs.map(String)); filters.push(r => set.has(String(r[c]))); if (table === 'price_history' && c === 'product_id') kind = 'prior'; return q; },
    gte(c, v) { filters.push(r => cmp(r[c], v) >= 0); if (table === 'price_history' && kind === 'other') kind = 'today'; return q; },
    lt(c, v) { filters.push(r => cmp(r[c], v) < 0); return q; },
    or() { return q; },
    order(c, o) { orders.push({ c, asc: !o || o.ascending !== false }); return q; },
    limit(n) { limitN = n; return q; },
    range(a, b) { rFrom = a; rTo = b; return q; },
    abortSignal(s) { signal = s; return q; },
    then(res, rej) {
      return respond(kind, () => {
        let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
        if (orders.length) rows = rows.slice().sort((a, b) => { for (const o of orders) { const d = (o.asc ? 1 : -1) * cmp(a[o.c], b[o.c]); if (d) return d; } return 0; });
        if (rFrom != null) rows = rows.slice(rFrom, rTo + 1);
        rows = rows.slice(0, Math.min(limitN == null ? Infinity : limitN, ctl.rowCap));
        return rows.map(r => Object.assign({}, r));
      }, signal).then(res, rej);
    }
  };
  return q;
}
function rpc(name, args) {
  let signal = null;
  const run = () => respond('rpc', () => {
    if (ctl.rpc !== 'present') return null;
    const ids = new Set(args.p_ids.map(String));
    const best = new Map();
    db.price_history.forEach(r => {
      if (!ids.has(String(r.product_id)) || !(r.recorded_at < args.p_before) || !(r.recorded_at >= args.p_since)) return;
      const k = `${r.product_id}|${r.mall}|${r.vendor_item_id}`;
      const cur = best.get(k);
      if (!cur || r.recorded_at > cur.recorded_at) best.set(k, r);
    });
    return [...best.values()].slice(0, ctl.rowCap).map(r => Object.assign({}, r));
  }, signal).then(r => (ctl.rpc !== 'present' && !r.error)
    ? { data: null, error: { message: `Could not find the function public.${name} in the schema cache`, code: 'PGRST202' } }
    : r);
  return { abortSignal(s) { signal = s; return run(); }, then(res, rej) { return run().then(res, rej); } };
}
const fakeSupabase = { from, rpc };
const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request) {
  if (request === './_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};
global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

const hotdealsPath = MEASURE || path.join(__dirname, '..', 'api', 'hotdeals.js');
const H = require(hotdealsPath)._internal;
const { kstToday, kstDayStartUtc } = require('../api/_price');

/* ── 데이터: 쿠팡(숫자 id) 40% · ADPICK(64자 hex) 60% — 운영 비율 근사 ── */
const DAY = 86400000;
function hex64(i) { return (i.toString(16).padStart(8, '0')).repeat(8); }
function build(n, opts) {
  const extra = (opts && opts.priorDays) || 0;
  const dayStart = Date.parse(kstDayStartUtc(kstToday()));
  const rows = []; const truth = new Map();
  for (let i = 0; i < n; i++) {
    const coupang = (opts && opts.coupangOnly) || i % 5 < 2;
    const pid = coupang ? String(9000000000 + i) : hex64(i);
    const mall = coupang ? '쿠팡' : 'ADPICK';
    const vid = coupang ? String(80000000000 + i) : '';
    const base = 20000 + (i % 50) * 1000;
    // 직전 관측 2개(3일 전 · 1일 전) + 오늘 1개. 3개 중 1개는 오늘 10% 내린다.
    const prevLatest = base + (i % 3 === 0 ? 3000 : 0);
    rows.push({ product_id: pid, mall, title: 'p' + i, price: base + 9000, link: '', vendor_item_id: vid, item_id: '',
      recorded_at: new Date(dayStart - 3 * DAY + 3600000).toISOString(), recorded_date: '' });
    rows.push({ product_id: pid, mall, title: 'p' + i, price: prevLatest, link: '', vendor_item_id: vid, item_id: '',
      recorded_at: new Date(dayStart - 1 * DAY + 3600000 + i).toISOString(), recorded_date: '' });
    rows.push({ product_id: pid, mall, title: 'p' + i, price: i % 3 === 0 ? Math.round(prevLatest * 0.9) : prevLatest,
      recorded_at: new Date(dayStart + 3600000 + i).toISOString(), recorded_date: '', link: '', vendor_item_id: vid, item_id: '' });
    for (let d = 2; d < 2 + extra; d++) {
      rows.push({ product_id: pid, mall, title: 'p' + i, price: base + d * 100, link: '', vendor_item_id: vid, item_id: '',
        recorded_at: new Date(dayStart - d * DAY + 7200000).toISOString(), recorded_date: '' });
    }
    truth.set(`${pid}|${mall}`, prevLatest);
  }
  db.price_history = rows; db.hotdeals = []; db.products = [];
  return truth;
}

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); }
}
function section(t) { console.log(`\n[${t}]`); }
function setCtl(o) {
  ctl.latency = o.latency || (() => 0); ctl.fail = o.fail || (() => false);
  ctl.rpc = o.rpc || 'missing'; ctl.rowCap = o.rowCap || 1000;
  if (H._resetPriorRpc) H._resetPriorRpc();
}
async function run(limit, opts) {
  resetMeter();
  const t = Date.now();
  let r, err = null;
  try { r = await H.loadTodayDrops(limit, opts); } catch (e) { err = e; }
  return { r, err, ms: Date.now() - t, q: Object.assign({}, meter.queries), peak: meter.peak, priorPeak: meter.priorPeak, aborted: meter.abortedSignals };
}
/** 나온 카드의 직전 가격이 전부 진짜 직전 관측과 같은가 (fail-closed 의 증거). */
function noFalseDrop(r, truth) {
  return (r.items || []).every(c => truth.get(`${c.productId}|${c.mall}`) === c.previousPrice);
}

(async () => {
  if (MEASURE) {
    /* 수정 전후 비교 지표 — 시험이 아니다 */
    const out = {};
    for (const [label, n, o] of [
      ['ids4136_fast', 4136, {}],
      ['ids12000_fast', 12000, {}],
      ['ids4136_prior1s', 4136, { latency: k => (k === 'prior' || k === 'rpc') ? 1000 : 0 }],
      ['ids4136_today6s_prior5s', 4136, { latency: k => k === 'today' ? 6000 : (k === 'prior' || k === 'rpc') ? 5000 : 0 }],
      ['ids4136_rpc_prior1s', 4136, { rpc: 'present', latency: k => k === 'rpc' ? 1000 : 0 }],
      ['ids12000_rpc_fast', 12000, { rpc: 'present' }]
    ]) {
      build(n); setCtl(o);
      const m = await run(60);
      out[label] = { ms: m.ms, priorQueries: m.q.prior + m.q.rpc, peak: m.peak, abortedSignals: m.aborted, cards: m.r ? m.r.items.length : null, err: m.err && m.err.message };
    }
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  section('① 질의 수 — 폴백(조각)과 RPC');
  let truth = build(4136); setCtl({});
  let m = await run(60);
  ok(!m.err && m.r.stats.priorVia === 'chunks', '폴백 경로(RPC 없음)', m.r && m.r.stats.priorVia);
  ok(m.q.prior <= 60, `★ 4,136 id → 직전 관측 질의 ${m.q.prior}회 (수정 전 79)`, m.q.prior);
  ok(m.r.stats.priorChunksDone === m.r.stats.priorChunks, '조각 전부 완료', [m.r.stats.priorChunksDone, m.r.stats.priorChunks]);
  ok(noFalseDrop(m.r, truth), '카드의 직전 가격 = 진짜 직전 관측');
  const fallbackCards = m.r.items.map(c => c.productId).join(',');
  setCtl({ rpc: 'present' });
  m = await run(60);
  ok(m.r.stats.priorVia === 'rpc' && m.q.rpc === Math.ceil(4136 / 500), `★ RPC: 4,136 id → ${m.q.rpc}회`, m.q.rpc);
  ok(m.r.items.map(c => c.productId).join(',') === fallbackCards, 'RPC 와 폴백이 같은 카드를 만든다');
  truth = build(12000); setCtl({});
  m = await run(60);
  ok(m.q.prior <= 170, `★ 12,000 id → 폴백 ${m.q.prior}회 (수정 전 214)`, m.q.prior);
  ok(noFalseDrop(m.r, truth), '12,000 id 에서도 틀린 하락 없음');
  setCtl({ rpc: 'present' });
  m = await run(60);
  ok(m.q.rpc === Math.ceil(12000 / 500), `★ 12,000 id → RPC ${m.q.rpc}회`, m.q.rpc);

  section('② 동시 요청 상한');
  truth = build(4136); setCtl({ latency: k => k === 'prior' ? 30 : 0 });
  m = await run(60);
  ok(m.priorPeak <= H.PRIOR_CONCURRENCY, `★ 폴백 직전 관측 동시 ${m.priorPeak} ≤ ${H.PRIOR_CONCURRENCY} (수정 전 24)`, m.priorPeak);
  ok(m.peak <= H.PRIOR_CONCURRENCY + 1, `전체 동시 ${m.peak} ≤ ${H.PRIOR_CONCURRENCY + 1} (직전 관측 + 검증 행 1)`, m.peak);
  setCtl({ rpc: 'present', latency: k => k === 'rpc' ? 30 : 0 });
  m = await run(60);
  ok(m.priorPeak <= H.PRIOR_RPC_CONCURRENCY, `RPC 동시 ${m.priorPeak} ≤ ${H.PRIOR_RPC_CONCURRENCY}`, m.priorPeak);

  section('③④ 느림 — 요청 전체 상한 안에서 답하고, 진행 중 요청은 취소한다');
  truth = build(4136); setCtl({ latency: k => k === 'prior' ? 1000 : 0 });
  m = await run(60, { totalBudgetMs: 2500, reserveMs: 300 });
  ok(!m.err && m.ms < 2500 + 300, `★ prior 1초 지연 · 상한 2.5초 → ${m.ms}ms`, m.ms);
  ok(m.r.partial === true && m.r.stats.priorTimedOut, '부분 결과로 표시된다 (캐시 짧게)', m.r.stats.priorTimedOut);
  ok(m.aborted > 0 && m.r.stats.priorAborted > 0, `★ 상한에서 진행 중 요청 ${m.aborted}개 취소`, m.aborted);
  ok(noFalseDrop(m.r, truth), '★ 못 읽은 계열은 빠질 뿐 틀린 하락이 없다');
  setCtl({ latency: k => k === 'today' ? 6000 : k === 'prior' ? 5000 : 0 });
  m = await run(60, { totalBudgetMs: 3000, todayBudgetMs: 1500, reserveMs: 300 });
  ok(!m.err && m.ms < 3000 + 300, `★ today 6초 + prior 5초 · 상한 3초 → ${m.ms}ms (수정 전 약 10.5초)`, m.ms);
  ok(m.r.stats.todayPartial === true && m.r.items.length === 0, '오늘치를 못 읽으면 카드 0 — 지어내지 않는다', m.r.items.length);
  setCtl({ latency: k => k === 'today' ? 6000 : k === 'prior' ? 5000 : 0 });
  m = await run(60);
  ok(!m.err && m.ms < H.DROP_TOTAL_BUDGET_MS + 300, `★ 기본 상한(${H.DROP_TOTAL_BUDGET_MS}ms)에서 같은 지연 → ${m.ms}ms`, m.ms);

  section('⑤ 오류 — 조각 일부 실패');
  truth = build(4136); setCtl({ fail: (k, n) => k === 'prior' && n % 2 === 0 });
  m = await run(60);
  ok(!m.err && m.r.stats.priorErrors > 0, `조각 ${m.r.stats.priorErrors}개 실패해도 200 목록`, m.r.stats.priorErrors);
  ok(m.r.items.length > 0 && noFalseDrop(m.r, truth), '★ 성공한 조각의 카드만, 직전 가격은 전부 진짜');
  ok(m.r.partial === true, '부분 결과로 표시된다');

  section('⑤ 상한 — 한 조각이 1,000행에 닿아도 최신 관측은 남는다');
  truth = build(4136, { priorDays: 6, coupangOnly: true }); setCtl({});   // 쿠팡 200 id × 8행 = 1,600행 → 1,000행 상한
  m = await run(60);
  ok(m.r.stats.priorCapped > 0, `상한에 닿은 조각 ${m.r.stats.priorCapped}개`, m.r.stats.priorCapped);
  ok(noFalseDrop(m.r, truth), '★ 잘린 쪽은 오래된 행 — 카드의 직전 가격은 전부 진짜');

  console.log(`\n${'='.repeat(58)}`);
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail) { console.log('\n실패한 항목:'); failures.forEach(f => console.log(`  · ${f}`)); process.exit(1); }
  console.log('오늘의 하락 상한 계약 이상 없음.');
})().catch(e => { console.error(e); process.exit(1); });
