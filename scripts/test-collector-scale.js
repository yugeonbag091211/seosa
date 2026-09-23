#!/usr/bin/env node
/*
 * 수집기 규모·내구성 테스트 (2026-09-22).
 *
 *   node scripts/test-collector-scale.js
 *
 * ── 왜 이 파일이 생겼나 ────────────────────────────────────────────
 *
 *   2026-09-22 KST 07:23·07:41, Daily Price Collection 이 연속 두 번
 *   **첫 줄에서** 죽었다 (gh run 35662376120 / 35663976131).
 *
 *     치명적 오류: collector_target_products 조회 실패:
 *       canceling statement due to statement timeout
 *
 *   한 상품도 시도하지 못했다. 원인은 «수집 대상 조회» 한 문장이 카탈로그
 *   전체(products 69,743 / price_history 143,282)를 훑는 구조였다는 것이고,
 *   그래서 카탈로그가 커질수록 더 빨리 죽었다. 하루 전에 statement_timeout 을
 *   8초 → 30초로 올려 둔 처방은 하루 만에 다시 넘겼다 (실측 30,362 ms).
 *
 *   이 파일은 그 사고가 다시 나지 않도록 «규모» 를 계약으로 고정한다.
 *   100 / 1,000 / 10,000 / 60,000개에서 동작이 한 줄도 달라지지 않아야 하고,
 *   한 페이지가 실패해도 처음부터 다시 받지 않아야 하며, 재실행이 같은
 *   상품을 두 번 수집하지 않아야 한다.
 *
 * ── 안전성 ────────────────────────────────────────────────────────
 *
 *   DB 도 외부 API 도 부르지 않는다. api/_supabase 를 require.cache 에
 *   가짜로 심어 두고 시작하므로, 이 파일에서 나가는 요청은 0건이다.
 *   (test-price-mall-collection.js 머리말의 2026-08-29 사고 참고 —
 *    픽스처가 운영 DB 에 들어간 적이 있다)
 */
'use strict';

/*
 * ★ require 보다 «먼저» 둔다. 이 값들은 collect-all-prices 가 모듈 로드
 *   시점에 한 번만 읽는다.
 *   배치 간격 15초는 운영에서 쿠팡 호출 속도를 잡는 값이고, 여기서는
 *   그 속도를 재는 게 아니라 «규모» 를 잰다. 0 으로 두지 않으면 1,000개
 *   규모 하나에 12분이 걸린다.
 */
process.env.PRICE_BATCH_INTERVAL_MS = '1';   // 0 은 Number(x) || 15000 에 걸려 기본값이 된다

const path = require('path');

/* ── 가짜 supabase 를 «collect-all-prices 를 require 하기 전에» 심는다 ──
 *
 *   api/_supabase 는 첫 접근 시점에 createClient 를 부르는 Proxy 다.
 *   환경변수가 없으면 거기서 throw 하므로, 모듈을 통째로 바꿔치기해야
 *   테스트가 DB 없이 돈다. 바꿔치기는 require.cache 한 줄이면 된다.
 */
const SUPABASE_PATH = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
const fakeDb = {
  rpcCalls: [],
  /** 다음 rpc 호출들이 돌려줄 값. shift 로 하나씩 꺼내 쓴다. */
  rpcQueue: [],
  /** 큐가 비었을 때의 기본 응답 */
  rpcDefault: { data: [], error: null },
  async rpc(name, args) {
    this.rpcCalls.push({ name, args });
    const next = this.rpcQueue.length ? this.rpcQueue.shift() : this.rpcDefault;
    return typeof next === 'function' ? next(name, args) : next;
  },
  from() { throw new Error('이 테스트는 .from() 을 쓰지 않는다'); }
};
require.cache[SUPABASE_PATH] = {
  id: SUPABASE_PATH, filename: SUPABASE_PATH, loaded: true, exports: fakeDb, children: [], paths: []
};

const C = require('./collect-all-prices');
const {
  keysetScan, runMallCollection, reportInvariantErrors,
  OUTCOME_KEYS, outcomesTemplate, outcomeFromReason, failureStage,
  buildPlan, splitBatches, resumeFrom
} = C;

let pass = 0, fail = 0;
const lines = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; lines.push(`  [PASS] ${name}`); }
  else { fail++; lines.push(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, got, want) {
  check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function section(t) { lines.push(''); lines.push(t); }

async function main() {
/* ================================================================
 *  1. keysetScan — offset 을 쓰지 않고, 빠뜨리지도 겹치지도 않는다
 * ================================================================ */
section('[1] keysetScan — 커서 진행 / 누락·중복 없음');

/** 메모리 표 하나를 PostgREST 빌더처럼 흉내낸다. */
function fakeTable(rows, { cursor = 'id', failOn = null, serverMaxRows = Infinity } = {}) {
  const stats = { requests: 0, offsets: [], maxRowsRead: 0 };
  const build = () => {
    const q = { _gt: null, _limit: 0, _cols: '' };
    q.select = (cols) => { q._cols = cols; return q; };
    q.order = () => q;
    q.limit = (n) => { q._limit = n; return q; };
    q.gt = (col, v) => { if (col !== cursor) throw new Error('커서 컬럼이 아니다: ' + col); q._gt = v; return q; };
    q.then = (resolve) => {
      stats.requests++;
      if (failOn && failOn(stats.requests)) return resolve({ data: null, error: { message: 'boom' } });
      const after = q._gt;
      /* PostgREST 의 db-max-rows 처럼, 요청보다 적게 줄 수 있다. */
      const want = Math.min(q._limit, serverMaxRows);
      const slice = rows.filter(r => after === null || r[cursor] > after).slice(0, want);
      stats.offsets.push(after);
      stats.maxRowsRead = Math.max(stats.maxRowsRead, slice.length);
      // 커서 컬럼을 select 에 넣지 않았으면 응답에서도 빠진다 (운영과 같은 모양)
      const cols = String(q._cols).split(',').map(c => c.trim());
      const projected = slice.map(r => {
        const o = {};
        cols.forEach(c => { if (c in r) o[c] = r[c]; });
        return o;
      });
      return resolve({ data: projected, error: null });
    };
    return q;
  };
  return { build, stats };
}

for (const n of [0, 1, 999, 1000, 1001, 60000]) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, k: 'v' + i }));
  const t = fakeTable(rows);
  const got = await keysetScan({ build: t.build, columns: 'id, k', cursor: 'id', pageSize: 1000, label: 'fake' });
  const ids = got.map(r => r.id);
  eq(`n=${n}: 전부 돌려준다`, ids.length, n);
  check(`n=${n}: 중복 없음`, new Set(ids).size === ids.length);
  check(`n=${n}: 순서가 커서 오름차순`, ids.every((v, i) => i === 0 || v > ids[i - 1]));
  check(`n=${n}: 한 요청이 읽는 행이 페이지 크기를 넘지 않는다`, t.stats.maxRowsRead <= 1000);
}

{
  /*
   * ★ 핵심 계약: 요청 수가 행 수에 «선형» 이다 (offset 처럼 2차가 아니다).
   *   6만 행 / 1,000 = 60 페이지. 60번째가 꽉 차서 오므로 «더 있는가» 를
   *   묻는 61번째 빈 페이지가 한 번 더 간다. 그게 전부다.
   *   offset 방식이면 같은 일에 243만 행을 읽는다 (keysetScan 주석 참고).
   */
  const rows = Array.from({ length: 60000 }, (_, i) => ({ id: i + 1 }));
  const t = fakeTable(rows);
  await keysetScan({ build: t.build, columns: 'id', pageSize: 1000, label: 'fake' });
  eq('6만 행 = 61요청 (60 페이지 + 끝 확인 1)', t.stats.requests, 61);
  check('★ 모든 요청이 «커서 뒤» 를 묻는다 (offset 없음)',
    t.stats.offsets.slice(1).every(v => v !== null));
}

{
  /*
   * ★ 2026-09-22 자체 회귀.
   *
   *   PostgREST 는 db-max-rows(운영 1,000)로 응답을 자른다. 페이지 크기를
   *   2,000 으로 잡고 «요청보다 적게 왔으니 마지막» 으로 판단하면 첫
   *   페이지에서 루프가 끝나 대상의 대부분을 조용히 잃는다.
   *   구현 도중 실제로 그 상태였고, 운영 DB 로 확인해서 잡았다
   *   (limit 2,000 요청 → 정확히 1,000행 응답).
   */
  const rows = Array.from({ length: 4500 }, (_, i) => ({ id: i + 1 }));
  const t = fakeTable(rows, { serverMaxRows: 1000 });
  const got = await keysetScan({ build: t.build, columns: 'id', pageSize: 2000, label: 'capped' });
  eq('★ 서버가 응답을 1,000으로 잘라도 4,500행을 전부 받는다', got.length, 4500);
  check('★ 중복 없음', new Set(got.map(r => r.id)).size === 4500);
  eq('요청 수 = 5 (1000×4 + 500)', t.stats.requests, 5);
}

eq('대상 페이지 크기가 PostgREST db-max-rows(1,000)를 넘지 않는다', C.TARGET_PAGE <= 1000, true);

{
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
  const t = fakeTable(rows);
  let threw = '';
  try {
    // 커서 컬럼을 select 에서 뺐다 → 커서를 못 만든다
    await keysetScan({ build: t.build, columns: 'k', cursor: 'id', pageSize: 5, label: 'fake' });
  } catch (e) { threw = e.message; }
  check('★ 커서 컬럼을 안 읽으면 조용히 도는 대신 즉시 실패한다',
    /커서 컬럼/.test(threw), threw);
}

{
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
  const t = fakeTable(rows, { failOn: (n) => n === 2 });
  let threw = '';
  try {
    await keysetScan({ build: t.build, columns: 'id', pageSize: 5, label: '가짜표 조회' });
  } catch (e) { threw = e.message; }
  check('오류를 삼키지 않는다 (라벨 + 원인)', /가짜표 조회 실패: boom/.test(threw), threw);
}

{
  /*
   * ★ supabase-js v2 처럼 «엄격한» 가짜 표 (2026-09-23).
   *   from() 은 select 만 갖고, 필터(gte/lt/eq)는 select() 가 돌려준 빌더에만 있다.
   *   위 fakeTable 은 순서를 가리지 않아서 collectedTodayByDayScan 의
   *   from().gte(...) 가 운영에서 매번 "gte is not a function" 으로 실패하는 것을 놓쳤다.
   */
  const rows = Array.from({ length: 2500 }, (_, i) => ({
    id: i + 1, mall: i % 2 ? 'ADPICK' : '쿠팡', recorded_at: new Date(Date.UTC(2026, 8, 22, 0, 0, i * 30)).toISOString()
  }));
  const strict = () => ({
    select(cols) {
      const f = { preds: [], _gt: null, _limit: 0 };
      const api = {
        gte: (c, v) => { f.preds.push(r => r[c] >= v); return api; },
        lt: (c, v) => { f.preds.push(r => r[c] < v); return api; },
        eq: (c, v) => { f.preds.push(r => r[c] === v); return api; },
        gt: (c, v) => { f._gt = v; return api; },
        order: () => api,
        limit: n => { f._limit = n; return api; },
        then: resolve => resolve({
          error: null,
          data: rows.filter(r => (f._gt === null || r.id > f._gt) && f.preds.every(p => p(r))).slice(0, Math.min(f._limit, 1000))
            .map(r => Object.fromEntries(String(cols).split(',').map(c => c.trim()).map(c => [c, r[c]])))
        })
      };
      return api;
    }
  });
  let oldThrew = '';
  try {
    await keysetScan({ build: () => strict().gte('recorded_at', 'x'), columns: 'id', label: '옛 모양' });
  } catch (e) { oldThrew = e.message; }
  check('★ 엄격한 빌더에서 from().gte() 는 실패한다 (운영에서 난 바로 그 오류)', /gte is not a function/.test(oldThrew), oldThrew);

  const from = '2026-09-22T00:05:00.000Z', to = '2026-09-22T00:15:00.000Z';
  const got = await keysetScan({
    build: strict,
    filter: q => q.gte('recorded_at', from).lt('recorded_at', to).eq('mall', 'ADPICK'),
    columns: 'id, mall, recorded_at', label: '필터 스캔'
  });
  const want = rows.filter(r => r.recorded_at >= from && r.recorded_at < to && r.mall === 'ADPICK');
  eq('★ filter 인자: select 뒤에 걸려 범위·몰 조건을 지킨다', got.length, want.length);
  check('filter 인자: 페이지를 넘어도 누락·중복 없음', new Set(got.map(r => r.id)).size === want.length && got.every(r => r.mall === 'ADPICK'));
}

/* ================================================================
 *  2. 대상 조회 — 규모별 · 한 페이지 실패해도 처음부터 다시 받지 않는다
 * ================================================================ */
section('[2] collector_target_page 키셋 루프 — 100 / 1,000 / 10,000 / 60,000');

const TARGET_PAGE = C.TARGET_PAGE;

/** collector_target_page 를 흉내내는 rpc 스텁을 만든다. */
function targetRpcStub(total, { dailyEvery = 10, failAt = null, failWith = null } = {}) {
  const all = Array.from({ length: total }, (_, i) => ({
    product_id: `p${String(i).padStart(6, '0')}`,
    mall: i % 2 === 0 ? 'ADPICK' : '쿠팡',
    tier: i % dailyEvery === 0 ? 'daily' : 'rotation'
  }));
  /*
   * 함수와 같은 정렬: (mall, product_id).
   * ★ 정렬과 커서 비교가 «같은 비교» 여야 한다. Postgres 는 ORDER BY 와
   *   행 비교 (a,b) > (c,d) 가 같은 collation 을 쓰므로 언제나 일치한다.
   *   스텁에서 localeCompare 로 정렬하고 < > 로 거르면 한글/라틴 순서가
   *   엇갈려 «절반만 받는» 가짜 실패가 난다 (실제로 그렇게 났다).
   */
  const cmp = (a, b) => (a.mall < b.mall ? -1 : a.mall > b.mall ? 1
    : a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0);
  all.sort(cmp);
  const stats = { calls: 0, cursors: [], refreshCalls: 0 };
  const handler = (name, args) => {
    if (name === 'collector_refresh_eligible') {
      stats.refreshCalls++;
      return { data: [{ refreshed: false, row_count: Math.max(1, Math.floor(total / dailyEvery)), refreshed_at: new Date().toISOString() }], error: null };
    }
    if (name !== 'collector_target_page') throw new Error('예상 못 한 rpc: ' + name);
    stats.calls++;
    if (failAt && stats.calls === failAt) {
      return { data: null, error: failWith };
    }
    const after = args.p_after_mall === null || args.p_after_mall === undefined
      ? null : { mall: args.p_after_mall, product_id: args.p_after_product_id };
    stats.cursors.push(after);
    const rest = after === null ? all : all.filter(r =>
      r.mall > after.mall || (r.mall === after.mall && r.product_id > after.product_id));
    return { data: rest.slice(0, args.p_limit), error: null };
  };
  return { all, stats, handler };
}

for (const total of [100, 1000, 10000, 60000]) {
  const stub = targetRpcStub(total);
  fakeDb.rpcCalls = [];
  fakeDb.rpcQueue = [];
  fakeDb.rpcDefault = stub.handler;

  const meta = { mode: 'rotation', rotationDays: 7, rotationBucket: 3, signature: 'x' };
  const rows = await C.fetchTargetPages(meta);
  const keys = rows.map(r => `${r.product_id}|${r.mall}`);

  eq(`${total}개: 전부 받는다`, rows.length, total);
  check(`${total}개: 중복 0`, new Set(keys).size === keys.length);
  /*
   * ★ 끝 판정이 «서버가 준 최대 페이지» 기준이라, 마지막에 «더 있는가» 를
   *   묻는 빈 호출이 언제나 한 번 더 간다. 그 한 번이 PostgREST 의
   *   db-max-rows 가 우리 요청보다 작을 때 데이터를 잃지 않게 해 준다
   *   (fetchTargetPages 의 maxPage 주석 참고). 전체 스캔당 1회이고,
   *   페이지당이 아니다.
   */
  const expectedCalls = Math.ceil(total / TARGET_PAGE) + 1;
  eq(`${total}개: RPC 호출 ${expectedCalls}회 (= ⌈n/${TARGET_PAGE}⌉ + 끝 확인 1)`, stub.stats.calls, expectedCalls);
  check(`${total}개: 첫 호출만 커서 없음 — 나머지는 전부 «커서 뒤»`,
    stub.stats.cursors[0] === null && stub.stats.cursors.slice(1).every(c => c !== null));
  check(`${total}개: 모든 호출이 p_limit=${TARGET_PAGE} 로 고정 (한 문장이 읽는 양이 규모와 무관)`,
    fakeDb.rpcCalls.filter(c => c.name === 'collector_target_page').every(c => c.args.p_limit === TARGET_PAGE));
}

{
  /* 한 페이지가 일시 실패 → 같은 커서로 재시도, 앞 페이지를 버리지 않는다 */
  const stub = targetRpcStub(10000, {
    failAt: 3,
    failWith: { code: '57014', message: 'canceling statement due to statement timeout' }
  });
  fakeDb.rpcCalls = []; fakeDb.rpcDefault = stub.handler;
  const before = Date.now();
  const rows = await C.fetchTargetPages({ mode: 'rotation', rotationDays: 7, rotationBucket: 0 });
  const elapsed = Date.now() - before;
  eq('★ 3번째 페이지가 timeout 나도 10,000개를 전부 받는다', rows.length, 10000);
  check('★ 중복 0 — 재시도가 앞 페이지를 다시 받지 않는다',
    new Set(rows.map(r => `${r.product_id}|${r.mall}`)).size === 10000);
  /*
   * 실패한 호출은 cursors 에 기록되지 않는다(스텁이 그 전에 돌아간다).
   * 성공한 호출의 커서열이 «중복 없이 단조 증가» 면 재시도가 앞 페이지를
   * 다시 받지 않았다는 뜻이다 — 처음부터 다시 돌았다면 null 이 두 번 나온다.
   */
  const nulls = stub.stats.cursors.filter(c => c === null).length;
  eq('★ 커서가 처음으로 되돌아가지 않는다 (null 커서는 딱 한 번)', nulls, 1);
  const keys2 = stub.stats.cursors.filter(Boolean).map(c => `${c.mall}|${c.product_id}`);
  check('재시도가 같은 커서를 다시 쓰지 않는다 (성공한 페이지 커서는 전부 서로 다르다)',
    new Set(keys2).size === keys2.length, JSON.stringify(keys2.slice(0, 5)));
  check(`재시도 사이에 backoff 가 있다 (${elapsed}ms ≥ 2000ms)`, elapsed >= 2000);
}

{
  /* 함수가 없으면 «없다» 는 것이 그대로 올라와야 폴백을 고를 수 있다 */
  const stub = targetRpcStub(100, {
    failAt: 1,
    failWith: { code: 'PGRST202', message: 'Could not find the function public.collector_target_page' }
  });
  fakeDb.rpcCalls = []; fakeDb.rpcDefault = stub.handler;
  let threw = null;
  try { await C.fetchTargetPages({ mode: 'rotation', rotationDays: 7, rotationBucket: 0 }); }
  catch (e) { threw = e; }
  check('★ 없는 함수는 재시도하지 않고 즉시 올린다 (구형 경로로 내려갈 수 있게)',
    !!threw && /PGRST202|Could not find/.test(String(threw.rpcError && threw.rpcError.message)));
  eq('없는 함수에 재시도를 걸지 않는다 (호출 1회)', stub.stats.calls, 1);
}

{
  /* 대상 RPC 도 서버가 자르는 상황에서 전부 받아야 한다. */
  const stub = targetRpcStub(9000);
  const capped = (name, args) => {
    const r = stub.handler(name, args);
    if (name === 'collector_target_page' && r.data) r.data = r.data.slice(0, 1000);
    return r;
  };
  fakeDb.rpcCalls = []; fakeDb.rpcDefault = capped;
  const rows = await C.fetchTargetPages({ mode: 'rotation', rotationDays: 7, rotationBucket: 0 });
  eq('★ 대상 RPC 응답이 1,000으로 잘려도 9,000개를 전부 받는다', rows.length, 9000);
  check('중복 0', new Set(rows.map(r => `${r.product_id}|${r.mall}`)).size === 9000);
}

/* ================================================================
 *  3. 상품 단위 최종 상태 — 합이 대상 수와 맞는다
 * ================================================================ */
section('[3] 상품별 최종 상태 분류 (outcomes)');

eq('칸 이름이 요청받은 taxonomy 를 전부 담는다', [
  'collected', 'already_collected', 'no_match', 'blocked', 'rate_limited',
  'timeout', 'api_error', 'db_error', 'target_query_error', 'unknown'
].every(k => OUTCOME_KEYS.indexOf(k) > -1), true);

const REASON_CASES = [
  ['쿠팡 API 403: Access denied', 'blocked'],
  ['차단 상태 — 서킷 브레이커', 'blocked'],
  ['ADPICK API 429: 사용 횟수를 초과하였습니다', 'rate_limited'],
  ['분당 상한 도달 — 대기 중', 'rate_limited'],
  ['쿠팡 네트워크 응답 시간 초과 (10000ms)', 'timeout'],
  ['실행 예산 소진 (budget)', 'budget'],
  ['쿠팡 응답 파싱 실패', 'api_error'],
  ['ADPICK 네트워크 오류: fetch failed', 'api_error'],
  ['canceling statement due to statement timeout', 'db_error'],
  ['', 'unknown']
];
REASON_CASES.forEach(([reason, want]) => {
  eq(`사유 "${reason.slice(0, 32)}" → ${want}`, outcomeFromReason(reason), want);
});

/* 픽스처: 검색어 그룹마다 결과를 다르게 준다. */
function rowsFor(n, mall = '쿠팡', perGroup = 2) {
  return Array.from({ length: n }, (_, i) => ({
    product_id: `X${String(i).padStart(5, '0')}`,
    mall,
    title: `타이틀 ${i}`,
    keyword: `kw${String(Math.floor(i / perGroup)).padStart(4, '0')}`,
    link: '', image: '', vendor_item_id: '', item_id: ''
  }));
}
const NO_WRITE = async () => ({ saved: 0, recorded: 0, recordedKeys: [], rejected: 0, suspect: 0, optionMismatch: 0, errors: [] });
const NO_HINT = async () => new Map();
const NO_TODAY = async () => new Set();

async function runOnce(rows, fetchAllFn, extra = {}) {
  return runMallCollection({
    mallName: rows[0].mall, rows, fetchAllFn,
    savedState: null, deadlineTs: Date.now() + 8000,
    recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT, collectedTodayFn: NO_TODAY,
    ...extra
  });
}

function outcomeSum(o) { return OUTCOME_KEYS.reduce((t, k) => t + (Number(o[k]) || 0), 0); }

{
  /* 전부 차단 */
  const rows = rowsFor(100);
  const r = await runOnce(rows, async () => ({ ok: false, items: [], reason: '쿠팡 API 403: Access denied' }));
  eq('차단 100개: 합계 = 대상', outcomeSum(r.outcomes), r.targetProducts);
  check('차단 100개: blocked 칸에 들어간다', r.outcomes.blocked > 0, JSON.stringify(r.outcomes));
  eq('차단 100개: collected 0', r.outcomes.collected, 0);
}

{
  /* 전부 응답은 왔는데 우리 상품이 없다 → no_match */
  const rows = rowsFor(100);
  const r = await runOnce(rows, async () => ({ ok: true, items: [], allItems: [] }),
    { deadlineTs: Date.now() + 30000 });
  eq('무매칭 100개: 합계 = 대상', outcomeSum(r.outcomes), r.targetProducts);
  eq('무매칭 100개: 전부 no_match', r.outcomes.no_match, 100);
  eq('무매칭 100개: collected = 수집 성공 지표와 같다', r.outcomes.collected, r.collectorSuccessProducts);
}

{
  /* 429 와 timeout 이 섞인다 */
  const rows = rowsFor(200);
  let i = 0;
  const r = await runOnce(rows, async () => {
    i++;
    if (i % 3 === 0) return { ok: false, items: [], reason: 'ADPICK API 429: 사용 횟수를 초과하였습니다' };
    if (i % 3 === 1) return { ok: false, items: [], reason: '쿠팡 네트워크 응답 시간 초과 (10000ms)' };
    return { ok: true, items: [], allItems: [] };
  });
  eq('혼합 200개: 합계 = 대상', outcomeSum(r.outcomes), r.targetProducts);
  check('혼합 200개: rate_limited 와 timeout 이 따로 잡힌다',
    r.outcomes.rate_limited > 0 && r.outcomes.timeout > 0, JSON.stringify(r.outcomes));
}

for (const n of [1000, 10000]) {
  const rows = rowsFor(n, '쿠팡', 5);
  const r = await runOnce(rows, async () => ({ ok: true, items: [], allItems: [] }),
    { deadlineTs: Date.now() + 25000 });
  eq(`${n}개 규모: 합계 = 대상 (${r.targetProducts})`, outcomeSum(r.outcomes), r.targetProducts);
  eq(`${n}개 규모: 대상 = 입력 행 수`, r.targetProducts, n);
  check(`${n}개 규모: 한 상품이 두 칸에 들어가지 않는다`,
    outcomeSum(r.outcomes) === n);
}

{
  /* 예산/시간이 끊겨 차례가 안 온 상품은 pending/budget 이지 unknown 이 아니다 */
  const rows = rowsFor(2000, '쿠팡', 2);
  const r = await runOnce(rows, async () => {
    await new Promise(res => setTimeout(res, 5));
    return { ok: true, items: [], allItems: [] };
  }, { deadlineTs: Date.now() + 300 });
  eq('시간이 끊긴 실행: 합계 = 대상', outcomeSum(r.outcomes), r.targetProducts);
  check('★ 아직 못 돈 상품이 unknown 으로 새지 않는다',
    r.outcomes.unknown === 0, JSON.stringify(r.outcomes));
  check('그 상품들은 pending 또는 budget 에 있다',
    r.outcomes.pending + r.outcomes.budget > 0, JSON.stringify(r.outcomes));
}

/* ================================================================
 *  4. 중복 방지 · 부분 실패 후 이어받기
 * ================================================================ */
section('[4] 재실행 안전성 — 중복 없음 / 실패분만 이어받기');

{
  const rows = rowsFor(60, '쿠팡', 2);   // 검색어 30종
  const called = [];
  const fetchAll = async (kw) => { called.push(kw); return { ok: true, items: [], allItems: [] }; };

  /* 1차 실행: 시간이 짧아 일부만 돈다 */
  const r1 = await runMallCollection({
    mallName: '쿠팡', rows, fetchAllFn: async (kw) => {
      called.push(kw);
      await new Promise(res => setTimeout(res, 8));
      return { ok: true, items: [], allItems: [] };
    },
    savedState: null, deadlineTs: Date.now() + 250,
    recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT, collectedTodayFn: NO_TODAY
  });
  const firstRunCalls = called.slice();
  check('1차 실행이 중간에 멈춘다 (커서가 남는다)', !!r1.cursorKey, JSON.stringify({ cursor: r1.cursorKey, status: r1.status }));

  /* 2차 실행: 1차의 상태를 그대로 물려받는다 */
  called.length = 0;
  const saved = {
    job_date: C.kstToday(),
    cursor_key: r1.cursorKey,
    processed: r1.processed,
    total: r1.total,
    status: r1.status,
    last_result: {
      secondPassDone: r1.secondPassDone || [],
      facetDryGroups: r1.facetDryGroups || [],
      terminalOptionFailures: r1.terminalOptionFailures || [],
      optionMissStreaks: r1.optionMissStreaks || {},
      collectorCovered: r1.collectorCovered || [],
      collectorAttempted: r1.collectorAttempted || [],
      failedKeywords: r1.failedKeywords || []
    }
  };
  const r2 = await runMallCollection({
    mallName: '쿠팡', rows, fetchAllFn: fetchAll,
    savedState: saved, deadlineTs: Date.now() + 20000,
    recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT, collectedTodayFn: NO_TODAY
  });

  const overlap = called.filter(kw => firstRunCalls.indexOf(kw) > -1 && !(r1.failedKeywords || []).includes(kw));
  check('★ 2차 실행이 1차가 «성공적으로» 끝낸 검색어를 다시 부르지 않는다',
    overlap.length === 0, `겹친 검색어 ${overlap.length}개: ${overlap.slice(0, 5).join(', ')}`);
  /*
   * 1차 계획의 검색어(kwNNNN)만 센다. 회수 패스는 제목·브랜드에서 만든
   * 다른 문구를 부르므로, 그것까지 세면 «계획을 한 번씩 돌았는가» 를
   * 묻는 이 검사가 흐려진다.
   */
  const planKw = new Set([...firstRunCalls, ...called].filter(k => /^kw[0-9]{4}$/.test(k)));
  check('두 실행을 합치면 계획의 검색어 30종을 빠짐없이 부른다',
    planKw.size === 30, `고유 ${planKw.size} / 기대 30`);
  eq('2차 실행 뒤 합계 = 대상', outcomeSum(r2.outcomes), r2.targetProducts);
  check('시도 상품이 하루 누적으로 이어진다 (1차 + 2차)',
    r2.attemptedProducts >= r1.attemptedProducts, `${r1.attemptedProducts} → ${r2.attemptedProducts}`);
}

{
  /* 실패한 검색어만 다시 돈다 */
  const rows = rowsFor(20, '쿠팡', 2);   // 10종
  const saved = {
    job_date: C.kstToday(),
    cursor_key: 'kw0009',           // 커서는 끝까지 갔다
    processed: 20, total: 20, status: 'running',
    last_result: { failedKeywords: ['kw0003', 'kw0007'], collectorCovered: [], collectorAttempted: [] }
  };
  const called = [];
  await runMallCollection({
    mallName: '쿠팡', rows,
    fetchAllFn: async (kw) => { called.push(kw); return { ok: true, items: [], allItems: [] }; },
    savedState: saved, deadlineTs: Date.now() + 20000,
    recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT, collectedTodayFn: NO_TODAY
  });
  const retried = called.filter(kw => kw === 'kw0003' || kw === 'kw0007');
  check('★ 직전 실행에서 실패한 검색어가 다시 시도된다', retried.length === 2, JSON.stringify(called.slice(0, 12)));
  check('커서 앞의 성공한 검색어는 다시 부르지 않는다',
    called.filter(kw => kw === 'kw0000' || kw === 'kw0001').length === 0, JSON.stringify(called.slice(0, 12)));
}

{
  /* 오늘 이미 가격이 있는 상품은 다시 부르지 않는다 = 중복 수집 방지 */
  const rows = rowsFor(20, '쿠팡', 2);
  const already = new Set(rows.slice(0, 10).map(p => `${p.product_id}|${p.mall}`));
  const r = await runMallCollection({
    mallName: '쿠팡', rows,
    fetchAllFn: async () => ({ ok: true, items: [], allItems: [] }),
    savedState: { job_date: C.kstToday(), cursor_key: '', processed: 0, total: 20, status: 'running', last_result: {} },
    deadlineTs: Date.now() + 20000,
    recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
    collectedTodayFn: async () => already
  });
  eq('★ 오늘 이미 기록된 10개가 already_collected 로 잡힌다', r.outcomes.already_collected, 10);
  eq('합계 = 대상', outcomeSum(r.outcomes), r.targetProducts);
}

/* ================================================================
 *  5. 리포트 불변조건 — 합이 안 맞으면 메일이 나가기 전에 잡힌다
 * ================================================================ */
section('[5] 리포트 불변조건');

{
  const base = {
    targetProducts: 100,
    collectorSuccessProducts: 40, collectorMissingProducts: 60,
    attemptedProducts: 70, skippedProducts: 30, noMatchProducts: 30,
    todayPriceProducts: 45, uncoveredProducts: 55,
    attemptCalls: 10, attemptSuccess: 6, attemptFailed: 4,
    failCats: { blocked: 4 },
    recorded: 40, saved: 40
  };
  const good = { ...base, outcomes: { ...outcomesTemplate(), collected: 40, already_collected: 5, no_match: 30, pending: 25 } };
  eq('맞는 리포트는 위반 0', reportInvariantErrors(good).length, 0);

  const badSum = { ...base, outcomes: { ...outcomesTemplate(), collected: 40, no_match: 30 } };
  const v1 = reportInvariantErrors(badSum);
  check('★ 분류 합계가 대상과 다르면 잡는다', v1.some(m => /최종 상태/.test(m)), JSON.stringify(v1));

  const badCollected = { ...base, outcomes: { ...outcomesTemplate(), collected: 39, already_collected: 6, no_match: 30, pending: 25 } };
  const v2 = reportInvariantErrors(badCollected);
  check('★ collected 와 수집 성공 지표가 어긋나면 잡는다',
    v2.some(m => /collected/.test(m)), JSON.stringify(v2));
}

/* ================================================================
 *  6. 실패 단계 이름 — 오늘 난 오류가 target_query_error 로 분류된다
 * ================================================================ */
section('[6] 실행 자체가 죽었을 때의 단계 분류');

eq('★ 2026-09-22 운영 오류가 target_query_error 로 분류된다',
  failureStage(new Error('collector_target_products 조회 실패: canceling statement due to statement timeout')),
  'target_query_error');
eq('새 키셋 RPC 오류도 같은 칸', failureStage(new Error('collector_target_page 조회 실패: timeout')), 'target_query_error');
eq('상시 추적 캐시 오류도 같은 칸', failureStage(new Error('collector_eligible_products 조회 실패: x')), 'target_query_error');
eq('진행 상태 표 오류는 state_error', failureStage(new Error('price_job_state 를 읽지 못했습니다 [DB_TIMEOUT]')), 'state_error');
eq('그 밖의 DB 오류는 db_error', failureStage(new Error('products 조회 실패: canceling statement due to statement timeout')), 'db_error');
eq('분류할 수 없으면 unknown', failureStage(new Error('무언가 이상함')), 'unknown');

/* ================================================================
 *  7. 배치 계획 — 규모가 커져도 그룹을 쪼개지 않는다
 * ================================================================ */
section('[7] 배치 계획의 규모 불변성');

for (const n of [100, 1000, 10000, 60000]) {
  const rows = rowsFor(n, '쿠팡', 6);
  const plan = buildPlan(rows, new Map());
  const batches = splitBatches(plan, C.BATCH_PRODUCTS);
  const planned = batches.reduce((t, b) => t + b.reduce((m, g) => m + g.rows.length, 0), 0);
  eq(`${n}개: 배치에 담긴 상품 수 = 전체`, planned, n);
  const kws = batches.flat().map(g => g.kw);
  check(`${n}개: 같은 검색어가 두 배치에 걸치지 않는다 (호출 낭비 방지)`,
    new Set(kws).size === kws.length);
  check(`${n}개: 커서 뒤만 남기면 정확히 나머지가 된다`,
    resumeFrom(plan, plan[0].kw).length === plan.length - 1);
}


}

/* ================================================================ */
main().then(() => {
console.log('=== 수집기 규모·내구성 테스트 ===');
console.log(lines.join('\n'));
console.log('');
console.log('='.repeat(52));
console.log(`PASS ${pass}  /  FAIL ${fail}`);
if (fail > 0) process.exit(1);
}).catch(e => { console.error('테스트 실행 중 예외:', e); process.exit(1); });
