#!/usr/bin/env node
/**
 * 오늘 가격 갱신 결과 검증 — 읽기 전용.
 *
 * ★ 아무것도 쓰지 않는다. 쿠팡도 부르지 않는다. select 만 한다.
 *
 * 이 스크립트가 답하려는 질문은 둘이고, 둘은 다르다.
 *   ① 오늘 가격 갱신을 실행했는가        (배치가 돌았는가)
 *   ② 쿠팡 전체 상품의 오늘 가격이 다 있는가 (커버리지)
 * ①이 참이어도 ②는 거짓일 수 있다. 섞어서 "완료"라고 말하지 않는다.
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
const { isRefreshableMall, observedKstDate } = require('../api/_price');

const PAGE = 1000;

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

(async () => {
  /*
   * "오늘" 은 KST 하나로 통일한다.
   *
   * 예전에는 recorded_date 를 UTC 로 보고 utcToday 와 비교했다. 그런데
   * recorded_date 는 그 값을 쓴 코드가 어느 시간대로 잘랐느냐에 따라 달라지는
   * 라벨이고, 배포본은 UTC 로 잘라 왔다. 수집 크론이 KST 01·03·06시에 도는
   * 탓에 그날 수집분이 통째로 하루 이른 라벨을 달고 저장된다.
   *
   * 2026-08-22 실측: 그날 수집한 498행의 recorded_date 가 전부 2026-08-21
   * 이었다. 라벨로 세면 "오늘 갱신 0행 = 배치가 안 돌았다" 는 정반대 진단이
   * 나온다 (실제로는 KST 02:19 에 완주했다).
   *
   * 그래서 관측일은 _price.observedKstDate 로 정한다 — recorded_at(절대
   * 시각)을 KST 로 환산하고, 없을 때만 recorded_date 로 폴백한다. 이러면
   * 라벨을 KST 로 고친 뒤에도 같은 답이 나온다.
   */
  const utcToday = new Date().toISOString().slice(0, 10);
  const kstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  console.log('═══════════════════════════════════════════════════');
  console.log(' 오늘 가격 갱신 검증 (읽기 전용)');
  console.log(`   KST 오늘 ${kstToday}  (관측일·job_date 공통 기준)`);
  console.log(`   UTC 오늘 ${utcToday}  (참고용 — 판정에 쓰지 않는다)`);
  console.log('═══════════════════════════════════════════════════\n');

  const products = await fetchAll('products', 'id,product_id,mall,keyword,title,collected_at');
  const coupang  = products.filter(p => isRefreshableMall(p.mall));
  const other    = products.filter(p => !isRefreshableMall(p.mall));

  const hist = await fetchAll('price_history', 'id,product_id,mall,recorded_date,recorded_at,price');
  const today = hist.filter(h => observedKstDate(h) === kstToday);

  // 라벨(recorded_date)이 실제 관측일과 어긋난 행 수 — 수집기가 UTC 로 자르고
  // 있으면 여기서 바로 드러난다.
  const mislabeled = hist.filter(h => h.recorded_at && observedKstDate(h) !== h.recorded_date);

  /* ── 1. 오늘 기록 수 ── */
  console.log('[1] 오늘(KST) 관측된 price_history');
  console.log(`    ${today.length}행`);
  console.log(`    recorded_date 라벨이 실제 관측일과 다른 행: ${mislabeled.length}`
    + `/${hist.length}` + (mislabeled.length ? '  ← 수집기가 recorded_date 를 UTC 로 자르고 있다' : ''));

  /* ── 2. 오늘 가격이 잡힌 고유 상품 ── */
  const todayKeys = new Set(today.map(h => `${h.product_id}|${h.mall}`));
  const todayPids = new Set(today.map(h => h.product_id));
  console.log('\n[2] 오늘 가격이 기록된 고유 상품');
  console.log(`    고유 product_id      ${todayPids.size}개`);
  console.log(`    고유 product_id|mall ${todayKeys.size}개`);

  /* ── 3. 오늘 기록이 없는 쿠팡 상품 ── */
  const missing = coupang.filter(p => !todayKeys.has(`${p.product_id}|${p.mall}`));
  const cov = coupang.length ? (coupang.length - missing.length) / coupang.length * 100 : 0;
  console.log('\n[3] 커버리지');
  console.log(`    쿠팡 products        ${coupang.length}개`);
  console.log(`    오늘 가격 있음        ${coupang.length - missing.length}개  (${cov.toFixed(1)}%)`);
  console.log(`    오늘 가격 없음        ${missing.length}개`);
  if (missing.length) {
    console.log('    없는 상품 예시 5건:');
    missing.slice(0, 5).forEach(p =>
      console.log(`      pid=${p.product_id} kw="${p.keyword || '(없음)'}" ${String(p.title).slice(0, 32)}`));
  }

  /* ── 4. 중복 기록 ── */
  console.log('\n[4] 중복 기록 (같은 상품·같은 몰·같은 날 2행 이상)');
  const dupMap = new Map();
  today.forEach(h => {
    const k = `${h.product_id}|${h.mall}|${h.recorded_date}`;
    dupMap.set(k, (dupMap.get(k) || 0) + 1);
  });
  const dups = [...dupMap.entries()].filter(([, n]) => n > 1);
  console.log(`    중복 키 ${dups.length}건 ${dups.length ? '← upsert 제약이 안 걸렸다는 뜻' : '(없음 — 정상)'}`);
  dups.slice(0, 5).forEach(([k, n]) => console.log(`      ${k} → ${n}행`));

  // 오늘 말고 전체 기간도 한 번 본다 (제약 자체가 도는지)
  const allDup = new Map();
  hist.forEach(h => {
    const k = `${h.product_id}|${h.mall}|${h.recorded_date}`;
    allDup.set(k, (allDup.get(k) || 0) + 1);
  });
  const allDups = [...allDup.values()].filter(n => n > 1).length;
  console.log(`    전체 기간 중복 키    ${allDups}건`);

  /* ── 5·6. 배치 상태 ── */
  console.log('\n[5] price_job_state');
  const { data: st, error: stErr } = await supabase
    .from('price_job_state').select('*').eq('id', 1).maybeSingle();
  if (stErr) {
    console.log(`    조회 실패: ${stErr.message}`);
  } else if (!st) {
    console.log('    행 없음');
  } else {
    console.log(`    job_date     ${st.job_date}   (KST 오늘 ${kstToday} → ${st.job_date === kstToday ? '일치' : '불일치'})`);
    console.log(`    status       ${st.status}`);
    console.log(`    processed    ${st.processed} / total ${st.total}`);
    console.log(`    cursor_key   ${st.cursor_key ? `"${st.cursor_key}"` : '(빈 문자열 = 처음)'}`);
    console.log(`    last_run_at  ${st.last_run_at}`);
    const lr = st.last_result || {};
    console.log(`    last_result  ${JSON.stringify(lr).slice(0, 300)}`);

    console.log('\n[6] 완료 여부');
    console.log(`    status === 'completed' ? ${st.status === 'completed' ? '예' : '아니오 (아직 남음)'}`);

    console.log('\n[7] 실패 항목');
    const failed = Array.isArray(lr.failedKeywords) ? lr.failedKeywords : [];
    console.log(`    실패 검색어 ${failed.length}종`);
    failed.slice(0, 10).forEach(k => console.log(`      · ${k}`));

    console.log('\n[8] 다음 실행이 처음부터 다시 시작하는가');
    if (st.job_date !== kstToday) {
      console.log('    → 날짜가 다르므로 처음부터 시작 (정상: 새 날)');
    } else if (st.status === 'completed') {
      console.log('    → 오늘 완료됨. 같은 날 재실행하면 아무것도 하지 않음 (no-op)');
    } else if (st.cursor_key) {
      console.log(`    → 커서 "${st.cursor_key}" 다음부터 이어받음 (처음부터 다시 하지 않음) ✓`);
    } else {
      console.log('    → 커서가 비어 있음. 처음부터 시작한다.');
    }
  }

  /* ── 요약 ── */
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 요약 — 두 문장을 구분해서 읽을 것');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  "오늘 가격 갱신을 실행했다"           → ${today.length > 0 ? '예' : '아니오'}`);
  console.log(`  "쿠팡 전체의 오늘 가격이 다 기록됐다"  → ${missing.length === 0 ? '예' : `아니오 (${missing.length}개 없음)`}`);
  console.log('───────────────────────────────────────────────────');
  console.log(`  products 전체        ${products.length}`);
  console.log(`  쿠팡                 ${coupang.length}`);
  console.log(`  비쿠팡               ${other.length} ${other.length === 0 ? '✓' : '✗'}`);
  console.log(`  오늘 price_history   ${today.length}`);
  console.log(`  오늘 확인된 고유 상품  ${todayKeys.size}`);
  console.log(`  기록 없는 쿠팡 상품   ${missing.length}`);
  console.log(`  중복 기록            ${dups.length}`);
  console.log('═══════════════════════════════════════════════════');
})().catch(e => { console.error('\n검증 실패:', e.message); process.exit(1); });
