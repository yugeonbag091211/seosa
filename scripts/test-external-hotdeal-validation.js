#!/usr/bin/env node
'use strict';

/*
 * External Hotdeal Radar — validation regression.
 *
 *   A. 뽐뿌 RSS adapter: fixture parse, malformed/missing fields, URL/id dedupe, timezone
 *   B. Provider failure: timeout, 429, 5xx retry budget, local rate limit, registry isolation
 *   C. Matching audit: must-not-match pairs from the 2026-09-13 probe, identifier namespaces
 *   D. Deal score audit: suspicious drop, thin/stale history, spike, conditional/member/range
 *      prices, shipping, cross-mall reference, verification reasons
 *   E. Collector: shadow default, public policy, cross-source grouping with stored rows,
 *      vendorItemId history guard, dry-run before migration, degraded source
 *
 * Fully offline: no network, no Supabase.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request) {
  if (request === supabasePath || /(^|\/)_supabase$/.test(request)) {
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        return () => { throw new Error(`offline test touched real Supabase (${String(prop)})`); };
      }
    });
  }
  return realLoad.apply(this, arguments);
};
global.fetch = async url => { throw new Error(`offline test made a network request: ${url}`); };

const Collector = require('./collect-external-hotdeals');
// 사진 검사는 네트워크 없이 — 픽스처의 https 사진은 열린다고 본다. 죽은 사진 판정은 전용 테스트가 주입한다.
Collector._setImageProbe(async url => (Collector.safeImageUrl(url) ? { ok: true, status: 200, reason: 'ok' } : { ok: false, status: 0, reason: 'invalid-url' }));
const registry = require('../api/_hotdeal-sources/registry');
const ppomppu = require('../api/_hotdeal-sources/adapters/ppomppu');
const Normalize = require('../api/_hotdeal-sources/normalize');
const Radar = require('../api/_external-hotdeal');

const ENV_KEYS = ['EXTERNAL_HOTDEAL_PPOMPPU_ENABLED', 'EXTERNAL_HOTDEAL_MOCK', 'EXTERNAL_HOTDEAL_SHADOW',
  'EXTERNAL_HOTDEAL_PUBLIC_SOURCES', 'EXTERNAL_HOTDEAL_PUBLIC'];
// The collector loads .env.local; tests must not inherit operator switches.
ENV_KEYS.forEach(key => { delete process.env[key]; });

const NOW = Date.parse('2026-09-14T03:00:00Z');
const TODAY = '2026-09-14';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (error) { failures.push(name); console.log(`  [FAIL] ${name}\n         ${error && error.message}`); }
}
function section(title) { console.log(`\n[${title}]`); }

/* ── fixture: synthetic items in the observed 뽐뿌 RSS 2.0 shape ─────────── */
const FIXTURE = `<?xml version="1.0" encoding="UTF-8" ?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
<channel>
<title>뽐뿌게시판</title>
<link>http://www.ppomppu.co.kr/zboard/zboard.php?id=ppomppu</link>
<item>
<title>[쿠팡] 코카콜라 제로 355ml 24캔 (17,900원/무료)</title>
<link>http://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&amp;no=900001</link>
<description>본문은 읽지 않는다</description>
<author>someone</author>
<pubDate>Mon, 14 Sep 2026 02:10:00 GMT</pubDate>
</item>
<item>
<title><![CDATA[[롯데온] 펩시 제로 라임 355ml 48캔 (27,790원/무배)]]></title>
<link>https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&amp;no=900002</link>
<pubDate>Mon, 14 Sep 2026 10:30:00 +0900</pubDate>
</item>
<item>
<title>[네이버] 햇반 210g 24개 (21,900원/3,000원)</title>
<link>http://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&amp;no=900003</link>
<pubDate>Mon, 14 Sep 2026 01:00:00 GMT</pubDate>
</item>
<item>
<title>[11번가] 로지텍 MX Master 3S (89,000원~/무료)</title>
<link>http://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&amp;no=900004</link>
<pubDate>Mon, 14 Sep 2026 00:50:00 GMT</pubDate>
</item>
<item>
<title>[쿠팡] 신라면 120g 40개 (카드 25,900원/와우무료)</title>
<link>http://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&amp;no=900005</link>
<pubDate>Mon, 14 Sep 2026 00:40:00 GMT</pubDate>
</item>
<item>
<title>[옥션] 가격 없는 특가 안내</title>
<link>http://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&amp;no=900006</link>
<pubDate>Mon, 14 Sep 2026 00:30:00 GMT</pubDate>
</item>
<item>
<title>[종료][쿠팡] 에어팟 프로 2 (199,000원/무료)</title>
<link>http://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&amp;no=900007</link>
<pubDate>Mon, 14 Sep 2026 00:20:00 GMT</pubDate>
</item>
<item>
<title>[G마켓] 링크가 다른 사이트 (9,900원/무료)</title>
<link>https://example.com/zboard/view.php?id=ppomppu&amp;no=900008</link>
<pubDate>Mon, 14 Sep 2026 00:10:00 GMT</pubDate>
</item>
<item>
<title>[G마켓] 날짜가 깨진 글 (9,900원/무료)</title>
<link>http://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&amp;no=900009</link>
<pubDate>어제쯤</pubDate>
</item>
<item>
<title>[쿠팡] 코카콜라 제로 355ml 24캔 (17,900원/무료)</title>
<link>http://ppomppu.co.kr/zboard/view.php?no=900001&amp;id=ppomppu&amp;page=2</link>
<pubDate>Mon, 14 Sep 2026 02:10:00 GMT</pubDate>
</item>
<item>
<title>[알리익스프레스] 블루투스 이어폰 ($19.99/무료)</title>
<link>http://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&amp;no=900011</link>
<pubDate>Mon, 14 Sep 2026 00:05:00 GMT</pubDate>
</item>
<item>
<title>[쿠팡] 링크 없는 글 (9,900원/무료)</title>
<pubDate>Mon, 14 Sep 2026 00:00:00 GMT</pubDate>
</item>
</channel>
</rss>`;

function response(status, body, headers) {
  const h = Object.assign({ 'content-type': 'text/xml; charset=UTF-8' }, headers || {});
  const buf = Buffer.from(body || '', 'utf8');
  return {
    status,
    headers: { get: key => (h[String(key).toLowerCase()] == null ? null : h[String(key).toLowerCase()]) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  };
}

function adapterWith(fetchImpl, over) {
  return new ppomppu.PpomppuRssAdapter(Object.assign({
    fetch: fetchImpl, now: () => NOW, minIntervalMs: 0, retryDelayMs: 0, timeoutMs: 40
  }, over || {}));
}

function hangingFetch(calls) {
  return (url, init) => {
    calls.push(url);
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
}

async function captureFailure(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a failure');
}

(async () => {
  console.log('=== External Hotdeal Radar — validation (offline) ===');

  /* ── A. adapter ─────────────────────────────────────────────────── */
  section('A) 뽐뿌 RSS adapter');
  const calls = [];
  const fixtureAdapter = adapterWith(async url => { calls.push(url); return response(200, FIXTURE); });
  const parsed = await fixtureAdapter.fetch();
  const byId = id => parsed.items.find(it => it.externalId === id);

  await check('1. fixture parse — one GET to the official feed, contract fields present', () => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'https://www.ppomppu.co.kr/rss.php?id=ppomppu');
    assert.equal(parsed.meta.rawCount, 12);
    assert.equal(parsed.items.length, 6);
    const cola = byId('900001');
    assert.deepEqual(Object.keys(cola).sort(),
      ['externalId', 'imageUrl', 'mall', 'metadata', 'postUrl', 'postedAt', 'price', 'productUrl', 'title'].sort());
    assert.equal(cola.title, '코카콜라 제로 355ml 24캔');
    assert.equal(cola.price, 17900);
    assert.equal(cola.mall, '쿠팡');
    assert.equal(cola.postUrl, 'https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&no=900001');
    assert.equal(cola.postedAt, '2026-09-14T02:10:00.000Z');
    assert.equal(cola.metadata.shippingNote, 'free');
  });

  await check('1b. post body and author are never carried', () => {
    const text = JSON.stringify(parsed.items);
    assert(!text.includes('본문은 읽지 않는다'));
    assert(!text.includes('someone'));
  });

  await check('1c. CDATA title, &amp; link, +0900 pubDate → UTC ISO', () => {
    const pepsi = byId('900002');
    assert.equal(pepsi.title, '펩시 제로 라임 355ml 48캔');
    assert.equal(pepsi.postedAt, '2026-09-14T01:30:00.000Z');
    assert.equal(ppomppu._internal.parsePostedAt('2026-09-14 10:30', NOW), '2026-09-14T01:30:00.000Z', 'zone-less time is KST');
    assert.equal(ppomppu._internal.parsePostedAt('Tue, 15 Sep 2026 03:00:00 GMT', NOW), null, 'future time rejected');
  });

  await check('1d. price qualifiers: shipping fee, from-price, card price, conditional shipping', () => {
    assert.equal(byId('900003').metadata.shippingFee, 3000);
    assert.equal(byId('900003').metadata.shippingNote, 'paid');
    assert.equal(byId('900004').metadata.priceIsFrom, true);
    assert.equal(byId('900005').metadata.priceHasCondition, true);
    assert.equal(byId('900005').metadata.shippingNote, 'conditional');
  });

  await check('2. malformed items are skipped with a reason, never thrown', () => {
    assert.deepEqual(parsed.skipped, {
      missing_price: 1, ended: 1, missing_url: 2, invalid_posted_at: 1, foreign_currency: 1
    });
    const again = ppomppu._internal.parseItem({ title: '', link: '', pubDate: '' }, NOW);
    assert.equal(again.skip, 'missing_title');
  });

  await check('3. missing / ambiguous / implausible price', () => {
    assert.equal(ppomppu._internal.parsePriceGroup('무료나눔').error, 'missing_price');
    assert.equal(ppomppu._internal.parsePriceGroup('1+1 9,900원/무료').error, 'ambiguous_price');
    assert.equal(ppomppu._internal.parsePriceGroup('9/13~').error, 'implausible_price');
    assert.equal(ppomppu._internal.parsePriceGroup('1.2만원/무료').price, 12000);
  });

  await check('4. missing URL or a non-뽐뿌 host is rejected', () => {
    assert.equal(ppomppu._internal.postIdentity(''), null);
    assert.equal(ppomppu._internal.postIdentity('https://example.com/zboard/view.php?id=ppomppu&no=1'), null);
    assert.equal(ppomppu._internal.postIdentity('javascript:alert(1)'), null);
    assert.equal(ppomppu._internal.postIdentity('https://www.ppomppu.co.kr/zboard/view.php?id=freeboard&no=1'), null);
  });

  await check('5/6. duplicate post id and equivalent URL collapse to one row with a stable id', async () => {
    const id = ppomppu._internal.postIdentity('http://ppomppu.co.kr/zboard/view.php?no=900001&id=ppomppu&page=2');
    assert.equal(id.externalId, '900001');
    assert.equal(id.postUrl, byId('900001').postUrl);
    const rows = parsed.items.map(it => Normalize.normalizeExternalHotdeal(it, 'ppomppu'));
    const unique = Normalize.dedupeByCanonicalUrl(rows);
    assert.equal(unique.length, 5);
    assert.equal(unique.filter(r => r.externalId === '900001').length, 1);
    // Same provider id with a different URL must also collapse (one upsert key per batch).
    const a = { source: 's', externalId: '1', canonicalPostUrl: 'https://x/a', price: 100 };
    const b = { source: 's', externalId: '1', canonicalPostUrl: 'https://x/b', price: 90 };
    assert.equal(Normalize.dedupeByCanonicalUrl([a, b]).length, 1);
  });

  await check('20. adapters are disabled by default', () => {
    assert.equal(ppomppu.enabled(), false);
    assert.equal(registry.active().length, 0);
  });

  /* ── B. provider failure ───────────────────────────────────────── */
  section('B) provider failure isolation');
  await check('17. timeout → kind=timeout, no retry', async () => {
    const seen = [];
    const error = await captureFailure(adapterWith(hangingFetch(seen)).fetch());
    assert.equal(error.kind, 'timeout');
    assert.equal(seen.length, 1);
  });

  await check('18a. 429 → kind=http_429, no retry', async () => {
    let n = 0;
    const error = await captureFailure(adapterWith(async () => { n++; return response(429, ''); }).fetch());
    assert.equal(error.kind, 'http_429');
    assert.equal(error.httpStatus, 429);
    assert.equal(n, 1);
  });

  await check('18b. 5xx → exactly one retry, then success or http_5xx', async () => {
    let n = 0;
    const flaky = adapterWith(async () => (++n === 1 ? response(503, '') : response(200, FIXTURE)));
    const ok = await flaky.fetch();
    assert.equal(n, 2);
    assert.equal(ok.meta.attempts, 2);
    let m = 0;
    const error = await captureFailure(adapterWith(async () => { m++; return response(502, ''); }).fetch());
    assert.equal(error.kind, 'http_5xx');
    assert.equal(m, 2);
  });

  await check('18c. non-RSS body → kind=parse; local rate limit blocks a second call', async () => {
    const error = await captureFailure(adapterWith(async () => response(200, '<html>login</html>')).fetch());
    assert.equal(error.kind, 'parse');
    let n = 0;
    const limited = adapterWith(async () => { n++; return response(200, FIXTURE); }, { minIntervalMs: 60000 });
    await limited.fetch();
    const second = await captureFailure(limited.fetch());
    assert.equal(second.kind, 'local_rate_limit');
    assert.equal(n, 1);
  });

  await check('17b. registry: a timed-out source is degraded while another source still delivers', async () => {
    const live = registry.get('ppomppu');
    const mock = registry.get('mock-hotdeal');
    const saved = { fetchImpl: live.fetchImpl, timeoutMs: live.timeoutMs, minIntervalMs: live.minIntervalMs, lastRequestAt: live.lastRequestAt, items: mock.items };
    process.env.EXTERNAL_HOTDEAL_PPOMPPU_ENABLED = '1';
    process.env.EXTERNAL_HOTDEAL_MOCK = '1';
    live.fetchImpl = hangingFetch([]);
    live.timeoutMs = 30;
    live.minIntervalMs = 0;
    live.lastRequestAt = 0;
    mock.items = [{ externalId: 'm1', title: '테스트 상품 500ml', price: 1000, postUrl: 'https://feed.example/m1', postedAt: '2026-09-14T00:00:00Z' }];
    try {
      const result = await registry.fetchAll({});
      assert.equal(result.items.length, 1);
      const liveStat = result.sources.find(s => s.source === 'ppomppu');
      assert.equal(liveStat.status, 'degraded');
      assert.equal(liveStat.errorKind, 'timeout');
      assert.equal(result.sources.find(s => s.source === 'mock-hotdeal').status, 'ok');
      assert.equal(result.errors.length, 1);
    } finally {
      delete process.env.EXTERNAL_HOTDEAL_PPOMPPU_ENABLED;
      delete process.env.EXTERNAL_HOTDEAL_MOCK;
      Object.assign(live, { fetchImpl: saved.fetchImpl, timeoutMs: saved.timeoutMs, minIntervalMs: saved.minIntervalMs, lastRequestAt: saved.lastRequestAt });
      mock.items = saved.items;
    }
  });

  await check('17c. registry counts fetched / skipped / duplicates per source', async () => {
    const live = registry.get('ppomppu');
    const saved = { fetchImpl: live.fetchImpl, minIntervalMs: live.minIntervalMs, lastRequestAt: live.lastRequestAt, now: live.now };
    process.env.EXTERNAL_HOTDEAL_PPOMPPU_ENABLED = '1';
    Object.assign(live, { fetchImpl: async () => response(200, FIXTURE), minIntervalMs: 0, lastRequestAt: 0, now: () => NOW });
    try {
      const result = await registry.fetchAll({});
      const stat = result.sources[0];
      assert.equal(stat.fetched, 12);
      assert.equal(stat.normalized, 6);
      assert.equal(stat.duplicates, 1);
      assert.equal(result.items.length, 5);
      assert.equal(stat.httpStatus, 200);
    } finally {
      delete process.env.EXTERNAL_HOTDEAL_PPOMPPU_ENABLED;
      Object.assign(live, saved);
    }
  });

  /* ── C. matching ────────────────────────────────────────────────── */
  section('C) matching audit');
  const MUST_NOT_MATCH = [
    ['7. count', '코카콜라 355ml 24캔', '코카콜라 355ml 48캔'],
    ['7. count (one side only)', '닭가슴살 500g', '닭가슴살 500g 4개'],
    ['7. count (one side only)', '동아제약 가그린 오리지널 750ml 4개', '동아제약 가그린 오리지널 750ml'],
    ['8. volume', '다우니 섬유유연제 1L', '다우니 섬유유연제 2L'],
    ['8. capacity', '삼성 T7 포터블 SSD 1TB', '삼성 T7 포터블 SSD 2TB'],
    ['9. model grade', 'Apple iPhone 15 128GB', 'Apple iPhone 15 Pro 128GB'],
    ['9. model variant', 'MSI 지포스 RTX 5070 벤투스 2X OC', 'MSI 지포스 RTX 5070 Ti 벤투스 2X OC'],
    ['9. model variant', '이엠텍 RTX 5070 블랙', '이엠텍 RTX 5070 Ti 블랙'],
    ['9. model variant', '닌텐도 스위치 OLED', '닌텐도 스위치 2'],
    ['10. generation', 'Apple AirPods Pro 2', 'Apple AirPods 4'],
    ['10. generation', '아이패드 에어 5세대', '아이패드 에어 6세대'],
    ['10. year', 'LG 그램 16 2024', 'LG 그램 16 2025'],
    ['11. accessory', '갤럭시 S24 256GB', '갤럭시 S24 256GB 강화유리 필름'],
    ['11. accessory', '로지텍 MX Master 3S', '로지텍 MX Master 3S 전용 파우치'],
    ['11. refill', '다우니 섬유유연제 2L 본품', '다우니 섬유유연제 2L 리필'],
    ['11. bundle', '닌텐도 스위치 2', '닌텐도 스위치 2 마리오카트 번들'],
    ['11. accessory', '아이폰 15 케이스', 'Apple 아이폰 15 128GB'],
    // Shapes taken from the real-catalog mutation/collision audit (titles shortened).
    ['8. capacity, one value shared', '오멘 16 라이젠AI7 RTX5060 64G/1TB 게이밍 노트북', '오멘 16 라이젠AI7 RTX5060 32G/1TB 게이밍 노트북'],
    ['8. pack size with total', '하루견과 구운아몬드 1000g x 2봉 (총2kg)', '하루견과 구운아몬드 500g x 2봉 (총1kg)'],
    ['7. extra count unit', '깨끗한나라 데일리 천연펄프 키친타월 8개', '깨끗한나라 데일리 천연펄프 키친타월 150매 8개'],
    ['9. model, one code shared', '삼성 갤럭시북 프로 NT951XDB i7-2330G7 16GB', '삼성 갤럭시북 프로 NT951XDB i7-1165G7 16GB'],
    ['9. spec code is not a model', '제이노브 IPX8 클래식 핸드폰 방수팩', '히키스 스마트폰 터치 투명 IPX8 방수팩 워터파크'],
    ['option flavor', 'SP스포츠 식물성 단백질쉐이크 흑임자맛 1.2kg x 3개', 'SP스포츠 식물성 단백질쉐이크 무맛 1.2kg x 3개'],
    ['7. multi-item bundle counts', '농심 안성탕면 20개 + 삼양라면 10개', '농심 안성탕면 10개 + 삼양라면 10개'],
    ['7. bare multiplier', '우르오스 올인원 스킨밀크 200ml x2', '우르오스 올인원 스킨밀크 200ml'],
    ['7. total is the only count', '화과방 더알찬통단팥 3kg(캔),총8개 빙수팥', '화과방 더알찬통단팥 3kg(캔),총4개 빙수팥']
  ];
  for (const [label, deal, stored] of MUST_NOT_MATCH) {
    await check(`${label}: "${deal}" ≠ "${stored}"`, () => {
      const forward = Radar.matchProduct({ title: deal }, [{ product_id: 'p', title: stored }]);
      const reverse = Radar.matchProduct({ title: stored }, [{ product_id: 'p', title: deal }]);
      assert.equal(forward.product, null, `${forward.confidence} ${forward.reason}`);
      assert.equal(reverse.product, null, `${reverse.confidence} ${reverse.reason}`);
    });
  }

  await check('12. exact model / identical title still match', () => {
    const model = Radar.matchProduct({ title: 'Samsung Galaxy S24 SM-S921N 256GB' },
      [{ product_id: 'p1', title: '삼성 갤럭시 S24 SM-S921N 256GB 자급제' }]);
    assert.equal(model.method, 'model');
    assert(model.confidence >= Radar.HIGH_MATCH_CONFIDENCE);
    const same = Radar.matchProduct({ title: '코카콜라 제로 355ml 24캔' },
      [{ product_id: 'p2', title: '코카콜라 제로 355ml 24캔' }]);
    assert.equal(same.product.product_id, 'p2');
    assert.equal(Radar.matchScore({ title: '신라면 120g 5개입' }, { title: '신라면 120g 5개' }).method === 'conflict', false,
      '5개입 and 5개 are the same count');
    assert(Radar.measurements('이너홈 베이킹소다 2kgx3개').has('2000g'), 'unit followed by an x multiplier');
    const seller = Radar.matchProduct({ title: '삼성 갤럭시 워치 고속 무선 충전기 EP-OL715' },
      [{ product_id: 'p4', title: '삼성 갤럭시 워치 고속 무선 충전기 EP-OL715 (S51853605)' }]);
    assert.equal(seller.method, 'model', 'a seller code on one side only is an omission, not a conflict');
  });

  await check('13. weak title overlap stays below threshold and keeps the candidate only for audit', () => {
    const weak = Radar.matchProduct({ title: '로지텍 무선 마우스 특가' },
      [{ product_id: 'p3', title: '로지텍 MX Master 3S 무선 마우스' }]);
    assert.equal(weak.product, null);
    assert(weak.confidence < Radar.MATCH_THRESHOLD);
    assert.equal(weak.candidate.product_id, 'p3');
  });

  await check('13b. vendorItemId namespace: itemId / productId never count as an option match', () => {
    const itemId = Radar.matchScore({ title: '가 상품', productUrl: 'https://www.coupang.com/vp/products/9?itemId=777' },
      { title: '나 상품', mall: '쿠팡', vendor_item_id: '777' });
    assert(itemId.confidence < Radar.MATCH_THRESHOLD, JSON.stringify(itemId));
    const productLevel = Radar.matchScore({ title: '삼성 갤럭시 S24 256GB', productUrl: 'https://www.coupang.com/vp/products/123' },
      { title: '삼성 갤럭시 S24 256GB', mall: '쿠팡', vendor_item_id: '900', link: 'https://www.coupang.com/vp/products/123' });
    assert.notEqual(productLevel.method, 'url');
    const conflict = Radar.matchScore({ title: '삼성 갤럭시 S24 256GB', productUrl: 'https://www.coupang.com/vp/products/123?vendorItemId=555' },
      { title: '삼성 갤럭시 S24 256GB', mall: '쿠팡', vendor_item_id: '900' });
    assert.equal(conflict.method, 'conflict');
    const exact = Radar.matchScore({ title: '다른 표기', mall: '쿠팡', productUrl: 'https://www.coupang.com/vp/products/123?vendorItemId=900' },
      { title: '삼성 갤럭시 S24 256GB', mall: '쿠팡', vendor_item_id: '900' });
    assert.equal(exact.method, 'mall-id');
  });

  /* ── D. score ───────────────────────────────────────────────────── */
  section('D) deal score audit');
  const product = { product_id: 'p1', title: '코카콜라 제로 355ml 24캔', mall: '쿠팡', vendor_item_id: 'v1' };
  const exactMatch = { product, confidence: 1, method: 'url', reason: 'url' };
  const daily = (count, price, endDay, overrides) => Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.parse(`${endDay}T00:00:00Z`) - (count - 1 - i) * 86400000).toISOString().slice(0, 10);
    return { date: d, price: overrides && overrides[i] != null ? overrides[i] : price };
  });
  const deal = (price, over) => Object.assign({ title: product.title, price, mall: '쿠팡', metadata: {} }, over || {});

  await check('baseline: a clean 28% drop on 14 days of history is a strong deal with positive reasons', () => {
    const v = Radar.verifyDeal(deal(17900), exactMatch, daily(14, 25000, TODAY), TODAY);
    assert.equal(v.verificationStatus, 'STRONG_DEAL');
    for (const code of ['HIGH_MATCH_CONFIDENCE', 'BELOW_30D_AVG', 'NEW_90D_LOW']) assert(v.reasons.includes(code), code);
  });

  await check('14. 50%+ drop (typo, wrong option, per-unit price) → SUSPICIOUS_PRICE, score 0', () => {
    const v = Radar.verifyDeal(deal(1790), exactMatch, daily(14, 25000, TODAY), TODAY);
    assert.equal(v.verificationStatus, 'SUSPICIOUS_PRICE');
    assert.equal(v.dealScore, 0);
    assert(v.reasons.includes('SUSPICIOUS_DROP'));
  });

  await check('14b. 30–50% under the 90-day low is capped below GOOD_DEAL', () => {
    const v = Radar.verifyDeal(deal(16000), exactMatch, daily(14, 25000, TODAY), TODAY);
    assert(v.reasons.includes('DEEP_BELOW_90D_LOW'));
    assert(v.dealScore <= 74);
  });

  await check('15. history < 3 days → INSUFFICIENT_HISTORY ≤ 49; < 7 days → LOW_HISTORY_COUNT ≤ 74', () => {
    const thin = Radar.verifyDeal(deal(17900), exactMatch, daily(2, 25000, TODAY), TODAY);
    assert.equal(thin.verificationStatus, 'INSUFFICIENT_HISTORY');
    assert(thin.dealScore <= 49);
    const low = Radar.verifyDeal(deal(17900), exactMatch, daily(5, 25000, TODAY), TODAY);
    assert(low.reasons.includes('LOW_HISTORY_COUNT'));
    assert(low.dealScore <= 74);
    const none = Radar.verifyDeal(deal(17900), exactMatch, [], TODAY);
    assert(none.reasons.includes('NO_HISTORY'));
    assert.equal(none.verificationStatus, 'INSUFFICIENT_HISTORY');
    assert(none.dealScore < Radar.EXPOSURE_SCORE, `no history is never exposable: ${none.dealScore}`);
  });

  await check('stale history (last seen 30 days ago) is never exposed', () => {
    const v = Radar.verifyDeal(deal(17900), exactMatch, daily(20, 25000, '2026-08-15'), TODAY);
    assert(v.reasons.includes('STALE_HISTORY'));
    assert(v.dealScore < Radar.EXPOSURE_SCORE);
  });

  await check('spike then return to normal: scored against the median, not the inflated mean, and not called suspicious', () => {
    const spike = daily(25, 100000, TODAY, { 20: 200000, 21: 200000, 22: 200000, 23: 200000, 24: 200000 });
    const v = Radar.verifyDeal(deal(95000), exactMatch, spike, TODAY);
    assert(v.reasons.includes('AVG30_SKEWED_BY_SPIKE'));
    assert(!v.reasons.includes('SUSPICIOUS_DROP'));
    assert(v.priceVs30dAvg > 20, 'the mean says 20%+');
    assert(v.parts.averageDiscount <= 7.5, `scored on the median: ${v.parts.averageDiscount}`);
  });

  await check('coupon/card price → CONDITIONAL_PRICE ≤ 89; member price → ≤ 74; from-price → ≤ 49', () => {
    const history = daily(14, 25000, TODAY);
    const card = Radar.verifyDeal(deal(17900, { metadata: { rawTitle: '[쿠팡] 코카콜라 제로 (카드할인 17,900원/무료)' } }), exactMatch, history, TODAY);
    assert(card.reasons.includes('CONDITIONAL_PRICE'));
    assert(card.dealScore <= 89);
    const member = Radar.verifyDeal(deal(17900, { metadata: { rawTitle: '[쿠팡] 코카콜라 제로 와우회원 전용' } }), exactMatch, history, TODAY);
    assert(member.reasons.includes('MEMBER_ONLY_PRICE'));
    assert(member.dealScore <= 74);
    const from = Radar.verifyDeal(deal(17900, { metadata: { priceIsFrom: true } }), exactMatch, history, TODAY);
    assert(from.reasons.includes('OPTION_PRICE_RANGE'));
    assert(from.dealScore < Radar.EXPOSURE_SCORE);
  });

  await check('shipping fee is added before comparing; unknown shipping is annotated', () => {
    const history = daily(14, 25000, TODAY);
    const free = Radar.verifyDeal(deal(17900), exactMatch, history, TODAY);
    const paid = Radar.verifyDeal(deal(17900, { metadata: { shippingFee: 3000, shippingNote: 'paid' } }), exactMatch, history, TODAY);
    assert.equal(paid.effectivePrice, 20900);
    assert(paid.reasons.includes('SHIPPING_ADDED'));
    assert(paid.priceVs30dAvg < free.priceVs30dAvg);
    const unknown = Radar.verifyDeal(deal(17900, { metadata: { shippingNote: 'conditional' } }), exactMatch, history, TODAY);
    assert(unknown.reasons.includes('SHIPPING_UNKNOWN'));
  });

  await check('a price from another mall is compared with a cap and a reason', () => {
    const v = Radar.verifyDeal(deal(17900, { mall: '11번가' }), exactMatch, daily(14, 25000, TODAY), TODAY);
    assert(v.reasons.includes('CROSS_MALL_REFERENCE'));
    assert(v.dealScore <= 89);
  });

  await check('an unmatched deal is never scored', () => {
    const v = Radar.verifyDeal(deal(17900), { product: null, confidence: 0.7 }, daily(14, 25000, TODAY), TODAY);
    assert.equal(v.dealScore, 0);
    assert.equal(v.verificationStatus, 'UNMATCHED');
  });

  /* ── E. collector ───────────────────────────────────────────────── */
  section('E) collector — shadow, grouping, guards');
  const hoursAgo = h => new Date(NOW - h * 3600000).toISOString();

  function fakeDb(tables, options) {
    const opts = options || {};
    const writes = [];
    const reads = [];
    return {
      writes,
      reads,
      from(table) {
        const filters = [];
        let from = 0, to = Infinity;
        const q = {
          select() { return q; },
          order() { return q; },
          in(col, values) { filters.push(r => values.map(String).includes(String(r[col]))); return q; },
          gte(col, value) { filters.push(r => String(r[col]) >= String(value)); return q; },
          range(a, b) { from = a; to = b; return q; },
          upsert(rows, conflict) { writes.push({ table, rows, conflict }); return Promise.resolve({ error: null }); },
          then(resolve) {
            reads.push(table);
            if (opts.missing && opts.missing.includes(table)) {
              resolve({ data: null, error: { message: `relation "public.${table}" does not exist` } });
              return;
            }
            if (opts.transient && opts.transient.includes(table)) {
              resolve({ data: null, error: { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' } });
              return;
            }
            resolve({ data: (tables[table] || []).filter(r => filters.every(f => f(r))).slice(from, to + 1), error: null });
          }
        };
        return q;
      }
    };
  }

  const colaDeal = Normalize.normalizeExternalHotdeal({
    externalId: '900001', title: '코카콜라 제로 355ml 24캔', price: 17900, mall: '쿠팡',
    postUrl: 'https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&no=900001', postedAt: hoursAgo(1),
    metadata: { board: 'ppomppu', shippingFee: 0, shippingNote: 'free', rawTitle: '[쿠팡] 코카콜라 제로 355ml 24캔 (17,900원/무료)' }
  }, 'ppomppu');
  const fakeRegistry = items => ({
    fetchAll: async () => ({
      items,
      errors: [],
      sources: [{ source: 'ppomppu', kind: 'rss', status: 'ok', errorKind: null, httpStatus: 200, attempts: 1,
        latencyMs: 5, fetched: items.length, normalized: items.length, duplicates: 0, skipped: {} }]
    }),
    active: () => []
  });

  const history = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10);
    history.push({ product_id: 'p1', mall: '쿠팡', vendor_item_id: 'v1', price: 25000, recorded_date: date });
    // Another option of the same product and another mall must not leak into p1/v1's history.
    history.push({ product_id: 'p1', mall: '쿠팡', vendor_item_id: 'v2', price: 9000, recorded_date: date });
    history.push({ product_id: 'p1', mall: '11번가', vendor_item_id: '', price: 8000, recorded_date: date });
  }
  const baseTables = () => ({
    products: [
      { product_id: 'p1', vendor_item_id: 'v1', mall: '쿠팡', title: '코카콜라 제로 355ml 24캔', link: '' },
      { product_id: 'p2', vendor_item_id: 'v9', mall: '쿠팡', title: '코카콜라 제로 355ml 48캔', link: '' }
    ],
    price_history: history.slice(),
    external_hotdeals: [
      { id: 7, source: 'ruliweb', source_post_id: '555', matched_product_id: 'p1', title: '코카콜라 제로 24캔', price: 18200,
        posted_at: hoursAgo(3), deal_score: 70, verification_status: 'INTEREST', match_confidence: 0.94,
        product_url: '', is_primary: true, is_exposed: false, sources: ['ruliweb'], source_count: 1, group_key: 'old' },
      { id: 8, source: 'clien', source_post_id: '777', matched_product_id: 'p1', title: '코카콜라 제로 24캔', price: 24000,
        posted_at: hoursAgo(2), deal_score: 40, verification_status: 'NOT_QUALIFIED', match_confidence: 0.94,
        product_url: '', is_primary: true, is_exposed: false, sources: ['clien'], source_count: 1, group_key: 'old2' },
      { id: 9, source: 'ruliweb', source_post_id: '111', matched_product_id: 'p1', title: '오래된 글', price: 17900,
        posted_at: hoursAgo(100), deal_score: 80, verification_status: 'GOOD_DEAL', match_confidence: 0.94,
        product_url: '', is_primary: true, is_exposed: false, sources: ['ruliweb'], source_count: 1, group_key: 'old3' }
    ]
  });

  let shadowRun;
  await check('19. shadow is the default: verified rows are saved but none is exposed', async () => {
    const db = fakeDb(baseTables());
    shadowRun = { db, summary: await Collector.main({ db, registry: fakeRegistry([colaDeal]), env: {}, now: NOW, today: TODAY, quiet: true }) };
    const { summary } = shadowRun;
    assert.equal(summary.shadow, true);
    assert.equal(summary.verified, 1);
    assert.equal(summary.exposed, 0);
    const written = db.writes.flatMap(w => w.rows);
    assert(written.length > 0);
    assert(written.every(r => r.is_exposed === false));
    assert(db.writes.every(w => w.conflict && w.conflict.onConflict === 'source,source_post_id'));
  });

  await check('vendorItemId + mall guard: only p1/v1 on 쿠팡 feeds the verdict', () => {
    const cola = shadowRun.db.writes.flatMap(w => w.rows).find(r => r.source === 'ppomppu');
    assert.equal(cola.low_90d, 25000);
    assert.equal(cola.history_observation_count, 14);
    assert.equal(cola.verification_status, 'STRONG_DEAL');
    assert.equal(cola.matched_product_id, 'p1');
    assert(Array.isArray(cola.verification_reasons) && cola.verification_reasons.includes('BELOW_30D_AVG'));
  });

  await check('16. cross-source grouping with stored rows: similar price groups, a 25% gap does not, originals kept', () => {
    const rows = shadowRun.db.writes.flatMap(w => w.rows);
    const key = r => `${r.source}|${r.source_post_id}`;
    const byKey = Object.fromEntries(rows.map(r => [key(r), r]));
    assert.equal(rows.length, 3, 'current + two recent rows; the 100h-old row is outside the window');
    assert(!rows.some(r => 'id' in r), 'stored ids are not re-sent');
    const cola = byKey['ppomppu|900001'];
    const ruli = byKey['ruliweb|555'];
    const clien = byKey['clien|777'];
    assert.equal(cola.is_primary, true);
    assert.equal(ruli.is_primary, false);
    assert.equal(cola.group_key, ruli.group_key);
    assert.deepEqual([...cola.sources].sort(), ['ppomppu', 'ruliweb']);
    assert.equal(ruli.source_url === undefined || ruli.source_post_id === '555', true);
    assert.equal(clien.is_primary, true);
    assert.notEqual(clien.group_key, cola.group_key);
    assert.equal(shadowRun.summary.carriedFromDb, 2);
  });

  await check('public policy: exposure needs shadow off AND the source on the allow-list', async () => {
    const allowed = await Collector.main({ db: fakeDb(baseTables()), registry: fakeRegistry([colaDeal]),
      env: { EXTERNAL_HOTDEAL_SHADOW: '0', EXTERNAL_HOTDEAL_PUBLIC_SOURCES: 'ppomppu' }, now: NOW, today: TODAY, quiet: true });
    assert.equal(allowed.exposed, 1);
    const notListed = await Collector.main({ db: fakeDb(baseTables()), registry: fakeRegistry([colaDeal]),
      env: { EXTERNAL_HOTDEAL_SHADOW: '0' }, now: NOW, today: TODAY, quiet: true });
    assert.equal(notListed.exposed, 0);
  });

  await check('affiliate enrichment: strict match only, uses commission/partner link, never source URL', async () => {
    const deal = Normalize.normalizeExternalHotdeal({
      externalId: 'aff-1',
      title: 'Samsung Galaxy S24 SM-S921N 256GB',
      price: 799000,
      mall: '쿠팡',
      postUrl: 'https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&no=999001',
      postedAt: hoursAgo(1),
      metadata: { rawTitle: '[쿠팡] Samsung Galaxy S24 SM-S921N 256GB (799,000원/무료)' }
    }, 'ppomppu');
    const row = {
      source: 'ppomppu',
      source_post_id: '999001',
      source_url: deal.postUrl,
      title: deal.title,
      price: deal.price,
      matched_product_id: null,
      metadata: {}
    };
    let saved = null;
    const affiliate = {
      title: 'Samsung Galaxy S24 SM-S921N 256GB',
      lprice: 799000,
      link: 'https://link.coupang.com/a/seosa-test',
      mall: '쿠팡',
      mallLabel: '쿠팡',
      productId: 's24',
      vendorItemId: '777',
      image: 'https://img.example/s24.jpg',
      _source: 'api'
    };
    const stats = await Collector.enrichAffiliateRows([deal], [row], {
      lookupLimit: 1,
      searchAll: async () => ({ items: [affiliate], from: 'api' }),
      saveProducts: async (keyword, items, opts) => {
        saved = { keyword, items, opts };
        return { saved: 1, errors: [] };
      }
    });
    assert.equal(stats.attempted, 1);
    assert.equal(stats.searches, 1);
    assert.equal(stats.matched, 1);
    assert.equal(row.metadata.affiliateUrl, affiliate.link);
    assert.equal(row.metadata.affiliateProductId, 's24');
    assert(row.metadata.affiliateConfidence >= 0.9);
    assert.equal(row.image_url, 'https://img.example/s24.jpg', '정확 매칭은 제휴상품 사진도 저장');
    assert.equal(row.metadata.imageProductId, 's24');
    assert.equal(row.source_url, deal.postUrl, 'community source remains attribution/source, not commerce destination');
    assert.equal(row.matched_product_id, 's24');
    assert(saved && saved.items.length === 1);
    assert.equal(saved.opts.source, 'external-hotdeal');
  });

  await check('affiliate enrichment: preserves SKU specs and retries with alternate search phrases', async () => {
    const deal = Normalize.normalizeExternalHotdeal({
      externalId: 'aff-retry',
      title: '에브리워터 무라벨 500ml 40개 77%할인',
      price: 4400,
      mall: '쿠팡',
      postUrl: 'https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&no=999003',
      postedAt: hoursAgo(1),
      metadata: { rawTitle: '[쿠팡] 에브리워터 무라벨 500ml 40개 77%할인 (4,400원/무료)' }
    }, 'ppomppu');
    const queries = Collector.affiliateSearchQueries(deal);
    assert(queries.length >= 2);
    assert(queries[0].includes('500ml'), queries[0]);
    assert(queries[0].includes('40개'), queries[0]);
    assert(!queries[0].includes('77%'), queries[0]);

    const row = { source: 'ppomppu', source_post_id: '999003', source_url: deal.postUrl,
      title: deal.title, price: deal.price, matched_product_id: null, metadata: {} };
    const wrong = {
      title: '에브리워터 무라벨 500ml 20개',
      lprice: 5900, link: 'https://link.coupang.com/a/wrong-water',
      mall: '쿠팡', productId: 'water20', vendorItemId: '20', _source: 'api'
    };
    const right = {
      title: '에브리워터 무라벨 500ml 40개',
      lprice: 4900, link: 'https://link.coupang.com/a/right-water',
      mall: '쿠팡', productId: 'water40', vendorItemId: '40', _source: 'api'
    };
    let calls = 0;
    const stats = await Collector.enrichAffiliateRows([deal], [row], {
      lookupLimit: 1,
      searchLimit: 3,
      searchAll: async () => ({ items: [++calls === 1 ? wrong : right], from: 'api' }),
      saveProducts: async () => ({ saved: 1, errors: [] })
    });
    assert.equal(calls, 2, '첫 검색 실패 후 두 번째 검색어로 재시도');
    assert.equal(stats.searches, 2);
    assert.equal(stats.matched, 1);
    assert.equal(row.metadata.affiliateUrl, right.link);
    assert.equal(row.metadata.affiliateSearchQuery, queries[1]);
  });

  await check('affiliate enrichment: ADPICK is called only on the first query while Coupang retries', async () => {
    const deal = Normalize.normalizeExternalHotdeal({
      externalId: 'aff-budget',
      title: '테스트브랜드 ABC123 500ml 20개 50%할인',
      price: 10000,
      mall: '쿠팡',
      postUrl: 'https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&no=999004',
      postedAt: hoursAgo(1),
      metadata: { rawTitle: '[쿠팡] 테스트브랜드 ABC123 500ml 20개 50%할인 (10,000원/무료)' }
    }, 'ppomppu');
    const row = { source: 'ppomppu', source_post_id: '999004', source_url: deal.postUrl,
      title: deal.title, price: deal.price, matched_product_id: null, metadata: {} };
    const wrong = {
      title: '테스트브랜드 ABC999 500ml 20개',
      lprice: 10000, link: 'https://link.coupang.com/a/wrong-budget',
      mall: '쿠팡', productId: 'wrong-budget', vendorItemId: '1', _source: 'api'
    };
    const right = {
      title: '테스트브랜드 ABC123 500ml 20개',
      lprice: 10000, link: 'https://link.coupang.com/a/right-budget',
      mall: '쿠팡', productId: 'right-budget', vendorItemId: '2', _source: 'api'
    };
    let coupangCalls = 0, adpickCalls = 0;
    const stats = await Collector.enrichAffiliateRows([deal], [row], {
      lookupLimit: 1,
      searchLimit: 3,
      fetchCoupang: async () => ({ items: [++coupangCalls === 1 ? wrong : right], from: 'api' }),
      fetchAdpick: async () => { adpickCalls++; return { items: [], from: 'api' }; },
      saveProducts: async () => ({ saved: 1, errors: [] })
    });
    assert.equal(coupangCalls, 2);
    assert.equal(adpickCalls, 1, 'ADPICK은 전체 제목 검색 한 번만 호출');
    assert.equal(stats.matched, 1);
    assert.equal(row.metadata.affiliateUrl, right.link);
  });

  await check('external image: identity-B candidate may supply photo without becoming an affiliate match', async () => {
    const deal = Normalize.normalizeExternalHotdeal({
      externalId: 'img-1',
      title: '푸마 코트 클래식 클린 스니커즈',
      price: 35160,
      mall: '쿠팡',
      postUrl: 'https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&no=999005',
      postedAt: hoursAgo(1),
      metadata: { rawTitle: '[쿠팡] 푸마 코트 클래식 클린 스니커즈 (35,160원/무료)' }
    }, 'ppomppu');
    const row = { source: 'ppomppu', source_post_id: '999005', source_url: deal.postUrl,
      title: deal.title, price: deal.price, matched_product_id: null, image_url: '', metadata: {} };
    const visual = {
      title: '푸마 코트 클래식 클린 스니커즈 운동화',
      lprice: 35900,
      link: 'https://link.coupang.com/a/puma-photo',
      image: 'https://img.example/puma.jpg',
      mall: '쿠팡', productId: 'puma-photo', vendorItemId: 'puma-v1', _source: 'api'
    };
    const stats = await Collector.enrichAffiliateRows([deal], [row], {
      lookupLimit: 1,
      searchLimit: 3,
      searchAll: async () => ({ items: [visual], from: 'api' }),
      saveProducts: async () => { throw new Error('0.82 image-only match must not be saved as affiliate'); }
    });
    assert.equal(stats.matched, 0, '0.82 photo match is below affiliate 0.90 threshold');
    assert.equal(row.matched_product_id, null);
    assert.equal(row.metadata.affiliateUrl, undefined);
    assert.equal(row.image_url, 'https://img.example/puma.jpg');
    assert.equal(row.metadata.imageProductId, 'puma-photo');
    assert(Number(row.metadata.imageMatchConfidence) >= 0.70);
    assert.equal(row.metadata.imageReference, true, '0.90 미만 사진은 참고 이미지로 표시');
  });

  await check('external image: identity-partial photo is allowed but still cannot monetize', async () => {
    const deal = Normalize.normalizeExternalHotdeal({
      externalId: 'img-2',
      title: '푸마 코트 클래식 클린 스니커즈',
      price: 35160,
      mall: '쿠팡',
      postUrl: 'https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&no=999006',
      postedAt: hoursAgo(1),
      metadata: { rawTitle: '[쿠팡] 푸마 코트 클래식 클린 스니커즈 (35,160원/무료)' }
    }, 'ppomppu');
    const row = { source: 'ppomppu', source_post_id: '999006', source_url: deal.postUrl,
      title: deal.title, price: deal.price, matched_product_id: null, image_url: '', metadata: {} };
    const visual = {
      title: '푸마 코트 클래식 클린 스니커즈 남녀공용 운동화 신발 캐주얼 데일리',
      lprice: 35900,
      link: 'https://link.coupang.com/a/puma-photo-partial',
      image: 'https://img.example/puma-partial.jpg',
      mall: '쿠팡', productId: 'puma-photo-partial', vendorItemId: 'puma-v2', _source: 'api'
    };
    const stats = await Collector.enrichAffiliateRows([deal], [row], {
      lookupLimit: 1,
      searchLimit: 1,
      searchAll: async () => ({ items: [visual], from: 'api' }),
      saveProducts: async () => { throw new Error('reference photo must not be saved as affiliate'); }
    });
    assert.equal(stats.matched, 0);
    assert.equal(row.metadata.affiliateUrl, undefined);
    assert.equal(row.image_url, 'https://img.example/puma-partial.jpg');
    assert.equal(row.metadata.imageReference, true);
    assert(Number(row.metadata.imageMatchConfidence) >= 0.70);
  });

  await check('external image: full-title search fallback picks a relevant photo and rejects unrelated photos', () => {
    const deal = {
      title: '명품 차량용 방향제 고급 블랙체리 100ml 1개',
      mall: '쿠팡'
    };
    const good = {
      title: '차량용 방향제 블랙체리 디퓨저 100ml 1개',
      image: 'https://img.example/diffuser.jpg',
      mall: '쿠팡',
      productId: 'diffuser',
      vendorItemId: 'v1',
      link: 'https://link.coupang.com/a/diffuser',
      lprice: 5900
    };
    const bad = {
      title: '헤어왁스 100ml 1개',
      image: 'https://img.example/wax.jpg',
      mall: '쿠팡',
      productId: 'wax',
      vendorItemId: 'v2',
      link: 'https://link.coupang.com/a/wax',
      lprice: 4900
    };
    const picked = Collector.referenceImageCandidate(deal, [bad, good]);
    assert(picked);
    assert.equal(picked.item.productId, 'diffuser');
    assert.equal(picked.image, 'https://img.example/diffuser.jpg');
    assert(picked.confidence < 0.70, 'fallback photo never upgrades product identity');
    assert.equal(Collector.referenceImageCandidate(deal, [bad]), null);
  });

  await check('external image: reference photo may come from another mall without changing commerce identity', () => {
    const deal = {
      title: '명품 차량용 방향제 고급 블랙체리 100ml 1개',
      mall: '네이버'
    };
    const coupangPhoto = {
      title: '명품 차량용 고급 송풍구 방향제 100ml 1개 블랙체리',
      image: 'https://img.example/car-diffuser.jpg',
      mall: '쿠팡',
      mallLabel: '쿠팡',
      productId: 'cross-mall-photo',
      vendorItemId: 'v3',
      link: 'https://link.coupang.com/a/cross-mall-photo',
      lprice: 36000
    };
    const picked = Collector.referenceImageCandidate(deal, [coupangPhoto]);
    assert(picked, '판매처가 달라도 같은 상품 계열의 참고 사진은 쓸 수 있다');
    assert.equal(picked.item.productId, 'cross-mall-photo');
    assert(picked.confidence < 0.70, '교차 몰 참고 사진은 상품 identity/제휴 매칭으로 승격하지 않는다');
  });

  await check('external image: pack-size difference is okay for a labeled reference photo, model conflict is not', () => {
    const foodDeal = { title: '참도깨비 사누끼 포차우동 10인분 + 소스 10봉', mall: '네이버' };
    const foodPhoto = {
      title: '사누끼 포차 우동 4인분 면 4개 소스 4개',
      image: 'https://img.example/udon.jpg',
      mall: 'ADPICK', mallLabel: '오늘의집',
      productId: 'udon-photo', vendorItemId: '',
      link: 'https://example.com/udon', lprice: 10000
    };
    const picked = Collector.referenceImageCandidate(foodDeal, [foodPhoto]);
    assert(picked, '포장 수량이 달라도 같은 우동 상품 계열 사진은 참고용으로 허용');
    assert.equal(picked.item.productId, 'udon-photo');
    assert(picked.confidence < 0.70);

    const modelDeal = { title: 'QCY AilyBuds E10 무선 블루투스 이어폰', mall: 'G마켓' };
    const wrongModel = {
      title: 'QCY AilyBuds T35 무선 블루투스 이어폰',
      image: 'https://img.example/qcy-t35.jpg',
      mall: '쿠팡', productId: 'qcy-t35', vendorItemId: 'v35',
      link: 'https://example.com/qcy-t35', lprice: 20000
    };
    assert.equal(Collector.referenceImageCandidate(modelDeal, [wrongModel]), null,
      '모델 코드가 다르면 참고 이미지도 사용하지 않는다');
  });

  await check('external image: unsafe/non-https image URL is rejected', () => {
    assert.equal(Collector.safeImageUrl('javascript:alert(1)'), '');
    assert.equal(Collector.safeImageUrl('http://img.example/a.jpg'), '');
    assert.equal(Collector.safeImageUrl('https://img.example/a.jpg'), 'https://img.example/a.jpg');
  });

  await check('affiliate enrichment: a merely similar product is never monetized as the same deal', async () => {
    const deal = Normalize.normalizeExternalHotdeal({
      externalId: 'aff-2',
      title: '코카콜라 제로 355ml 24캔',
      price: 17900,
      mall: '쿠팡',
      postUrl: 'https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&no=999002',
      postedAt: hoursAgo(1),
      metadata: { rawTitle: '[쿠팡] 코카콜라 제로 355ml 24캔 (17,900원/무료)' }
    }, 'ppomppu');
    const row = { source: 'ppomppu', source_post_id: '999002', source_url: deal.postUrl,
      title: deal.title, price: deal.price, matched_product_id: null, metadata: {} };
    const wrong = {
      title: '코카콜라 제로 355ml 48캔',
      lprice: 29900,
      link: 'https://link.coupang.com/a/wrong',
      mall: '쿠팡',
      productId: 'wrong',
      vendorItemId: '888',
      _source: 'api'
    };
    const stats = await Collector.enrichAffiliateRows([deal], [row], {
      lookupLimit: 1,
      searchLimit: 3,
      searchAll: async () => ({ items: [wrong], from: 'api' }),
      saveProducts: async () => { throw new Error('wrong candidate must never be saved'); }
    });
    assert.equal(stats.matched, 0);
    assert(stats.searches >= 2, '한 검색어 실패로 포기하지 않는다');
    assert.equal(row.metadata.affiliateUrl, undefined);
    assert.equal(row.matched_product_id, null);
  });

  await check('dry-run before the migration: reads work, nothing is written, table absence is reported', async () => {
    const db = fakeDb(baseTables(), { missing: ['external_hotdeals'] });
    const summary = await Collector.main({ db, registry: fakeRegistry([colaDeal]), env: {}, now: NOW, today: TODAY, dryRun: true, quiet: true });
    assert.equal(db.writes.length, 0);
    assert.equal(summary.tableMissing, true);
    assert.equal(summary.written, 0);
    assert.equal(summary.matched, 1);
    await assert.rejects(Collector.main({ db: fakeDb(baseTables(), { missing: ['external_hotdeals'] }),
      registry: fakeRegistry([colaDeal]), env: {}, now: NOW, today: TODAY, quiet: true }), /external_hotdeals/);
  });

  await check('a transient DB error on external_hotdeals is not reported as a missing table (even in dry-run)', async () => {
    await assert.rejects(Collector.main({ db: fakeDb(baseTables(), { transient: ['external_hotdeals'] }),
      registry: fakeRegistry([colaDeal]), env: {}, now: NOW, today: TODAY, dryRun: true, quiet: true }),
    /external_hotdeals\(read\)/);
  });

  await check('a degraded source ends the run cleanly without touching the database', async () => {
    const db = fakeDb(baseTables());
    const summary = await Collector.main({
      db, env: {}, now: NOW, today: TODAY, quiet: true,
      registry: { fetchAll: async () => ({ items: [], errors: [{ source: 'ppomppu', kind: 'timeout', message: 'x' }],
        sources: [{ source: 'ppomppu', kind: 'rss', status: 'degraded', errorKind: 'timeout', fetched: 0, normalized: 0, duplicates: 0, skipped: {}, latencyMs: 40 }] }) }
    });
    assert.equal(summary.errors, 1);
    assert.equal(summary.written, 0);
    assert.equal(db.reads.length, 0);
    assert.match(Collector.summaryText(summary), /status=degraded error=timeout/);
  });

  await check('observability summary carries every required counter', () => {
    const s = shadowRun.summary;
    for (const key of ['fetched', 'normalized', 'duplicates', 'matched', 'unmatched', 'highConfidence',
      'verified', 'suspicious', 'exposed', 'errors', 'written']) {
      assert(Object.prototype.hasOwnProperty.call(s, key), key);
    }
    const src = s.sources[0];
    for (const key of ['status', 'errorKind', 'httpStatus', 'latencyMs', 'skipped']) {
      assert(Object.prototype.hasOwnProperty.call(src, key), key);
    }
    const sample = Collector.sampleOf(shadowRun.db.writes.flatMap(w => w.rows));
    assert(!JSON.stringify(sample).includes('author'));
  });

  console.log(`\nPASS ${passed}  /  FAIL ${failures.length}`);
  if (failures.length) {
    console.log('failed: ' + failures.join(' | '));
    process.exit(1);
  }
})().catch(error => { console.error(error); process.exit(1); });
