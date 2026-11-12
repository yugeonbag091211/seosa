'use strict';
// AI v3.4 — fast-check property suite over the REAL server pipeline
// (createEngine / validateCandidates / searchCatalog hybrid / rrfFuse /
// priceFreshness). Fixed seeds; every failure is written with its seed, path
// and SHRUNK counterexample to reports/ai-v34-evaluation/fastcheck-failures.json
// so it can be replayed exactly:  fc.check(prop, { seed, path, endOnFailure }).
// No network, DB, GPT or seller API is touched.
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { createEngine } = require('../api/_ai-v3-core');
const { searchCatalog } = require('../api/_ai-v3-catalog');
const { rrfFuse } = require('../api/_ai-v34-fusion');
const { memoryVectorStore, createVectorSearch } = require('../api/_ai-v34-vector');
const { hashEmbedder } = require('../api/_ai-v34-embedding');
const { productDocument } = require('../api/_ai-v34-text');
const { priceFreshness } = require('../api/_ai-v34-freshness');

const NOW = Date.parse('2026-11-06T05:00:00Z');
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const BASE_SEED = Number(process.env.AI_V34_FC_SEED || 20261112);
const RUNS = Number(process.env.AI_V34_FC_RUNS || 0) || null;
let totalRuns = 0;
const results = [], failures = [];

const listing = (id, title, price, extra = {}) => ({ productId: id, title, lprice: price, mall: '쿠팡',
  link: 'https://www.example.org/vp/products/' + id, _source: 'db', collectedAt: iso(NOW - DAY), shippingFee: 0, ...extra });
async function engine({ message, plan, listings, state = {}, decide, now = NOW }) {
  return createEngine({
    planModel: async () => ({ mode: 'recommend', compareQuery: '', exclusions: [], mallOnly: '', exactModel: '', maxPrice: null, ...plan }),
    decideModel: decide || (async ({ candidates }) => ({ productIds: candidates.slice(0, 4).map(c => c.id) })),
    searchProducts: async query => (typeof listings === 'function' ? listings(query) : listings),
    loadDisplayed: async () => (typeof listings === 'function' ? [] : listings),
    now
  }, { message, history: [], state });
}
async function check(name, arbitrary, predicate, numRuns, seedOffset) {
  const seed = BASE_SEED + seedOffset;
  const runs = RUNS || numRuns;
  const out = await fc.check(fc.asyncProperty(arbitrary, predicate), { seed, numRuns: runs, endOnFailure: false });
  totalRuns += out.numRuns;
  const ok = !out.failed;
  results.push({ name, seed, numRuns: out.numRuns, ok });
  if (!ok) {
    failures.push({ name, seed, path: out.counterexamplePath, numRuns: out.numRuns, numShrinks: out.numShrinks,
      counterexample: out.counterexample, error: String(out.errorInstance && out.errorInstance.message || out.error).slice(0, 400) });
    console.log('FAIL ' + name + ' seed=' + seed + ' path=' + out.counterexamplePath + '\n     ' + JSON.stringify(out.counterexample).slice(0, 300));
  } else console.log('PASS ' + name + ' (' + out.numRuns + ' runs, seed ' + seed + ')');
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const FAMILIES = [
  { name: '갤럭시 S25', cat: '스마트폰', variants: ['', '플러스', '울트라', '엣지', 'FE'], price: 1100000 },
  { name: '갤럭시 버즈3', cat: '이어폰', variants: ['', '프로', 'FE'], price: 180000 },
  { name: '아이폰 16', cat: '스마트폰', variants: ['', '프로', '프로 맥스', '플러스', 'e'], price: 1200000 },
  { name: '갤럭시탭 S10', cat: '태블릿', variants: ['', 'FE', 'FE+', '울트라', '플러스'], price: 700000 }
];
const modelTitle = (fam, v) => fam.name + (v === 'e' ? 'e' : v ? ' ' + v : '');

(async () => {
  // 1 + 9. similar-but-different model / base·Pro·Plus·FE·Edge
  await check('1/9 a different variant of the requested model is never a card',
    fc.record({ f: fc.integer({ min: 0, max: FAMILIES.length - 1 }), r: fc.nat(), l: fc.nat(), seller: fc.constantFrom('삼성전자', '[공식]', '') }),
    async ({ f, r, l, seller }) => {
      const fam = FAMILIES[f];
      const want = fam.variants[r % fam.variants.length], have = fam.variants[l % fam.variants.length];
      const title = (seller + ' ' + modelTitle(fam, have) + ' 256GB 자급제 새상품').trim();
      const out = await engine({ message: modelTitle(fam, want) + ' 256GB 찾아줘', plan: { query: modelTitle(fam, want), category: fam.cat },
        listings: [listing('x1', title, fam.price)] });
      if (want !== have) assert(out.cards.length === 0, 'variant ' + JSON.stringify(have) + ' shown for ' + JSON.stringify(want));
    }, 400, 1);

  // 2. option over budget (and «미만» is exclusive)
  await check('2 a listing above the stated budget is never a card',
    fc.record({ max: fc.integer({ min: 20, max: 200 }), price: fc.integer({ min: 10000, max: 2500000 }), lt: fc.boolean() }),
    async ({ max, price, lt }) => {
      const maxWon = max * 10000;
      const out = await engine({ message: max + '만원 ' + (lt ? '미만' : '이하') + ' 무선 마우스', plan: { query: '무선 마우스', category: '마우스' },
        listings: [listing('m1', '로지텍 무선 마우스 M650', price)] });
      for (const c of out.cards) assert(lt ? c.price < maxWon : c.price <= maxWon, 'over budget card ' + c.price + ' > ' + maxWon);
    }, 300, 2);

  // 3. displayed price vs option price: a multi-capacity listing cannot satisfy one capacity
  await check('3 a listing that offers several capacities is not the requested capacity',
    fc.record({ want: fc.constantFrom(128, 256, 512), other: fc.constantFrom(128, 256, 512, 1024), price: fc.integer({ min: 900000, max: 1900000 }) }),
    async ({ want, other, price }) => {
      fc.pre(want !== other);
      const optionTitle = '애플 아이폰 16 프로 ' + Math.min(want, other) + 'GB/' + Math.max(want, other) + 'GB 자급제';
      const out = await engine({ message: '아이폰 16 프로 ' + want + 'GB 찾아줘', plan: { query: '아이폰 16 프로', category: '스마트폰' },
        listings: [listing('o1', optionTitle, price)] });
      assert(out.cards.length === 0, 'multi-option listing accepted as ' + want + 'GB');
    }, 200, 3);

  // 4. shipping-inclusive budget
  await check('4 known shipping that breaks the budget rejects; unknown shipping is flagged',
    fc.record({ max: fc.integer({ min: 5, max: 50 }), under: fc.integer({ min: 0, max: 30000 }), ship: fc.option(fc.integer({ min: 0, max: 8000 }), { nil: null }) }),
    async ({ max, under, ship }) => {
      const maxWon = max * 10000, price = Math.max(1000, maxWon - under);
      const out = await engine({ message: max + '만원 이하 무선 마우스', plan: { query: '무선 마우스', category: '마우스' },
        listings: [listing('s1', '로지텍 무선 마우스 M650', price, { shippingFee: ship })] });
      for (const c of out.cards) {
        if (ship != null) assert(c.price + ship <= maxWon, 'total ' + (c.price + ship) + ' over ' + maxWon);
        else assert(c.budgetStatus === 'listing_only_shipping_unverified' && /배송비/.test(out.answer), 'unknown shipping presented as verified');
      }
    }, 300, 4);

  // 5. stale prices
  await check('5 a DB price older than the display limit (or of unknown age) is never a card',
    fc.record({ ageDays: fc.oneof(fc.integer({ min: 11, max: 400 }), fc.constant(null)), stored: fc.boolean() }),
    async ({ ageDays, stored }) => {
      const extra = { collectedAt: ageDays == null ? '' : iso(NOW - ageDays * DAY), _source: stored ? 'db' : 'stale-cache' };
      const out = await engine({ message: '로지텍 무선 마우스 추천', plan: { query: '로지텍 무선 마우스', category: '마우스' },
        listings: [listing('t1', '로지텍 무선 마우스 M650', 39000, extra)] });
      assert(out.cards.length === 0, 'stale price card shown (age ' + ageDays + ')');
      assert(/가격/.test(out.answer), 'stale-only answer must explain the price problem');
    }, 250, 5);

  // 6. duplicate SKU / re-posted listing
  await check('6 the same SKU or an identical re-post appears at most once',
    fc.record({ copies: fc.integer({ min: 2, max: 6 }), reid: fc.boolean() }),
    async ({ copies, reid }) => {
      const rows = Array.from({ length: copies }, (_, i) => listing(reid ? 'd' + i : 'dup', '로지텍 무선 마우스 M650 그래파이트', 39000));
      const out = await engine({ message: '로지텍 무선 마우스 추천', plan: { query: '로지텍 무선 마우스', category: '마우스' }, listings: rows });
      assert(out.cards.length <= 1, copies + ' copies produced ' + out.cards.length + ' cards');
    }, 150, 6);

  // 7. invalid seller URLs
  await check('7 a non-http(s) or credential-bearing link is never a card',
    fc.constantFrom('javascript:alert(1)', 'data:text/html,hi', 'ftp://example.org/p', 'http://user:pw@example.org/p',
      'https://user@example.org/p', 'not a url', '//example.org/p', 'file:///etc/passwd', ''),
    async link => {
      const out = await engine({ message: '로지텍 무선 마우스 추천', plan: { query: '로지텍 무선 마우스', category: '마우스' },
        listings: [listing('u1', '로지텍 무선 마우스 M650', 39000, { link })] });
      assert(out.cards.length === 0, 'unsafe link reached a card: ' + link);
    }, 120, 7);

  // 8. wired vs wireless
  await check('8 a wired-only listing is never a wireless request card',
    fc.record({ cat: fc.constantFrom(['마우스', '마우스'], ['키보드', '키보드'], ['이어폰', '이어폰'], ['헤드폰', '헤드폰']), brand: fc.constantFrom('로지텍', '삼성', 'QCY', '') }),
    async ({ cat, brand }) => {
      const noun = cat[0];
      const out = await engine({ message: '무선 ' + noun + ' 추천해줘', plan: { query: '무선 ' + noun, category: cat[1] },
        listings: [listing('w1', (brand + ' 유선 ' + noun + ' USB 연결').trim(), 25000)] });
      assert(out.cards.length === 0, 'wired listing shown for a wireless ' + noun);
    }, 150, 8);

  // 10. accessories are not the device
  await check('10 an accessory naming the device is never a device card',
    fc.record({ dev: fc.constantFrom(['갤럭시 S25', '스마트폰', 1100000], ['에어팟 프로 2', '이어폰', 300000], ['아이패드 에어', '태블릿', 900000], ['로지텍 G304', '마우스', 39000]),
      acc: fc.constantFrom('케이스', '강화유리 필름', '이어팁', '충전 케이블', '거치대', '마우스피트', '보호 커버', '키스킨'), price: fc.integer({ min: 3000, max: 40000 }) }),
    async ({ dev, acc, price }) => {
      const out = await engine({ message: dev[0] + ' 찾아줘', plan: { query: dev[0], category: dev[1] },
        listings: [listing('a1', dev[0] + ' 전용 ' + acc, price)] });
      assert(out.cards.length === 0, 'accessory card: ' + dev[0] + ' ' + acc);
    }, 250, 10);

  // 11. comparison never shows one side only
  await check('11 a comparison shows both sides or nothing',
    fc.record({ aOk: fc.boolean(), bOk: fc.boolean() }),
    async ({ aOk, bOk }) => {
      const rows = q => /G304/i.test(q) ? (aOk ? [listing('ca', '로지텍 G304 무선 게이밍 마우스', 39000)] : [])
        // (not «G502 X»: the engine correctly treats G502 X as a different model than G502)
        : (bOk ? [listing('cb', '로지텍 G502 HERO 게이밍 마우스', 69000)] : []);
      const out = await engine({ message: '로지텍 G304랑 G502 비교해줘', plan: { mode: 'compare', query: '로지텍 G304', compareQuery: '로지텍 G502', category: '마우스' }, listings: rows });
      if (aOk && bOk) assert(out.cards.length === 2, 'expected two sides, got ' + out.cards.length);
      else assert(out.cards.length === 0, 'one-sided comparison shown');
    }, 100, 11);

  // 12. conditions survive a follow-up turn
  await check('12 budget, brand exclusion and used-exclusion survive a follow-up',
    fc.record({ max: fc.integer({ min: 3, max: 20 }), follow: fc.constantFrom('다른 것도 보여줘', '더 추천해줘', '흰색으로', '조용한 걸로') }),
    async ({ max, follow }) => {
      const maxWon = max * 10000;
      const rows = [listing('f1', '로지텍 무선 마우스 M650', maxWon - 1000), listing('f2', '삼성 무선 마우스 SM-M170', maxWon - 2000),
        listing('f3', '로지텍 무선 마우스 MX Master 3S', maxWon + 50000), listing('f4', '로지텍 무선 마우스 중고 M650', 5000)];
      const first = await engine({ message: max + '만원 이하 무선 마우스, 삼성은 빼줘', plan: { query: '무선 마우스', category: '마우스', exclusions: ['삼성'] }, listings: rows });
      const second = await engine({ message: follow, plan: { query: '', category: '' }, listings: rows, state: first.state });
      assert(second.state.maxPrice === maxWon, 'budget lost: ' + second.state.maxPrice);
      for (const c of second.cards) {
        assert(c.price <= maxWon, 'follow-up card over the carried budget');
        assert(!/삼성/.test(c.title), 'excluded brand came back');
        assert(!/중고/.test(c.title), 'used listing came back');
      }
    }, 120, 12);

  // 13. the model cannot invent products
  await check('13 IDs that were not server candidates never become cards',
    fc.array(fc.string({ minLength: 1, maxLength: 24 }), { minLength: 1, maxLength: 6 }),
    async fake => {
      const out = await engine({ message: '로지텍 무선 마우스 추천', plan: { query: '로지텍 무선 마우스', category: '마우스' },
        listings: [listing('real', '로지텍 무선 마우스 M650', 39000)], decide: async () => ({ productIds: fake.map(x => '쿠팡:' + x) }) });
      for (const c of out.cards) assert(c.productId === '쿠팡:real', 'invented product ' + c.productId);
    }, 150, 13);

  // 14. seller outage vs real absence (live-first and hybrid)
  await check('14 a provider outage with no stored match is an error, never «no such product»',
    fc.record({ strategy: fc.constantFrom('live-first', 'hybrid'), failure: fc.constantFrom('failed', 'throw', 'stale-cache', 'empty') }),
    async ({ strategy, failure }) => {
      const before = process.env.SEOSA_DB_READONLY; delete process.env.SEOSA_DB_READONLY;
      try {
        const db = { from() { const b = new Proxy({}, { get(_, p) { if (p === 'then') return undefined; if (p === 'limit') return async () => ({ data: [], error: null }); return () => b; } }); return b; } };
        const liveSearch = async () => {
          if (failure === 'throw') throw new Error('timeout');
          if (failure === 'failed') return { failed: true, items: [] };
          if (failure === 'stale-cache') return { items: [{ productId: 'sc', title: '로지텍 무선 마우스 M650', lprice: 30000, mall: '쿠팡', link: 'https://www.example.org/p/sc', _source: 'stale-cache' }] };
          return { items: [] };
        };
        let threw = false, items = [];
        try { items = await searchCatalog('로지텍 무선 마우스', { db, liveSearch, category: '마우스', userText: '로지텍 무선 마우스', searchStrategy: strategy, mapRow: r => r }); }
        catch { threw = true; }
        if (failure === 'empty') assert(!threw && items.length === 0, 'a healthy empty provider must report no result');
        else assert(threw || (items._retrieval && items._retrieval.providerFailed), 'outage reported as absence (' + failure + ')');
      } finally { if (before !== undefined) process.env.SEOSA_DB_READONLY = before; }
    }, 120, 14);

  // 15. hybrid: vector similarity cannot bypass the exact-model filter
  await check('15 hybrid vector candidates never bypass the exact model filter',
    fc.record({ f: fc.integer({ min: 0, max: FAMILIES.length - 1 }), r: fc.nat(), distractors: fc.integer({ min: 1, max: 6 }) }),
    async ({ f, r, distractors }) => {
      const fam = FAMILIES[f];
      const want = fam.variants[r % fam.variants.length];
      const others = fam.variants.filter(v => v !== want);
      const rows = [];
      for (let i = 0; i < distractors; i++) {
        const v = others[i % others.length];
        rows.push({ product_id: 'v' + i, mall: '쿠팡', title: modelTitle(fam, v) + ' 256GB 자급제 정품 새상품 ' + i, lprice: fam.price,
          collected_at: iso(NOW - DAY), keyword: fam.cat, link: 'https://www.example.org/p/v' + i });
      }
      const embedder = hashEmbedder({ dims: 128 });
      const vectors = await embedder.embed(rows.map(r => productDocument(r).text));
      const store = memoryVectorStore(rows.map((row, i) => ({ row, vector: vectors[i] })), { embedderId: embedder.id });
      const vectorSearch = createVectorSearch({ store, embedder, k: 20 });
      const db = { from() { const b = new Proxy({}, { get(_, p) { if (p === 'then') return undefined; if (p === 'limit') return async () => ({ data: [], error: null }); return () => b; } }); return b; } };
      const out = await engine({ message: modelTitle(fam, want) + ' 256GB 찾아줘', plan: { query: modelTitle(fam, want), category: fam.cat },
        listings: query => searchCatalog(query, { db, liveSearch: null, category: fam.cat, userText: modelTitle(fam, want) + ' 256GB',
          identity: require('../api/_ai-v3-identity').requestedIdentity(modelTitle(fam, want) + ' 256GB'), searchStrategy: 'hybrid', vectorSearch,
          mapRow: x => ({ productId: x.product_id, title: x.title, lprice: x.lprice, mall: x.mall, link: x.link }) }) });
      assert(out.cards.length === 0, 'a vector-only near-miss variant became a card for ' + JSON.stringify(want));
    }, 200, 15);

  // 16. RRF fusion invariants
  await check('16 RRF keeps every candidate exactly once and ranks a unanimous first item first',
    fc.array(fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 20 }), { minLength: 1, maxLength: 3 }),
    async lists => {
      const named = lists.map((ids, i) => ['L' + i, [...new Set(ids)].map(id => ({ mall: '쿠팡', productId: String(id) }))]);
      const fused = rrfFuse(named, { k: 60 });
      const union = new Set(named.flatMap(([, items]) => items.map(x => x.productId)));
      assert(fused.length === union.size, 'lost or duplicated items');
      const firsts = named.map(([, items]) => items[0] && items[0].productId).filter(Boolean);
      if (firsts.length === named.length && firsts.every(x => x === firsts[0])) assert(fused[0].productId === firsts[0], 'unanimous first not first');
    }, 300, 16);

  // 17. freshness classifier agrees with the site's lifecycle boundary
  await check('17 price freshness: fresh iff age <= limit for stored rows; provider rows are observed',
    fc.record({ age: fc.double({ min: 0, max: 60, noNaN: true }), limit: fc.integer({ min: 1, max: 30 }), source: fc.constantFrom('db', 'api', 'cache') }),
    async ({ age, limit, source }) => {
      const f = priceFreshness({ _source: source, mall: '쿠팡', price: 1000, productId: 'p', collectedAt: iso(NOW - age * DAY) }, { now: NOW, maxAgeDays: limit });
      if (source !== 'db') assert(f.state === 'observed', 'provider row not observed');
      else assert((f.state === 'fresh') === (age <= limit), 'boundary mismatch age=' + age + ' limit=' + limit + ' state=' + f.state);
    }, 400, 17);

  const summary = { suite: 'ai-v34-properties', baseSeed: BASE_SEED, properties: results.length, totalRuns,
    passed: results.filter(r => r.ok).length, failed: failures.length };
  const file = path.resolve(__dirname, '../reports/ai-v34-evaluation/fastcheck-failures.json');
  if (process.argv.includes('--record')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...summary, generatedAt: new Date().toISOString(), results, failures }, null, 1) + '\n');
  }
  console.log(JSON.stringify(summary));
  if (failures.length) process.exitCode = 1;
})().catch(e => { console.error(e.stack || e); process.exit(1); });
