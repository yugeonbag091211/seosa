#!/usr/bin/env node
'use strict';
/**
 * 커뮤니티 핫딜 사진 검증 (2026-09-26) — 네트워크 없이.
 *   · 사진 주소는 «실제로 열리는가» 로 판정한다 (ADPICK search_img.php 404 실측)
 *   · 참고 사진은 모델·색상에 더해 용량이 다르면 쓰지 않는다
 *   · 1순위 사진이 죽어 있으면 다음 후보, 전부 죽었으면 사진 없음 + 사유
 *   · 사진은 제휴 링크를 만들지 않는다 (0.90 identity 만)
 *   · 다음 실행이 앞 실행·백필이 찾은 사진/제휴를 빈 값으로 덮지 않는다
 */
const assert = require('node:assert/strict');
const C = require('./collect-external-hotdeals');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}\n         ${String(e.message).split('\n').join('\n         ')}`); }
}

const res = (status, type, extra) => ({
  status,
  headers: { get: k => ({ 'content-type': type, ...(extra || {}) })[k.toLowerCase()] || null },
  body: { cancel: async () => {} }
});
// 죽은 일반 사진(임시 토큰이 아닌 404). ADPICK 토큰(search_img.php)은 [3b] 가 따로 본다.
const DEAD = 'https://img.gone.example/product/495916396.jpg';
const LIVE = 'https://image4.coupangcdn.com/image/vendor_inventory/cola.jpg';
const fakeProbe = async url => (/gone\.example/.test(url)
  ? { ok: false, status: 404, reason: 'http-404' } : { ok: true, status: 200, reason: 'ok' });

(async () => {
  console.log('[1] 사진 주소 검사');
  await check('404 text/html (ADPICK 만료 토큰의 실측 응답 모양) → 죽은 사진', async () => {
    const r = await C.probeImageUrl(DEAD, { fetch: async () => res(404, 'text/html; charset=UTF-8', { 'content-length': '0' }), cache: new Map() });
    assert.equal(r.ok, false); assert.equal(r.reason, 'http-404'); assert.ok(!r.transient);
  });
  await check('200 image/jpeg → 열리는 사진', async () => {
    const r = await C.probeImageUrl(LIVE, { fetch: async () => res(200, 'image/jpeg'), cache: new Map() });
    assert.equal(r.ok, true);
  });
  await check('206(부분 응답) image/webp 도 열리는 사진', async () => {
    assert.equal((await C.probeImageUrl(LIVE, { fetch: async () => res(206, 'image/webp'), cache: new Map() })).ok, true);
  });
  await check('200 인데 text/html(오류 페이지) → 사진 아님', async () => {
    const r = await C.probeImageUrl(LIVE, { fetch: async () => res(200, 'text/html'), cache: new Map() });
    assert.equal(r.ok, false); assert.match(r.reason, /not-image/);
  });
  await check('200 image 인데 길이 0 → 사진 아님', async () => {
    assert.equal((await C.probeImageUrl(LIVE, { fetch: async () => res(200, 'image/png', { 'content-length': '0' }), cache: new Map() })).ok, false);
  });
  await check('★ 네트워크 오류·시간 초과는 «죽음» 이 아니라 «확인 못 함» — 캐시하지 않는다', async () => {
    const cache = new Map();
    const r = await C.probeImageUrl(LIVE, { fetch: async () => { throw new Error('timeout'); }, cache });
    assert.equal(r.ok, false); assert.equal(r.transient, true); assert.equal(cache.size, 0);
  });
  await check('http:// 와 형식이 틀린 주소는 요청조차 하지 않는다', async () => {
    let called = 0;
    const r = await C.probeImageUrl('http://img.example/a.jpg', { fetch: async () => { called++; return res(200, 'image/jpeg'); }, cache: new Map() });
    assert.equal(r.ok, false); assert.equal(called, 0);
  });
  await check('같은 주소는 한 실행에 한 번만 연다', async () => {
    let called = 0; const cache = new Map();
    const f = async () => { called++; return res(200, 'image/jpeg'); };
    await C.probeImageUrl(LIVE, { fetch: f, cache }); await C.probeImageUrl(LIVE, { fetch: f, cache });
    assert.equal(called, 1);
  });

  console.log('[2] 참고 사진 — 용량 충돌');
  await check('용량 표기를 기준 단위로 맞춘다 (1.7kg = 1700g, 2L = 2000ml)', async () => {
    assert.deepEqual([...C.imageCapacities('삼치 1.7kg (850g*2팩)')].sort(), ['1700g', '850g']);
    assert.deepEqual([...C.imageCapacities('생수 2L 6개')], ['2000ml']);
    assert.deepEqual([...C.imageCapacities('코카콜라 제로 190ml 30개')], ['190ml']);
  });
  const item = (title, image, extra) => ({ title, image, link: 'https://link.example/' + encodeURIComponent(title),
    productId: 'pid-' + title.length, mall: '쿠팡', lprice: 10000, ...(extra || {}) });
  await check('★ 190ml 캔 딜에 500ml 병 사진은 쓰지 않는다', async () => {
    const deal = { title: '코카콜라 제로 190ml 30개', mall: '쿠팡' };
    assert.equal(C.referenceImageCandidate(deal, [item('코카콜라 제로 500ml 20개', LIVE)]), null);
  });
  await check('같은 용량에 개수만 다르면 참고 사진으로 허용 (30개 ↔ 24개)', async () => {
    const deal = { title: '코카콜라 제로 190ml 30개', mall: '쿠팡' };
    const c = C.referenceImageCandidate(deal, [item('코카콜라 제로 190ml 24개', LIVE)]);
    assert.ok(c && c.image === LIVE); assert.ok(c.confidence < 0.9, 'reference photos stay below the affiliate bar');
  });
  await check('1.7kg 딜에 1700g 표기 후보는 같은 용량이다', async () => {
    const deal = { title: '국내산 삼치 손질 냉동 1.7kg', mall: '' };
    assert.ok(C.referenceImageCandidate(deal, [item('국내산 삼치 손질 냉동 1700g 대사이즈', LIVE)]));
  });
  await check('후보 목록은 순위 순 — 예전 «최고 1개» 선택과 같다', async () => {
    const deal = { title: '폴햄 남녀 바람막이 자켓', mall: '' };
    const list = C.referenceImageCandidates(deal, [item('폴햄 바람막이', 'https://a.example/1.jpg'), item('폴햄 남녀 바람막이 자켓 블랙', 'https://a.example/2.jpg')]);
    assert.equal(list[0].image, 'https://a.example/2.jpg');
    assert.equal(C.referenceImageCandidate(deal, list.map(l => l.item)).image, list[0].image);
  });

  console.log('[3] 제휴 검색 보강 — 죽은 사진 건너뛰기');
  const deal = { title: '코카콜라 제로 190ml 30개', price: 17900, mall: '쿠팡' };
  const search = items => async () => ({ items, from: 'api' });
  await check('★ 1순위 사진이 404 면 다음 후보의 열리는 사진을 쓴다', async () => {
    const row = { image_url: '', metadata: {} };
    const probed = [];
    // 죽은 쪽이 핵심어를 더 많이 공유해 1순위다 (제로·코카콜라 vs 코카콜라).
    const top = item('코카콜라 제로 190ml 24개', DEAD, { mall: 'ADPICK', mallLabel: 'G마켓' });
    const next = item('코카콜라 190ml 캔', LIVE);
    assert.equal(C.referenceImageCandidates(deal, [next, top])[0].image, DEAD, 'fixture: the dead photo ranks first');
    const stats = await C.enrichAffiliateRows([deal], [row], {
      searchAll: search([top, next]),
      saveProducts: async () => ({ saved: 0 }), probeImage: async u => { probed.push(u); return fakeProbe(u); },
      lookupLimit: 1, searchLimit: 1
    });
    assert.deepEqual(probed, [DEAD, LIVE], 'opened in rank order');
    assert.equal(row.image_url, LIVE);
    assert.equal(row.metadata.imageLookup.dead, 1);
    assert.equal(row.metadata.imageLookup.outcome, 'image');
    assert.ok(stats.deadImagesRejected >= 1);
    assert.equal(row.matched_product_id, undefined, 'photo alone never creates a product identity');
    assert.equal(row.metadata.affiliateUrl, undefined, 'photo alone never creates an affiliate link');
  });
  await check('★ 후보 사진이 전부 죽었으면 사진 없음 + 사유 image-dead', async () => {
    const row = { image_url: '', metadata: {} };
    await C.enrichAffiliateRows([deal], [row], {
      searchAll: search([item('코카콜라 제로 190ml 24개', DEAD)]),
      saveProducts: async () => ({ saved: 0 }), probeImage: fakeProbe, lookupLimit: 1, searchLimit: 1
    });
    assert.equal(row.image_url, ''); assert.equal(row.metadata.imageLookup.outcome, 'image-dead');
  });
  await check('검색 결과 0건 → no-results, 안전한 후보 0 → no-safe-candidate', async () => {
    const r1 = { image_url: '', metadata: {} };
    await C.enrichAffiliateRows([deal], [r1], { searchAll: search([]), saveProducts: async () => ({}), probeImage: fakeProbe, lookupLimit: 1, searchLimit: 1 });
    assert.equal(r1.metadata.imageLookup.outcome, 'no-results');
    const r2 = { image_url: '', metadata: {} };
    await C.enrichAffiliateRows([deal], [r2], { searchAll: search([item('펩시 제로 라임 500ml 20개', LIVE)]), saveProducts: async () => ({}), probeImage: fakeProbe, lookupLimit: 1, searchLimit: 1 });
    assert.equal(r2.metadata.imageLookup.outcome, 'no-safe-candidate');
  });
  await check('제휴 확정 상품의 자기 사진이 죽었으면 제휴는 유지하고 사진은 다른 안전 후보에서', async () => {
    const row = { image_url: '', metadata: {} };
    const exact = item('코카콜라 제로 190ml 30개', DEAD);
    await C.enrichAffiliateRows([deal], [row], {
      searchAll: search([exact, item('코카콜라 제로 190ml 24개', LIVE)]),
      saveProducts: async () => ({ saved: 1 }), probeImage: fakeProbe, lookupLimit: 1, searchLimit: 1
    });
    if (row.matched_product_id) {
      assert.equal(row.metadata.affiliateUrl, exact.link);
      assert.notEqual(row.image_url, DEAD, 'a dead photo is never stored even for an exact match');
    } else {
      assert.notEqual(row.image_url, DEAD);
    }
  });
  await check('최근 12시간 안에 찾아본 글은 다시 검색하지 않는다 (skipRecentlyLooked)', async () => {
    let calls = 0;
    const nowMs = Date.parse('2026-09-26T12:00:00Z');
    const row = { image_url: '', metadata: { imageLookup: { at: new Date(nowMs - 3600e3).toISOString(), outcome: 'no-results' } } };
    const stats = await C.enrichAffiliateRows([deal], [row], { searchAll: async () => { calls++; return { items: [] }; },
      saveProducts: async () => ({}), probeImage: fakeProbe, nowMs, skipRecentlyLooked: true });
    assert.equal(calls, 0); assert.equal(stats.skipped, 1);
    const old = { image_url: '', metadata: { imageLookup: { at: new Date(nowMs - 13 * 3600e3).toISOString() } } };
    await C.enrichAffiliateRows([deal], [old], { searchAll: async () => { calls++; return { items: [] }; },
      saveProducts: async () => ({}), probeImage: fakeProbe, nowMs, skipRecentlyLooked: true, lookupLimit: 1, searchLimit: 1 });
    assert.equal(calls, 1);
  });

  console.log('[3b] ADPICK 임시 토큰 사진');
  const TOKEN = 'https://d2iaagr1j041pi.cloudfront.net/apis/search_img.php?code=496601772';
  await check('search_img.php 는 임시 토큰 — 저장 가능한 사진이 아니다', async () => {
    assert.equal(C.isEphemeralImageUrl(TOKEN), true); assert.equal(C.durableImageUrl(TOKEN), '');
    assert.equal(C.isEphemeralImageUrl(LIVE), false); assert.equal(C.durableImageUrl(LIVE), LIVE);
    assert.equal(C.durableImageUrl('https://shop2.daumcdn.net/shophow/p/S36905939918.jpg'), 'https://shop2.daumcdn.net/shophow/p/S36905939918.jpg');
  });
  await check('★ 지금 열리는(프로브 ok) 토큰이어도 카드 사진으로 저장하지 않는다', async () => {
    const row = { image_url: '', metadata: {} };
    await C.enrichAffiliateRows([deal], [row], { searchAll: search([item('코카콜라 제로 190ml 24개', TOKEN, { mall: 'ADPICK' })]),
      saveProducts: async () => ({}), probeImage: async () => ({ ok: true }), lookupLimit: 1, searchLimit: 1 });
    assert.equal(row.image_url, ''); assert.equal(row.metadata.imageLookup.outcome, 'no-safe-candidate');
  });
  await check('토큰보다 순위가 낮아도 쿠팡 사진이 있으면 그쪽을 쓴다', async () => {
    const row = { image_url: '', metadata: {} };
    await C.enrichAffiliateRows([deal], [row], { searchAll: search([item('코카콜라 제로 190ml 24개', TOKEN, { mall: 'ADPICK' }), item('코카콜라 190ml 캔', LIVE)]),
      saveProducts: async () => ({}), probeImage: async () => ({ ok: true }), lookupLimit: 1, searchLimit: 1 });
    assert.equal(row.image_url, LIVE);
  });
  await check('★ 저장된 토큰 사진은 열어 보지 않고 비운다 (사유 ephemeral-adpick)', async () => {
    let probed = 0; const rows = [{ image_url: TOKEN, metadata: { imageReference: true } }];
    const n = await C.dropDeadImages(rows, { probeImage: async () => { probed++; return { ok: true }; } });
    assert.equal(n, 1); assert.equal(probed, 0); assert.equal(rows[0].image_url, ''); assert.equal(rows[0].metadata.imageDeadReason, 'ephemeral-adpick');
  });

  console.log('[4] 저장된 행 — 죽은 사진 비우기 · 앞 실행 결과 이어받기');
  await check('★ 죽은 사진은 비우고 주소·사유를 남긴다, 확인 못 한 사진은 그대로', async () => {
    const rows = [
      { image_url: DEAD, metadata: { imageReference: true, imageSource: 'ADPICK' } },
      { image_url: LIVE, metadata: {} },
      { image_url: 'https://slow.example/x.jpg', metadata: {} }
    ];
    const n = await C.dropDeadImages(rows, { probeImage: async u => (u === DEAD ? { ok: false, reason: 'http-404' }
      : /slow/.test(u) ? { ok: false, transient: true } : { ok: true }), nowMs: 0 });
    assert.equal(n, 1);
    assert.equal(rows[0].image_url, ''); assert.equal(rows[0].metadata.imageDeadUrl, DEAD);
    assert.equal(rows[0].metadata.imageReference, undefined, 'the «참고 이미지» label goes with the dead photo');
    assert.equal(rows[1].image_url, LIVE); assert.equal(rows[2].image_url, 'https://slow.example/x.jpg');
  });
  function carryDb(stored) {
    return { from() {
      const f = [];
      const q = { select() { return q; },
        in(col, vals) { f.push(r => vals.map(String).includes(String(r[col]))); return q; },
        then(resolve) { resolve({ data: stored.filter(r => f.every(fn => fn(r))), error: null }); } };
      return q;
    } };
  }
  await check('★ 피드에 다시 실린 글은 저장된 사진·0.90 제휴를 이어받는다 (빈 값으로 덮지 않는다)', async () => {
    const stored = [
      { source: 'ppomppu', source_post_id: '1', image_url: LIVE, metadata: { imageReference: true, imageSource: '쿠팡', imageLookup: { at: 'x' },
        affiliateUrl: 'https://link.coupang.com/a', affiliateConfidence: 0.95 }, matched_product_id: 'p1', matched_mall: '쿠팡',
        matched_vendor_item_id: 'v1', match_confidence: 0.95, match_method: 'affiliate-identity' },
      { source: 'ppomppu', source_post_id: '2', image_url: LIVE, metadata: { affiliateUrl: 'https://link.example/weak' },
        matched_product_id: 'p2', match_confidence: 0.8, match_method: 'identity-partial' }
    ];
    const rows = [
      { source: 'ppomppu', source_post_id: '1', image_url: '', metadata: {}, matched_product_id: null },
      { source: 'ppomppu', source_post_id: '2', image_url: '', metadata: {}, matched_product_id: null },
      { source: 'ppomppu', source_post_id: '3', image_url: '', metadata: {}, matched_product_id: null }
    ];
    const r = await C.carryStoredEnrichment(carryDb(stored), rows);
    assert.deepEqual(r, { carriedImages: 2, carriedAffiliates: 1 });
    assert.equal(rows[0].image_url, LIVE); assert.equal(rows[0].metadata.imageReference, true);
    assert.equal(rows[0].matched_product_id, 'p1'); assert.equal(rows[0].metadata.affiliateUrl, 'https://link.coupang.com/a');
    assert.deepEqual(rows[0].metadata.imageLookup, { at: 'x' });
    assert.equal(rows[1].matched_product_id, null, 'a sub-0.90 or non-affiliate match is never carried as an affiliate link');
    assert.equal(rows[1].metadata.affiliateUrl, undefined);
    assert.equal(rows[2].image_url, '');
  });
  await check('이번 실행 카탈로그 매칭이 있으면 저장된 제휴보다 그쪽이 이긴다', async () => {
    const stored = [{ source: 'ppomppu', source_post_id: '1', image_url: LIVE, metadata: { affiliateUrl: 'https://old' },
      matched_product_id: 'old', match_confidence: 0.95, match_method: 'affiliate-identity' }];
    const rows = [{ source: 'ppomppu', source_post_id: '1', image_url: 'https://img.example/new.jpg', metadata: {}, matched_product_id: 'new' }];
    await C.carryStoredEnrichment(carryDb(stored), rows);
    assert.equal(rows[0].matched_product_id, 'new'); assert.equal(rows[0].image_url, 'https://img.example/new.jpg');
  });
  await check('표가 없으면(마이그레이션 전) 조용히 넘어간다', async () => {
    const db = { from() { const q = { select() { return q; }, in() { return q; },
      then(resolve) { resolve({ data: null, error: { message: 'relation "public.external_hotdeals" does not exist' } }); } }; return q; } };
    assert.deepEqual(await C.carryStoredEnrichment(db, [{ source: 's', source_post_id: '1', metadata: {} }]), { carriedImages: 0, carriedAffiliates: 0 });
  });

  console.log(`\nPASS ${pass}  /  FAIL ${fail}`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
