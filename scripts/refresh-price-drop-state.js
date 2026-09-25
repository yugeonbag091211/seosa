#!/usr/bin/env node
/*
 * 가격 하락 상태표(price_drop_state) 갱신 — .github/workflows/price-drop-state.yml
 *
 *   node scripts/refresh-price-drop-state.js            자동: 필요하면 원자적 재구성 → 증분 → 표본 검증
 *   node scripts/refresh-price-drop-state.js --full     원자적 전체 재구성을 강제 (일일 백스톱 · 복구)
 *   node scripts/refresh-price-drop-state.js --verify   표본 검증만 (기존 뷰를 부르지 않는다)
 *   node scripts/refresh-price-drop-state.js --status   메타만 읽는다 (쓰기 없음)
 *   node scripts/refresh-price-drop-state.js --rollback 직전 공개 세대로 즉시 되돌린다
 *   node scripts/refresh-price-drop-state.js --abort    진행 중인 재구성을 버린다 (공개 세대 유지)
 *
 * ── 무엇을 하고, 무엇을 하지 않는가 ────────────────────────────────
 *   한다      price_history 를 읽어 price_drop_state 를 다시 계산한다 (DB 함수 안에서).
 *   안 한다   가격을 수집하지 않는다. 쿠팡·ADPICK 을 부르지 않는다.
 *             price_history · products · hotdeals 에 쓰지 않는다. 기존 뷰 price_drop_top 을 부르지 않는다.
 *
 * ── 원자성 ────────────────────────────────────────────────────────
 *   재구성은 새 세대에 배치로 쓴다. 읽기는 공개 세대만 본다. 모든 배치가 끝나고 공개 게이트
 *   (행 수 · 표본 검증)를 통과했을 때만 publish 가 공개 세대 한 칸을 바꾼다. 이 스크립트가
 *   중간에 죽어도 공개 세대는 그대로이고, 다음 실행이 커서에서 이어받는다(10분 뒤 소유권 인수).
 *
 * ── 마이그레이션 전 ───────────────────────────────────────────────
 *   함수가 없으면(supabase/2026-09-25-price-drop-state.sql 미적용) 아무것도 하지 않고 exit 0.
 *   워크플로는 저장소 변수 PRICE_DROP_STATE_ENABLED=1 일 때만 돈다.
 */
'use strict';

require('./_env');
const crypto = require('crypto');
const supabase = require('../api/_supabase');
const { isMissingObject } = require('../api/_dberror');

const MAX_STEPS = 400;        // 3,000 × 400 = 120만 상품. 무한 루프 방지선.
const STEP_RETRIES = 3;
const NOT_READY = '상태표 함수가 아직 없습니다(supabase/2026-09-25-price-drop-state.sql 미적용) — 할 일이 없습니다.';

class NotReady extends Error {}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args || {});
  if (error) {
    if (isMissingObject(error)) throw new NotReady(error.message);
    const e = new Error(`${name}: ${error.message}`);
    e.code = error.code;
    throw e;
  }
  return data;
}

async function status() {
  const { data, error } = await supabase.from('price_drop_state_meta').select('*').eq('id', 1).maybeSingle();
  if (error) {
    if (isMissingObject(error)) throw new NotReady(error.message);
    throw new Error(`상태 조회 실패: ${error.message}`);
  }
  return data;
}

const transient = e => !/lost build ownership|publish refused|not finished|owner required/.test(e.message);

/**
 * 원자적 전체 재구성. 공개 전까지 사용자는 이전 세대를 본다.
 * @returns {{published?:object, busy?:boolean, gen?:number, steps:number}}
 */
async function rebuild(opts) {
  const o = opts || {};
  const owner = o.owner || `${process.env.GITHUB_RUN_ID || 'local'}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const limit = Number(o.batch) || 3000;
  const start = await rpc('price_drop_state_rebuild_start', { p_owner: owner });
  if (!start.started) return { busy: true, gen: start.gen, heartbeat: start.heartbeat, steps: 0 };
  let steps = 0;
  const total = { products: 0, upserted: 0, deleted: 0, removed: 0, maxStepMs: 0 };
  for (;;) {
    let r;
    for (let attempt = 1; ; attempt++) {
      const t = Date.now();
      try {
        r = await rpc('price_drop_state_rebuild_step', { p_gen: start.gen, p_owner: owner, p_limit: limit });
        total.maxStepMs = Math.max(total.maxStepMs, Date.now() - t);
        break;
      } catch (e) {
        // 배치는 멱등이다(원장에서 다시 계산). 일시 오류는 같은 커서로 다시 한다.
        if (!transient(e) || attempt >= STEP_RETRIES) throw e;
        await new Promise(res => setTimeout(res, 1000 * attempt));
      }
    }
    steps++;
    for (const k of ['products', 'upserted', 'deleted', 'removed']) total[k] += Number(r[k]) || 0;
    if (r.done) break;
    if (steps >= MAX_STEPS) throw new Error(`배치 ${MAX_STEPS}번을 넘었다 — 커서 ${r.cursor}`);
    if (o.onStep) await o.onStep(r, steps);
  }
  const published = await rpc('price_drop_state_publish', { p_gen: start.gen, p_owner: owner, p_min_ratio: o.minRatio == null ? 0.9 : o.minRatio });
  return { published, gen: start.gen, resumed: !!start.resumed, steps, ...total };
}

async function verify(sample) {
  return rpc('price_drop_state_verify', { p_gen: null, p_sample: sample || 100 });
}

async function auto(opts) {
  const o = opts || {};
  const log = [];
  let meta = await status();
  if (!meta) throw new NotReady('meta row missing');
  if (o.full || meta.published_gen == null || meta.needs_rebuild) {
    const why = o.full ? 'forced' : meta.published_gen == null ? 'not initialized' : meta.needs_rebuild_reason;
    const r = await rebuild(o);
    log.push({ step: 'rebuild', why, ...r, published: r.published ? { gen: r.published.gen, rows: r.published.rows, verify: r.published.verify && r.published.verify.ok } : null });
    if (r.busy) return { ok: true, busy: true, log };
  } else {
    const r = await rpc('price_drop_state_refresh_recent', { p_days: o.days || 2 });
    log.push({ step: 'recent', products: r.products, published: r.published, elapsed_ms: r.elapsed_ms, needs_rebuild: r.needs_rebuild });
    if (r.needs_rebuild) {
      const rb = await rebuild(o);
      log.push({ step: 'rebuild', why: r.needs_rebuild_reason, gen: rb.gen, busy: !!rb.busy, steps: rb.steps });
      if (rb.busy) return { ok: true, busy: true, log };
    }
  }
  let v = await verify(o.sample);
  log.push({ step: 'verify', ok: v.ok, checked: v.checked, mismatches: v.mismatches, pending: v.pending, kinds: v.kinds });
  if (!v.ok) {
    // 공개 세대가 원장과 어긋난다 → 원자적 재구성으로 복구하고 다시 검증한다.
    const rb = await rebuild(o);
    log.push({ step: 'rebuild', why: 'verify mismatch', gen: rb.gen, busy: !!rb.busy, steps: rb.steps });
    if (!rb.busy) {
      v = await verify(o.sample);
      log.push({ step: 'verify', ok: v.ok, checked: v.checked, mismatches: v.mismatches, pending: v.pending, kinds: v.kinds });
    }
  }
  return { ok: !!v.ok, log, verify: v };
}

async function main() {
  const t0 = Date.now();
  try {
    if (arg('--status', false)) {
      const m = await status();
      console.log(JSON.stringify({ msg: 'price_drop_state_status', ...m }));
      return;
    }
    if (arg('--verify', false)) {
      const v = await verify(Number(arg('--sample', 100)) || 100);
      console.log(JSON.stringify({ msg: 'price_drop_state_verify', ...v }));
      if (!v.ok) process.exitCode = 1;
      return;
    }
    if (arg('--rollback', false)) {
      console.log(JSON.stringify({ msg: 'price_drop_state_rollback', ...(await rpc('price_drop_state_rollback_publish')) }));
      return;
    }
    if (arg('--abort', false)) {
      console.log(JSON.stringify({ msg: 'price_drop_state_abort', ...(await rpc('price_drop_state_abort_build')) }));
      return;
    }
    const r = await auto({ full: !!arg('--full', false), days: Number(arg('--days', 2)) || 2,
      batch: Number(arg('--batch', 3000)) || 3000, sample: Number(arg('--sample', 100)) || 100 });
    console.log(JSON.stringify({ msg: 'price_drop_state_refresh', ok: r.ok, busy: !!r.busy, log: r.log, elapsedMs: Date.now() - t0 }));
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    if (e instanceof NotReady) { console.log(NOT_READY); return; }
    throw e;
  }
}

if (require.main === module) {
  main().catch(e => { console.error('오류:', e.message); process.exit(1); });
}

module.exports = { main, auto, rebuild, verify, status, NotReady };
