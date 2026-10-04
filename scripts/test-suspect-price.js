#!/usr/bin/env node
'use strict';
/*
 * 의심 관측(suspect) 격리 — 2026-10-04 독립 리뷰(Codex) 재현 시나리오를 그대로.
 *
 *   승인 현재가 500,000 → 새 단발 관측 90,000 (같은 옵션, 5배 이상 = suspect)
 *
 *   저장   products 500,000 유지 · price_history 90,000 기록 · suspect 1   (원래부터 맞음)
 *   읽기   검색 · 상세 헤드라인 · 차트 마지막 점 · JSON-LD Offer · AI 근거가
 *          전부 90,000 으로 나갔다 (재현됨)  → 전부 500,000 이어야 한다
 *   핫딜   오늘의 하락은 IMPLAUSIBLE 로 이미 빠진다 — 그대로여야 한다
 *   승격   다음 날 같은 수준(90,000)이 다시 관측되면 그때 90,000 이 현재가가 된다
 *
 * 실제 핸들러(/api/search · /api/history · /p/ · today-drop)와 저장 함수(saveProducts)
 * 를 가짜 Supabase 위에서 돌린다. 운영 DB 0회, 외부 호출 0회.
 */
const path = require('path');
const Module = require('module');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
process.env.ANALYTICS_DISABLED = '1';

/* ══════════════════════════════════════════════════════════════════
 *  가짜 Supabase — select 필터 · 정렬 · upsert(onConflict) 만
 * ════════════════════════════════════════════════════════════════ */
const db = { products: [], price_history: [], hotdeals: [] };
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a == null && b == null) return 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function builder(table) {
  const filters = [];
  const orders = [];
  let limitN = null, rangeFrom = null, rangeTo = null, single = false, upsertRows = null, conflict = null;
  // 이 시험이 쓰지 않는 연산자(.or · .not · .is …)는 걸러내지 않고 지나간다.
  let self = null;
  const q = {
    select() { return self; },
    eq(c, v) { filters.push(r => String(r[c]) === String(v)); return self; },
    neq(c, v) { filters.push(r => String(r[c]) !== String(v)); return self; },
    in(c, vs) { filters.push(r => vs.map(String).indexOf(String(r[c])) > -1); return self; },
    gte(c, v) { filters.push(r => cmp(r[c], v) >= 0); return self; },
    gt(c, v) { filters.push(r => cmp(r[c], v) > 0); return self; },
    lt(c, v) { filters.push(r => cmp(r[c], v) < 0); return self; },
    lte(c, v) { filters.push(r => cmp(r[c], v) <= 0); return self; },
    order(c, o) { orders.push({ c, asc: !o || o.ascending !== false }); return self; },
    limit(n) { limitN = n; return self; },
    range(a, b) { rangeFrom = a; rangeTo = b; return self; },
    maybeSingle() { single = true; return self; },
    upsert(rows, opts) { upsertRows = [].concat(rows); conflict = String((opts && opts.onConflict) || '').split(',').map(s => s.trim()).filter(Boolean); return self; },
    then(resolve) {
      if (upsertRows) {
        db[table] = db[table] || [];
        upsertRows.forEach(row => {
          const i = db[table].findIndex(r => conflict.length && conflict.every(c => String(r[c] == null ? '' : r[c]) === String(row[c] == null ? '' : row[c])));
          if (i > -1) db[table][i] = Object.assign({}, db[table][i], row);
          else db[table].push(Object.assign({ id: db[table].length + 1 }, row));
        });
        return resolve({ data: null, error: null });
      }
      let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
      if (orders.length) {
        rows = rows.slice().sort((a, b) => {
          for (const o of orders) { const d = (o.asc ? 1 : -1) * cmp(a[o.c], b[o.c]); if (d) return d; }
          return 0;
        });
      }
      if (rangeFrom != null) rows = rows.slice(rangeFrom, rangeTo + 1);
      if (limitN != null) rows = rows.slice(0, limitN);
      rows = rows.map(r => Object.assign({}, r));
      return resolve({ data: single ? (rows[0] || null) : rows, error: null });
    }
  };
  self = new Proxy(q, { get(t, k) { return k in t ? t[k] : (() => self); } });
  return self;
}
const fakeSupabase = {
  from: builder,
  rpc() {
    const r = { data: null, error: { message: 'Could not find the function public.price_history_prior_obs in the schema cache', code: 'PGRST202' } };
    return { abortSignal() { return Promise.resolve(r); }, then(res) { return Promise.resolve(r).then(res); } };
  }
};
const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request) {
  if (request === './_supabase' || request === supabasePath || request === '../api/_supabase') return fakeSupabase;
  return realLoad.apply(this, arguments);
};
global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

/* ══════════════════════════════════════════════════════════════════ */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail).slice(0, 300)}`); }
}
function section(t) { console.log(`\n[${t}]`); }
function call(handler, query, method) {
  return new Promise((resolve, reject) => {
    let code = 200; const headers = {};
    const res = {
      status(c) { code = c; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      json(body) { resolve({ status: code, headers, body, text: JSON.stringify(body) }); return this; },
      end(text) { resolve({ status: code, headers, body: null, text: String(text || '') }); return this; }
    };
    Promise.resolve(handler({ method: method || 'GET', headers: {}, query, socket: { remoteAddress: '10.1.2.' + Math.floor(Math.random() * 250) } }, res)).catch(reject);
  });
}

const DAY = 86400000;
const iso = msAgo => new Date(Date.now() - msAgo).toISOString();
const { kstToday } = require('../api/_price');
const kst = msAgo => kstToday(new Date(Date.now() - msAgo));

const PID = '7001', VID = '90001', MALL = '쿠팡';
const TITLE = '테스트 노트북 16인치 고성능 자급형';
const LINK = `https://link.coupang.com/re/AFFSDP?lptag=AF8789251&pageKey=${PID}&itemId=80001&vendorItemId=${VID}`;
function hist(daysAgo, price) {
  return { product_id: PID, mall: MALL, title: TITLE, price, link: LINK, vendor_item_id: VID, item_id: '80001',
    recorded_at: iso(daysAgo * DAY + 3600000), recorded_date: kst(daysAgo * DAY + 3600000), source: 'collect' };
}
function seed(prices) {
  db.price_history = prices.map(([d, p]) => hist(d, p));
  db.products = [{ id: 1, product_id: PID, mall: MALL, keyword: '테스트 노트북', title: TITLE, lprice: 500000, oprice: 500000, save_pct: 0,
    link: LINK, image: 'https://img.example/a.jpg', collected_at: iso(DAY), item_id: '80001', vendor_item_id: VID, mall_label: '' }];
  db.hotdeals = [];
}
const observed = price => ({ title: TITLE, lprice: price, link: LINK, image: 'https://img.example/a.jpg', mall: MALL, isCoupang: true,
  productId: PID, oprice: price, savePct: 0, itemId: '80001', vendorItemId: VID, _source: 'api' });

const shop = require('../api/_shop');
let searchItems = [];
shop.searchAll = async () => ({ items: searchItems.map(x => Object.assign({}, x)), allItems: null, from: 'api', blocked: false, failed: false, errors: [] });
const search = require('../api/search.js');
const history = require('../api/history.js');
const hotdeals = require('../api/hotdeals.js');
const { attachTrust } = require('../api/_trust');
const { loadStats } = require('../api/_pricestat');
const ai = require('../api/ai.js')._internal;
const fs = require('fs');

(async () => {
  /* 8일치 승인 기록 — /p/ 페이지가 색인 조건(관측 7일)을 넘도록 */
  const ACCEPTED = [[8, 500000], [7, 500000], [6, 500000], [5, 500000], [4, 500000], [3, 500000], [2, 500000], [1, 500000]];

  section('1) 저장 — products 500,000 유지 · 원장에는 90,000 기록 (원래 동작)');
  seed(ACCEPTED);
  const saved = await shop.saveProducts('테스트 노트북', [observed(90000)], { from: 'api', source: 'search' });
  ok(saved.suspect === 1, 'suspect 1건으로 판정', saved);
  ok(db.products[0].lprice === 500000, 'products 현재가는 500,000 그대로', db.products[0].lprice);
  const todayRow = db.price_history.find(r => r.recorded_date === kstToday() && r.vendor_item_id === VID);
  ok(todayRow && todayRow.price === 90000, '원장(price_history)에는 90,000 관측이 남는다 — 지우지 않는다', todayRow);

  section('2) 검색 /api/search — 500,000');
  seed(ACCEPTED);
  searchItems = [observed(90000)];
  const s = await call(search, { keyword: '테스트 노트북' });
  const sItem = (s.body || []).find(x => x.productId === PID);
  ok(sItem && sItem.lprice === 500000, '★ 검색 결과 현재가 500,000', sItem && sItem.lprice);
  ok(sItem && sItem.priceWithheld === true, '확인 전 급변임을 표시한다 (priceWithheld)');
  ok(!/90000|90,000/.test(s.text), '★ 응답 어디에도 90,000 이 실리지 않는다', s.text.match(/.{40}90000.{20}/));
  const ledger = db.price_history.find(r => r.recorded_date === kstToday() && r.vendor_item_id === VID);
  ok(ledger && ledger.price === 90000, '검색이 남긴 원장 관측은 실제 값 90,000', ledger);
  ok(db.products[0].lprice === 500000, '검색 후에도 products 500,000');

  section('3) 상세 /p/ · JSON-LD Offer · 모달 /api/history — 500,000');
  const pageRes = await call(history, { __route: 'page', pid: PID });
  const html = pageRes.text;
  const ld = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || []).join('');
  ok(/"price":\s*"?500000/.test(ld), '★ JSON-LD Offer price 500000', ld.slice(0, 300));
  ok(!/"price":\s*"?90000/.test(ld), '★ JSON-LD 에 90000 이 없다');
  ok(/<div class="price">500,000<small> 원<\/small><\/div>/.test(html), '★ 상세 헤드라인 500,000원', (html.match(/<div class="price">[^]{0,40}/) || [])[0]);
  ok(html.indexOf('90,000') < 0, '상세 HTML 어디에도 90,000 이 없다');
  const prodJson = await call(history, { __route: 'product', pid: PID });
  ok(prodJson.body && prodJson.body.product && prodJson.body.product.lprice === 500000, '?p= 딥링크 JSON 현재가 500,000', prodJson.body && prodJson.body.product);
  const modal = await call(history, { productId: PID, mall: MALL, vendorItemId: VID, deal: '1' });
  const pts = (modal.body && modal.body.points) || [];
  ok(pts.length && pts[pts.length - 1].price === 500000, '★ 차트 마지막 점(모달 헤드라인) 500,000', pts.slice(-2));
  ok(!pts.some(p => p.price === 90000), '차트에 90,000 점이 없다');
  const batch = await call(history, { __route: 'batch', keys: JSON.stringify([`${PID}|${MALL}|${VID}`]), titles: '[]' });
  const bpts = (batch.body && batch.body[`${PID}|${MALL}|${VID}`]) || [];
  ok(bpts.length && bpts[bpts.length - 1].price === 500000, '배치 이력(스파크라인·찜 현재가) 마지막 점 500,000', bpts.slice(-2));

  section('4) AI — 현재가·가격 근거 500,000, 원장 기록은 90,000');
  seed(ACCEPTED);
  const aiItem = observed(90000);
  await attachTrust([aiItem], { source: 'api', guardPrice: true });   // ai.js 와 같은 순서: 저장 «전»
  ok(aiItem.lprice === 500000, '★ AI 후보 현재가 500,000', aiItem.lprice);
  ok(ai.toCard(aiItem).lprice === 500000, '★ AI 상품 카드 가격 500,000', ai.toCard(aiItem));
  ok(!/90000/.test(JSON.stringify(aiItem)), 'AI 항목 JSON 에 90,000 이 실리지 않는다 (원 관측값은 열거되지 않는 속성)');
  await shop.saveProducts('테스트 노트북', [aiItem], { from: 'api', source: 'ai' });
  const aiLedger = db.price_history.find(r => r.recorded_date === kstToday() && r.vendor_item_id === VID);
  ok(aiLedger && aiLedger.price === 90000, '★ 저장이 화면값(500,000)이 아니라 실제 관측(90,000)을 원장에 남긴다', aiLedger);
  const stats = await loadStats([{ productId: PID, mall: MALL, vendorItemId: VID }], { strictOption: true });
  const st = stats.get(`${PID}|${MALL}|${VID}`);
  ok(st && st.low === 500000 && st.lastPrice === 500000, '★ AI 가격 근거(loadStats) 최저·최근 500,000', st);
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'ai.js'), 'utf8');
  ok(/attachTrust\(currentItems, \{ source: from, guardPrice: true \}\)/.test(aiSrc), 'ai.js 검색 경로가 guardPrice 로 신뢰도를 붙인다 (배선)');

  section('5) 오늘의 하락 — 여전히 제외 (IMPLAUSIBLE)');
  seed(ACCEPTED.concat([[0, 90000]]));
  const td = await call(hotdeals, { view: 'today-drop', limit: 60 });
  ok(td.status === 200 && !(td.body.items || []).some(x => x.productId === PID), '★ 90,000 하락 카드가 없다', td.body && td.body.items);
  ok(td.body.stats && td.body.stats.reasons && td.body.stats.reasons.IMPLAUSIBLE >= 1, 'stats.reasons.IMPLAUSIBLE 로 빠졌다', td.body && td.body.stats);

  section('6) 승격 — 다음 날 같은 수준이 다시 관측되면 90,000 이 현재가');
  seed(ACCEPTED.slice(0, 7).concat([[1, 90000]]));   // 어제 90,000(suspect) · 오늘 다시 90,000
  const promo = await shop.saveProducts('테스트 노트북', [observed(90000)], { from: 'api', source: 'search' });
  ok(promo.suspect === 0 && db.products[0].lprice === 90000, '저장: products 가 90,000 으로 승격', { promo, lprice: db.products[0].lprice });
  seed(ACCEPTED.slice(0, 7).concat([[1, 90000]]));
  searchItems = [observed(90000)];
  const s2 = await call(search, { keyword: '테스트 노트북' });
  const s2Item = (s2.body || []).find(x => x.productId === PID);
  ok(s2Item && s2Item.lprice === 90000 && !s2Item.priceWithheld, '★ 검색 현재가 90,000 (보류 아님)', s2Item);
  const modal2 = await call(history, { productId: PID, mall: MALL, vendorItemId: VID, deal: '1' });
  const pts2 = modal2.body.points;
  ok(pts2[pts2.length - 1].price === 90000 && pts2.some(p => p.price === 90000 && p.date === kst(DAY + 3600000)),
    '★ 차트: 어제 90,000 도 확인된 관측으로 보인다', pts2.slice(-3));
  const page2 = await call(history, { __route: 'page', pid: PID });
  ok(/"price":\s*"?90000/.test(page2.text), '★ JSON-LD Offer 90000 (승격 후)');

  section('7) 반대 방향 — 일시적으로 튀었다가 돌아오면 튄 값은 끝까지 숨는다');
  seed(ACCEPTED.slice(0, 6).concat([[2, 90000], [1, 500000]]));
  const modal3 = await call(history, { productId: PID, mall: MALL, vendorItemId: VID, deal: '1' });
  ok(!modal3.body.points.some(p => p.price === 90000), '되돌아간 단발 90,000 은 차트에 없다', modal3.body.points);

  console.log(`\n${'='.repeat(58)}`);
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail) { console.log('\n실패한 항목:'); failures.forEach(f => console.log(`  · ${f}`)); process.exit(1); }
  console.log('의심 관측 격리 계약 이상 없음.');
})().catch(e => { console.error(e); process.exit(1); });
