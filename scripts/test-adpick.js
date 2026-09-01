#!/usr/bin/env node
/*
 * ADPICK 데이터 무결성 회귀 테스트 — 외부 호출 0회 / 운영 Supabase 접근 0회.
 *
 *   node scripts/test-adpick.js
 *
 * 무엇을 지키는 테스트인가
 *
 * 2026-08-27 ADPICK 하드닝 감사에서 확인·수정한 것들을 고정한다. ADPICK 은
 * 쿠팡과 식별 체계가 근본적으로 다르다 —
 *
 *   쿠팡    productId + vendorItemId 를 API 가 직접 준다.
 *   ADPICK  상품 ID 필드가 아예 없다. title/price/photo/cp_code/cp_name/
 *           commissionlink 뿐이라, commissionlink 를 sha256 해서 product_id 로 쓴다.
 *
 * 그래서 "commissionlink 가 상품마다 하나이고 재조회해도 같다" 는 전제가 무너지면
 * ADPICK 데이터 전체가 조용히 망가진다. 운영 실측(2026-08-27)으로 그 전제를
 * 확인했고(33시간 뒤 재조회 20/20 동일, 고유 링크 398건 중 충돌 0건), 아래
 * 테스트는 그 전제를 코드 쪽에서 고정한다.
 *
 * 감사에서 실제로 고친 두 가지도 여기서 고정한다.
 *   ① price_history 쓰기 실패 → products 쓰기 차단
 *      (원장 없는 현재가가 화면에 현재가로 찍히던 문제. 운영 179행 중 10행)
 *   ② 신뢰도 배지의 출처를 항목별 _source 로 판정
 *      (쿠팡 from 하나로 뭉뚱그려 ADPICK 카드가 "방금 확인" 이라고 거짓말하던 문제)
 */
'use strict';

const path = require('path');
const Module = require('module');
const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 *  가짜 Supabase — api/_shop.js / api/_trust.js 가 쓰는 것만 흉내 낸다.
 * ------------------------------------------------------------------ */
const db = {
  price_history: [],
  products: [],
  adpick_search_cache: [],
  upserts: { products: [], price_history: [], adpick_search_cache: [] }
};

/** 다음 upsert 를 강제로 실패시킬 테이블 이름 (부분 실패 재현용). */
let failUpsertOn = '';

function reset() {
  db.price_history = [];
  db.products = [];
  db.adpick_search_cache = [];
  db.upserts = { products: [], price_history: [], adpick_search_cache: [] };
  failUpsertOn = '';
}

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function makeQuery(table) {
  const filters = { in: null, lt: null, gte: [], eq: [] };
  let sort = null, cap = null;
  const q = {
    select() { return q; },
    order(col, opts) { sort = { col, asc: !opts || opts.ascending !== false }; return q; },
    limit(n) { cap = n; return q; },
    in(col, vals) { filters.in = { col, vals: vals.map(String) }; return q; },
    lt(col, v) { filters.lt = { col, v }; return q; },
    gte(col, v) { filters.gte.push({ col, v }); return q; },
    eq(col, v) { filters.eq.push({ col, v }); return q; },
    range() { return q; },
    maybeSingle() {
      return q.then(r => ({ data: (r.data || [])[0] || null, error: r.error }));
    },
    then(resolve, reject) {
      let rows = db[table] || [];
      if (filters.in) rows = rows.filter(r => filters.in.vals.indexOf(String(r[filters.in.col])) > -1);
      if (filters.lt) rows = rows.filter(r => String(r[filters.lt.col]) < String(filters.lt.v));
      filters.gte.forEach(f => { rows = rows.filter(r => cmp(r[f.col], f.v) >= 0); });
      filters.eq.forEach(f => { rows = rows.filter(r => String(r[f.col]) === String(f.v)); });
      if (sort) rows = rows.slice().sort((a, b) => (sort.asc ? 1 : -1) * cmp(a[sort.col], b[sort.col]));
      if (cap != null) rows = rows.slice(0, cap);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
  };
  return q;
}

const fakeSupabase = {
  from(table) {
    return Object.assign(makeQuery(table), {
      update() { return { eq: () => Promise.resolve({ data: null, error: null }) }; },
      upsert(rows) {
        const list = Array.isArray(rows) ? rows : [rows];
        if (failUpsertOn === table) {
          return Promise.resolve({ data: null, error: { message: 'deadlock detected' } });
        }
        db.upserts[table].push(...list);
        const key = table === 'price_history'
          ? ['product_id', 'mall', 'vendor_item_id', 'recorded_date']
          : table === 'products' ? ['product_id', 'mall'] : ['keyword'];
        list.forEach(r => {
          const i = (db[table] || []).findIndex(x => key.every(k => String(x[k] || '') === String(r[k] || '')));
          if (i > -1) db[table][i] = { ...db[table][i], ...r };
          else db[table].push({ ...r });
        });
        return Promise.resolve({ data: list, error: null });
      }
    });
  },
  rpc() { return Promise.resolve({ data: null, error: null }); }
};

const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

const { recordPrices, adpickProductId } = require('../api/_shop');
const { attachTrust } = require('../api/_trust');
const { kstToday, observedKstDate, todayDropConfirmed, vendorIdOf } = require('../api/_price');
const { redact, mallLabelFromCpName } = require('../api/_adpick');

/* ------------------------------------------------------------------ *
 *  유틸
 * ------------------------------------------------------------------ */
let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function section(name) {
  console.log(`\n──────────────────────────────────────────────────────────────────`);
  console.log(name);
  console.log(`──────────────────────────────────────────────────────────────────`);
}

const ADPICK_MALL = 'ADPICK';
const link = n => `https://biz.adpick.co.kr/r${n}`;

/** ADPICK 관측 한 건 (api/_shop.fetchAdpick 이 만드는 모양과 같게). */
function ad(n, price, extra = {}) {
  return {
    productId: adpickProductId(link(n)),
    mall: ADPICK_MALL,
    keyword: extra.keyword || '여행용 캐리어',
    title: extra.title || `테스트 상품 ${n}`,
    price,
    oprice: price,
    savePct: 0,
    link: link(n),
    image: extra.image || `https://img.example/${n}.jpg`,
    itemId: '',
    vendorItemId: '',
    mallLabel: extra.mallLabel || '알리',
    ...extra
  };
}

(async () => {

/* ================================================================== *
 *  A — 상품 식별자
 * ================================================================== */
section('A — ADPICK 식별자 (product_id = sha256(commissionlink))');

check(adpickProductId(link(1)) === adpickProductId(link(1)),
  '같은 링크는 항상 같은 product_id (재조회 안정성)');
check(adpickProductId(link(1)) !== adpickProductId(link(2)),
  '다른 링크는 다른 product_id');
check(/^[0-9a-f]{64}$/.test(adpickProductId(link(1))),
  'sha256 전체 64자 hex — 잘라 쓰지 않는다 (충돌 여지 제거)',
  adpickProductId(link(1)).slice(0, 12) + '…');

/*
 * ★ 쿠팡 pid 와 값 공간이 겹치지 않아야 한다.
 *   products 는 (product_id, mall) 이 유일키라 mall 이 다르면 애초에 다른 행이지만,
 *   pid 공간까지 겹치지 않으면 사람이 로그를 볼 때도 헷갈리지 않는다.
 */
check(!/^\d+$/.test(adpickProductId(link(1))),
  'ADPICK pid 는 순수 숫자가 아니다 — 쿠팡 숫자 pid 와 값이 겹칠 수 없다');

/*
 * URL 변형. 운영 실측(2026-08-27) 결과 commissionlink 는 형태가 하나뿐이고
 * (https://biz.adpick.co.kr/rN) 쿼리·끝슬래시·대문자가 전부 0건이라 정규화가
 * 필요 없다. 다만 "변형이 오면 다른 상품으로 갈린다" 는 사실은 명시해 둔다 —
 * 나중에 ADPICK 이 링크 형태를 바꾸면 이 테스트가 먼저 알려 준다.
 */
check(adpickProductId(link(1)) !== adpickProductId(link(1) + '/'),
  '끝 슬래시가 붙으면 다른 pid (현재 응답에는 그런 변형이 없음 — 형태 변화 감시용)');

check(vendorIdOf(ad(1, 1000)) === '',
  'ADPICK 은 vendor_item_id 가 빈 문자열 (쿠팡 옵션 개념 없음)');
check(vendorIdOf({ mall: '쿠팡', link: 'https://www.coupang.com/vp/products/1?vendorItemId=999' }) === '999',
  '★ 쿠팡의 vendorItemId 추출은 그대로 동작한다 (기존 식별 구조 불변)');

/* ================================================================== *
 *  B — 다른 몰과 섞이지 않는가
 * ================================================================== */
section('B — cross-mall / cross-product 오염');

reset();
await recordPrices([
  ad(100, 10000, { title: '같은 이름 상품' }),
  { productId: '9999', mall: '쿠팡', keyword: 'k', title: '같은 이름 상품', price: 20000,
    oprice: 20000, savePct: 0, link: 'https://www.coupang.com/vp/products/9999?vendorItemId=88',
    image: '', itemId: '', vendorItemId: '88', mallLabel: '' }
], { label: 'mix' });

check(db.products.length === 2, '상품명이 같아도 ADPICK/쿠팡이 각각 한 행으로 남는다', String(db.products.length));
const adRow = db.products.find(p => p.mall === ADPICK_MALL);
const cpRow = db.products.find(p => p.mall === '쿠팡');
check(adRow.product_id !== cpRow.product_id, '두 행의 product_id 가 다르다');
check(adRow.lprice === 10000 && cpRow.lprice === 20000,
  '가격이 서로 덮어쓰이지 않는다', `ADPICK=${adRow.lprice} 쿠팡=${cpRow.lprice}`);
check(adRow.link !== cpRow.link, 'link 가 서로 섞이지 않는다');
check(db.price_history.filter(h => h.mall === ADPICK_MALL).length === 1
   && db.price_history.filter(h => h.mall === '쿠팡').length === 1,
  'history 도 mall 별로 각각 남는다');

// ADPICK 끼리 — 이름이 같아도 링크가 다르면 다른 상품
reset();
await recordPrices([
  ad(200, 10000, { title: '동일 상품명' }),
  ad(201, 30000, { title: '동일 상품명' })
], { label: 'ad-ad' });
check(db.products.length === 2, '이름이 같은 ADPICK 상품 둘은 합쳐지지 않는다', String(db.products.length));
check(new Set(db.products.map(p => p.lprice)).size === 2, '두 상품의 가격이 서로 독립적이다');

// mall 은 항상 상수. cp_name 은 mall_label 로만 간다.
reset();
await recordPrices([ad(300, 5000, { mallLabel: 'SSG' })], { label: 'label' });
check(db.products[0].mall === 'ADPICK', '★ mall 은 상수 ADPICK — cp_name 이 mall 로 새지 않는다', db.products[0].mall);
check(db.products[0].mall_label === 'SSG', '표시 이름은 mall_label 에만 들어간다', db.products[0].mall_label);
check(db.price_history[0].mall === 'ADPICK', 'history 의 mall 도 상수 ADPICK');

check(mallLabelFromCpName('알리익스프레스') === '알리', 'cp_name 축약 규칙 — 알리익스프레스 → 알리');
check(mallLabelFromCpName('SSG') === 'SSG', '규칙에 없는 cp_name 은 원본 그대로 (지어내지 않는다)');
check(mallLabelFromCpName('') === '', 'cp_name 이 없으면 빈 문자열');

/* ================================================================== *
 *  C — products / price_history 일관성  ★ 이번 감사의 핵심 수정
 * ================================================================== */
section('C — 원장 없는 현재가 차단 (2026-08-27 수정)');

reset();
const okRun = await recordPrices([ad(400, 9900), ad(401, 12000)], { label: 'ok' });
check(db.upserts.price_history.length === 2 && db.upserts.products.length === 2,
  '정상 경로 — 두 테이블에 각각 2행');
check(okRun.errors.length === 0 && okRun.saved === 2 && okRun.recorded === 2,
  '정상 경로 반환값 불변', `saved=${okRun.saved} recorded=${okRun.recorded}`);

reset();
failUpsertOn = 'price_history';
const badRun = await recordPrices([ad(402, 9900), ad(403, 283500)], { label: 'fail' });
failUpsertOn = '';
check(db.upserts.price_history.length === 0, 'price_history 쓰기 실패');
check(db.upserts.products.length === 0,
  '★ products 도 쓰지 않는다 — 원장 없는 현재가를 남기지 않는다', String(db.upserts.products.length));
check(badRun.errors.length === 1 && /price_history/.test(badRun.errors[0]),
  '원장 오류가 errors 로 보고된다', badRun.errors[0]);
check(!/products:/.test(badRun.errors.join(' ')),
  'products 오류를 만들어내지 않는다 (건너뛴 것이지 실패가 아니다)');
check(badRun.saved === 0 && badRun.recorded === 0, 'saved=0 recorded=0');
/*
 * ★ 원장이 실패했으면 확보한 상품도 없다 (2026-09-01 감사).
 *   recordedKeys 는 Daily Collection 성공률의 근거(collectorCovered)로 바로
 *   들어가므로, 저장되지 않은 가격이 여기 섞이면 성공률이 거짓이 된다.
 */
check(Array.isArray(badRun.recordedKeys) && badRun.recordedKeys.length === 0,
  '★ history 실패 + products 건너뜀 → recordedKeys 비어 있다',
  JSON.stringify(badRun.recordedKeys));

// 다음 회차 복구
const recovered = await recordPrices([ad(402, 9900), ad(403, 283500)], { label: 'retry' });
check(db.upserts.price_history.length === 2 && db.upserts.products.length === 2,
  '다음 수집이 그대로 복구한다 (pid 가 안정적이라 중복이 생기지 않는다)');
check(recovered.errors.length === 0, '복구 시 오류 없음');
check(db.products.length === 2, '복구 후에도 상품 수가 늘지 않는다 (중복 없음)', String(db.products.length));

// 반대 순서 — products 만 실패하면 원장은 그대로 남는다
reset();
failUpsertOn = 'products';
const catFail = await recordPrices([ad(404, 7000)], { label: 'cat-fail' });
failUpsertOn = '';
check(db.upserts.price_history.length === 1,
  '반대 순서(products 만 실패)에서는 원장을 남긴다 — 가격을 과장하지 않는다');
check(/products:/.test(catFail.errors.join(' ')), 'products 오류가 보고된다');
/*
 * ★★ 여기가 2026-09-01 감사에서 잡은 BLOCKER 다.
 *
 *   원장에는 가격이 남았는데(위 줄에서 확인) recordedKeys 가 비면, 그 상품은
 *   collectorCovered 에서 통째로 빠져 수집 성공률이 실제보다 낮게 보고된다.
 *   예전 구현은 errors.length 로 판정해서 products 오류 하나 때문에 원장
 *   성공분까지 버렸다. 이제 historyFailed 로만 판정한다.
 */
check(catFail.recordedKeys.length === 1,
  '★★ products 만 실패해도 원장에 남은 상품은 recordedKeys 에 포함된다',
  JSON.stringify(catFail.recordedKeys));
check(catFail.recorded === 0 && catFail.saved === 0,
  '  (recorded / saved 의 보수적 의미는 그대로 둔다 — 기존 계약 유지)',
  `recorded=${catFail.recorded} saved=${catFail.saved}`);

/* ================================================================== *
 *  D — 저장 거부 / 결측 입력
 * ================================================================== */
section('D — 결측·이상 입력');

reset();
await recordPrices([
  { ...ad(500, 9900), productId: '' },
  { ...ad(501, 9900), title: '' },
  { ...ad(502, 9900), mall: '' }
], { label: 'missing' });
check(db.products.length === 0 && db.price_history.length === 0,
  '★ 식별자·상품명·mall 이 없으면 아무것도 저장하지 않는다 (상품명을 pid 로 쓰지 않는다)');

reset();
const zero = await recordPrices([ad(503, 0), ad(504, -100)], { label: 'zero' });
check(db.price_history.length === 0 && db.products.length === 0,
  '0원·음수 가격은 저장하지 않는다');
check(zero.rejected === 2, '거부 건수를 보고한다', String(zero.rejected));

reset();
await recordPrices([ad(505, 999999999999)], { label: 'huge' });
check(db.products.length === 0, '비정상적으로 큰 가격(1억 초과)은 현재가로 올리지 않는다');

/* ================================================================== *
 *  E — 배치 내 중복 접기
 * ================================================================== */
section('E — 같은 배치에 같은 상품이 두 번 들어올 때');

reset();
await recordPrices([ad(600, 30000), ad(600, 19900)], { label: 'dup' });
check(db.upserts.price_history.length === 1,
  '같은 pid 는 한 행으로 접힌다 (upsert 통째 실패 방지)', String(db.upserts.price_history.length));
check(db.products[0].lprice === 19900,
  '★ 겹치면 싼 쪽을 남긴다 — 순서에 기대지 않는다', String(db.products[0].lprice));

/* ================================================================== *
 *  F — 날짜 (KST/UTC)
 * ================================================================== */
section('F — KST 날짜 경계');

reset();
const noonKst = new Date('2026-08-27T03:00:00Z');   // KST 12:00
await recordPrices([ad(700, 5000)], { label: 'kst', now: noonKst });
check(db.price_history[0].recorded_date === '2026-08-27',
  'recorded_date 는 KST 달력으로 보낸다', db.price_history[0].recorded_date);
check(db.price_history[0].recorded_at === noonKst.toISOString(),
  'recorded_at 은 UTC 절대시각 그대로');

// 관측일 판정은 라벨이 아니라 recorded_at 으로 한다
check(observedKstDate({ recorded_date: '2026-08-26', recorded_at: '2026-08-26T18:00:00Z' }) === '2026-08-27',
  '★ UTC 라벨이 하루 이르게 찍혀도 KST 관측일은 정확히 나온다 (cron KST 03:00 = UTC 18:00)');
check(observedKstDate({ recorded_date: '2026-08-27', recorded_at: '2026-08-27T03:00:00Z' }) === '2026-08-27',
  'KST 12:00 관측도 같은 날로 나온다');
check(observedKstDate({ recorded_date: '2026-08-27', recorded_at: '2026-08-27T14:59:00Z' }) === '2026-08-27',
  'KST 23:59 경계 — 아직 오늘');
check(observedKstDate({ recorded_date: '2026-08-27', recorded_at: '2026-08-27T15:00:00Z' }) === '2026-08-28',
  'KST 00:00 경계 — 다음 날');

/*
 * ★ 같은 KST 날에 UTC 라벨이 갈려 2행이 생기는 구조를 고정한다.
 *
 *   운영 실측(2026-08-27): ADPICK 169 pid 중 29개가 2행이다. cron(KST 03:00 =
 *   UTC 전날 18:00)과 사용자 검색(KST 09:00 이후 = UTC 당일)이 서로 다른
 *   recorded_date 라벨을 받기 때문이다. UNIQUE 에 recorded_date 가 들어가므로
 *   두 행이 남는다.
 *
 *   지금 중요한 성질은 "거짓 하락이 만들어지지 않는다" 다. todayDropConfirmed 는
 *   비교 대상(prev)을 오늘이 아닌 날에서만 찾으므로, 같은 날 안의 값 변동은
 *   절대 "오늘의 하락" 이 되지 않는다.
 */
const sameDayOnly = [
  { price: 20000, recorded_date: '2026-08-26', recorded_at: '2026-08-26T18:00:00Z' },  // KST 08-27
  { price: 15000, recorded_date: '2026-08-27', recorded_at: '2026-08-27T03:00:00Z' }   // KST 08-27
];
check(todayDropConfirmed({ current_price: 15000, prev_price: 20000 }, sameDayOnly, '2026-08-27') === false,
  '★ 같은 KST 날 안의 인트라데이 변동은 "오늘의 하락" 이 되지 않는다 (거짓 하락 차단)');

const realDrop = [
  { price: 20000, recorded_date: '2026-08-25', recorded_at: '2026-08-25T18:00:00Z' },  // KST 08-26
  { price: 15000, recorded_date: '2026-08-26', recorded_at: '2026-08-26T18:00:00Z' }   // KST 08-27
];
check(todayDropConfirmed({ current_price: 15000, prev_price: 20000 }, realDrop, '2026-08-27') === true,
  '하루 1행이면 실제 하락이 정상 노출된다');

/* ================================================================== *
 *  G — 신뢰도 배지 출처  ★ 이번 감사의 두 번째 수정
 * ================================================================== */
section('G — 신뢰도 출처는 항목별 _source 로 판정 (2026-08-27 수정)');

reset();
const mixed = [
  { productId: 'C1', mall: '쿠팡', link: 'https://www.coupang.com/vp/products/1?vendorItemId=7', _source: 'api' },
  { productId: adpickProductId(link(800)), mall: ADPICK_MALL, link: link(800), _source: 'stale-cache' }
];
// 배치 전체의 source 는 쿠팡의 'api' — 예전에는 이 값이 ADPICK 에도 적용됐다.
await attachTrust(mixed, { source: 'api' });
check(mixed[0].trust.reasons.some(r => r.code === 'checked_now'),
  '쿠팡(api) 항목은 "방금 확인" 이 맞다');
check(!mixed[1].trust.reasons.some(r => r.code === 'checked_now'),
  '★ ADPICK(stale-cache) 항목이 "방금 확인" 이라고 말하지 않는다');
check(mixed[1].trust.reasons.some(r => r.code === 'stale_source'),
  '★ ADPICK 항목은 오래된 저장값이라고 정확히 밝힌다');

// 반대 방향 — 쿠팡이 막혔는데 ADPICK 은 방금 받아온 경우
reset();
const mixed2 = [
  { productId: 'C2', mall: '쿠팡', link: 'https://www.coupang.com/vp/products/2?vendorItemId=7', _source: 'stale-cache' },
  { productId: adpickProductId(link(801)), mall: ADPICK_MALL, link: link(801), _source: 'api' }
];
await attachTrust(mixed2, { source: 'stale-cache' });
check(mixed2[1].trust.reasons.some(r => r.code === 'checked_now'),
  '★ 쿠팡이 막혀도 방금 받아온 ADPICK 가격을 STALE 로 깎지 않는다');
check(mixed2[0].trust.reasons.some(r => r.code === 'stale_source'),
  '쿠팡 항목은 STALE 로 남는다');

// _source 가 없는 항목(DB 에서 읽는 경로)은 기존 동작 유지
reset();
const fromDb = [{ productId: 'C3', mall: '쿠팡', link: 'https://www.coupang.com/vp/products/3?vendorItemId=7' }];
await attachTrust(fromDb, { source: 'api' });
check(fromDb[0].trust.reasons.some(r => r.code === 'checked_now'),
  '_source 가 없으면 opts.source 를 그대로 쓴다 (init.js·rec.js 기존 동작 불변)');

/* ================================================================== *
 *  H — 오래된 출처는 저장하지 않는다
 * ================================================================== */
section('H — stale-cache 는 오늘 가격으로 저장하지 않는다');

const { saveProducts } = require('../api/_shop');
reset();
await saveProducts('여행용 캐리어', [
  { ...ad(900, 9900), lprice: 9900, _source: 'stale-cache' }
], { from: 'stale-cache' });
check(db.price_history.length === 0 && db.products.length === 0,
  '★ 최대 48시간 전 캐시를 "오늘 관측" 으로 기록하지 않는다');

reset();
await saveProducts('여행용 캐리어', [
  { ...ad(901, 9900), lprice: 9900, _source: 'api' },
  { ...ad(902, 8800), lprice: 8800, _source: 'stale-cache' }
], { from: 'api' });
check(db.price_history.length === 1,
  '★ 같은 배치에서 신선한 항목만 저장한다 (배치 하나로 뭉뚱그리지 않는다)',
  String(db.price_history.length));
check(db.price_history[0].product_id === adpickProductId(link(901)),
  '저장된 것이 신선한 쪽이 맞다');

/* ================================================================== *
 *  I — 보안: API 키가 로그·오류 문자열에 새지 않는가
 * ================================================================== */
section('I — ADPICK API 키 노출 방지');

const SAVED_KEY = process.env.ADPICK_API_KEY;
process.env.ADPICK_API_KEY = 'TESTKEY_ABCDEF123456';
check(redact('nginx: /api/TESTKEY_ABCDEF123456/search not found') === 'nginx: /api/***/search not found',
  '★ 업스트림이 요청 경로를 되비춰도 키가 지워진다');
check(redact('Invalid API key: TESTKEY_ABCDEF123456 (x2) TESTKEY_ABCDEF123456')
      === 'Invalid API key: *** (x2) ***',
  '여러 번 나와도 전부 지운다');
check(redact('정상 오류 메시지') === '정상 오류 메시지',
  '키가 없는 문자열은 그대로 둔다 (진단 정보를 버리지 않는다)');
process.env.ADPICK_API_KEY = '';
check(redact('anything') === 'anything', '키가 설정되지 않았으면 아무것도 하지 않는다');
if (SAVED_KEY === undefined) delete process.env.ADPICK_API_KEY;
else process.env.ADPICK_API_KEY = SAVED_KEY;

// 프론트 번들에 ADPICK 키/호스트 직접 호출이 없어야 한다
const fs = require('fs');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
check(!/ADPICK_API_KEY/.test(html), '★ 프론트 번들에 ADPICK_API_KEY 문자열이 없다');
check(!/biz\.adpick\.co\.kr\/api\//.test(html),
  '★ 프론트가 ADPICK API 를 직접 호출하지 않는다 (키는 서버에만 있다)');

// 서버 코드에서도 URL 을 통째로 로그에 찍지 않는다
const adpickSrc = fs.readFileSync(path.join(__dirname, '..', 'api', '_adpick.js'), 'utf8');
check(!/console\.(log|warn|error)\([^)]*\$\{url\}/.test(adpickSrc),
  '★ 키가 들어간 url 변수를 로그에 직접 찍지 않는다');

/* ================================================================== *
 *  요약
 * ================================================================== */
console.log(`\n==================================================================`);
console.log('ADPICK 무결성 테스트 요약');
console.log('==================================================================');
console.log(`결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);

})().catch(e => {
  console.error('\n테스트 실행 중 예외:', e);
  process.exit(1);
});
