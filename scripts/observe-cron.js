#!/usr/bin/env node
/*
 * 수집 cron 관측기 — 읽기 전용.
 *
 *   node scripts/observe-cron.js              오늘(KST) 작업일
 *   node scripts/observe-cron.js 2026-09-09   특정 KST 일자
 *   node scripts/observe-cron.js --logs       + GitHub Actions 로그에서 서킷 복구 확인
 *
 * ── 이 파일이 하지 «않는» 것 ────────────────────────────────────────
 *
 *   · 쓰지 않는다      — supabase 는 .select() 만 쓴다. insert/upsert/update/
 *                        delete/rpc 를 한 번도 부르지 않는다.
 *   · 부르지 않는다    — 쿠팡·ADPICK 등 외부 상거래 API 호출 0회.
 *                        scripts/collect-all-prices.js 를 import 조차 하지 않는다.
 *   · 실행하지 않는다  — 수집을 트리거하는 경로가 없다.
 *   · 망가뜨리지 않는다 — 조회가 실패하면 그 줄만 '-' 로 두고 계속한다.
 *                        어떤 실패 경로에서도 운영 상태를 바꾸지 않는다.
 *
 *   --logs 를 준 «경우에만» gh CLI 로 GitHub Actions 로그를 읽는다. 이것도
 *   읽기 전용이고 상거래 API 와는 무관하지만, 기본값에서 외부 호출을 0으로
 *   두기 위해 옵트인으로 뺐다.
 *
 * ── 왜 합격선을 코드에 박아 두는가 ──────────────────────────────────
 *
 *   숫자를 보고 나서 기준을 만들면 어떤 결과든 성공으로 읽힌다. 그래서
 *   기준선(BASELINE)과 합격선(TARGET)을 미리 적어 두고, 실제값을 그 옆에
 *   나란히 찍는다. 판정은 마지막에 기계적으로 한다.
 */
'use strict';
require('./_env');
const supabase = require('../api/_supabase');
const { kstToday, kstDayStartUtc } = require('../api/_price');

const args = process.argv.slice(2);
const WITH_LOGS = args.includes('--logs');
const DAY = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || kstToday();
const PAGE = 1000;

/*
 * 기준선 — KST 2026-09-08 실측 (수정 배포 «전»). 개선을 이 값과 비교한다.
 * 합격선 — 배포 전 미리 정한 값. 근거는 커밋 787baaf 메시지 참고.
 */
const BASELINE = { eligible: 2473, collected: 1917, coupang: 1304, adpick: 613, coupangCalls: 1865, adpickCalls: 47 };
const TARGET = { adpickCalls: 100, adpickRate: 0.90, totalRate: 0.855, coupangDayBudget: 2800 };

const pct = (n, d) => (d > 0 ? (n / d * 100).toFixed(1) + '%' : '-');
const p = (v, n) => String(v).padStart(n);

/** 페이지 넘기며 전부 읽는다. 실패하면 null 을 주고 호출부가 '-' 로 처리한다. */
async function all(table, cols, mod) {
  try {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      let q = supabase.from(table).select(cols).range(from, from + PAGE - 1);
      if (mod) q = mod(q);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return out;
  } catch (e) {
    console.warn(`  ! ${table} 조회 실패(계속 진행): ${e.message}`);
    return null;
  }
}
/*
 * ★ count 가 null 인 경우를 «0건» 으로 읽으면 안 된다 (2026-09-08 실측).
 *
 *   adpick_api_calls 는 마이그레이션이 아직 적용되지 않아서, 조회가
 *   error 를 주는 대신 count: null / error: null 로 조용히 돌아온다.
 *   그걸 Number(null)||0 으로 접으면 "계측 테이블이 없다" 가 "오늘 0회
 *   불렀다" 로 둔갑하고, 합격 판정이 그 0 을 그대로 쓴다.
 *   실제로 이 관측기 초판이 "ADPICK calls 실제 0" 을 찍었다 — job_state 에
 *   attempt 53 이 남아 있는데도.
 *   그래서 «모른다» 를 숫자로 만들지 않고 err 로 돌려보낸다.
 */
async function countRows(table, mod) {
  try {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    if (mod) q = mod(q);
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    if (count === null || count === undefined) throw new Error('count 없음(테이블/권한 미적용)');
    return Number(count);
  } catch (e) {
    return { err: e.message };
  }
}

/**
 * 서킷이 열린 뒤 «같은 실행에서 다시 불렀는가» 를 판정한다.
 *
 * ★ DB 만으로는 단정할 수 없다. price_job_state 에는 차단 «횟수» 는 남지만
 *   (failureCategories.blocked) 시각 순서가 없어서, 차단 뒤에 부른 것인지
 *   차단 전에 부른 것인지 구분되지 않는다. 그래서 추론과 확증을 나눈다.
 *
 *   추론  차단을 봤는데도 attempt 가 충분히 많다 → 멈춘 채로 끝나지 않았다.
 *         옛 동작(영구 중단)이면 차단을 본 순간 회수 패스가 끝나므로
 *         attempt 가 그 지점에서 멈춘다. 실측 기준선이 47회였다.
 *   확증  --logs 로 실행 로그에서 재개 문구를 직접 찾는다.
 */
function circuitInference(v) {
  const cats = v.failureCategories || {};
  const opens = Number(cats.blocked || 0);
  const attempts = Number(v.attemptCalls || 0);
  return { opens, attempts, resumedLikely: opens > 0 && attempts >= TARGET.adpickCalls };
}

/** --logs 일 때만. gh CLI 로 최근 실행 로그에서 서킷 열림/복구 문구를 센다. */
function circuitFromLogs() {
  const { execFileSync } = require('child_process');
  const run = (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const ids = run(['run', 'list', '--workflow=daily-prices.yml', '--limit', '8',
      '--json', 'databaseId,startedAt', '--jq', '.[]|"\\(.databaseId) \\(.startedAt)"'])
      .trim().split('\n').filter(Boolean);
    let opens = 0, resumes = 0, checked = 0;
    for (const row of ids) {
      const [id, startedAt] = row.split(' ');
      // 그 KST 작업일에 속한 실행만 본다.
      const s = kstDayStartUtc(DAY);
      const e = new Date(Date.parse(s) + 864e5).toISOString();
      if (!(startedAt >= s && startedAt < e)) continue;
      let log = '';
      try { log = run(['run', 'view', id, '--log']); } catch (_) { continue; }
      checked++;
      opens += (log.match(/차단 감지 —/g) || []).length;
      resumes += (log.match(/차단이 풀렸습니다/g) || []).length;
    }
    return { checked, opens, resumes };
  } catch (e) {
    return { err: e.message };
  }
}

(async () => {
  const s = kstDayStartUtc(DAY);
  const e = new Date(Date.parse(s) + 864e5).toISOString();
  console.log(`\n${'='.repeat(72)}`);
  console.log(`수집 cron 관측 — KST ${DAY}   (UTC ${s} ~ ${e})`);
  console.log(`읽기 전용: SELECT 만 / 외부 상거래 API 호출 0회 / 수집 실행 없음`);
  console.log('='.repeat(72));

  const products = await all('products', 'product_id, mall');
  const ph = await all('price_history', 'product_id, mall',
    q => q.gte('recorded_at', s).lt('recorded_at', e));

  let nC = 0, nA = 0, gotC = 0, gotA = 0, adpRows = 0;
  if (products && ph) {
    const key = new Set(ph.map(r => `${r.product_id}|${r.mall}`));
    nC = products.filter(x => x.mall === '쿠팡').length;
    nA = products.filter(x => x.mall === 'ADPICK').length;
    gotC = products.filter(x => x.mall === '쿠팡' && key.has(`${x.product_id}|${x.mall}`)).length;
    gotA = products.filter(x => x.mall === 'ADPICK' && key.has(`${x.product_id}|${x.mall}`)).length;
    adpRows = ph.filter(r => r.mall === 'ADPICK').length;
  }
  const nT = nC + nA, gotT = gotC + gotA;

  console.log('\n[수집률]                        실제      기준선(09-08)');
  console.log(`  전체 eligible            ${p(nT, 9)}      ${p(BASELINE.eligible, 6)}`);
  console.log(`  전체 collected           ${p(gotT, 9)}      ${p(BASELINE.collected, 6)}`);
  console.log(`  Coupang collected        ${p(gotC, 9)}      ${p(BASELINE.coupang, 6)}`);
  console.log(`  Coupang 수집률           ${p(pct(gotC, nC), 9)}      ${p(pct(BASELINE.coupang, 1648), 6)}`);
  console.log(`  ADPICK collected         ${p(gotA, 9)}      ${p(BASELINE.adpick, 6)}   ← 핵심`);
  console.log(`  ADPICK 수집률            ${p(pct(gotA, nA), 9)}      ${p(pct(BASELINE.adpick, 825), 6)}`);
  console.log(`  ADPICK price_history 행  ${p(adpRows, 9)}      ${p(BASELINE.adpick, 6)}`);
  console.log(`  전체 수집률              ${p(pct(gotT, nT), 9)}      ${p(pct(BASELINE.collected, BASELINE.eligible), 6)}`);

  const coupCalls = await countRows('coupang_api_calls',
    q => q.gte('called_at', s).lt('called_at', e).eq('source', 'collect'));
  const adpCalls = await countRows('adpick_api_calls',
    q => q.gte('called_at', s).lt('called_at', e));
  console.log('\n[호출]');
  console.log(`  Coupang collect 호출     ${p(coupCalls.err ? '-' : coupCalls, 9)}      ${p(BASELINE.coupangCalls, 6)}`
    + `   (하루 상한 ${TARGET.coupangDayBudget})`);
  console.log(`  ADPICK 호출(계측 테이블) ${p(adpCalls.err ? '미적용' : adpCalls, 9)}`
    + (adpCalls.err ? '      supabase/2026-09-05-adpick-api-calls.sql 미적용 — job_state 로 대신 센다' : ''));

  /* ── job_state: 몰별 패스 성적 + 서킷 흔적 ─────────────────────── */
  let st = null;
  try {
    const r = await supabase.from('price_job_state').select('*').eq('id', 1).single();
    st = r.data;
  } catch (e) { console.warn(`  ! price_job_state 조회 실패: ${e.message}`); }

  const malls = (st && (st.last_result || {}).malls) || {};
  let adpAttempts = 0, adpInf = { opens: 0, attempts: 0, resumedLikely: false };
  if (st) {
    console.log(`\n[job_state] job_date ${st.job_date} / status ${st.status} / last_run ${st.last_run_at}`);
    for (const [m, v] of Object.entries(malls)) {
      const inf = circuitInference(v);
      if (m === 'ADPICK') { adpAttempts = inf.attempts; adpInf = inf; }
      console.log(`  ${m}  status=${v.status}  대상 ${v.targetProducts}`
        + ` / 수집성공 ${v.collectorSuccessProducts}`
        + ` / 시도 ${v.attemptedProducts == null ? '-' : v.attemptedProducts}`);
      console.log(`      attempt ${inf.attempts} (성공 ${v.attemptSuccess})`
        + `  circuit open(차단 사유 attempt) ${inf.opens}`
        + `  실패원인 ` + JSON.stringify(Object.fromEntries(
            Object.entries(v.failureCategories || {}).filter(([, n]) => n > 0))));
      (v.passStats || []).forEach(x => console.log(
        `      pass ${String(x.pass).padEnd(7)} 호출 ${p(x.calls, 4)}  회수 ${p(x.recovered, 4)}`
        + `  호출당 ${x.calls ? (x.recovered / x.calls).toFixed(2) : '-'}`));
      console.log(`      미호출 회수 검색어 ${v.secondPassRemaining}종`);
    }
  }

  /* ── 서킷 복구 판정 ────────────────────────────────────────────── */
  console.log('\n[ADPICK 서킷]');
  console.log(`  차단 사유 attempt(=circuit open 흔적)  ${adpInf.opens}`);
  console.log(`  차단 이후 재개 (추론)                  `
    + (adpInf.opens === 0 ? '해당 없음 — 이번 작업일에 차단이 없었다'
      : adpInf.resumedLikely
        ? `그렇다 — 차단을 보고도 attempt ${adpInf.attempts}회 (옛 동작이면 여기서 멈춘다)`
        : `아니다 — 차단 후 attempt ${adpInf.attempts}회에 그쳤다`));
  if (WITH_LOGS) {
    const lg = circuitFromLogs();
    if (lg.err) console.log(`  로그 확증: 실패 (${lg.err})`);
    else console.log(`  로그 확증: 실행 ${lg.checked}건 — "차단 감지" ${lg.opens}회 /`
      + ` "차단이 풀렸습니다" ${lg.resumes}회`);
  } else {
    console.log('  로그 확증: 건너뜀 (--logs 를 주면 gh 로 실행 로그를 읽어 확인한다)');
  }

  /* ── 판정 ──────────────────────────────────────────────────────── */
  console.log('\n' + '='.repeat(72));
  console.log('[1차 합격 기준 — 배포 전에 미리 정한 값]');
  const v = (c, label) => console.log(`  ${c ? 'PASS' : 'FAIL'}  ${label}`);
  const adpCallsEff = adpCalls.err ? adpAttempts : adpCalls;
  v(adpCallsEff >= TARGET.adpickCalls,
    `ADPICK calls ≥ ${TARGET.adpickCalls}      실제 ${adpCallsEff}${adpCalls.err ? ' (job_state attempt 기준)' : ''}`);
  v(nA > 0 && gotA / nA >= TARGET.adpickRate,
    `ADPICK 수집률 ≥ ${(TARGET.adpickRate * 100).toFixed(0)}%      실제 ${pct(gotA, nA)}`);
  v(nT > 0 && gotT / nT >= TARGET.totalRate,
    `전체 수집률 ≥ ${(TARGET.totalRate * 100).toFixed(1)}%     실제 ${pct(gotT, nT)}`);
  v(adpInf.opens === 0 || adpInf.resumedLikely,
    `서킷이 열렸다면 재개 흔적이 있다      open ${adpInf.opens} / attempt ${adpInf.attempts}`);
  v(!coupCalls.err && coupCalls <= TARGET.coupangDayBudget,
    `Coupang 호출 ≤ 하루 상한 ${TARGET.coupangDayBudget}    실제 ${coupCalls.err ? '-' : coupCalls}`);

  console.log('\n※ 외부 API 가 종일 불안정했던 날은 기계적으로 판정하지 말 것.');
  console.log('  job_state 의 실패원인(blocked/network/staleCache)이 평소보다 크면');
  console.log('  그것을 원인으로 함께 보고해야 한다 — 수치만으로 코드를 탓하면 틀린다.');
  console.log('※ 이 스크립트는 SELECT 만 했다. 쓰기·수집 실행·상거래 API 호출 0회.');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
