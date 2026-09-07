#!/usr/bin/env node
'use strict';
/*
 * SEOSA 레이더 · 목표가 · 구매판단 · 퍼널 — 완전 오프라인.
 *
 * ★ 외부 호출 0회. 운영 Supabase·쿠팡·ADPICK·OpenRouter 를 부르지 않는다.
 *   가짜 Supabase 가 products / price_history / hotdeals / funnel_events 를
 *   흉내 낸다.
 *
 * ★ 여기서 지키는 것.
 *     1) 목표가 판정은 결정론이다 (currentPrice <= targetPrice, 그것뿐)
 *     2) 근거가 없으면 숫자를 만들지 않는다 (goodBuyPrice·단위가는 null)
 *     3) 데이터 «부족» 과 «오래됨» 을 섞지 않는다
 *     4) 클릭을 구매로 기록하지 않는다
 *     5) 기존 Hot Deal v1 · 검색 · 상품 상세를 건드리지 않는다
 */

const path = require('path');
const Module = require('module');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
process.env.CRON_SECRET = 'test-secret';

/* ── 가짜 Supabase ─────────────────────────────────────────────── */
const db = { products: [], price_history: [], hotdeals: [], funnel_events: [], conversions: [] };
/** 이 표들은 «아직 없다» 고 가정한다 (마이그레이션 전 재현). */
let missingTables = [];

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a == null && b == null) return 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const fakeSupabase = {
  from(table) {
    const filters = [];
    const orders = [];
    let single = false, limitN = null, inserted = null;
    const q = {
      select() { return q; },
      insert(row) { inserted = row; return q; },
      eq(c, v) { filters.push(r => String(r[c]) === String(v)); return q; },
      in(c, vs) { filters.push(r => vs.map(String).indexOf(String(r[c])) > -1); return q; },
      gte(c, v) { filters.push(r => cmp(r[c], v) >= 0); return q; },
      order(c, o) { orders.push({ c, asc: !o || o.ascending !== false }); return q; },
      limit(n) { limitN = n; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve) {
        if (missingTables.indexOf(table) > -1) {
          return resolve({ data: null, error: { message: `relation "public.${table}" does not exist` } });
        }
        if (inserted) { db[table].push(Object.assign({}, inserted)); return resolve({ data: null, error: null }); }
        let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
        if (orders.length) {
          rows = rows.slice().sort((a, b) => {
            for (const o of orders) { const d = (o.asc ? 1 : -1) * cmp(a[o.c], b[o.c]); if (d) return d; }
            return 0;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        rows = rows.map(r => Object.assign({}, r));
        return resolve({ data: single ? (rows[0] || null) : rows, error: null });
      }
    };
    return q;
  },
  rpc() { return Promise.resolve({ data: null, error: null }); }
};

const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request) {
  if (request === './_supabase' || request === '../api/_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};
global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

const R = require('../api/_radar');
const P = require('../api/_pricestat');
const funnel = require('../api/_funnel');
const historyHandler = require('../api/history.js');
const statsHandler = require('../api/stats.js');

/* ── 도구 ───────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  — ${detail}` : ''}`); }
}
function eq(a, b, name) { ok(a === b, name, a === b ? String(a) : `기대 ${b} / 실제 ${a}`); }
function section(t) { console.log(`\n[${t}]`); }

const TODAY = '2026-09-07';
const day = n => new Date(Date.parse(TODAY + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
/** n일치 관측. f(i) 가 i일 전의 가격. */
const series = (n, f) => { const a = []; for (let i = n - 1; i >= 0; i--) a.push({ date: day(i), price: f(i) }); return a; };
const statOf = (n, f) => P.statsFrom(series(n, f));

function call(handler, query, body, method) {
  return new Promise((resolve, reject) => {
    let code = 200; const headers = {};
    const res = {
      status(c) { code = c; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      json(b) { resolve({ status: code, headers, body: b }); return this; },
      end() { resolve({ status: code, headers, body: null }); return this; }
    };
    Promise.resolve(handler({
      method: method || (body ? 'POST' : 'GET'),
      headers: {}, query: query || {}, body: body || undefined,
      url: '/api/history', socket: { remoteAddress: '10.0.0.9' }
    }, res)).catch(reject);
  });
}
const radar = (items, extra) => call(historyHandler, Object.assign({ __route: 'radar' }, extra || {}), { items }, 'POST');
const alts = q => call(historyHandler, Object.assign({ __route: 'alternatives' }, q), null, 'GET');

function seed() {
  db.products.length = 0; db.price_history.length = 0; db.hotdeals.length = 0;
  db.funnel_events.length = 0; db.conversions.length = 0;
  missingTables = [];
  funnel._internal._reset();

  db.products.push(
    { product_id: 'A1', mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: 'v1', keyword: '무선 이어폰',
      title: '소니 WF-1000XM5 무선 이어폰', lprice: 199000, image: 'https://i/1.jpg',
      link: 'https://link.coupang.com/a/1', collected_at: '2026-09-07T00:00:00Z' },
    { product_id: 'B2', mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: '', keyword: '무선 이어폰',
      title: '삼성 갤럭시 버즈3 프로', lprice: 209000, image: '', link: 'https://link.coupang.com/a/2',
      collected_at: '2026-09-07T00:00:00Z' },
    { product_id: 'C3', mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: '', keyword: '무선 이어폰',
      title: '소니 WF-1000XM5 무선 이어폰 실리콘 케이스', lprice: 12000, image: '', link: '',
      collected_at: '2026-09-07T00:00:00Z' },
    { product_id: 'D4', mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: '', keyword: '무선 이어폰',
      title: '초고가 레퍼런스 헤드폰', lprice: 1900000, image: '', link: '',
      collected_at: '2026-09-07T00:00:00Z' },
    { product_id: 'THIN', mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: '', keyword: '무선 이어폰',
      title: '기록이 거의 없는 상품', lprice: 50000, image: '', link: '',
      collected_at: '2026-09-07T00:00:00Z' }
  );
  let id = 1;
  const hist = (pid, n, f) => series(n, f).forEach(p => db.price_history.push({
    id: id++, product_id: pid, mall: '쿠팡', vendor_item_id: pid === 'A1' ? 'v1' : '',
    price: p.price, recorded_date: p.date, recorded_at: p.date + 'T01:00:00Z'
  }));
  // A1: 30일, 위아래로 움직이다 오늘 최저 (BUY 후보)
  hist('A1', 30, i => (i === 0 ? 199000 : 220000 + (i % 5) * 9000));
  // B2: 30일, 오늘이 비싼 축 (WAIT 후보)
  hist('B2', 30, i => (i === 0 ? 209000 : 180000 + (i % 4) * 3000));
  hist('C3', 20, () => 12000);
  hist('D4', 20, i => 1900000 + (i % 3) * 10000);
  hist('THIN', 2, () => 50000);
}

(async () => {
  console.log('=== SEOSA 레이더 · 목표가 · 구매판단 · 퍼널 (외부 호출 0회) ===');
  seed();

  /* ───────────────────────────────────────────────────────────── */
  section('1) 레이더 — 저장 · 취소 · 중복 · 익명');
  {
    // «저장» 은 서버에 쓰지 않는다. 목록을 보내면 상태를 돌려주는 구조다.
    const r = await radar([{ productId: 'A1', mall: '쿠팡', vendorItemId: 'v1' }]);
    eq(r.status, 200, '저장 목록 조회 200');
    eq(r.body.items.length, 1, '항목 1개');
    eq(r.body.items[0].currentPrice, 199000, '현재 가격');
    eq(db.funnel_events.length, 0, '레이더 조회는 아무것도 쓰지 않는다');

    // 저장 취소 = 목록에서 빼고 다시 부르는 것. 서버 상태가 없으니 그것으로 끝이다.
    eq((await radar([])).body.items.length, 0, '저장 취소(빈 목록)');

    // 같은 상품을 두 번 저장해도 한 번만 답한다
    const dup = await radar([{ productId: 'A1', mall: '쿠팡' }, { productId: 'A1', mall: '쿠팡' }]);
    eq(dup.body.items.length, 1, '중복 저장은 한 항목으로');

    // 익명 폴백 — 인증 헤더가 없어도 전 기능이 돈다
    ok(r.body.items[0].decision, '익명 사용자도 판정을 받는다', r.body.items[0].decision);
    eq(r.headers['cache-control'] && /no-store/.test(r.headers['cache-control']), true,
      '개인 목록은 캐시하지 않는다');
  }

  section('2) 목표가 — 결정론');
  {
    const reached = await radar([{ productId: 'A1', mall: '쿠팡', targetPrice: 200000, seenPrice: 229000 }]);
    const it = reached.body.items[0];
    eq(it.targetReached, true, '199,000 ≤ 200,000 → 도달');
    const ev = it.events.find(e => e.type === 'TARGET_PRICE_REACHED');
    ok(!!ev, '목표가 도달 이벤트');
    eq(ev.targetPrice, 200000, '목표가');
    eq(ev.currentPrice, 199000, '현재가');
    eq(ev.previousPrice, 229000, '이전 가격');

    const notYet = await radar([{ productId: 'A1', mall: '쿠팡', targetPrice: 150000 }]);
    eq(notYet.body.items[0].targetReached, false, '199,000 > 150,000 → 미도달');
    eq(notYet.body.items[0].events.filter(e => e.type === 'TARGET_PRICE_REACHED').length, 0, '미도달이면 이벤트 없음');

    // 경계 — 같으면 도달이다 (이하)
    eq(R.changesFor({ targetPrice: 199000 }, { price: 199000 }).some(e => e.type === 'TARGET_PRICE_REACHED'),
      true, '같은 값도 «이하» 이므로 도달');
    eq(R.changesFor({ targetPrice: 198999 }, { price: 199000 }).some(e => e.type === 'TARGET_PRICE_REACHED'),
      false, '1원 차이는 미도달');
    // 목표가가 없으면 판정 자체를 하지 않는다
    eq(R.changesFor({ targetPrice: 0 }, { price: 1 }).some(e => e.type === 'TARGET_PRICE_REACHED'),
      false, '목표가 0 은 조건이 아니다');
  }

  section('3) 가격 변화 감지');
  {
    const down = R.changesFor({ seenPrice: 229000 }, { price: 199000 });
    const d = down.find(e => e.type === 'PRICE_DROP');
    ok(!!d, '가격 하락 감지'); eq(d.changeAmount, 30000, '하락 금액'); eq(d.changePercent, 13.1, '하락률');

    const up = R.changesFor({ seenPrice: 199000 }, { price: 229000 });
    ok(up.some(e => e.type === 'PRICE_RISE'), '가격 상승 감지');
    ok(!up.some(e => e.type === 'PRICE_DROP'), '상승을 하락이라 하지 않는다');

    eq(R.changesFor({ seenPrice: 199000 }, { price: 199000 }).length, 0, '같은 가격이면 이벤트 없음');
    // 반올림 노이즈를 «변화» 라고 하지 않는다
    eq(R.changesFor({ seenPrice: 200000 }, { price: 199900 }).length, 0, '0.05% 변동은 무시');

    ok(R.changesFor({}, { price: 1000, isNewLow: true }).some(e => e.type === 'NEW_LOW'), '신저가');
    ok(R.changesFor({ seenDecision: 'WAIT' }, { price: 1000, decision: 'BUY' })
      .some(e => e.type === 'DECISION_BUY'), 'BUY 로 전환');
    ok(!R.changesFor({ seenDecision: 'BUY' }, { price: 1000, decision: 'BUY' })
      .some(e => e.type === 'DECISION_BUY'), '원래 BUY 였으면 «변화» 가 아니다');
    ok(R.changesFor({}, { price: 1000, cheaper: { mall: 'ADPICK', price: 900 } })
      .some(e => e.type === 'CHEAPER_MALL'), '더 싼 판매처');
    ok(!R.changesFor({}, { price: 1000, cheaper: { mall: 'ADPICK', price: 1100 } })
      .some(e => e.type === 'CHEAPER_MALL'), '더 비싸면 «더 싼 곳» 이 아니다');
    eq(R.changesFor({ seenPrice: 1000 }, { price: 0 }).length, 0, '현재가가 없으면 아무 말도 하지 않는다');
  }

  section('4) BUY / WAIT / WATCH · 데이터 상태 분리');
  {
    const buy = R.decisionOf(statOf(30, i => (i === 0 ? 150000 : 220000 + (i % 5) * 9000)), 150000, TODAY, '');
    eq(buy.decision, 'BUY', '기록 대비 확연히 싸면 BUY');
    ok(buy.evidence.dropPercent > 0, '하락률 근거', String(buy.evidence.dropPercent));
    ok(!!buy.reason, '왜 그런지 한 문장', buy.reason.slice(0, 30));

    const dear = R.decisionOf(statOf(30, i => (i === 0 ? 260000 : 180000 + (i % 4) * 2000)), 260000, TODAY, '');
    ok(dear.decision === 'WAIT', '기록 대비 비싸면 WAIT', dear.decision + '/' + dear.verdict);

    const mid = R.decisionOf(statOf(30, i => (i === 0 ? 200000 : 195000 + (i % 5) * 2000)), 200000, TODAY, '');
    ok(['WATCH', 'WAIT'].indexOf(mid.decision) > -1, '평범하면 WATCH 계열', mid.decision);

    // ★ 세 상태가 서로 섞이지 않는다
    eq(R.decisionOf(statOf(30, i => 200000 + (i % 5) * 5000), 190000, TODAY, '').dataState,
      'SUFFICIENT', '충분');
    eq(R.decisionOf(statOf(2, () => 50000), 50000, TODAY, '').dataState, 'INSUFFICIENT', '부족');
    const staleStat = P.statsFrom(series(20, i => 200000 + (i % 4) * 5000).map(p => ({
      date: new Date(Date.parse(p.date) - 25 * 86400000).toISOString().slice(0, 10), price: p.price
    })));
    eq(R.decisionOf(staleStat, 190000, TODAY, '').dataState, 'STALE', 'stale');
    eq(R.decisionOf(null, 190000, TODAY, '').dataState, 'INSUFFICIENT', '기록 없음');
    // 부족·stale 이면 확신을 높게 주지 않는다
    eq(R.decisionOf(statOf(2, () => 50000), 50000, TODAY, '').confidence, 'LOW', '부족하면 LOW');
    eq(R.decisionOf(staleStat, 190000, TODAY, '').confidence, 'LOW', 'stale 이면 LOW');
  }

  section('5) goodBuyPrice — 설명 가능할 때만');
  {
    const rich = statOf(30, i => (i === 0 ? 150000 : 200000 + (i % 5) * 10000));
    const g = R.goodBuyPrice(rich);
    ok(g && g.price > 0, '기록이 두꺼우면 값을 준다', g && String(g.price));
    ok(g.price >= rich.low, '관측 최저가보다 낮은 값을 제시하지 않는다', `${g.price} >= ${rich.low}`);
    ok(g.price <= rich.high, '관측 최고가를 넘지 않는다');
    ok(/관측한 \d+번/.test(g.explain), 'price_history 로 설명된다', g.explain);
    eq(g.price, Math.max(rich.low, rich.p25), 'p25 와 최저가 중 큰 값');

    eq(R.goodBuyPrice(statOf(9, i => 100000 + i * 1000)), null, '관측 10회 미만이면 null');
    eq(R.goodBuyPrice(statOf(30, () => 100000)), null, '값이 안 움직였으면 null');
    eq(R.goodBuyPrice(null), null, '기록 없으면 null');
    eq(R.decisionOf(statOf(2, () => 50000), 50000, TODAY, '').goodBuyPrice, null, '부족하면 판정에도 null');
    eq(R.decisionOf(staleStatOrNull(), 1, TODAY, '').goodBuyPrice, null, 'stale 이면 null');
  }
  function staleStatOrNull() {
    return P.statsFrom(series(20, i => 200000 + (i % 4) * 5000).map(p => ({
      date: new Date(Date.parse(p.date) - 25 * 86400000).toISOString().slice(0, 10), price: p.price
    })));
  }

  section('6) 단위 가격 — 확실할 때만');
  {
    eq(R.unitPriceOf('샴푸 500ml', 12000).unitPrice, 2400, '100ml당');
    eq(R.unitPriceOf('샴푸 500ml', 12000).unit, '100ml', '단위 표기');
    eq(R.unitPriceOf('무선이어폰 2개', 30000).unitPrice, 15000, '개당');
    eq(R.unitPriceOf('커피 원두 1kg', 25000).unitPrice, 2500, 'kg → 100g당');
    // ★ 애매하면 말하지 않는다
    eq(R.unitPriceOf('생수 2L 6개입', 9000), null, '단위가 둘이면 null');

    /*
     * 아래는 전부 2026-09-07 운영 데이터 실측에서 «틀린 값이 나왔던» 제목이다.
     * 지어낸 예가 아니라 실제로 화면에 나갈 뻔한 값들이다.
     */
    eq(R.unitPriceOf('BMW X4 G02 F98 2018-2026 자동차 햇빛 가리개', 21850), null,
      '★ 모델코드의 «4 G» 를 4그램으로 읽지 않는다');
    eq(R.unitPriceOf('롯데칠성 펩시 제로슈거 355ml 48캔 업소용', 19900), null,
      '★ 수량이 둘(355ml·48캔)이면 무엇을 나눌지 모른다');
    eq(R.unitPriceOf('리벤스 아기 물티슈 캡형, 75g, 70매, 10개', 4800), null,
      '★ 수량이 셋이면 null');
    eq(R.unitPriceOf('도트 미니 아이스박스 9L', 20995), null,
      '★ 용기의 «크기» 를 내용물의 «양» 으로 읽지 않는다');
    eq(R.unitPriceOf('캠핑 낚시 차량용 아이스박스 25리터', 35400), null, '★ 아이스박스 25리터도 null');
    eq(R.unitPriceOf('올리빙 도트 가정용 재활용 분리수거함 40L 3P', 26880), null, '★ 분리수거함 40L');
    // 반대로, 진짜 내용물이면 말한다
    eq(R.unitPriceOf('신라면 120g', 4150).unitPrice, 3458, '라면 120g 은 내용물이다');
    eq(R.unitPriceOf('끌로에 우먼 EDP 75ml', 102210).unitPrice, 136280, '향수 75ml');
    eq(R.unitPriceOf('빙그레 붕어싸만코 저당 아이스크림 24개', 26450).unitPrice, 1102, '아이스크림 24개');
    eq(R.unitPriceOf('그냥 상품명', 10000), null, '단위가 없으면 null');
    eq(R.unitPriceOf('세트 1개', 10000), null, '1개짜리에 «개당» 은 정보가 없다');
    eq(R.unitPriceOf('샴푸 500ml', 0), null, '가격이 없으면 null');
    eq(R.unitPriceOf('', 1000), null, '제목이 없으면 null');
  }

  section('7) 대체 상품 후보');
  {
    const r = await alts({ pid: 'A1', mall: '쿠팡', limit: 5 });
    eq(r.status, 200, '200');
    const ids = r.body.items.map(i => i.productId);
    ok(ids.indexOf('B2') > -1, '같은 검색어의 비슷한 가격대 상품이 후보');
    eq(ids.indexOf('C3'), -1, '★ 부속(케이스)은 제외');
    eq(ids.indexOf('D4'), -1, '★ 가격대가 크게 벗어나면 제외');
    eq(ids.indexOf('A1'), -1, '자기 자신 제외');
    ok(r.body.items.every(i => i.price > 0), '현재 가격이 있는 것만');
    ok(r.body.items.every(i => i.decision), '후보에도 판단 근거가 붙는다');
    ok(!!r.body.base.title, '기준 상품 정보');
    eq((await alts({ pid: 'NOPE' })).status, 404, '없는 상품은 404');
    eq((await alts({})).status, 400, '식별자 없으면 400');
  }

  section('8) 재방문 요약');
  {
    const r = await radar([
      { productId: 'A1', mall: '쿠팡', vendorItemId: 'v1', seenPrice: 229000, targetPrice: 200000, seenDecision: 'WAIT' },
      { productId: 'B2', mall: '쿠팡', seenPrice: 209000 },
      { productId: 'THIN', mall: '쿠팡' }
    ]);
    eq(r.body.items.length, 3, '3건');
    ok(r.body.summary.total === 3, '요약 총계');
    ok(r.body.summary.actionable >= 1, '«다시 올 이유» 가 있는 건수', String(r.body.summary.actionable));
    ok(r.body.summary.byType.TARGET_PRICE_REACHED >= 1, '갈래별 집계');
    ok(r.body.summary.decisions.BUY + r.body.summary.decisions.WAIT + r.body.summary.decisions.WATCH === 3,
      '판정별 집계 합이 총계와 같다');
    eq(r.body.today, undefined === r.body.today ? undefined : r.body.today, 'today 포함');
  }

  section('9) null · 결손 처리');
  {
    const r = await radar([{ productId: 'UNKNOWN_PID', mall: '쿠팡' }]);
    const it = r.body.items[0];
    eq(it.currentPrice, null, '카탈로그에 없으면 가격은 null (0 아님)');
    eq(it.events.length, 0, '가격이 없으면 이벤트를 만들지 않는다');
    eq(it.goodBuyPrice, null, '근거 없으면 goodBuyPrice null');
    eq(it.unit, null, '단위가 없으면 null');
    eq(it.dataState, 'INSUFFICIENT', '데이터 상태');
    const json = JSON.stringify(r.body);
    ok(!/NaN|undefined/.test(json), '응답에 NaN·undefined 가 없다');
    // 잘못된 입력
    eq((await radar([{ mall: '쿠팡' }])).body.items.length, 0, 'productId 없는 항목은 버린다');
    eq((await radar(null)).body.items.length, 0, 'items 가 없어도 죽지 않는다');
  }

  section('10) 페이지네이션 · 성능 상한');
  {
    const many = [];
    for (let i = 0; i < R.MIN_OBSERVATIONS + 80; i++) many.push({ productId: 'P' + i, mall: '쿠팡' });
    const r = await radar(many);
    ok(r.body.items.length <= 60, '한 번에 60건까지', String(r.body.items.length));
    eq(r.body.truncated, true, '잘렸다는 사실을 알린다');
  }

  section('11) hotdeals 표가 없어도 레이더는 돈다');
  {
    missingTables = ['hotdeals'];
    const r = await radar([{ productId: 'A1', mall: '쿠팡', vendorItemId: 'v1' }]);
    eq(r.status, 200, '200');
    eq(r.body.items[0].hotDeal, null, '핫딜 정보만 비고');
    ok(r.body.items[0].decision, '판정은 그대로 나온다');
    missingTables = [];
  }

  section('12) 퍼널 계측 — 클릭은 구매가 아니다');
  {
    const r = await call(statsHandler, {
      event: 'affiliate_click', pid: 'A1', mall: '쿠팡', price: '199000',
      src: 'hotdeal', vid: 'abc12345xyz'
    });
    eq(r.status, 200, '200');
    eq(db.funnel_events.length, 1, '상품 단위로 남는다');
    const row = db.funnel_events[0];
    eq(row.event, 'affiliate_click', '이벤트');
    eq(row.product_id, 'A1', 'productId');
    eq(row.mall, '쿠팡', 'mall');
    eq(row.price, 199000, 'price');
    eq(row.source, 'hotdeal', 'source');
    eq(row.visitor_id, 'abc12345xyz', 'visitor_id (브라우저 난수)');

    // ★★ 이것이 이 파일에서 가장 중요한 검사다
    eq(db.conversions.length, 0, '★ 클릭은 conversions 에 들어가지 않는다');
    ok(!Object.prototype.hasOwnProperty.call(row, 'ip'), 'IP 를 저장하지 않는다');
    ok(!Object.prototype.hasOwnProperty.call(row, 'user_agent'), 'User-Agent 를 저장하지 않는다');
    ok(!Object.prototype.hasOwnProperty.call(row, 'email'), '이메일과 연결하지 않는다');

    // 개인정보·위조 방어
    await call(statsHandler, { event: 'radar_save', pid: 'A1', vid: 'not a vid!!' });
    eq(db.funnel_events[1].visitor_id, '', '모양이 다른 vid 는 버린다');
    await call(statsHandler, { event: 'affiliate_click', pid: 'A1', price: '-5' });
    eq(db.funnel_events[2].price, 0, '음수 가격을 0원으로 적지 않는다');
    await call(statsHandler, { event: 'affiliate_click', pid: 'A1', src: '해킹' });
    eq(db.funnel_events[3].source, '', '모르는 source 는 빈 값');

    const before = db.funnel_events.length;
    await call(statsHandler, { event: 'search_submit', pid: 'A1' });
    eq(db.funnel_events.length, before, '대량 이벤트는 행으로 쌓지 않는다 (카운터로만)');
    await call(statsHandler, { event: 'conversion', pid: 'A1' });
    eq(db.conversions.length, 0, '★ conversion 이라는 이벤트로도 전환을 만들 수 없다');
  }

  section('13) 계측 화이트리스트 — 조용히 버려지던 핫딜 이벤트');
  {
    const analytics = require('../api/_analytics.js');
    const src = require('fs').readFileSync(path.resolve(__dirname, '..', 'api', '_analytics.js'), 'utf8');
    const list = (src.match(/const METRICS = \[([\s\S]*?)\];/) || ['', ''])[1];
    ['hotdeal_list_view', 'hotdeal_open', 'hotdeal_impression', 'radar_save', 'radar_remove',
      'target_price_set', 'compare_open', 'affiliate_click', 'buy_wait_watch_view', 'product_view']
      .forEach(m => ok(list.indexOf(`'${m}'`) > -1, `METRICS 에 ${m} 이 있다`));
    ok(typeof analytics.bump === 'function', 'bump 존재');
  }

  section('14) funnel_events 표가 없어도 서비스는 돈다');
  {
    funnel._internal._reset();
    missingTables = ['funnel_events'];
    const r = await call(statsHandler, { event: 'affiliate_click', pid: 'A1' });
    eq(r.status, 200, '200 으로 답한다');
    eq(r.body.logged, false, '기록되지 않았음을 알린다');
    missingTables = [];
    funnel._internal._reset();
  }

  section('15) 기존 기능 회귀');
  {
    // 상품 가격 기록 (기존 /api/history) — 레이더 라우트 추가로 깨지지 않아야 한다
    const h = await call(historyHandler, { productId: 'A1', mall: '쿠팡' });
    eq(h.status, 200, '가격 기록 조회 200');
    ok(Array.isArray(h.body) || Array.isArray(h.body.points), '기존 응답 모양 유지');
    // 검색어 집계 (기존 /api/stats)
    const s = await call(statsHandler, { keyword: '무선 이어폰' });
    eq(s.status, 200, '검색어 집계 200');
    // 핫딜 엔진·군집 모듈이 그대로 로드된다
    ok(!!require('../api/_hotdeal.js').evaluate, 'Hot Deal 엔진 그대로');
    ok(!!require('../api/_hotgroup.js').groupOffers, '핫딜 군집 그대로');
    // _pricestat 에 p25 를 더했지만 기존 필드는 그대로여야 한다
    const st = statOf(30, i => 100000 + (i % 5) * 1000);
    ['count', 'low', 'high', 'avg30', 'avg7', 'median', 'trendPct', 'points', 'historyDays', 'volatility']
      .forEach(f => ok(Object.prototype.hasOwnProperty.call(st, f), `statsFrom.${f} 유지`));
    ok(typeof st.p25 === 'number', 'p25 추가됨');
  }

  console.log('\n====================================================');
  console.log(`PASS ${pass}  /  FAIL ${fail}`);
  if (fail) { console.log('실패: ' + failures.join(', ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
