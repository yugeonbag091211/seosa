#!/usr/bin/env node
/*
 * Neon 공용망 전송량 가드 (2026-11-14) — 외부 호출 0회 · 운영 DB 접근 0회.
 *
 *   node scripts/test-neon-transfer-guards.js
 *
 * ── 왜 이 파일이 있는가 ─────────────────────────────────────────────
 *
 * 2026-11-14 운영 실측: Neon 무료 플랜 전송량이 5.12GB(한도 5GiB 근접)였다. 소진되면 컴퓨트가
 * 다음 결제 주기까지 정지된다(Neon 공식 문서). 원인으로 확인한 두 가지를 여기서 고정한다.
 *
 *   A. 수집기 — price_job_state.last_result 가 1.69MB 인데, 할 일이 없는 실행(잠금 충돌 ·
 *      오늘 완료 · 하루 예산 소진)까지 실행마다 그걸 통째로 읽었다(하루 ≈90회).
 *      → 그런 실행은 상태 «요약» 몇 바이트만 읽고 끝나야 한다. 쓰기도 없어야 한다.
 *   B. 점심·저녁 재확인 — 같은 이유. 잠금 충돌 · 처리된 슬롯 · 창 밖 감시는 요약만 읽는다.
 *      판정 문장·상태는 예전 분기와 같아야 한다.
 *   C. 홈 핫딜(today-drop) — 운영은 canonical 읽기라 no-store 였고, 방문마다 원장
 *      16,000행(title·link 포함 ≈7MB JSON)을 읽었다. → 판정 스캔은 title·link 없이,
 *      카드에 실릴 것만 보강, 같은 인스턴스의 짧은 메모. 카드는 예전과 같아야 한다.
 *   D. Neon 어댑터 — 상태 요약의 JSON 경로가 서버 SQL 로 옮겨지는지(전체 열을 읽지 않는지).
 */
'use strict';

const path = require('path');
const Module = require('module');

/* ── 환경: 수집기 모듈은 require 시점에 env 를 읽는다 ── */
process.env.COUPANG_ACCESS_KEY = 'test-access';
process.env.COUPANG_SECRET_KEY = 'test-secret';
process.env.ADPICK_API_KEY = 'test-adpick';
process.env.COUPANG_DAY_BUDGET = '100';
process.env.ADPICK_DAY_BUDGET = '50';
delete process.env.PRICE_SEED_ONLY;
delete process.env.HOME_DROP_MEMO_MS;
global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail).slice(0, 300)}`); }
}
function section(t) { console.log(`\n[${t}]`); }

/* ══════════════════════════════════════════════════════════════════
 *  가짜 DB — 테이블별 행 + PostgREST 빌더 모양. select 한 열만 돌려준다
 *  (코드가 읽지 않은 열에 기대는 일을 잡는다). 모든 질의를 calls 에 남긴다.
 * ════════════════════════════════════════════════════════════════ */
const db = { price_job_state: [], price_history: [], products: [], hotdeals: [], coupang_api_calls: [], adpick_api_calls: [] };
const calls = [];
let jobStateFullError = null;   // 전체 상태 읽기를 «여기서 멈춤» 으로 만든다

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
// 'alias:col->a->>b' 같은 PostgREST 열 식을 행에서 읽는다.
function projectRow(row, cols) {
  if (!cols || cols === '*') return Object.assign({}, row);
  const out = {};
  for (const raw of String(cols).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(?:([A-Za-z_][A-Za-z0-9_]*):)?(.+)$/.exec(raw);
    const expr = m[2];
    if (!expr.includes('->')) { if (Object.prototype.hasOwnProperty.call(row, expr)) out[m[1] || expr] = row[expr]; continue; }
    const parts = expr.split(/->>?/);
    let v = row[parts[0]];
    for (const k of parts.slice(1)) v = v && typeof v === 'object' ? v[k] : undefined;
    const name = m[1] || parts[parts.length - 1];
    out[name] = v === undefined ? null : (expr.includes('->>') && v != null && typeof v === 'object' ? JSON.stringify(v) : v);
  }
  return out;
}
function bytesOf(data) { try { return Buffer.byteLength(JSON.stringify(data)); } catch (_) { return 0; } }

function from(table) {
  const q = { table, op: 'select', cols: '*', opts: null, filters: [], orders: [], rangeFrom: null, rangeTo: null, limitN: null, single: false };
  const b = {
    select(cols, opts) { if (q.op === 'select') { q.cols = cols || '*'; q.opts = opts || null; } else q.returning = cols; return b; },
    eq(c, v) { q.filters.push(r => String(projectRow(r, c)[Object.keys(projectRow(r, c))[0]]) === String(v)); q.eqs = (q.eqs || []).concat([[c, v]]); return b; },
    is(c, v) { q.filters.push(r => (v === null ? r[c] == null : r[c] === v)); return b; },
    in(c, vs) { const set = new Set((vs || []).map(String)); q.filters.push(r => set.has(String(r[c]))); return b; },
    gte(c, v) { q.filters.push(r => cmp(r[c], v) >= 0); return b; },
    lt(c, v) { q.filters.push(r => cmp(r[c], v) < 0); return b; },
    neq(c, v) { q.filters.push(r => String(r[c]) !== String(v)); return b; },
    // hotdeals 검증 행의 만료 조건 — 이 테스트의 hotdeals 는 비어 있어 거르지 않아도 같다.
    or() { return b; },
    order(c, o) { q.orders.push({ c, asc: !o || o.ascending !== false }); return b; },
    range(a, z) { q.rangeFrom = a; q.rangeTo = z; return b; },
    limit(n) { q.limitN = n; return b; },
    abortSignal() { return b; },
    maybeSingle() { q.single = true; return b; },
    update(p) { q.op = 'update'; q.payload = p; return b; },
    upsert(p) { q.op = 'upsert'; q.payload = p; return b; },
    delete() { q.op = 'delete'; return b; },
    then(resolve, reject) {
      calls.push(q);
      return Promise.resolve().then(() => respond(q)).then(resolve, reject);
    }
  };
  return b;
}
function respond(q) {
  let rows = (db[q.table] || []).filter(r => q.filters.every(f => f(r)));
  if (q.op === 'update') {
    rows.forEach(r => Object.assign(r, q.payload));
    return { data: q.returning ? rows.map(r => projectRow(r, q.returning)) : null, error: null, count: null };
  }
  if (q.op !== 'select') return { data: null, error: null, count: null };
  if (q.table === 'price_job_state' && jobStateFullError && /\blast_result\b(?!->)/.test(String(q.cols))) {
    return { data: null, error: jobStateFullError, count: null };
  }
  if (q.opts && q.opts.head) return { data: null, error: null, count: rows.length };
  if (q.orders.length) rows = rows.slice().sort((a, z) => { for (const o of q.orders) { const d = (o.asc ? 1 : -1) * cmp(a[o.c], z[o.c]); if (d) return d; } return 0; });
  if (q.rangeFrom != null) rows = rows.slice(q.rangeFrom, q.rangeTo + 1);
  if (q.limitN != null) rows = rows.slice(0, q.limitN);
  rows = rows.slice(0, 1000).map(r => projectRow(r, q.cols));
  const data = q.single ? (rows[0] || null) : rows;
  q.bytes = bytesOf(data);
  return { data, error: null, count: null };
}
/* 직전 관측 RPC — 계열(product_id, mall, vendor_item_id)당 가장 최근 한 행. select 로 열을 고를 수 있다. */
function rpc(name, args) {
  const q = { table: 'rpc:' + name, op: 'rpc', cols: '*', args };
  const run = () => {
    calls.push(q);
    if (name !== 'price_history_prior_obs') return Promise.resolve({ data: null, error: null });
    const ids = new Set((args.p_ids || []).map(String));
    const best = new Map();
    db.price_history.forEach(r => {
      if (!ids.has(String(r.product_id)) || !(r.recorded_at < args.p_before) || !(r.recorded_at >= args.p_since)) return;
      const k = `${r.product_id}|${r.mall}|${r.vendor_item_id}`;
      const cur = best.get(k);
      if (!cur || r.recorded_at > cur.recorded_at) best.set(k, r);
    });
    const data = [...best.values()].map(r => projectRow(r, q.cols));
    q.bytes = bytesOf(data);
    return Promise.resolve({ data, error: null });
  };
  const b = {
    select(cols) { q.cols = cols || '*'; return b; },
    abortSignal() { return run(); },
    then(res, rej) { return run().then(res, rej); }
  };
  return b;
}
const fakeSupabase = { from, rpc };

function inject(rel, ex) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p; require.cache[p].loaded = true; require.cache[p].exports = ex;
}
inject('api/_supabase.js', fakeSupabase);
inject('api/_notify.js', { send: () => Promise.resolve({ ok: true }) });

const C = require('./collect-all-prices');
const V = require('./collect-volatile-prices');
const PV = require('./_price-volatility');
const H = require('../api/hotdeals.js')._internal;
const TD = require('../api/_todaydrop');
const { kstToday, kstDayStartUtc } = require('../api/_price');
const neon = require('../api/_neonpg');

const TODAY = kstToday();
const iso = ms => new Date(ms).toISOString();
const jobSelects = () => calls.filter(q => q.table === 'price_job_state' && q.op === 'select');
const fullJobReads = () => jobSelects().filter(q => /\blast_result\b(?!->)/.test(String(q.cols)));
const jobWrites = () => calls.filter(q => q.table === 'price_job_state' && q.op !== 'select');

/* 운영과 같은 모양의 큰 상태 — ADPICK 64자 키 13,000개 ≈ 1MB */
function bigLastResult(extra) {
  const keys = Array.from({ length: 13000 }, (_, i) => i.toString(16).padStart(64, 'a') + '|ADPICK');
  return Object.assign({
    targetSignature: C.targetSignatureFor(C.collectorTargetMeta(TODAY)),
    malls: {
      '쿠팡': { status: 'running', collectorCovered: ['1|쿠팡'], collectorAttempted: ['1|쿠팡'] },
      ADPICK: { status: 'running', collectorCovered: keys.slice(0, 5000), collectorAttempted: keys }
    }
  }, extra || {});
}
function setJobState(row) { db.price_job_state = [Object.assign({ id: 1, job_date: TODAY, status: 'running', cursor_key: '', processed: 0, total: 0, last_run_at: iso(Date.now() - 3600000) }, row)]; }
function setUsage(coupang, adpick) {
  db.coupang_api_calls = Array.from({ length: coupang }, (_, i) => ({ id: i, called_at: iso(Date.now() - 60000), source: 'collect' }));
  db.adpick_api_calls = Array.from({ length: adpick }, (_, i) => ({ id: i, kst_date: TODAY, source: 'collect', external_call: true }));
}

(async () => {
  console.log('=== Neon 전송량 가드 (2026-11-14) ===');

  /* ════════════════ A. 수집기 ════════════════ */
  section('A-1) 잠금 판정 문장 · 상태 요약 열');
  const now = Date.now();
  ok(C.lockHeldReason({ runId: 'r1', until: iso(now + 30 * 60000) }, now).startsWith('다른 실행이 진행 중입니다 (r1, 만료까지 30분)'),
    '살아 있는 잠금 → acquireLock 과 같은 문장');
  ok(C.lockHeldReason({ runId: 'r1', until: iso(now - 1000) }, now) === '', '만료된 잠금 → 이유 없음(회수는 예전 경로가 한다)');
  ok(C.lockHeldReason(null, now) === '' && C.lockHeldReason({ until: 'garbage' }, now) === '', '잠금 없음 · 깨진 값 → 이유 없음');
  ok(!/\blast_result\b(?!->)/.test(C.STATE_HEAD_COLS), '★ 상태 요약은 last_result 를 통째로 고르지 않는다', C.STATE_HEAD_COLS);
  ok(/last_result->malls->ADPICK->>status/.test(C.STATE_HEAD_COLS) && /lock:last_result->lock/.test(C.STATE_HEAD_COLS),
    '상태 요약은 잠금 · ADPICK 상태 · 대상 서명 · 재확인 원장만 JSON 경로로 고른다');

  section('A-2) idleRunReason — run()/runLocked 의 기존 조기 종료와 같은 조건만');
  const meta = C.collectorTargetMeta(TODAY);
  const sig = C.targetSignatureFor(meta);
  const base = { job_date: TODAY, status: 'completed', adpickStatus: 'completed', targetSignature: sig, lock: null };
  const idle = h => C.idleRunReason(h, { today: TODAY, nowMs: now, targetMeta: meta });
  ok(idle(base) && idle(base).kind === 'done', '오늘 · 두 몰 완료 · 같은 대상 서명 → done');
  ok(idle({ ...base, targetSignature: meta.signature }) && idle({ ...base, targetSignature: meta.signature }).kind === (C.V3_PLANNER ? 'done' : 'done'),
    'V3 는 레거시 서명 상태도 이어받는다(resumeCompatible) → done');
  ok(idle({ ...base, adpickStatus: 'running' }) === null, 'ADPICK 이 아직 → 판정하지 않음(전체 경로)');
  ok(idle({ ...base, status: 'running' }) === null, '쿠팡이 아직 → 판정하지 않음');
  ok(idle({ ...base, job_date: '2000-01-01' }) === null, '다른 날 상태 → 판정하지 않음(새 날 시작은 전체 경로)');
  ok(idle({ ...base, targetSignature: 'other-v9:' + TODAY }) === null, '대상 서명이 다르면(정책 변경·V3→레거시) 판정하지 않음');
  ok(idle({ ...base, status: 'running', lock: { runId: 'x', until: iso(now + 60000) } }).kind === 'locked', '살아 있는 잠금 → locked');
  ok(idle(null) === null && idle('x') === null, '요약을 못 읽었으면 판정하지 않음');

  section('A-3) ★ run() — 할 일 없는 실행은 큰 상태를 읽지도 쓰지도 않는다');
  // (1) 다른 실행이 잠금을 쥠
  setJobState({ last_result: bigLastResult({ lock: { runId: 'other', at: iso(now), until: iso(now + 40 * 60000) } }) });
  setUsage(0, 0); calls.length = 0;
  await C.run();
  ok(fullJobReads().length === 0 && jobWrites().length === 0, '★ 잠금 충돌 실행: 전체 상태 읽기 0 · 쓰기 0',
    jobSelects().map(q => q.cols));
  ok(jobSelects().length === 1 && jobSelects()[0].bytes < 2000, `  요약 한 번만 (${jobSelects()[0] && jobSelects()[0].bytes}B — 예전 ${bytesOf(db.price_job_state[0].last_result)}B×1)`);
  // (2) 오늘 두 몰 완료
  setJobState({ status: 'completed', last_result: bigLastResult({ malls: { '쿠팡': { status: 'completed' }, ADPICK: { status: 'completed', collectorAttempted: bigLastResult().malls.ADPICK.collectorAttempted } } }) });
  calls.length = 0;
  await C.run();
  ok(fullJobReads().length === 0 && jobWrites().length === 0, '★ 오늘 완료 실행: 전체 상태 읽기 0 · 쓰기 0(잠금도 안 잡는다)', jobSelects().map(q => q.cols));
  // (3) 두 제공자 하루 예산 소진
  setJobState({ last_result: bigLastResult() });
  setUsage(100, 50); calls.length = 0;
  await C.run();
  ok(fullJobReads().length === 0 && jobWrites().length === 0, '★ 예산 소진 실행: 전체 상태 읽기 0 · 쓰기 0', calls.map(q => q.table + ':' + q.op));
  ok(calls.filter(q => q.opts && q.opts.head).length === 2, '  사용량은 count 두 번(쿠팡 · ADPICK)');
  // (4) 할 일이 있으면 예전처럼 전체 상태를 읽는다 (여기서는 그 읽기에서 멈춘다)
  setUsage(10, 0); calls.length = 0;
  jobStateFullError = { message: 'stop-here (test)', code: 'XX000' };
  let threw = null;
  try { await C.run(); } catch (e) { threw = e; }
  jobStateFullError = null;
  ok(threw && /price_job_state 를 읽지 못했습니다/.test(threw.message) && fullJobReads().length === 1,
    '★ 할 일이 남은 실행은 예전 전체 경로(loadState)로 간다', threw && threw.message);
  // (5) 요약 읽기가 실패하면 판정하지 않고 전체 경로 — 오류 분류·재시도는 예전 그대로
  const realFrom = fakeSupabase.from;
  let headFailed = 0;
  fakeSupabase.from = t => { const b = realFrom(t); const sel = b.select; b.select = (c, o) => { if (t === 'price_job_state' && c === C.STATE_HEAD_COLS) { headFailed++; throw new Error('boom'); } return sel(c, o); }; return b; };
  ok(await C.loadStateHead() === null && headFailed === 1, '요약 읽기 예외 → null (호출부가 전체 경로로 간다)');
  fakeSupabase.from = realFrom;

  /* ════════════════ B. 점심·저녁 재확인 ════════════════ */
  section('B) volatileFastPath — 예전 분기와 같은 상태·문장, 쓰기가 필요하면 null');
  const kst = (day, hh, mm) => new Date(Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:00+09:00`));
  const day = '2026-11-14', yday = '2026-11-13';
  const served = { status: 'COMPLETED', at: '2026-11-14T03:10:00.000Z', attempts: 1 };
  const fullLedger = { [yday]: { noon: served, evening: served }, [day]: { noon: served } };
  const fp = (now_, wanted, head) => V.volatileFastPath({ now: now_, plan: PV.slotPlan(now_, wanted || ''), wantedSlot: wanted || '', head });
  const t13 = kst(day, 13, 0), t16 = kst(day, 16, 0);
  let r = fp(t13, '', { lock: { runId: 'main', until: iso(t13.getTime() + 20 * 60000) }, volatileSlots: {} });
  ok(r && r.status === PV.STATUS.LOCKED && /^기존 정기 수집과 잠금 충돌: 다른 실행이 진행 중입니다/.test(r.reason), '잠금 충돌 → LOCKED (예전 문장)', r);
  r = fp(t13, '', { lock: null, volatileSlots: fullLedger });
  ok(r && r.status === PV.STATUS.SKIPPED && /슬롯은 이미 처리됨\(COMPLETED/.test(r.reason), '창 안 · 이미 처리 → SKIPPED (중복 수집 없음)', r);
  ok(fp(t13, '', { lock: null, volatileSlots: { [yday]: fullLedger[yday] } }) === null, '창 안 · 아직 안 함 → null (슬롯을 맡는다 = 예전 경로)');
  r = fp(t16, '', { lock: null, volatileSlots: fullLedger });
  ok(r && r.status === PV.STATUS.SKIPPED && /창 밖/.test(r.reason), '창 밖 · 놓친 슬롯 없음 → SKIPPED (감시 실행)', r);
  ok(fp(t16, '', { lock: null, volatileSlots: {} }) === null, '★ 창 밖 · 놓친 슬롯 있음 → null (MISSED 표시는 쓰기라 예전 경로)');
  r = fp(t16, 'noon', { lock: null, volatileSlots: fullLedger });
  ok(r && r.status === PV.STATUS.MISSED && /창 밖입니다/.test(r.reason), '지시받은 슬롯 창이 닫힘 → MISSED (예전 문장)', r);
  r = fp(t16, 'evening', { lock: null, volatileSlots: fullLedger });
  ok(r && r.status === PV.STATUS.SKIPPED && /아직 열리지 않았습니다/.test(r.reason), '지시받은 슬롯 창이 아직 → SKIPPED', r);
  ok(fp(t13, '', null) === null, '요약이 없으면 판정하지 않음');

  /* ════════════════ C. 홈 핫딜 ════════════════ */
  section('C-1) 판정 스캔 열');
  ok(!/\btitle\b|\blink\b|recorded_date/.test(H.LEDGER_SCAN_COLS), '★ 판정 스캔은 title · link · recorded_date 를 읽지 않는다', H.LEDGER_SCAN_COLS);
  ok(['id', 'product_id', 'mall', 'price', 'recorded_at', 'vendor_item_id', 'item_id'].every(c => H.LEDGER_SCAN_COLS.split(/,\s*/).includes(c)),
    '판정에 쓰는 열(옵션 열 포함)은 다 있다');
  ok(H.needsLinkForOption({ vendor_item_id: '', item_id: '' }) && H.needsLinkForOption({ vendor_item_id: '__LEGACY__', item_id: null })
    && !H.needsLinkForOption({ vendor_item_id: 'v1' }) && !H.needsLinkForOption({ item_id: 'i1' }),
    '옵션 열이 둘 다 빈 행만 link 가 필요하다 (_todaydrop.optionIdOf 와 같은 규칙)');

  section('C-2) ★ 같은 원장 → 같은 카드, 더 적은 바이트');
  const dayStart = kstDayStartUtc(TODAY);
  const at = (dayOffset, minute) => iso(Date.parse(dayStart) + dayOffset * 86400000 + minute * 60000);
  db.price_history = []; db.products = []; db.hotdeals = [];
  let id = 1;
  for (let i = 0; i < 300; i++) {
    const coupang = i % 3 !== 0;
    const pid = coupang ? String(8000000000 + i) : (i.toString(16).padStart(64, 'b'));
    const mall = coupang ? '쿠팡' : 'ADPICK';
    const link = coupang ? `https://link.coupang.com/re/AFFSDP?lptag=AF0000000&pageKey=${pid}&itemId=${9000 + i}&vendorItemId=${7000 + i}&traceid=${'x'.repeat(120)}` : `https://adpick.co.kr/?ac=${i}`;
    const title = `테스트 상품 ${i} 무선 블루투스 이어폰 노이즈캔슬링 화이트 정품 ${'가'.repeat(20)}`;
    const opt = coupang ? { vendor_item_id: String(7000 + i), item_id: String(9000 + i) } : { vendor_item_id: '', item_id: 'a' + i };
    db.price_history.push({ id: id++, product_id: pid, mall, title, price: 20000 + i * 10, link, recorded_at: at(-2, 60 + i), recorded_date: '', ...opt, source: 'collect' });
    db.price_history.push({ id: id++, product_id: pid, mall, title, price: (i % 2 ? 15000 : 26000) + i * 10, link, recorded_at: at(0, 30 + i), recorded_date: '', ...opt, source: 'collect' });
    db.products.push({ product_id: pid, mall, title: '카탈로그 ' + title, image: 'https://img/' + i, link, mall_label: '', collected_at: at(0, 1) });
  }
  // 옵션 열이 빈 행 하나 — link 의 vendorItemId 가 옵션 키다
  db.price_history.push({ id: id++, product_id: 'LX1', mall: '쿠팡', title: '옵션 열 빈 행', price: 50000, link: 'https://link.coupang.com/a?vendorItemId=555&itemId=444', recorded_at: at(-1, 10), recorded_date: '', vendor_item_id: '', item_id: '', source: 'collect' });
  db.price_history.push({ id: id++, product_id: 'LX1', mall: '쿠팡', title: '옵션 열 빈 행', price: 30000, link: 'https://link.coupang.com/a?vendorItemId=555&itemId=444', recorded_at: at(0, 10), recorded_date: '', vendor_item_id: '', item_id: '', source: 'collect' });

  // 예전 동작의 기준 카드: 같은 원장을 title·link 포함 전 열로 판정
  const todayAll = db.price_history.filter(rw => rw.recorded_at >= dayStart);
  const wantedKeys = new Set(todayAll.map(TD.seriesKeyOf));
  const priorAll = db.price_history.filter(rw => rw.recorded_at < dayStart);
  const priorPicked = Array.from(H.pickPriorRows(priorAll, wantedKeys).values());
  const expected = TD.buildDrops(todayAll.concat(priorPicked), { today: TODAY }).items;

  H._resetDropsMemo(); calls.length = 0;
  const got = await H.loadTodayDrops(60);
  const scanBytes = calls.filter(q => q.table === 'price_history' || q.table === 'rpc:price_history_prior_obs').reduce((s, q) => s + (q.bytes || 0), 0);
  const fullBytes = bytesOf(todayAll.map(rw => projectRow(rw, H.LEDGER_COLS))) + bytesOf(priorPicked);
  ok(got.items.length === Math.min(60, expected.length) && got.items.length > 0, `카드 수가 같다 (${got.items.length})`);
  ok(got.items.every((it, i) => it.productId === expected[i].productId && it.currentPrice === expected[i].currentPrice
      && it.previousPrice === expected[i].previousPrice && it.vendorItemId === expected[i].vendorItemId),
    '★ 카드 순서 · 현재가 · 직전가 · 옵션이 전 열 판정과 같다');
  const lx = got.items.find(it => it.productId === 'LX1');
  ok(lx && lx.vendorItemId === '555' && got.stats.optionLinkRows === 2, '옵션 열 빈 행은 link 를 id 로 다시 읽어 같은 옵션 키를 만든다', got.stats);
  const firstExpected = expected[0];
  ok(got.items[0].title === firstExpected.title, '카드 title 은 원장 문구(todayPoint) 그대로 — 카드만 따로 읽는다', [got.items[0].title, firstExpected.title]);
  ok(got.stats.cardTextRows > 0 && got.stats.cardTextRows <= 60, `카드 문구 조회는 카드 수 이하 (${got.stats.cardTextRows})`);
  ok(scanBytes < fullBytes * 0.6, `★ 원장에서 받은 바이트가 예전(전 열)보다 40% 이상 적다: ${scanBytes}B vs ${fullBytes}B`);

  section('C-3) 인스턴스 메모 — 두 번째 방문은 원장을 다시 읽지 않는다');
  H._resetDropsMemo(); calls.length = 0;
  const m1 = await H.loadTodayDropsMemo(60);
  const after1 = calls.length;
  const m2 = await H.loadTodayDropsMemo(60);
  ok(after1 > 0 && calls.length === after1, `★ 메모 적중: 두 번째 호출은 질의 0회 (첫 호출 ${after1}회)`);
  ok(m1.stats.memo === 'miss' && m2.stats.memo === 'hit', '응답 stats 에 memo 적중 여부가 남는다');
  m2.items[0].title = '변조'; m2.items.length = 0;
  const m3 = await H.loadTodayDropsMemo(60);
  ok(m3.items.length === m1.items.length && m3.items[0].title !== '변조', '호출부가 결과를 바꿔도 메모는 오염되지 않는다(canonical 묶기가 items 를 바꾼다)');
  // 단독 한 번의 질의 수(오늘치는 여러 장을 동시에 던진다)를 재고, 동시 두 요청이 그 수를 넘지 않는지 본다.
  H._resetDropsMemo(); calls.length = 0;
  await H.loadTodayDropsMemo(30);
  const solo = calls.length;
  H._resetDropsMemo(); calls.length = 0;
  const [s1, s2] = await Promise.all([H.loadTodayDropsMemo(30), H.loadTodayDropsMemo(30)]);
  ok(s1.items.length === s2.items.length && calls.length === solo && [s1.stats.memo, s2.stats.memo].sort().join() === 'miss,shared',
    `★ 동시에 온 두 요청은 원장 스캔 한 번을 같이 기다린다 (질의 ${calls.length}회 = 단독 ${solo}회)`);
  ok(H.DROPS_MEMO_MS > 0 && H.DROPS_MEMO_MS <= 120000, `메모 기본 ${H.DROPS_MEMO_MS}ms — 예전 CDN 캐시(120초)보다 길지 않다`);

  /* ════════════════ D. Neon 어댑터 ════════════════ */
  section('D) 상태 요약 JSON 경로가 서버 SQL 로 간다');
  const seen = [];
  const client = neon.createClient({ query: async (text, values) => { seen.push(text); return { rows: [{}], rowCount: 1, fields: [] }; },
    meta: { tables: { price_job_state: { columns: ['id', 'job_date', 'status', 'last_run_at', 'last_result'], primaryKey: ['id'] } }, functions: {} } });
  await client.from('price_job_state').select(C.STATE_HEAD_COLS).eq('id', 1).maybeSingle();
  const sql = seen[0] || '';
  ok(/"last_result"->'malls'->'ADPICK'->>'status' AS "adpickStatus"/.test(sql) && /"last_result"->'lock' AS "lock"/.test(sql), '★ JSON 경로는 서버에서 잘린다', sql);
  ok(!/"last_result"\s*(,|FROM)/.test(sql), '★ last_result 전체 열은 SELECT 목록에 없다', sql);

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
