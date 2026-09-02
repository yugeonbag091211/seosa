#!/usr/bin/env node
/**
 * 상품 페이지 · 상품 JSON · 상품 사이트맵 — 완전 오프라인 (외부 호출 0회).
 *
 *   node scripts/test-product-page.js
 *
 * ── 무엇을 지키는가 ────────────────────────────────────────────
 *   ① /p/{id} 가 실제 DB 값으로 HTML 을 그린다 — 판매자 문자열은 전부 이스케이프
 *   ② 기록이 INDEX_MIN_DAYS 미만이거나 stale·링크 없음이면 noindex (저품질 페이지 금지)
 *   ③ 없는 상품은 404, 이상한 식별자는 400/404
 *   ④ 사이트맵은 색인 가능한 상품만 담는다
 *   ⑤ Product/Offer 구조화 데이터를 넣지 않는다 (SEOSA 는 판매자가 아니다)
 *
 * ── 안전성 ───────────────────────────────────────────────────────
 * 운영 Supabase 0회. 가짜 Supabase 가 products / price_history 를 흉내 낸다.
 */
'use strict';

const path = require('path');
const Module = require('module');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

/* ── 가짜 Supabase — 필요한 연산자만 ─────────────────────────── */
const db = { products: [], price_history: [] };
function reset() { db.products = []; db.price_history = []; }

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const fakeSupabase = {
  from(table) {
    const filters = [];
    let orderBy = null, limitN = null, rangeFrom = null, rangeTo = null;
    const q = {
      select() { return q; },
      eq(c, v) { filters.push(r => String(r[c]) === String(v)); return q; },
      neq(c, v) { filters.push(r => String(r[c]) !== String(v)); return q; },
      gte(c, v) { filters.push(r => cmp(r[c], v) >= 0); return q; },
      gt(c, v) { filters.push(r => cmp(r[c], v) > 0); return q; },
      lt(c, v) { filters.push(r => cmp(r[c], v) < 0); return q; },
      in(c, vs) { filters.push(r => vs.map(String).indexOf(String(r[c])) > -1); return q; },
      order(c, o) { orderBy = { c, asc: !o || o.ascending !== false }; return q; },
      limit(n) { limitN = n; return q; },
      range(a, b) { rangeFrom = a; rangeTo = b; return q; },
      then(resolve, reject) {
        try {
          let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
          if (orderBy) rows = rows.slice().sort((a, b) => (orderBy.asc ? 1 : -1) * cmp(a[orderBy.c], b[orderBy.c]));
          if (rangeFrom != null) rows = rows.slice(rangeFrom, rangeTo + 1);
          if (limitN != null) rows = rows.slice(0, limitN);
          resolve({ data: rows.map(r => Object.assign({}, r)), error: null });
        } catch (e) { resolve({ data: null, error: { message: e.message } }); }
      }
    };
    return q;
  },
  rpc() { return Promise.resolve({ data: null, error: { message: 'rpc not in fake' } }); }
};

const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request, parent) {
  if (request === './_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};
global.fetch = async (url) => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

const trust = require('../api/_trust');
trust.attachTrust = async list => { (list || []).forEach(it => { if (it) it.trust = { level: 'high', label: '신뢰 높음', summary: '오늘 확인됨', reasons: [] }; }); return list; };

const history = require('../api/history.js');
const page = require('../api/_product-page.js');
const { INDEX_MIN_DAYS } = page._internal;

/* ── 도구 ───────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

function call(query) {
  return new Promise((resolve, reject) => {
    let code = 200; const headers = {};
    const res = {
      status(c) { code = c; return this; },
      setHeader(k, v) { headers[k.toLowerCase()] = v; return this; },
      json(payload) { resolve({ status: code, headers, body: payload, text: '' }); return this; },
      end(text) { resolve({ status: code, headers, body: null, text: String(text || '') }); return this; }
    };
    Promise.resolve(history({ method: 'GET', headers: {}, query, socket: { remoteAddress: '10.0.0.1' } }, res)).catch(reject);
  });
}

const nowIso = new Date().toISOString();
const daysAgoIso = n => new Date(Date.now() - n * 86400000).toISOString();
const kst = n => new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);

function seed() {
  reset();
  db.products.push(
    { id: 1, product_id: '1001', mall: '쿠팡', keyword: '무선 이어폰', title: 'QCY T13 무선 이어폰 <script>alert("x")</script>', lprice: 29900, oprice: 39900, save_pct: 25, link: 'https://link.coupang.com/a/1001', image: 'https://img.example/1.jpg', collected_at: nowIso, item_id: '', vendor_item_id: '555' },
    // 제목에 검색어 토큰이 있어야 relevantRows 를 통과한다 (실제 저장 규칙과 같다).
    { id: 2, product_id: '1002', mall: '쿠팡', keyword: '무선 이어폰', title: '소니 WF-1000XM5 무선 이어폰', lprice: 289000, oprice: 359000, save_pct: 19, link: 'https://link.coupang.com/a/1002', image: '', collected_at: nowIso, item_id: '', vendor_item_id: '' },
    { id: 3, product_id: '1003', mall: '쿠팡', keyword: '무선 이어폰', title: '브리츠 BZ-TWS6 이어폰 (기록 짧음)', lprice: 19900, oprice: 19900, save_pct: 0, link: 'https://link.coupang.com/a/1003', image: '', collected_at: nowIso, item_id: '', vendor_item_id: '' },
    { id: 4, product_id: '1004', mall: '쿠팡', keyword: '무선 이어폰', title: '오래된 이어폰', lprice: 9900, oprice: 9900, save_pct: 0, link: 'https://link.coupang.com/a/1004', image: '', collected_at: daysAgoIso(40), item_id: '', vendor_item_id: '' },
    { id: 5, product_id: '1005', mall: '쿠팡', keyword: '무선 이어폰', title: '링크 없는 이어폰', lprice: 9900, oprice: 9900, save_pct: 0, link: '', image: '', collected_at: nowIso, item_id: '', vendor_item_id: '' },
    { id: 6, product_id: 'a3f9c2', mall: 'ADPICK', mall_label: '알리', keyword: '무선 이어폰', title: '알리 이어폰', lprice: 12000, oprice: 12000, save_pct: 0, link: 'https://adpick.example/x', image: '', collected_at: nowIso, item_id: '', vendor_item_id: '' }
  );
  let id = 1;
  const series = (pid, mall, n, base) => {
    for (let i = 0; i < n; i++) {
      db.price_history.push({ id: id++, product_id: pid, mall, vendor_item_id: '', price: base + (i % 3) * 500,
        recorded_date: kst(n - 1 - i), recorded_at: daysAgoIso(n - 1 - i) });
    }
  };
  series('1001', '쿠팡', 20, 29900);
  series('1002', '쿠팡', 12, 289000);
  series('1003', '쿠팡', 3, 19900);
  series('1004', '쿠팡', 30, 9900);
  series('1005', '쿠팡', 20, 9900);
  series('a3f9c2', 'ADPICK', 9, 12000);
}

(async () => {
  console.log('=== 상품 페이지 · JSON · 사이트맵 (외부 호출 0회) ===');
  seed();

  section('1. __route=product (JSON)');
  {
    const r = await call({ __route: 'product', pid: '1001' });
    ok(r.status === 200, '200', String(r.status));
    ok(r.body && r.body.product && r.body.product.productId === '1001', 'product.productId');
    ok(r.body.product.mall === '쿠팡' && r.body.product.lprice === 29900, 'toClientProduct 모양');
    ok(Array.isArray(r.body.points) && r.body.points.length === 20, '가격 점 20일', String(r.body.points && r.body.points.length));
    ok(r.body.deal && typeof r.body.deal.verdict === 'string', '판정이 실린다', r.body.deal && r.body.deal.verdict);
    ok(r.body.indexable === true, '색인 가능');
    ok(/max-age=0, s-maxage=300/.test(r.headers['cache-control'] || ''), 'Edge 캐시 300초');
    const nf = await call({ __route: 'product', pid: '9999' });
    ok(nf.status === 404, '없는 상품 → 404', String(nf.status));
    const bad = await call({ __route: 'product', pid: '<img src=x>' });
    ok(bad.status === 400, '이상한 식별자 → 400', String(bad.status));
    const ad = await call({ __route: 'product', pid: 'a3f9c2' });
    ok(ad.status === 200 && ad.body.product.mallLabel === '알리', 'ADPICK 은 표시 이름(알리)이 실린다', ad.body && ad.body.product && ad.body.product.mallLabel);
  }

  section('2. __route=page (HTML)');
  {
    const r = await call({ __route: 'page', pid: '1001' });
    ok(r.status === 200, '200', String(r.status));
    ok(/^text\/html/.test(r.headers['content-type'] || ''), 'text/html');
    ok(r.text.indexOf('<script>alert("x")</script>') === -1, '★ 상품명의 스크립트가 실행 가능한 형태로 남지 않는다');
    ok(r.text.indexOf('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;') > -1, '이스케이프된 상품명이 있다');
    ok(/<meta name="robots" content="index,follow">/.test(r.text), '기록 20일 + live + 링크 → index');
    ok(!r.headers['x-robots-tag'], 'X-Robots-Tag 없음(색인 가능)');
    ok(/rel="canonical" href="https:\/\/seosa\.ai\.kr\/p\/1001"/.test(r.text), 'canonical /p/1001');
    ok(/29,900/.test(r.text), '현재가 29,900 이 본문에 있다');
    ok(/기록<\/span><b>20일/.test(r.text), '기록 일수 20일');
    ok(/BreadcrumbList/.test(r.text) && /"WebPage"/.test(r.text), 'BreadcrumbList + WebPage JSON-LD');
    ok(!/"@type":"Product"/.test(r.text) && !/"Offer"/.test(r.text), '★ Product/Offer 구조화 데이터를 넣지 않는다');
    ok(/rel="nofollow sponsored noopener"/.test(r.text), '제휴 링크는 nofollow sponsored');
    ok(/href="\/\?p=1001"/.test(r.text), '앱 딥링크 ?p=1001');
    ok(/<svg/.test(r.text), '스파크라인 SVG');
    ok(/href="\/p\/1002"/.test(r.text) && /href="\/p\/1003"/.test(r.text), '같은 검색어의 다른 상품(내부 링크)');
    ok(!/href="\/p\/1005"/.test(r.text), '링크 없는 상품은 내부 링크에서 뺀다');
    ok(/max-age=0, s-maxage=3600/.test(r.headers['cache-control'] || ''), 'Edge 캐시 1시간');
    ok(r.text.indexOf('배송비·쿠폰') > -1, '배송비·쿠폰 미포함 고지');
  }
  {
    const r = await call({ __route: 'page', pid: '1003' });
    ok(r.status === 200 && /content="noindex,follow"/.test(r.text), `★ 기록 ${INDEX_MIN_DAYS}일 미만 → noindex (저품질 페이지 금지)`);
    ok(r.headers['x-robots-tag'] === 'noindex', 'X-Robots-Tag: noindex 헤더');
    const s = await call({ __route: 'page', pid: '1004' });
    ok(s.status === 200 && /content="noindex,follow"/.test(s.text), 'stale(40일 미확인) → noindex');
    const n = await call({ __route: 'page', pid: '1005' });
    ok(n.status === 200 && /content="noindex,follow"/.test(n.text) && /판매처 링크 없음/.test(n.text), '링크 없음 → noindex + 구매 버튼 비활성');
    const nf = await call({ __route: 'page', pid: '9999' });
    ok(nf.status === 404 && /찾을 수 없어요/.test(nf.text) && /noindex/.test(nf.text), '없는 상품 → 404 HTML noindex', String(nf.status));
    const bad = await call({ __route: 'page', pid: '../../etc' });
    ok(bad.status === 404, '이상한 식별자 → 404', String(bad.status));
    const ad = await call({ __route: 'page', pid: 'a3f9c2' });
    ok(ad.status === 200 && /알리에서 보기/.test(ad.text), 'ADPICK 상품은 표시 몰 이름으로 버튼을 만든다');
  }

  section('3. __route=sitemap (XML)');
  {
    const r = await call({ __route: 'sitemap' });
    ok(r.status === 200 && /^application\/xml/.test(r.headers['content-type'] || ''), '200 application/xml');
    ok(/<urlset/.test(r.text) && /<\/urlset>/.test(r.text), 'urlset');
    ok(/<loc>https:\/\/seosa\.ai\.kr\/p\/1001<\/loc>/.test(r.text), '1001 (20일·live·링크) 포함');
    ok(/\/p\/1002<\/loc>/.test(r.text), '1002 (12일) 포함');
    ok(/\/p\/a3f9c2<\/loc>/.test(r.text), 'ADPICK 9일 포함');
    ok(!/\/p\/1003<\/loc>/.test(r.text), `★ 기록 ${INDEX_MIN_DAYS}일 미만 제외`);
    ok(!/\/p\/1004<\/loc>/.test(r.text), '★ stale 제외');
    ok(!/\/p\/1005<\/loc>/.test(r.text), '★ 링크 없음 제외');
    ok(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(r.text), 'lastmod');
    ok(/s-maxage=43200/.test(r.headers['cache-control'] || ''), 'Edge 캐시 12시간');
  }

  section('4. 기존 라우트는 그대로');
  {
    const r = await call({ productId: '1001', mall: '쿠팡' });
    ok(r.status === 200 && Array.isArray(r.body) && r.body.length === 20, '단건 이력 조회(배열) 그대로', String(r.body && r.body.length));
    const b = await call({ __route: 'batch', keys: JSON.stringify(['1001|쿠팡']), titles: '[]' });
    ok(b.status === 200 && b.body && Array.isArray(b.body['1001|쿠팡']), '배치 조회 그대로');
  }

  section('5. 순수 함수');
  {
    const P = page._internal;
    ok(P.esc('<a href="x">&\'') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;', 'esc');
    ok(P.safeUrl('javascript:alert(1)') === '' && P.safeUrl('https://a.b/c') === 'https://a.b/c', 'safeUrl 은 http(s)만');
    ok(P.cleanPid('1001') === '1001' && P.cleanPid('A3F9') === 'A3F9' && P.cleanPid('1001; drop') === '' && P.cleanPid('') === '', 'cleanPid');
    ok(P.sparkSvg([{ price: 1 }]) === '' && P.sparkSvg([{ price: 5 }, { price: 5 }]) === '', '점이 부족하거나 평탄하면 그래프 없음');
    ok(/<svg/.test(P.sparkSvg([{ price: 1 }, { price: 2 }, { price: 3 }])), '움직임이 있으면 그린다');
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) { console.log('실패: ' + failures.join(' | ')); process.exit(1); }
})().catch(e => { console.error('오류:', e && e.stack || e); process.exit(1); });
