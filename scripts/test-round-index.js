#!/usr/bin/env node
/*
 * 라운드 인덱스 불변식 테스트 — 외부 호출 0회 / 운영 DB 접근 0회.
 *
 *   node scripts/test-round-index.js
 *
 * ── 왜 이 파일이 있는가 ─────────────────────────────────────────
 *
 * 2026-08-31 구현 도중 실제로 났던 버그를 고정한다.
 *
 *   회수 패스는 상품마다 후보를 [q0, q1, q2] 로 만들고 라운드 N 에서
 *   qs[N] 을 쓴다. 그런데 라운드마다 "이미 부른 검색어"를 exclude 로
 *   넘겨 후보를 **다시 만들면** 배열이 앞으로 밀린다.
 *
 *     R0  [q0, q1, q2]          → qs[0] = q0   (q0 호출)
 *     R1  q0 을 빼고 재생성
 *         [q1, q2]              → qs[1] = q2   ← q1 을 영영 안 부른다
 *
 *   q1(브랜드+마지막명사)은 실측 단독 적중률 78.6% 짜리 후보다. 그게
 *   조용히 사라져도 화면에는 아무 표시가 없고, 수집률만 떨어진다.
 *
 * ── 층을 나눠 본다 ──────────────────────────────────────────────
 *
 *   생성 층 (api/_query.js)
 *     priorSecondDone(이전 실행에서 이미 부른 것)만 exclude 로 받아
 *     후보 배열을 만든다. 이 배열은 그 실행 내내 바뀌지 않는다.
 *
 *   선택 층 (collect-all-prices.js 라운드 루프)
 *     배열은 읽기만 한다. 이번 실행 중 부른 검색어(alreadyTried)는
 *     **건너뛰기만** 하고 배열을 splice/filter/rebuild 하지 않는다.
 *     그래서 뒤 라운드의 후보가 앞으로 당겨지지 않는다.
 */
'use strict';

const path = require('path');
const Module = require('module');

process.env.PRICE_BATCH_INTERVAL_MS = '1';
process.env.PRICE_BATCH_PRODUCTS = '1000';
delete process.env.PRICE_SECOND_PASS;
delete process.env.PRICE_SECOND_PASS_MAX_CALLS;
delete process.env.PRICE_SECOND_PASS_ROUNDS;

/* ── 가짜 Supabase (운영 DB 에 닿지 않는다) ── */
const saved = { price_history: [], products: [] };
function chain(table) {
  const c = {
    select: () => c, in: () => c, eq: () => c, lt: () => c, gte: () => c,
    not: () => c, order: () => c, limit: () => c, range: () => c, update: () => c,
    upsert(rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      if (!saved[table]) saved[table] = [];
      saved[table].push(...list);
      return Promise.resolve({ data: list, error: null });
    },
    then: (res) => Promise.resolve({ data: [], error: null }).then(res)
  };
  return c;
}
function inject(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p;
  require.cache[p].loaded = true;
  require.cache[p].exports = exports;
}
inject('api/_supabase.js', { from: t => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) });
inject('api/_notify.js', { send: () => Promise.resolve({ ok: true }) });

const { runMallCollection } = require('./collect-all-prices');
const { generateSecondPassQueries } = require('../api/_query');

/* 운영 DB 에 절대 쓰지 않는 저장 훅 — test-price-mall-collection.js 의 같은 주석 참고. */
/* 캐시 힌트 조회는 운영 테이블 전체 스캔이라 테스트에서는 막는다. */
const NO_HINT = async () => new Map();
const NO_WRITE = async (obs) => ({ saved: obs.length, recorded: obs.length,
  recordedKeys: [...new Set(obs.map(o => o.productId + "|" + o.mall))], rejected: 0, suspect: 0, errors: [] });

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}
function section(n) { console.log(`\n${n}`); }

const prod = (id, title, keyword) =>
  ({ product_id: id, mall: '쿠팡', title, keyword: keyword || '', link: '', image: '' });
const FAR = () => Date.now() + 10 * 60 * 1000;

/**
 * 회수 패스를 돌리고, 1차 검색어를 뺀 "회수용 호출"만 순서대로 돌려준다.
 * 응답은 항상 비어 있게 해서 라운드가 끝까지 돌게 한다.
 */
async function runAndCollectQueries(rows, opts) {
  const o = opts || {};
  const firstKw = new Set(rows.map(p => p.keyword).filter(Boolean));
  const seen = [];
  await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
    mallName: '쿠팡', rows,
    savedState: o.savedState || null,
    deadlineTs: FAR(),
    fetchAllFn: async (kw) => {
      if (!firstKw.has(kw)) seen.push(kw);
      return { ok: true, reason: '', items: [] };
    }
  });
  return seen;
}

(async () => {
  console.log('=== 라운드 인덱스 불변식 테스트 ===');

  /* ==============================================================
   *  A. 3라운드 고정 인덱스
   * ============================================================== */
  section('A. round 0→q0, round 1→q1, round 2→q2');
  {
    const p = prod('A1', '알파 베타 감마 델타', '공통키워드');
    const expect = generateSecondPassQueries(p, { exclude: [] });
    check(expect.length === 3, '픽스처가 후보 3개를 만든다', expect);

    saved.price_history = [];
    const seen = await runAndCollectQueries([p]);

    check(seen.length === 3, '★★ 라운드 수만큼 호출한다', seen);
    check(seen[0] === expect[0], '★★ round 0 → q0', { got: seen[0], want: expect[0] });
    check(seen[1] === expect[1], '★★ round 1 → q1', { got: seen[1], want: expect[1] });
    check(seen[2] === expect[2], '★★ round 2 → q2', { got: seen[2], want: expect[2] });
    check(JSON.stringify(seen) === JSON.stringify(expect),
      '★★ 전체 순서가 후보 배열과 정확히 같다', { seen, expect });
  }

  /* ==============================================================
   *  B. 중복 skip — 건너뛰어도 뒤 후보가 앞으로 당겨지지 않는다
   *
   *  구성: P_B 의 q0 == P_A 의 q1 ("알파 델타")
   *    round 0  P_A→"알파 베타 감마 델타",  P_B→"알파 델타"   둘 다 호출
   *    round 1  P_A 의 q1 = "알파 델타" → 이미 부름 → **건너뛴다**
   *    round 2  P_A 의 q2 = "알파 베타 감마" → 반드시 호출된다
   *
   *  버그가 있으면 round 1 에서 q2 가 당겨져 호출되고, round 2 는
   *  아무것도 안 부른다.
   * ============================================================== */
  section('B. 이미 부른 검색어를 건너뛰어도 인덱스가 밀리지 않는다');
  {
    const pA = prod('B1', '알파 베타 감마 델타', '공통키워드');
    const pB = prod('B2', '알파 델타', '공통키워드');
    const qA = generateSecondPassQueries(pA, { exclude: [] });   // [full, "알파 델타", "알파 베타 감마"]
    const qB = generateSecondPassQueries(pB, { exclude: [] });   // ["알파 델타"]

    check(qA[1] === qB[0],
      '픽스처 전제: P_A 의 q1 과 P_B 의 q0 이 같은 문구다', { q1: qA[1], q0: qB[0] });

    saved.price_history = [];
    const seen = await runAndCollectQueries([pA, pB]);

    check(seen.filter(q => q === qA[1]).length === 1,
      '★★ 겹치는 검색어는 딱 한 번만 호출된다', seen);
    check(seen.includes(qA[2]),
      '★★ 건너뛴 뒤에도 q2 가 반드시 호출된다 (사라지지 않는다)', seen);

    // q2 는 q1 보다 뒤에 호출돼야 한다 = 앞으로 당겨지지 않았다
    const iQ1 = seen.indexOf(qA[1]);
    const iQ2 = seen.indexOf(qA[2]);
    check(iQ1 > -1 && iQ2 > -1 && iQ2 > iQ1,
      '★★ q2 가 q1 자리로 당겨지지 않았다 (호출 순서가 뒤)', { seen, iQ1, iQ2 });
    check(new Set(seen).size === seen.length,
      '★★ 같은 검색어를 두 번 부르지 않는다', seen);
  }

  /* ==============================================================
   *  C. 이전 실행분(priorSecondDone)은 생성 단계에서 제외된다
   *
   *  ※ B 와 층이 다르다.
   *    B  = 이번 실행 중 부른 것 → 배열은 그대로, 선택에서만 건너뛴다
   *    C  = 지난 실행에서 부른 것 → 애초에 후보로 만들지 않는다
   *  둘을 섞으면 안 된다. 지난 실행 것까지 배열에 남겨 두면 라운드가
   *  이미 소진된 검색어에 낭비된다.
   * ============================================================== */
  section('C. priorSecondDone 은 생성 단계에서 제외');
  {
    const p = prod('C1', '알파 베타 감마 델타', '공통키워드');
    const full = generateSecondPassQueries(p, { exclude: [] });
    const q0 = full[0];

    const excluded = generateSecondPassQueries(p, { exclude: [q0] });
    check(!excluded.includes(q0), '★★ exclude 한 검색어가 후보에서 빠진다', excluded);
    check(excluded.length === full.length - 1, '★ 정확히 하나만 줄어든다', { full, excluded });
    check(excluded[0] === full[1] && excluded[1] === full[2],
      '★ 남은 후보의 상대 순서는 유지된다', { full, excluded });

    // 통합: 이전 실행 상태를 물려받으면 그 검색어를 다시 부르지 않는다
    const savedState = {
      job_date: require('./collect-all-prices').kstToday(new Date()),
      cursor_key: '공통키워드', processed: 1, total: 1, status: 'running',
      last_result: { failedKeywords: [], secondPassDone: [q0] }
    };
    saved.price_history = [];
    const seen = await runAndCollectQueries([p], { savedState });
    check(!seen.includes(q0),
      '★★ 지난 실행에서 부른 검색어를 이번 실행이 다시 부르지 않는다', seen);
    check(seen.length > 0, '★ 나머지 후보는 정상적으로 호출된다', seen);
  }

  /* ==============================================================
   *  D. 재현성 — 같은 입력이면 항상 같은 배열
   * ============================================================== */
  section('D. 재현성');
  {
    const p = prod('D1', '루이벤 암막 정전기 강력흡수 차량용 햇빛가리개', '차량용 햇빛 가리개');
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(generateSecondPassQueries(p, { exclude: [] }));
    const first = JSON.stringify(runs[0]);
    check(runs.every(r => JSON.stringify(r) === first),
      '★★ 같은 fixture 를 5번 생성해도 배열이 동일하다', runs[0]);

    const withEx = [];
    for (let i = 0; i < 5; i++) withEx.push(generateSecondPassQueries(p, { exclude: [runs[0][0]] }));
    check(withEx.every(r => JSON.stringify(r) === JSON.stringify(withEx[0])),
      '★★ 같은 exclude 로도 매번 동일하다', withEx[0]);

    // 실행을 두 번 돌려도 호출 순서가 같다
    saved.price_history = [];
    const s1 = await runAndCollectQueries([p]);
    saved.price_history = [];
    const s2 = await runAndCollectQueries([p]);
    check(JSON.stringify(s1) === JSON.stringify(s2),
      '★★ 같은 조건으로 두 번 실행하면 호출 순서가 같다', { s1, s2 });
  }

  /* ==============================================================
   *  E. 후보 수 < 라운드 수 — 예외 없이 안전하게 끝난다
   * ============================================================== */
  section('E. 후보가 라운드보다 적을 때');
  {
    const p = prod('E1', '브랜드 하나', '공통키워드');
    const qs = generateSecondPassQueries(p, { exclude: [] });
    check(qs.length < 3, '픽스처가 3개 미만의 후보를 만든다', qs);

    saved.price_history = [];
    let threw = null;
    let seen = [];
    try { seen = await runAndCollectQueries([p]); }
    catch (e) { threw = e.message; }

    check(threw === null, '★★ 예외가 나지 않는다', threw);
    check(seen.length === qs.length,
      '★★ 있는 후보만큼만 호출한다 (없는 라운드는 조용히 건너뛴다)', { seen, qs });
    check(seen.every(q => q && q.trim()), '★★ 빈 검색어를 호출하지 않는다', seen);

    // 후보가 아예 없는 상품도 안전해야 한다
    const empty = prod('E2', '', '공통키워드');
    saved.price_history = [];
    let threw2 = null, seen2 = [];
    try { seen2 = await runAndCollectQueries([empty]); }
    catch (e) { threw2 = e.message; }
    check(threw2 === null && seen2.length === 0,
      '★★ 후보가 하나도 없는 상품도 예외 없이 넘어간다', { threw2, seen2 });
  }

  /* ==============================================================
   *  F. 구조 불변식 — 코드 모양으로 고정
   * ============================================================== */
  section('F. 구조 불변식');
  {
    const src = require('fs').readFileSync(
      path.join(__dirname, 'collect-all-prices.js'), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

    check((code.match(/generateSecondPassQueries\(/g) || []).length === 1,
      '★★ 후보 생성 호출이 수집기에 정확히 1회', (code.match(/generateSecondPassQueries\(/g) || []).length);

    const gen = code.indexOf('generateSecondPassQueries(');
    const loop = code.indexOf('for (let round = 0');
    check(gen > -1 && loop > -1 && gen < loop,
      '★★ 생성이 라운드 루프보다 앞에 있다', { gen, loop });

    check(/const q = qs\[round\];/.test(code),
      '★★ 라운드는 qs[round] 로만 후보를 고른다');

    /*
     * 후보 배열을 다시 만드는 흔적이 없어야 한다.
     *
     * ★ 겨냥하는 것은 **후보 배열(qs)** 뿐이다.
     *   루프 안에는 상품 목록을 거르는 filter 가 정상적으로 있다.
     *     [...uncovered.values()].filter(eligible)   ← 회수 대상 상품 선별
     *     rows.filter(p => uncovered.has(...))       ← 그룹 내 미수집 상품 선별
     *   이건 후보 인덱스와 아무 관계가 없다. 처음에 루프 안의 모든
     *   .filter( 를 금지했더니 이 두 줄이 걸렸는데, 그건 테스트가 너무
     *   넓게 잡은 것이지 코드 문제가 아니었다. 검사 대상을 좁힌다.
     */
    const loopBody = code.slice(loop, code.indexOf('secondPassRemaining +=', loop));

    /*
     * qs 에 대한 대입은 "계획에서 꺼내 읽는" 한 줄만 허용된다.
     *   const qs = queryPlan.get(...)      ← 읽기 (허용)
     *   qs = generateSecondPassQueries(..) ← 재생성 (금지)
     *   qs = qs.filter(...)                ← 변형 (금지)
     * 허용된 줄을 지운 뒤에도 qs 대입이 남으면 실패다.
     */
    const allowedRead = /const qs = queryPlan\.get\([^)]*\);/g;
    const loopSansRead = loopBody.replace(allowedRead, '');
    check(!/\bqs\s*=[^=]/.test(loopSansRead),
      '★★ 후보 배열(qs)은 계획에서 읽기만 하고 재할당하지 않는다',
      (loopSansRead.match(/.*\bqs\s*=[^=].*/g) || []).slice(0, 2));
    check(!/\bqs\.(splice|filter|shift|pop|push|sort|reverse)\(/.test(loopBody),
      '★★ 후보 배열(qs)을 변형하는 호출이 없다');
    check(!/generateSecondPassQueries\(/.test(loopBody),
      '★★ 라운드 루프 안에서 후보를 재생성하지 않는다');
    check(!/queryPlan\.set\(/.test(loopBody),
      '★★ 라운드 루프 안에서 후보 계획을 덮어쓰지 않는다');

    check(/exclude: \[\.\.\.priorSecondDone\]/.test(code),
      '★★ 생성 시 exclude 는 priorSecondDone 만 쓴다 (alreadyTried 아님)');

    check(/if \(alreadyTried\.has\(q\)\) return;/.test(code),
      '★★ alreadyTried 는 건너뛰기로만 처리한다');

    /*
     * product_id 게이트 유지.
     *
     * 2026-09-03 에 판정이 두 겹이 됐다 — product_id 완전 일치(여기)에 더해
     * vendorItemId(판매 단위) 일치를 pickOption 이 본다. 쿠팡 productId 아래
     * 옵션이 여럿이라 productId 만으로는 다른 옵션 가격이 붙기 때문이다.
     * 게이트가 있는 자리(1차 processGroup / 2차 callAndMatch)는 그대로다.
     */
    check((code.match(/byId\.get\(pid\)/g) || []).length === 2,
      '★★ product_id 완전 일치 게이트가 1차·2차 두 곳에 그대로 있다',
      (code.match(/byId\.get\(pid\)/g) || []).length);
    check(/pickOption\(target, items\)/.test(code),
      '★★ 채택은 판매 단위(vendorItemId)까지 확인한 뒤에만 이뤄진다');

    // rate limit 불변
    check(/const COUPANG_MIN_GAP_MS\s*=\s*6000;/.test(src),
      '★★ COUPANG_MIN_GAP_MS 6000 유지');
    const cou = require('fs').readFileSync(path.join(__dirname, '..', 'api', '_coupang.js'), 'utf8');
    check(/COUPANG_MAX_PER_MIN', 20\)/.test(cou), '★★ 쿠팡 분당 상한 20 유지');
    const adp = require('fs').readFileSync(path.join(__dirname, '..', 'api', '_adpick.js'), 'utf8');
    check(/ADPICK_MAX_PER_MIN', 20\)/.test(adp), '★★ ADPICK 분당 상한 20 유지');
  }

  /* ==============================================================
   *  G. 운영 DB 에 아무것도 쓰지 않았다
   * ============================================================== */
  section('G. DB 안전성');
  {
    check(saved.price_history.length === 0,
      '★★ 이 테스트가 price_history 에 한 행도 쓰지 않았다', saved.price_history.length);
    check(saved.products.length === 0,
      '★★ products 에도 쓰지 않았다', saved.products.length);
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(1); });
