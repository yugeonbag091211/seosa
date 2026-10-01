/*
 * test-precovered-skip.js — 실행 «도중» 전원 확보된 그룹의 1차 호출 생략 (2026-10-01)
 *
 * ── 무엇을 고정하는가 ────────────────────────────────────────────────
 *   시작 시점의 P4 필터(todayAtStart)는 «실행이 시작될 때» 이미 오늘 가격이
 *   있던 그룹만 걸러낸다. 그런데 교차 매칭(absorbCrossMatches)은 실행 «도중»
 *   앞 그룹의 응답으로 뒤 그룹의 상품을 흡수한다. 그렇게 전원이 확보된 뒤
 *   그룹이 remaining 에 그대로 남아, 커서가 닿으면 아무도 기다리지 않는 1차
 *   호출이 한 번 더 나갔다. processGroup 맨 앞의 가드가 회수 패스와 같은
 *   기준(남은 미확보 target 이 없으면 호출하지 않는다)을 1차에도 적용한다.
 *
 * ── 정확성 안전장치 (가격 정확성 > API 절약) ─────────────────────────
 *   상품이 uncovered 에서 빠지는 경로는 둘뿐이다:
 *     · adoptOne === 'MATCH'  = product_id + vendorItemId(옵션) 완전 일치
 *     · collectedTodayFn      = 오늘 원장에 그 옵션의 가격이 이미 있다
 *   그래서 productId 만 같거나 제목이 비슷하다고 skip 되는 일은 없다. 아래
 *   Case 3·7 이 그것을 고정한다.
 *
 * ── 운영 DB 에 절대 닿지 않는다 ─────────────────────────────────────
 *   api/_supabase 를 가짜로 바꾸고, 저장(recordPricesFn)·캐시 힌트
 *   (cacheHintFn)·오늘 기록 조회(collectedTodayFn)를 전부 스텁으로 넣는다.
 *   test-second-pass.js / test-price-mall-collection.js 의 같은 관례를 따른다.
 */
'use strict';
const path = require('path');
const Module = require('module');

/* 배치 대기를 1ms 로 (몇 분씩 자지 않게) · 한 배치에 다 담기게. */
process.env.PRICE_BATCH_INTERVAL_MS = '1';
process.env.PRICE_BATCH_PRODUCTS = '1000';

/* ── 가짜 Supabase — 운영 DB 에 절대 닿지 않는다. ── */
function makeChain(table, store) {
  const chain = {
    select() { return chain; }, in() { return chain; }, eq() { return chain; },
    lt() { return chain; }, gte() { return chain; }, not() { return chain; },
    order() { return chain; }, limit() { return chain; }, range() { return chain; },
    upsert(rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      if (!store[table]) store[table] = [];
      store[table].push(...list);
      return Promise.resolve({ data: list, error: null });
    },
    update() { return chain; },
    then(res) { return Promise.resolve({ data: [], error: null }).then(res); }
  };
  return chain;
}
const store = {};
const fakeSupabase = { from: t => makeChain(t, store), rpc: () => Promise.resolve({ data: null, error: null }) };
function inject(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p; require.cache[p].loaded = true;
  require.cache[p].exports = exports;
}
inject('api/_supabase.js', fakeSupabase);
inject('api/_notify.js', { send: () => Promise.resolve({ ok: true }) });

const { runMallCollection } = require('./collect-all-prices');
const { kstToday } = require('../api/_price');

/* 저장·힌트·오늘기록 스텁 — 전부 메모리, 운영 미접촉. */
const NO_HINT = async () => new Map();
const NO_WRITE = async (obs) => ({
  saved: obs.length, recorded: obs.length,
  recordedKeys: [...new Set(obs.map(o => `${o.productId}|${o.mall}`))],
  rejected: 0, suspect: 0, errors: []
});
const NO_TODAY = async () => new Set();

/* 픽스처 — test-second-pass.js 와 같은 모양. 상품마다 옵션(vendor_item_id) 하나. */
const prod = (id, kw) =>
  ({ product_id: id, mall: '쿠팡', title: `${id} 아주 구체적인 상품 이름`, keyword: kw,
     link: '', image: '', item_id: 'I' + id, vendor_item_id: 'V' + id });
/* 응답 항목. vid 를 지정하면 옵션 불일치(Case 3)를 만들 수 있다. */
const item = (id, price = 10000, vid = 'V' + id) =>
  ({ productId: id, title: 't' + id, lprice: price, oprice: price,
     link: 'https://x/' + id, image: '', mall: '쿠팡', itemId: 'I' + id, vendorItemId: vid });
const FAR = () => Date.now() + 10 * 60 * 1000;
const ok = (items) => ({ ok: true, reason: '', items, allItems: items });

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}
function section(n) { console.log(`\n${n}`); }

/**
 * 시나리오 하나를 돌린다. 실제로 fetchAllFn 이 나간 검색어를 기록한다.
 * @param rows          products 행 배열
 * @param byKw          { 검색어: 응답객체 | ()=>응답객체 } — 없으면 빈 응답
 * @param extra         runMallCollection 추가 인자 (collectedTodayFn 등)
 */
async function run(rows, byKw, extra = {}) {
  const calledKw = [];
  const fetchAllFn = async (kw) => {
    calledKw.push(kw);
    const r = byKw[kw];
    if (typeof r === 'function') return r();
    return r || ok([]);
  };
  const r = await runMallCollection({
    mallName: '쿠팡', rows, fetchAllFn,
    recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT, collectedTodayFn: NO_TODAY,
    savedState: null, deadlineTs: FAR(), ...extra
  });
  return { r, calledKw };
}

/* CONCURRENCY=4 라, 앞 그룹의 교차 매칭이 뒤 그룹에 반영되려면 뒤 그룹이
 * «다음 슬라이스» 에 있어야 한다. 채움 그룹 3개로 첫 슬라이스를 채운다.
 * 정렬은 검색어 문자열 오름차순(buildPlan) — 아래 키 이름이 그 순서를 만든다. */
const FILLERS = () => [prod('F1', 'k1_fill'), prod('F2', 'k2_fill'), prod('F3', 'k3_fill')];
const FILLER_RESP = { k1_fill: ok([item('F1')]), k2_fill: ok([item('F2')]), k3_fill: ok([item('F3')]) };

(async () => {
  console.log('=== 실행 도중 전원 확보 그룹 1차 호출 생략 테스트 ===');

  /* ================================================================
   * Case 1 — 그룹 A 응답에 A+B 가 같이 와서 B 가 전원 확보되면,
   *          뒤 그룹 B 의 1차 검색은 아예 나가지 않는다.
   * ================================================================ */
  section('Case 1 — A 응답으로 B 전원 확보 → B 검색 호출 안 함');
  {
    const rows = [prod('A', 'k0_a'), ...FILLERS(), prod('B', 'k9_z')];
    // A 응답에 B 의 상품(정확한 vid)이 함께 들어온다.
    const { r, calledKw } = await run(rows, {
      k0_a: ok([item('A'), item('B')]),
      ...FILLER_RESP,
      k9_z: ok([item('B')])            // 만약 호출되면 여기로 오지만, 호출돼선 안 된다
    });
    check(!calledKw.includes('k9_z'), 'B 그룹(k9_z)의 1차 검색이 나가지 않았다', calledKw);
    check(r.preCoveredSkips === 1, 'preCoveredSkips === 1', r.preCoveredSkips);
    check(r.collectorSuccessProducts === 5, 'A·B·채움 3개 전부 확보 (5개)', r.collectorSuccessProducts);
    check(r.uncoveredProducts === 0, '미확보 0개', r.uncoveredProducts);
  }

  /* ================================================================
   * Case 2 — B 그룹 3개 중 2개만 교차 회수되면, 남은 1개 때문에
   *          B 검색은 그대로 나간다 (부분 확보는 skip 하지 않는다).
   * ================================================================ */
  section('Case 2 — 부분 확보(3개 중 2개) → 남은 1개 위해 B 검색 유지');
  {
    const rows = [prod('A', 'k0_a'), ...FILLERS(), prod('B1', 'k9_z'), prod('B2', 'k9_z'), prod('B3', 'k9_z')];
    const { r, calledKw } = await run(rows, {
      k0_a: ok([item('A'), item('B1'), item('B2')]),   // B3 은 안 들어온다
      ...FILLER_RESP,
      k9_z: ok([item('B1'), item('B2'), item('B3')])    // 호출되면 B3 까지 확보
    });
    check(calledKw.includes('k9_z'), 'B 그룹(k9_z)의 1차 검색이 정상적으로 나갔다', calledKw);
    check(r.preCoveredSkips === 0, 'preCoveredSkips === 0 (부분 확보는 skip 아님)', r.preCoveredSkips);
    check(r.collectorSuccessProducts === 7, 'A·채움 3·B1·B2·B3 전부 확보 (7개)', r.collectorSuccessProducts);
  }

  /* ================================================================
   * Case 3 — product_id 는 같지만 vendorItemId 가 다르면 확보가 아니다.
   *          교차 매칭이 채택하지 않으므로 B 는 미확보로 남고 검색이 나간다.
   * ================================================================ */
  section('Case 3 — productId 동일·vid 다름 → 확보 아님, skip 금지');
  {
    const rows = [prod('A', 'k0_a'), ...FILLERS(), prod('B', 'k9_z')];
    const { r, calledKw } = await run(rows, {
      // A 응답의 B 항목은 «다른 옵션»(vid=VX). 옵션 게이트가 채택을 거부한다.
      k0_a: ok([item('A'), item('B', 10000, 'VX')]),
      ...FILLER_RESP,
      k9_z: ok([item('B')])            // 올바른 옵션(VB)으로 와야 비로소 확보
    });
    check(calledKw.includes('k9_z'), 'vid 가 달라 B 는 미확보 → B 검색이 나갔다', calledKw);
    check(r.preCoveredSkips === 0, 'preCoveredSkips === 0 (productId 만으로는 skip 안 함)', r.preCoveredSkips);
    check(r.collectorSuccessProducts === 5, '올바른 옵션으로만 B 가 확보됐다 (5개)', r.collectorSuccessProducts);
  }

  /* ================================================================
   * Case 4 — 시작 시점에 이미 확보된(오늘 기록) 상품 + 실행 도중 교차 확보.
   *          두 경로가 합쳐져 그룹 전원이 확보되면 1차 호출이 나가지 않는다.
   * ================================================================ */
  section('Case 4 — 시작시 확보 + 도중 교차 확보 → 전원 확보, 호출 안 함');
  {
    const rows = [prod('A', 'k0_a'), ...FILLERS(), prod('B1', 'k9_z'), prod('B2', 'k9_z')];
    // B1 은 오늘 이미 기록돼 있다(collectedTodayFn). B2 는 A 응답으로 교차 확보.
    // collectedTodayFn 은 이어받기 실행(!isNewDay)에서만 읽으므로 같은 날 savedState 를 준다.
    const todayFn = async () => new Set(['B1|쿠팡']);
    const savedState = { job_date: kstToday(), cursor_key: '', processed: 0, status: 'running', last_result: {} };
    const { r, calledKw } = await run(rows, {
      k0_a: ok([item('A'), item('B2')]),
      ...FILLER_RESP,
      k9_z: ok([item('B1'), item('B2')])   // 호출돼선 안 된다
    }, { collectedTodayFn: todayFn, savedState });
    check(!calledKw.includes('k9_z'), '시작시 확보 + 교차 확보로 B 그룹 검색이 나가지 않았다', calledKw);
    check(r.preCoveredSkips === 1, 'preCoveredSkips === 1', r.preCoveredSkips);
  }

  /* ================================================================
   * Case 5 — 큰 그룹(>FACET_MIN_GROUP)이 1차에서 전원 확보되면,
   *          그 그룹은 facet/회수 후보에서 빠져 추가 외부 호출이 없다.
   * ================================================================ */
  section('Case 5 — 큰 그룹 전원 확보 → facet/회수에서 추가 호출 없음');
  {
    // 큰 그룹 B(12개). 앞 그룹 A 가 그 12개를 전부 교차 확보한다.
    const big = [];
    for (let i = 0; i < 12; i++) big.push(prod('G' + i, 'k9_big'));
    const rows = [prod('A', 'k0_a'), ...FILLERS(), ...big];
    const bigItems = big.map(p => item(p.product_id));
    const { r, calledKw } = await run(rows, {
      k0_a: ok([item('A'), ...bigItems]),   // A 응답이 큰 그룹 전원을 흡수
      ...FILLER_RESP
      // k9_big 에는 응답을 등록하지 않는다 — 호출되면 즉시 드러난다.
    });
    const bigCalls = calledKw.filter(kw => kw === 'k9_big' || kw.includes('k9_big')).length;
    check(bigCalls === 0, '큰 그룹 1차·facet·사다리 어떤 외부 호출도 나가지 않았다', calledKw);
    check(r.preCoveredSkips === 1, 'preCoveredSkips === 1 (큰 그룹 1차 생략)', r.preCoveredSkips);
    check(r.collectorSuccessProducts === 1 + 3 + 12, 'A·채움 3·큰그룹 12 전부 확보 (16개)', r.collectorSuccessProducts);
  }

  /* ================================================================
   * Case 6 — 체크포인트 후 다음 실행: 저장된 실제 가격(오늘 기록) 기준으로
   *          이미 확보된 그룹은 다시 탐색하지 않는다.
   * ================================================================ */
  section('Case 6 — 다음 실행 resume: 이미 가격 있는 그룹 재탐색 안 함');
  {
    const rows = [prod('A', 'k0_a'), ...FILLERS(), prod('B', 'k9_z')];
    // 2차 실행 가정: 1차에서 A·채움·B 가 모두 오늘 기록됐다(원장 기준).
    const todayFn = async () => new Set(['A|쿠팡', 'F1|쿠팡', 'F2|쿠팡', 'F3|쿠팡', 'B|쿠팡']);
    // 같은 KST 작업일의 이어받기 실행(= 체크포인트 이후)을 흉내 낸다.
    const savedState = { job_date: kstToday(), cursor_key: '', processed: 0, status: 'running', last_result: {} };
    const { r, calledKw } = await run(rows, {
      k0_a: ok([item('A')]), ...FILLER_RESP, k9_z: ok([item('B')])
    }, { collectedTodayFn: todayFn, savedState });
    check(calledKw.length === 0, '전원이 오늘 이미 가격이 있어 어떤 1차 검색도 나가지 않았다', calledKw);
    check(r.collectorSuccessProducts === 0, '이번 실행이 새로 확보한 상품은 0 (전부 앞 실행 몫)', r.collectorSuccessProducts);
    check(r.uncoveredProducts === 0, '미확보 0개 (전원 확보 상태로 resume)', r.uncoveredProducts);
  }

  /* ================================================================
   * Case 7 — API 실패/429/timeout: 가격을 못 얻었으면 확보 처리하지 않는다.
   *          실패한 그룹은 uncovered 로 남고, skip 되지 않는다(실패를 가리지 않는다).
   * ================================================================ */
  section('Case 7 — API 실패 → 확보 처리 금지, skip 금지');
  {
    const rows = [prod('A', 'k0_a'), ...FILLERS(), prod('B', 'k9_z')];
    const { r, calledKw } = await run(rows, {
      k0_a: ok([item('A')]),
      ...FILLER_RESP,
      k9_z: () => ({ ok: false, items: [], reason: 'HTTP 429 분당 상한' })   // 실제 호출, 실패
    });
    check(calledKw.includes('k9_z'), '실패할 그룹도 실제로 호출됐다 (skip 으로 가리지 않음)', calledKw);
    check(r.preCoveredSkips === 0, 'preCoveredSkips === 0 (실패는 확보가 아니다)', r.preCoveredSkips);
    check(r.uncoveredProducts === 1, 'B 는 가격을 못 얻어 미확보로 남았다', r.uncoveredProducts);
    const bCovered = (r.collectorCovered || []).includes('B|쿠팡');
    check(!bCovered, 'B 는 collectorCovered 에 들어가지 않았다', r.collectorCovered);
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (store.price_history && store.price_history.length) {
    // NO_WRITE 를 쓰므로 여기엔 아무것도 없어야 한다 — 운영 미접촉의 마지막 확인.
    console.log(`  (경고) 가짜 store 에 ${store.price_history.length}행 — NO_WRITE 우회 여부 점검`);
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
