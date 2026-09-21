#!/usr/bin/env node
'use strict';
/*
 * 홈 핫딜 «오늘 가격 하락» — 정의 + 계약 회귀 시험. 완전 오프라인.
 *
 * ── 여기서 고정하는 것 ─────────────────────────────────────────────
 *
 *   ① 노출의 «기본» 은 오늘 실제로 내려간 상품이다.
 *      검증되지 않았다고 목록에서 빼지 않는다 — 배지로만 구분한다.
 *      (2026-09-21 이전에는 검증 통과분 2개만 홈에 떴다. 같은 날 실제
 *       하락은 24개였다.)
 *   ② 비교는 (product_id, mall, 옵션) 이 모두 같은 관측끼리만 한다.
 *   ③ 관문은 «5% 또는 1,000원» 이다 — AND 가 아니라 OR.
 *   ④ 같은 상품은 옵션이 여럿이어도 카드 한 장이다.
 *   ⑤ 정렬은 검증 우선이되, 검증되지 않은 하락도 그 뒤에 계속 나온다.
 *   ⑥ 기존 /api/hotdeals 목록·상세·외부 레이더는 한 줄도 달라지지 않는다.
 *
 * ── 안전성 ─────────────────────────────────────────────────────────
 * 운영 Supabase 0회. 외부 호출 0회. 가짜 Supabase 가 표를 흉내 낸다.
 */

const path = require('path');
const Module = require('module');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

/* ══════════════════════════════════════════════════════════════════
 *  가짜 Supabase — price_history / hotdeals / products / external_hotdeals
 * ════════════════════════════════════════════════════════════════ */
const db = { price_history: [], hotdeals: [], products: [], external_hotdeals: [] };

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a == null && b == null) return 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const fakeSupabase = {
  from(table) {
    const filters = [];
    const orders = [];
    let cols = '*', single = false, rangeFrom = null, rangeTo = null, limitN = null;
    const q = {
      select(c) { cols = c || '*'; return q; },
      eq(c, v) { filters.push(r => String(r[c]) === String(v)); return q; },
      neq(c, v) { filters.push(r => String(r[c]) !== String(v)); return q; },
      in(c, vs) { filters.push(r => vs.map(String).indexOf(String(r[c])) > -1); return q; },
      gte(c, v) { filters.push(r => cmp(r[c], v) >= 0); return q; },
      lt(c, v) { filters.push(r => cmp(r[c], v) < 0); return q; },
      /* PostgREST 의 .or('a.is.null,a.gt.X') — 콤마로 나뉜 조건의 OR. */
      or(expr) {
        const terms = String(expr || '').split(',').map(s => s.trim()).filter(Boolean)
          .map(t => {
            const i = t.indexOf('.'), j = t.indexOf('.', i + 1);
            const col = t.slice(0, i), op = t.slice(i + 1, j), val = t.slice(j + 1);
            if (op === 'is') return r => (val === 'null' ? r[col] == null : String(r[col]) === val);
            if (op === 'gt') return r => r[col] != null && cmp(r[col], val) > 0;
            throw new Error(`테스트 스텁이 모르는 or 연산자: ${op}`);
          });
        filters.push(r => terms.some(f => f(r)));
        return q;
      },
      order(c, o) { orders.push({ c, asc: !o || o.ascending !== false }); return q; },
      limit(n) { limitN = n; return q; },
      range(a, b) { rangeFrom = a; rangeTo = b; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve) {
        let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
        if (orders.length) {
          rows = rows.slice().sort((a, b) => {
            for (const o of orders) {
              const d = (o.asc ? 1 : -1) * cmp(a[o.c], b[o.c]);
              if (d) return d;
            }
            return 0;
          });
        }
        if (rangeFrom != null) rows = rows.slice(rangeFrom, rangeTo + 1);
        if (limitN != null) rows = rows.slice(0, limitN);
        /* select 한 컬럼만 돌려준다 — 응답에 없는 값을 코드가 읽는 일을 잡는다. */
        const want = cols === '*' ? null : String(cols).split(',').map(s => s.trim()).filter(Boolean);
        rows = rows.map(r => {
          if (!want) return Object.assign({}, r);
          const out = {};
          want.forEach(c => { if (Object.prototype.hasOwnProperty.call(r, c)) out[c] = r[c]; });
          return out;
        });
        return resolve({ data: single ? (rows[0] || null) : rows, error: null });
      }
    };
    return q;
  }
};

const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request) {
  if (request === './_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};
global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

const TD = require('../api/_todaydrop');
const handler = require('../api/hotdeals.js');

/* ══════════════════════════════════════════════════════════════════
 *  도구
 * ════════════════════════════════════════════════════════════════ */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  — ${detail}` : ''}`); }
}
function eq(a, b, name) { ok(a === b, name, a === b ? String(a) : `기대 ${b} / 실제 ${a}`); }
function section(t) { console.log(`\n[${t}]`); }

/*
 * 날짜를 «오늘 기준» 으로 굴린다.
 *
 * 고정 날짜를 박으면 시험이 시한폭탄이 된다 — KST 창이 매일 움직이므로
 * 어느 날 갑자기 «오늘» 이 아니게 된다. 그래서 실행 시점의 KST 오늘에서
 * 거꾸로 센다. 라우트 시험은 kstToday() 를 그대로 쓰므로 이렇게 해야
 * 원장 데이터와 코드가 같은 «오늘» 을 본다.
 */
const { kstToday } = require('../api/_price');
const TODAY = kstToday();
const dayOffset = n => new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const YESTERDAY = dayOffset(-1);
const TWO_DAYS_AGO = dayOffset(-2);

/** KST 달력일 + KST 시각 → 저장되는 절대 시각(ISO, UTC). */
function at(day, hhmm) {
  const [h, m] = String(hhmm || '12:00').split(':').map(Number);
  return new Date(Date.parse(day + 'T00:00:00Z') + ((h - 9) * 60 + m) * 60000).toISOString();
}

/**
 * price_history 한 행.
 *
 * ★ recorded_date 는 «일부러» UTC 로 잘라 넣는다. 운영 DB 가 그렇게 덮어쓰기
 *   때문이다 (api/_price.js kstToday 주석). 코드가 라벨이 아니라 recorded_at
 *   으로 KST 를 다시 뽑는지 여기서 확인된다.
 */
function ph(day, hhmm, price, over) {
  const recordedAt = at(day, hhmm);
  return Object.assign({
    id: db.price_history.length + 1,
    product_id: 'p1', mall: '쿠팡', title: '상품 p1',
    link: 'https://link.coupang.com/a/1',
    price,
    recorded_at: recordedAt,
    recorded_date: recordedAt.slice(0, 10),   // UTC 라벨 — 믿으면 안 되는 값
    vendor_item_id: 'v1', item_id: ''
  }, over || {});
}

function product(over) {
  return Object.assign({
    product_id: 'p1', mall: '쿠팡', title: '상품 p1',
    image: 'https://img/p1.jpg', link: 'https://link.coupang.com/a/1',
    mall_label: '', collected_at: at(TODAY, '02:00')
  }, over || {});
}

let nextDealId = 1;
function deal(over) {
  const id = nextDealId++;
  return Object.assign({
    id,
    source: 'internal-history', source_external_id: 'ext' + id,
    product_id: 'p1', mall: '쿠팡', vendor_item_id: 'v1',
    title: '상품 p1', image: 'https://img/deal.jpg',
    affiliate_url: 'https://link.coupang.com/deal/' + id,
    current_price: 19800, source_reference_price: 29800,
    deal_status: 'VERIFIED_HOT', hot_score: 84,
    confidence: 'HIGH', identity_confidence: 'EXACT',
    reason_json: [{ kind: 'median30', text: '근거' }], gate_json: [],
    lifecycle: 'ACTIVE',
    detected_at: at(YESTERDAY, '01:00'),
    last_checked_at: at(TODAY, '01:00'),
    expires_at: new Date(Date.now() + 24 * 3600000).toISOString(),
    group_key: 'g' + id, is_primary: true, group_size: 1,
    group_lowest_price: 19800, group_lowest_mall: '쿠팡', group_offers: [],
    signal_json: {}, price_drop_percent: 33.6, confidence_rank: 3,
    observation_count: 10, observation_span_days: 20,
    median_30d: 29000, observed_low: 19800
  }, over || {});
}

function call(query) {
  return new Promise((resolve, reject) => {
    let code = 200; const headers = {};
    const res = {
      status(c) { code = c; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      json(body) { resolve({ status: code, headers, body }); return this; },
      end() { resolve({ status: code, headers, body: null }); return this; }
    };
    Promise.resolve(handler(
      { method: 'GET', headers: {}, query: query || {}, socket: { remoteAddress: '10.0.0.9' } }, res
    )).catch(reject);
  });
}

/** 한 계열의 관측만 넘겨 판정을 본다 (순수 계산). */
const drop = (points, over) => TD.todayDrop(points, Object.assign({ today: TODAY }, over || {}));

console.log('=== 홈 핫딜: 오늘 가격 하락 (외부 호출 0회) ===');

/* 라우트 시험이 await 를 쓰므로 전체를 async 로 감싼다 (CommonJS 는 최상위 await 를 쓸 수 없다). */
(async () => {

/* ══════════════════════════════════════════════════════════════════
 *  1. 노출 기준 — 지시서의 케이스 1~4, 7
 * ════════════════════════════════════════════════════════════════ */
section('1) 노출 기준 — 5% 또는 1,000원');
{
  const r = drop([ph(YESTERDAY, '20:00', 29800), ph(TODAY, '09:00', 19800)]);
  eq(r.ok, true, '케이스1: 29,800 → 19,800 노출');
  eq(r.pct, 33.6, '케이스1: 하락률 33.6%');
  eq(r.amount, 10000, '케이스1: 하락액 10,000원');
  eq(r.previousPrice, 29800, '케이스1: 직전 가격을 그대로 싣는다');
  eq(r.todayPrice, 19800, '케이스1: 오늘 가격을 그대로 싣는다');
}
{
  const r = drop([ph(YESTERDAY, '20:00', 174000), ph(TODAY, '09:00', 158000)]);
  eq(r.ok, true, '케이스2: 174,000 → 158,000 노출');
  eq(r.pct, 9.2, '케이스2: 하락률 9.2%');
}
{
  const r = drop([ph(YESTERDAY, '20:00', 20000), ph(TODAY, '09:00', 19500)]);
  eq(r.ok, false, '케이스3: 20,000 → 19,500 (2.5% / 500원) 제외');
  eq(r.reason, TD.REASON.BELOW_THRESHOLD, '케이스3: 이유는 임계값 미달');
  eq(r.lowered, true, '케이스3: 내려간 것은 사실이다 (집계에는 남는다)');
}
{
  const r = drop([ph(YESTERDAY, '20:00', 100000), ph(TODAY, '09:00', 99000)]);
  eq(r.ok, true, '케이스4: 100,000 → 99,000 (1% 지만 1,000원) 노출');
  eq(r.pct, 1, '케이스4: 하락률은 1% 그대로 싣는다');
  eq(r.amount, 1000, '케이스4: 하락액 1,000원이 관문을 연다');
}
{
  const r = drop([ph(YESTERDAY, '20:00', 10000), ph(TODAY, '09:00', 12000)]);
  eq(r.ok, false, '케이스7: 가격이 올랐으면 제외');
  eq(r.reason, TD.REASON.NOT_LOWER, '케이스7: 이유는 NOT_LOWER');
  eq(drop([ph(YESTERDAY, '20:00', 10000), ph(TODAY, '09:00', 10000)]).reason,
    TD.REASON.NOT_LOWER, '같은 값도 하락이 아니다');
}
{
  eq(TD.meetsThreshold(5, 0), true, '5% 면 금액과 무관하게 통과');
  eq(TD.meetsThreshold(0.1, 1000), true, '1,000원이면 퍼센트와 무관하게 통과');
  eq(TD.meetsThreshold(4.9, 999), false, '둘 다 못 넘으면 탈락');
  eq(TD.MIN_DROP_PCT, 5, '기본 하락률 기준 5%');
  eq(TD.MIN_DROP_AMOUNT, 1000, '기본 하락액 기준 1,000원');
}

/* ══════════════════════════════════════════════════════════════════
 *  2. 관측이 없을 때 — 케이스 6
 * ════════════════════════════════════════════════════════════════ */
section('2) 관측이 없으면 판정하지 않는다');
{
  eq(drop([ph(YESTERDAY, '20:00', 29800)]).reason, TD.REASON.NO_TODAY,
    '케이스6: 오늘 관측이 없으면 목록에서 빠진다');
  eq(drop([ph(TODAY, '09:00', 19800)]).reason, TD.REASON.NO_PREVIOUS,
    '오늘만 있고 직전 관측이 없으면 비교 불가');
  eq(drop([]).reason, TD.REASON.NO_POINTS, '이력이 없으면 후보가 아니다');
  eq(drop(null).reason, TD.REASON.NO_POINTS, 'null 안전');
}
{
  /*
   * 비교 대상은 «어제» 가 아니라 «오늘 이전의 가장 최근 관측» 이다.
   * 수집기가 카탈로그를 나눠 돌아 어제가 비는 계열이 흔하기 때문이다
   * (api/_dailydrop.js 는 어제로 못 박는다 — 그쪽 규칙은 그대로 둔다).
   */
  const r = drop([ph(TWO_DAYS_AGO, '10:00', 29800), ph(TODAY, '09:00', 19800)]);
  eq(r.ok, true, '어제가 비어도 그제 관측과 비교해 노출한다');
  eq(r.previousPrice, 29800, '그제 값이 직전 관측이 된다');
}
{
  const r = drop([
    ph(TWO_DAYS_AGO, '10:00', 40000), ph(YESTERDAY, '20:00', 29800),
    ph(TODAY, '09:00', 19800)
  ]);
  eq(r.previousPrice, 29800, '직전 관측은 «가장 최근» 한 점이다 (그제가 아니다)');
}
{
  const r = drop([
    ph(YESTERDAY, '20:00', 29800),
    ph(TODAY, '01:00', 25000), ph(TODAY, '14:00', 19800)
  ]);
  eq(r.todayPrice, 19800, '같은 날 여러 관측이면 마지막 관측이 오늘 값');
}
{
  eq(drop([ph(YESTERDAY, '20:00', 29800), ph(TODAY, '09:00', 0)]).reason,
    TD.REASON.NO_TODAY, '0원은 관측으로 치지 않는다');
  eq(drop([ph(YESTERDAY, '20:00', -100), ph(TODAY, '09:00', 19800)]).reason,
    TD.REASON.NO_PREVIOUS, '음수도 관측으로 치지 않는다');
}

section('2-1) KST 날짜는 recorded_at 으로 다시 뽑는다');
{
  /*
   * KST 01:00 수집분은 UTC 로 «어제» 다. recorded_date 라벨을 믿으면
   * 오늘치가 통째로 사라진다 — 실제로 났던 사고다.
   */
  const row = ph(TODAY, '01:00', 19800);
  ok(row.recorded_date !== TODAY, 'KST 01시 수집분의 UTC 라벨은 오늘이 아니다', row.recorded_date);
  const r = drop([ph(YESTERDAY, '20:00', 29800), row]);
  eq(r.ok, true, '라벨이 어제여도 recorded_at 으로 보면 오늘 관측이다');
  eq(r.todayPrice, 19800, '그 값이 오늘 가격으로 잡힌다');
}

section('2-2) 설명할 수 없는 폭락은 인하가 아니라 매칭 오류다');
{
  const r = drop([ph(YESTERDAY, '20:00', 100000), ph(TODAY, '09:00', 10000)]);
  eq(r.reason, TD.REASON.IMPLAUSIBLE, '90% 하락은 제외 (저장 단계와 같은 잣대)');
  eq(r.ok, false, '그래서 노출하지 않는다');
  eq(r.lowered, false, '«실제 하락» 집계에도 넣지 않는다');
  eq(TD.MAX_PLAUSIBLE_DROP_PCT, 80, '기준은 _price.MAX_PLAUSIBLE_DROP_PCT 와 같은 80%');
}

/* ══════════════════════════════════════════════════════════════════
 *  3. 옵션 — 케이스 5, 10
 * ════════════════════════════════════════════════════════════════ */
section('3) 옵션이 다르면 비교하지 않는다');
{
  eq(TD.seriesKeyOf({ product_id: 'p1', mall: '쿠팡', vendor_item_id: 'vA' }),
    'p1|쿠팡|vA', '계열 키는 product_id + mall + 옵션');
  ok(TD.seriesKeyOf({ product_id: 'p1', mall: '쿠팡', vendor_item_id: 'vA' })
    !== TD.seriesKeyOf({ product_id: 'p1', mall: '쿠팡', vendor_item_id: 'vB' }),
    '옵션이 다르면 다른 계열');
  ok(TD.seriesKeyOf({ product_id: 'p1', mall: '쿠팡', vendor_item_id: '' })
    !== TD.seriesKeyOf({ product_id: 'p1', mall: 'ADPICK', vendor_item_id: '' }),
    '몰이 다르면 다른 계열');
  eq(TD.optionIdOf({ vendor_item_id: '', item_id: '', link: 'https://x?itemId=77&vendorItemId=99' }),
    '99', '컬럼이 비면 link 의 vendorItemId 를 쓴다 (_price.vendorIdOf 규칙)');
  eq(TD.optionIdOf({ vendor_item_id: '', item_id: '88', link: '' }),
    'i:88', 'vendorItemId 가 없으면 item_id 로 폴백한다');
  ok(TD.optionIdOf({ vendor_item_id: '', item_id: '88', link: '' })
    !== TD.optionIdOf({ vendor_item_id: '88', item_id: '', link: '' }),
    'itemId 88 과 vendorItemId 88 은 다른 옵션이다');
  eq(TD.optionIdOf({ vendor_item_id: '__LEGACY__', item_id: '', link: '' }),
    '', "'__LEGACY__' 는 옵션 값이 아니라 «모른다» 는 표시다");
}
{
  /* 케이스5 — 오늘은 A 옵션, 직전은 B 옵션. 섞으면 –70% 짜리 가짜 딜이 된다. */
  const rows = [
    ph(YESTERDAY, '20:00', 30000, { vendor_item_id: 'vB' }),
    ph(TODAY, '09:00', 9000, { vendor_item_id: 'vA' })
  ];
  const built = TD.buildDrops(rows, { today: TODAY });
  eq(built.items.length, 0, '케이스5: 다른 옵션끼리는 하락으로 판정하지 않는다');
  eq(built.stats.series, 2, '두 계열로 나뉘어 각자 «비교 대상 없음» 이 된다');
  eq(built.stats.lowered, 0, '실제 하락 집계에도 잡히지 않는다');
}
{
  /* 케이스10 — 같은 상품·같은 몰, 옵션 둘. 카드는 한 장이다. */
  const rows = [
    ph(YESTERDAY, '20:00', 20000, { vendor_item_id: 'v8a' }),
    ph(TODAY, '09:00', 18000, { vendor_item_id: 'v8a' }),        // -10%  / -2,000
    ph(YESTERDAY, '20:00', 10000, { vendor_item_id: 'v8b' }),
    ph(TODAY, '09:00', 9000, { vendor_item_id: 'v8b' })          // -10%  / -1,000
  ];
  const built = TD.buildDrops(rows, { today: TODAY });
  eq(built.items.length, 1, '케이스10: 같은 상품은 옵션이 여럿이어도 카드 한 장');
  eq(built.stats.passed, 2, '두 옵션 모두 관문은 통과했다 (고르기만 한 것이다)');
  eq(built.items[0].vendorItemId, 'v8a', '동률이면 하락액이 큰 옵션을 대표로 세운다');
  eq(built.items[0].dropAmount, 2000, '대표의 값이 카드에 실린다');
}
{
  const rows = [
    ph(YESTERDAY, '20:00', 20000, { vendor_item_id: 'vLow' }),
    ph(TODAY, '09:00', 19000, { vendor_item_id: 'vLow' }),       // -5%
    ph(YESTERDAY, '20:00', 20000, { vendor_item_id: 'vHigh' }),
    ph(TODAY, '09:00', 16000, { vendor_item_id: 'vHigh' })       // -20%
  ];
  const built = TD.buildDrops(rows, { today: TODAY });
  eq(built.items[0].vendorItemId, 'vHigh', '대표는 하락률이 가장 큰 옵션');
}

/* ══════════════════════════════════════════════════════════════════
 *  4. 검증 병합 — 케이스 8, 9
 * ════════════════════════════════════════════════════════════════ */
section('4) 검증은 배지로만 구분한다 — 목록에서 빼지 않는다');
{
  const cards = TD.buildDrops([
    ph(YESTERDAY, '20:00', 29800), ph(TODAY, '09:00', 19800)
  ], { today: TODAY }).items;

  const merged = TD.applyVerified(cards, [
    { id: 7, product_id: 'p1', mall: '쿠팡', vendor_item_id: 'v1',
      deal_status: 'VERIFIED_HOT', hot_score: 84, lifecycle: 'ACTIVE',
      expires_at: null, is_primary: true, affiliate_url: 'https://deal/7', image: '' }
  ], { now: Date.now() });

  eq(merged[0].verified, true, '케이스8: VERIFIED_HOT 매칭 → verified=true');
  eq(merged[0].badge, 'SEOSA 검증', '케이스8: 배지는 «SEOSA 검증»');
  eq(merged[0].dealStatus, 'VERIFIED_HOT', '케이스8: 원래 판정을 잃지 않는다');
  eq(merged[0].hotScore, 84, '케이스8: hot_score 도 그대로 전달된다');
  eq(merged[0].dealId, 7, '케이스8: 어느 딜과 매칭됐는지 남긴다');
}
{
  const cards = TD.buildDrops([
    ph(YESTERDAY, '20:00', 29800), ph(TODAY, '09:00', 19800)
  ], { today: TODAY }).items;
  const merged = TD.applyVerified(cards, [], { now: Date.now() });
  eq(merged.length, 1, '케이스9: 매칭이 없어도 목록에 남는다 ★ 이 변경의 핵심');
  eq(merged[0].verified, false, '케이스9: verified=false');
  eq(merged[0].badge, '오늘 가격 하락', '케이스9: 배지는 «오늘 가격 하락»');
  eq(merged[0].dealStatus, null, '케이스9: 없는 판정을 지어내지 않는다 (0 이 아니라 null)');
  eq(merged[0].hotScore, null, '케이스9: 점수도 null');
}
{
  const now = Date.now();
  const base = { product_id: 'p1', mall: '쿠팡', vendor_item_id: 'v1',
    deal_status: 'VERIFIED_HOT', lifecycle: 'ACTIVE', expires_at: null,
    is_primary: true, hot_score: 80, id: 1 };
  eq(TD.isVerifiedDeal(base, now), true, 'VERIFIED_HOT · ACTIVE · is_primary → 검증');
  eq(TD.isVerifiedDeal(Object.assign({}, base, { deal_status: 'GOOD_DEAL' }), now), true,
    'GOOD_DEAL 도 검증이다');
  eq(TD.isVerifiedDeal(Object.assign({}, base, { deal_status: 'POTENTIAL_DEAL' }), now), false,
    'POTENTIAL_DEAL 은 배지를 주지 않는다');
  eq(TD.isVerifiedDeal(Object.assign({}, base, { lifecycle: 'COOLING' }), now), false,
    'COOLING 은 배지를 주지 않는다');
  eq(TD.isVerifiedDeal(Object.assign({}, base, { lifecycle: 'EXPIRED' }), now), false,
    'EXPIRED 는 배지를 주지 않는다');
  eq(TD.isVerifiedDeal(Object.assign({}, base, { is_primary: false }), now), false,
    'is_primary 가 아니면 배지를 주지 않는다');
  eq(TD.isVerifiedDeal(Object.assign({}, base,
    { expires_at: new Date(now - 1000).toISOString() }), now), false,
    '이미 만료된 딜은 배지를 주지 않는다');
  eq(TD.isVerifiedDeal(Object.assign({}, base,
    { expires_at: new Date(now + 3600000).toISOString() }), now), true,
    '아직 살아 있는 딜은 배지를 준다');
}
{
  /* 다른 옵션의 판정을 이 카드의 «검증» 이라고 말하지 않는다. */
  const cards = TD.buildDrops([
    ph(YESTERDAY, '20:00', 29800, { vendor_item_id: 'vA' }),
    ph(TODAY, '09:00', 19800, { vendor_item_id: 'vA' })
  ], { today: TODAY }).items;
  const other = [{ id: 9, product_id: 'p1', mall: '쿠팡', vendor_item_id: 'vB',
    deal_status: 'VERIFIED_HOT', hot_score: 90, lifecycle: 'ACTIVE',
    expires_at: null, is_primary: true, affiliate_url: '', image: '' }];
  eq(TD.applyVerified(cards, other, { now: Date.now() })[0].verified, false,
    '옵션이 서로 다르면 검증을 옮겨 붙이지 않는다');

  const unknown = [{ id: 10, product_id: 'p1', mall: '쿠팡', vendor_item_id: '',
    deal_status: 'GOOD_DEAL', hot_score: 70, lifecycle: 'NEW',
    expires_at: null, is_primary: true, affiliate_url: '', image: '' }];
  eq(TD.applyVerified(cards, unknown, { now: Date.now() })[0].verified, true,
    "딜 쪽이 옵션을 «모르면» 상품 단위로 붙인다 ('' 는 다른 옵션이라는 뜻이 아니다)");
}

/* ══════════════════════════════════════════════════════════════════
 *  5. 정렬
 * ════════════════════════════════════════════════════════════════ */
section('5) 정렬 — 검증 우선, 그 뒤로 실제 하락이 계속 나온다');
{
  const rows = [
    /* 검증될 상품: 하락률이 낮다 */
    ph(YESTERDAY, '20:00', 174000, { product_id: 'pV', vendor_item_id: 'vV' }),
    ph(TODAY, '09:00', 158000, { product_id: 'pV', vendor_item_id: 'vV' }),
    /* 검증 안 된 상품: 하락률이 훨씬 높다 */
    ph(YESTERDAY, '20:00', 29800, { product_id: 'pA', vendor_item_id: 'vA' }),
    ph(TODAY, '09:00', 19800, { product_id: 'pA', vendor_item_id: 'vA' }),
    ph(YESTERDAY, '20:00', 100000, { product_id: 'pB', vendor_item_id: 'vB' }),
    ph(TODAY, '09:00', 99000, { product_id: 'pB', vendor_item_id: 'vB' })
  ];
  const built = TD.buildDrops(rows, { today: TODAY });
  const merged = TD.applyVerified(built.items, [
    { id: 1, product_id: 'pV', mall: '쿠팡', vendor_item_id: 'vV',
      deal_status: 'GOOD_DEAL', hot_score: 70, lifecycle: 'ACTIVE',
      expires_at: null, is_primary: true, affiliate_url: '', image: '' }
  ], { now: Date.now() });

  eq(merged.length, 3, '세 상품 모두 목록에 있다');
  eq(merged[0].productId, 'pV', '검증된 상품이 하락률이 낮아도 맨 앞');
  eq(merged[1].productId, 'pA', '그 다음은 하락률이 큰 순서 (33.6%)');
  eq(merged[2].productId, 'pB', '하락률이 작은 것이 뒤 (1%)');
  eq(merged[1].verified, false, '뒤에 오는 것들도 목록에서 사라지지 않는다');
}
{
  /* 하락률·하락액이 같으면 신선도 → 키 순. 같은 입력에 같은 순서여야 한다. */
  const mk = (key, pct, amount, recordedAt) =>
    ({ key, dropPct: pct, dropAmount: amount, recordedAt, verified: false });
  const list = [
    mk('b', 10, 1000, at(TODAY, '09:00')),
    mk('a', 10, 1000, at(TODAY, '09:00')),
    mk('c', 10, 1000, at(TODAY, '11:00'))
  ];
  const once = list.slice().sort(TD.compareCards).map(x => x.key).join(',');
  const twice = list.slice().reverse().sort(TD.compareCards).map(x => x.key).join(',');
  eq(once, 'c,a,b', '신선한 것이 먼저, 동률이면 키 사전순');
  eq(once, twice, '입력 순서가 달라도 결과가 같다 (결정론)');
}

/* ══════════════════════════════════════════════════════════════════
 *  6. 라우트 계약 — /api/hotdeals?view=today-drop
 * ════════════════════════════════════════════════════════════════ */
section('6) GET /api/hotdeals?view=today-drop');

db.price_history = [
  /* 1) 검증될 딜 — 29,800 → 19,800 */
  ph(YESTERDAY, '20:00', 29800),
  ph(TODAY, '09:00', 19800),
  /* 2) 검증 안 된 하락 — 174,000 → 158,000 */
  ph(YESTERDAY, '20:00', 174000, { product_id: 'p2', vendor_item_id: 'v2', title: '상품 p2', link: 'https://link.coupang.com/a/2' }),
  ph(TODAY, '09:00', 158000, { product_id: 'p2', vendor_item_id: 'v2', title: '상품 p2', link: 'https://link.coupang.com/a/2' }),
  /* 3) 임계값 미달 — 20,000 → 19,500 */
  ph(YESTERDAY, '20:00', 20000, { product_id: 'p3', vendor_item_id: 'v3', title: '상품 p3' }),
  ph(TODAY, '09:00', 19500, { product_id: 'p3', vendor_item_id: 'v3', title: '상품 p3' }),
  /* 4) 1% 지만 1,000원 — 100,000 → 99,000 */
  ph(YESTERDAY, '20:00', 100000, { product_id: 'p4', vendor_item_id: 'v4', title: '상품 p4' }),
  ph(TODAY, '09:00', 99000, { product_id: 'p4', vendor_item_id: 'v4', title: '상품 p4' }),
  /* 5) 옵션이 다르다 */
  ph(YESTERDAY, '20:00', 30000, { product_id: 'p5', vendor_item_id: 'v5b', title: '상품 p5' }),
  ph(TODAY, '09:00', 9000, { product_id: 'p5', vendor_item_id: 'v5a', title: '상품 p5' }),
  /* 6) 오늘 관측이 없다 */
  ph(YESTERDAY, '20:00', 50000, { product_id: 'p6', vendor_item_id: 'v6', title: '상품 p6' }),
  /* 7) 올랐다 */
  ph(YESTERDAY, '20:00', 10000, { product_id: 'p7', vendor_item_id: 'v7', title: '상품 p7' }),
  ph(TODAY, '09:00', 12000, { product_id: 'p7', vendor_item_id: 'v7', title: '상품 p7' })
];
db.products = [
  product(),
  product({ product_id: 'p2', title: '상품 p2', image: 'https://img/p2.jpg', link: 'https://link.coupang.com/a/2' }),
  product({ product_id: 'p4', title: '상품 p4', image: '', link: '' })
];
db.hotdeals = [deal()];

{
  const r = await call({ view: 'today-drop', limit: 60 });
  const items = r.body.items;
  eq(r.status, 200, '200 으로 답한다');
  eq(r.body.view, 'today-drop', 'view 를 밝힌다');
  eq(items.length, 3, '노출 후보는 3개 (p1 · p2 · p4)');
  eq(items.map(i => i.productId).join(','), 'p1,p2,p4', '검증 우선 → 하락률 순');
  eq(r.body.counts.VERIFIED, 1, 'counts 로 검증분을 셀 수 있다');
  eq(r.body.counts.TODAY_DROP, 2, 'counts 로 미검증분을 셀 수 있다');
  eq(r.body.total, 3, '전체 후보 수를 밝힌다');
  // p1 · p2 · p4 는 노출되고, p3 은 임계값 미달로 빠진다 — 넷 다 «내려간» 것은 맞다.
  eq(r.body.stats.lowered, 4, 'stats: 실제로 내려간 계열 수 (임계값 미달 p3 포함)');
  eq(r.body.stats.passed, 3, 'stats: 그중 관문을 통과한 수');
  // p1·p2·p3·p4·p5(오늘 옵션)·p7 = 6. p6 은 오늘 관측이 없어 애초에 세지 않는다.
  eq(r.body.stats.todaySeries, 6, 'stats: 오늘 관측된 계열 수');
  eq(r.body.stats.cards, 3, 'stats: 카드 수');
  eq(r.body.nextCursor, null, '커서는 쓰지 않는다 (한 번에 다 준다)');

  const a = items[0];
  section('6-1) 카드 한 장이 들고 있어야 하는 값');
  eq(a.productId, 'p1', 'productId');
  eq(a.vendorItemId, 'v1', 'vendorItemId (가격 그래프가 옵션을 좁히는 키)');
  eq(a.title, '상품 p1', 'title');
  eq(a.image, 'https://img/p1.jpg', 'image — products 카탈로그에서 온다');
  eq(a.mall, '쿠팡', 'mall (저장 키)');
  eq(a.mallLabel, '', 'mallLabel (표시 이름 — 없으면 빈 문자열)');
  eq(a.currentPrice, 19800, 'currentPrice');
  eq(a.previousPrice, 29800, 'previousPrice');
  eq(a.dropAmount, 10000, 'dropAmount');
  eq(a.dropPct, 33.6, 'dropPct');
  eq(a.verified, true, 'verified');
  eq(a.badge, 'SEOSA 검증', 'badge');
  eq(a.dealStatus, 'VERIFIED_HOT', 'dealStatus');
  eq(a.hotScore, 84, 'hotScore');
  eq(a.link, 'https://link.coupang.com/deal/1', 'link — 제휴 링크가 최우선');
  ok(!!a.recordedAt, 'recordedAt', a.recordedAt);
  ok(!!a.previousAt, 'previousAt (무엇과 비교했는지)', a.previousAt);

  const b = items[1];
  eq(b.verified, false, '검증되지 않은 카드도 그대로 나간다');
  eq(b.badge, '오늘 가격 하락', '그 카드의 배지');
  eq(b.link, 'https://link.coupang.com/a/2', '제휴 링크가 없으면 카탈로그 링크');

  const c = items[2];
  eq(c.link, 'https://link.coupang.com/a/1', '카탈로그 링크도 없으면 원장의 링크');
  eq(c.image, '', '이미지를 모르면 빈 문자열 — 지어내지 않는다 (화면이 폴백한다)');
}

section('6-2) 노출 수 — 홈은 5개로 시작해 10개씩 펼친다');
{
  const r = await call({ view: 'today-drop', limit: 2 });
  eq(r.body.items.length, 2, 'limit 을 지킨다');
  eq(r.body.total, 3, '그래도 전체 후보 수는 알려 준다');
}
{
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok(html.includes('INITIAL: 5') && html.includes('STEP: 10'),
    '케이스11: 기본 5개 · 더보기 10개씩 (기존 패턴 재사용)');
  ok(html.includes("queryUrl = url + '?view=today-drop&limit=60'"),
    '한 번에 60개를 받아 두고 서버를 다시 치지 않는다');
  ok(html.includes('Drop.fromTodayDrop'), '새 응답을 기존 카드 모양으로 옮긴다');
  ok(html.includes('Drop.items.slice(0, take)'), 'visible 개수까지만 렌더한다');
  ok(html.includes('class="dbadge'), '카드에 배지 자리가 있다');
}

/* ══════════════════════════════════════════════════════════════════
 *  7. 회귀 — 기존 소비자는 달라지지 않는다 (케이스 12)
 * ════════════════════════════════════════════════════════════════ */
section('7) 케이스12: 기존 /api/hotdeals 목록·상세·외부 레이더 회귀 없음');
{
  const r = await call({});
  eq(r.status, 200, '기본 목록은 그대로 200');
  eq(r.body.items.length, 1, '엔진의 검증 통과분만 담는 예전 계약 그대로');
  eq(r.body.items[0].id, 1, '항목은 hotdeals 행 그 자체다');
  eq(r.body.items[0].status, 'VERIFIED_HOT', '판정 이름도 그대로');
  ok(r.body.grouped === true, '군집 응답 표시도 그대로');
  ok(!('view' in r.body), '기본 목록에는 view 가 붙지 않는다');
}
{
  const r = await call({ id: '1' });
  eq(r.status, 200, '상세는 그대로 200');
  eq(r.body.deal.id, 1, '상세가 그 딜을 돌려준다');
  eq(r.body.deal.vendorItemId, 'v1', '상세의 옵션 식별자도 그대로');
  ok(Array.isArray(r.body.deal.reasons), '판정 근거 배열도 그대로');
}
{
  const r = await call({ view: 'external' });
  eq(r.status, 200, '외부 레이더 view 는 그대로 200');
  eq(r.body.external, true, '외부 view 표시도 그대로');
  ok(Array.isArray(r.body.items), '외부 목록 모양도 그대로');
}
{
  const r = await call({ view: 'today-drop', id: '1' });
  eq(r.body.deal ? 'detail' : 'list', 'detail',
    '?id= 가 있으면 상세가 먼저다 — view 가 상세를 가로채지 않는다');
}

/* ══════════════════════════════════════════════════════════════════ */
console.log(`\n${'='.repeat(58)}`);
console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  console.log('\n실패한 항목:');
  failures.forEach(f => console.log(`  · ${f}`));
  process.exit(1);
}
console.log('오늘 가격 하락 계약 이상 없음.');
})().catch(e => { console.error(e); process.exit(1); });
