#!/usr/bin/env node
'use strict';
/*
 * 구매 링크 무결성 — 서버 쪽 (2026-10-04 독립 리뷰 재현).
 *
 * 리뷰에서 통과해 버린 것: 다른 파트너 lptag 의 AFF 링크 · lptag 없는 AFF 링크 ·
 * /re/UNKNOWN · 쿠팡 상품 페이지 원본 URL. 그리고 /re/PCS… 는 핫딜·AI 경로로 우회됐다.
 *
 * 여기서는 «URL 형식 × 구매 링크를 내보내는 모든 서버 출구» 를 실제 함수로 돌린다.
 * 한 출구라도 다른 판정을 내리면 실패다. (브라우저 쪽 같은 매트릭스는 test-user-flow.js)
 *
 * 운영 DB 0회, 외부 호출 0회.
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
process.env.ANALYTICS_DISABLED = '1';

/* 가짜 Supabase — 검색 핸들러가 저장·신뢰도·하락 표시를 위해 읽고 쓰는 만큼만 */
const db = { products: [], price_history: [] };
function builder(table) {
  let self = null; let up = null;
  const q = {
    select() { return self; }, eq() { return self; }, in() { return self; }, gte() { return self; },
    lt() { return self; }, order() { return self; }, limit() { return self; }, range() { return self; },
    upsert(rows) { up = rows; return self; },
    then(res) { if (up) { (db[table] = db[table] || []).push(...[].concat(up)); return res({ data: null, error: null }); } return res({ data: [], error: null }); }
  };
  self = new Proxy(q, { get(t, k) { return k in t ? t[k] : (() => self); } });
  return self;
}
const fakeSupabase = { from: builder, rpc() { return Promise.resolve({ data: null, error: { message: 'Could not find the function' } }); } };
const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request) {
  if (request === './_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};
global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail).slice(0, 240)}`); }
}
function section(t) { console.log(`\n[${t}]`); }

const A = require('../api/_affiliate');
const VID = '90001';
const FORMS = [
  // [이름, URL, 통과해야 하는가]
  ['SEOSA AFFSDP', `https://link.coupang.com/re/AFFSDP?lptag=${A.SEOSA_COUPANG_LPTAG}&pageKey=7001&itemId=80001&vendorItemId=${VID}`, true],
  ['SEOSA AFFTDP', `https://link.coupang.com/re/AFFTDP?lptag=${A.SEOSA_COUPANG_LPTAG}&pageKey=7001&vendorItemId=${VID}`, true],
  ['파트너스 단축 /a/', 'https://link.coupang.com/a/hb5vuuKbV6', true],
  ['ADPICK commissionlink', 'https://biz.adpick.co.kr/r4268331', true],
  ['다른 파트너 lptag', `https://link.coupang.com/re/AFFSDP?lptag=AF1234567&pageKey=7001&vendorItemId=${VID}`, false],
  ['lptag 없음', `https://link.coupang.com/re/AFFSDP?pageKey=7001&vendorItemId=${VID}`, false],
  ['/re/PCS 가격비교', 'https://link.coupang.com/re/PCSNAVERPCSDP?pageKey=5475665757&lptag=l000000000000&vendorItemId=95176818964', false],
  ['/re/UNKNOWN', `https://link.coupang.com/re/UNKNOWN?lptag=${A.SEOSA_COUPANG_LPTAG}&pageKey=7001`, false],
  ['쿠팡 상품 원본 URL', `https://www.coupang.com/vp/products/7001?vendorItemId=${VID}`, false],
  ['모바일 원본 URL', `https://m.coupang.com/vm/products/7001?vendorItemId=${VID}`, false],
  ['http 제휴 링크', `http://link.coupang.com/re/AFFSDP?lptag=${A.SEOSA_COUPANG_LPTAG}&pageKey=7001`, false],
  ['다른 옵션의 제휴 링크', `https://link.coupang.com/re/AFFSDP?lptag=${A.SEOSA_COUPANG_LPTAG}&pageKey=7001&vendorItemId=99999`, false],
  ['javascript:', 'javascript:alert(1)', false]
];

section('0) 관문 자체');
FORMS.forEach(([name, url, allow]) => {
  const got = A.safeBuyLink(url, { vendorItemId: VID });
  ok(allow ? got === url : got === '', `${allow ? '통과' : '차단'} — ${name}`, got);
});
ok(A.firstSafeBuyLink([FORMS[6][1], FORMS[0][1]], { vendorItemId: VID }) === FORMS[0][1], '여러 후보면 막힌 것을 건너뛰고 첫 통과 링크');
ok(A.firstSafeBuyLink([FORMS[4][1], FORMS[8][1]], { vendorItemId: VID }) === '', '전부 막히면 빈 링크 — 원본 URL 로 되살리지 않는다');

/* ── 출구별 ── */
const shop = require('../api/_shop');
const H = require('../api/hotdeals.js')._internal;
const ai = require('../api/ai.js')._internal;
const aictx = require('../api/_aicontext');
const init = require('../api/init.js')._internal;

const EXITS = [
  ['toClientProduct (홈·추천·/p/·?p=)', url => shop.toClientProduct({ product_id: '7001', mall: '쿠팡', title: 't', lprice: 1000, link: url, vendor_item_id: VID }).link],
  ['핫딜 엔진 목록 url/productUrl', url => { const x = H.toListItem({ id: 1, affiliate_url: url, vendor_item_id: VID, source: 'internal-history', reason_json: [], signal_json: {} }); return x.url === x.productUrl ? x.url : 'MISMATCH'; }],
  ['핫딜 다른 판매처(otherOffers)', url => (H.otherOffers({ group_offers: [{ url, price: 1000, vendorItemId: VID, key: 'o' }], affiliate_url: '' })[0] || {}).url],
  ['외부 핫딜(검증)', url => H.toExternalListItem({ id: 1, metadata: { affiliateUrl: url }, source_url: 'https://community.example/p/1' }).affiliateUrl],
  ['커뮤니티 핫딜', url => H.toCommunityListItem({ id: 1, metadata: { affiliateUrl: url }, source_url: 'https://community.example/p/1' }).affiliateUrl],
  ['오늘의 하락 카드 링크', url => H.linkFor({ dealUrl: '', historyLink: url, vendorItemId: VID }, null)],
  ['AI 상품 카드(toCard)', url => ai.toCard({ productId: '7001', title: 't', lprice: 1000, link: url, vendorItemId: VID }).link],
  ['AI 카탈로그 근거(rowToItem)', url => aictx.rowToItem({ product_id: '7001', mall: '쿠팡', title: 't', lprice: 1000, link: url, vendor_item_id: VID }).link],
  ['홈 시세판(init toDropRow)', url => init.toDropRow({ product_id: '7001', mall: '쿠팡', title: 't', current_price: 1000, link: url }).link]
];

section('1) URL 형식 × 서버 출구 — 모든 출구가 같은 판정');
FORMS.filter(([n]) => n !== '다른 옵션의 제휴 링크').forEach(([name, url, allow]) => {
  const results = EXITS.map(([exit, fn]) => {
    let out; try { out = fn(url); } catch (e) { out = 'THROW:' + e.message; }
    return { exit, out, good: allow ? out === url : out === '' };
  });
  const bad = results.filter(r => !r.good);
  ok(!bad.length, `★ ${allow ? '통과' : '차단'} — ${name} (${EXITS.length}개 출구)`, bad);
});

section('1-b) 옵션이 다른 링크 — 옵션을 아는 출구는 전부 막는다');
const optUrl = FORMS.find(([n]) => n === '다른 옵션의 제휴 링크')[1];
[EXITS[0], EXITS[1], EXITS[5], EXITS[6], EXITS[7]].forEach(([exit, fn]) => ok(fn(optUrl) === '', `${exit}: 옵션 ${VID} 항목에 vendorItemId=99999 링크를 싣지 않는다`, fn(optUrl)));

section('2) /api/search 응답 — 실제 핸들러');
(async () => {
  let items = [];
  shop.searchAll = async () => ({ items: items.map(x => Object.assign({}, x)), from: 'api', blocked: false, failed: false, errors: [] });
  shop.saveProducts = async () => ({ saved: 0, errors: [] });
  const search = require('../api/search.js');
  items = FORMS.map(([name, url], i) => ({ title: '테스트 상품 ' + name, lprice: 1000 + i, link: url, mall: '쿠팡', productId: String(7000 + i), vendorItemId: VID, _source: 'api' }));
  const body = await new Promise((resolve, reject) => {
    const res = { status() { return res; }, setHeader() { return res; }, json: resolve, end: resolve };
    Promise.resolve(search({ method: 'GET', headers: {}, query: { keyword: '테스트 상품' }, socket: { remoteAddress: '10.9.9.9' } }, res)).catch(reject);
  });
  FORMS.forEach(([name, url, allow], i) => {
    const it = (body || []).find(x => x.productId === String(7000 + i));
    ok(it && (allow ? it.link === url : it.link === ''), `★ 검색 응답 — ${allow ? '통과' : '차단'}: ${name}`, it && it.link);
  });

  section('3) /p/ 상품 페이지 구매 버튼 — renderPage');
  const page = require('../api/_product-page.js')._internal;
  FORMS.filter(([n]) => n !== '다른 옵션의 제휴 링크' && n !== 'javascript:').forEach(([name, url, allow]) => {
    const product = shop.toClientProduct({ product_id: '7001', mall: '쿠팡', title: '테스트', lprice: 1000, link: url, vendor_item_id: VID });
    const html = page.renderPage({ product, points: [], stat: null, deal: { verdict: 'UNKNOWN', label: '', reasons: [], cautions: [] }, price: 1000, indexable: false, row: { product_id: '7001', mall: '쿠팡', title: '테스트', lprice: 1000, link: url } }, []);
    const hasBtn = /id="affiliateLink"/.test(html);
    ok(allow ? hasBtn && html.includes(url.replace(/&/g, '&amp;')) : !hasBtn && /판매처 링크 없음/.test(html), `★ /p/ — ${allow ? '구매 버튼' : '판매처 링크 없음'}: ${name}`);
  });
  ok(page.isIndexableProduct({ product_id: '7001', mall: '쿠팡', title: '테스트', lprice: 10000, link: FORMS[6][1], collected_at: new Date().toISOString() }, 30) === false,
    '추적 없는 링크만 가진 상품은 색인하지 않는다');

  section('4) 배선 — 구매 링크를 내보내는 서버 파일은 전부 관문을 쓴다');
  const wired = {
    'api/_shop.js': /safeBuyLink\(p\.link, p\)/,
    'api/search.js': /res\.json\(sanitizeItemLinks\(ranked\)\)/,
    'api/hotdeals.js': /firstSafeBuyLink\(\[card\.dealUrl, product && product\.link, card\.historyLink\], card\)/,
    'api/ai.js': /link: require\('\.\/_affiliate'\)\.safeBuyLink\(it && it\.link, it\)/,
    'api/_aicontext.js': /safeBuyLink\(row\.link, row\)/,
    'api/init.js': /link: safeBuyLink\(p\.link,/,
    'api/_radarapi.js': /url: p \? safeBuyLink\(p\.link, p\) : ''/,
    'api/_product-page.js': /const link = safeBuyLink\(product\.link, product\)/,
    'api/_seo-pages.js': /safeBuyLink\(r\.link, r\)/,
    'api/alerts.js': /link: safeBuyLink\(a\.link\)/,
    'scripts/check-alerts.js': /firstSafeBuyLink\(\[alert\.link, todayRow\.link\]/
  };
  Object.entries(wired).forEach(([f, re]) => ok(re.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), `${f} — 공통 관문을 지난다`));
  const radarJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'radar.js'), 'utf8');
  ok(/var buy = buyUrl\(d\.url, d\) \|\| buyUrl\(saved && saved\.link, saved\);/.test(radarJs), 'public/radar.js — 저장된 옛 링크도 관문을 지난다');

  console.log(`\n${'='.repeat(58)}`);
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail) { console.log('\n실패한 항목:'); failures.forEach(f => console.log(`  · ${f}`)); process.exit(1); }
  console.log('구매 링크 무결성(서버) 이상 없음.');
})().catch(e => { console.error(e); process.exit(1); });
