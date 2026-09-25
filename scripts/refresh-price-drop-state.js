#!/usr/bin/env node
/*
 * 가격 하락 상태표(price_drop_state) 갱신 — .github/workflows/price-drop-state.yml
 *
 *   node scripts/refresh-price-drop-state.js              증분: 최근 2일에 기록된 상품만 다시 계산
 *   node scripts/refresh-price-drop-state.js --days 3     증분 창을 넓힌다 (갱신이 며칠 밀렸을 때)
 *   node scripts/refresh-price-drop-state.js --full       전체 재구성 (초기 적재 · 복구)
 *   node scripts/refresh-price-drop-state.js --status     갱신 기록만 읽는다 (쓰기 없음)
 *
 * ── 무엇을 하고, 무엇을 하지 않는가 ────────────────────────────────
 *   한다      price_history 를 읽어 price_drop_state 를 다시 계산한다 (함수 안에서).
 *   안 한다   가격을 수집하지 않는다. 쿠팡·ADPICK 을 부르지 않는다.
 *             price_history · products · hotdeals 에 쓰지 않는다.
 *
 * ── 왜 증분과 전체가 따로 있는가 ───────────────────────────────────
 *   수집기와 /api/search 는 오늘 날짜로만 쓴다 → 증분(최근 N일에 기록이 있는 상품)이면
 *   충분하다. 오래된 날짜를 고치는 일(가져오기·정리 스크립트, 행 삭제)은 증분이
 *   볼 수 없다 → --full 이 product_id 키셋 배치로 원장 전체를 다시 계산해 따라잡는다.
 *   둘 다 «원장에서 다시 계산» 이라 멱등이다. 몇 번을 돌려도 결과가 같다.
 *
 * ── 마이그레이션 전 ───────────────────────────────────────────────
 *   함수가 없으면(supabase/2026-09-25-price-drop-state.sql 미적용) 아무것도 하지 않고
 *   exit 0 으로 끝낸다. 워크플로는 저장소 변수 PRICE_DROP_STATE_ENABLED=1 일 때만 돈다.
 */
'use strict';

require('./_env');
const supabase = require('../api/_supabase');
const { isMissingObject } = require('../api/_dberror');

const MAX_BATCHES = 200;   // 3,000 × 200 = 60만 상품. 무한 루프 방지선.

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function status() {
  const { data, error } = await supabase.from('price_drop_state_meta').select('*').eq('id', 1).maybeSingle();
  if (error) return { ok: false, error };
  const { count, error: cErr } = await supabase.from('price_drop_state').select('*', { count: 'exact', head: true });
  return { ok: !cErr, error: cErr, meta: data || null, stateRows: count };
}

async function recent(days) {
  const { data, error } = await supabase.rpc('price_drop_state_refresh_recent', { p_days: days });
  return { data, error };
}

async function full(batch) {
  let after = '';
  let batches = 0;
  const total = { products: 0, upserted: 0, deleted: 0, removed_products_rows: 0, maxBatchMs: 0 };
  for (;;) {
    const t = Date.now();
    const { data, error } = await supabase.rpc('price_drop_state_rebuild_batch', { p_after: after, p_limit: batch });
    if (error) return { error, total, batches };
    if (data && data.refreshed === false) return { error: new Error(`다른 갱신이 진행 중: ${data.skipped}`), total, batches };
    batches++;
    total.maxBatchMs = Math.max(total.maxBatchMs, Date.now() - t);
    for (const k of ['products', 'upserted', 'deleted', 'removed_products_rows']) total[k] += Number(data && data[k]) || 0;
    if (!data || !data.next_after) return { total, batches };
    if (batches >= MAX_BATCHES) return { error: new Error(`배치 ${MAX_BATCHES}번을 넘었다 — 커서 ${data.next_after}`), total, batches };
    after = data.next_after;
  }
}

async function main() {
  const t0 = Date.now();
  if (arg('--status', false)) {
    const s = await status();
    if (!s.ok && isMissingObject(s.error)) {
      console.log('상태표가 아직 없습니다(supabase/2026-09-25-price-drop-state.sql 미적용).');
      return;
    }
    if (!s.ok) throw new Error(`상태 조회 실패: ${s.error.message}`);
    console.log(JSON.stringify({ msg: 'price_drop_state_status', stateRows: s.stateRows, ...s.meta }));
    return;
  }

  if (arg('--full', false)) {
    const batch = Number(arg('--batch', 3000)) || 3000;
    const r = await full(batch);
    if (r.error && isMissingObject(r.error)) {
      console.log('상태표 함수가 아직 없습니다(supabase/2026-09-25-price-drop-state.sql 미적용) — 할 일이 없습니다.');
      return;
    }
    if (r.error) throw new Error(`전체 재구성 실패(배치 ${r.batches}개 처리 뒤): ${r.error.message}`);
    console.log(JSON.stringify({ msg: 'price_drop_state_full', batches: r.batches, ...r.total, elapsedMs: Date.now() - t0 }));
    return;
  }

  const days = Math.max(1, Math.min(Number(arg('--days', 2)) || 2, 30));
  const { data, error } = await recent(days);
  if (error && isMissingObject(error)) {
    console.log('상태표 함수가 아직 없습니다(supabase/2026-09-25-price-drop-state.sql 미적용) — 할 일이 없습니다.');
    return;
  }
  if (error) throw new Error(`증분 갱신 실패: ${error.message}`);
  console.log(JSON.stringify({ msg: 'price_drop_state_recent', days, ...data, elapsedMs: Date.now() - t0 }));
}

if (require.main === module) {
  main().catch(e => { console.error('오류:', e.message); process.exit(1); });
}

module.exports = { main, full, recent, status };
