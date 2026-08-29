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
 *   assertNoDbWrite() 로 매 케이스마다 실제로 안 썼는지 확인한다.
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

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, got, want) { check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const TODAY = kstToday();

/*
 * 이 테스트가 운영 DB 에 한 행이라도 썼는지 실제로 확인한다.
 * 픽스처 product_id 는 전부 "<mall>-p<n>" 꼴이라 like 로 한 번에 잡힌다.
 * 운영 데이터의 product_id 는 쿠팡=숫자, ADPICK=sha256 hex 라 절대 겹치지 않는다.
 */
async function assertNoDbWrite(label) {
  const supabase = require('../api/_supabase');
  const [{ data: prods }, { data: hist }] = await Promise.all([
    supabase.from('products').select('product_id').or('product_id.like.ADPICK-p%,product_id.like.쿠팡-p%'),
    supabase.from('price_history').select('product_id').or('product_id.like.ADPICK-p%,product_id.like.쿠팡-p%')
  ]);
  const leaked = (prods || []).length + (hist || []).length;
  check(`★ ${label}: 운영 DB 에 픽스처가 새어 들어가지 않았다`, leaked === 0,
    `products=${(prods || []).length} price_history=${(hist || []).length}`);
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
    const coupangResult = await runMallCollection({
      mallName: '쿠팡', rows: coupangRows, fetchAllFn: coupangFetch, savedState: null, deadlineTs: deadline
    });
    const adpickResult = await runMallCollection({
      mallName: 'ADPICK', rows: adpickRows, fetchAllFn: adpickFetch, savedState: null, deadlineTs: deadline
    });

    eq('쿠팡: 대상 6개', coupangResult.target, 6);
    eq('쿠팡: 시도 6개 전부 실패', coupangResult.attempted, 6);
    eq('쿠팡: 성공 0개', coupangResult.success, 0);
    eq('쿠팡: 저장 0행(DB 접근 없음)', coupangResult.recorded, 0);
    check('쿠팡: 실패 사유가 예외 메시지로 기록됨', coupangResult.failedKeywords.length > 0);

    eq('ADPICK: 대상 6개', adpickResult.target, 6);
    eq('ADPICK: 시도 6개(호출은 성공)', adpickResult.attempted, 6);
    eq('ADPICK: 성공 0개(매칭 없음 — no-match 는 성공이 아니다)', adpickResult.success, 0);
    eq('ADPICK: 저장 0행', adpickResult.recorded, 0);
    check('★ 쿠팡이 전부 실패해도 ADPICK 결과는 멀쩡하다(독립 실행 확인)',
      adpickResult.attempted === 6 && coupangResult.attempted === 6);
    await assertNoDbWrite('[3] 몰 독립성 케이스');
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
    const result = await runMallCollection({
      mallName: 'ADPICK', rows, fetchAllFn: fetchStub, savedState: null, deadlineTs: Date.now() + 5000
    });
    eq('대상(target) = 10', result.target, 10);
    eq('시도(attempted) = 10 (전부 이번 실행에서 처리)', result.attempted, 10);
    eq('★ 저장(recorded) = 0 — 가격 0 은 저장 경로로 넘어가지 않는다', result.recorded, 0);
    check('★ 대상(10) 과 시도(10) 와 저장(0) 이 서로 다른 숫자로 집계된다',
      result.target === 10 && result.attempted === 10 && result.recorded === 0);
    await assertNoDbWrite('[4] 숫자 분리 케이스');
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
    const result = await runMallCollection({
      mallName: '쿠팡', rows, fetchAllFn: fetchStub, savedState: null, deadlineTs: started + 200
    });
    const elapsed = Date.now() - started;
    check('★ deadline(200ms) 근처에서 멈춘다 — 배치 간격(60초) 만큼 기다리지 않는다',
      elapsed < 10000, `elapsed=${elapsed}ms`);
    check('전부 처리하지 못했다(상태 running 또는 남은 상품 있음)',
      result.status === 'running' || result.attempted < result.target);
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
    const result = await runMallCollection({
      mallName: 'ADPICK', rows, fetchAllFn: fetchStub, savedState, deadlineTs: Date.now() + 5000
    });
    check('★ 커서 이후 남은 그룹이 없어도 재시도 목록만으로 다시 시도한다',
      retried.includes('ADPICK-kw000') && retried.includes('ADPICK-kw001'),
      `retried=${JSON.stringify(retried)}`);
    eq('재시도까지 전부 성공하면 완료 상태로 전환', result.status, 'completed');
    await assertNoDbWrite('[6] 재시도 케이스');
  }
  console.log('');

  console.log(`=== 결과: ${pass}/${pass + fail} PASS ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('테스트 실행 오류:', e.message, e.stack);
  process.exit(1);
});
