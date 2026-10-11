#!/usr/bin/env node
/**
 * 기술 SEO 회귀 — 완전 오프라인 (외부 호출 0회).
 *
 *   node scripts/test-seo.js
 *
 * ── 무엇을 지키는가 ────────────────────────────────────────────
 *   1. 공용 도구(api/_seo.js) — JSON-LD XSS, 가격 요약 숫자·문장, title/description,
 *      Offer/AggregateOffer, 이미지 수명, 레지스트리 무결성, 사이트맵 XML
 *   2. 상품 페이지 — title · canonical · description · Product JSON-LD · Breadcrumb ·
 *      가격 요약 텍스트 · 내부 링크 · 가격 없음 처리 · 중복 canonical
 *   3. 카테고리 · 브랜드 · 허브 — 본품만, 문턱 미만 noindex, 없는 주소 404
 *   4. 사이트맵 — 인덱스/파일, DB 함수가 없을 때 폴백, 사이트맵 URL 은 전부 index
 *   5. 정적 파일 — robots.txt · index.html H1 · 검색 URL noindex · vercel.json 라우팅
 *
 * ── 안전성 ───────────────────────────────────────────────────────
 * 운영 Supabase 0회. 가짜 Supabase 가 products / price_history / rpc 를 흉내 낸다.
 * 날짜는 전부 «오늘 기준 상대값» 이다 (고정 날짜는 시한폭탄 — 롤링 KST 창).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.GOOGLE_SITE_VERIFICATION;
delete process.env.NAVER_SITE_VERIFICATION;

const ROOT = path.resolve(__dirname, '..');

/* ── 가짜 Supabase ─────────────────────────────────────────────── */
const db = { products: [], price_history: [] };
let rpcImpl = null;           // null 이면 «함수 없음»(PGRST202)
let dbDown = false;           // true 면 products 조회가 statement timeout 으로 실패한다
const calls = [];

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function likeRe(pattern, ci) {
  const src = String(pattern).split('').map(ch => (ch === '%' || ch === '*') ? '.*' : ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${src}$`, ci ? 'is' : 's');
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
      ilike(c, p) { const re = likeRe(p, true); filters.push(r => re.test(String(r[c] || ''))); return q; },
      or(expr) {
        const conds = String(expr).split(',').map(part => {
          const m = /^([a-z_]+)\.(ilike|like|eq)\.(.*)$/.exec(part);
          if (!m) throw new Error(`fake or: ${part}`);
          const re = m[2] === 'eq' ? null : likeRe(m[3], m[2] === 'ilike');
          return r => (re ? re.test(String(r[m[1]] || '')) : String(r[m[1]]) === m[3]);
        });
        filters.push(r => conds.some(f => f(r)));
        return q;
      },
      order(c, o) { orderBy = { c, asc: !o || o.ascending !== false }; return q; },
      limit(n) { limitN = n; return q; },
      range(a, b) { rangeFrom = a; rangeTo = b; return q; },
      then(resolve) {
        calls.push(table);
        if (dbDown && table === 'products') { resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }); return; }
        try {
          let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
          const total = rows.length;   // PostgREST count 는 range 를 자르기 «전» 행 수다
          if (orderBy) rows = rows.slice().sort((a, b) => (orderBy.asc ? 1 : -1) * cmp(a[orderBy.c], b[orderBy.c]));
          if (rangeFrom != null) rows = rows.slice(rangeFrom, rangeTo + 1);
          if (limitN != null) rows = rows.slice(0, limitN);
          // PostgREST db-max-rows — 한 응답은 1,000행을 넘지 않는다.
          rows = rows.slice(0, 1000);
          resolve({ data: rows.map(r => Object.assign({}, r)), error: null, count: total });
        } catch (e) { resolve({ data: null, error: { message: e.message } }); }
      }
    };
    return q;
  },
  rpc(name, params) {
    calls.push(`rpc:${name}`);
    if (!rpcImpl) {
      return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}(p_id_from, p_id_to) in the schema cache` } });
    }
    return Promise.resolve(rpcImpl(name, params));
  }
};

const supabasePath = path.resolve(ROOT, 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request, parent) {
  if (request === './_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};
global.fetch = async (url) => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

const trust = require('../api/_trust');
trust.attachTrust = async list => list;
// 목록 필터가 남기는 운영 로그는 이 테스트의 관심사가 아니다.
const realLog = console.log;
console.log = (...a) => { if (!/^\[(rec|display)\]/.test(String(a[0]))) realLog(...a); };

const SEO = require('../api/_seo');
const history = require('../api/history.js');
const pages = require('../api/_seo-pages');
const productPage = require('../api/_product-page');
const { statsFrom } = require('../api/_pricestat');
const { kstToday } = require('../api/_price');

/* ── 도구 ───────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; realLog(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; failures.push(name); realLog(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { realLog(`\n── ${t} ──`); }

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

/** <script type="application/ld+json"> 를 전부 파싱해 @graph 노드 목록으로. */
function ldNodes(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
  return [].concat(...blocks.map(b => b['@graph'] || [b]));
}
function locs(xml) { return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&')); }
/** 사이트맵 XML 이 최소한의 형식을 갖췄는가 — 선언 · 네임스페이스 · 태그 짝 · 맨 & 없음. */
function wellFormed(xml, root) {
  if (!/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/.test(xml)) return 'xml 선언 없음';
  if (xml.indexOf(`<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`) < 0) return '네임스페이스 없음';
  if (!xml.trim().endsWith(`</${root}>`)) return '닫는 태그 없음';
  if (/&(?!(amp|lt|gt|quot|#39);)/.test(xml)) return '이스케이프 안 된 &';
  const open = (xml.match(/<loc>/g) || []).length, close = (xml.match(/<\/loc>/g) || []).length;
  if (open !== close) return 'loc 짝 불일치';
  return '';
}

const nowIso = new Date().toISOString();
const daysAgoIso = n => new Date(Date.now() - n * 86400000).toISOString();
const kst = n => kstToday(Date.now() - n * 86400000);

let nextId = 1;
function product(o) {
  return Object.assign({ id: o.id || nextId++, mall: '쿠팡', mall_label: '', lprice: 10000, oprice: 0, save_pct: 0,
    link: `https://link.coupang.com/a/${o.product_id}`, image: `https://ads-partners.coupang.com/image1/${o.product_id}.jpg`,
    collected_at: nowIso, item_id: '', vendor_item_id: '' }, o);
}
let hid = 1;
/** prices[0] 이 가장 오래된 날 — 마지막 값이 오늘. */
function series(pid, prices, opts) {
  const o = opts || {};
  prices.forEach((price, i) => {
    const ago = (o.endAgo || 0) + (prices.length - 1 - i);
    db.price_history.push({ id: hid++, product_id: pid, mall: o.mall || '쿠팡', vendor_item_id: o.vid || '', price,
      recorded_date: kst(ago), recorded_at: daysAgoIso(ago) });
  });
}

function seed() {
  db.products = []; db.price_history = []; nextId = 1; hid = 1;
  // 노트북 카테고리 — 본품 9개(색인 문턱 8 이상) + 부속 1 + 무관 1 + stale 1
  const laptops = [
    ['2001', 'LG전자 2026 그램 16 노트북 코어Ultra5 16Z90T, 에센스 화이트, 512GB', 1429000],
    ['2002', '삼성전자 갤럭시북5 프로 14 노트북 NT940XHA', 1590000],
    ['2003', 'Apple 2025 맥북 에어 13 M4 노트북', 1390000],
    ['2004', 'HP 2025 노트북 15 코어i5 사무용', 690000],
    ['2005', '레노버 아이디어패드 슬림3 노트북 15인치', 599000],
    ['2006', '에이수스 비보북 16 노트북 라이젠5', 649000],
    ['2007', '한성컴퓨터 TFG5076 게이밍 노트북', 1190000],
    ['2008', '주연테크 리오나인 노트북 14인치 학생용', 459000],
    ['2009', 'MSI 모던 15 노트북 사무용 코어i5', 729000]
  ];
  laptops.forEach(([pid, title, lprice]) => db.products.push(product({ product_id: pid, keyword: '노트북', title, lprice })));
  db.products.push(product({ product_id: '2010', keyword: '노트북', title: '노트북 파우치 15.6인치 방수 노트북 가방', lprice: 9900 }));
  db.products.push(product({ product_id: '2011', keyword: '노트북', title: '펩시 제로슈거 라임 355ml 24캔', lprice: 15900 }));
  db.products.push(product({ product_id: '2012', keyword: '노트북', title: '오래된 노트북 재고', lprice: 300000, collected_at: daysAgoIso(40) }));
  // 관련성·부속 낱말을 통과하지만 본품이 아닌 행 (운영 실측 그대로) — 값이 중앙값의 20% 미만
  db.products.push(product({ product_id: '2013', keyword: '노트북', title: '[해외] 레노버 LOQ 15IRX9 노트북 키보드 키캡용 싱글 키 힌지 고무', lprice: 7520 }));
  // 그램: 20일 기록, 어제 1,460,000 → 오늘 1,429,000
  series('2001', [1490000, 1490000, 1480000, 1480000, 1470000, 1470000, 1490000, 1500000, 1500000, 1490000,
    1480000, 1480000, 1470000, 1470000, 1460000, 1460000, 1450000, 1460000, 1460000, 1429000]);
  series('2002', [1590000, 1590000, 1590000]);
  // 노트북 목록 색인 문턱 ②(색인 상품 ≥ 3) — 그램(20일) 외에 7일 기록 둘
  series('2003', Array(7).fill(1390000));
  series('2004', Array(7).fill(690000));
  // 노트북 키워드로 모인 «부속» — 부속 낱말(어댑터·충전기) / 부속 낱말 없이 값만 동떨어진 것(핀 어댑터)
  db.products.push(product({ product_id: '2014', keyword: '노트북', title: 'LG 그램 전용 어댑터 19V 65W 노트북 충전기', lprice: 29000 }));
  db.products.push(product({ product_id: '2015', keyword: '노트북', title: 'LG 그램 노트북 핀 타입 19V 이우 2.53A 48 엘지전자', lprice: 27500 }));
  series('2014', Array(7).fill(29000));
  series('2015', Array(7).fill(27500));
  // 레지스트리 카테고리 밖의 부속 · 호환품 · 본품
  db.products.push(product({ product_id: '2016', keyword: '닌텐도 스위치 필름', title: '닌텐도 스위치 OLED 전용 필름', lprice: 9900 }));
  db.products.push(product({ product_id: '2017', keyword: '아이폰 케이스', title: '애플 호환 케이스 아이폰 16 투명', lprice: 12000 }));
  db.products.push(product({ product_id: '2018', keyword: '닌텐도 스위치', title: '닌텐도 스위치 2 본체 마리오 카트 세트', lprice: 640000 }));
  series('2016', Array(7).fill(9900));
  series('2017', Array(7).fill(12000));
  series('2018', Array(7).fill(640000));
  // 모니터 카테고리 — 본품 3개뿐 (문턱 미만 → noindex)
  ['3001', '3002', '3003'].forEach((pid, i) => db.products.push(product({ product_id: pid, keyword: '게이밍 모니터', title: `${['LG', '삼성', '델'][i]} 게이밍 모니터 27인치 QHD`, lprice: 300000 + i * 10000 })));
  // 브랜드 함정 — LG 가 첫 낱말이지만 다른 회사 · 호환품 · 몰 이름 머리
  db.products.push(product({ product_id: '4001', keyword: '샴푸', title: 'LG생활건강 엘라스틴 샴푸 1L', lprice: 12000 }));
  db.products.push(product({ product_id: '4002', keyword: '리모컨', title: 'LG 호환 TV 리모컨 만능', lprice: 8000 }));
  db.products.push(product({ product_id: '4003', keyword: '세탁기', title: '[보리보리] LG전자 세탁기', lprice: 500000, mall: 'ADPICK', mall_label: '보리보리', link: 'https://biz.adpick.co.kr/r1', image: 'https://d2iaagr1j041pi.cloudfront.net/apis/search_img.php?code=1' }));
  ['4004', '4005', '4006', '4007', '4008', '4009', '4010'].forEach((pid, i) =>
    db.products.push(product({ product_id: pid, keyword: '세탁기', title: `LG전자 트롬 드럼세탁기 ${21 + i}kg 방문설치`, lprice: 900000 + i * 10000 })));
  // LG전자 브랜드 색인 문턱 ②: 그램(20일) + 세탁기 둘(7일) = 3
  series('4004', Array(7).fill(900000));
  series('4005', Array(7).fill(910000));
  db.products.push(product({ product_id: '4011', keyword: '냉장고', title: '[LG] [LG구독인증점]LG냉장고렌탈/구독 디오스 김치톡톡 327L', lprice: 1, mall: 'ADPICK', mall_label: '', link: 'https://biz.adpick.co.kr/r2', image: 'https://shop2.daumcdn.net/shophow/p/A1.jpg' }));
  series('4011', [1, 1, 1, 1, 1, 1, 1, 1], { mall: 'ADPICK' });
  // 가격 없는 상품 · XSS 제목
  db.products.push(product({ product_id: '5001', keyword: '노트북 거치대', title: '가격 없는 상품', lprice: 0 }));
  db.products.push(product({ product_id: '5002', keyword: '마우스', title: '마우스 </script><script>alert(1)</script> & "따옴표"', lprice: 19900 }));
  series('5002', [19900, 19900, 19900, 19900, 19900, 19900, 19900, 19900]);

  // 면도기 — 본품 8개지만 7일 기록 상품 2개 → noindex (문턱 ②)
  for (let n = 1; n <= 8; n++) db.products.push(product({ product_id: String(6000 + n), keyword: '면도기', title: `브라운 시리즈${n} 전기 면도기 습식 건식`, lprice: 89000 + n * 1000 }));
  series('6001', Array(7).fill(90000));
  series('6002', Array(7).fill(91000));
  // 전기포트 — 7개 전부 7일 기록 · 본품 7개 < 8 → noindex (문턱 ①)
  for (let n = 1; n <= 7; n++) {
    db.products.push(product({ product_id: String(6100 + n), keyword: '전기포트', title: `한일 무선 전기포트 1.${n}L 스테인리스`, lprice: 20000 + n * 1000 }));
    series(String(6100 + n), Array(7).fill(20000 + n * 1000));
  }
  // 필립스 — 브랜드 본품 8개 · 7일 기록 1개 → noindex
  for (let n = 1; n <= 8; n++) db.products.push(product({ product_id: String(6200 + n), keyword: '필립스 전동칫솔', title: `필립스 소닉케어 전동칫솔 HX${n}000`, lprice: 50000 + n * 1000 }));
  series('6201', Array(7).fill(51000));

  // 판매처 — ADPICK + 실제 몰 이름 / ADPICK + 몰 이름 없음
  db.products.push(product({ product_id: '7101', keyword: '러닝화', title: '하프클럽 테스트 러닝화 270', lprice: 59000, mall: 'ADPICK', mall_label: '하프클럽', link: 'https://biz.adpick.co.kr/r7101', image: 'https://shop2.daumcdn.net/shophow/p/R1.jpg' }));
  db.products.push(product({ product_id: '7102', keyword: '블루투스 스피커', title: '라벨 없는 제휴몰 블루투스 스피커', lprice: 39000, mall: 'ADPICK', mall_label: '', link: 'https://biz.adpick.co.kr/r7102', image: 'https://shop2.daumcdn.net/shophow/p/R2.jpg' }));
  series('7101', Array(7).fill(59000), { mall: 'ADPICK' });
  series('7102', Array(7).fill(39000), { mall: 'ADPICK' });

  // 구조화 데이터 신선도 — 마지막 관측이 0·1·3·4·10일 전 (전부 8일 기록 · live · index)
  [0, 1, 3, 4, 10].forEach(d => {
    const pid = String(7200 + d);
    db.products.push(product({ product_id: pid, keyword: '신선도 테스트', title: `구조화 데이터 신선도 ${d}일`, lprice: 10000 }));
    series(pid, Array(8).fill(10000), { endAgo: d });
  });

  // 7일 색인 경계 — 관측 6 · 7 · 8일
  [6, 7, 8].forEach(n => {
    const pid = String(7300 + n);
    db.products.push(product({ product_id: pid, keyword: '경계 테스트', title: `관측 ${n}일 경계 상품`, lprice: 15000 }));
    series(pid, Array(n).fill(15000));
  });

  // 옵션(vendor_item_id) — 다른 옵션의 8일은 세지 않는다 / 같은 옵션 8일 / 옵션 표시 없는 옛 행 8일
  db.products.push(product({ product_id: '8001', keyword: '옵션 테스트', title: '옵션 바뀐 상품', lprice: 30000, vendor_item_id: 'V1' }));
  series('8001', Array(8).fill(25000), { vid: 'V0', endAgo: 2 });
  series('8001', [30000, 30000], { vid: 'V1' });
  db.products.push(product({ product_id: '8002', keyword: '옵션 테스트', title: '옵션 그대로인 상품', lprice: 30000, vendor_item_id: 'V2' }));
  series('8002', Array(8).fill(30000), { vid: 'V2' });
  db.products.push(product({ product_id: '8003', keyword: '옵션 테스트', title: '옛 행만 있는 상품', lprice: 30000, vendor_item_id: 'V3' }));
  series('8003', Array(8).fill(30000), { vid: '' });

  // KST lastmod — UTC 16:00 수집 = KST 다음 날 01:00
  {
    const n = new Date();
    let t = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 16, 0, 0);
    if (t > Date.now()) t -= 86400000;
    KST_LASTMOD_AT = t;
    db.products.push(product({ product_id: '8101', keyword: '시간대 테스트', title: 'KST 날짜 상품', lprice: 10000, collected_at: new Date(t).toISOString() }));
    series('8101', Array(7).fill(10000));
  }
  pages._internal.resetMemo();
}
let KST_LASTMOD_AT = 0;

/* ══════════════════════════════════════════════════════════════════ */
(async () => {
  realLog('=== 기술 SEO 회귀 (외부 호출 0회) ===');

  section('1. JSON-LD 직렬화 — XSS');
  {
    const evil = { name: '</script><script>alert(1)</script> & <!-- ' + String.fromCharCode(0x2028, 0x2029) };
    const out = SEO.jsonLdScript(evil);
    const inner = out.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '');
    ok(inner.indexOf('<') < 0 && inner.indexOf('>') < 0 && inner.indexOf('&') < 0, '★ 본문에 < > & 가 날것으로 남지 않는다');
    ok((out.match(/<\/script>/g) || []).length === 1, '★ </script> 는 블록을 닫는 하나뿐');
    ok(JSON.parse(inner).name === evil.name, '파싱하면 원래 문자열 그대로');
    ok(!/[\u2028\u2029]/.test(out), 'U+2028/2029 도 이스케이프');
  }

  section('2. 가격 요약 — 결정론 · 실제 값만');
  {
    const now = Date.now();
    const pts = [];
    // 30일 전부터 매일: 100,000 · 마지막 3일 98,000 → 97,000 → 95,000(오늘)
    for (let i = 29; i >= 3; i--) pts.push({ date: kst(i), price: 100000 });
    pts.push({ date: kst(2), price: 98000 }, { date: kst(1), price: 97000 }, { date: kst(0), price: 95000 });
    const stat = statsFrom(pts);
    const s = SEO.priceSummary(pts, stat, { now });
    ok(s.current === 95000 && s.lastDate === kst(0), '현재가 = 마지막 관측');
    ok(s.prev && s.prev.label === '어제 대비' && s.prev.diff === -2000, '오늘·어제 연속이면 «어제 대비» -2,000', s.prev && `${s.prev.label} ${s.prev.diff}`);
    ok(s.window30.avg === stat.avg30, '★ 30일 평균은 statsFrom.avg30 과 같은 값 (같은 화면에 두 숫자가 없다)', `${s.window30.avg} / ${stat.avg30}`);
    ok(s.window30.low === 95000 && s.isLow30, '30일 최저 = 오늘 → isLow30');
    const expectPct = Math.round(((95000 - stat.avg30) / stat.avg30) * 1000) / 10;
    ok(s.vsAvg30Pct === expectPct && expectPct < 0, '30일 평균 대비 % (실제 계산과 같다)', `${s.vsAvg30Pct}%`);
    ok(s.sentences[0] === `현재 가격은 최근 30일 평균(${SEO.won(stat.avg30)}원)보다 ${Math.abs(expectPct)}% 낮습니다.`, '문장 1 — 30일 평균 대비', s.sentences[0]);
    ok(s.sentences.indexOf('어제보다 2,000원 내렸습니다.') > -1, '문장 — 어제보다 내렸다');

    const gap = [{ date: kst(5), price: 50000 }, { date: kst(2), price: 52000 }];
    const g = SEO.priceSummary(gap, statsFrom(gap), { now });
    ok(g.prev.label === `직전 관측(${kst(5).slice(5)}) 대비` && g.prev.diff === 2000, '★ 연속이 아니면 «어제» 라고 하지 않는다', g.prev.label);
    ok(g.vsAvg30Pct === null && !g.isLow30, '30일 관측이 3일 미만이면 평균 대비를 말하지 않는다');
    ok(g.sentences.indexOf(`직전 관측(${kst(5).slice(5)})보다 2,000원 올랐습니다.`) > -1, '문장 — 직전 관측보다 올랐다');

    const one = SEO.priceSummary([{ date: kst(0), price: 10000 }], null, { now });
    ok(one && !one.prev && !one.window7 && !one.window30 && one.sentences.length === 0, '기록 1일 → 비교 줄 없음 (지어내지 않는다)');
    ok(SEO.priceSummary([], null) === null && SEO.priceSummary([{ date: kst(0), price: 0 }], null) === null, '기록 없음·0원 → null');
  }

  section('2-1. 날짜 경계 — 7일 · 30일 창, KST 자정');
  {
    const now = Date.now();
    // 8일: 7일 전(창 밖) 10,000 → 오늘 80,000 — 창이 하루라도 밀리면 low/avg 가 바뀐다
    const eight = [10, 20, 30, 40, 50, 60, 70, 80].map((k, i) => ({ date: kst(7 - i), price: k * 1000 }));
    const s8 = SEO.priceSummary(eight, statsFrom(eight), { now });
    ok(s8.window7.count === 7 && s8.window7.low === 20000 && s8.window7.avg === 50000, '★ 7일 창 = 오늘 포함 7일 (7일 전 제외) · low 20,000 · avg 50,000', JSON.stringify(s8.window7));
    const six = eight.slice(2);   // 6일 관측
    const s6 = SEO.priceSummary(six, statsFrom(six), { now });
    ok(s6.window7.count === 6 && s6.window7.low === 30000 && s6.window7.avg === 55000, '관측 6일 → 6점 · low 30,000 · avg 55,000', JSON.stringify(s6.window7));
    const seven = eight.slice(1); // 7일 관측 (6일 전 ~ 오늘)
    const s7 = SEO.priceSummary(seven, statsFrom(seven), { now });
    ok(s7.window7.count === 7 && s7.window7.low === 20000, '관측 7일 → 7점 전부 창 안', JSON.stringify(s7.window7));
    // 31일: 30일 전(창 밖) 1,000 → 오늘 31,000
    const t31 = Array.from({ length: 31 }, (_, i) => ({ date: kst(30 - i), price: (i + 1) * 1000 }));
    const s31 = SEO.priceSummary(t31, statsFrom(t31), { now });
    const in30 = t31.slice(1).map(p => p.price);
    ok(s31.window30.count === 30 && s31.window30.low === 2000 && s31.window30.avg === Math.round(in30.reduce((a, b) => a + b, 0) / 30), '★ 30일 창 = 오늘 포함 30일 (30일 전 제외)', JSON.stringify(s31.window30));
    const s30 = SEO.priceSummary(t31.slice(1), statsFrom(t31.slice(1)), { now });
    ok(s30.window30.count === 30 && s30.window30.low === 2000, '관측 30일 → 30점 전부', String(s30.window30.count));
    const s29 = SEO.priceSummary(t31.slice(2), statsFrom(t31.slice(2)), { now });
    ok(s29.window30.count === 29 && s29.window30.low === 3000, '관측 29일 → 29점', String(s29.window30.count));

    // KST 자정 — UTC 전날 15:00 은 KST 00:00 (다음 날), UTC 전날 14:59 는 KST 23:59 (그날)
    const base = Date.UTC(2026, 9, 1, 15, 0, 0);   // KST 2026-10-02 00:00:00
    ok(kstToday(base) === '2026-10-02' && kstToday(base - 60000) === '2026-10-01', 'KST 00:00 = UTC 전날 15:00 · UTC 14:59 는 KST 전날 23:59');
    const atMid = SEO.priceSummary([{ date: '2026-10-01', price: 1000 }, { date: '2026-10-02', price: 900 }], null, { now: base + 30000 });
    ok(atMid.today === '2026-10-02' && atMid.prev.label === '어제 대비', 'KST 00:00:30 — 오늘은 10-02 · «어제 대비»', atMid.prev.label);
    const before = SEO.priceSummary([{ date: '2026-09-30', price: 1000 }, { date: '2026-10-01', price: 900 }], null, { now: base - 30000 });
    ok(before.today === '2026-10-01' && before.prev.label === '어제 대비', 'KST 23:59:30 — 오늘은 10-01', before.today);

    // 관측일 수 — KST 날짜로 센다 (UTC 날짜가 같아도 KST 로 다른 날이면 2일)
    const PP = productPage._internal;
    const iso = t => new Date(t).toISOString();
    const rows = [{ recorded_at: iso(base - 60000), vendor_item_id: '' }, { recorded_at: iso(base), vendor_item_id: '' }];
    ok(PP.observedDays(rows, '') === 2, '★ UTC 14:59 와 15:00 은 KST 로 다른 날 → 관측 2일');
    const same = [{ recorded_at: iso(base), vendor_item_id: '' }, { recorded_at: iso(base + 8 * 3600e3), vendor_item_id: '' }];
    ok(PP.observedDays(same, '') === 1, 'KST 같은 날 두 번 관측 → 1일');
    const mixed = [{ recorded_at: iso(base), vendor_item_id: 'A' }, { recorded_at: iso(base + 86400e3), vendor_item_id: 'B' }, { recorded_at: iso(base + 2 * 86400e3), vendor_item_id: 'B' }];
    ok(PP.observedDays(mixed, 'A') === 1 && PP.observedDays(mixed, 'B') === 2 && PP.observedDays(mixed, 'C') === 0, '★ 관측일은 현재 옵션(sameVendorRows)만 센다 — 다른 옵션의 날짜를 섞지 않는다');
    const live = { product_id: '1', mall: '쿠팡', lprice: 1000, link: 'https://x.y/z', collected_at: new Date().toISOString(), title: 'x' };
    ok(!PP.isIndexableProduct(live, 6) && PP.isIndexableProduct(live, 7) && PP.isIndexableProduct(live, 8), '★ 색인 문턱: 6일 ✗ · 7일 ✓ · 8일 ✓');
  }

  section('3. title · description · shortName');
  {
    ok(SEO.productTitle('LG전자 그램 16') === 'LG전자 그램 16 최저가·가격 추이 | SEOSA', '판매처 1곳 → «가격 추이»');
    ok(SEO.productTitle('LG전자 그램 16', { sellerCount: 2 }) === 'LG전자 그램 16 최저가·가격비교 | SEOSA', '판매처 2곳 이상일 때만 «가격비교»');
    const long = 'FURYCUBE G11 초경량 무선 게이밍 마우스 PAW3311 센서 메테오 볼캐노 다이내믹 RGB 3모드 연결 6단계 DPI 인체공학적 디자인';
    const sn = SEO.shortName(long);
    ok(sn.length <= SEO.TITLE_NAME_MAX && long.startsWith(sn) && !/\s$/.test(sn), '긴 제목은 낱말 경계에서 자른다', sn);
    ok(SEO.shortName('[무료배송] [당일발송] 로지텍 G102, 블랙, 1개') === '로지텍 G102 블랙 1개', '판촉 머리표만 빼고 옵션은 남긴다');
    ok(SEO.shortName('팝콘&amp;나쵸 세트') === '팝콘&나쵸 세트', 'DB 에 엔티티째 저장된 제목을 푼다');
    const pts = [{ date: kst(4), price: 1500000 }, { date: kst(3), price: 1480000 }, { date: kst(1), price: 1460000 }, { date: kst(0), price: 1429000 }];
    const d = SEO.productDescription({ title: 'LG전자 그램 16', price: 1429000, mall: '쿠팡', lastDate: kst(0), summary: SEO.priceSummary(pts, statsFrom(pts)) });
    ok(/1,429,000원/.test(d) && /최근 30일 최저 1,429,000원/.test(d) && d.length <= 160, 'description: 현재가 · 30일 최저 · 160자 안', d);
    const d0 = SEO.productDescription({ title: '가격 없는 상품', price: 0, mall: '쿠팡', lastDate: '', summary: null });
    ok(!/\d원/.test(d0), '★ 가격이 없으면 금액을 쓰지 않는다', d0);
    const d2 = SEO.productDescription({ title: '다른 상품', price: 9900, mall: '쿠팡', lastDate: kst(0), summary: null });
    ok(d2 !== d, '상품마다 description 이 다르다');
  }

  section('4. Offer / AggregateOffer / Product');
  {
    const one = SEO.offersJsonLd([{ price: 29900, seller: '쿠팡' }]);
    ok(one['@type'] === 'Offer' && one.price === 29900 && one.priceCurrency === 'KRW' && one.seller.name === '쿠팡', '판매처 1곳 → Offer');
    const agg = SEO.offersJsonLd([{ price: 31000 }, { price: 29900 }, { price: 30500 }]);
    ok(agg['@type'] === 'AggregateOffer' && agg.lowPrice === 29900 && agg.highPrice === 31000 && agg.offerCount === 3, '2곳 이상 → AggregateOffer(low/high/count)');
    ok(SEO.offersJsonLd([]) === null && SEO.offersJsonLd([{ price: 0 }]) === null, '가격 없으면 오퍼 없음');
    ok(!('availability' in one) && !('availability' in agg), '★ 재고 상태를 지어내지 않는다');
    ok(SEO.productJsonLd({ name: 'x', url: 'https://seosa.ai.kr/p/1', offers: [] }) === null, '★ 오퍼가 없으면 Product 도 없다 (제품 스니펫 필수 조건)');
    const p = SEO.productJsonLd({ name: 'x', url: 'https://seosa.ai.kr/p/1', offers: [{ price: 1000 }], image: '', brand: undefined, sku: undefined });
    ok(p && !('aggregateRating' in p) && !('review' in p) && !('image' in p) && !('brand' in p), '빈 값은 싣지 않는다 · 평점/리뷰 없음');
    const bc = SEO.breadcrumbJsonLd([{ name: '홈', url: 'https://seosa.ai.kr/' }, { name: '노트북', url: 'https://seosa.ai.kr/category/laptop' }]);
    ok(bc.itemListElement.map(i => i.position).join() === '1,2', 'BreadcrumbList position 1..n');
  }

  section('5. 이미지 · 검증 메타');
  {
    ok(!SEO.isDurableImage('https://d2iaagr1j041pi.cloudfront.net/apis/search_img.php?code=487542438'), '★ ADPICK 임시 토큰 이미지는 밖으로 내지 않는다');
    ok(SEO.isDurableImage('https://ads-partners.coupang.com/image1/abc.jpg') && SEO.isDurableImage('https://shop2.daumcdn.net/shophow/p/V1.jpg'), '쿠팡·다음 CDN 이미지는 낸다');
    ok(!SEO.isDurableImage('http://a.b/c.jpg') && !SEO.isDurableImage('javascript:alert(1)'), 'https 가 아니면 내지 않는다');
    ok(SEO.verificationMeta({}) === '', '환경변수가 없으면 확인 메타를 만들지 않는다');
    const vm = SEO.verificationMeta({ GOOGLE_SITE_VERIFICATION: 'abc_DEF-1', NAVER_SITE_VERIFICATION: 'x"><script>' });
    ok(/google-site-verification" content="abc_DEF-1"/.test(vm) && /naver-site-verification" content="xscript"/.test(vm) && !/<script>/.test(vm), '환경변수 값만 · 특수문자는 지운다');
  }

  section('5-1. 렌탈·명목가 — 구매 가격이 아니다');
  {
    const np = SEO.isNonPurchaseListing;
    ok(np({ title: '[LG구독인증점]LG냉장고렌탈/구독 디오스 327L', lprice: 1 }) && np({ title: '[렌탈] LG 휘센 에어컨 렌탈 60개월', lprice: 58900 }), '★ 렌탈·구독 월 요금은 구매 가격이 아니다');
    ok(np({ title: '창안애 블라인드', lprice: 95 }) && np({ title: 'x', lprice: 0 }), '★ 100원 미만 명목가는 구매 가격이 아니다');
    ok(!np({ title: 'LG전자 그램 16', lprice: 1429000 }) && !np({ title: '로지텍 마우스', lprice: 100 }), '보통 상품은 그대로');
  }

  section('6. 레지스트리 무결성');
  {
    const slugs = SEO.CATEGORIES.map(c => c.slug).concat(SEO.BRANDS.map(b => b.slug));
    ok(SEO.CATEGORIES.every(c => /^[a-z0-9-]{1,40}$/.test(c.slug)) && SEO.BRANDS.every(b => /^[a-z0-9-]{1,40}$/.test(b.slug)), 'slug 는 영문 소문자·숫자·하이픈');
    ok(new Set(SEO.CATEGORIES.map(c => c.slug)).size === SEO.CATEGORIES.length && new Set(SEO.BRANDS.map(b => b.slug)).size === SEO.BRANDS.length, 'slug 중복 없음', `${slugs.length}개`);
    const kws = [].concat(...SEO.CATEGORIES.map(c => c.keywords));
    ok(new Set(kws).size === kws.length, '★ 검색어 하나는 카테고리 하나에만 (같은 상품이 두 카테고리의 원본이 되지 않는다)');
    // 대소문자 표기만 다른 별칭(SONY · Sony)은 같은 브랜드 안에서만 허용된다.
    const owner = new Map();
    let clash = '';
    SEO.BRANDS.forEach(b => b.aliases.forEach(a => {
      const k = a.toLowerCase();
      if (owner.has(k) && owner.get(k) !== b.slug) clash = `${a}: ${owner.get(k)} / ${b.slug}`;
      owner.set(k, b.slug);
    }));
    ok(!clash, '★ 별칭 하나가 두 브랜드에 걸치지 않는다', clash);
    const pre = pages._internal.brandPrefixes(SEO.BRANDS);
    ok(pre.indexOf('LG') > -1 && pre.indexOf('LG전자') < 0 && pre.indexOf('[LG') > -1 && pre.indexOf('SONY') > -1 && pre.indexOf('Sony') > -1,
      'DB 접두: 포함되는 별칭은 빼고 · 대괄호 머리도 찾고 · 대소문자 표기는 따로', `${pre.length}개`);
    ok([].concat(...SEO.BRANDS.map(b => b.aliases)).every(a => /^[0-9A-Za-z가-힣-]+$/.test(a)), '★ 별칭에 PostgREST or 구분자( , . ( ) : % _ * )가 없다');
    ok(SEO.CATEGORIES.every(c => c.keywords.length && c.name), '카테고리마다 이름과 검색어가 있다');
    ok(SEO.categoryOfKeyword('노트북').slug === 'laptop' && SEO.categoryOfKeyword('노트북 파우치') === null, '카테고리는 검색어가 «정확히» 같을 때만');
  }

  section('7. 브랜드 판정 — 첫 낱말 + 별칭 + 함정');
  {
    const b = t => (SEO.brandOfTitle(t) || {}).slug || null;
    ok(b('삼성전자 갤럭시 버즈3 FE') === 'samsung' && b('LG전자 2026 그램 16') === 'lg' && b('Apple 2025 맥북 에어') === 'apple', '첫 낱말이 별칭이면 그 브랜드');
    ok(b('삼성 호환 TV 리모컨') === null && b('LG 호환 리모컨') === null, '★ «호환» 상품은 그 브랜드가 아니다');
    ok(b('LG생활건강 엘라스틴 샴푸') === null && b('LG 생활건강 샴푸') === null, '★ LG생활건강 ≠ LG전자');
    ok(b('[LG전자] 트롬 세탁기 21kg') === 'lg' && b('[나이키] 에어포스 1') === 'nike', '대괄호 머리의 브랜드도 같은 브랜드');
    ok(b('보리보리 LG전자 세탁기') === null && b('애플망고 5kg') === null, '★ 몰 이름이 머리인 제목 · 비슷한 낱말은 브랜드가 아니다');
  }

  section('8. 사이트맵 XML');
  {
    const x = SEO.urlsetXml([{ loc: 'https://seosa.ai.kr/p/1?a=1&b=2', lastmod: '2026-10-02' }, { loc: 'https://seosa.ai.kr/p/2', lastmod: 'garbage' }, { loc: '' }]);
    ok(wellFormed(x, 'urlset') === '', 'urlset 형식', wellFormed(x, 'urlset'));
    ok(/<loc>https:\/\/seosa\.ai\.kr\/p\/1\?a=1&amp;b=2<\/loc><lastmod>2026-10-02<\/lastmod>/.test(x), '& 이스케이프 · 올바른 lastmod');
    ok(!/garbage/.test(x) && locs(x).length === 2, '잘못된 lastmod · 빈 loc 은 버린다');
    ok(locs(SEO.urlsetXml(Array.from({ length: 50001 }, (_, i) => ({ loc: `https://seosa.ai.kr/p/${i}` })))).length === SEO.SITEMAP_FILE_MAX, `파일 하나 ${SEO.SITEMAP_FILE_MAX}개 상한 (프로토콜 50,000 안)`);
    ok(!/\u0001/.test(SEO.xmlEsc('a\u0001b')), 'XML 제어문자 제거');
    const ix = SEO.sitemapIndexXml([{ loc: 'https://seosa.ai.kr/sitemaps/pages.xml' }]);
    ok(wellFormed(ix, 'sitemapindex') === '' && /<sitemap><loc>/.test(ix), 'sitemapindex 형식');
  }

  seed();

  section('9. 상품 페이지 — title · canonical · description · JSON-LD');
  {
    const r = await call({ __route: 'page', pid: '2001' });
    const t = r.text;
    ok(r.status === 200 && /<meta name="robots" content="index,follow">/.test(t), '200 · index (20일 기록)');
    const title = (t.match(/<title>([^<]*)<\/title>/) || [])[1];
    ok(title === `${SEO.esc(SEO.shortName('LG전자 2026 그램 16 노트북 코어Ultra5 16Z90T, 에센스 화이트, 512GB'))} 최저가·가격 추이 | SEOSA`, 'title = 상품명 최저가·가격 추이 | SEOSA', title);
    ok((t.match(/rel="canonical"/g) || []).length === 1 && /rel="canonical" href="https:\/\/seosa\.ai\.kr\/p\/2001"/.test(t), 'canonical 하나 · /p/2001');
    const desc = (t.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
    ok(/1,429,000원/.test(desc) && /최근 30일 최저/.test(desc) && desc.length <= 160, 'description 에 현재가·30일 최저', desc);

    const nodes = ldNodes(t);
    const prod = nodes.find(n => n['@type'] === 'Product');
    const crumb = nodes.find(n => n['@type'] === 'BreadcrumbList');
    const shown = Number(((t.match(/<div class="price">([\d,]+)<small>/) || [])[1] || '').replace(/,/g, ''));
    ok(prod && prod.offers.price === shown && shown === 1429000, '★ Offer 가격 = 화면 현재가', `${shown}`);
    ok(prod && prod.brand && prod.brand.name === 'LG전자', '레지스트리 브랜드만 brand 로');
    ok(prod && prod.image && prod.image[0].startsWith('https://ads-partners.coupang.com/'), 'image 는 오래 사는 주소');
    ok(crumb && crumb.itemListElement.length === 3 && crumb.itemListElement[1].item === 'https://seosa.ai.kr/category/laptop', 'Breadcrumb: 홈 > 노트북(카테고리) > 상품');
    ok(/<nav class="crumb"[^>]*><a href="\/">홈<\/a> › <a href="\/category\/laptop">노트북<\/a> › /.test(t), '화면 경로도 같은 계층');
    ok(/<h2 id="price-summary">가격 요약<\/h2>/.test(t) && /<dt>어제 대비<\/dt><dd class="dn">-31,000원/.test(t), '★ 가격 요약이 HTML 텍스트로 (어제 대비 -31,000원)');
    ok(/현재 가격은 최근 30일 평균\([\d,]+원\)보다 [\d.]+% 낮습니다\./.test(t), '30일 평균 대비 문장');
    const avgGrid = (t.match(/<span>30일 평균<\/span><b>([\d,]+)원/) || [])[1];
    const avgSum = (t.match(/최근 30일 최저 · 평균<\/dt><dd>[\d,]+원 · ([\d,]+)원/) || [])[1];
    ok(avgGrid && avgGrid === avgSum, '★ 통계 칸 «30일 평균» 과 요약의 평균이 같은 숫자', `${avgGrid} / ${avgSum}`);
    ok(/href="\/category\/laptop">노트북 최저가 전체 보기/.test(t) && /href="\/brand\/lg">LG전자 제품 가격비교/.test(t), '내부 링크: 카테고리 · 브랜드');
    ok(/<img src="[^"]+" alt="LG전자 2026 그램 16[^"]*"/.test(t), '이미지 alt = 상품명 (키워드 나열 아님)');
    ok(/<a rel="nofollow" href="\/\?q=/.test(t), '검색 URL 링크는 nofollow');
    ok(!/google-site-verification|naver-site-verification/.test(t), '환경변수 없으면 확인 메타 없음');

    const variant = await call({ __route: 'page', pid: '2001', mall: '쿠팡', utm_source: 'x', m: '쿠팡' });
    ok(/rel="canonical" href="https:\/\/seosa\.ai\.kr\/p\/2001"/.test(variant.text), '★ 쿼리가 붙은 주소도 canonical 은 /p/2001 하나');
    const other = await call({ __route: 'page', pid: '2002' });
    ok(!/rel="canonical" href="https:\/\/seosa\.ai\.kr\/p\/2001"/.test(other.text) && (other.text.match(/<title>([^<]*)/) || [])[1] !== title, '다른 상품은 다른 canonical · 다른 title');
  }
  {
    const r = await call({ __route: 'page', pid: '5002' });
    const t = r.text;
    ok(t.indexOf('</script><script>alert(1)</script>') < 0, '★ 상품명의 </script> 가 실행 가능한 형태로 남지 않는다');
    ok(ldNodes(t).find(n => n['@type'] === 'Product').name.indexOf('</script>') > -1, 'JSON-LD 안에서는 원래 이름 그대로 (파싱 후)');
    const noPrice = await call({ __route: 'page', pid: '5001' });
    ok(noPrice.status === 200 && /content="noindex,follow"/.test(noPrice.text) && /가격 미확인/.test(noPrice.text), '가격 없음 → noindex · «가격 미확인»');
    ok(!ldNodes(noPrice.text).some(n => n['@type'] === 'Product' || n.offers), '★ 가격 없음 → Product/가격 구조화 데이터 없음');
    const desc = (noPrice.text.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
    ok(!/\d원/.test(desc), '★ 가격 없음 → description 에 금액 없음', desc);
  }

  section('9-1. 판매처 (seller)');
  {
    const prod = pid => call({ __route: 'page', pid }).then(r => ({ r, p: ldNodes(r.text).find(n => n['@type'] === 'Product') }));
    const cp = await prod('2001');
    ok(cp.p && cp.p.offers.seller && cp.p.offers.seller.name === '쿠팡', '쿠팡 → seller «쿠팡»');
    const known = await prod('7101');
    ok(known.p && known.p.offers.seller && known.p.offers.seller.name === '하프클럽', 'ADPICK + 몰 이름 → seller «하프클럽»', JSON.stringify(known.p && known.p.offers));
    const unknown = await prod('7102');
    ok(unknown.p && unknown.p.offers && !('seller' in unknown.p.offers), '★ ADPICK + 몰 이름 없음 → seller 속성 자체가 없다', JSON.stringify(unknown.p && unknown.p.offers));
    ok(!/"name":"ADPICK"/.test(unknown.r.text) && !/현재 ADPICK/.test(unknown.r.text), '★ "ADPICK" 을 판매자로 쓰지 않는다 (구조화 데이터·description)');
    ok(SEO.sellerOf({ mall: 'ADPICK', mall_label: 'ADPICK' }) === '' && SEO.sellerOf({ mall: '네이버' }) === '', '라벨이 ADPICK 이거나 모르는 몰 → 판매자 없음');
  }

  section('9-2. 부속 · 호환품 — brand · breadcrumb');
  {
    const look = async pid => {
      const r = await call({ __route: 'page', pid });
      const nodes = ldNodes(r.text);
      const crumb = nodes.find(n => n['@type'] === 'BreadcrumbList').itemListElement.map(i => i.name);
      const p = nodes.find(n => n['@type'] === 'Product');
      const nav = ((r.text.match(/<nav class="crumb"[^>]*>([\s\S]*?)<\/nav>/) || [])[1] || '').replace(/<[^>]+>/g, '');
      return { r, crumb, brand: p && p.brand ? p.brand.name : null, hasProduct: !!p, nav };
    };
    const main = await look('2001');
    ok(main.crumb.length === 3 && main.crumb[1] === '노트북' && main.brand === 'LG전자', '본품(그램) → 홈 > 노트북 > 상품 · brand LG전자');
    for (const [pid, label] of [['2014', 'LG 그램 전용 어댑터'], ['2015', 'LG 그램 노트북 핀 타입 19V (부속 낱말 없음)'], ['2016', '닌텐도 스위치 OLED 전용 필름'], ['2017', '애플 호환 케이스']]) {
      const a = await look(pid);
      ok(a.hasProduct && a.brand === null, `★ ${label} → brand 없음`, String(a.brand));
      ok(a.crumb.length === 2 && a.crumb[0] === '홈' && !/노트북 ›/.test(a.nav), `★ ${label} → 홈 > 상품 (카테고리 계층 없음)`, a.crumb.join(' > '));
      ok(!/href="\/brand\//.test(a.r.text) && !/href="\/category\/laptop">노트북 최저가 전체 보기/.test(a.r.text), `${label} → 브랜드·카테고리 링크도 달지 않는다`);
    }
    const nsw = await look('2018');
    ok(nsw.brand === '닌텐도' && nsw.crumb.length === 2, '카테고리 밖 본품(닌텐도 스위치 2) → brand 있음 · 홈 > 상품');
    const lg = await call({ __route: 'brand', slug: 'lg' });
    ok(!/href="\/p\/2015"/.test(lg.text) && !/href="\/p\/2014"/.test(lg.text), '★ /brand/lg 목록도 같은 규칙 — 어댑터·핀을 LG전자 제품으로 올리지 않는다');
  }

  section('9-3. 구조화 데이터 신선도 (마지막 관측 기준 3일)');
  {
    for (const d of [0, 1, 3, 4, 10]) {
      const r = await call({ __route: 'page', pid: String(7200 + d) });
      const p = ldNodes(r.text).find(n => n['@type'] === 'Product');
      ok(/content="index,follow"/.test(r.text), `관측 ${d}일 전 — 페이지 색인 정책은 그대로 index (구조화 데이터와 별개)`);
      if (d <= SEO.STALE_OFFER_DAYS) ok(p && p.offers && p.offers.price === 10000, `관측 ${d}일 전 → Product + Offer`);
      else ok(!p && !/"@type":"Offer"/.test(r.text), `★ 관측 ${d}일 전 → Product·Offer 없음 (묵은 값을 현재가로 내지 않는다)`);
    }
  }

  section('9-4. 상품 페이지 색인 경계 — 관측 6 · 7 · 8일');
  {
    for (const n of [6, 7, 8]) {
      const r = await call({ __route: 'page', pid: String(7300 + n) });
      const want = n >= 7 ? 'index,follow' : 'noindex,follow';
      ok(r.text.indexOf(`<meta name="robots" content="${want}">`) > -1, `★ 관측 ${n}일 → ${want}`);
    }
  }

  {
    const r = await call({ __route: 'page', pid: '4011' });
    ok(r.status === 200 && /content="noindex,follow"/.test(r.text) && !ldNodes(r.text).some(n => n['@type'] === 'Product'), '★ 렌탈 1원 상품: 기록 8일이어도 noindex · Product 없음 (페이지는 열린다)');
  }

  section('10. 카테고리 페이지');
  {
    const r = await call({ __route: 'category', slug: 'laptop' });
    const t = r.text;
    ok(r.status === 200 && /content="index,follow"/.test(t) && !r.headers['x-robots-tag'], '★ 본품 9개 ≥ 8 · 색인 상품 3개 ≥ 3 → index');
    ok(!/가장 낮은/.test(t), '★ «가장 낮은 ○○ 상품» 단정 문장이 없다');
    ok(/<title>노트북 최저가·가격비교 \| SEOSA<\/title>/.test(t) && /<h1>노트북 최저가·가격 추이<\/h1>/.test(t), 'title · h1');
    ok(/rel="canonical" href="https:\/\/seosa\.ai\.kr\/category\/laptop"/.test(t), 'canonical /category/laptop');
    const links = [...t.matchAll(/<li><a href="\/p\/(\d+)">/g)].map(m => m[1]);
    ok(links.length === 9 && links.indexOf('2010') < 0 && links.indexOf('2011') < 0 && links.indexOf('2012') < 0, '★ 부속(파우치)·무관(펩시)·stale 제외', links.join(','));
    ok(links.indexOf('2013') < 0 && !/7,520원/.test(t), '★ 값이 카테고리 중앙값의 20% 미만인 행(키캡)은 «가장 싼 노트북» 이 되지 않는다');
    ok(links[0] === '2008' && links[links.length - 1] === '2002', '현재가 낮은 순');
    ok(/▼31,000원/.test(t), '가격 기록이 있으면 직전 관측 대비 하락을 보여 준다');
    ok(/현재가 범위<\/dt><dd>459,000~1,590,000원/.test(t), '요약: 실제 최저~최고');
    const nodes = ldNodes(t);
    const coll = nodes.find(n => n['@type'] === 'CollectionPage');
    ok(coll && coll.mainEntity && coll.mainEntity.itemListElement.length === 9 && coll.mainEntity.itemListElement[0].url === 'https://seosa.ai.kr/p/2008', 'CollectionPage + ItemList(상세 페이지 URL)');
    ok(!nodes.some(n => n['@type'] === 'Product'), '★ 목록 페이지에는 Product 를 넣지 않는다');
    ok(nodes.find(n => n['@type'] === 'BreadcrumbList').itemListElement.length === 3, 'Breadcrumb 홈 > 카테고리 > 노트북');

    const thin = await call({ __route: 'category', slug: 'monitor' });
    ok(thin.status === 200 && /content="noindex,follow"/.test(thin.text) && thin.headers['x-robots-tag'] === 'noindex', `★ 본품 3개 < ${SEO.CATEGORY_MIN_PRODUCTS} → noindex`);
    const shaver = await call({ __route: 'category', slug: 'shaver' });
    ok(shaver.status === 200 && /content="noindex,follow"/.test(shaver.text) && shaver.headers['x-robots-tag'] === 'noindex', `★ 본품 8개 · 색인 상품 2개 < ${SEO.CATEGORY_MIN_TRACKED} → noindex,follow`);
    const kettle = await call({ __route: 'category', slug: 'electric-kettle' });
    ok(kettle.status === 200 && /content="noindex,follow"/.test(kettle.text), '★ 본품 7개 (전부 기록 충분) < 8 → noindex,follow');
    const gate = (n, t) => pages._internal.categoryGate(Array.from({ length: n }, (_, i) => ({ product_id: String(i) })), new Set(Array.from({ length: t }, (_, i) => String(i))));
    ok(gate(8, 3).indexable && !gate(8, 2).indexable && !gate(7, 7).indexable && gate(9, 9).indexable, '판정 함수: 8+3 ✓ · 8+2 ✗ · 7+7 ✗');
    const empty = await call({ __route: 'category', slug: 'tent' });
    ok(empty.status === 404 && /noindex/.test(empty.text), '레지스트리에 있어도 상품이 없으면 404 (soft 404 금지)');
    const unknown = await call({ __route: 'category', slug: 'not-a-category' });
    const bad = await call({ __route: 'category', slug: '../etc' });
    ok(unknown.status === 404 && bad.status === 404, '★ 레지스트리에 없는 slug → 404 (검색어마다 페이지를 찍지 않는다)');
    const noBrand = await call({ __route: 'brand', slug: 'not-a-brand' });
    const noProduct = await call({ __route: 'page', pid: '99999999' });
    ok([unknown, empty, noBrand, noProduct].every(x => x.status === 404 && !/rel="canonical"/.test(x.text) && !/og:url/.test(x.text)),
      '★ 404 응답(카테고리·브랜드·상품)에는 canonical · og:url 이 없다');
  }

  section('11. 브랜드 · 허브');
  {
    const r = await call({ __route: 'brand', slug: 'lg' });
    const ids = [...r.text.matchAll(/<li><a href="\/p\/(\d+)">/g)].map(m => m[1]);
    ok(r.status === 200 && /<title>LG전자 최저가·가격비교 \| SEOSA<\/title>/.test(r.text), 'title');
    ok(ids.indexOf('4001') < 0 && ids.indexOf('4002') < 0 && ids.indexOf('4003') < 0, '★ LG생활건강 · 호환품 · 몰 머리 제목 제외', ids.join(','));
    ok(ids.indexOf('4011') < 0 && !/>1원/.test(r.text), '★ 렌탈 1원 상품은 «가장 싼 LG전자» 가 되지 않는다');
    ok(ids.indexOf('2001') > -1 && ids.filter(x => /^400[4-9]|4010$/.test(x)).length === 7 && ids.length === 9, 'LG전자 본품 9개 (그램 1 + 세탁기 7 + 모니터 1)', String(ids.length));
    ok(/content="index,follow"/.test(r.text), '★ 본품 9개 · 색인 상품 3개 → index');
    const ph = await call({ __route: 'brand', slug: 'philips' });
    ok(ph.status === 200 && /content="noindex,follow"/.test(ph.text), '★ 브랜드 본품 8개 · 색인 상품 1개 → noindex,follow');
    ok(/<h2>현재가 높은 순<\/h2>/.test(r.text) && ids[0] === '2001' && !/가장 낮은 LG전자/.test(r.text),
      '★ 브랜드는 현재가 높은 순 · «가장 싼 제품» 문장 없음 (TV 와 리모컨을 견주지 않는다)', ids[0]);
    const sam = await call({ __route: 'brand', slug: 'samsung' });
    ok(sam.status === 200 && /content="noindex,follow"/.test(sam.text), '삼성 2개 → noindex');

    pages._internal.resetMemo();
    const hub = await call({ __route: 'hub' });
    ok(hub.status === 200 && /href="\/category\/laptop"/.test(hub.text) && /href="\/brand\/lg"/.test(hub.text), '허브: 색인 문턱을 넘은 카테고리·브랜드 링크');
    ok(!/href="\/category\/monitor"/.test(hub.text) && !/href="\/brand\/samsung"/.test(hub.text) && !/href="\/category\/shaver"/.test(hub.text) && !/href="\/brand\/philips"/.test(hub.text), '★ 허브는 noindex 페이지로 링크하지 않는다');

    // DB 가 바빠 다시 세지 못하면 직전 결과로 답한다 (인스턴스 메모). 허브·상품 사이트맵 메모를 둘 다 만료시킨다.
    pages._internal.expireMemo();
    dbDown = true;
    const stale = await call({ __route: 'hub' });
    dbDown = false;
    ok(stale.status === 200 && /href="\/category\/laptop"/.test(stale.text), '★ 허브 재집계 실패 → 직전 결과로 200 (빈 허브·500 이 아니다)');
    pages._internal.resetMemo();
    dbDown = true;
    const cold = await call({ __route: 'hub' });
    dbDown = false;
    ok(cold.status === 503 && cold.headers['retry-after'] && /no-store/.test(cold.headers['cache-control'] || ''), '직전 결과도 없으면 503 · Retry-After · no-store', String(cold.status));
    pages._internal.resetMemo();
  }
  {
    // 1,000행(PostgREST 한 응답 상한)을 넘는 카테고리 — 나머지 페이지를 놓치지 않는가.
    const saved = db.products.slice();
    for (let i = 0; i < 2300; i++) db.products.push(product({ product_id: String(700000 + i), keyword: i % 2 ? '무선 마우스' : '마우스', title: `테스트 무선 마우스 모델${i}`, lprice: 10000 + i }));
    const r = await call({ __route: 'category', slug: 'mouse' });
    const count = Number(((r.text.match(/가격 기록 중인 상품<\/dt><dd>([\d,]+)개/) || [])[1] || '').replace(/,/g, ''));
    ok(r.status === 200 && count === 2301, '★ 1,000행을 넘어도 전부 센다 (페이지 3장 동시 읽기)', `${count}개`);
    pages._internal.resetMemo();
    const hub = await pages._internal.hubData();
    const mouse = hub.categories.find(e => e.def.slug === 'mouse');
    ok(mouse && mouse.count === count, '★ 허브와 카테고리 페이지가 같은 수를 센다', mouse && `${mouse.count}`);
    db.products = saved;
    pages._internal.resetMemo();
  }

  section('12. 사이트맵 — DB 함수 없음(폴백)');
  {
    rpcImpl = null;
    pages._internal.resetMemo();
    const ix = await call({ __route: 'sitemap-index' });
    ok(ix.status === 200 && wellFormed(ix.text, 'sitemapindex') === '', '인덱스 형식', wellFormed(ix.text, 'sitemapindex'));
    ok(locs(ix.text).join() === 'https://seosa.ai.kr/sitemaps/pages.xml,https://seosa.ai.kr/sitemaps/products-1.xml', '함수 없음 → pages + products-1', locs(ix.text).join());
    const p1 = await call({ __route: 'sitemap-file', file: 'products-1.xml' });
    ok(p1.status === 200 && wellFormed(p1.text, 'urlset') === '', 'products-1 형식');
    const urls = locs(p1.text);
    const has = pid => urls.indexOf(`https://seosa.ai.kr/p/${pid}`) > -1;
    ok(['2001', '2003', '2004', '5002', '7307', '7308', '8002', '8003'].every(has), '관측 7일 이상 · live · 구매 가격 상품이 오른다');
    ok(!['2002', '4011', '7306', '5001'].some(has), '★ 기록 부족·렌탈·가격 없음은 오르지 않는다');
    ok(!has('8001'), '★ 다른 옵션의 8일을 세지 않는다 — 현재 옵션 2일인 8001 은 사이트맵에 없다 (sameVendorRows)');
    const lm = (p1.text.match(/<loc>https:\/\/seosa\.ai\.kr\/p\/8101<\/loc><lastmod>([^<]+)</) || [])[1];
    ok(lm === kstToday(KST_LASTMOD_AT) && lm !== new Date(KST_LASTMOD_AT).toISOString().slice(0, 10), '★ lastmod 는 KST 날짜 (UTC 16:00 수집 = KST 다음 날)', `${lm}`);
    const p2 = await call({ __route: 'sitemap-file', file: 'products-2.xml' });
    ok(p2.status === 404, '함수 없음 → products-2 는 404');
    const pg = await call({ __route: 'sitemap-file', file: 'pages.xml' });
    const pl = locs(pg.text);
    ok(pl[0] === 'https://seosa.ai.kr/' && pl.indexOf('https://seosa.ai.kr/category') > -1 && pl.indexOf('https://seosa.ai.kr/category/laptop') > -1 && pl.indexOf('https://seosa.ai.kr/brand/lg') > -1, 'pages.xml: 홈 · 허브 · 색인 카테고리·브랜드');
    ok(/<url><loc>https:\/\/seosa\.ai\.kr\/<\/loc><\/url>/.test(pg.text) && /<url><loc>https:\/\/seosa\.ai\.kr\/category<\/loc><\/url>/.test(pg.text), '★ 홈·허브에는 근거 없는 «오늘» lastmod 를 달지 않는다');
    ok(/<loc>https:\/\/seosa\.ai\.kr\/category\/laptop<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(pg.text), '카테고리 lastmod 는 실제 수집일');
    ok(['category/monitor', 'brand/samsung', 'category/shaver', 'category/electric-kettle', 'brand/philips'].every(u => pl.indexOf(`https://seosa.ai.kr/${u}`) < 0), '★ noindex 목록 페이지는 사이트맵에 없다');
    const junk = await call({ __route: 'sitemap-file', file: '../../etc/passwd' });
    ok(junk.status === 404, '이상한 파일 이름 → 404');
    ok(/s-maxage=43200/.test(ix.headers['cache-control'] || ''), '사이트맵 Edge 캐시 12시간');

    // 사이트맵에 오른 상품 URL 은 전부 index 여야 한다 (Search Console «제출됐지만 noindex» 방지)
    for (const u of urls) {
      const pid = u.split('/p/')[1];
      const page = await call({ __route: 'page', pid });
      ok(/content="index,follow"/.test(page.text), `★ 사이트맵 URL ${pid} → index,follow`);
    }
  }

  section('13. 사이트맵 — DB 함수 있음(id 범위 분할)');
  {
    // 함수의 판정을 흉내 낸다 — 범위 안 · 관측일 ≥ p_min_days.
    rpcImpl = (name, p) => {
      if (name !== 'seo_sitemap_products') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
      const days = new Map();
      db.price_history.forEach(h => { const k = `${h.product_id}|${h.mall}`; if (!days.has(k)) days.set(k, new Set()); days.get(k).add(h.recorded_date); });
      const out = db.products.filter(r => r.id >= p.p_id_from && r.id < p.p_id_to && r.lprice >= 100 && !/렌탈|구독/.test(r.title) && (days.get(`${r.product_id}|${r.mall}`) || new Set()).size >= p.p_min_days)
        .sort((a, b) => a.id - b.id).map(r => [r.product_id, r.collected_at.slice(0, 10)]);
      return { data: out, error: null };
    };
    // 두 번째 범위에 상품 하나를 둔다 — id 를 범위 폭만큼 띄운다.
    const R = pages._internal.PRODUCT_ID_RANGE;
    db.products.push(product({ id: R + 5, product_id: '9001', keyword: '마우스', title: '로지텍 G102 마우스', lprice: 19900 }));
    series('9001', [19900, 19900, 19900, 19900, 19900, 19900, 19900]);
    db.products.push(product({ id: 3 * R + 1, product_id: '9002', keyword: '마우스', title: '기록 짧은 마우스', lprice: 9900 }));
    pages._internal.resetMemo();
    const ix = await call({ __route: 'sitemap-index' });
    const files = locs(ix.text);
    ok(files.join() === ['pages', 'products-1', 'products-2'].map(f => `https://seosa.ai.kr/sitemaps/${f}.xml`).join(), '★ 빈 범위(3·4번째)는 인덱스에 올리지 않는다', files.join());
    const p2 = await call({ __route: 'sitemap-file', file: 'products-2.xml' });
    ok(p2.status === 200 && locs(p2.text).join() === 'https://seosa.ai.kr/p/9001', 'products-2 = 두 번째 id 범위');
    const p4 = await call({ __route: 'sitemap-file', file: 'products-4.xml' });
    ok(p4.status === 200 && locs(p4.text).length === 0, '범위 안이지만 비어 있으면 빈 urlset (404 아님)');
    const p9 = await call({ __route: 'sitemap-file', file: 'products-9.xml' });
    ok(p9.status === 404, '최대 id 를 넘는 번호 → 404');
    const goodImpl = rpcImpl;
    const TIMEOUT = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    const p1Before = locs((await call({ __route: 'sitemap-file', file: 'products-1.xml' })).text);

    // (1) 직전 결과 있음 + RPC 전부 실패 → 직전 결과로 200 (짧게만 캐시)
    pages._internal.expireMemo();
    rpcImpl = () => TIMEOUT;
    const lg1 = await call({ __route: 'sitemap-file', file: 'products-1.xml' });
    ok(lg1.status === 200 && locs(lg1.text).join() === p1Before.join() && /s-maxage=600\b/.test(lg1.headers['cache-control'] || ''), '★ 직전 결과 있음 + RPC 실패 → 직전 목록 200 · 10분만 캐시', `${lg1.status} ${lg1.headers['cache-control']}`);
    const lgIx = await call({ __route: 'sitemap-index' });
    ok(lgIx.status === 200 && locs(lgIx.text).length === 3, '직전 결과로 인덱스도 그대로 (pages + products-1·2)');

    // (2) 직전 결과 없음 + RPC 전부 실패 → 503 · Retry-After · no-store
    pages._internal.resetMemo();
    const errd = await call({ __route: 'sitemap-file', file: 'products-1.xml' });
    ok(errd.status === 503 && errd.headers['retry-after'] && /no-store/.test(errd.headers['cache-control'] || ''), '★ 직전 결과 없음 + 전부 실패 → 503 · Retry-After · no-store (빈 사이트맵 200 이 아니다)', String(errd.status));
    const errIx = await call({ __route: 'sitemap-index' });
    ok(errIx.status === 503 && /no-store/.test(errIx.headers['cache-control'] || ''), '인덱스도 503 (상품 사이트맵이 사라진 200 이 아니다)', String(errIx.status));

    // (3) 범위 하나만 실패 · 나머지 정상 · 직전 결과 없음 → 나머지만 내고, 실패 범위는 503
    const R2 = pages._internal.PRODUCT_ID_RANGE;
    rpcImpl = (name, p) => (p.p_id_from === R2 ? TIMEOUT : goodImpl(name, p));
    pages._internal.resetMemo();
    const part = await call({ __route: 'sitemap-index' });
    const partFiles = locs(part.text).map(u => u.split('/').pop());
    ok(part.status === 200 && partFiles.join() === 'pages.xml,products-1.xml' && /s-maxage=600\b/.test(part.headers['cache-control'] || ''), '★ 범위 하나 실패 → 전체를 죽이지 않고 pages·products-1 만 · 짧게 캐시', partFiles.join());
    const part2 = await call({ __route: 'sitemap-file', file: 'products-2.xml' });
    ok(part2.status === 503, '실패한 범위 파일 → 503 (빈 200 이 아니다)', String(part2.status));

    // (4) 범위 하나 실패 + 직전 결과 있음 → 그 범위는 직전 결과
    rpcImpl = goodImpl;
    pages._internal.resetMemo();
    await call({ __route: 'sitemap-index' });
    pages._internal.expireMemo();
    rpcImpl = (name, p) => (p.p_id_from === R2 ? TIMEOUT : goodImpl(name, p));
    const keep = await call({ __route: 'sitemap-index' });
    const keep2 = await call({ __route: 'sitemap-file', file: 'products-2.xml' });
    ok(locs(keep.text).length === 3 && keep2.status === 200 && locs(keep2.text).join() === 'https://seosa.ai.kr/p/9001', '★ 실패한 범위는 직전 결과로 유지 (pages · 1 · 2 그대로)');

    // (5) 형식이 틀린 응답은 «빈 성공» 이 아니다
    rpcImpl = () => ({ data: { rows: 1 }, error: null });
    pages._internal.resetMemo();
    const bad = await call({ __route: 'sitemap-index' });
    ok(bad.status === 503, '★ RPC 응답이 배열이 아니면 오류 — 0개 성공으로 삼키지 않는다', String(bad.status));
    let threw = '';
    try { await pages._internal.rpcRange(0, 10); } catch (e) { threw = e.message; }
    ok(/형식 오류/.test(threw), 'rpcRange: 형식 오류를 던진다', threw);

    // (6) 정상 빈 범위 vs 실패 — 빈 범위는 200 빈 urlset, 실패는 503
    rpcImpl = goodImpl;
    pages._internal.resetMemo();
    const legitEmpty = await call({ __route: 'sitemap-file', file: 'products-4.xml' });
    ok(legitEmpty.status === 200 && locs(legitEmpty.text).length === 0, '정상적으로 비어 있는 범위 → 200 빈 urlset (실패와 구별)');
    rpcImpl = null;
    pages._internal.resetMemo();
  }

  section('13-1. 직전 결과 대조 (reconcile)');
  {
    const rc = pages._internal.reconcile;
    const L = n => Array.from({ length: n }, (_, i) => ({ pid: String(i), lastmod: '' }));
    const now = Date.now();
    const prev = { mode: 'rpc', count: 2, shards: new Map([[1, L(40)], [2, L(30)]]), computedAt: now - 60000 };
    let o = rc({ mode: 'rpc', count: 2, shards: new Map([[1, L(10)], [2, L(30)]]), failed: [] }, prev, now);
    ok(o.shards.get(1).length === 40 && o.stale.indexOf(1) > -1, `★ 범위 하나가 절반 미만으로 급감(40→10) → 직전 결과 유지 (기준 ${pages._internal.DROP_RATIO})`);
    o = rc({ mode: 'rpc', count: 2, shards: new Map([[1, L(25)], [2, L(30)]]), failed: [] }, prev, now);
    ok(o.shards.get(1).length === 25 && !o.stale.length, '절반 이상(40→25) → 새 결과 받아들임');
    o = rc({ mode: 'rpc', count: 2, shards: new Map([[1, L(40)]]), failed: [2] }, prev, now);
    ok(o.shards.get(2).length === 30 && o.stale.indexOf(2) > -1 && !o.missing.length, '실패한 범위 → 직전 결과로');
    o = rc({ mode: 'rpc', count: 2, shards: new Map([[1, L(40)]]), failed: [2] }, null, now);
    ok(!o.shards.has(2) && o.missing.join() === '2', '직전 결과가 없으면 실패한 범위는 빠지고 missing 으로 남는다');
    const small = { mode: 'rpc', count: 1, shards: new Map([[1, L(10)]]), computedAt: now - 60000 };
    o = rc({ mode: 'rpc', count: 1, shards: new Map([[1, L(0)]]), failed: [] }, small, now);
    ok(o.shards.get(1).length === 0, `직전이 ${pages._internal.DROP_MIN}개 미만이면 0 도 정상으로 받아들인다 (비교할 근거가 없다)`);
    o = rc({ mode: 'rpc', count: 2, shards: new Map([[1, L(5)], [2, L(5)]]), failed: [] }, Object.assign({}, prev, { computedAt: now - 25 * 3600e3 }), now);
    ok(o.shards.get(1).length === 5, '★ 직전 결과가 24시간보다 오래되면 기준으로 쓰지 않는다 (옛 목록을 영원히 붙들지 않는다)');
    o = rc({ mode: 'legacy', count: 1, shards: new Map([[1, L(3)]]), failed: [] }, prev, now);
    ok(o.shards.get(1).length === 3, '방식이 바뀌면(rpc→legacy) 비교하지 않는다');
  }

  section('14. 정적 파일 · 라우팅');
  {
    const robots = fs.readFileSync(path.join(ROOT, 'public', 'robots.txt'), 'utf8');
    const rules = robots.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
    ok(rules.indexOf('Sitemap: https://seosa.ai.kr/sitemap.xml') > -1, 'robots.txt → 사이트맵 인덱스');
    ok(rules.indexOf('Disallow: /api/') > -1, '/api/ 차단은 그대로');
    ok(!rules.some(l => /^Disallow:\s*\/(\?|p\/|category|brand|$)/.test(l)), '★ 검색 URL·상품·카테고리를 robots 로 막지 않는다 (noindex 를 읽어야 한다)');

    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const body = html.replace(/<!--[\s\S]*?-->/g, '');
    ok((body.match(/<h1[\s>]/g) || []).length === 1, '★ 홈 H1 은 하나', String((body.match(/<h1[\s>]/g) || []).length));
    ok((body.match(/<h2 class="hero-title">/g) || []).length === 3, '나머지 슬라이드 제목은 같은 class 의 h2 (모양 그대로)');
    ok(/<title>SEOSA · 최저가·가격비교·가격 추이<\/title>/.test(body), '홈 title');
    ok(/<meta property="og:title" content="SEOSA · 최저가도 고급스럽게">/.test(body), '공유 카드 브랜드 문구는 그대로');
    ok(/<link rel="canonical" href="https:\/\/seosa\.ai\.kr\/">/.test(body), '홈 원본 HTML 은 canonical = 홈');
    // 머리의 인라인 스크립트를 실제로 돌려 «행동» 을 본다 (정규식 모양을 단언하지 않는다).
    const headScript = [...body.split('</head>')[0].matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(src => /canonical/.test(src));
    const runHead = search => {
      const canonical = { removed: false };
      canonical.parentNode = { removeChild() { canonical.removed = true; } };
      const robots = { content: 'index,follow', setAttribute(k, v) { if (k === 'content') this.content = v; } };
      const document = { querySelector(sel) { if (/canonical/.test(sel)) return canonical.removed ? null : canonical; if (/robots/.test(sel)) return robots; return null; } };
      new Function('location', 'document', headScript)({ search }, document);
      return `${canonical.removed ? 'no-canonical' : 'canonical'}/${robots.content}`;
    };
    const NOIDX = 'no-canonical/noindex,follow', IDX = 'canonical/index,follow';
    const cases = [['?q=%EB%85%B8%ED%8A%B8%EB%B6%81', NOIDX], ['?p=1', NOIDX], ['?q=', NOIDX], ['?q', NOIDX], ['?utm_source=x&q=y', NOIDX], ['', IDX], ['?foo=bar', IDX], ['?Q=x', IDX], ['?qq=1', IDX]];
    const wrong = cases.filter(([q, want]) => runHead(q) !== want).map(([q]) => q || '(없음)');
    ok(!!headScript && !wrong.length, '★ 열린 주소별 행동: ?q·?p(값 없음 포함) → canonical 제거 + noindex · 그 밖은 그대로', wrong.join(','));
    ok(/<a href="\/category"[^>]*>카테고리·브랜드별 최저가<\/a>/.test(body), '홈 → /category 진짜 링크');
    ok(!/naver-site-verification" content="[^여]/.test(body), '네이버 확인 값을 지어내지 않는다 (주석 자리만)');
    const radar = fs.readFileSync(path.join(ROOT, 'public', 'radar.html'), 'utf8');
    ok(/<meta name="robots" content="noindex,follow">/.test(radar), '개인 레이더 페이지 noindex');
    ok(!fs.existsSync(path.join(ROOT, 'public', 'sitemap.xml')), '정적 sitemap.xml 은 없다 (동적 인덱스가 같은 주소를 맡는다)');

    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const rw = vercel.rewrites.map(r => r.source);
    const catchAll = rw.indexOf('/((?!api/).*)');
    const need = ['/sitemap.xml', '/sitemap-products.xml', '/sitemaps/:file', '/category', '/category/:slug', '/brand/:slug', '/p/:pid'];
    ok(need.every(s => rw.indexOf(s) > -1 && rw.indexOf(s) < catchAll), '★ 새 경로는 정적 catch-all 보다 앞', need.filter(s => !(rw.indexOf(s) > -1 && rw.indexOf(s) < catchAll)).join(','));
    const noindexQ = vercel.headers.filter(h => h.source === '/' && (h.has || []).some(x => x.type === 'query' && (x.key === 'q' || x.key === 'p')));
    ok(noindexQ.length === 2 && noindexQ.every(h => h.headers.some(x => x.key === 'X-Robots-Tag' && /noindex/.test(x.value) && /follow/.test(x.value))), '/?q= · /?p= → X-Robots-Tag: noindex, follow');
    // Vercel 규칙(문서): headers.source 는 쿼리를 뺀 경로와 맞추고, has.type=query 에 value 가 없으면 «키가 있기만 하면» 맞는다.
    const robotsHeader = (pathname, query) => vercel.headers
      .filter(h => h.source === pathname || h.source === '/(.*)')
      .filter(h => (h.has || []).every(c => c.type === 'query' && c.value === undefined && Object.prototype.hasOwnProperty.call(query, c.key)))
      .reduce((acc, h) => acc.concat(h.headers), [])
      .filter(x => x.key === 'X-Robots-Tag').map(x => x.value).join();
    const hcases = [['/', { q: '노트북' }, true], ['/', { p: '1' }, true], ['/', { q: '' }, true], ['/index.html', { q: 'x' }, true], ['/index.html', { p: '1' }, true],
      ['/radar.html', {}, true], ['/', {}, false], ['/', { foo: 'bar' }, false], ['/index.html', {}, false]];
    const hwrong = hcases.filter(([p, q, want]) => /noindex/.test(robotsHeader(p, q)) !== want).map(([p, q]) => p + JSON.stringify(q));
    ok(!hwrong.length, '★ vercel.json 헤더 규칙: /?q·/?p·/index.html?q·/index.html?p → noindex · / 와 /?foo 는 아님', hwrong.join(' '));
    const dev = fs.readFileSync(path.join(ROOT, 'scripts', 'dev-server.js'), 'utf8');
    ok(/'sitemap-index'/.test(dev) && /route: 'category'/.test(dev) && /route: 'brand'/.test(dev) && /route: 'sitemap-file'/.test(dev), '로컬 서버도 같은 경로를 안다');

    const sql = fs.readFileSync(path.join(ROOT, 'supabase', '2026-10-02-seo-sitemap.sql'), 'utf8').replace(/--.*$/gm, '');
    ok(/stable/.test(sql) && /security invoker/.test(sql) && /from public, anon, authenticated/.test(sql) && /to service_role/.test(sql), 'DB 함수: stable · invoker · service_role 만');
    ok(!/\b(delete|update|insert|truncate|drop\s+table|alter\s+table)\b/i.test(sql), '★ 마이그레이션은 아무 행도 바꾸지 않는다');
    ok(sql.indexOf(`p.lprice >= ${SEO.NOMINAL_PRICE_MIN}`) > -1 && sql.indexOf("'(렌탈|구독)'") > -1 && sql.indexOf("p.mall in ('쿠팡', 'ADPICK')") > -1,
      '★ DB 함수와 JS(isNonPurchaseListing · isRefreshableMall)가 같은 규칙');
  }

  realLog(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) { realLog('실패: ' + failures.join(' | ')); process.exit(1); }
})().catch(e => { console.error('오류:', e && e.stack || e); process.exit(1); });
