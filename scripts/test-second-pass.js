#!/usr/bin/env node
/*
 * 2차 패스(P0-1) + 배치 간격(P0-2) 테스트 — 외부 호출 0회 / 운영 DB 접근 0회.
 *
 *   node scripts/test-second-pass.js
 *
 * ── 왜 이 파일이 있는가 ─────────────────────────────────────────
 *
 * 2026-08-31 감사에서 운영 DB 를 읽어(SELECT 만) 확인한 것:
 *
 *   쿠팡 1,401개 중 어제 하루 수집 724개 (51.7%)
 *   limit(10) 초과 검색어 그룹 25종 → 구조적으로 못 받는 상품 266개 (19.0%)
 *   "수영복"        상품 32개 → 3일간 0개 수집
 *   "여행용 캐리어"  상품 43개 → 17개 (39.5%)
 *
 * 쿠팡 검색 API 는 한 번에 10건까지만 주고 offset 이 없다. 한 검색어에
 * 10개 넘는 상품이 묶여 있으면 나머지는 **매일** 누락된다 — retry 로도
 * backoff 로도 복구되지 않는 구조적 결손이다.
 *
 * 2차 패스는 1차에서 못 잡은 상품만 골라, 제목에서 뽑은 **더 좁은**
 * 검색어로 한 번 더 찾는다.
 *
 * ── 이 테스트가 지키는 것 ───────────────────────────────────────
 *
 *   ① 1차에서 놓친 상품이 2차에서 회수된다
 *   ② 검색어를 바꿔도 **다른 product_id 는 절대 저장되지 않는다**
 *   ③ 2차에서도 못 찾으면 NOT FOUND 로 남는다 (지어내지 않는다)
 *   ④ 그룹 크기가 limit 을 넘어도 초과분이 재탐색된다
 *   ⑤ 기존 rate limit / 예산 / 차단을 2차 패스가 우회하지 않는다
 *   ⑥ BATCH_INTERVAL_MS 기본값이 15초다
 *
 * ★ ②가 이 파일의 핵심이다. 수집률을 올리려고 매칭을 느슨하게 하면
 *   사용자에게 다른 상품의 가격을 보여주게 된다 — 그건 누락보다 나쁘다.
 */
'use strict';

const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

/* 배치 대기를 1ms 로 만들어 테스트가 몇 분씩 자지 않게 한다.
   (기본값 15초 자체는 아래 [6] 에서 소스로 확인한다) */
process.env.PRICE_BATCH_INTERVAL_MS = '1';
process.env.PRICE_BATCH_PRODUCTS = '1000';   // 한 배치에 다 들어가게
delete process.env.PRICE_SECOND_PASS;
delete process.env.PRICE_SECOND_PASS_MAX_CALLS;

/* ------------------------------------------------------------------ *
 *  가짜 Supabase — recordPrices 가 쓰는 것만 흉내 낸다.
 *  운영 DB 에 절대 닿지 않는다.
 * ------------------------------------------------------------------ */
const saved = { price_history: [], products: [] };

function makeChain(table) {
  const chain = {
    select() { return chain; },
    in() { return chain; },
    eq() { return chain; },
    lt() { return chain; },
    gte() { return chain; },
    not() { return chain; },
    order() { return chain; },
    limit() { return chain; },
    range() { return chain; },
    upsert(rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      if (!saved[table]) saved[table] = [];
      saved[table].push(...list);
      return Promise.resolve({ data: list, error: null });
    },
    update() { return chain; },
    then(res) { return Promise.resolve({ data: [], error: null }).then(res); }
  };
  return chain;
}
const fakeSupabase = { from: t => makeChain(t), rpc: () => Promise.resolve({ data: null, error: null }) };

function inject(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p;
  require.cache[p].loaded = true;
  require.cache[p].exports = exports;
}
inject('api/_supabase.js', fakeSupabase);
inject('api/_notify.js', { send: () => Promise.resolve({ ok: true }) });

const { runMallCollection } = require('./collect-all-prices');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}
function section(n) { console.log(`\n${n}`); }

const prod = (id, title, keyword) =>
  ({ product_id: id, mall: '쿠팡', title, keyword: keyword || '', link: '', image: '' });
const item = (id, price) =>
  ({ productId: id, title: 't' + id, lprice: price, oprice: price,
     link: 'https://x/' + id, image: '', mall: '쿠팡', itemId: '', vendorItemId: '' });
const FAR = () => Date.now() + 10 * 60 * 1000;

/** 자식 프로세스에서 env 를 바꿔 2차 패스를 돌리고 결과 JSON 을 받는다. */
function probeChild(envLines) {
  const src = `
    process.env.PRICE_BATCH_INTERVAL_MS='1';
    process.env.PRICE_BATCH_PRODUCTS='1000';
    ${envLines}
    const path=require('path'), Module=require('module');
    const DIR=${JSON.stringify(__dirname)};
    function inject(rel,ex){const p=require.resolve(path.join(DIR,'..',rel));
      require.cache[p]=new Module(p,null);require.cache[p].filename=p;
      require.cache[p].loaded=true;require.cache[p].exports=ex;}
    inject('api/_supabase.js',{from:()=>{const c={select:()=>c,in:()=>c,eq:()=>c,lt:()=>c,gte:()=>c,
      not:()=>c,order:()=>c,limit:()=>c,range:()=>c,
      upsert:()=>Promise.resolve({data:[],error:null}),update:()=>c,
      then:r=>Promise.resolve({data:[],error:null}).then(r)};return c;},
      rpc:()=>Promise.resolve({data:null,error:null})});
    inject('api/_notify.js',{send:()=>Promise.resolve({ok:true})});
    const {runMallCollection}=require(path.join(DIR,'collect-all-prices.js'));
    const rows=[];
    for(let i=0;i<5;i++)rows.push({product_id:'Q'+i,mall:'쿠팡',
      title:'브랜드'+i+' 아주 구체적인 상품 이름 표기',keyword:'공통'});
    let narrow=0;
    runMallCollection({mallName:'쿠팡',rows,savedState:null,deadlineTs:Date.now()+600000,
      fetchAllFn:async(kw)=>{ if(kw!=='공통') narrow++; return {ok:true,reason:'',items:[]}; }})
      .then(r=>console.log('__R__'+JSON.stringify({secondCalls:r.secondPassCalls,narrow})));
  `;
  let out = '';
  try { out = execFileSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 90000 }); }
  catch (e) { out = String((e.stdout || '') + (e.stderr || '')); }
  const m = out.match(/__R__(\{.*\})/);
  try { return m ? JSON.parse(m[1]) : { _raw: out.slice(-300) }; }
  catch (e) { return { _raw: out.slice(-300) }; }
}

(async () => {
  console.log('=== 2차 패스 · 배치 간격 테스트 ===');

  /* ==============================================================
   *  1. 1차에서 놓친 상품이 2차에서 회수된다
   * ============================================================== */
  section('1. 1차에서 놓친 상품 회수');
  {
    const rows = [
      prod('A', '아레나 여성 수영복 원피스 블랙', '수영복'),
      prod('B', '나이키스윔 여성 수영복 블루밍 도트', '수영복'),
      prod('C', '스피도 남성 수영복 트렁크 네이비', '수영복')
    ];
    const calls = [];
    const fetchAllFn = async (kw) => {
      calls.push(kw);
      if (kw === '수영복') return { ok: true, reason: '', items: [item('A', 10000)] };
      if (kw.indexOf('나이키스윔') === 0) return { ok: true, reason: '', items: [item('B', 20000)] };
      if (kw.indexOf('스피도') === 0)     return { ok: true, reason: '', items: [item('C', 30000)] };
      return { ok: true, reason: '', items: [] };
    };

    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, savedState: null, deadlineTs: FAR()
    });

    check(calls[0] === '수영복', '★ 1차는 기존 검색어 그대로 부른다', calls);
    check(calls.length > 1, '★ 1차에서 못 잡은 상품이 있으면 2차 호출이 나간다', calls);
    check(r.secondPassRecovered === 2, '★★ 1차에서 놓친 2개를 2차에서 회수했다', r);
    check(r.uncoveredProducts === 0, '★★ 결과적으로 미수집 0개', r.uncoveredProducts);
    check(r.secondPassCalls >= 2, '2차 호출 수가 기록된다', r.secondPassCalls);
  }

  /* ==============================================================
   *  2. ★★ 다른 product_id 는 절대 저장되지 않는다 (이 파일의 핵심)
   * ============================================================== */
  section('2. 오매칭 방지 — product_id 완전 일치만 채택');
  {
    const rows = [prod('WANT', '아레나 여성 수영복 원피스 블랙', '수영복')];
    // 2차 검색이 "비슷하지만 다른 상품"만 잔뜩 돌려준다 — 제목까지 같은 것 포함.
    const fetchAllFn = async (kw) => {
      if (kw === '수영복') return { ok: true, reason: '', items: [] };
      return { ok: true, reason: '', items: [
        item('OTHER1', 9900), item('OTHER2', 12000), item('OTHER3', 15000),
        { ...item('LOOKALIKE', 11000), title: '아레나 여성 수영복 원피스 블랙' }
      ] };
    };

    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, savedState: null, deadlineTs: FAR()
    });

    check(r.secondPassRecovered === 0,
      '★★ 제목이 똑같아도 product_id 가 다르면 채택하지 않는다', r.secondPassRecovered);
    check(r.uncoveredProducts === 1, '★★ 그 상품은 미수집으로 남는다 (NOT FOUND)', r.uncoveredProducts);
    const bad = saved.price_history.filter(h => h.product_id && h.product_id !== 'WANT');
    check(bad.length === 0, '★★ 다른 product_id 가 단 한 건도 저장되지 않았다', bad.slice(0, 3));
    check(saved.price_history.length === 0, '★★ price_history 에 아무것도 안 들어갔다', saved.price_history.length);
  }

  /* ==============================================================
   *  3. 2차에서도 못 찾으면 NOT FOUND
   * ============================================================== */
  section('3. 못 찾으면 지어내지 않는다');
  {
    const rows = [
      prod('X', '단종된 무슨무슨 상품 이름', '단종상품'),
      prod('Y', '또 다른 없는 상품 이름표기', '단종상품')
    ];
    const fetchAllFn = async () => ({ ok: true, reason: '', items: [] });

    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, savedState: null, deadlineTs: FAR()
    });

    check(r.uncoveredProducts === 2, '★ 응답이 비면 2개 모두 미수집으로 남는다', r.uncoveredProducts);
    check(r.secondPassRecovered === 0, '회수 0개', r.secondPassRecovered);
    check(saved.price_history.length === 0, '★★ 빈 응답으로 가짜 행을 만들지 않는다', saved.price_history.length);
    check(r.recorded === 0, '기록 0행', r.recorded);
  }

  /* ==============================================================
   *  4. 그룹 크기가 limit 을 넘어도 초과분이 재탐색된다
   * ============================================================== */
  section('4. limit(10) 초과 그룹의 초과분 재탐색');
  {
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push(prod('P' + i, `브랜드${i} 여행용 캐리어 20인치 하드`, '여행용 캐리어'));
    }
    const seen = [];
    const fetchAllFn = async (kw) => {
      seen.push(kw);
      if (kw === '여행용 캐리어') {
        // 쿠팡 API 상한 10건
        return { ok: true, reason: '', items: rows.slice(0, 10).map((p, i) => item(p.product_id, 50000 + i)) };
      }
      const m = /브랜드(\d+)/.exec(kw);
      if (!m) return { ok: true, reason: '', items: [] };
      return { ok: true, reason: '', items: [item('P' + m[1], 60000)] };
    };

    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, savedState: null, deadlineTs: FAR()
    });

    check(r.secondPassRecovered === 2,
      '★★ API 상한(10) 때문에 못 받은 2개를 2차에서 회수했다', r.secondPassRecovered);
    check(r.uncoveredProducts === 0, '★★ 12개 전부 수집', r.uncoveredProducts);
    check(seen.filter(k => k === '여행용 캐리어').length === 1,
      '★ 1차 검색어를 두 번 부르지 않는다', seen.filter(k => k === '여행용 캐리어').length);
  }

  /* ==============================================================
   *  5. rate limit / 예산 / 차단을 우회하지 않는다
   * ============================================================== */
  section('5. 기존 제한을 2차 패스가 우회하지 않는다');
  {
    const rows = [prod('Z', '무슨 상품 이름 하나 표기', '검색어')];
    const blockedFetch = async (kw) => (kw === '검색어')
      ? { ok: true, reason: '', items: [] }
      : { ok: false, reason: '쿠팡 차단: blocked', items: [] };

    saved.price_history = [];
    const r1 = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn: blockedFetch, savedState: null, deadlineTs: FAR()
    });
    check(r1.uncoveredProducts === 1, '★ 2차가 차단되면 미수집으로 남는다 (강행하지 않는다)', r1.uncoveredProducts);
    check(saved.price_history.length === 0, '★★ 차단 상태에서 아무것도 저장하지 않는다');

    // deadline 이 이미 지났으면 2차 호출이 나가지 않는다
    saved.price_history = [];
    let narrowCalls = 0;
    const countingFetch = async (kw) => {
      if (kw !== '검색어') narrowCalls++;
      return { ok: true, reason: '', items: [] };
    };
    await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn: countingFetch, savedState: null,
      deadlineTs: Date.now() - 1000
    });
    check(narrowCalls === 0, '★★ 시간 예산이 끝났으면 2차 호출을 시작하지 않는다', narrowCalls);

    /*
     * ★★ 1차가 아예 못 나간 상품은 2차 대상이 아니다.
     *
     * 2026-08-31 전체 dry-run 에서 실제로 터진 문제다. ADPICK 1차가 서킷
     * 브레이커로 전부 막힌 상태에서 2차가 120회를 더 호출했고 회수는 0,
     * 그 호출이 ADPICK 일일 쿼터를 갉아먹어 HTTP 429 까지 갔다.
     * 검색어를 좁혀도 막힌 API 는 똑같이 막힌다 — 그건 다음 실행의
     * 재시도 패스가 할 일이지 2차 패스가 할 일이 아니다.
     */
    saved.price_history = [];
    let narrowAfterBlock = 0;
    const allBlocked = async (kw) => {
      if (kw !== '검색어') narrowAfterBlock++;
      return { ok: false, reason: '쿠팡 차단: blocked', items: [] };
    };
    const rBlocked = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn: allBlocked, savedState: null, deadlineTs: FAR()
    });
    check(narrowAfterBlock === 0,
      '★★ 1차 호출이 못 나갔으면 2차 호출을 시도조차 하지 않는다 (쿼터 낭비 방지)', narrowAfterBlock);
    check(rBlocked.secondPassCalls === 0, '★★ 그 경우 2차 호출 수가 0이다', rBlocked.secondPassCalls);
    check(rBlocked.failedKeywords.length === 1,
      '★ 대신 재시도 대상(failedKeywords)으로 남아 다음 실행이 이어받는다', rBlocked.failedKeywords);

    // 1차가 성공했지만 결과에 없었던 경우에만 2차가 돈다
    saved.price_history = [];
    let narrowAfterOk = 0;
    const okButEmpty = async (kw) => {
      if (kw !== '검색어') { narrowAfterOk++; return { ok: true, reason: '', items: [] }; }
      return { ok: true, reason: '', items: [] };
    };
    await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn: okButEmpty, savedState: null, deadlineTs: FAR()
    });
    /*
     * 2026-08-31: 2차 패스가 "1회 호출" → "라운드 사다리" 로 바뀌었다.
     *   PHASE 9  3라운드 (실측 78.6% → 85.7% → 92.9%)
     *   PHASE 10 5라운드 (T4 제목압축·T7 특수문자 정규화 추가)
     *
     * 상한을 숫자로 박아 두면 라운드를 조정할 때마다 이 테스트가 깨진다.
     * 확인해야 할 것은 "몇 회인가"가 아니라 두 가지다.
     *   ① 1차가 성공했는데 못 찾았으면 회수 패스가 실제로 돈다
     *   ② 그 상품에 만들어진 후보 수를 넘겨 부르지 않는다
     * 그래서 후보 생성기에 직접 물어본 값과 비교한다.
     */
    const { generateSecondPassQueries: genQ } = require('../api/_query');
    const maxForThisProduct = genQ(rows[0], { exclude: [] }).length;
    check(narrowAfterOk >= 1,
      '★★ 1차가 성공(ok)했는데 응답에 없으면 2차가 돈다', narrowAfterOk);
    check(narrowAfterOk <= maxForThisProduct,
      '★★ 그 상품에 만들어진 후보 수를 넘겨 부르지 않는다',
      { called: narrowAfterOk, candidates: maxForThisProduct });

    // 호출 상한
    const p1 = probeChild("process.env.PRICE_SECOND_PASS_MAX_CALLS='1';");
    check(p1.secondCalls === 1,
      '★★ PRICE_SECOND_PASS_MAX_CALLS=1 이면 2차 호출이 1회를 넘지 않는다', p1);

    // 스위치로 끌 수 있다
    const p2 = probeChild("process.env.PRICE_SECOND_PASS='0';");
    check(p2.secondCalls === 0 && p2.narrow === 0,
      '★ PRICE_SECOND_PASS=0 이면 2차 패스가 아예 돌지 않는다', p2);
  }

  /* ==============================================================
   *  6. 배치 간격 기본값 (P0-2)
   * ============================================================== */
  section('6. BATCH_INTERVAL_MS 기본값 / rate limit 불변');
  {
    const src = require('fs').readFileSync(path.join(__dirname, 'collect-all-prices.js'), 'utf8');

    const m = /const BATCH_INTERVAL_MS = Number\(process\.env\.PRICE_BATCH_INTERVAL_MS\) \|\| (\d+);/.exec(src);
    check(m && Number(m[1]) === 15000,
      '★★ 기본 배치 간격이 15,000ms 다 (60,000 → 15,000)', m && m[1]);

    check(/const COUPANG_MIN_GAP_MS\s*=\s*6000;/.test(src),
      '★★ COUPANG_MIN_GAP_MS 는 6000 그대로 — rate limit 을 우회하지 않았다');

    const cou = require('fs').readFileSync(path.join(__dirname, '..', 'api', '_coupang.js'), 'utf8');
    check(/COUPANG_MAX_PER_MIN', 20\)/.test(cou),
      '★ 분당 상한 기본값(20)이 그대로다');

    /*
     * ── 예산 hard stop 이 모든 쿠팡 호출 경로에 걸리는가 ──────────
     *
     * 수집기에서 쿠팡을 부르는 곳은 fetchAllFn 두 군데뿐이고(1차 processGroup,
     * 회수 callAndMatch — facet 도 callAndMatch 를 지난다), 쿠팡의 fetchAllFn 은
     * fetchCoupangAll 이다. 그 함수 첫머리에 예산 검사가 있어야 한다.
     *
     * 새 호출 경로를 만들면서 이 검사를 건너뛰면 예산이 무력해진다.
     */
    /* 주석을 뺀 실행 코드만 본다 — 설명 주석에 같은 문구가 있어도 세지 않게. */
    const runCode = src.split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

    check(/if \(_coupangCalls >= COUPANG_RUN_BUDGET\)/.test(runCode),
      '★★ fetchCoupangAll 에 실행 예산 hard stop 이 있다');
    /*
     * ── 왜 숫자 고정이 아니라 관계 검사인가 (2026-09-03) ──────────────
     *
     * 예전에는 "COUPANG_RUN_BUDGET 이 정확히 400" 을 고정했다. 그런데 이 값은
     * 페이스 조절 장치가 아니라 폭주 안전판이고, 실제 속도를 정하는 것은
     * COUPANG_MIN_GAP_MS(호출 간격)와 전역 분당 상한이다. 숫자 하나를 못 박으면
     * 시간 배분이 바뀔 때마다 "테스트가 막으니까" 라는 이유로 예산만 그대로
     * 두게 되고, 그러면 시간이 남는데 예산이 먼저 끊는 상태가 된다.
     *
     * 그래서 지켜야 할 **관계**를 고정한다:
     *   1) 호출 간격 6초는 그대로다             ← 실제 rate limit 방어선
     *   2) 실행 예산은 절대 상한(600) 이하       ← 예산 폭주 방지
     *   3) 회수 상한 ≤ 시간이 허용하는 호출 수   ← 안전판이 벽 노릇을 한다
     *   4) 회수 상한 < 실행 예산                ← 1차·facet 몫이 남는다
     *   5) 실행 예산 ≥ 시간이 허용하는 호출 수   ← 시간이 먼저 멈춘다
     */
    /*
     * 상수 파서 — 소스에서 숫자만 읽어 온다.
     * 정규식 이스케이프에 기대지 않고 줄을 잘라 숫자를 뽑는다(가장 앞 숫자).
     */
    const constNum = (name) => {
      const i = src.indexOf('const ' + name);
      if (i < 0) return -1;
      const eol = src.indexOf(String.fromCharCode(10), i);
      const line = src.slice(i, eol < 0 ? src.length : eol);
      const code = line.split('//')[0];
      const m = code.match(/[0-9]+/g);
      return m ? Number(m[0]) : -1;
    };
    const gapMs = constNum('COUPANG_MIN_GAP_MS');
    check(gapMs === 6000,
      '★★ 쿠팡 호출 간격 6초 유지 — 분당 호출 속도를 올리지 않았다', gapMs);

    const runBudget = constNum('COUPANG_RUN_BUDGET');
    check(runBudget > 0 && runBudget <= 600,
      '★★ COUPANG_RUN_BUDGET 이 절대 상한(600) 안에 있다', runBudget);
    check((runCode.match(/await fetchAllFn\(/g) || []).length === 2,
      '★★ 쿠팡 호출 경로가 두 곳뿐이다 (1차 · 회수) — 예산을 우회하는 샛길 없음',
      (runCode.match(/await fetchAllFn\(/g) || []).length);
    /*
     * searchCoupang 호출 지점은 딱 하나여야 하고, 그것은 예산 검사 **뒤**의
     * fetchCoupangAll 안이어야 한다.
     *
     * 처음엔 "수집기가 searchCoupang 을 직접 부르지 않는다" 로 썼다가
     * 실패했는데, 그건 잘못된 기대였다 — 어딘가에서는 불러야 하고,
     * 중요한 것은 **예산 게이트를 지난 뒤에** 부르는가다.
     */
    const budgetIdx = runCode.indexOf('_coupangCalls >= COUPANG_RUN_BUDGET');
    const callIdx = runCode.indexOf('await searchCoupang(');
    check((runCode.match(/await searchCoupang\(/g) || []).length === 1,
      '★★ searchCoupang 호출 지점이 정확히 하나다',
      (runCode.match(/await searchCoupang\(/g) || []).length);
    check(budgetIdx > -1 && callIdx > -1 && budgetIdx < callIdx,
      '★★ 그 호출은 예산 검사 뒤에 있다 (리미터·예산 우회 경로 없음)',
      { budgetIdx, callIdx });

    /*
     * 회수 패스 하위 상한.
     *
     * "시간이 먼저 걸린다" 는 관계를 소스에서 직접 계산해 고정한다. 시간
     * 배분(ADPICK_RESERVE_MS)이 바뀌면 timeCap 도 같이 움직이므로, 상수만
     * 손대고 이 관계를 깨뜨리면 여기서 잡힌다.
     *
     *   쿠팡 몫 = RUN_TIME_BUDGET_MS - ADPICK_RESERVE_MS  (최소 절반 보장)
     *   timeCap = 쿠팡 몫 ÷ COUPANG_MIN_GAP_MS
     */
    const cap    = constNum('SECOND_PASS_MAX_CALLS');
    const runMin = constNum('RUN_TIME_BUDGET_MS');   // 분 단위 (… || 50 * 60 * 1000)
    const adpMin = constNum('ADPICK_RESERVE_MS');    // 분 단위 (… ||  8 * 60 * 1000)
    check(runMin > 0 && adpMin > 0 && adpMin < runMin / 2,
      '★★ 시간 배분 상수를 소스에서 읽을 수 있고 ADPICK 몫이 절반 미만이다',
      { runMin, adpMin });
    const coupangMin = Math.max(runMin - adpMin, Math.floor(runMin / 2));
    const timeCap = Math.floor(coupangMin * 60 / (gapMs / 1000));
    check(cap > 0 && cap <= timeCap,
      '★★ 회수 상한이 시간이 허용하는 실행당 호출 수를 넘지 않는다', { cap, timeCap });
    check(cap < runBudget,
      '★★ 회수 상한이 실행 예산보다 작다 — 1차·facet 몫을 남긴다', { cap, runBudget });
    check(runBudget >= timeCap,
      '★★ 실행 예산이 시간이 허용하는 호출 수 이상이다 — 시간이 먼저 멈춘다',
      { runBudget, timeCap });
    check(/재시도 없음/.test(cou), '★ 쿠팡 클라이언트에 retry 를 추가하지 않았다');

    check(!/forceRefresh:\s*true/.test(src),
      '★ 캐시를 무시하는 강제 갱신을 넣지 않았다');
    /*
     * 2026-08-31: 검색어 규칙을 api/_query.js 로 옮겼다.
     *
     * 수집기 안에 규칙이 있으면 쿠팡을 호출하지 않고는 검증할 수가 없어서,
     * 규칙 자체를 고정하는 테스트(scripts/test-query.js)를 만들 수 없었다.
     * 여기서 지키는 것은 **규칙이 한 곳에만 있다**는 것이다 — 두 벌로
     * 갈라지면 테스트가 고정하는 규칙과 실제로 도는 규칙이 달라진다.
     */
    check(/require\('\.\.\/api\/_query'\)/.test(src),
      '★ 2차 검색어는 전용 모듈(api/_query.js)에서 만든다');
    check(!/function generateSecondPassQueries|const MAX_QUERY_LEN/.test(src),
      '★★ 수집기 안에 검색어 규칙을 중복 정의하지 않았다');
    /*
     * 주석에도 같은 문구를 적어 뒀으므로(설명용) 주석 줄은 빼고 센다.
     * 실행되는 코드에서 이 게이트가 정확히 두 곳 — 1차(processGroup)와
     * 2차 패스 — 에 있어야 한다.
     */
    const codeOnly = src.split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    const gates = (codeOnly.match(/byId\.get\(item\.productId\)/g) || []).length;
    check(gates === 2,
      '★★ product_id 완전 일치 게이트가 1차·2차 두 곳 모두에 있다 (그리고 그 둘뿐이다)', gates);
  }

  /* ==============================================================
   *  7. 1차 동작이 변하지 않았다 (회귀)
   * ============================================================== */
  section('7. 1차 패스 회귀');
  {
    const rows = [
      prod('M1', '상품 하나 이름 표기법', '키워드A'),
      prod('M2', '상품 둘 이름 표기법', '키워드A')
    ];
    const calls = [];
    const fetchAllFn = async (kw) => {
      calls.push(kw);
      return { ok: true, reason: '', items: [item('M1', 1000), item('M2', 2000)] };
    };
    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, savedState: null, deadlineTs: FAR()
    });
    check(r.uncoveredProducts === 0, '1차에서 다 잡히면 미수집 0');
    check(r.secondPassCalls === 0, '★ 1차에서 다 잡히면 2차 호출이 아예 없다', r.secondPassCalls);
    check(calls.length === 1, '★ 불필요한 추가 호출이 없다', calls);
    check(r.status === 'completed', '완료 상태로 끝난다', r.status);
  }

  /* ==============================================================
   *  8. 같은 날 후속 실행이 2차 패스를 이어받는다
   *
   *  ── 왜 이 테스트가 있는가 ──────────────────────────────────
   *  2026-08-31 전체 dry-run 실측:
   *    1차  383회 호출 → 688/1401 (49.1%)
   *    2차  대상 686종인데 실행 예산(400) 중 17회만 남아 10개 회수
   *  1차가 끝나는 순간 status='completed' 가 되어 같은 날 후속 실행
   *  (KST 03·06시)이 통째로 스킵됐다. 즉 2차 패스는 영원히 "남는 예산"만
   *  쓸 수 있었다. 이 테스트가 그 회귀를 막는다.
   * ============================================================== */
  section('8. 같은 날 후속 실행이 2차를 이어받는다');
  {
    const rows = [];
    for (let i = 0; i < 6; i++) {
      rows.push(prod('R' + i, `브랜드${i} 아주 구체적인 상품 이름 표기`, '공통'));
    }

    // ── 1회차: 2차 호출 상한을 2로 묶어 일부만 돌게 한다
    process.env.PRICE_SECOND_PASS_MAX_CALLS = '2';
    delete require.cache[require.resolve('./collect-all-prices')];
    const mod1 = require('./collect-all-prices');

    let narrow1 = 0;
    const fetch1 = async (kw) => {
      if (kw !== '공통') narrow1++;
      return { ok: true, reason: '', items: [] };   // 1차 성공 · 결과 없음
    };
    saved.price_history = [];
    const run1 = await mod1.runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn: fetch1, savedState: null, deadlineTs: FAR()
    });

    check(narrow1 === 2, '★ 1회차는 상한(2)만큼만 2차를 돈다', narrow1);
    check(run1.status === 'running',
      '★★ 2차 미시도가 남아 있으면 completed 로 끝내지 않는다', run1.status);
    check(run1.secondPassRemaining > 0, '★ 남은 2차 검색어 수를 보고한다', run1.secondPassRemaining);
    check((run1.secondPassDone || []).length === 2,
      '★ 이번 실행에서 시도한 2차 검색어를 기록한다', (run1.secondPassDone || []).length);

    // ── 2회차: 1회차 상태를 물려받아 이어서 돈다
    const savedState = {
      job_date: mod1.kstToday(new Date()),
      cursor_key: run1.cursorKey,
      processed: run1.processed,
      total: run1.total,
      status: run1.status,
      last_result: { failedKeywords: run1.failedKeywords, secondPassDone: run1.secondPassDone }
    };

    let narrow2 = 0;
    const seen2 = [];
    const fetch2 = async (kw) => {
      if (kw !== '공통') { narrow2++; seen2.push(kw); }
      return { ok: true, reason: '', items: [] };
    };
    saved.price_history = [];
    const run2 = await mod1.runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn: fetch2, savedState, deadlineTs: FAR()
    });

    check(narrow2 > 0,
      '★★ 후속 실행이 스킵하지 않고 2차를 이어서 돈다 (예전에는 0이었다)', narrow2);
    const overlap = seen2.filter(k => (run1.secondPassDone || []).includes(k));
    check(overlap.length === 0,
      '★★ 1회차에서 이미 부른 검색어를 다시 부르지 않는다 (예산 낭비 방지)', overlap);

    delete process.env.PRICE_SECOND_PASS_MAX_CALLS;
    delete require.cache[require.resolve('./collect-all-prices')];
  }

  /* ==============================================================
   *  9. 라운드마다 후보가 밀리지 않는다 (실제로 났던 버그)
   *
   *  구현 도중 이런 버그가 있었다.
   *    R0 후보 [제목48, 브랜드+꼬리, 브랜드+명사2] → R0 는 [0] 사용
   *    R1 에서 R0 가 쓴 검색어를 exclude 하고 후보를 **다시 만들면**
   *    목록이 [브랜드+꼬리, 브랜드+명사2] 로 줄고 [1] 은 '브랜드+명사2' 다.
   *    → '브랜드+꼬리' 를 영영 부르지 않는다. 실측 단독 적중률 78.6% 짜리
   *      후보 하나가 통째로 사라지는 것이다.
   *  후보 목록을 고정하고 이미 부른 것만 건너뛰도록 고쳤다.
   * ============================================================== */
  section('9. 라운드별 후보가 밀리지 않는다');
  {
    const rows = [prod('S1', '루이벤 암막 정전기 강력흡수 차량용 햇빛가리개', '차량용 햇빛 가리개')];
    const seen = [];
    const fetchAllFn = async (kw) => {
      if (kw !== '차량용 햇빛 가리개') seen.push(kw);
      return { ok: true, reason: '', items: [] };   // 계속 실패시켜 3라운드를 다 돌린다
    };
    saved.price_history = [];
    await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, savedState: null, deadlineTs: FAR()
    });

    const { generateSecondPassQueries } = require('../api/_query');
    const expect = generateSecondPassQueries(rows[0], { exclude: [] });

    check(seen.length === expect.length,
      '★★ 후보 개수만큼 호출한다 (건너뛰는 후보 없음)', { seen, expect });
    check(JSON.stringify(seen) === JSON.stringify(expect),
      '★★ 후보를 정의된 순서 그대로 부른다', { seen, expect });
    check(new Set(seen).size === seen.length,
      '★★ 같은 검색어를 두 번 부르지 않는다', seen);

    /*
     * 구조로도 고정한다.
     *
     * 위 세 검사는 "결과가 맞다"를 본다. 그런데 후보 생성이 라운드 루프
     * 안으로 다시 들어가면, 어떤 상품에서는 우연히 결과가 같아 통과할 수
     * 있다(후보가 2개 이하이거나 exclude 가 비었을 때). 그래서 코드 모양
     * 자체를 본다 — 생성은 라운드가 시작되기 **전에 한 번**뿐이어야 한다.
     */
    const csrc = require('fs').readFileSync(
      require('path').join(__dirname, 'collect-all-prices.js'), 'utf8');
    const codeOnly = csrc.split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    const genCalls = (codeOnly.match(/generateSecondPassQueries\(/g) || []).length;
    check(genCalls === 1,
      '★★ 후보 생성 호출이 코드에 정확히 한 번만 있다 (라운드마다 재생성 금지)', genCalls);

    const planIdx = codeOnly.indexOf('queryPlan.set(');
    const loopIdx = codeOnly.indexOf('for (let round = 0');
    check(planIdx > -1 && loopIdx > -1 && planIdx < loopIdx,
      '★★ 후보 생성이 라운드 루프보다 앞에 있다', { planIdx, loopIdx });
    check(/const q = qs\[round\];/.test(codeOnly),
      '★★ 라운드는 고정된 배열을 인덱스로만 읽는다');
  }

  /* ==============================================================
   *  10. facet 패스 — 큰 그룹만, 무수확이면 중단
   * ============================================================== */
  section('10. facet 패스');
  {
    // 12개짜리 그룹(=FACET_MIN_GROUP 10 초과). 1차는 상한 10개만 준다.
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push(prod('F' + i, `브랜드${i} 여행용 캐리어 ${20 + (i % 3) * 4}인치 하드`, '여행용 캐리어'));
    }
    const seen = [];
    const fetchAllFn = async (kw) => {
      seen.push(kw);
      if (kw === '여행용 캐리어') {
        return { ok: true, reason: '', items: rows.slice(0, 10).map((p, i) => item(p.product_id, 50000 + i)) };
      }
      // facet: "여행용 캐리어 24인치" 같은 문구에 남은 상품이 걸린다
      const m = /(\d+)인치/.exec(kw);
      if (m) {
        const hit = rows.filter(p => p.title.indexOf(m[1] + '인치') > -1);
        return { ok: true, reason: '', items: hit.map(p => item(p.product_id, 60000)) };
      }
      return { ok: true, reason: '', items: [] };
    };

    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, savedState: null, deadlineTs: FAR()
    });

    const facetCalls = seen.filter(k => k !== '여행용 캐리어' && k.indexOf('여행용 캐리어') === 0);
    check(facetCalls.length > 0,
      '★★ 10개 초과 그룹에 facet 검색어가 나간다', facetCalls);
    check(facetCalls.every(k => k.indexOf('여행용 캐리어') === 0),
      '★★ facet 은 원래 검색어를 포함한다 (엉뚱한 검색이 되지 않게)', facetCalls);
    check(r.uncoveredProducts === 0, '★★ facet 으로 상한 초과분까지 전부 회수', r.uncoveredProducts);
    check(new Set(seen).size === seen.length, '★★ 같은 검색어를 두 번 부르지 않는다', seen);

    // 작은 그룹에는 facet 을 쓰지 않는다
    const small = [];
    for (let i = 0; i < 5; i++) small.push(prod('G' + i, `브랜드${i} 작은그룹 상품 이름`, '작은그룹'));
    const seen2 = [];
    await runMallCollection({
      mallName: '쿠팡', rows: small, savedState: null, deadlineTs: FAR(),
      fetchAllFn: async (kw) => {
        seen2.push(kw);
        return { ok: true, reason: '', items: small.map(p => item(p.product_id, 1000)) };
      }
    });
    check(seen2.length === 1,
      '★★ 10개 이하 그룹에는 facet 호출을 하지 않는다 (1차 한 번이면 충분)', seen2);
  }

  /* ==============================================================
   *  이어받기(resume) 실행 — 성공 상품은 하루 누적이어야 한다
   *
   *  2026-09-01 두 번째 실행이 13.7% (199/1455) 를 보낸 사고의 회귀 테스트.
   *  그날 첫 실행이 582개를 확보했는데, 이어받기 실행이 자기가 새로 잡은
   *  몫만 세어 성공률을 다시 계산했다. 하루 누적으로는 절반 가까이 수집된
   *  날인데 메일은 "13.7%" 라고 말했다.
   *
   *  성공 상품의 출발점은 price_history 가 오늘 갖고 있는 상품이다
   *  (collectedTodayFn). 여기서는 그 조회를 주입해 재현한다.
   * ============================================================== */
  section('9. 이어받기 실행 — 성공 상품 = 앞 실행 + 이번 실행 (하루 누적)');
  {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(prod('R' + i, `브랜드${i} 상품 이름 표기`, 'kw' + i));

    // 앞선 실행이 오늘 이미 확보한 상품 6개 (실제 사고의 582 자리).
    const alreadyToday = new Set(rows.slice(0, 6).map(p => `${p.product_id}|${p.mall}`));

    // 이번 실행은 R6·R7 두 개를 새로 잡는다 (158 자리).
    const fetchAllFn = async (kw) => {
      if (kw === 'kw6') return { ok: true, reason: '', items: [item('R6', 11000)] };
      if (kw === 'kw7') return { ok: true, reason: '', items: [item('R7', 12000)] };
      return { ok: true, reason: '', items: [] };
    };

    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, deadlineTs: FAR(),
      savedState: { job_date: require('./collect-all-prices').kstToday(), cursor_key: '',
                    processed: 6, total: 10, status: 'running',
                    last_result: { failedKeywords: [], secondPassDone: [],
                                   // 앞 실행이 수집기로 확보한 목록 (실제 사고의 582 자리)
                                   collectorCovered: [...alreadyToday] } },
      collectedTodayFn: async () => alreadyToday
    });

    check(r.collectorSuccessProducts === 8,
      '★★ 수집 성공 상품 = 앞 실행 6 + 이번 실행 2 = 8 (이번 실행 몫 2 로 축소하지 않는다)',
      { collectorSuccessProducts: r.collectorSuccessProducts, collectorMissingProducts: r.collectorMissingProducts });
    check(r.collectorMissingProducts === 2, '수집 미확보 상품 2', r.collectorMissingProducts);
    check(r.collectorSuccessProducts + r.collectorMissingProducts === r.targetProducts,
      '★ 불변조건: 수집 성공 + 수집 미확보 = 대상 상품',
      [r.collectorSuccessProducts, r.collectorMissingProducts, r.targetProducts]);
    check(r.collectorSuccessProducts / r.targetProducts === 0.8,
      '★★ 수집 성공률 80% — 이번 실행 몫만 센 20% 가 아니다');
    check(r.todayPriceProducts === 8 && r.uncoveredProducts === 2,
      '오늘 가격 보유(모든 경로)도 8 — 이 케이스에선 두 축이 같다', 
      [r.todayPriceProducts, r.uncoveredProducts]);
    check(r.recorded === 2,
      '★ 저장 행 수는 이번 실행이 실제로 보낸 2행 (하루 누적 8과 섞이지 않는다)', r.recorded);
  }

  /* ==============================================================
   *  10. ★ 다른 경로가 남긴 가격은 수집기 성과로 세지 않는다
   *
   *  price_history 에는 사용자 검색 · Vercel cron · AI · 수동 임포트도 쓴다.
   *  실측(2026-09-01 KST): 오늘 가격을 가진 쿠팡 상품 740개 중 9개는 Vercel
   *  cron 이 KST 03:11 에 쓴 것이었다.
   *
   *  그 행들을 수집기 성과로 세면, 수집기가 통째로 실패한 날에도 사용자
   *  트래픽이 성공률을 끌어올려 장애를 가린다. 여기서는 오늘 가격이 6개
   *  있지만 **수집기가 확보한 것은 하나도 없는** 상태를 만들어 고정한다.
   *  (savedState 에 collectorCovered 를 주지 않는다 = 수집기 기록 없음)
   * ============================================================== */
  section('10. 다른 경로(사용자 검색·cron)가 남긴 가격은 수집 성공으로 세지 않는다');
  {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(prod('S' + i, `브랜드${i} 상품 이름 표기`, 'kw' + i));
    const otherPaths = new Set(rows.slice(0, 6).map(p => `${p.product_id}|${p.mall}`));

    const fetchAllFn = async (kw) => {
      if (kw === 'kw6') return { ok: true, reason: '', items: [item('S6', 11000)] };
      if (kw === 'kw7') return { ok: true, reason: '', items: [item('S7', 12000)] };
      return { ok: true, reason: '', items: [] };
    };

    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, deadlineTs: FAR(),
      savedState: { job_date: require('./collect-all-prices').kstToday(), cursor_key: '',
                    processed: 6, total: 10, status: 'running',
                    // ★ collectorCovered 없음 — 그 6개는 수집기가 잡은 게 아니다
                    last_result: { failedKeywords: [], secondPassDone: [] } },
      collectedTodayFn: async () => otherPaths
    });

    check(r.collectorSuccessProducts === 2,
      '★★ 수집 성공 상품 2 — 다른 경로가 남긴 6개는 수집기 성과가 아니다',
      { collectorSuccessProducts: r.collectorSuccessProducts });
    check(r.todayPriceProducts === 8,
      '★ 오늘 가격 보유 상품은 8 (다른 경로 6 + 수집기 2) — 신선도 지표는 전부 센다',
      r.todayPriceProducts);
    check(r.collectorSuccessProducts < r.todayPriceProducts,
      '★★ 두 지표가 서로 다른 값으로 남는다 (같은 숫자로 뭉개지 않는다)');
    check(r.collectorSuccessProducts + r.collectorMissingProducts === r.targetProducts
       && r.todayPriceProducts + r.uncoveredProducts === r.targetProducts,
      '★ 두 축 각각 불변조건을 만족한다',
      [r.collectorSuccessProducts, r.collectorMissingProducts, r.todayPriceProducts, r.uncoveredProducts]);
  }

  /* ==============================================================
   *  11. collectorCovered 완전성 — 성공 경로를 하나도 빠뜨리지 않는가
   *
   *  Daily Collection 성공률의 분자가 이 집합이다. 가격을 확보한 경로가
   *  하나라도 빠지면 성공률이 실제보다 낮게 보고되고, 반대로 확보하지 못한
   *  상품이 섞이면 장애를 가린다. 경로별로 각각 고정한다.
   * ============================================================== */
  section('11. collectorCovered — 모든 성공 경로 포함 / 실패 경로 제외');
  {
    /* 11-a) 1차 · 2차에서 확보한 상품이 모두 들어가고, 실패는 빠진다 */
    const rows = [
      prod('P1', '아레나 여성 수영복 원피스 블랙', '수영복'),
      prod('P2', '나이키스윔 여성 수영복 블루밍 도트', '수영복'),
      prod('P3', '스피도 남성 수영복 트렁크 네이비', '수영복')
    ];
    const fetchAllFn = async (kw) => {
      if (kw === '수영복') return { ok: true, reason: '', items: [item('P1', 10000)] };
      if (kw.indexOf('나이키스윔') === 0) return { ok: true, reason: '', items: [item('P2', 20000)] };
      return { ok: true, reason: '', items: [] };
    };
    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, savedState: null, deadlineTs: FAR()
    });
    const covered = new Set(r.collectorCovered);
    check(covered.has('P1|쿠팡'), '★★ Test 10-a: 1차에서 확보한 상품이 collectorCovered 에 있다');
    check(covered.has('P2|쿠팡'), '★★ Test 10-b: 2차(회수) 패스에서 확보한 상품도 들어간다');
    check(!covered.has('P3|쿠팡'), '★★ Test 13: 끝내 못 찾은 상품은 들어가지 않는다');
    check(r.collectorSuccessProducts === 2, '수집 성공 상품 2', r.collectorSuccessProducts);
    check(r.collectorMissingProducts === 1, '수집 미확보 상품 1', r.collectorMissingProducts);
  }
  {
    /* 11-b) Test 11 — facet/회수로 건진 limit 초과분도 포함된다 */
    const rows = [];
    for (let i = 0; i < 14; i++) rows.push(prod('F' + i, '브랜드' + i + ' 제품 이름 표기', '공통검색어'));
    const fetchAllFn = async (kw) => {
      if (kw === '공통검색어') return { ok: true, reason: '', items: rows.slice(0, 10).map(p => item(p.product_id, 5000)) };
      return { ok: true, reason: '', items: rows.slice(10).map(p => item(p.product_id, 6000)) };
    };
    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn, savedState: null, deadlineTs: FAR()
    });
    const covered = new Set(r.collectorCovered);
    check(rows.slice(10).every(p => covered.has(p.product_id + '|쿠팡')),
      '★★ Test 11: facet/회수 패스로 건진 limit 초과분도 collectorCovered 에 들어간다',
      { covered: covered.size, recovered: r.secondPassRecovered });
    check(r.collectorSuccessProducts === 14, '14개 전부 수집 성공', r.collectorSuccessProducts);
  }
  {
    /* 11-c) Test 9 — 같은 상품을 다시 확보해도 집합 크기는 그대로 */
    const rows = [prod('D1', '중복 확인용 상품 이름', 'kwA')];
    const fetchAllFn = async () => ({ ok: true, reason: '', items: [item('D1', 7000)] });
    saved.price_history = [];
    const r = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn,
      savedState: { job_date: require('./collect-all-prices').kstToday(), cursor_key: '',
                    processed: 0, total: 1, status: 'running',
                    last_result: { failedKeywords: [], secondPassDone: [], collectorCovered: ['D1|쿠팡'] } },
      collectedTodayFn: async () => new Set(),
      deadlineTs: FAR()
    });
    check(r.collectorSuccessProducts === 1,
      '★★ Test 9: 같은 상품을 다시 확보해도 collectorCovered 는 +1 이 아니라 1 그대로',
      { collectorSuccessProducts: r.collectorSuccessProducts, collectorCovered: r.collectorCovered });
    check(r.collectorCovered.filter(k => k === 'D1|쿠팡').length === 1, '  (목록에도 중복이 남지 않는다)');
  }
  {
    /* 11-d) Test 12 — idle 실행(호출 0회)이어도 앞 실행 몫을 잃지 않는다 */
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(prod('I' + i, '유휴 확인 상품 ' + i, 'ikw' + i));
    const priorCovered = rows.slice(0, 7).map(p => p.product_id + '|쿠팡');
    let called = 0;
    const r = await runMallCollection({
      mallName: '쿠팡', rows,
      fetchAllFn: async () => { called++; return { ok: true, reason: '', items: [] }; },
      savedState: { job_date: require('./collect-all-prices').kstToday(), cursor_key: 'ikw009',
                    processed: 10, total: 10, status: 'completed',
                    last_result: { failedKeywords: [], secondPassDone: [], collectorCovered: priorCovered } },
      collectedTodayFn: async () => new Set(priorCovered),
      deadlineTs: FAR()
    });
    check(called === 0 && r.attemptCalls === 0, 'idle 실행 — 수집 호출 0회', { called, attemptCalls: r.attemptCalls });
    check(r.collectorSuccessProducts === 7,
      '★★ Test 12: 호출 0회여도 앞 실행이 확보한 7개가 유지된다 (0% 로 떨어지지 않는다)',
      r.collectorSuccessProducts);
    check(r.collectorSuccessProducts + r.collectorMissingProducts === r.targetProducts,
      '  불변조건: 수집 성공 + 미확보 = 대상',
      [r.collectorSuccessProducts, r.collectorMissingProducts, r.targetProducts]);
  }
  console.log('');

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(1); });
