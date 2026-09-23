#!/usr/bin/env node
/*
 * V3 카나리 리포트 — 읽기 전용 (DB 조회 + gh run 로그). 외부 API 호출 0회, DB 쓰기 0회.
 *
 *   node scripts/v3-canary-report.js --date 2026-09-24 [--baseline 2026-09-16,2026-09-17,2026-09-21]
 *
 * 카나리 날짜와 레거시 정상일을 «같은 지표» 로 나란히 놓는다. 전부 운영 실측값이다.
 *   호출      수집기(source=collect) 쿠팡·ADPICK 외부 호출
 *   확보      그날 수집기가 가격을 남긴 고유 상품 (product_id|mall) — 호출당 확보
 *   커버리지  그날 대상(collector_target_page) 중 수집기가 확보한 비율
 *              ★ 과거 날짜의 상시 추적 대상은 «지금» 캐시로 근사한다 (회전 버킷은 정확)
 *   429/403   ADPICK·쿠팡 응답
 *   60초 최대 ADPICK 검색의 임의의 연속 60초 호출 수 (수집기 / 모든 경로)
 *   옵션      자기모순 = 기록한 옵션 ≠ 그 행 링크의 옵션 (쿠팡) / 링크 해시 ≠ product_id (ADPICK)
 *             추적옵션불일치 = 기록한 옵션 ≠ 지금 상품이 추적하는 옵션 (과거 날짜는 재등록 착시 포함)
 *   중복      (product_id, mall, vendor_item_id, KST 날짜) 2행 이상
 * 필수 조건(카나리 당일: 옵션 자기모순 0 · 추적옵션불일치 0 · 중복 0 · 60초 위반 0 ·
 * 잠금/체크포인트 이상 0 · 429 0) 중 하나라도 어기면 exit 1.
 */
'use strict';

require('./_env');
const supabase = require('../api/_supabase');
const { kstDayStartUtc, vendorIdOf } = require('../api/_price');
const { adpickProductId } = require('../api/_shop');
const { rollingStats } = require('../api/_adpicklimit');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DATE = arg('--date');
if (!DATE) { console.error('사용법: node scripts/v3-canary-report.js --date YYYY-MM-DD [--baseline a,b,c]'); process.exit(2); }
const BASE = String(arg('--baseline', '2026-09-16,2026-09-17,2026-09-21')).split(',').map(s => s.trim()).filter(Boolean);
const COLLECT_CAP = 5, OFFICIAL = 10;
const bucketOf = d => { const n = Math.floor(Date.parse(`${d}T00:00:00Z`) / 86400000); return ((n % 7) + 7) % 7; };

async function keyset(table, cols, filter, cursor = 'id') {
  const out = []; let after = null, maxPage = 0;
  for (;;) {
    let q = supabase.from(table).select(cols).order(cursor, { ascending: true }).limit(1000);
    q = filter(q); if (after !== null) q = q.gt(cursor, after);
    const { data, error } = await q; if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data); if (!data.length) break;
    maxPage = Math.max(maxPage, data.length); if (data.length < maxPage) break;
    after = data[data.length - 1][cursor];
  }
  return out;
}

async function targets(bucket) {
  const rows = []; let am = null, ap = null, maxPage = 0;
  for (;;) {
    const { data, error } = await supabase.rpc('collector_target_page', {
      p_rotation_days: 7, p_rotation_bucket: bucket, p_after_mall: am, p_after_product_id: ap, p_limit: 1000, p_include_all: false });
    if (error) throw new Error('collector_target_page: ' + error.message);
    rows.push(...data); if (!data.length) break;
    maxPage = Math.max(maxPage, data.length); if (data.length < maxPage) break;
    am = data[data.length - 1].mall; ap = data[data.length - 1].product_id;
  }
  return rows;
}

async function day(d) {
  const ds = kstDayStartUtc(d), de = new Date(Date.parse(ds) + 86400000).toISOString();
  const ad = await keyset('adpick_api_calls', 'id, called_at, source, operation, http_status, external_call',
    q => q.gte('called_at', ds).lt('called_at', de).eq('external_call', true));
  const cp = await keyset('coupang_api_calls', 'id, called_at, source, http_status', q => q.gte('called_at', ds).lt('called_at', de));
  const ph = await keyset('price_history', 'id, product_id, mall, vendor_item_id, link, recorded_at, source',
    q => q.gte('recorded_at', ds).lt('recorded_at', de));
  const col = ph.filter(r => r.source === 'collect');
  const tg = await targets(bucketOf(d));
  const tgKeys = { '쿠팡': new Set(), 'ADPICK': new Set() };
  tg.forEach(t => tgKeys[t.mall] && tgKeys[t.mall].add(`${t.product_id}|${t.mall}`));
  const got = { '쿠팡': new Set(), 'ADPICK': new Set() };
  col.forEach(r => got[r.mall] && got[r.mall].add(`${r.product_id}|${r.mall}`));

  // 옵션 오류 — 기록된 판매 단위가 상품이 추적하는 판매 단위와 같은가
  const ids = [...new Set(col.map(r => r.product_id))];
  const prods = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from('products').select('product_id, mall, vendor_item_id, link').in('product_id', ids.slice(i, i + 150));
    if (error) throw new Error('products: ' + error.message);
    data.forEach(p => prods.set(`${p.product_id}|${p.mall}`, p));
  }
  /*
   * 두 가지를 따로 센다.
   *   selfBad  행 자체가 모순 — 기록한 옵션 ≠ 그 행 링크의 옵션 (쿠팡) / 링크 해시 ≠ product_id (ADPICK).
   *            «남의 옵션 가격 저장» 의 직접 증거다. 날짜와 무관하게 0 이어야 한다.
   *   optBad   지금 상품이 추적하는 옵션과 다르다. 그날 기준으로는 오저장이지만, 과거 날짜는
   *            뒤에 추적 옵션이 바뀐 상품(2026-09-18 seed 재등록 등)도 여기 잡힌다 — 실측:
   *            09-16 불일치 66행 전부 selfBad 0, 표본 40개 중 38개가 09-18 seed 로 옵션이 바뀌었다.
   *            그래서 필수 조건은 «카나리 당일 리포트» 의 optBad 로만 본다.
   */
  let optBad = 0, selfBad = 0, optChecked = 0;
  col.forEach(r => {
    if (r.mall === '쿠팡') {
      const own = vendorIdOf({ vendor_item_id: '', link: r.link });
      if (own && String(r.vendor_item_id || '') !== own) selfBad++;
    } else if (r.mall === 'ADPICK' && adpickProductId(r.link) !== r.product_id) selfBad++;
    const p = prods.get(`${r.product_id}|${r.mall}`); if (!p) return;
    optChecked++;
    if (r.mall === '쿠팡') { const want = vendorIdOf(p); if (!want || String(r.vendor_item_id || '') !== want) optBad++; }
    else if (r.mall === 'ADPICK' && adpickProductId(r.link) !== r.product_id) optBad++;
  });
  const seen = new Map();
  ph.forEach(r => { const k = `${r.product_id}|${r.mall}|${r.vendor_item_id || ''}`; seen.set(k, (seen.get(k) || 0) + 1); });

  const adCollect = ad.filter(r => r.source === 'collect' && (r.operation || 'search') === 'search');
  const adSearchAll = ad.filter(r => (r.operation || 'search') === 'search');
  const cpCollect = cp.filter(r => r.source === 'collect');
  const cov = m => { let n = 0; got[m].forEach(k => { if (tgKeys[m].has(k)) n++; }); return { n, of: tgKeys[m].size }; };
  return {
    d,
    adCalls: adCollect.length, cpCalls: cpCollect.length,
    adGot: got.ADPICK.size, cpGot: got['쿠팡'].size,
    adCov: cov('ADPICK'), cpCov: cov('쿠팡'),
    ad429: ad.filter(r => r.http_status === 429).length, ad403: ad.filter(r => r.http_status === 403).length,
    cp429: cp.filter(r => r.http_status === 429).length,
    roll: rollingStats(adCollect.map(r => Date.parse(r.called_at))), rollAll: rollingStats(adSearchAll.map(r => Date.parse(r.called_at))),
    optBad, selfBad, optChecked, dup: [...seen.values()].filter(n => n > 1).length
  };
}

function runLogs(d) {
  // 그 KST 날짜의 Daily Price Collection 실행 로그에서 게이트·체크포인트·잠금 이상을 센다.
  const out = { runs: 0, v3On: 0, v3Off: 0, ckptFail: 0, finalFail: 0, lockLost: 0, killed: [] };
  try {
    const { execSync } = require('child_process');
    const ds = kstDayStartUtc(d), de = new Date(Date.parse(ds) + 86400000).toISOString();
    const list = JSON.parse(execSync('gh run list --workflow=daily-prices.yml --limit 60 --json databaseId,createdAt,status', { encoding: 'utf8' }));
    list.filter(r => r.createdAt >= ds && r.createdAt < de && r.status === 'completed').forEach(r => {
      const log = execSync(`gh run view ${r.databaseId} --log`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (!/\[잠금\] 획득/.test(log)) return;
      out.runs++;
      if (/\[V3 카나리 게이트\] ON/.test(log)) out.v3On++; else out.v3Off++;
      const m = /\[체크포인트\] 중간 저장 (\d+)회 \/ 실패 (\d+)회 \/ 최종 저장 (완료|못 함)/.exec(log);
      if (m) { out.ckptFail += Number(m[2]); if (m[3] !== '완료') out.finalFail++; }
      if (/잠금을 잃었습니다|잠금 상실|잠금이 더 이상 우리 것이 아닙니다/.test(log)) out.lockLost++;
      const k = /⛔ \[V3 카나리\][^\n]*/.exec(log); if (k) out.killed.push(`${r.databaseId}: ${k[0]}`);
    });
  } catch (e) { out.error = e.message.split('\n')[0]; }
  return out;
}

(async () => {
  const rows = [];
  for (const d of [...BASE, DATE]) rows.push(await day(d));
  const pc = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
  console.log(`V3 카나리 리포트 — 카나리 ${DATE} vs 레거시 ${BASE.join(', ')} (전부 운영 실측)\n`);
  console.log('날짜        | ADPICK 호출 확보 호출당  커버리지 | 쿠팡 호출 확보 호출당 커버리지 | 429(A/C) 403 | 60초최대 수집/전체 | 옵션: 자기모순 / 추적옵션불일치 / 검사 | 중복');
  rows.forEach(r => console.log(
    `${r.d}${r.d === DATE ? '*' : ' '} | ${String(r.adCalls).padStart(6)} ${String(r.adGot).padStart(5)} ${(r.adGot / (r.adCalls || 1)).toFixed(2).padStart(5)} ${pc(r.adCov.n, r.adCov.of).padStart(8)} |`
    + ` ${String(r.cpCalls).padStart(5)} ${String(r.cpGot).padStart(5)} ${(r.cpGot / (r.cpCalls || 1)).toFixed(2).padStart(5)} ${pc(r.cpCov.n, r.cpCov.of).padStart(7)} |`
    + ` ${r.ad429}/${r.cp429} ${String(r.ad403).padStart(3)} | ${r.roll.maxIn60s}/${r.rollAll.maxIn60s} | ${r.selfBad} / ${r.optBad} / ${r.optChecked} | ${r.dup}`));

  const c = rows[rows.length - 1];
  const st = await supabase.from('price_job_state')
    .select('job_date, status, last_result->lock, last_result->targetSignature, last_result->v3Kill, last_result->plannerStarveCursor').eq('id', 1).single();
  const s = st.data || {};
  console.log(`\n상태(${s.job_date}): 서명 ${s.targetSignature} · 잠금 ${s.lock ? '보유 중' : '없음'} · V3 비활성화 표식 ${s.v3Kill ? JSON.stringify(s.v3Kill) : '없음'} · 기아 커서 ${JSON.stringify(s.plannerStarveCursor || {})}`);
  const L = runLogs(DATE);
  console.log(`실행 로그(${DATE}): 작업 실행 ${L.runs} (V3 ${L.v3On} / 레거시 ${L.v3Off}) · 체크포인트 실패 ${L.ckptFail} · 최종 저장 실패 ${L.finalFail} · 잠금 상실 ${L.lockLost}${L.error ? ` · 로그 조회 실패: ${L.error}` : ''}`);
  L.killed.forEach(k => console.log(`  ${k}`));

  const fails = [];
  if (c.selfBad) fails.push(`옵션 자기모순 ${c.selfBad}`);
  if (c.optBad) fails.push(`추적 옵션 불일치 ${c.optBad} (카나리 당일 기준)`);
  if (c.dup) fails.push(`중복 ${c.dup}`);
  if (c.roll.maxIn60s > COLLECT_CAP) fails.push(`수집기 60초 ${c.roll.maxIn60s} > ${COLLECT_CAP}`);
  if (c.rollAll.maxIn60s > OFFICIAL) fails.push(`검색 전체 60초 ${c.rollAll.maxIn60s} > 공식 ${OFFICIAL}`);
  if (c.ad429 || c.cp429) fails.push(`429 ${c.ad429 + c.cp429}`);
  if (L.ckptFail || L.finalFail || L.lockLost) fails.push('잠금·체크포인트 이상');
  console.log(`\n필수 조건: ${fails.length ? '미충족 — ' + fails.join(' · ') : '전부 충족'}`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('실패:', e.message); process.exit(2); });
