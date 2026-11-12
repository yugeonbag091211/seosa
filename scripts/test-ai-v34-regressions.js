'use strict';
// AI v3.4 — one minimal reproduction per defect found on the frozen V001-V100
// development run or by fast-check (docs/ai-v34-failure-analysis.md). Titles
// are synthetic copies of the failing listing shapes; no corpus, no network.
const assert = require('node:assert/strict');
const { createEngine } = require('../api/_ai-v3-core');
const { searchCatalog } = require('../api/_ai-v3-catalog');
const { brandsFromUser, brandConflict } = require('../api/_ai-v31-retrieval');
const { mentionedPositively, excludedBy, parseBudget } = require('../api/_ai-v32-intent');
const { productTypeMatches } = require('../api/_ai-v31-taxonomy');
const { createSnapshotDb } = require('./ai-v31-rootcause/snapshot-db');

const fresh = () => new Date(Date.now() - 86400000).toISOString();
const L = (id, title, price, extra = {}) => ({ productId: id, title, lprice: price, mall: '쿠팡', link: 'https://x.example/' + id,
  _source: 'db', collectedAt: fresh(), shippingFee: 0, ...extra });
const run = (message, plan, listings, state = {}) => createEngine({
  planModel: async () => ({ mode: 'recommend', compareQuery: '', exclusions: [], mallOnly: '', exactModel: '', maxPrice: null, ...plan }),
  decideModel: async ({ candidates }) => ({ productIds: candidates.map(c => c.id) }),
  searchProducts: async () => listings
}, { message, history: [], state });
let passed = 0;
async function test(id, name, fn) { await fn(); passed++; console.log('PASS ' + id + ' ' + name); }

(async () => {
  await test('V001/V029', 'an HDMI cable or a laptop bag is not a laptop (implausible device price)', async () => {
    const out = await run('50만원 이하 노트북 추천해줘', { query: '노트북', category: '노트북', maxPrice: 500000 },
      [L('c', '[기타] 8K 4K HDMI V2.1 케이블 0.5M 노트북 콘솔게임기', 12590), L('b', '맥북 레노버 노트북용 가방 15인치', 12500), L('n', 'HP 노트북 15.6인치 인텔 N100', 449000)]);
    assert.deepEqual(out.cards.map(c => c.productId), ['쿠팡:n']);
  });
  await test('V011/V049', 'a carrier-contract price is not the purchase price', async () => {
    const out = await run('갤럭시 S25 울트라 가격 알려줘', { query: '갤럭시 S25 울트라', category: '스마트폰' },
      [L('k', '[삼성] 갤럭시S25 울트라 256GB, KT 기기변경 완납 (단말할인(공통지원))', 505000), L('s', '삼성전자 갤럭시 S25 울트라 256GB 자급제', 1664000)]);
    assert.deepEqual(out.cards.map(c => c.productId), ['쿠팡:s']);
  });
  await test('V070', 'a «통신사 유심 변경 특가» price is a carrier condition', async () => {
    const out = await run('갤럭시 Z 플립7 512GB 가격', { query: '갤럭시 Z 플립7 512GB', category: '스마트폰' },
      [L('f', '[삼성] 갤럭시 Z 플립7 512GB 자급제 새상품 + 번호 그대로 통신사 유심 변경 특가', 1267208)]);
    assert.equal(out.cards.length, 0);
  });
  await test('V012', 'a «headset + G304 mouse» bundle is not a G304 price', async () => {
    const out = await run('로지텍 G304 무선 마우스 찾아줘', { query: '로지텍 G304 무선 마우스', category: '마우스', exactModel: 'G304' },
      [L('bundle', '[Logitech] 로지텍코리아 G325 무선 게이밍 헤드셋 + G304 무선 마우스', 197000), L('g', '로지텍 G304 LIGHTSPEED 무선 게이밍 마우스', 39000)]);
    assert.deepEqual(out.cards.map(c => c.productId), ['쿠팡:g']);
  });
  await test('V026', 'a brand store page («공기청정기/가습기/건조기 …») is not one SKU', async () => {
    const out = await run('위닉스 공기청정기 추천해줘', { query: '위닉스 공기청정기', category: '공기청정기' },
      [L('store', '[위닉스]공기청정기/가습기/건조기 믿고사는 생활가전 브랜드!', 126650), L('z', '위닉스 제로S 공기청정기 AZSE430', 163990)]);
    assert.deepEqual(out.cards.map(c => c.productId), ['쿠팡:z']);
  });
  await test('V010-hybrid', 'a book about keyboards is not a keyboard', async () => {
    const out = await run('7만원 이하 기계식 키보드 추천해줘', { query: '기계식 키보드', category: '키보드', maxPrice: 70000 },
      [L('book', '기계식 키보드 처음 한 대를 고릅니다', 10000), L('kb', '앱코 K660 기계식 게이밍 키보드 갈축', 39000)]);
    assert.deepEqual(out.cards.map(c => c.productId), ['쿠팡:kb']);
  });
  await test('V065', 'a requested colour must be confirmed by the listing', async () => {
    const out = await run('버즈3 프로 화이트 색상으로 찾아줘', { query: '갤럭시 버즈3 프로 화이트', category: '이어폰', exactModel: '버즈3 프로' },
      [L('w', '삼성전자 갤럭시 버즈3 프로 SM-R630N 화이트', 249500), L('s', '이어폰/갤럭시버즈3프로/SM-R630N(실버)', 239000)]);
    assert.deepEqual(out.cards.map(c => c.productId), ['쿠팡:w']);
  });
  await test('V036', '«조용한» mouse requires silent-click evidence', async () => {
    const out = await run('사무실에서 쓸 조용한 무선 마우스', { query: '저소음 무선 마우스', category: '마우스' },
      [L('loud', '로지텍 G502 X LIGHTSPEED 무선 게이밍 마우스', 145180), L('quiet', '아이리버 무소음 무선 마우스', 10710)]);
    assert.deepEqual(out.cards.map(c => c.productId), ['쿠팡:quiet']);
  });
  await test('V057', '«게이밍» stated two turns earlier still holds after «로지텍 제품만»', async () => {
    const rows = [L('mx', '로지텍 MX VERTICAL 인체공학 무선 마우스', 97340), L('g', '로지텍 G304 LightSpeed 무선 게이밍 마우스', 39000)];
    const t1 = await run('게이밍 마우스 추천해줘', { query: '게이밍 마우스', category: '마우스' }, rows);
    const t2 = await run('무선으로', { query: '무선 게이밍 마우스', category: '마우스' }, rows, t1.state);
    const t3 = await run('로지텍 제품만 보여줘', { query: '로지텍 무선 마우스', category: '마우스' }, rows, t2.state);
    assert.equal(t3.state.features.gaming, true);
    assert.deepEqual(t3.cards.map(c => c.productId), ['쿠팡:g']);
  });
  await test('fast-check#8', 'a wired-only listing is not a wireless request card', async () => {
    const out = await run('무선 마우스 추천해줘', { query: '무선 마우스', category: '마우스' }, [L('w', '로지텍 유선 마우스 USB 연결', 25000)]);
    assert.equal(out.cards.length, 0);
  });
  await test('V025-hybrid', 'AirPods Max is a headphone, not an earphone', async () => {
    assert.equal(productTypeMatches('애플 에어팟 맥스 1세대 실버', '이어폰', '애플 이어폰'), false);
    assert.equal(productTypeMatches('애플 에어팟 맥스 1세대 실버', '헤드폰', '애플 헤드폰'), true);
  });
  await test('V096', 'mouse feet listing that names G304 is an accessory', async () => {
    const out = await run('로지텍 G304 가격 알려줘', { query: '로지텍 G304', category: '마우스', exactModel: 'G304' },
      [L('feet', '핫라인 마우스피트 STR버전 GPRO X 슈퍼라이트 G102 G304', 11500)]);
    assert.equal(out.cards.length, 0);
  });
  await test('V060', '«삼성 제품은 제외» is not a request for Samsung; exclusions reach retrieval', async () => {
    assert.deepEqual(brandsFromUser('삼성 제품은 제외해줘', '외장하드'), []);
    assert.equal(mentionedPositively('그중 게이밍 제품은 제외해줘', /게이밍/), false);
    const rows = [...Array.from({ length: 45 }, (_, i) => ({ id: i + 1, product_id: 's' + i, mall: '쿠팡', keyword: '외장 SSD', title: '삼성전자 포터블 외장 SSD T7 1TB ' + i, lprice: 150000, collected_at: fresh() })),
      { id: 99, product_id: 'ssk', mall: '쿠팡', keyword: '외장 SSD', title: 'SSK 외장SSD SD500 PRO 1TB USB3.2', lprice: 219000, collected_at: fresh() }];
    const db = createSnapshotDb(rows.map(r => ({ ...r, link: 'https://x.example/' + r.product_id })));
    const found = await searchCatalog('외장 SSD 1TB', { db, liveSearch: null, searchStrategy: 'db-first', category: '외장하드', userText: '삼성 제품은 제외해줘',
      exclusions: ['삼성'], mapRow: r => ({ productId: r.product_id, title: r.title, lprice: r.lprice, mall: r.mall, link: r.link }) });
    assert(found.some(x => x.productId === 'ssk'), 'non-Samsung SSD must be retrievable');
    assert(!found.some(x => /삼성/.test(x.title)), 'excluded brand must not fill the page');
  });
  await test('V079', 'excluding a brand covers its English name; asking for and excluding it at once is asked back', async () => {
    assert.equal(excludedBy('Logitech M650 Wireless Mouse', ['로지텍']), '로지텍');
    const out = await run('로지텍 무선 마우스 추천해줘 근데 로지텍은 빼고', { query: '로지텍 무선 마우스', category: '마우스', exclusions: ['로지텍'] },
      [L('a', 'Logitech M650 무선 마우스', 39000)]);
    assert.equal(out.cards.length, 0); assert.equal(out.stats.conflict, 'brand_excluded');
    assert(/로지텍을 제외/.test(out.answer));
    const t1 = await run('로지텍 무선 마우스 추천', { query: '로지텍 무선 마우스', category: '마우스' }, [L('a', 'Logitech M650 무선 마우스', 39000), L('s', '삼성 무선 마우스 SM-M170', 15000)]);
    const t2 = await run('로지텍은 빼고 보여줘', { query: '무선 마우스', category: '마우스', exclusions: ['로지텍'] }, [L('a', 'Logitech M650 무선 마우스', 39000), L('s', '삼성 무선 마우스 SM-M170', 15000)], t1.state);
    assert.deepEqual(t2.cards.map(c => c.productId), ['쿠팡:s'], 'a carried brand the user now excludes is dropped, not a conflict');
  });
  await test('V074/V075', 'a maker named for another maker\'s product line is asked back', async () => {
    assert.deepEqual(brandConflict('애플이 만든 갤럭시 버즈3 프로 있어?', '이어폰'), { maker: '애플', lineOwner: '삼성' });
    assert.equal(brandConflict('삼성이나 LG 노트북', '노트북'), null);
    const out = await run('애플이 만든 갤럭시 버즈3 프로 있어?', { query: '애플 갤럭시 버즈3 프로', category: '이어폰' }, [L('b', '삼성 갤럭시 버즈3 프로 SM-R630', 250000)]);
    assert.equal(out.cards.length, 0); assert.equal(out.stats.conflict, 'brand');
  });
  await test('V078', 'a floor above the ceiling in one sentence is asked back, not half-applied', async () => {
    assert.deepEqual(parseBudget('50만원 이상이면서 3만원 이하인 마우스').conflict, { min: 500000, max: 30000 });
    const out = await run('50만원 이상이면서 3만원 이하인 마우스', { query: '마우스', category: '마우스', maxPrice: 30000 }, [L('m', '삼성전자 유선마우스', 9900)]);
    assert.equal(out.cards.length, 0); assert.equal(out.stats.conflict, 'budget');
  });
  await test('V068', 'spaced family anchors find «애플 워치 SE» written with a space', async () => {
    const rows = [{ id: 1, product_id: 'aw', mall: '쿠팡', keyword: '스마트워치', title: '(관부가세 포함) 애플 워치 SE 2세대 GPS 40mm 미드나잇 알루미늄', lprice: 491600, collected_at: fresh() }];
    const db = createSnapshotDb(rows.map(r => ({ ...r, link: 'https://x.example/' + r.product_id })));
    const { requestedIdentity } = require('../api/_ai-v3-identity');
    const found = await searchCatalog('애플워치 SE 40mm GPS', { db, liveSearch: null, searchStrategy: 'db-first', category: '시계', userText: '애플워치 SE 40mm GPS 모델',
      identity: requestedIdentity('애플워치 SE 40mm GPS'), mapRow: r => ({ productId: r.product_id, title: r.title, lprice: r.lprice, mall: r.mall, link: r.link }) });
    assert(found.some(x => x.productId === 'aw'));
  });
  await test('price-age', 'a 49-day-old DB price is never a card; the answer says why', async () => {
    const out = await run('로지텍 G502 무선 마우스', { query: '로지텍 G502 무선 마우스', category: '마우스' },
      [L('old', '로지텍 G502 X LIGHTSPEED 무선 게이밍 마우스', 129700, { collectedAt: new Date(Date.now() - 49 * 86400000).toISOString() })]);
    assert.equal(out.cards.length, 0); assert.equal(out.stats.noResult, 'stale_price_only'); assert(/10일/.test(out.answer));
  });
  console.log(JSON.stringify({ passed, failed: 0 }));
})().catch(e => { console.error(e.stack || e); process.exit(1); });
