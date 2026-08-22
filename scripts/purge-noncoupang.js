#!/usr/bin/env node
/**
 * 비쿠팡 상품 삭제.
 *
 * ★ --confirm 없이는 아무것도 지우지 않는다 (기본은 시늉만 하는 dry-run).
 *
 * 판별 기준은 api/_price.js 의 isRefreshableMall() 하나뿐이다. 여기서 따로
 * 만들지 않는다 — 코드가 "수집 가능"이라고 보는 것과 우리가 "남긴다"고 보는
 * 것이 어긋나면, 지우면 안 되는 행을 지우게 된다.
 *
 * 지우는 순서
 *   1) price_history  — 먼저 지운다. products 를 먼저 지우면 어떤 기록이
 *                       그 상품 것이었는지 알 방법이 없어져 고아만 남는다.
 *   2) products
 *
 * FK 는 없다(price_history 에 이미 고아가 7천 행 넘게 있는 것이 증거다).
 * 그래서 CASCADE 를 기대하지 않고 손으로 지운다.
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const root = path.resolve(__dirname, '..');
for (const f of ['.env.local', '.env']) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) { require('dotenv').config({ path: p }); break; }
}

const supabase = require('../api/_supabase');
const { isRefreshableMall } = require('../api/_price');

const CONFIRM   = process.argv.includes('--confirm');
const PAGE      = 1000;
const DEL_CHUNK = 200;   // 한 번에 지우는 행 수. URL 길이·타임아웃을 피한다.

async function fetchAll(table, columns) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select(columns).order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function deleteByIds(table, ids) {
  let done = 0;
  for (let i = 0; i < ids.length; i += DEL_CHUNK) {
    const chunk = ids.slice(i, i + DEL_CHUNK);
    const { error } = await supabase.from(table).delete().in('id', chunk);
    if (error) throw new Error(`${table} 삭제 실패: ${error.message}`);
    done += chunk.length;
    process.stdout.write(`\r    ${table}: ${done}/${ids.length}`);
  }
  process.stdout.write('\n');
  return done;
}

(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(` 비쿠팡 상품 삭제  ${CONFIRM ? '[실제 삭제]' : '[DRY-RUN — 지우지 않음]'}`);
  console.log('═══════════════════════════════════════════════════\n');

  const products = await fetchAll('products', 'id,product_id,title,mall,link');
  const coupang  = products.filter(p => isRefreshableMall(p.mall));
  const targets  = products.filter(p => !isRefreshableMall(p.mall));

  console.log(`[1] 대상 확정 (isRefreshableMall 기준)`);
  console.log(`    전체 ${products.length} / 쿠팡 ${coupang.length} / 삭제 대상 ${targets.length}`);

  /* ── 안전장치 ─────────────────────────────────────────────
     조건이 조금이라도 이상하면 지우지 않고 멈춘다. */
  if (coupang.length + targets.length !== products.length) {
    throw new Error('분류 합계가 전체와 다릅니다 — 중단');
  }
  if (!targets.length) {
    console.log('\n삭제할 것이 없습니다. 이미 정리된 상태입니다.');
    return;
  }
  const wrong = targets.filter(p => /coupang\.com/i.test(String(p.link || '')));
  if (wrong.length) {
    console.error(`\n중단: 삭제 대상 중 쿠팡 링크를 가진 행이 ${wrong.length}건 있습니다.`);
    wrong.slice(0, 5).forEach(p => console.error(`  id=${p.id} mall=${p.mall} ${p.link}`));
    throw new Error('쿠팡 상품일 수 있는 행이 섞여 있습니다 — 중단');
  }
  // 삭제 대상에 mall='쿠팡' 이 단 한 행도 없어야 한다 (이중 확인)
  if (targets.some(p => String(p.mall) === '쿠팡')) {
    throw new Error('삭제 대상에 mall=쿠팡 이 포함됐습니다 — 중단');
  }
  console.log(`    안전 확인: 쿠팡 링크 혼입 0 / mall=쿠팡 혼입 0  → 통과\n`);

  /* ── 연결된 price_history ── */
  const hist = await fetchAll('price_history', 'id,product_id,mall');
  const targetKeys = new Set(targets.map(p => `${p.product_id}|${p.mall}`));
  const coupangKeys = new Set(coupang.map(p => `${p.product_id}|${p.mall}`));
  const histTargets = hist.filter(h => targetKeys.has(`${h.product_id}|${h.mall}`));

  // 지우려는 기록이 유지 대상(쿠팡)과 겹치지 않는지 확인한다.
  const overlap = histTargets.filter(h => coupangKeys.has(`${h.product_id}|${h.mall}`));
  if (overlap.length) throw new Error(`쿠팡 상품의 기록 ${overlap.length}행이 삭제 목록에 있습니다 — 중단`);

  console.log(`[2] 연결된 price_history`);
  console.log(`    전체 ${hist.length} / 삭제 대상 ${histTargets.length}`);
  console.log(`    쿠팡 기록과 겹침: 0  → 통과\n`);

  if (!CONFIRM) {
    console.log('DRY-RUN 입니다. 실제로 지우려면 --confirm 을 붙여 다시 실행하세요.');
    console.log(`  지울 것: price_history ${histTargets.length}행 → products ${targets.length}행`);
    return;
  }

  /* ── 실제 삭제 ── */
  console.log('[3] 삭제 실행');
  const dh = await deleteByIds('price_history', histTargets.map(h => h.id));
  const dp = await deleteByIds('products', targets.map(p => p.id));
  console.log(`    price_history ${dh}행 / products ${dp}행 삭제 완료\n`);

  /* ── 사후 검증 ── */
  console.log('[4] 사후 검증');
  const after     = await fetchAll('products', 'id,product_id,mall');
  const afterHist = await fetchAll('price_history', 'id,product_id,mall');
  const afterCoupang = after.filter(p => isRefreshableMall(p.mall));
  const afterOther   = after.filter(p => !isRefreshableMall(p.mall));
  const afterKeys = new Set(after.map(p => `${p.product_id}|${p.mall}`));
  const orphans = afterHist.filter(h => !afterKeys.has(`${h.product_id}|${h.mall}`));

  console.log(`    products 전체        ${after.length}`);
  console.log(`    쿠팡 products        ${afterCoupang.length}`);
  console.log(`    비쿠팡 products      ${afterOther.length}   ${afterOther.length === 0 ? '✓ 목표 달성' : '✗ 남아 있음'}`);
  console.log(`    price_history 전체   ${afterHist.length}`);
  console.log(`    고아 기록            ${orphans.length}  (이번 삭제 이전부터 있던 것)`);

  if (afterOther.length !== 0) {
    console.error('\n비쿠팡 상품이 남아 있습니다. 확인이 필요합니다.');
    process.exit(1);
  }
  console.log('\n═══ 정리 완료 ═══');
})().catch(e => { console.error('\n실패:', e.message); process.exit(1); });
