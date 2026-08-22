#!/usr/bin/env node
/**
 * 비쿠팡 상품 정리 — 읽기 전용 분석.
 *
 * ★ 이 스크립트는 아무것도 쓰지 않는다. select 만 한다.
 *   삭제는 scripts/purge-noncoupang.js 가 따로 한다.
 *
 * 판별 기준은 추측하지 않는다. api/_price.js 의 isRefreshableMall() 을
 * 그대로 가져다 쓴다 — 홈 노출·수집 대상 판정이 쓰는 바로 그 함수다.
 * 여기서 다른 기준을 만들면 "코드가 보는 쿠팡"과 "우리가 지우는 쿠팡"이
 * 어긋난다.
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

const PAGE = 1000;

/** 테이블 전체를 페이지로 나눠 읽는다 (Supabase 기본 상한이 1000행). */
async function fetchAll(table, columns, order) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select(columns).order(order, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

function tally(rows, key) {
  const m = new Map();
  rows.forEach(r => {
    const v = r[key] === null ? '(null)' : r[key] === '' ? '(빈문자열)' : String(r[key]);
    m.set(v, (m.get(v) || 0) + 1);
  });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(' products 비쿠팡 정리 — 읽기 전용 분석');
  console.log(' (이 스크립트는 DB 에 아무것도 쓰지 않습니다)');
  console.log('═══════════════════════════════════════════════════\n');

  /* ── 실제 컬럼 확인 — 있다고 가정하지 않는다 ── */
  const { data: sample, error: sErr } = await supabase.from('products').select('*').limit(1);
  if (sErr) throw new Error(`products 조회 실패: ${sErr.message}`);
  const columns = sample && sample.length ? Object.keys(sample[0]) : [];
  console.log('[0] products 실제 컬럼');
  console.log(`    ${columns.join(', ')}\n`);

  for (const c of ['source', 'provider']) {
    console.log(`    ${c} 컬럼: ${columns.includes(c) ? '있음' : '없음 (이 DB 에는 존재하지 않음)'}`);
  }
  console.log('');

  /* ── 전체 조회 ── */
  const products = await fetchAll('products', 'id,product_id,title,mall,link,keyword,lprice,collected_at', 'id');
  console.log(`[1] products 전체: ${products.length}행\n`);

  /* ── mall 분포 ── */
  console.log('[2] mall 값 분포');
  tally(products, 'mall').forEach(([v, n]) => {
    console.log(`    ${isRefreshableMall(v === '(null)' || v === '(빈문자열)' ? '' : v) ? '[쿠팡]  ' : '[비쿠팡]'} ${String(v).padEnd(22)} ${n}행`);
  });
  console.log('');

  /* ── 판별 (isRefreshableMall 그대로) ── */
  const coupang = products.filter(p => isRefreshableMall(p.mall));
  const other   = products.filter(p => !isRefreshableMall(p.mall));
  console.log('[3] isRefreshableMall() 기준 분류');
  console.log(`    쿠팡 (유지):   ${coupang.length}행`);
  console.log(`    비쿠팡 (삭제): ${other.length}행`);
  console.log(`    합계 검증:     ${coupang.length + other.length} === ${products.length} → `
    + `${coupang.length + other.length === products.length ? 'OK' : '불일치!'}\n`);

  /* ── 교차 검증: link 도메인으로도 확인한다 ──
     mall 값이 잘못 들어간 행이 있으면 여기서 드러난다. */
  console.log('[4] 교차 검증 — link 도메인과 mall 이 어긋나는 행');
  const looksCoupang = p => /coupang\.com/i.test(String(p.link || ''));
  const mismatchA = coupang.filter(p => p.link && !looksCoupang(p));
  const mismatchB = other.filter(p => looksCoupang(p));
  console.log(`    mall=쿠팡 인데 링크가 쿠팡이 아님:   ${mismatchA.length}행`);
  console.log(`    mall≠쿠팡 인데 링크는 쿠팡임:       ${mismatchB.length}행  ← 삭제하면 안 되는 행`);
  mismatchA.slice(0, 5).forEach(p => console.log(`      · id=${p.id} pid=${p.product_id} link=${String(p.link).slice(0, 60)}`));
  mismatchB.slice(0, 5).forEach(p => console.log(`      · id=${p.id} mall=${p.mall} link=${String(p.link).slice(0, 60)}`));
  console.log('');

  /* ── 삭제 대상 상세 ── */
  console.log('[5] 삭제 대상 요약');
  const byMall = tally(other, 'mall');
  byMall.forEach(([v, n]) => console.log(`    ${String(v).padEnd(22)} ${n}행`));
  console.log(`\n    삭제 대상 product_id 고유값: ${new Set(other.map(p => p.product_id)).size}개`);
  console.log('    예시 5건:');
  other.slice(0, 5).forEach(p =>
    console.log(`      id=${p.id} pid=${p.product_id} mall=${p.mall} ${String(p.title).slice(0, 34)} ${p.lprice}원`));
  console.log('');

  /* ── price_history 영향 ── */
  console.log('[6] price_history 영향 범위');
  const hist = await fetchAll('price_history', 'id,product_id,mall,recorded_date', 'id');
  console.log(`    price_history 전체: ${hist.length}행`);

  const coupangPidMall = new Set(coupang.map(p => `${p.product_id}|${p.mall}`));
  const otherPidMall   = new Set(other.map(p => `${p.product_id}|${p.mall}`));

  const histOther   = hist.filter(h => otherPidMall.has(`${h.product_id}|${h.mall}`));
  const histCoupang = hist.filter(h => coupangPidMall.has(`${h.product_id}|${h.mall}`));
  const histOrphan  = hist.filter(h =>
    !coupangPidMall.has(`${h.product_id}|${h.mall}`) && !otherPidMall.has(`${h.product_id}|${h.mall}`));

  console.log(`    삭제 대상과 연결된 기록:   ${histOther.length}행`);
  console.log(`    유지 대상(쿠팡)과 연결:    ${histCoupang.length}행`);
  console.log(`    이미 고아인 기록:          ${histOrphan.length}행  (지금도 products 에 짝이 없음)`);
  console.log('    ※ price_history 의 mall 별 분포:');
  tally(hist, 'mall').slice(0, 8).forEach(([v, n]) => console.log(`       ${String(v).padEnd(22)} ${n}행`));
  console.log('');

  /* ── 참조 관계 확인 ── */
  console.log('[7] 다른 테이블의 참조');
  for (const t of ['alerts', 'price_drop_top']) {
    try {
      const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
      if (error) { console.log(`    ${t}: 조회 불가 (${error.message.slice(0, 50)})`); continue; }
      console.log(`    ${t}: ${count}행 존재`);
    } catch (e) {
      console.log(`    ${t}: 조회 불가 (${e.message.slice(0, 50)})`);
    }
  }

  // alerts 가 삭제 대상 상품을 가리키는지
  try {
    const alerts = await fetchAll('alerts', 'id,email,title,mall,sent', 'id');
    const otherTitles = new Set(other.map(p => p.title));
    const hit = alerts.filter(a => otherTitles.has(a.title) || (a.mall && !isRefreshableMall(a.mall)));
    console.log(`    → alerts 중 비쿠팡 상품을 가리키는 것: ${hit.length}건 / 전체 ${alerts.length}건`);
    hit.slice(0, 5).forEach(a => console.log(`      · ${a.mall} | ${String(a.title).slice(0, 40)} | sent=${a.sent}`));
  } catch (e) {
    console.log(`    alerts 확인 실패: ${e.message}`);
  }
  console.log('');

  /* ── 오늘 기록 현황 (배치 실행 전 기준선) ── */
  const kst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const utc = new Date().toISOString().slice(0, 10);
  console.log('[8] 기록 현황 (배치 실행 전 기준선)');
  console.log(`    KST 오늘: ${kst} / UTC 오늘: ${utc}  (recorded_date 는 UTC 기준)`);
  const todayRows = hist.filter(h => h.recorded_date === utc);
  console.log(`    오늘(${utc}) price_history: ${todayRows.length}행`);
  console.log(`    오늘 기록된 고유 product_id: ${new Set(todayRows.map(h => h.product_id)).size}개`);

  const recent = tally(hist, 'recorded_date').sort((a, b) => String(b[0]).localeCompare(String(a[0]))).slice(0, 5);
  console.log('    최근 기록일:');
  recent.forEach(([d, n]) => console.log(`       ${d}  ${n}행`));
  console.log('');

  /* ── 백업 파일 ── */
  const outDir = path.join(root, 'backup');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(outDir, `noncoupang-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({
    createdAt: new Date().toISOString(),
    criterion: "isRefreshableMall(mall) === false  (api/_price.js)",
    productsTotal: products.length,
    coupangCount: coupang.length,
    deleteCount: other.length,
    products: other,
    priceHistory: histOther
  }, null, 2));
  console.log('[9] 백업');
  console.log(`    삭제 대상 원본을 저장했습니다 (복구용):`);
  console.log(`    ${backup}`);
  console.log(`    products ${other.length}행 + price_history ${histOther.length}행\n`);

  console.log('═══════════════════════════════════════════════════');
  console.log(' 요약');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  전체 products            ${products.length}`);
  console.log(`  쿠팡 (유지)              ${coupang.length}`);
  console.log(`  비쿠팡 (삭제 대상)        ${other.length}`);
  console.log(`  삭제 시 지워질 기록       ${histOther.length}`);
  console.log(`  삭제 후 남을 기록         ${hist.length - histOther.length}`);
  console.log(`  링크-몰 불일치(위험)      ${mismatchB.length}  ← 0 이어야 안전`);
  console.log('═══════════════════════════════════════════════════');
})().catch(e => { console.error('\n분석 실패:', e.message); process.exit(1); });
