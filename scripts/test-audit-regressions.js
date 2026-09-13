#!/usr/bin/env node
'use strict';
/*
 * 2026-09-13 FULL PRODUCT BUG AUDIT — 재현한 버그의 회귀 고정.
 *
 * 외부 호출 0회 · 운영 DB 0회. 각 검사는 수정 전 코드에서 실제로 실패했던 입력이다.
 *
 *   A. DB 오류 분류          PGRST002·504 를 «표 없음» 으로 읽지 않는다
 *   B. price_job_state      일시 장애는 재시도, 표 없음만 마이그레이션 안내
 *   C. 영구 폴백 플래그        쿠팡 전역 카운터 · products/price_history 컬럼 · 인증 RPC
 *   D. /api/hotdeals        일시 장애를 200 빈 목록으로 숨기지 않는다
 *   E. 1,000행 상한          _trust 이력이 오래된 날을 잃지 않는다
 *   F. AI 검색어 · 라우팅     조사 떼기가 상품명을 자르지 않는다 · 명사형 뉴스 요청
 *   G. 상품 동일성            수량 · 변형 · 번들 차이를 동일 유력으로 보지 않는다
 *   H. 구매 판정              짧은 급등 뒤 평소 가격 ≠ BUY · 하루 60% 급락 = 판정 보류
 *   I. 검색 부속             그래픽카드 지지대가 본품보다 위에 오지 않는다
 */
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'audit-regression-secret-0123456789abcdef';
global.fetch = async url => { throw new Error(`offline test made a network request: ${url}`); };

/* ── 가짜 Supabase — 검사마다 db 를 갈아 끼운다 ─────────────────────── */
let db = null;
function inject(rel, exportsValue) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p;
  require.cache[p].loaded = true;
  require.cache[p].exports = exportsValue;
}
inject('api/_supabase.js', new Proxy({}, {
  get(_target, prop) {
    if (prop === 'then') return undefined;
    if (!db || typeof db[prop] !== 'function') {
      return () => { throw new Error(`test db has no ${String(prop)}`); };
    }
    return db[prop].bind(db);
  }
}));
inject('api/_notify.js', { send: async () => ({ ok: true }) });

const PG002 = { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' };
const GW504 = { message: '<html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body><center><h1>504 Gateway Time-out</h1></center></body>\r\n</html>' };
const TABLE_MISSING = table => ({ code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });

/** from()/rpc() 호출마다 responses 를 하나씩 소비한다. 마지막 응답은 계속 반복한다. */
function scripted(responses, log) {
  const next = () => {
    const r = responses.length > 1 ? responses.shift() : responses[0];
    return typeof r === 'function' ? r() : r;
  };
  return {
    from(table) {
      const q = {};
      ['select', 'eq', 'in', 'gte', 'lt', 'order', 'limit', 'range', 'is', 'update', 'upsert', 'maybeSingle', 'insert']
        .forEach(m => { q[m] = () => q; });
      q.then = (resolve, reject) => { log.push(table); return Promise.resolve(next()).then(resolve, reject); };
      return q;
    },
    rpc(name) { log.push(`rpc:${name}`); return Promise.resolve(next()); }
  };
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (error) { failures.push(name); console.log(`  [FAIL] ${name}\n         ${error && error.message}`); }
}
const section = title => console.log(`\n[${title}]`);

function callApi(handler, query) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      json(body) { resolve({ status: this.statusCode, headers, body }); return this; },
      end() { resolve({ status: this.statusCode, headers, body: null }); return this; }
    };
    Promise.resolve(handler({ method: 'GET', headers: {}, query: query || {}, socket: { remoteAddress: '10.3.2.1' } }, res))
      .catch(reject);
  });
}

(async () => {
  console.log('=== FULL PRODUCT BUG AUDIT 회귀 (외부 호출 0회) ===');

  /* ── A ───────────────────────────────────────────────────────────── */
  section('A) DB 오류 분류');
  const DbError = require('../api/_dberror');
  await check('일시 장애(PGRST002 · 504 HTML · fetch failed · statement timeout)는 transient, 표 없음이 아니다', () => {
    for (const [err, kind] of [[PG002, 'DB_UNAVAILABLE'], [GW504, 'DB_TIMEOUT'],
      [{ message: 'TypeError: fetch failed' }, 'DB_UNAVAILABLE'],
      [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'DB_TIMEOUT']]) {
      const info = DbError.classifyDbError(err);
      assert.equal(info.kind, kind, JSON.stringify(err));
      assert.equal(info.transient, true);
      assert.equal(info.missing, false);
    }
  });
  await check('진짜 없음은 종류별로 가른다 (표 · 컬럼 · 함수 · 환경변수)', () => {
    assert.equal(DbError.classifyDbError(TABLE_MISSING('hotdeals')).kind, 'TABLE_MISSING');
    assert.equal(DbError.classifyDbError('relation "public.hotdeals" does not exist').kind, 'TABLE_MISSING');
    assert.equal(DbError.classifyDbError("Could not find the 'source' column of 'price_history' in the schema cache").kind, 'COLUMN_MISSING');
    assert.equal(DbError.classifyDbError('column price_history.vendor_item_id does not exist').kind, 'COLUMN_MISSING');
    assert.equal(DbError.classifyDbError('Could not find the function public.auth_code_attempt(p_email, p_hash) in the schema cache').kind, 'FUNCTION_MISSING');
    assert.equal(DbError.classifyDbError('Supabase 환경변수 누락: SUPABASE_URL').kind, 'CONFIG_MISSING');
    assert.equal(DbError.classifyDbError('duplicate key value violates unique constraint').missing, false);
  });
  await check('withDbRetry 는 일시 장애만 다시 시도한다', async () => {
    let n = 0;
    const ok = await DbError.withDbRetry(async () => (++n < 3 ? { error: PG002 } : { data: 1, error: null }), { baseDelayMs: 0 });
    assert.equal(ok.data, 1);
    assert.equal(n, 3);
    let m = 0;
    await DbError.withDbRetry(async () => { m++; return { error: TABLE_MISSING('x') }; }, { baseDelayMs: 0 });
    assert.equal(m, 1);
  });

  /* ── B ───────────────────────────────────────────────────────────── */
  section('B) price_job_state 읽기');
  const Collector = require('./collect-all-prices');
  await check('PGRST002 → 504 → 성공: 재시도해서 이어 간다', async () => {
    const log = [];
    const fake = scripted([{ data: null, error: PG002 }, { data: null, error: GW504 }, { data: { job_date: '2026-09-13' }, error: null }], log);
    const state = await Collector.loadState({ db: fake, baseDelayMs: 0 });
    assert.equal(state.job_date, '2026-09-13');
    assert.equal(log.length, 3);
  });
  await check('게이트웨이 타임아웃이 계속되면 DB_TIMEOUT 으로 멈추고 «테이블이 없습니다» 라고 말하지 않는다', async () => {
    const log = [];
    const error = await Collector.loadState({ db: scripted([{ data: null, error: GW504 }], log), baseDelayMs: 0, attempts: 3 })
      .then(() => null, e => e);
    assert(error, 'must throw');
    assert.equal(error.dbErrorKind, 'DB_TIMEOUT');
    assert(!error.message.includes('테이블이 없습니다'), error.message);
    assert.equal(log.length, 3);
  });
  await check('표가 정말 없으면 재시도 없이 마이그레이션 안내', async () => {
    const log = [];
    const error = await Collector.loadState({ db: scripted([{ data: null, error: TABLE_MISSING('price_job_state') }], log), baseDelayMs: 0 })
      .then(() => null, e => e);
    assert(error && error.message.includes(Collector.STATE_MISSING_HINT), error && error.message);
    assert.equal(log.length, 1);
  });

  /* ── C ───────────────────────────────────────────────────────────── */
  section('C) 프로세스 수명짜리 폴백 플래그');
  await check('쿠팡 전역 호출 카운터는 일시 장애로 꺼지지 않는다', () => {
    const Coupang = require('../api/_coupang');
    assert.equal(Coupang.permanentGateFailure(PG002.message), false);
    assert.equal(Coupang.permanentGateFailure(GW504.message), false);
    assert.equal(Coupang.permanentGateFailure('Could not find the function public.coupang_acquire(max_per_min, src, kw) in the schema cache'), true);
    assert.equal(Coupang.permanentGateFailure('Supabase 환경변수 누락: SUPABASE_URL'), true);
  });
  await check('products/price_history 컬럼 플래그는 일시 장애로 꺼지지 않는다 (vendor_item_id 저장 유지)', () => {
    const Shop = require('../api/_shop');
    assert.equal(Shop.missingColumn(PG002.message), false);
    assert.equal(Shop.missingColumn(GW504.message), false);
    assert.equal(Shop.missingColumn("Could not find the 'vendor_item_id' column of 'products' in the schema cache"), true);
  });
  await check('인증 시도 RPC 일시 장애 → 거절하고, 다음 요청도 원자적 RPC 경로를 쓴다', async () => {
    const Auth = require('../api/_auth');
    const log = [];
    db = scripted([{ data: null, error: PG002 }, { data: [{ allowed: true, matched: false, expired: false }], error: null }], log);
    const first = await Auth.consumeCode('audit@example.com', '123456');
    assert.equal(first.ok, false);
    assert.match(first.error, /인증을 처리하지 못했어요/);
    const second = await Auth.consumeCode('audit@example.com', '123456');
    assert.equal(second.error, '코드가 일치하지 않습니다');
    assert.deepEqual(log.filter(x => x.startsWith('rpc:')), ['rpc:auth_code_attempt', 'rpc:auth_code_attempt']);
    assert(!log.includes('auth_codes'), 'must not fall back to the non-atomic select path');
  });

  /* ── D ───────────────────────────────────────────────────────────── */
  section('D) /api/hotdeals');
  const hotdeals = require('../api/hotdeals');
  await check('DB 일시 장애는 5xx — 200 빈 목록(pending)으로 숨기지 않는다', async () => {
    db = scripted([{ data: null, error: PG002 }], []);
    const r = await callApi(hotdeals, {});
    assert.equal(r.status, 500);
    assert.equal(r.body.pending, undefined);
  });
  await check('표가 정말 없으면 예전처럼 200 pending', async () => {
    db = scripted([{ data: null, error: TABLE_MISSING('hotdeals') }], []);
    const r = await callApi(hotdeals, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.pending, true);
  });

  /* ── E ───────────────────────────────────────────────────────────── */
  section('E) 1,000행 상한');
  await check('_trust.loadRecentHistory 는 1,800행(60상품 × 30일)을 전부 받는다', async () => {
    const { kstToday } = require('../api/_price');
    const Trust = require('../api/_trust');
    const today = kstToday();
    const day = n => kstToday(new Date(Date.parse(`${today}T12:00:00+09:00`) - n * 86400000));
    const rows = [];
    for (let i = 0; i < 60; i++) {
      for (let d = 0; d < 30; d++) {
        rows.push({ product_id: `p${i}`, mall: '쿠팡', vendor_item_id: `v${i}`, price: 10000 + d,
          recorded_date: day(d), recorded_at: `${day(d)}T01:00:00Z` });
      }
    }
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    db = {
      from() {
        const f = { ids: null, gte: null, from: 0, to: 999 };
        const q = {
          select: () => q,
          in: (_c, v) => { f.ids = new Set(v.map(String)); return q; },
          gte: (_c, v) => { f.gte = v; return q; },
          order: () => q,
          limit: n => { f.to = n - 1; return q; },
          range: (a, b) => { f.from = a; f.to = b; return q; },
          then: resolve => {
            const hit = rows.filter(r => (!f.ids || f.ids.has(r.product_id)) && (!f.gte || r.recorded_date >= f.gte))
              .sort((a, b) => cmp(b.recorded_date, a.recorded_date) || cmp(a.product_id, b.product_id)
                || cmp(a.mall, b.mall) || cmp(a.vendor_item_id, b.vendor_item_id));
            const want = hit.slice(f.from, f.to + 1);
            return Promise.resolve({ data: want.slice(0, 1000), error: null }).then(resolve);   // db-max-rows
          }
        };
        return q;
      }
    };
    const map = await Trust.loadRecentHistory(rows.filter(r => r.recorded_date === today)
      .map(r => ({ productId: r.product_id, mall: r.mall, vendorItemId: r.vendor_item_id })));
    // 상품 단위 키("pid|mall")만 센다 — 같은 점이 옵션 키("pid|mall|vid")에도 한 번 더 담긴다.
    const perProduct = Array.from({ length: 60 }, (_, i) => (map.get(`p${i}|쿠팡`) || []).length);
    assert.equal(perProduct.reduce((s, n) => s + n, 0), 1800, `got ${perProduct.join(',')}`);
    assert(perProduct.every(n => n === 30), 'every product keeps all 30 days');
  });

  /* ── F ───────────────────────────────────────────────────────────── */
  section('F) AI 검색어 · 라우팅');
  const Intent = require('../api/_intent');
  for (const [q, want] of [
    ['맥북 프로 추천', '맥북 프로'], ['아이패드 프로 가격', '아이패드 프로'], ['에어팟 프로 살까', '에어팟 프로'],
    ['아이폰 17 프로 살까 말까', '아이폰 17 프로'], ['사과 5kg 최저가', '사과 5kg'], ['포도 2kg 얼마', '포도 2kg'],
    ['고양이 사료 추천', '고양이 사료'], ['목걸이 추천', '목걸이'], ['와이파이 공유기 추천', '와이파이 공유기'],
    ['마이크로 SD카드 256GB', '마이크로 SD카드 256GB'],
    // 떼야 하는 조사는 여전히 뗀다
    ['이어폰은 뭐가 좋아', '이어폰'], ['키보드로 뭐가 좋아', '키보드'], ['책상을 사고 싶어', '책상']
  ]) {
    await check(`검색어 "${q}" → "${want}"`, () => assert.equal(Intent.extractQuery(q), want));
  }
  for (const [q, intent] of [['엔비디아 뉴스', 'N'], ['애플 신제품 발표 소식', 'N'], ['노트북 뉴스', 'N'],
    ['오늘 AI 뉴스 알려줘', 'N'], ['노트북 추천', 'C'], ['콜라 355ml 24캔 최저가', 'D']]) {
    await check(`의도 "${q}" → ${intent}`, () => assert.equal(Intent.classify(q, []).intent, intent));
  }

  /* ── G ───────────────────────────────────────────────────────────── */
  section('G) 상품 동일성');
  const Identity = require('../api/_identity');
  const HD = require('../api/_hotdeal');
  for (const [a, b] of [
    ['닭가슴살 500g', '닭가슴살 500g 4개'], ['MSI RTX 5070 벤투스', 'MSI RTX 5070 Ti 벤투스'],
    ['닌텐도 스위치 2', '닌텐도 스위치 2 마리오카트 번들'], ['닌텐도 스위치 OLED', '닌텐도 스위치'],
    ['코카콜라 355ml 24캔', '코카콜라 355ml 48캔'], ['농심 안성탕면 20개 + 삼양라면 10개', '농심 안성탕면 10개 + 삼양라면 10개'],
    ['우르오스 스킨밀크 200ml x2', '우르오스 스킨밀크 200ml']
  ]) {
    await check(`"${a}" ≠ "${b}" (양방향, 핫딜 IDENTITY 관문 탈락)`, () => {
      assert.equal(Identity.judgeSameProduct(a, b).tier, 'D', JSON.stringify(Identity.judgeSameProduct(a, b)));
      assert.equal(Identity.judgeSameProduct(b, a).tier, 'D');
      assert.equal(HD.identityOf(a, b).level, HD.IDENTITY.REJECT);
    });
  }
  await check('같은 상품은 여전히 같다 (정규화 제목 · 브랜드+모델코드 · 5개입=5개)', () => {
    assert.equal(Identity.judgeSameProduct('로지텍 G304 LIGHTSPEED 무선 마우스', '로지텍 G304 LIGHTSPEED 무선 게이밍 마우스').tier, 'A');
    assert.equal(Identity.judgeSameProduct('신라면 120g 5개입', '신라면 5개입 120g').tier, 'A');
    assert.notEqual(Identity.judgeSameProduct('신라면 120g 5개입', '신라면 120g 5개').tier, 'D');
  });

  /* ── H ───────────────────────────────────────────────────────────── */
  section('H) 구매 판정');
  const Stat = require('../api/_pricestat');
  const Deal = require('../api/_deal');
  const TODAY = '2026-09-13';
  const series = (n, f) => Array.from({ length: n }, (_, i) => {
    const back = n - 1 - i;
    return { date: new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86400000).toISOString().slice(0, 10), price: f(back) };
  });
  const judge = (points, price) => Deal.dealOf(Stat.statsFrom(points), price, TODAY);
  await check('사흘 급등 뒤 평소 가격(100,000원)으로 돌아온 것은 BUY/GOOD_BUY 가 아니다', () => {
    // 급등이 바로 어제 끝났으면 직전 기록 대비 절반이라 판정 보류(UNKNOWN)가 된다.
    const d = judge(series(40, b => (b >= 1 && b <= 3 ? 200000 : 100000)), 100000);
    assert(!['BUY', 'GOOD_BUY'].includes(d.verdict), `${d.verdict}/${d.score} ${d.reasons.join(' | ')}`);
    // 급등이 그저께 끝나 어제도 평소 가격이면 이상 탐지를 지나 백분위·평균으로 판정된다 — 이 경로가 BUY 였다.
    const e = judge(series(40, b => (b >= 2 && b <= 4 ? 200000 : 100000)), 100000);
    assert(!['BUY', 'GOOD_BUY'].includes(e.verdict), `${e.verdict}/${e.score} ${e.reasons.join(' | ')}`);
    assert(!e.reasons.some(r => /가장 낮은 가격/.test(r)), e.reasons.join(' | '));
  });
  await check('하루 만에 60% 급락한 값은 price_drop 이상으로 판정 보류', () => {
    const d = judge(series(40, b => (b === 0 ? 40000 : 100000)), 40000);
    assert(d.anomalies.some(a => a.kind === 'price_drop'), JSON.stringify(d.anomalies));
    assert.equal(d.verdict, 'UNKNOWN');
  });
  await check('진짜 신저가와 꾸준한 하락은 여전히 좋은 가격이다 · 평소보다 비싸면 사지 말라는 쪽', () => {
    assert(['BUY', 'GOOD_BUY'].includes(judge(series(40, b => (b === 0 ? 85000 : 100000)), 85000).verdict));
    assert(['BUY', 'GOOD_BUY'].includes(judge(series(40, b => 100000 + b * 1250), 100000).verdict));
    assert(['WAIT', 'DONT_BUY'].includes(judge(series(40, b => (b === 0 ? 115000 : 100000)), 115000).verdict));
  });

  /* ── I ───────────────────────────────────────────────────────────── */
  section('I) 검색 부속');
  const Search = require('../api/_search');
  await check('"RTX 5070" — 그래픽카드 지지대가 본품보다 위에 오지 않는다', () => {
    const items = [
      { title: 'RTX 5070 그래픽카드 지지대', lprice: 15000, mall: '쿠팡', productId: 'a' },
      { title: 'MSI 지포스 RTX 5070 벤투스 2X OC 12GB', lprice: 890000, mall: '쿠팡', productId: 'b' }
    ];
    const ranked = Search.sortByRelevance(Search.rankItems('RTX 5070', items, { minScore: 0 }).items);
    assert.match(ranked[0].title, /MSI/);
  });
  await check('"허리 지지대" 처럼 검색어에 부속어가 있으면 내리지 않는다', () => {
    const f = Search.productFocus(Search.analyzeQuery('허리 지지대'), '허리 지지대 복대');
    assert.equal(f.factor, 1);
  });

  /* ── J ───────────────────────────────────────────────────────────── */
  section('J) SEOSA HOT 저장');
  const HotCollector = require('./collect-hotdeals');
  await check('새 딜과 기존 딜이 섞인 묶음도 모든 행에 detected_at 이 있다 (NOT NULL 위반으로 전체 거부되지 않는다)', () => {
    const nowIso = '2026-09-13T04:58:55.000Z';
    const fresh = HotCollector.withDetectedAt({ source: 'internal-history', source_external_id: 'a' }, undefined, nowIso);
    const kept = HotCollector.withDetectedAt({ source: 'internal-history', source_external_id: 'b' },
      { detected_at: '2026-09-06T01:00:00.000Z' }, nowIso);
    const batch = [fresh, kept];
    assert(batch.every(r => typeof r.detected_at === 'string' && r.detected_at), JSON.stringify(batch));
    assert.equal(fresh.detected_at, nowIso);
    assert.equal(kept.detected_at, '2026-09-06T01:00:00.000Z', '처음 발견한 시각은 유지한다');
  });
  await check('upsert 가 한 건이라도 실패하면 실행 결과는 failed 다 (초록불로 숨기지 않는다)', () => {
    assert.equal(HotCollector.writeOutcome({ ok: 0, failed: 35 }), 'failed');
    assert.equal(HotCollector.writeOutcome({ ok: 35, failed: 0 }), 'done');
  });

  console.log(`\nPASS ${passed}  /  FAIL ${failures.length}`);
  if (failures.length) { console.log('failed: ' + failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
