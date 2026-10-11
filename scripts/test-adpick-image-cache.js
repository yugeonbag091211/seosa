#!/usr/bin/env node
'use strict';
/*
 * ADPICK 사진 원본 캐시 (api/_imagecache.js + recordPrices + 수집기) — 오프라인.
 *
 *   · 임시 사진이 살아 있을 때 원본 바이트 그대로 Storage 에 한 번 저장한다
 *   · 저장 뒤에는 카탈로그가 Storage 주소를 쓰고, 다시 받지 않는다
 *   · daumcdn · 이미 저장한 주소는 건드리지 않는다
 *   · 404 · text/html · 너무 큰 응답 · 업로드 실패는 저장하지 않고, 가격 저장은 계속된다
 *   · ADPICK 검색 API 호출은 0회 — 네트워크는 사진 주소 GET 뿐이다
 *
 * ★ 실제 네트워크도 운영 DB 도 쓰지 않는다. fetch 는 가짜 라우터, supabase 는 가짜다.
 */
const path = require('node:path');
const Module = require('module');

process.env.SUPABASE_URL = 'https://unit-test.supabase.co';
process.env.ADPICK_IMAGE_CACHE = '1';
process.env.ADPICK_API_KEY = process.env.ADPICK_API_KEY || 'offline-test-key';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ── 가짜 사진 서버 (global.fetch) ─────────────────────────────────── */
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(4000, 7), Buffer.from([0xFF, 0xD9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(3000, 3)]);
const HTML = Buffer.from('<!doctype html><html><body>' + 'x'.repeat(1000) + '</body></html>');
const routes = new Map();    // code → { status, type, body, length?, delayMs?, throws? }
const net = { calls: [], adpickApi: 0, inFlight: 0, maxInFlight: 0 };
const tok = code => `https://d2iaagr1j041pi.cloudfront.net/apis/search_img.php?code=${code}`;

global.fetch = async (url, init = {}) => {
  url = String(url);
  net.calls.push(url);
  if (/biz\.adpick\.co\.kr\/api\//.test(url)) { net.adpickApi++; throw new Error('ADPICK 검색 API 를 부르면 안 된다'); }
  const code = (url.match(/code=(\d+)/) || [])[1] || url;
  const r = routes.get(code);
  if (!r) throw new Error(`예상하지 못한 외부 호출: ${url}`);
  net.inFlight++; net.maxInFlight = Math.max(net.maxInFlight, net.inFlight);
  try {
    if (r.delayMs) await new Promise(res => setTimeout(res, r.delayMs));
    if (r.throws) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; }
    const headers = new Headers({ 'content-type': r.type });
    if (r.length != null) headers.set('content-length', String(r.length));
    return new Response(r.body, { status: r.status, headers });
  } finally { net.inFlight--; }
};

/* ── 가짜 supabase (DB + Storage) ─────────────────────────────────── */
const db = { products: [], price_history: [], adpick_search_cache: [] };
const store = { objects: new Map(), uploads: [], failWith: null };
function resetAll() {
  db.products = []; db.price_history = []; db.adpick_search_cache = [];
  store.objects = new Map(); store.uploads = []; store.failWith = null;
  routes.clear(); net.calls = []; net.adpickApi = 0; net.maxInFlight = 0;
  require('../api/_imagecache')._resetState();
}
function makeQuery(table) {
  const eqs = []; let inF = null;
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
    lt() { return q; }, gte() { return q; }, gt() { return q; }, lte() { return q; }, neq() { return q; },
    or() { return q; }, not() { return q; }, is() { return q; }, abortSignal() { return q; },
    in(col, vals) { inF = { col, vals: vals.map(String) }; return q; },
    eq(col, v) { eqs.push({ col, v }); return q; },
    maybeSingle() { return q.then(r => ({ data: (r.data || [])[0] || null, error: r.error })); },
    single() { return q.maybeSingle(); },
    then(resolve, reject) {
      let rows = db[table] || [];
      if (inF) rows = rows.filter(r => inF.vals.includes(String(r[inF.col])));
      eqs.forEach(f => { rows = rows.filter(r => String(r[f.col]) === String(f.v)); });
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
  };
  return q;
}
const fakeSupabase = {
  from(table) {
    return Object.assign(makeQuery(table), {
      update() { return { eq: () => Promise.resolve({ data: null, error: null }) }; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      upsert(rows) {
        const list = Array.isArray(rows) ? rows : [rows];
        const key = table === 'price_history' ? ['product_id', 'mall', 'vendor_item_id', 'recorded_date']
          : table === 'products' ? ['product_id', 'mall'] : ['keyword'];
        db[table] = db[table] || [];
        list.forEach(r => {
          const i = db[table].findIndex(x => key.every(k => String(x[k] || '') === String(r[k] || '')));
          if (i > -1) db[table][i] = { ...db[table][i], ...r };
          else db[table].push(table === 'products' ? { mall_label: '', ...r } : { ...r });
        });
        return Promise.resolve({ data: list, error: null });
      }
    });
  },
  storage: {
    from(bucket) {
      return {
        async upload(key, bytes, o) {
          store.uploads.push({ bucket, key, bytes: Buffer.from(bytes), opts: o });
          if (store.failWith) return { data: null, error: { message: store.failWith } };
          if (store.objects.has(`${bucket}/${key}`) && !o.upsert) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
          store.objects.set(`${bucket}/${key}`, Buffer.from(bytes));
          return { data: { path: key }, error: null };
        }
      };
    }
  },
  rpc() { return Promise.resolve({ data: null, error: { message: 'function does not exist' } }); }
};
const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

const IC = require('../api/_imagecache');
const { recordPrices, adpickProductId } = require('../api/_shop');

const LINK = n => `https://biz.adpick.co.kr/r${n}`;
const PID = n => adpickProductId(LINK(n));
const STORE_URL = (n, ext = 'jpg') => `https://unit-test.supabase.co/storage/v1/object/public/product-images/adpick-products/${PID(n)}.${ext}`;
const obs = (n, { image = '', freshImage = '', price = 10000, mallLabel = 'SSG' } = {}) => ({
  productId: PID(n), mall: 'ADPICK', keyword: '테스트', title: `상품 ${n}`, price, oprice: price,
  link: LINK(n), image, freshImage, itemId: '', vendorItemId: '', mallLabel
});
const prod = n => db.products.find(r => r.product_id === PID(n));
const hist = n => db.price_history.filter(r => r.product_id === PID(n));
const save = (list, extra = {}) => recordPrices(list, { label: 't', source: 'collect', cacheImages: true, ...extra });
const quiet = async fn => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };

(async () => {
  console.log('[1] 판정 — 무엇을 저장 대상으로 보는가');
  check('search_img.php?code=숫자 는 임시 주소', IC.isEphemeralAdpickImage(tok(1)));
  check('daumcdn 은 임시가 아니다', !IC.isEphemeralAdpickImage('https://shop2.daumcdn.net/shophow/p/J1.jpg'));
  check('http(비 TLS)·code 없는 주소는 아니다', !IC.isEphemeralAdpickImage(tok(1).replace('https', 'http'))
    && !IC.isEphemeralAdpickImage('https://d2iaagr1j041pi.cloudfront.net/apis/search_img.php'));
  check('현재 사진이 Storage 주소면 다시 받지 않는다', !IC.needsCache(STORE_URL(1), tok(2)));
  check('현재 사진이 daumcdn 이면 건드리지 않는다', !IC.needsCache('https://shop2.daumcdn.net/shophow/p/J1.jpg', tok(2)));
  check('현재 사진이 죽은 토큰/빈 값이면 새 토큰을 저장한다', IC.needsCache(tok(1), tok(2)) && IC.needsCache('', tok(2)));
  check('새 사진이 임시 주소가 아니면 저장하지 않는다', !IC.needsCache('', 'https://shop2.daumcdn.net/x.jpg'));
  check('키는 상품별 고정 · 확장자는 Content-Type', IC.objectKey('abc', 'image/jpeg') === 'adpick-products/abc.jpg'
    && IC.objectKey('abc', 'image/png') === 'adpick-products/abc.png' && IC.objectKey('../x', 'image/jpeg') === '');

  console.log('\n[2] 임시 사진 200 image/jpeg → 원본 그대로 저장 → 카탈로그는 Storage 주소');
  resetAll();
  routes.set('101', { status: 200, type: 'image/jpeg', body: JPEG });
  await quiet(() => save([obs(1, { image: tok(90), freshImage: tok(101) })]));
  check('Storage 에 1회 업로드', store.uploads.length === 1, String(store.uploads.length));
  const up = store.uploads[0] || {};
  check('버킷 product-images · 키 adpick-products/{productId}.jpg', up.bucket === 'product-images' && up.key === `adpick-products/${PID(1)}.jpg`, up.key);
  check('★ 바이트가 원본과 완전히 같다 (리사이즈·재압축 없음)', up.bytes && up.bytes.equals(JPEG));
  check('Content-Type 그대로 · 덮어쓰기 금지(upsert:false)', up.opts && up.opts.contentType === 'image/jpeg' && up.opts.upsert === false);
  check('★ products.image 가 Storage 영구 주소', prod(1) && prod(1).image === STORE_URL(1), prod(1) && prod(1).image);
  check('가격 원장도 정상 기록', hist(1).length === 1);
  check('mall_label 보존 회귀 없음', prod(1).mall_label === 'SSG');

  console.log('\n[3] 같은 상품 재수집 → 다시 받지 않는다');
  routes.set('102', { status: 200, type: 'image/jpeg', body: JPEG });
  const before = net.calls.length;
  await quiet(() => save([obs(1, { image: prod(1).image, freshImage: tok(102), price: 9900 })]));
  check('사진 GET 0회 · 업로드 0회', net.calls.length === before && store.uploads.length === 1);
  check('Storage 주소 유지 · 가격은 갱신', prod(1).image === STORE_URL(1) && prod(1).lprice === 9900);

  console.log('\n[4] 다른 출처의 멀쩡한 사진은 건드리지 않는다');
  resetAll();
  const DAUM = 'https://shop2.daumcdn.net/shophow/p/J37003402468.jpg';
  routes.set('103', { status: 200, type: 'image/jpeg', body: JPEG });
  await quiet(() => save([obs(2, { image: DAUM, freshImage: tok(103) }), obs(3, { image: STORE_URL(3), freshImage: tok(103) })]));
  check('daumcdn 그대로', prod(2).image === DAUM);
  check('기존 Storage 주소 그대로', prod(3).image === STORE_URL(3));
  check('네트워크·업로드 0회', net.calls.length === 0 && store.uploads.length === 0);

  console.log('\n[5] 저장하면 안 되는 응답');
  const cases = [
    ['404', { status: 404, type: 'text/html', body: '' }, 'http_404'],
    ['403', { status: 403, type: 'text/html', body: '' }, 'http_403'],
    ['200 text/html', { status: 200, type: 'text/html; charset=UTF-8', body: HTML }, 'content_type:text/html'],
    ['image/jpeg 라고 우기는 HTML', { status: 200, type: 'image/jpeg', body: HTML }, 'signature_mismatch'],
    ['content-length 3MB', { status: 200, type: 'image/jpeg', body: JPEG, length: 3 * 1024 * 1024 }, 'too_large'],
    ['길이를 숨긴 3MB 본문', { status: 200, type: 'image/jpeg', body: Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)]) }, 'too_large'],
    ['너무 작은 응답', { status: 200, type: 'image/jpeg', body: Buffer.from([0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }, 'too_small'],
    ['네트워크 오류', { throws: true }, 'network:ECONNRESET']
  ];
  for (const [name, route, reason] of cases) {
    resetAll();
    routes.set('200', route);
    const res = await IC.cacheImages([{ productId: PID(4), currentImage: tok(80), freshImage: tok(200) }], { storage: fakeSupabase.storage });
    await quiet(() => save([obs(4, { image: tok(80), freshImage: tok(200) })]));
    check(`${name} → 저장 거부(${reason}) · 사진은 기존 값 그대로(글리프 폴백) · 가격은 기록`,
      res.stats.reasons[reason] === 1 && store.uploads.length === 0 && prod(4).image === tok(80) && hist(4).length === 1,
      JSON.stringify(res.stats.reasons));
  }

  console.log('\n[6] 저장 실패는 가격 수집을 막지 않는다');
  resetAll();
  routes.set('301', { status: 200, type: 'image/jpeg', body: JPEG });
  store.failWith = 'Internal Server Error';
  const r6 = await quiet(() => save([obs(5, { image: tok(81), freshImage: tok(301) })]));
  check('업로드 실패 → 사진 그대로 · 가격·카탈로그 정상', prod(5).image === tok(81) && hist(5).length === 1 && r6.errors.length === 0, JSON.stringify(r6.errors));

  resetAll();
  routes.set('302', { status: 200, type: 'image/jpeg', body: JPEG });
  store.failWith = 'Bucket not found';
  const warns = [];
  const w = console.warn; console.warn = m => warns.push(String(m));
  const l = console.log; console.log = () => {};
  await save([obs(6, { image: '', freshImage: tok(302) }), obs(7, { image: '', freshImage: tok(302) })], { label: 'a' });
  const firstUploads = store.uploads.length;   // 이미 출발한 동시 작업(≤2)은 끝까지 간다
  await save([obs(8, { image: '', freshImage: tok(302) })], { label: 'b' });
  console.warn = w; console.log = l;
  check('버킷 없음 → 이 프로세스의 캐시를 끄고(다음 호출 업로드 0) 경고는 한 번', warns.filter(m => m.includes('버킷')).length === 1 && firstUploads <= 2 && store.uploads.length === firstUploads,
    `warn=${warns.length} uploads=${store.uploads.length}`);
  check('버킷이 없어도 세 상품 가격은 모두 기록', [6, 7, 8].every(n => hist(n).length === 1 && prod(n)));

  resetAll();
  routes.set('303', { status: 200, type: 'image/jpeg', body: JPEG });
  const realCache = IC.cacheImages;
  IC.cacheImages = async () => { throw new Error('boom'); };
  const r6c = await quiet(() => save([obs(9, { image: tok(82), freshImage: tok(303) })]));
  IC.cacheImages = realCache;
  check('캐시 모듈이 throw 해도 가격·카탈로그 저장', hist(9).length === 1 && prod(9) && r6c.errors.length === 0);

  console.log('\n[7] 꺼져 있으면 아무것도 하지 않는다');
  resetAll();
  routes.set('401', { status: 200, type: 'image/jpeg', body: JPEG });
  process.env.ADPICK_IMAGE_CACHE = '';
  await quiet(() => save([obs(10, { image: tok(83), freshImage: tok(401) })]));
  process.env.ADPICK_IMAGE_CACHE = '1';
  check('ADPICK_IMAGE_CACHE 미설정 → GET 0 · 업로드 0', net.calls.length === 0 && store.uploads.length === 0);
  await quiet(() => recordPrices([obs(11, { image: tok(83), freshImage: tok(401) })], { label: 't', source: 'search' }));
  check('검색 경로(cacheImages 없음) → GET 0 (사용자 응답을 기다리게 하지 않는다)', net.calls.length === 0);

  console.log('\n[8] 동시성·시간 상한');
  resetAll();
  for (let i = 0; i < 12; i++) routes.set(String(500 + i), { status: 200, type: i % 2 ? 'image/png' : 'image/jpeg', body: i % 2 ? PNG : JPEG, delayMs: 30 });
  const many = Array.from({ length: 12 }, (_, i) => obs(20 + i, { image: '', freshImage: tok(500 + i) }));
  await quiet(() => save(many));
  check('동시 요청 ≤ 4', net.maxInFlight <= 4 && net.maxInFlight >= 2, String(net.maxInFlight));
  check('12개 모두 저장 · PNG 는 .png 키', store.uploads.length === 12 && prod(21).image === STORE_URL(21, 'png') && prod(20).image === STORE_URL(20));
  resetAll();
  for (let i = 0; i < 6; i++) routes.set(String(600 + i), { status: 200, type: 'image/jpeg', body: JPEG, delayMs: 120 });
  const t0 = Date.now();
  const rb = await IC.cacheImages(Array.from({ length: 6 }, (_, i) => ({ productId: PID(40 + i), currentImage: '', freshImage: tok(600 + i) })),
    { storage: fakeSupabase.storage, concurrency: 1, budgetMs: 200 });
  check('시간 예산을 넘기면 남은 사진은 보류(다음 수집에서 다시)', rb.stats.skipped > 0 && Date.now() - t0 < 600, JSON.stringify(rb.stats));
  resetAll();
  for (let i = 0; i < 5; i++) routes.set(String(700 + i), { status: 200, type: 'image/jpeg', body: JPEG });
  const rc = await IC.cacheImages(Array.from({ length: 5 }, (_, i) => ({ productId: PID(50 + i), currentImage: '', freshImage: tok(700 + i) })),
    { storage: fakeSupabase.storage, maxPerProcess: 2 });
  check('실행당 상한(maxPerProcess)', rc.stats.attempted === 2 && rc.stats.skipped === 3);

  console.log('\n[9] 이미 저장된 객체(DB 쓰기만 실패했던 경우) → 덮지 않고 그 주소를 쓴다');
  resetAll();
  routes.set('801', { status: 200, type: 'image/jpeg', body: JPEG });
  store.objects.set(`product-images/adpick-products/${PID(60)}.jpg`, Buffer.from('first'));
  await quiet(() => save([obs(60, { image: tok(84), freshImage: tok(801) })]));
  check('409 → 원래 객체 유지 · 카탈로그는 그 주소', store.objects.get(`product-images/adpick-products/${PID(60)}.jpg`).toString() === 'first'
    && prod(60).image === STORE_URL(60));

  console.log('\n[10] 수집기 경로 — 이미 받은 응답만 쓴다, ADPICK API 추가 호출 0');
  resetAll();
  routes.set('901', { status: 200, type: 'image/jpeg', body: JPEG });
  db.adpick_search_cache.push({ keyword: '캐시 키워드', req_limit: 20, fetched_at: new Date().toISOString(),
    items: [{ title: '상품 70', price: 15000, photo: tok(901), cpCode: 'x', cpName: 'Hmall', mallLabel: 'Hmall', commissionlink: LINK(70) }] });
  db.products.push({ product_id: PID(70), mall: 'ADPICK', title: '상품 70', keyword: '캐시 키워드', link: LINK(70), image: tok(85), mall_label: 'Hmall', vendor_item_id: '', item_id: '' });
  const { fetchAdpickAll, runMallCollection } = require('./collect-all-prices');
  let seenOpts = null;
  await quiet(async () => {
    const fr = await fetchAdpickAll('캐시 키워드');
    await runMallCollection({
      mallName: 'ADPICK', rows: [db.products[0]], savedState: null, deadlineTs: Date.now() + 5000,
      fetchAllFn: async () => fr, collectedTodayFn: async () => new Set(), cacheHintFn: async () => new Map(),
      recordPricesFn: (o, opts) => { seenOpts = opts; return recordPrices(o, opts); }
    });
  });
  check('수집기가 recordPrices 에 cacheImages:true 를 넘긴다', seenOpts && seenOpts.cacheImages === true);
  check('★ 수집 결과 카탈로그 사진 = Storage 주소', prod(70).image === STORE_URL(70), prod(70).image);
  check('★ ADPICK 검색 API 호출 0회 · 외부 요청은 사진 주소 GET 1회뿐',
    net.adpickApi === 0 && net.calls.length === 1 && net.calls[0] === tok(901), JSON.stringify(net.calls));
  check('mall_label 보존 회귀 없음', prod(70).mall_label === 'Hmall');

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
