#!/usr/bin/env node
/*
 * 몰별 독립 수집(runMallCollection) 테스트.
 *
 * 실제 쿠팡/ADPICK API를 부르지 않는다.
 *
 * ★ 이 테스트는 운영 Supabase 에 절대 쓰면 안 된다.
 *
 *   runMallCollection 은 내부에서 진짜 recordPrices() 를 호출한다. 스텁이
 *   "DB 에 있는 product_id 와 매칭되고 가격이 0 보다 큰" 항목을 돌려주는 순간
 *   그 값이 운영 products / price_history 에 그대로 upsert 된다.
 *
 *   실제로 이 파일 초판이 그 사고를 냈다 (2026-08-29): 픽스처
 *   ADPICK-p0 / p4 / p8 이 운영 products 에 들어갔고, 그 뒤 GitHub Actions
 *   수집기가 픽스처 keyword(ADPICK-kw000 등)로 ADPICK 을 검색하기까지 했다.
 *
 *   그래서 아래 스텁은 다음 둘 중 하나만 돌려준다.
 *     · 매칭되지 않는 productId  → obsMap 에 안 들어간다
 *     · 가격 0                   → addRow 가 버린다
 *   두 경우 모두 obsMap 이 비어 saveAll() 이 즉시 return 하므로 DB 를 건드리지 않는다.
 *   (저장 경로 자체의 검증은 test-adpick.js / test-price.js 가 가짜 supabase 로 한다)
 *   assertNoWrite() 로 매 케이스마다 저장 경로에 들어가지 않았는지 확인한다.
 *   (운영 DB 를 실제로 훑는 확인: node scripts/verify-collection-no-write.js)
 *
 * 검증 대상 (2026-08-29 몰별 독립 수집 도입)
 *   - 한 몰이 예외/차단이어도 다른 몰의 결과가 영향받지 않는다
 *   - 몰마다 자기 시간 예산(deadlineTs)을 지킨다
 *   - target/attempted/success/recorded 를 같은 숫자로 섞지 않는다
 *   - 재시도 목록이 몰별로 분리된다
 *   - isCoupangRow/isAdpickRow 분류, categorizeFailure 분류
 *
 *   node scripts/test-price-mall-collection.js
 */
'use strict';

const {
  runMallCollection, categorizeFailure, isCoupangRow, isAdpickRow, kstToday
} = require('./collect-all-prices');

/*
 * ★ 운영 DB 에 절대 쓰지 않는 저장 훅.
 *
 *   runMallCollection 은 기본값으로 api/_shop.js 의 recordPrices 를 부른다.
 *   테스트 픽스처가 fetchAllFn 응답에 섞이면 그대로 운영 price_history /
 *   products 에 들어간다 — 2026-09-03 에 실제로 P1·P2·P3·X1 4행이 들어갔고
 *   발견 즉시 지웠다. 그 뒤로 이 파일의 모든 호출은 이 훅을 넘긴다.
 */
/* 캐시 힌트 조회는 운영 테이블 전체 스캔이라 테스트에서는 막는다. */
const NO_HINT = async () => new Map();
const NO_WRITE = async (obs) => ({
  saved: obs.length, recorded: obs.length,
  recordedKeys: [...new Set(obs.map(o => o.productId + "|" + o.mall))],
  rejected: 0, suspect: 0, errors: []
});

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, got, want) { check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const TODAY = kstToday();

/*
 * 이 케이스가 DB 쓰기 경로에 한 번도 들어가지 않았는지 확인한다.
 *
 * ── 왜 운영 DB 를 조회하지 않는가 (2026-08-30 변경) ───────────
 *
 * 초판은 여기서 실제로 운영 Supabase 를 읽어 픽스처가 남았는지 봤다. 확인
 * 자체는 옳았지만, 그러면 `npm test` 체인에서 운영 DB 로 네트워크 호출이
 * 나간다 — test-release.js 의 SAFE 검사("체인 안에 운영 Supabase 를 그대로
 * 쓰는 테스트가 없다")가 실제로 FAIL 이었다. 테스트가 운영을 건드리지
 * 않는다는 약속이 테스트 자신 때문에 깨져 있었다.
 *
 * recorded 는 저장 경로를 실제로 통과한 행 수다. 0 이면 saveAll() 이
 * 즉시 return 했다는 뜻이고, 그때는 upsert 가 한 번도 일어나지 않는다.
 * 오프라인에서 같은 것을 판정할 수 있다.
 *
 * 운영 DB 를 실제로 훑는 확인은 체인 밖으로 옮겼다:
 *   node scripts/verify-collection-no-write.js
 */
function assertNoWrite(label, ...results) {
  const total = results.reduce((s, r) => s + (Number(r && r.recorded) || 0), 0);
  check(`★ ${label}: 저장 경로에 들어가지 않았다 (운영 DB 쓰기 0)`, total === 0,
    `recorded 합계=${total}`);
}

function makeRows(mall, n, withKeyword = true) {
  return Array.from({ length: n }, (_, i) => ({
    product_id: `${mall}-p${i}`,
    mall,
    title: `${mall} 상품 ${i}`,
    keyword: withKeyword ? `${mall}-kw${String(i).padStart(3, '0')}` : '',
    link: '', image: ''
  }));
}

(async () => {
  console.log('=== 몰별 독립 수집 테스트 ===\n');

  /* ── 1. mall 분류 ─────────────────────────────────────────── */
  console.log('[1] mall 분류');
  check('쿠팡 mall 값', isCoupangRow({ mall: '쿠팡' }));
  check('link 에 coupang 이 있으면 쿠팡', isCoupangRow({ mall: '기타', link: 'https://www.coupang.com/vp/products/1' }));
  check('ADPICK mall 값', isAdpickRow({ mall: 'ADPICK' }));
  check('쿠팡은 ADPICK 이 아니다', !isAdpickRow({ mall: '쿠팡' }));
  check('네이버는 둘 다 아니다(연동 없음 → 기타로 빠짐)', !isCoupangRow({ mall: '네이버' }) && !isAdpickRow({ mall: '네이버' }));
  console.log('');

  /* ── 2. 실패 사유 분류 ────────────────────────────────────── */
  console.log('[2] 실패 사유 분류(categorizeFailure)');
  eq('쿠팡 차단', categorizeFailure('쿠팡 차단: Access denied'), 'blocked');
  eq('ADPICK 차단 문구(중단)', categorizeFailure('호출 중단 중 (12초 남음): HTTP 429'), 'blocked');
  eq('예산 소진', categorizeFailure('실행당 호출 예산 400회 소진'), 'budget');
  eq('오래된 캐시', categorizeFailure('오래된 캐시 — 오늘 가격으로 쓸 수 없음'), 'staleCache');
  eq('키 미설정', categorizeFailure('ADPICK 키 미설정'), 'noKeys');
  eq('분당 상한', categorizeFailure('호출 생략: 인스턴스 분당 한도 20/20'), 'rateLimit');
  eq('알 수 없는 사유', categorizeFailure('무슨 일이 있었나'), 'other');
  console.log('');

  /* ── 3. 한 몰이 전부 실패해도 다른 몰은 영향받지 않는다 ─────── */
  console.log('[3] 몰 독립성 — 쿠팡이 전부 예외를 던져도 ADPICK 은 정상 처리된다');
  {
    const coupangRows = makeRows('쿠팡', 6);
    const adpickRows = makeRows('ADPICK', 6);

    const coupangFetch = async () => { throw new Error('쿠팡 네트워크 오류(시뮬레이션)'); };
    // ADPICK 은 호출만 성공하고, 매칭되는 productId 는 절대 주지 않는다(DB 쓰기 방지).
    const adpickFetch = async () => ({ ok: true, items: [{ productId: 'NO-MATCH', lprice: 1000, oprice: 1000, link: '', image: '', itemId: '', vendorItemId: '' }], reason: '' });

    const deadline = Date.now() + 5000;
    const coupangResult = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: '쿠팡', rows: coupangRows, fetchAllFn: coupangFetch, savedState: null, deadlineTs: deadline
    });
    const adpickResult = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: 'ADPICK', rows: adpickRows, fetchAllFn: adpickFetch, savedState: null, deadlineTs: deadline
    });

    eq('쿠팡: 대상 6개', coupangResult.targetProducts, 6);
    eq('쿠팡: 처리 상품 6개 전부 실패', coupangResult.processedProducts, 6);
    eq('쿠팡: 수집 성공 상품 0개', coupangResult.collectorSuccessProducts, 0);
    eq('쿠팡: 저장 0행(DB 접근 없음)', coupangResult.recorded, 0);
    check('쿠팡: 실패 사유가 예외 메시지로 기록됨', coupangResult.failedKeywords.length > 0);

    eq('ADPICK: 대상 6개', adpickResult.targetProducts, 6);
    eq('ADPICK: 처리 상품 6개(호출은 성공)', adpickResult.processedProducts, 6);
    eq('ADPICK: 수집 성공 상품 0개(매칭 없음 — no-match 는 성공이 아니다)', adpickResult.collectorSuccessProducts, 0);
    eq('ADPICK: 저장 0행', adpickResult.recorded, 0);
    check('★ 쿠팡이 전부 실패해도 ADPICK 결과는 멀쩡하다(독립 실행 확인)',
      adpickResult.processedProducts === 6 && coupangResult.processedProducts === 6);
    assertNoWrite('[3] 몰 독립성 케이스', coupangResult, adpickResult);
  }
  console.log('');

  /* ── 4. target ≠ attempted ≠ success ≠ recorded — 숫자를 섞지 않는다 ── */
  console.log('[4] 대상/시도/성공/저장 숫자 분리');
  {
    const rows = makeRows('ADPICK', 10);
    const fetchStub = async (kw) => {
      const idx = Number(kw.replace('ADPICK-kw', ''));
      // 홀수 검색어: 호출은 성공했지만 결과가 비었다 (매칭 0건).
      if (idx % 2 !== 0) return { ok: true, items: [], reason: '' };
      /*
       * 짝수 검색어: 우리 상품과 매칭되지만 가격이 0 이라 addRow 가 버린다.
       * → "조회는 성공(hit)했는데 저장은 안 된" 경우를 DB 쓰기 없이 재현한다.
       *   가격을 0 보다 크게 주면 그 순간 운영 DB 에 upsert 된다(파일 머리말 참고).
       */
      return { ok: true, items: [{ productId: `ADPICK-p${idx}`, lprice: 0, oprice: 0, link: '', image: '', itemId: '', vendorItemId: '' }], reason: '' };
    };
    const result = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: 'ADPICK', rows, fetchAllFn: fetchStub, savedState: null, deadlineTs: Date.now() + 5000
    });
    eq('대상 상품(targetProducts) = 10', result.targetProducts, 10);
    eq('처리 상품 수(processedProducts) = 10 (전부 이번 실행에서 처리)', result.processedProducts, 10);
    eq('★ 저장(recorded) = 0 — 가격 0 은 저장 경로로 넘어가지 않는다', result.recorded, 0);
    check('★ 대상(10) 과 시도(10) 와 저장(0) 이 서로 다른 숫자로 집계된다',
      result.targetProducts === 10 && result.processedProducts === 10 && result.recorded === 0);
    assertNoWrite('[4] 숫자 분리 케이스', result);
  }
  console.log('');

  /* ── 5. 몰별 시간 예산 — deadline 을 지킨다 ─────────────────── */
  console.log('[5] 몰별 시간 예산 준수');
  {
    // 상품이 아주 많지만 deadline 을 거의 0으로 줘서 재시도/본배치 루프가
    // 첫 배치 이후 반드시 멈추는지 확인한다.
    const rows = makeRows('쿠팡', 200);
    const fetchStub = async () => { await new Promise(r => setTimeout(r, 5)); return { ok: true, items: [], reason: '' }; };
    const started = Date.now();
    const result = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: '쿠팡', rows, fetchAllFn: fetchStub, savedState: null, deadlineTs: started + 200
    });
    const elapsed = Date.now() - started;
    check('★ deadline(200ms) 근처에서 멈춘다 — 배치 간격(60초) 만큼 기다리지 않는다',
      elapsed < 10000, `elapsed=${elapsed}ms`);
    check('전부 처리하지 못했다(상태 running 또는 남은 상품 있음)',
      result.status === 'running' || result.processedProducts < result.targetProducts);
  }
  console.log('');

  /* ── 6. 재시도 목록이 몰별로 분리된다 ─────────────────────── */
  console.log('[6] 재시도 목록 — 이전 실행의 실패 검색어를 이어받는다(몰별로 별도)');
  {
    const rows = makeRows('ADPICK', 4);
    // 이전 실행에서 kw000, kw001 이 실패했다고 저장된 상태를 흉내낸다.
    const savedState = {
      job_date: TODAY, cursor_key: rows[3].keyword, processed: 4, total: 4, status: 'running',
      last_result: { failedKeywords: ['ADPICK-kw000', 'ADPICK-kw001'] }
    };
    let retried = [];
    const fetchStub = async (kw) => { retried.push(kw); return { ok: true, items: [], reason: '' }; };
    const result = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: 'ADPICK', rows, fetchAllFn: fetchStub, savedState, deadlineTs: Date.now() + 5000
    });
    check('★ 커서 이후 남은 그룹이 없어도 재시도 목록만으로 다시 시도한다',
      retried.includes('ADPICK-kw000') && retried.includes('ADPICK-kw001'),
      `retried=${JSON.stringify(retried)}`);
    eq('재시도까지 전부 성공하면 완료 상태로 전환', result.status, 'completed');
    assertNoWrite('[6] 재시도 케이스', result);
  }
  console.log('');

  /* ── 7. 집계 단위 분리 — 상품 / attempt / 행 ──────────────────
   *
   * 2026-09-01 리포트 사고의 회귀 테스트다.
   *
   *   실제 메일:  실패(검색어) 26  ↔  blocked 23 / staleCache 3 / noMatch 125
   *   원인:       실패 개수는 검색어(=attempt) 단위인데 noMatch 만
   *               `+= groupRows.length` 로 상품 수를 더하고 있었다.
   *
   * 그래서 여기서는 **한 검색어가 여러 상품을 덮는** 배치를 일부러 만든다.
   * noMatch 가 상품 수를 세면 아래 항등식이 즉시 깨진다.
   */
  console.log('[7] 집계 단위 분리 — 상품 / attempt / 행을 섞지 않는다');
  {
    /*
     * 상품 12개를 검색어 3종에 4개씩 몰아 준다(한 attempt = 상품 4개).
     *   kw0 → 호출 성공, 매칭 0건        → 실패 attempt 1 (noMatch)
     *   kw1 → 호출 자체가 실패(차단)     → 실패 attempt 1 (blocked)
     *   kw2 → 호출 성공, 매칭 0건        → 실패 attempt 1 (noMatch)
     * 상품 단위로 세면 noMatch 는 8이 된다 — 그 값이 나오면 회귀다.
     */
    const rows = Array.from({ length: 12 }, (_, i) => ({
      product_id: `ADPICK-g${i}`, mall: 'ADPICK',
      title: `묶음 상품 ${i}`, keyword: `ADPICK-grp${i % 3}`, link: '', image: ''
    }));
    const fetchStub = async (kw) => {
      if (kw === 'ADPICK-grp1') return { ok: false, items: [], reason: 'ADPICK 차단: HTTP 429' };
      return { ok: true, items: [], reason: '' };     // 호출은 성공, 매칭 0건
    };
    const r = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: 'ADPICK', rows, fetchAllFn: fetchStub, savedState: null, deadlineTs: Date.now() + 5000
    });

    const catSum = Object.values(r.failureCategories).reduce((s, v) => s + v, 0);
    const firstPass = r.attemptCalls - r.attemptCallsRecovery;

    eq('1차 attempt 3회 (검색어 3종 = 호출 3회, 상품 12개가 아니다)', firstPass, 3);
    check('회수 패스 호출도 attempt 에 들어간다 (실제로 나간 호출이므로)',
      r.attemptCallsRecovery > 0 && r.attemptCalls === firstPass + r.attemptCallsRecovery,
      `total=${r.attemptCalls} 1차=${firstPass} 회수=${r.attemptCallsRecovery}`);
    eq('성공 attempt 0회', r.attemptSuccess, 0);
    eq('실패 attempt = 총 attempt (하나도 못 잡았다)', r.attemptFailed, r.attemptCalls);
    eq('★ 1차 noMatch 는 attempt 단위 2 (상품 단위 8이 아니다)',
      r.failureCategories.noMatch - r.attemptCallsRecovery, 2);
    check('★ noMatch 가 상품 수(8)로 세어지지 않는다', r.failureCategories.noMatch !== 8 + r.attemptCallsRecovery,
      `noMatch=${r.failureCategories.noMatch} 회수=${r.attemptCallsRecovery}`);
    eq('blocked 는 attempt 단위 1', r.failureCategories.blocked, 1);

    check('★ 불변조건 2: 실패 attempt = 모든 실패 원인의 합',
      r.attemptFailed === catSum, `실패=${r.attemptFailed} 원인합=${catSum}`);
    check('★ 불변조건 3: 성공 attempt + 실패 attempt = 총 attempt',
      r.attemptSuccess + r.attemptFailed === r.attemptCalls,
      `${r.attemptSuccess}+${r.attemptFailed} vs ${r.attemptCalls}`);
    check('★ 불변조건 1: 수집 성공 + 수집 미확보 = 대상 상품',
      r.collectorSuccessProducts + r.collectorMissingProducts === r.targetProducts,
      `${r.collectorSuccessProducts}+${r.collectorMissingProducts} vs ${r.targetProducts}`);
    eq('아무것도 못 잡았으므로 수집 성공 상품 0', r.collectorSuccessProducts, 0);
    eq('오늘 가격 미보유 상품은 대상 전부(12)', r.uncoveredProducts, 12);
    check('★ 상품 단위(12)와 attempt 단위(1차 3회)가 서로 다른 숫자로 남는다',
      r.targetProducts === 12 && firstPass === 3);
    assertNoWrite('[7] 단위 분리 케이스', r);
  }
  console.log('');

  /* ── 8. 예외로 끝난 호출도 실패 원인에 잡힌다 ────────────────── */
  console.log('[8] 예외 attempt 도 실패 원인 합계에 들어간다');
  {
    const rows = makeRows('쿠팡', 5);
    const fetchStub = async () => { throw new Error('쿠팡 네트워크 오류(시뮬레이션)'); };
    const r = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: '쿠팡', rows, fetchAllFn: fetchStub, savedState: null, deadlineTs: Date.now() + 5000
    });
    const catSum = Object.values(r.failureCategories).reduce((s, v) => s + v, 0);
    eq('attempt 5회 전부 예외', r.attemptCalls, 5);
    eq('실패 attempt 5회', r.attemptFailed, 5);
    check('★ 예외 5회가 실패 원인 합계에도 그대로 잡힌다 (예전에는 0이었다)',
      catSum === 5, `원인합=${catSum} 상세=${JSON.stringify(r.failureCategories)}`);
    eq('network 로 분류된다', r.failureCategories.network, 5);
    assertNoWrite('[8] 예외 attempt 케이스', r);
  }
  console.log('');

  /* ── 9. 이어받기 실행의 성공 상품은 하루 누적이다 ─────────────
   *
   * 2026-09-01 두 번째 실행이 13.7% (199/1455) 를 보낸 사고의 회귀 테스트다.
   *
   *   그날 첫 실행이 582개를 확보했는데, 이어받기 실행이 자기가 새로 잡은
   *   상품만 세어 성공률을 다시 계산했다. 하루 누적으로는 이미 절반 가까이
   *   수집된 날인데 메일은 "13.7%" 라고 말했다.
   *
   * 이제 성공 상품은 price_history 가 오늘 갖고 있는 상품(=collectedTodayFn)
   * 에서 출발한다. 여기서는 그 조회를 스텁으로 주입해 운영 DB 없이 재현한다.
   *
   * ★ 이 파일은 가격 0 만 돌려줄 수 있어(머리말 참고) 이번 실행이 새로
   *   잡는 몫은 만들 수 없다. 그래서 여기서는 "앞 실행 몫이 0 으로
   *   되돌아가지 않는다" 만 고정하고, 앞 실행 + 이번 실행 합산은 가짜
   *   Supabase 를 쓰는 test-second-pass.js §9 가 검증한다.
   */
  console.log('[9] 이어받기(resume) — 앞 실행이 확보한 상품을 되돌리지 않는다');
  {
    const rows = makeRows('ADPICK', 10);
    // 앞선 실행이 오늘 이미 확보한 상품 6개 (= 실제 사고의 582 자리).
    const alreadyToday = new Set(rows.slice(0, 6).map(p => `${p.product_id}|${p.mall}`));
    const collectedTodayFn = async () => alreadyToday;

    // 이번 실행은 아무것도 새로 잡지 못한다 (매칭 0건).
    const fetchStub = async () => ({ ok: true, items: [], reason: '' });
    const savedState = {
      job_date: TODAY, cursor_key: '', processed: 6, total: 10, status: 'running',
      last_result: { failedKeywords: [], secondPassDone: [] }
    };
    const r = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: 'ADPICK', rows, fetchAllFn: fetchStub, savedState,
      deadlineTs: Date.now() + 5000, collectedTodayFn
    });

    eq('★ 이번 실행이 0개를 잡아도 오늘 가격 보유는 앞 실행 몫 6 (0 으로 되돌리지 않는다)',
      r.todayPriceProducts, 6);
    eq('오늘 가격 미보유 상품 4', r.uncoveredProducts, 4);
    check('★ 불변조건: 가격 보유 + 미보유 = 대상',
      r.todayPriceProducts + r.uncoveredProducts === r.targetProducts,
      `${r.todayPriceProducts}+${r.uncoveredProducts} vs ${r.targetProducts}`);
    eq('★ 가격 보유율 60% — 이번 실행 몫만 센 0% 가 아니다',
      r.todayPriceProducts / r.targetProducts * 100, 60);
    /*
     * ★ 이 케이스의 6개는 collectedTodayFn 이 준 것 = 출처를 모른다.
     *   수집기가 잡았다는 기록(collectorCovered)이 없으므로 수집 성공은 0 이다.
     *   "오늘 가격이 있다" 와 "수집기가 확보했다" 를 섞지 않는다.
     */
    eq('★★ 수집 성공 상품은 0 — 출처 불명 6개를 수집기 성과로 세지 않는다',
      r.collectorSuccessProducts, 0);
    assertNoWrite('[9] 이어받기 케이스', r);
  }
  console.log('');

  /* ── 10. 호출부 배선 — 각 경로가 자기 source 를 넘기는가 (정적 확인) ──
   *
   * api/search.js · api/ai.js · api/cron.js 는 서버리스 핸들러라 여기서
   * 실행하지 않는다. 대신 소스에서 배선을 직접 확인한다 — 배선이 빠지면
   * price_history.source 가 비어 리포트의 전제가 무너지기 때문이다.
   * (source 값 자체가 저장되는지는 test-price.js 가 가짜 DB 로 검증한다)
   */
  console.log('[10] 호출부가 자기 source 를 넘기는가 (소스 확인)');
  {
    const fs = require('fs'), path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const wiring = [
      ['scripts/collect-all-prices.js', "source: 'collect'", '일일 수집기'],
      ['api/cron.js', "source: 'cron'", 'Vercel cron'],
      ['api/search.js', "source: 'search'", '사용자 검색'],
      ['api/ai.js', "source: 'ai'", 'AI 추천'],
      ['scripts/import-history.js', "source: 'import'", '수동 임포트']
    ];
    wiring.forEach(([rel, needle, name]) => {
      check(`★ ${name} (${rel}) 가 ${needle} 를 넘긴다`, read(rel).includes(needle));
    });
    // 저장 깔때기가 source 를 실제로 행에 싣는가
    const shop = read('api/_shop.js');
    check('★ recordPrices 가 source 를 price_history 행에 싣는다',
      shop.slice(shop.indexOf('historyRows.push({'), shop.indexOf('historyRows.push({') + 500).includes('source'));
    check('★ source 컬럼이 없는 환경에서도 저장이 죽지 않는다 (폴백 존재)',
      shop.includes('historySourceColumn') && shop.includes('upsertHistory'));
  }
  console.log('');

  /* ── 11. 날짜 경계 — 오늘 기록 조회는 recorded_date 라벨을 믿지 않는다 ──
   *
   * 운영 트리거가 recorded_date 를 UTC 로 덮어쓰는데, 이 잡은 UTC 16·18·21시
   * (=KST 01·03·06시)에 돈다. 그래서 .eq('recorded_date', kstToday()) 는
   * 자기가 방금 쓴 행을 절대 못 찾는다 (2026-09-01 실측: 747행 중 7행만 조회).
   * 경계는 반드시 절대 시각(recorded_at)으로 잡아야 한다.
   */
  console.log('[11] 날짜 경계 — collectedTodayKeys 는 recorded_at 범위로 조회한다');
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'collect-all-prices.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function collectedTodayKeys'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));

    check("★★ recorded_date 동등 비교를 쓰지 않는다", !body.includes("eq('recorded_date'"),
      'recorded_date 라벨은 UTC 로 잘려 있어 KST 하루 경계로 쓸 수 없다');
    check("★★ recorded_at 범위(gte/lt)로 조회한다",
      body.includes("gte('recorded_at'") && body.includes("lt('recorded_at'"));
    check('kstDayStartUtc 로 KST 하루 시작을 잡는다', body.includes('kstDayStartUtc('));
    check('kstDayStartUtc 가 import 되어 있다', src.includes('kstDayStartUtc } = require'));

    // 경계 산술 자체를 고정한다 (KST 는 서머타임이 없어 정확히 24시간)
    const { kstDayStartUtc } = require('../api/_price');
    const start = kstDayStartUtc('2026-09-01');
    const end = new Date(Date.parse(start) + 24 * 60 * 60 * 1000).toISOString();
    eq('★ KST 2026-09-01 시작 = UTC 2026-08-31T15:00Z', start, '2026-08-31T15:00:00.000Z');
    eq('★ KST 2026-09-01 종료 = UTC 2026-09-01T15:00Z', end, '2026-09-01T15:00:00.000Z');
    // 실제 사고 시각(수집기가 쓴 행)이 이 범위 안에 들어오는지
    const collectorWrite = Date.parse('2026-08-31T21:40:19.473Z');   // 실측 행 8579465515
    check('★★ KST 새벽 수집분(UTC 전날 21:40)이 오늘 범위에 포함된다',
      collectorWrite >= Date.parse(start) && collectorWrite < Date.parse(end));
  }
  console.log('');

  /* ── 9. 패스별 계측 (2026-09-03) ─────────────────────────────
   *
   * 어느 검색 전략이 몇 번의 호출로 몇 개를 건졌는지 나눠 세는지 고정한다.
   * 이 값이 없으면 "회수 패스가 듣는다" 를 숫자로 증명할 수 없다.
   */
  console.log('[9] 패스별 계측 — pass1 / facet / rN 이 각각 집계된다');
  {
    /*
     * 그룹 하나에 상품 12개(응답창 10 초과). 1차 검색은 앞 2개만 돌려주고,
     * facet 검색(검색어에 공백이 더 붙은 것)은 3번째를 돌려준다.
     * 나머지는 어떤 검색으로도 나오지 않는다 — 라운드가 헛돌아도 계측만 남는다.
     */
    const rows = [];
    for (let i = 1; i <= 12; i++) {
      rows.push({ product_id: `P${i}`, mall: '쿠팡', title: `브랜드${i} 모델 MD${i}00X 제품`, keyword: '공통검색어', link: '', image: '' });
    }
    const item = (id) => ({ productId: id, title: 't', lprice: 1000, oprice: 1000, link: '', image: '', itemId: '', vendorItemId: '' });
    const seen = [];
    const fetchAllFn = async (q) => {
      seen.push(q);
      if (q === '공통검색어') return { ok: true, reason: '', items: [item('P1'), item('P2')] };
      if (q.indexOf('공통검색어 ') === 0) return { ok: true, reason: '', items: [item('P3')] };
      return { ok: true, reason: '', items: [] };
    };
    const result = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: '쿠팡', rows, fetchAllFn, savedState: null,
      deadlineTs: Date.now() + 8000,
      collectedTodayFn: async () => new Set(),
        recordPricesFn: NO_WRITE
    });
    const ps = result.passStats || [];
    const get = (n) => ps.find(s => s.pass === n) || { calls: 0, ok: 0, success: 0, recovered: 0 };

    check('★ passStats 가 반환된다', ps.length > 0, JSON.stringify(ps));
    eq('★ pass1 호출 1회', get('pass1').calls, 1);
    eq('★ pass1 이 상품 2개를 회수', get('pass1').recovered, 2);
    check('★ facet 패스가 실제로 호출됐다', get('facet').calls > 0, JSON.stringify(get('facet')));
    eq('★ facet 이 상품 1개를 회수', get('facet').recovered, 1);
    check('★ 패스 순서는 pass1 → facet → rN', ps[0].pass === 'pass1' && ps[1].pass === 'facet',
      ps.map(s => s.pass).join(','));
    check('★ 라운드 패스 이름이 rN 꼴이다',
      ps.slice(2).every(s => /^r[0-9]+$/.test(s.pass)), ps.map(s => s.pass).join(','));
    const totalRecovered = ps.reduce((n, s) => n + s.recovered, 0);
    eq('★ 패스별 회수 합계 = 이번 실행이 잡은 상품 수', totalRecovered, 3);
    check('★ 패스별 호출 합계 = attemptCalls',
      ps.reduce((n, s) => n + s.calls, 0) === result.attemptCalls,
      `${ps.reduce((n, s) => n + s.calls, 0)} vs ${result.attemptCalls}`);
  }
  console.log('');

  /* ── 10. facet 깊이 이어파기 (2026-09-03 버그) ────────────────
   *
   * 예전에는 facet 을 상한만큼만 만든 뒤 "오늘 이미 부른 것" 을 걸렀다.
   * 생성이 결정론적이라 두 번째 실행부터는 남는 facet 이 0개가 됐다.
   * 이제는 깊은 풀에서 안 부른 것을 골라야 한다.
   */
  console.log('[10] facet — 앞선 실행이 쓴 facet 을 건너뛰고 다음 토큰으로 이어판다');
  {
    const rows = [];
    for (let i = 1; i <= 14; i++) {
      rows.push({ product_id: `Q${i}`, mall: '쿠팡', title: `브랜드${i} 제품${i}`, keyword: 'kw', link: '', image: '' });
    }
    const item = (id) => ({ productId: id, title: 't', lprice: 1000, oprice: 1000, link: '', image: '', itemId: '', vendorItemId: '' });

    const run = async (priorDone) => {
      const asked = [];
      await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
        mallName: '쿠팡', rows,
        fetchAllFn: async (q) => { asked.push(q); return { ok: true, reason: '', items: [item('NO-MATCH')] }; },
        savedState: {
          job_date: TODAY, cursor_key: '', processed: 0, total: 14, status: 'running',
          last_result: { failedKeywords: [], collectorCovered: [], collectorAttempted: [], secondPassDone: priorDone }
        },
        deadlineTs: Date.now() + 8000,
        collectedTodayFn: async () => new Set(),
        recordPricesFn: NO_WRITE
      });
      return asked.filter(q => q.indexOf('kw ') === 0);
    };

    const first = await run([]);
    check('★ 1회차에 facet 을 만든다', first.length > 0, JSON.stringify(first));
    const second = await run(first);          // 1회차가 부른 facet 을 전부 "이미 부름" 으로
    check('★★ 2회차는 1회차와 다른 facet 을 판다 (예전에는 0개였다)',
      second.length > 0 && second.every(q => first.indexOf(q) < 0),
      `1회차 ${JSON.stringify(first)} / 2회차 ${JSON.stringify(second)}`);
  }
  console.log('');

  /* ── 11. facet 이 마른 그룹은 다음 실행에서 건너뛴다 (2026-09-03 실측) ── */
  console.log('[11] facet — 오늘 마른 그룹은 다음 실행에서 두드리지 않는다');
  {
    const rows = [];
    for (let i = 1; i <= 14; i++) {
      rows.push({ product_id: `D${i}`, mall: '쿠팡', title: `브랜드${i} 제품${i}`, keyword: 'kw', link: '', image: '' });
    }
    // 어떤 검색으로도 우리 상품이 안 나온다 → facet 은 곧바로 마른다.
    const run = async (prior) => {
      const asked = [];
      const res = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
        mallName: '쿠팡', rows,
        fetchAllFn: async (q) => {
          asked.push(q);
          return { ok: true, reason: '', items: [{ productId: 'NO-MATCH', lprice: 1000, oprice: 1000, link: '', image: '', itemId: '', vendorItemId: '' }] };
        },
        savedState: {
          job_date: TODAY, cursor_key: '', processed: 0, total: 14, status: 'running',
          last_result: {
            failedKeywords: [], collectorCovered: [], collectorAttempted: [],
            secondPassDone: (prior && prior.secondPassDone) || [],
            facetDryGroups: (prior && prior.facetDryGroups) || []
          }
        },
        deadlineTs: Date.now() + 8000,
        collectedTodayFn: async () => new Set(),
        recordPricesFn: NO_WRITE
      });
      return { res, facets: asked.filter(q => q.indexOf('kw ') === 0) };
    };

    const a = await run(null);
    check('★ 1회차는 facet 을 두드린다', a.facets.length > 0, JSON.stringify(a.facets));
    check('★ 마른 그룹이 상태에 기록된다',
      (a.res.facetDryGroups || []).indexOf('kw') > -1, JSON.stringify(a.res.facetDryGroups));

    const b = await run({ secondPassDone: a.res.secondPassDone, facetDryGroups: a.res.facetDryGroups });
    eq('★★ 2회차는 그 그룹에 facet 호출을 하지 않는다', b.facets.length, 0);
    check('★ 마른 표시는 다음 실행으로도 이어진다',
      (b.res.facetDryGroups || []).indexOf('kw') > -1, JSON.stringify(b.res.facetDryGroups));
  }
  console.log('');

  /* ── 12. 교차 매칭 — 응답을 전체 미수집 집합과 대조한다 (2026-09-03) ──
   *
   * 검색 응답에는 그 검색어를 만든 상품 말고도 우리 카탈로그의 다른 상품이
   * 함께 들어온다. 예전에는 그것을 통째로 버렸다.
   * 채택 기준(product_id 완전 일치)은 그대로여야 한다.
   */
  console.log('[12] 교차 매칭 — 다른 검색어의 응답에 들어온 우리 상품도 가져간다');
  {
    const rows = [
      { product_id: 'X1', mall: '쿠팡', title: '알파 제품 하나', keyword: 'kwA', link: '', image: '' },
      { product_id: 'X2', mall: '쿠팡', title: '베타 제품 둘', keyword: 'kwB', link: '', image: '' }
    ];
    const item = (id, price) => ({ productId: id, title: 't' + id, lprice: price, oprice: price, link: '', image: '', itemId: '', vendorItemId: 'V' + id });
    const asked = [];
    // kwA 검색이 X1 과 X2 를 함께 돌려준다. kwB 검색은 아무것도 못 준다.
    const fetchAllFn = async (q) => {
      asked.push(q);
      if (q === 'kwA') return { ok: true, reason: '', items: [item('X1', 1000), item('X2', 2000)] };
      return { ok: true, reason: '', items: [] };
    };
    const saved = [];
    const result = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: '쿠팡', rows, fetchAllFn, savedState: null,
      deadlineTs: Date.now() + 6000,
      collectedTodayFn: async () => new Set(),
      recordPricesFn: async (obs) => {
        saved.push(...obs);
        return { saved: obs.length, recorded: obs.length, recordedKeys: [...new Set(obs.map(o => o.productId + '|' + o.mall))], rejected: 0, suspect: 0, errors: [] };
      }
    });
    eq('★★ 두 상품 모두 확보 (X2 는 kwA 응답에서 건졌다)', result.collectorSuccessProducts, 2);
    eq('★ 교차 매칭 회수 수가 보고된다', result.crossRecovered, 1);
    const x2 = saved.find(o => o.productId === 'X2');
    check('★★ 교차로 잡은 상품도 자기 가격을 쓴다 (다른 상품 가격을 붙이지 않는다)',
      x2 && x2.price === 2000, JSON.stringify(x2));
    check('★★ 교차로 잡은 상품도 자기 vendorItemId 를 유지한다',
      x2 && x2.vendorItemId === 'VX2', JSON.stringify(x2 && x2.vendorItemId));
  }
  console.log('');

  /* ── 13. 교차 매칭이 남의 상품을 끌어오지 않는다 ─────────────── */
  console.log('[13] 교차 매칭 — 카탈로그에 없는 product_id 는 절대 채택하지 않는다');
  {
    const rows = [{ product_id: 'Y1', mall: '쿠팡', title: '감마 제품', keyword: 'kwY', link: '', image: '' }];
    const saved = [];
    const result = await runMallCollection({ recordPricesFn: NO_WRITE, cacheHintFn: NO_HINT,
      mallName: '쿠팡', rows,
      fetchAllFn: async () => ({ ok: true, reason: '', items: [
        { productId: 'STRANGER', title: '남의 상품', lprice: 9999, oprice: 9999, link: '', image: '', itemId: '', vendorItemId: 'VZ' }
      ] }),
      savedState: null, deadlineTs: Date.now() + 6000,
      collectedTodayFn: async () => new Set(),
      recordPricesFn: async (obs) => { saved.push(...obs); return { saved: 0, recorded: 0, recordedKeys: [], rejected: 0, suspect: 0, errors: [] }; }
    });
    eq('★★ 카탈로그 밖 상품은 저장하지 않는다', saved.length, 0);
    eq('★ 확보 상품 0', result.collectorSuccessProducts, 0);
    eq('★ 교차 회수 0', result.crossRecovered, 0);
  }
  console.log('');

  console.log(`=== 결과: ${pass}/${pass + fail} PASS ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('테스트 실행 오류:', e.message, e.stack);
  process.exit(1);
});
