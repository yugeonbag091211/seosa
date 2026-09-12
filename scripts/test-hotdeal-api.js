#!/usr/bin/env node
'use strict';
/*
 * /api/hotdeals — 계약(schema) 회귀 시험. 완전 오프라인.
 *
 * ── 무엇을 지키는가 ────────────────────────────────────────────────
 *
 *   ① 프론트가 이미 쓰는 필드는 이름도 뜻도 바뀌지 않는다
 *      (Codex 가 UI 를 고치는 동안 백엔드가 계약을 깨면 안 된다)
 *   ② REJECTED·NORMAL·EXPIRED 는 절대 새어 나가지 않는다
 *   ③ 같은 상품은 한 카드다 (is_primary + 방어적 중복 제거)
 *   ④ 정렬이 결정론이고 tie-breaker 가 근거가 두꺼운 쪽을 위로 올린다
 *   ⑤ 마이그레이션 전(새 컬럼 없음)에도 목록이 죽지 않는다
 *   ⑥ 근거가 약하면 점수를 숫자로 내보내지 않는다
 *   ⑦ affiliate URL 이 보존된다
 *
 * ── 안전성 ─────────────────────────────────────────────────────────
 * 운영 Supabase 0회. 가짜 Supabase 가 hotdeals 표를 흉내 낸다.
 */

const path = require('path');
const Module = require('module');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

/* ── 가짜 Supabase ─────────────────────────────────────────────── */
const db = { hotdeals: [], external_hotdeals: [] };
/** 이 이름들이 «아직 없는» 컬럼이라고 가정한다 (마이그레이션 전 재현). */
let missingColumns = [];

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
    let missing = '';
    const touch = c => { if (missingColumns.indexOf(c) > -1 && !missing) missing = c; };
    const q = {
      select(c) { cols = c || '*'; String(cols).split(',').forEach(x => touch(x.trim())); return q; },
      eq(c, v) { touch(c); filters.push(r => String(r[c]) === String(v)); return q; },
      in(c, vs) { touch(c); filters.push(r => vs.map(String).indexOf(String(r[c])) > -1); return q; },
      gte(c, v) { touch(c); filters.push(r => Number(r[c]) >= Number(v)); return q; },
      order(c, o) { touch(c); orders.push({ c, asc: !o || o.ascending !== false }); return q; },
      limit(n) { limitN = n; return q; },
      range(a, b) { rangeFrom = a; rangeTo = b; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve) {
        if (missing) {
          return resolve({ data: null, error: { message: `column hotdeals.${missing} does not exist` } });
        }
        let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
        /*
         * ★ 정렬은 «합성» 이다. PostgREST 의 .order().order() 는
         *   ORDER BY a, b 하나로 나가지 두 번 정렬하는 것이 아니다.
         *   따로 정렬하면 마지막 것만 살아남아 tie-breaker 시험이 통째로
         *   무의미해진다 (그러면 시험이 통과해도 아무것도 보증하지 못한다).
         */
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
        /* select 한 컬럼만 돌려준다 — 실제 응답에 없는 값을 코드가 읽는 일을 잡는다. */
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
global.fetch = async (url) => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

const handler = require('../api/hotdeals.js');

/* ── 도구 ───────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  — ${detail}` : ''}`); }
}
function eq(a, b, name) { ok(a === b, name, a === b ? String(a) : `기대 ${b} / 실제 ${a}`); }
function section(t) { console.log(`\n[${t}]`); }

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
      { method: 'GET', headers: {}, query: query || {}, socket: { remoteAddress: '10.0.0.7' } }, res
    )).catch(reject);
  });
}

const iso = n => new Date(Date.now() - n * 3600000).toISOString();

let nextId = 1;
function deal(over) {
  const id = nextId++;
  return Object.assign({
    id,
    source: 'internal-history',
    source_external_id: 'ext' + id,
    mall: '쿠팡',
    product_id: 'pid' + id,
    vendor_item_id: '',
    title: '상품 ' + id,
    image: 'https://img/' + id + '.jpg',
    affiliate_url: 'https://link.coupang.com/a/' + id,
    current_price: 10000,
    source_reference_price: 15000,
    deal_status: 'VERIFIED_HOT',
    hot_score: 80,
    confidence: 'HIGH',
    identity_confidence: 'EXACT',
    observation_count: 12,
    observation_span_days: 20,
    median_30d: 12000,
    observed_low: 9800,
    reason_json: [{ kind: 'median30', text: '최근 30일 중앙값(12,000원)보다 16.7% 저렴' }],
    gate_json: [],
    lifecycle: 'ACTIVE',
    detected_at: iso(48),
    last_checked_at: iso(1),
    expires_at: iso(-24),
    group_key: 'internal-history|ext' + id + '|쿠팡',
    is_primary: true,
    group_size: 1,
    group_lowest_price: 10000,
    group_lowest_mall: '쿠팡',
    group_offers: [],
    signal_json: {
      currentPrice: 10000, referencePrice: 12000, referenceKind: 'median30',
      priceDropAmount: 2000, priceDropPercent: 16.7,
      previousPrice: 11000, nearHistoricalLow: false, observedLow: 9800,
      historyCount: 12, historyDays: 20, freshness: 'fresh', staleDays: 0,
      currentObserved: true
    },
    price_drop_percent: 16.7,
    confidence_rank: 3
  }, over || {});
}

function reset(rows, external) { db.hotdeals = rows || []; db.external_hotdeals = external || []; missingColumns = []; nextId = 1; }

(async () => {
  console.log('=== /api/hotdeals 계약 회귀 (외부 호출 0회) ===');

  /* ───────────────────────────────────────────────────────────── */
  section('1) 목록 기본 계약 — 프론트가 이미 쓰는 필드');
  reset([deal()]);
  {
    const r = await call({});
    eq(r.status, 200, '200');
    eq(r.body.items.length, 1, '항목 1개');
    const it = r.body.items[0];
    // ★ 아래 필드 이름은 public/index.html 의 Hot.cardHTML 이 그대로 읽는다.
    ['id', 'status', 'score', 'title', 'image', 'mall', 'price', 'listPrice',
      'reason', 'productId', 'url', 'checkedAt'].forEach(k => {
      ok(Object.prototype.hasOwnProperty.call(it, k), `필드 ${k} 유지`);
    });
    eq(it.score, 80, 'HIGH 는 점수를 준다');
    eq(it.url, 'https://link.coupang.com/a/1', 'affiliate URL 보존');
    eq(it.reason, '최근 30일 중앙값(12,000원)보다 16.7% 저렴', '근거 한 줄');
    eq(typeof r.body.nextCursor, 'object', '한 페이지면 nextCursor 는 null');
    eq(r.body.counts.VERIFIED_HOT, 1, '갈래별 개수');
    eq(r.body.grouped, true, '군집 응답임을 알린다');
  }

  section('2) 새 필드 — 설명 가능한 신호 (additive)');
  {
    const r = await call({});
    const s = r.body.items[0].signals;
    ok(s && typeof s === 'object', 'signals 객체');
    eq(s.priceDropPercent, 16.7, '하락률');
    eq(s.priceDropAmount, 2000, '하락 금액');
    eq(s.referenceKind, 'median30', '기준 종류');
    eq(s.previousPrice, 11000, '직전 가격');
    eq(s.historyCount, 12, '이력 개수');
    eq(s.freshness, 'fresh', '신선도');
    eq(s.nearHistoricalLow, false, '최저가 여부');
    eq(s.currentObserved, true, '현재가 관측 여부');
  }

  section('3) 없는 값을 0 으로 바꾸지 않는다');
  reset([deal({ signal_json: { historyCount: 0 } })]);
  {
    const s = (await call({})).body.items[0].signals;
    eq(s.priceDropPercent, null, '모르는 하락률은 null');
    eq(s.referencePrice, null, '모르는 기준가는 null');
    eq(s.previousPrice, null, '모르는 직전가는 null');
    eq(s.observedLow, null, '모르는 최저가는 null');
    eq(s.historyCount, 0, '이력 개수는 0 이 맞다');
  }

  section('4) 근거가 약하면 점수를 숫자로 주지 않는다');
  reset([
    deal({ confidence: 'LOW', deal_status: 'POTENTIAL_DEAL', hot_score: 60, confidence_rank: 1 }),
    deal({ confidence: 'MEDIUM', deal_status: 'GOOD_DEAL', hot_score: 55, confidence_rank: 2 })
  ]);
  {
    const items = (await call({})).body.items;
    const low = items.find(i => i.status === 'POTENTIAL_DEAL');
    const mid = items.find(i => i.status === 'GOOD_DEAL');
    eq(low.score, null, 'LOW 는 점수를 감춘다');
    eq(mid.score, 55, 'MEDIUM 은 점수를 준다');
  }

  section('5) 보이면 안 되는 것은 절대 새지 않는다');
  reset([
    deal({ deal_status: 'REJECTED' }),
    deal({ deal_status: 'NORMAL' }),
    deal({ lifecycle: 'EXPIRED' }),
    deal({ deal_status: 'GOOD_DEAL', lifecycle: 'COOLING' })
  ]);
  {
    const items = (await call({})).body.items;
    eq(items.length, 1, '노출 대상만 남는다');
    eq(items[0].status, 'GOOD_DEAL', 'COOLING 은 아직 보여 준다');
    // 상세도 같은 규칙이어야 한다 — 목록만 막고 상세가 열리면 뜻이 없다
    eq((await call({ id: '1' })).status, 404, 'REJECTED 상세는 404');
    eq((await call({ id: '2' })).status, 404, 'NORMAL 상세는 404');
    eq((await call({ id: '3' })).status, 404, 'EXPIRED 상세는 404');
  }

  section('6) 같은 상품은 한 카드');
  reset([
    deal({ group_key: 'G1', is_primary: true, group_size: 3, hot_score: 90,
      group_lowest_price: 9000, group_lowest_mall: 'ADPICK',
      group_offers: [
        { mall: 'ADPICK', price: 9000, url: 'https://ad/1', status: 'GOOD_DEAL', productId: 'x' },
        { mall: '쿠팡', price: 10000, url: 'https://link.coupang.com/a/1', status: 'VERIFIED_HOT', productId: 'pid1' }
      ] }),
    deal({ group_key: 'G1', is_primary: false, group_size: 3, hot_score: 88 }),
    deal({ group_key: 'G2', is_primary: true, hot_score: 70 })
  ]);
  {
    const items = (await call({})).body.items;
    eq(items.length, 2, '군집 하나당 카드 하나');
    const g1 = items[0];
    eq(g1.offerCount, 3, '군집 크기를 알려 준다');
    eq(g1.lowestPrice, 9000, '현재 최저가');
    eq(g1.lowestMall, 'ADPICK', '최저가 몰');
    eq(g1.isLowest, false, '내가 최저가가 아니라고 사실대로 말한다');
    eq(g1.otherOfferCount, 1, '다른 판매처 개수 (자기 자신 제외)');
  }

  section('7) is_primary 가 새어도 마지막에 막는다');
  // 수집기가 죽어 stale 한 is_primary=true 가 두 개 남은 상황
  reset([
    deal({ group_key: 'G9', is_primary: true, hot_score: 90 }),
    deal({ group_key: 'G9', is_primary: true, hot_score: 89 }),
    deal({ group_key: 'G8', is_primary: true, hot_score: 80 })
  ]);
  {
    const r = await call({});
    eq(r.body.items.length, 2, '같은 group_key 두 장은 한 장으로');
    eq(r.body.items[0].id, 1, '점수가 높은 쪽이 남는다');
  }

  section('8) 정렬 — 결정론과 tie-breaker');
  reset([
    deal({ hot_score: 70, confidence: 'LOW', confidence_rank: 1, group_key: 'a', price_drop_percent: 5 }),
    deal({ hot_score: 70, confidence: 'HIGH', confidence_rank: 3, group_key: 'b', price_drop_percent: 5 }),
    deal({ hot_score: 70, confidence: 'MEDIUM', confidence_rank: 2, group_key: 'c', price_drop_percent: 5 })
  ]);
  {
    const items = (await call({})).body.items;
    eq(items[0].id, 2, '동점이면 근거가 두꺼운 쪽이 위');
    const again = (await call({})).body.items;
    eq(again.map(i => i.id).join(','), items.map(i => i.id).join(','),
      '같은 입력이면 같은 순서 (결정론)');
  }
  reset([
    deal({ hot_score: 50, group_key: 'a', current_price: 3000 }),
    deal({ hot_score: 90, group_key: 'b', current_price: 9000 }),
    deal({ hot_score: 70, group_key: 'c', current_price: 5000, price_drop_percent: 40 })
  ]);
  {
    eq((await call({ sort: 'price' })).body.items[0].current_price, undefined, 'price 필드는 노출 이름이 price');
    eq((await call({ sort: 'price' })).body.items[0].price, 3000, 'sort=price 는 싼 것부터');
    eq((await call({ sort: 'drop' })).body.items[0].id, 3, 'sort=drop 은 하락률 순');
    eq((await call({ sort: '이상한값' })).body.items[0].id, 2, '모르는 정렬은 점수순으로 떨어진다');
  }

  section('9) 같은 계열 도배 방지 — 버리지 않고 자리만 바꾼다');
  reset([
    deal({ title: '소니 WF-1000XM5 무선 이어폰 블랙', group_key: 'a', hot_score: 99 }),
    deal({ title: '소니 WF-1000XM5 무선 이어폰 화이트', group_key: 'b', hot_score: 98 }),
    deal({ title: '소니 WF-1000XM5 무선 이어폰 실버', group_key: 'c', hot_score: 97 }),
    deal({ title: '삼성전자 갤럭시 버즈3 프로 SM-R630N', group_key: 'd', hot_score: 96 })
  ]);
  {
    const items = (await call({})).body.items;
    eq(items.length, 4, '항목을 버리지 않는다');
    eq(items.map(i => i.id).slice().sort().join(','), '1,2,3,4', '같은 항목들이다');
    ok(items[2].id === 4, '세 번째 자리에 다른 계열이 끼어든다', 'id=' + items[2].id);
  }

  section('10) 페이지 넘김 — 항목이 사라지지 않는다');
  reset(Array.from({ length: 5 }, (_, i) => deal({ group_key: 'g' + i, hot_score: 90 - i })));
  {
    const p1 = await call({ limit: '2' });
    eq(p1.body.items.length, 2, '1페이지 2개');
    eq(p1.body.nextCursor, 2, '커서는 읽은 행 수만큼');
    const p2 = await call({ limit: '2', cursor: '2' });
    eq(p2.body.items.length, 2, '2페이지 2개');
    eq(p2.body.nextCursor, 4, '커서 이어짐');
    const p3 = await call({ limit: '2', cursor: '4' });
    eq(p3.body.items.length, 1, '3페이지 1개');
    eq(p3.body.nextCursor, null, '마지막이면 null');
    const seen = [].concat(p1.body.items, p2.body.items, p3.body.items).map(i => i.id);
    eq(new Set(seen).size, 5, '5개가 빠짐없이 한 번씩 나온다');
  }

  section('11) 마이그레이션 전 — 새 컬럼이 없어도 죽지 않는다');
  reset([deal()]);
  missingColumns = ['is_primary', 'group_key', 'group_size', 'group_lowest_price',
    'group_lowest_mall', 'group_offers', 'signal_json', 'price_drop_percent', 'confidence_rank'];
  {
    const r = await call({});
    eq(r.status, 200, '200 으로 답한다');
    eq(r.body.items.length, 1, '예전 모양으로 목록이 나온다');
    eq(r.body.grouped, false, '군집 없는 응답임을 알린다');
    eq(r.body.items[0].title, '상품 1', '기본 필드는 그대로');
    eq(r.body.items[0].signals.historyCount, 0, '신호는 비어 있되 모양은 같다');
    eq(r.body.items[0].offerCount, 1, '군집 정보는 «혼자» 로 떨어진다');
    eq(r.body.items[0].isLowest, true, '비교할 대상이 없으면 자기가 최저가');
  }
  missingColumns = [];

  section('12) 상세');
  reset([deal({ group_key: 'G', group_size: 2, group_lowest_price: 9000, group_lowest_mall: 'ADPICK',
    group_offers: [
      { mall: 'ADPICK', price: 9000, url: 'https://ad/1', status: 'GOOD_DEAL', productId: 'x' },
      { mall: '쿠팡', price: 10000, url: 'https://link.coupang.com/a/1', status: 'VERIFIED_HOT', productId: 'pid1' }
    ] })]);
  {
    const r = await call({ id: '1' });
    eq(r.status, 200, '200');
    const d = r.body.deal;
    ['reasons', 'confidence', 'identityConfidence', 'lifecycle', 'detectedAt',
      'observations', 'spanDays', 'median30', 'observedLow', 'vendorItemId'].forEach(k => {
      ok(Object.prototype.hasOwnProperty.call(d, k), `상세 필드 ${k} 유지`);
    });
    eq(d.otherOffers.length, 1, '다른 판매처 (자기 자신 제외)');
    eq(d.otherOffers[0].mall, 'ADPICK', '다른 판매처의 몰');
    eq(d.otherOffers[0].price, 9000, '다른 판매처의 값');
    eq(d.signals.priceDropPercent, 16.7, '상세에도 신호가 있다');
    eq((await call({ id: '999' })).status, 404, '없는 id 는 404');
    eq((await call({ id: '0' })).status, 400, '잘못된 id 는 400');
    eq((await call({ id: 'abc' })).status, 400, '숫자가 아닌 id 는 400');
  }

  section('13) 방법·필터');
  reset([deal({ mall: '쿠팡', group_key: 'a' }), deal({ mall: 'ADPICK', group_key: 'b' })]);
  {
    eq((await call({ mall: 'ADPICK' })).body.items.length, 1, 'mall 필터');
    eq((await call({ status: 'VERIFIED_HOT' })).body.items.length, 2, 'status 필터');
    eq((await call({ status: 'REJECTED' })).body.items.length, 2, '보이면 안 되는 status 는 무시된다');
    eq((await call({ limit: '999' })).body.items.length, 2, '과한 limit 도 안전');
    const r = await new Promise(resolve => {
      const res = { status(c) { this.c = c; return this; }, setHeader() { return this; },
        json(b) { resolve({ status: this.c || 200, body: b }); return this; } };
      handler({ method: 'POST', headers: {}, query: {}, socket: { remoteAddress: '10.0.0.8' } }, res);
    });
    eq(r.status, 405, 'GET 이외는 405');
  }

  section('14) External Radar 응답과 source/minScore 필터');
  reset([deal({ source: 'internal-history', hot_score: 95 })], [{
    id: 81, source: 'fmkorea', source_post_id: 'post-81', source_url: 'https://community.example/81',
    title: '외부 검증 상품', price: 29900, original_price: 39900, mall: '쿠팡',
    product_url: 'https://shop.example/81', image_url: 'https://img.example/81.jpg',
    posted_at: iso(1), matched_product_id: 'p81', match_confidence: 0.97, deal_score: 91,
    verification_status: 'STRONG_DEAL', price_vs_30d_avg: 23, price_vs_90d_low: -2,
    average_30d: 38800, low_90d: 30500, previous_price: 39000,
    history_observation_count: 18, history_last_observed_at: '2026-09-12', source_count: 2,
    sources: ['fmkorea', 'ppomppu'], metadata: { matchReason: '모델번호 일치' },
    last_verified_at: iso(0), is_primary: true
  }]);
  {
    const r = await call({ source: 'fmkorea', minScore: '90' });
    eq(r.body.items.length, 1, '외부 source + minScore 필터');
    const it = r.body.items[0];
    eq(it.source, 'fmkorea', 'source');
    eq(it.sourceUrl, 'https://community.example/81', '원문 URL');
    eq(it.productUrl, 'https://shop.example/81', '상품 URL');
    eq(it.dealScore, 91, 'deal score');
    eq(it.matchConfidence, 0.97, 'match confidence');
    eq(it.priceVs30dAvg, 23, '30일 평균 대비');
    eq(it.priceVs90dLow, -2, '90일 최저가 비교');
    eq(it.productId, 'p81', 'SEOSA matched product id');
    eq(it.sourceCount, 2, '중복 source 수');
    eq((await call({ source: 'fmkorea', minScore: '99' })).body.items.length, 0, 'minScore 미달 제외');
  }

  console.log('\n====================================================');
  console.log(`PASS ${pass}  /  FAIL ${fail}`);
  if (fail) { console.log('실패: ' + failures.join(', ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
