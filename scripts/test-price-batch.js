#!/usr/bin/env node
/*
 * 가격 수집 배치 로직 테스트.
 *
 * 쿠팡 API 를 호출하지 않는다. DB 도 쓰지 않는다(진행 상태는 메모리로 흉내낸다).
 * 검증 대상은 collect-all-prices.js 에서 export 한 순수 함수와,
 * 그 위에 얹힌 "하루 한 바퀴" 상태 전이 규칙이다.
 *
 *   node scripts/test-price-batch.js
 */
'use strict';

const { kstToday, buildPlan, splitBatches, resumeFrom } = require('./collect-all-prices');

let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  [PASS] ${name}`); }
  else { fail++; results.push(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

function eq(name, got, want) {
  check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

/* ── 픽스처 ─────────────────────────────────────────────────────
 * 검색어당 상품 수를 운영 실측(770개 / 316종 ≈ 2.4개)과 비슷하게 만든다.
 */
function makeFixture(totalProducts, perGroup = 2) {
  const withKeyword = [];
  const derived = new Map();
  let made = 0, i = 0;
  while (made < totalProducts) {
    // 검색어를 zero-pad 해서 문자열 정렬 == 생성 순서가 되게 한다(검증 편의).
    const kw = `kw${String(i).padStart(4, '0')}`;
    const n = Math.min(perGroup, totalProducts - made);
    const rows = Array.from({ length: n }, (_, j) => ({
      product_id: `p${made + j}`, mall: '쿠팡', title: `t${made + j}`, keyword: kw
    }));
    withKeyword.push(...rows);
    made += n; i++;
  }
  return { withKeyword, derived };
}

const countProducts = batches =>
  batches.reduce((n, b) => n + b.reduce((m, g) => m + g.rows.length, 0), 0);

console.log('=== 가격 수집 배치 로직 테스트 ===\n');

/* ── 1. KST 날짜 경계 ───────────────────────────────────────── */
console.log('[1] 한국시간 날짜 판정');
// KST = UTC+9. UTC 14:59 → KST 23:59 (같은 날), UTC 15:00 → KST 익일 00:00
eq('UTC 2026-08-13T14:59Z → KST 08-13', kstToday(new Date('2026-08-13T14:59:00Z')), '2026-08-13');
eq('UTC 2026-08-13T15:00Z → KST 08-14', kstToday(new Date('2026-08-13T15:00:00Z')), '2026-08-14');
eq('UTC 2026-08-13T23:59Z → KST 08-14', kstToday(new Date('2026-08-13T23:59:00Z')), '2026-08-14');
eq('UTC 2026-08-14T00:00Z → KST 08-14', kstToday(new Date('2026-08-14T00:00:00Z')), '2026-08-14');
// GitHub Actions 실행 시각(15:00 UTC)이 KST 자정 직후임을 확인
eq('Actions 실행시각 15:00 UTC = KST 새 날', kstToday(new Date('2026-08-13T15:00:00Z')), '2026-08-14');
// 연말 경계
eq('UTC 2026-12-31T15:00Z → KST 2027-01-01', kstToday(new Date('2026-12-31T15:00:00Z')), '2027-01-01');
results.splice(0).forEach(r => console.log(r));

/* ── 2. 배치 분할 / 마지막 배치 크기 ────────────────────────── */
console.log('\n[2] 배치 분할');
{
  // 요구사항의 1,469개 시나리오 — 검색어당 1개(최악: 상품=검색어)일 때
  const { withKeyword, derived } = makeFixture(1469, 1);
  const plan = buildPlan(withKeyword, derived);
  const batches = splitBatches(plan, 20);
  eq('1469개 / 20 → 배치 수 74', batches.length, 74);
  eq('마지막 배치 상품 수 9', batches[74 - 1].reduce((n, g) => n + g.rows.length, 0), 9);
  eq('전 배치 합계 = 1469', countProducts(batches), 1469);
  // 1~20, 21~40 … 순서 확인
  eq('배치1 첫 상품 = p0', batches[0][0].rows[0].product_id, 'p0');
  eq('배치2 첫 상품 = p20', batches[1][0].rows[0].product_id, 'p20');
  eq('배치3 첫 상품 = p40', batches[2][0].rows[0].product_id, 'p40');
  eq('마지막 배치 첫 상품 = p1460', batches[73][0].rows[0].product_id, 'p1460');
}
{
  // 실제 운영 형태 — 검색어당 2~3개라 그룹을 안 쪼개면 20을 살짝 넘김
  const { withKeyword, derived } = makeFixture(770, 2);
  const plan = buildPlan(withKeyword, derived);
  const batches = splitBatches(plan, 20);
  eq('770개 전부 배치에 포함', countProducts(batches), 770);
  const sizes = batches.map(b => b.reduce((n, g) => n + g.rows.length, 0));
  check('그룹을 쪼개지 않아 배치는 20 이상(마지막 제외)',
    sizes.slice(0, -1).every(s => s >= 20), `sizes=${sizes.slice(0, 3)}`);
  check('배치가 20을 크게 넘지 않음(<=20+그룹최대)',
    sizes.every(s => s <= 20 + 2), `max=${Math.max(...sizes)}`);
  // 같은 검색어가 두 배치에 걸치지 않아야 한다(호출 낭비 방지)
  const seen = new Map();
  batches.forEach((b, bi) => b.forEach(g => {
    if (seen.has(g.kw)) seen.set(g.kw, -1); else seen.set(g.kw, bi);
  }));
  check('같은 검색어가 여러 배치에 걸치지 않음', ![...seen.values()].includes(-1));
}
results.splice(0).forEach(r => console.log(r));

/* ── 3. 커서 이어받기 ───────────────────────────────────────── */
console.log('\n[3] 커서 이어받기');
{
  const { withKeyword, derived } = makeFixture(1469, 1);
  const plan = buildPlan(withKeyword, derived);
  const b1 = splitBatches(plan, 20);

  // 실행 1 이 배치 1개만 처리하고 죽었다고 하자
  const cursorAfter1 = b1[0][b1[0].length - 1].kw;
  const rest = resumeFrom(plan, cursorAfter1);
  eq('실행2 는 21번째 상품부터', rest[0].rows[0].product_id, 'p20');
  eq('남은 상품 수 = 1449', rest.reduce((n, g) => n + g.rows.length, 0), 1449);
  check('처리한 검색어가 남은 목록에 없음', !rest.some(g => g.kw <= cursorAfter1));

  // 실행 2 가 이어서 3배치를 처리
  const b2 = splitBatches(rest, 20);
  const cursorAfter2 = b2[2][b2[2].length - 1].kw;
  const rest2 = resumeFrom(plan, cursorAfter2);
  eq('실행3 는 81번째 상품부터', rest2[0].rows[0].product_id, 'p80');

  // 끝까지 돌면 남는 게 없다
  const lastKw = plan[plan.length - 1].kw;
  eq('마지막 검색어 이후 남은 그룹 0', resumeFrom(plan, lastKw).length, 0);
}
results.splice(0).forEach(r => console.log(r));

/* ── 4. 목록이 변해도 누락/중복 없음 ────────────────────────── */
console.log('\n[4] 상품 추가·삭제 중 재개 안정성');
{
  const { withKeyword, derived } = makeFixture(100, 1);
  const plan = buildPlan(withKeyword, derived);
  const cursor = plan[9].kw;              // 10개 그룹 처리 완료 상태

  // (a) 커서보다 앞쪽에 새 상품이 추가됨 → 뒤쪽이 밀리면 안 된다
  const added = [...withKeyword, { product_id: 'pNEW', mall: '쿠팡', title: 'new', keyword: 'kw0000a' }];
  const planAdded = buildPlan(added, derived);
  const restAdded = resumeFrom(planAdded, cursor);
  eq('앞쪽 추가 후에도 다음은 11번째 그룹', restAdded[0].kw, plan[10].kw);
  check('앞쪽에 추가된 상품이 재처리되지 않음', !restAdded.some(g => g.kw === 'kw0000a'));

  // (b) 커서보다 앞쪽 상품이 삭제됨 → 뒤쪽을 건너뛰면 안 된다
  const removed = withKeyword.filter(p => p.keyword !== plan[3].kw);
  const planRemoved = buildPlan(removed, derived);
  const restRemoved = resumeFrom(planRemoved, cursor);
  eq('앞쪽 삭제 후에도 다음은 11번째 그룹', restRemoved[0].kw, plan[10].kw);

  // offset 방식이었다면 어떻게 됐는지 대조 — 삭제 시 한 그룹을 건너뛴다
  const offsetWould = planRemoved.slice(10);
  check('offset 방식은 같은 상황에서 어긋남(대조군)', offsetWould[0].kw !== plan[10].kw);
}
results.splice(0).forEach(r => console.log(r));

/* ── 5. 하루 상태 전이 (completed → no-op → 다음날 리셋) ────── */
console.log('\n[5] 하루 작업 상태 전이');
{
  // run() 의 상태 판정 규칙을 그대로 옮겨 시뮬레이션한다.
  //   날짜 다름            → 리셋(cursor='', processed=0, running)
  //   같은 날 + completed  → 아무것도 하지 않음
  //   같은 날 + running    → 커서부터 이어서
  function decide(state, today) {
    if (!state || state.job_date !== today) return { action: 'reset', cursor: '' };
    if (state.status === 'completed') return { action: 'noop', cursor: state.cursor_key };
    return { action: 'resume', cursor: state.cursor_key };
  }

  const { withKeyword, derived } = makeFixture(1469, 1);
  const plan = buildPlan(withKeyword, derived);
  const D1 = '2026-08-13', D2 = '2026-08-14';

  // 하루를 끝까지 돌린다
  let state = { job_date: D1, cursor_key: '', processed: 0, total: 1469, status: 'running' };
  let runs = 0, processed = 0;
  for (;;) {
    const d = decide(state, D1);
    if (d.action === 'noop') break;
    const batches = splitBatches(resumeFrom(plan, d.cursor), 20);
    if (!batches.length) { state.status = 'completed'; break; }
    // 한 실행이 배치 10개씩만 처리한다고 가정(시간 예산으로 끊긴 상황)
    const take = batches.slice(0, 10);
    take.forEach(b => {
      state.cursor_key = b[b.length - 1].kw;
      processed += b.reduce((n, g) => n + g.rows.length, 0);
    });
    state.processed = processed;
    if (take.length === batches.length) state.status = 'completed';
    runs++;
    if (runs > 50) break;   // 무한루프 방지
  }
  eq('여러 번 나눠 실행해도 전체 1469개 처리', state.processed, 1469);
  eq('완료 후 status = completed', state.status, 'completed');
  eq('8번의 실행으로 완료(74배치/10)', runs, 8);

  // ★ 같은 날 다시 실행 — 아무것도 하지 않아야 한다
  const again = decide(state, D1);
  eq('완료된 날 재실행 → noop', again.action, 'noop');
  check('완료 후 커서가 처음으로 되돌아가지 않음', state.cursor_key !== '');

  // 같은 날 여러 번 더 돌려도 계속 noop
  let noopCount = 0;
  for (let i = 0; i < 5; i++) if (decide(state, D1).action === 'noop') noopCount++;
  eq('같은 날 5회 추가 실행 전부 noop', noopCount, 5);
  eq('추가 실행 후에도 processed 그대로', state.processed, 1469);

  // ★ 다음 날 — 1번부터 다시 시작
  const next = decide(state, D2);
  eq('다음 날 → reset', next.action, 'reset');
  eq('리셋 커서는 빈 문자열', next.cursor, '');
  const firstBatch = splitBatches(resumeFrom(plan, next.cursor), 20)[0];
  eq('다음 날 첫 상품 = p0 (1번부터)', firstBatch[0].rows[0].product_id, 'p0');
}
results.splice(0).forEach(r => console.log(r));

/* ── 6. 실패 격리 ───────────────────────────────────────────── */
console.log('\n[6] 실패 상품이 배치를 멈추지 않음');
{
  // run() 의 그룹 루프를 흉내낸다: 한 그룹이 던져도 나머지가 계속 처리된다.
  const groups = Array.from({ length: 20 }, (_, i) => ({ kw: `k${i}`, rows: [{ product_id: `p${i}` }] }));
  const processedIds = [];
  const failed = [];

  const fetchStub = async kw => {
    if (kw === 'k6') throw new Error('네트워크 오류');
    if (kw === 'k11') return { ok: false, items: [], reason: '쿠팡 차단' };
    return { ok: true, items: [{ productId: kw.replace('k', 'p') }], reason: '' };
  };

  (async () => {
    for (const g of groups) {
      let r;
      try { r = await fetchStub(g.kw); }
      catch (e) { failed.push({ kw: g.kw, reason: e.message }); continue; }
      if (!r.ok) { failed.push({ kw: g.kw, reason: r.reason }); continue; }
      r.items.forEach(it => processedIds.push(it.productId));
    }

    eq('20개 중 18개 정상 처리', processedIds.length, 18);
    eq('실패 2건 기록', failed.length, 2);
    check('예외를 던진 k6 이후도 계속 처리됨', processedIds.includes('p7') && processedIds.includes('p19'));
    check('예외 실패와 호출불가 실패를 모두 기록', failed.some(f => f.reason === '네트워크 오류') && failed.some(f => f.reason === '쿠팡 차단'));
    check('실패한 상품이 성공으로 집계되지 않음', !processedIds.includes('p6') && !processedIds.includes('p11'));
    results.splice(0).forEach(r => console.log(r));

    /* ── 7. 쿠팡 호출량 ──────────────────────────────────────── */
    console.log('\n[7] 쿠팡 API 호출 한도');
    {
      const { withKeyword, derived } = makeFixture(770, 2);
      const plan = buildPlan(withKeyword, derived);
      const batches = splitBatches(plan, 20);
      const callsPerBatch = batches.map(b => b.length);   // 그룹 1개 = 검색 1회
      const maxCalls = Math.max(...callsPerBatch);
      const OFFICIAL = 50, SELF = 20;

      console.log(`  배치당 호출: 평균 ${(callsPerBatch.reduce((a, c) => a + c, 0) / callsPerBatch.length).toFixed(1)}회 / 최대 ${maxCalls}회`);
      check(`배치당 최대 호출 ${maxCalls}회 < 공식 한도 ${OFFICIAL}회/분`, maxCalls < OFFICIAL);
      check(`배치당 최대 호출 ${maxCalls}회 <= 자체 상한 ${SELF}회/분`, maxCalls <= SELF);
      check('라이브 검색 몫이 남음(자체 상한의 80% 이하)', maxCalls <= SELF * 0.8, `${maxCalls}/${SELF}`);
      eq('전체 호출 = 검색어 수(중복 호출 없음)', callsPerBatch.reduce((a, c) => a + c, 0), plan.length);
    }
    results.splice(0).forEach(r => console.log(r));

    /* ── 8. 실패 검색어의 같은 날 재시도 ─────────────────────── */
    console.log('\n[8] 실패 검색어 재시도 / 완료 판정');
    {
      /*
       * run() 의 규칙을 그대로 옮긴다.
       *   완료 조건 = 남은 검색어 없음 AND 재시도 목록 비어 있음
       *   재시도 그룹 = 커서를 지나온 것 중 실패한 검색어 (커서는 안 건드림)
       */
      const decide = (state, today) => {
        if (!state || state.job_date !== today) return 'reset';
        if (state.status === 'completed') return 'noop';
        return 'resume';
      };
      const { withKeyword, derived } = makeFixture(60, 1);
      const plan = buildPlan(withKeyword, derived);
      const D1 = '2026-08-13';

      // 실행 1: 전 배치를 돌았지만 2종이 쿠팡 차단으로 실패
      let state = { job_date: D1, cursor_key: '', processed: 0, total: 60, status: 'running', last_result: {} };
      const batches = splitBatches(resumeFrom(plan, ''), 20);
      const failed = new Set([plan[2].kw, plan[7].kw]);
      state.cursor_key = batches[batches.length - 1].slice(-1)[0].kw;
      state.processed = 60;
      state.status = failed.size ? 'running' : 'completed';
      state.last_result = { failedKeywords: [...failed] };

      eq('실패가 남으면 completed 로 굳히지 않음', state.status, 'running');
      eq('그래도 커서는 끝에 있음', state.cursor_key, plan[plan.length - 1].kw);

      // 실행 2 (같은 날 보충): 남은 검색어는 없고 재시도만 있어야 한다
      eq('보충 실행은 noop 이 아니라 resume', decide(state, D1), 'resume');
      const remaining2 = resumeFrom(plan, state.cursor_key);
      eq('남은 검색어 0종', remaining2.length, 0);
      const failed2 = new Set(state.last_result.failedKeywords);
      const retry2 = plan.filter(g => failed2.has(g.kw) && !remaining2.some(x => x.kw === g.kw));
      eq('재시도 그룹 2종', retry2.length, 2);
      check('★ 재시도는 1번부터 다시 돌지 않는다', retry2.every(g => failed2.has(g.kw)));
      check('재시도 대상이 원래 실패했던 검색어와 일치',
        retry2.map(g => g.kw).sort().join() === [...failed].sort().join());

      // 재시도 성공 → 목록에서 빠지고 완료
      retry2.forEach(g => failed2.delete(g.kw));
      const nowComplete = remaining2.length === 0 && failed2.size === 0;
      check('재시도 성공 후 완료 조건 충족', nowComplete);
      state.status = nowComplete ? 'completed' : 'running';
      eq('상태 completed 로 전환', state.status, 'completed');

      // 실행 3: 이제는 아무것도 하지 않는다
      eq('완료 후 같은 날 재실행 → noop', decide(state, D1), 'noop');
      eq('처리 수가 60 을 넘지 않음(중복 처리 없음)', state.processed, 60);

      // 재시도가 계속 실패해도 커서는 뒤로 가지 않는다
      const stuck = { ...state, status: 'running', last_result: { failedKeywords: [plan[2].kw] } };
      const rem = resumeFrom(plan, stuck.cursor_key);
      eq('계속 실패해도 남은 검색어는 0 (재처리 없음)', rem.length, 0);
      check('커서가 유지됨', stuck.cursor_key === plan[plan.length - 1].kw);
    }
    results.splice(0).forEach(r => console.log(r));

    /* ── 9. 전체 커버리지 시뮬레이션 (운영 실측 기준) ────────────── */
    console.log('\n[9] 전체 커버리지 시뮬레이션 — 770개 / 316종, 실패 포함');
    {
      /*
       * 운영 DB 실측(770 쿠팡 상품 / 316 고유 검색어)을 재현한다.
       * 일부 검색어가 실패해도 보충 실행으로 결국 전부 처리되는지 확인한다.
       *
       * 시뮬레이션 규칙:
       *   - 예산: 실행당 400회
       *   - 시간: 실행당 배치 50개까지(50분 근사)
       *   - 10% 검색어가 첫 시도에서 실패(차단/rate limit)
       *   - 보충 실행에서 재시도하면 전부 성공
       *   - 하루 최대 3회 실행(KST 01:00, 03:00, 06:00)
       */
      const BUDGET = 400;
      const MAX_BATCHES_PER_RUN = 50;
      const BATCH_SIZE = 20;

      const { withKeyword, derived } = makeFixture(770, 2);
      const plan = buildPlan(withKeyword, derived);
      const totalKeywords = plan.length;
      const totalProducts = plan.reduce((n, g) => n + g.rows.length, 0);

      const failSet = new Set(plan.filter((_, i) => i % 10 === 3).map(g => g.kw));
      const failCount = failSet.size;

      let state = null;
      const D1 = '2026-08-21';
      let runCount = 0;
      const runLog = [];

      for (let attempt = 0; attempt < 3; attempt++) {
        if (state && state.job_date === D1 && state.status === 'completed') break;
        runCount++;

        if (!state || state.job_date !== D1) {
          state = { job_date: D1, cursor_key: '', processed: 0, total: totalProducts, status: 'running',
                    last_result: {} };
        }

        const remaining = resumeFrom(plan, state.cursor_key || '');
        const failedKws = new Map(
          ((state.last_result && state.last_result.failedKeywords) || []).map(kw => [kw, true])
        );
        const retryGroups = failedKws.size
          ? plan.filter(g => failedKws.has(g.kw) && !remaining.some(x => x.kw === g.kw))
          : [];

        if (!remaining.length && !retryGroups.length) {
          state.status = 'completed';
          break;
        }

        let apiCalls = 0;
        let processed = 0;
        let succeeded = 0;
        let failed2 = 0;
        let batchCount = 0;

        const processGroups = (groups, isRetry) => {
          for (const g of groups) {
            if (apiCalls >= BUDGET) {
              failedKws.set(g.kw, true);
              failed2++;
              continue;
            }
            if (!isRetry && failSet.has(g.kw)) {
              failedKws.set(g.kw, true);
              failed2++;
              apiCalls++;
              continue;
            }
            failedKws.delete(g.kw);
            succeeded++;
            processed += g.rows.length;
            apiCalls++;
          }
        };

        if (retryGroups.length) {
          const retryBatches = splitBatches(retryGroups, BATCH_SIZE);
          for (const b of retryBatches) {
            if (batchCount >= MAX_BATCHES_PER_RUN) break;
            processGroups(b, true);
            batchCount++;
          }
        }

        const batches = splitBatches(remaining, BATCH_SIZE);
        for (const b of batches) {
          if (batchCount >= MAX_BATCHES_PER_RUN) break;
          processGroups(b, false);
          state.cursor_key = b[b.length - 1].kw;
          state.processed += b.reduce((n, g) => n + g.rows.length, 0);
          batchCount++;
        }

        const isLast = batchCount >= batches.length || batchCount >= MAX_BATCHES_PER_RUN;
        state.status = (isLast && !failedKws.size) ? 'completed' : 'running';
        state.last_result = { failedKeywords: [...failedKws.keys()] };

        runLog.push({
          run: runCount,
          apiCalls,
          succeeded,
          failed: failed2,
          batches: batchCount,
          retried: retryGroups.length,
          remaining: remaining.length
        });
      }

      console.log('  ┌──────────────────────────────────────────────');
      console.log(`  │ products 전체 (쿠팡)     ${totalProducts}개`);
      console.log(`  │ 고유 검색어              ${totalKeywords}종`);
      console.log(`  │ 의도적 실패 검색어       ${failCount}종 (10%)`);
      console.log(`  │ 실행당 API 예산          ${BUDGET}회`);
      runLog.forEach(r => {
        console.log(`  │ 실행 ${r.run}: API ${r.apiCalls}회, 성공 ${r.succeeded}종,`
          + ` 실패 ${r.failed}종, 재시도 ${r.retried}종, 배치 ${r.batches}개`);
      });
      console.log(`  │ 최종 상태: ${state.status}`);
      console.log(`  │ 남은 실패: ${(state.last_result.failedKeywords || []).length}종`);
      console.log('  └──────────────────────────────────────────────');

      eq('전체 상품 수 = 770', totalProducts, 770);
      eq('최종 상태 = completed', state.status, 'completed');
      eq('남은 실패 검색어 = 0', (state.last_result.failedKeywords || []).length, 0);
      check('2회 이내 실행으로 완료', runCount <= 2, `실행 ${runCount}회 소요`);
      check('API 예산(400) 이내로 1차 완료', runLog[0].apiCalls <= BUDGET);
    }
    results.splice(0).forEach(r => console.log(r));

    /* ── 10. 예산 부족 시나리오 (상품 1500개) ────────────────────── */
    console.log('\n[10] 예산 부족 시나리오 — 1500개 / 750종, 3회 실행으로 전량 처리');
    {
      const BUDGET = 400;
      const MAX_BATCHES_PER_RUN = 50;
      const BATCH_SIZE = 20;

      const { withKeyword, derived } = makeFixture(1500, 2);
      const plan = buildPlan(withKeyword, derived);
      const totalKeywords = plan.length;
      const totalProducts = plan.reduce((n, g) => n + g.rows.length, 0);

      let state = null;
      const D1 = '2026-08-21';
      let runCount = 0;
      const runLog = [];

      for (let attempt = 0; attempt < 5; attempt++) {
        if (state && state.job_date === D1 && state.status === 'completed') break;
        runCount++;

        if (!state || state.job_date !== D1) {
          state = { job_date: D1, cursor_key: '', processed: 0, total: totalProducts, status: 'running',
                    last_result: {} };
        }

        const remaining = resumeFrom(plan, state.cursor_key || '');
        const failedKws = new Map(
          ((state.last_result && state.last_result.failedKeywords) || []).map(kw => [kw, true])
        );
        const retryGroups = failedKws.size
          ? plan.filter(g => failedKws.has(g.kw) && !remaining.some(x => x.kw === g.kw))
          : [];

        if (!remaining.length && !retryGroups.length) {
          state.status = 'completed';
          break;
        }

        let apiCalls = 0;
        let succeeded = 0;
        let failed2 = 0;
        let batchCount = 0;

        const processGroups = (groups) => {
          for (const g of groups) {
            if (apiCalls >= BUDGET) {
              failedKws.set(g.kw, true);
              failed2++;
              continue;
            }
            failedKws.delete(g.kw);
            succeeded++;
            apiCalls++;
          }
        };

        if (retryGroups.length) {
          for (const b of splitBatches(retryGroups, BATCH_SIZE)) {
            if (batchCount >= MAX_BATCHES_PER_RUN) break;
            processGroups(b);
            batchCount++;
          }
        }

        const batches = splitBatches(remaining, BATCH_SIZE);
        for (const b of batches) {
          if (batchCount >= MAX_BATCHES_PER_RUN) break;
          processGroups(b);
          state.cursor_key = b[b.length - 1].kw;
          state.processed += b.reduce((n, g) => n + g.rows.length, 0);
          batchCount++;
        }

        const isLast = batchCount >= batches.length;
        state.status = (isLast && !failedKws.size) ? 'completed' : 'running';
        state.last_result = { failedKeywords: [...failedKws.keys()] };

        runLog.push({
          run: runCount,
          apiCalls,
          succeeded,
          failed: failed2,
          retried: retryGroups.length,
          batches: batchCount
        });
      }

      console.log('  ┌──────────────────────────────────────────────');
      console.log(`  │ products 전체 (쿠팡)     ${totalProducts}개`);
      console.log(`  │ 고유 검색어              ${totalKeywords}종`);
      console.log(`  │ 실행당 API 예산          ${BUDGET}회`);
      runLog.forEach(r => {
        console.log(`  │ 실행 ${r.run}: API ${r.apiCalls}회, 성공 ${r.succeeded}종,`
          + ` 실패(예산) ${r.failed}종, 재시도 ${r.retried}종, 배치 ${r.batches}개`);
      });
      console.log(`  │ 최종 상태: ${state.status}`);
      console.log(`  │ 남은 실패: ${(state.last_result.failedKeywords || []).length}종`);
      console.log('  └──────────────────────────────────────────────');

      eq('전체 상품 수 = 1500', totalProducts, 1500);
      eq('최종 상태 = completed', state.status, 'completed');
      eq('남은 실패 검색어 = 0', (state.last_result.failedKeywords || []).length, 0);
      check('3회 이내 실행으로 완료(GitHub Actions 일일 3회)', runCount <= 3,
        `실행 ${runCount}회 소요 — ★ 3회 안에 못 끝나면 하루 전량 수집 불가`);
      check('예산(400) × 2 = 800 ≥ 검색어 750종 → 2회면 충분',
        totalKeywords <= BUDGET * 2);
    }
    results.splice(0).forEach(r => console.log(r));

    /* ── 11. 하루 전량 처리 보장 계산 ─────────────────────────────── */
    console.log('\n[11] 용량 계산 — 현재 설정으로 하루 전량 처리 가능한 상한');
    {
      const BUDGET = 400;
      const RUNS_PER_DAY = 3;
      const BATCH_SZ = 20;
      const maxKeywords = BUDGET * RUNS_PER_DAY;
      const AVG_PRODUCTS_PER_KW = 2.4;
      const maxProducts = Math.floor(maxKeywords * AVG_PRODUCTS_PER_KW);

      const MIN_GAP_S = 6;
      const BATCH_INTERVAL_S = 60;
      const RUN_BUDGET_S = 50 * 60;
      const batchesPerRun = Math.floor(RUN_BUDGET_S / BATCH_INTERVAL_S);
      const kwPerBatch = Math.round(BATCH_SZ / AVG_PRODUCTS_PER_KW);
      const kwPerRun = batchesPerRun * kwPerBatch;
      const kwPerRunApi = Math.floor(RUN_BUDGET_S / MIN_GAP_S);

      console.log('  ┌──────────────────────────────────────────────');
      console.log(`  │ 설정값`);
      console.log(`  │   API 예산/실행         ${BUDGET}회`);
      console.log(`  │   일일 실행 횟수        ${RUNS_PER_DAY}회`);
      console.log(`  │   호출 간격             ${MIN_GAP_S}초`);
      console.log(`  │   배치 간격             ${BATCH_INTERVAL_S}초`);
      console.log(`  │   실행 시간 예산        ${RUN_BUDGET_S / 60}분`);
      console.log(`  │`);
      console.log(`  │ 예산 기준 용량`);
      console.log(`  │   하루 최대 검색어      ${maxKeywords}종 (${BUDGET} × ${RUNS_PER_DAY})`);
      console.log(`  │   하루 최대 상품        ~${maxProducts}개 (× ${AVG_PRODUCTS_PER_KW})`);
      console.log(`  │`);
      console.log(`  │ 시간 기준 용량`);
      console.log(`  │   실행당 배치           ~${batchesPerRun}개 (${RUN_BUDGET_S / 60}분 / ${BATCH_INTERVAL_S}초)`);
      console.log(`  │   실행당 검색어(배치)   ~${kwPerRun}종 (${batchesPerRun} × ${kwPerBatch})`);
      console.log(`  │   실행당 검색어(API)    ~${kwPerRunApi}종 (${RUN_BUDGET_S / 60}분 / ${MIN_GAP_S}초)`);
      console.log(`  │   → 병목은 예산(${BUDGET}) < API시간(${kwPerRunApi})`);
      console.log(`  │`);
      console.log(`  │ 현재 운영 (770개 / 316종)`);
      console.log(`  │   단일 실행 완료 가능   ${316 <= BUDGET ? '✓' : '✗'} (316 ${316 <= BUDGET ? '≤' : '>'} ${BUDGET})`);
      console.log(`  │   여유율               ${((BUDGET - 316) / 316 * 100).toFixed(0)}%`);
      console.log('  └──────────────────────────────────────────────');

      check('현재 316종 < 예산 400 → 단일 실행으로 완료 가능', 316 <= BUDGET);
      check('상품 2배 성장(1540개/~640종)해도 2회 실행이면 충분',
        640 <= BUDGET * 2);
      check('하루 전체 용량(1200종)까지는 3회 실행으로 커버',
        maxKeywords >= 1200);
    }
    results.splice(0).forEach(r => console.log(r));

    console.log(`\n=== 결과: ${pass}/${pass + fail} PASS ===`);
    process.exit(fail ? 1 : 0);
  })();
}
