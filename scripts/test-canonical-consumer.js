'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const OI = require('../api/_offeridentity');
const P = require('../api/_identitypromotion');
const C = require(process.env.CANONICAL_CONSUMER_MODULE || '../api/_canonicalconsumer');

function fixture(titles, options = {}) {
  const products = titles.map((title, i) => ({
    product_id: options.ids ? String(options.ids[i]) : String(700 + i), mall: options.rawMalls ? options.rawMalls[i] : options.mall || 'ADPICK',
    mall_label: options.labels ? options.labels[i] : ['Hmall', '롯데홈쇼핑', 'SSG'][i],
    vendor_item_id: options.vids ? options.vids[i] : '', title,
    gtin: options.gtins ? options.gtins[i] : '',
    lprice: options.prices ? options.prices[i] : [62000, 54000, 58000][i],
    link: options.links ? options.links[i] : 'https://biz.adpick.co.kr/offer/' + i,
    image: 'https://img.example/' + i + '.jpg', keyword: 'mouse',
    collected_at: new Date().toISOString()
  }));
  const identities = products.map((row, i) => OI.parseOffer({
    key: row.mall + '|' + row.product_id, title: row.title,
    mall: row.mall_label, productId: row.product_id, vendorItemId: row.vendor_item_id,
    gtin: row.gtin
  }));
  const strong = P.commonStrongIdentifier(identities);
  const tier = strong ? 'A' : 'B';
  const identity = P.canonicalIdentity(identities, strong, tier);
  const key = P.canonicalKeyOf(identity);
  const members = products.map((row, i) => ({
    group_id: 9, source_mall: row.mall, product_id: row.product_id,
    mall: row.mall_label, vendor_item_id: row.vendor_item_id,
    offer_key: row.mall + '|' + row.product_id,
    identity_snapshot: P.snapshotOf(identities[i])
  }));
  const group = { id: 9, canonical_key: key, status: options.status || 'ACTIVE',
    identity, confidence_tier: tier };
  const db = fakeDb({ canonical_product_members: members, canonical_product_groups: [group], products });
  const inputs = products.map(row => ({
    productId: row.product_id, mall: row.mall, mallId: row.mall,
    vendorItemId: row.vendor_item_id, title: row.title, lprice: row.lprice,
    link: row.link, image: row.image, mallLabel: row.mall_label
  }));
  return { db, products, group, members, inputs };
}

function fakeDb(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      const filters = [];
      const q = {
        select() { return q; },
        in(col, values) { filters.push(row => values.map(String).includes(String(row[col]))); return q; },
        eq(col, value) { filters.push(row => String(row[col]) === String(value)); return q; },
        order() { return q; },
        limit() { return q; },
        then(resolve, reject) {
          const data = (tables[table] || []).filter(row => filters.every(test => test(row)));
          return Promise.resolve({ data }).then(resolve, reject);
        }
      };
      return q;
    }
  };
}

function opts(db, extra = {}) {
  return Object.assign({ db, config: { enabled: true, percent: 100, allowlist: new Set() },
    attachTrust: async rows => rows.forEach(row => { row.trust = { level: 'high', reasons: [] }; }) }, extra);
}

function loadCardComponent() {
  const source = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const start = source.indexOf('var Card = {');
  const imageFallback = source.indexOf('/** 이미지 로드 실패', start);
  const marker = source.lastIndexOf('\n};', imageFallback);
  assert.ok(start >= 0 && marker > start, 'Card component source boundaries exist');
  const context = {
    Fmt: {
      int(value) { const n = parseInt(String(value == null ? '' : value).replace(/,/g, ''), 10); return Number.isFinite(n) ? n : 0; },
      won(value) { return Number(value).toLocaleString('en-US'); },
      esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); },
      glyph() { return '✦'; },
      mall(item) { return { cls: '', name: item.mallLabel || item.mall || '' }; },
      buyUrl(link, item) { return require('../api/_affiliate').safeBuyLink(link, item); },
      textOf(element) { return element && element.textContent || ''; },
      priceOf() { return 0; },
      asOf() { return ''; }
    },
    MallBrand: { render(mall, label) { return String(label || mall || ''); } },
    AppState: { products: {} },
    histKey() { return 'representative-history-key'; },
    productKey(title, mall, pid, vid) { return [title, mall, pid, vid].join('|'); }
  };
  vm.runInNewContext(source.slice(start, marker + 3), context, { timeout: 1000 });
  context.Card.thumbHTML = () => '';
  context.Card.changeHTML = () => '';
  context.Card.asOfHTML = () => '';
  context.Card.shipHTML = () => '';
  context.Card.trustHTML = () => '';
  return context;
}

async function run() {
  // Flag OFF must return the original array and make no DB call.
  const off = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse']);
  const same = await C.collapseItems(off.inputs, { db: off.db, env: {} });
  assert.strictEqual(same, off.inputs);
  assert.deepStrictEqual(off.db.calls, []);
  assert.strictEqual(C.config({}).percent, 0);

  // Active, fresh, exact membership is grouped once; its lowest current offer is read-only metadata.
  const fx = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse']);
  const resolved = await C.resolveGroups(fx.inputs, opts(fx.db));
  assert.strictEqual(resolved.groups.length, 1);
  assert.strictEqual(resolved.stats.offers, 2);
  assert.ok(fx.db.calls.length <= 4, 'bounded resolver query count');
  const collapsed = await C.collapseItems(fx.inputs.concat([{ productId: 'other', mall: '쿠팡', vendorItemId: 'x' }]), opts(fx.db));
  assert.strictEqual(collapsed.length, 2);
  assert.strictEqual(collapsed[0].isCanonicalGroup, true);
  assert.strictEqual(collapsed[0].offerCount, 2);
  assert.strictEqual(collapsed[0].lowestPrice, 54000);
  assert.strictEqual(collapsed[0].lowestMerchant, '롯데홈쇼핑');
  assert.strictEqual(collapsed[0].productId, fx.inputs[0].productId, 'the ranked representative remains the card identity');
  assert.strictEqual(collapsed[0].lprice, fx.inputs[0].lprice, 'representative price remains the history price');
  assert.strictEqual(collapsed[0].link, fx.inputs[0].link, 'representative link remains attached to its product identity');
  assert.strictEqual(collapsed[0].canonicalLowestPrice, 54000);
  assert.strictEqual(collapsed[0].canonicalLowestMerchant, '롯데홈쇼핑');
  assert.strictEqual(collapsed[0].displayPrice, 54000);
  assert.strictEqual(collapsed[0].displayMerchant, '롯데홈쇼핑');
  assert.strictEqual(collapsed[0].canonicalLowestProductId, fx.products[1].product_id);
  assert.strictEqual(collapsed[0].canonicalLowestVendorItemId, '');
  assert.strictEqual(collapsed[0].canonicalLowestLink, fx.products[1].link,
    'canonical purchase link and lowest price point to the same seller offer');

  // 3-member group: skip an unusable cheapest offer and choose the next safe seller.
  const three = fixture([
    'Logitech MX Master 3S Wireless Mouse',
    'Logitech MX Master 3S Wireless Mouse',
    'Logitech MX Master 3S Wireless Mouse'
  ], { prices: [70000, 50000, 55000], labels: ['Hmall', '롯데홈쇼핑', 'SSG'] });
  three.products[1].collected_at = new Date(Date.now() - 5 * 86400000).toISOString();
  const afterStale = await C.collapseItems(three.inputs, opts(three.db));
  assert.strictEqual(afterStale.length, 1);
  assert.strictEqual(afterStale[0].canonicalLowestPrice, 55000);
  assert.strictEqual(afterStale[0].canonicalLowestMerchant, 'SSG');
  assert.strictEqual(afterStale[0].canonicalLowestProductId, three.products[2].product_id);
  assert.strictEqual(afterStale[0].canonicalLowestLink, three.products[2].link,
    'stale cheapest seller falls through to next valid offer');
  assert.strictEqual(afterStale[0].productId, three.products[0].product_id,
    'even a filtered representative keeps its history identity');
  const suspect = fixture([
    'Logitech MX Master 3S Wireless Mouse',
    'Logitech MX Master 3S Wireless Mouse',
    'Logitech MX Master 3S Wireless Mouse'
  ], { prices: [70000, 50000, 55000], labels: ['Hmall', '롯데홈쇼핑', 'SSG'] });
  const afterSuspect = await C.collapseItems(suspect.inputs, opts(suspect.db, {
    attachTrust: async rows => rows.forEach(row => {
      row.trust = row.lprice === 50000
        ? { level: 'low', reasons: [{ code: 'volatile_high' }] } : { level: 'high', reasons: [] };
    })
  }));
  assert.strictEqual(afterSuspect.length, 1);
  assert.strictEqual(afterSuspect[0].canonicalLowestPrice, 55000,
    'suspect cheapest seller falls through to next trusted offer');
  const badLink = fixture([
    'Logitech MX Master 3S Wireless Mouse',
    'Logitech MX Master 3S Wireless Mouse',
    'Logitech MX Master 3S Wireless Mouse'
  ], { prices: [70000, 50000, 55000], labels: ['Hmall', '롯데홈쇼핑', 'SSG'],
    links: ['https://biz.adpick.co.kr/offer/0', 'javascript:alert(1)', 'https://biz.adpick.co.kr/offer/2'] });
  const afterBadLink = await C.collapseItems(badLink.inputs, opts(badLink.db));
  assert.strictEqual(afterBadLink[0].canonicalLowestPrice, 55000,
    'unsafe cheapest offer falls through to the next valid purchase offer');
  assert.strictEqual(afterBadLink[0].canonicalLowestLink, badLink.products[2].link);
  const allInvalid = fixture([
    'Logitech MX Master 3S Wireless Mouse',
    'Logitech MX Master 3S Wireless Mouse',
    'Logitech MX Master 3S Wireless Mouse'
  ], { prices: [70000, 50000, 55000], labels: ['Hmall', '롯데홈쇼핑', 'SSG'],
    links: ['javascript:alert(1)', '', 'data:text/html,unsafe'] });
  const allInvalidLinks = await C.collapseItems(allInvalid.inputs, opts(allInvalid.db));
  assert.strictEqual(allInvalidLinks.length, allInvalid.inputs.length,
    'all unsafe offers fall back to legacy ungrouped rows');
  assert.ok(allInvalidLinks.every(row => row.isCanonicalGroup !== true));
  const allInvalidRows = await C.collapseItems(allInvalid.inputs, opts(allInvalid.db, {
    attachTrust: async rows => rows.forEach(row => { row.trust = { level: 'low', reasons: [] }; })
  }));
  assert.strictEqual(allInvalidRows.length, allInvalid.inputs.length,
    'all invalid canonical offers fall back to legacy ungrouped rows');

  const affiliate = require('../api/_affiliate');
  const affiliateLink = `https://link.coupang.com/re/AFFSDP?lptag=${affiliate.SEOSA_COUPANG_LPTAG}&vendorItemId=12345`;
  const affiliateFixture = fixture([
    'Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse'
  ], { rawMalls: ['ADPICK', '쿠팡'], labels: ['Hmall', '쿠팡'], prices: [6206000, 5884990],
    vids: ['', '12345'], links: ['https://biz.adpick.co.kr/offer/hmall', affiliateLink] });
  const affiliateCard = (await C.collapseItems(affiliateFixture.inputs, opts(affiliateFixture.db)))[0];
  assert.strictEqual(affiliateCard.canonicalLowestLink, affiliateLink,
    'the lowest offer retains its verified affiliate attribution');
  assert.strictEqual(affiliate.safeBuyLink(affiliateCard.canonicalLowestLink, {
    mall: affiliateCard.canonicalLowestMall, vendorItemId: affiliateCard.canonicalLowestVendorItemId
  }), affiliateLink, 'purchase link still validates against the lowest offer option');
  const wrongOptionLink = fixture([
    'Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse'
  ], { rawMalls: ['ADPICK', '쿠팡'], labels: ['Hmall', '쿠팡'], prices: [6206000, 5884990],
    vids: ['', '12345'], links: ['https://biz.adpick.co.kr/offer/hmall',
      `https://link.coupang.com/re/AFFSDP?lptag=${affiliate.SEOSA_COUPANG_LPTAG}&vendorItemId=99999`] });
  const wrongOptionRows = await C.collapseItems(wrongOptionLink.inputs, opts(wrongOptionLink.db));
  assert.ok(wrongOptionRows.every(row => row.isCanonicalGroup !== true),
    'a valid Coupang affiliate link for a different vendor option cannot become a canonical offer');
  const ui = loadCardComponent();
  const legacyHtml = ui.Card.html(off.inputs[0]);
  assert.ok(legacyHtml.includes('62,000') && !legacyHtml.includes('최저가 ·'),
    'feature-off search card retains its legacy representative price presentation');
  assert.strictEqual(ui.Card.purchaseInfo(off.inputs[0]), off.inputs[0],
    'feature-off purchase CTA retains the legacy product/link identity');
  const productionSmoke = fixture([
    'HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 2.5K 240Hz 고사양 게이밍 노트북',
    'HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 2.5K 240Hz 고사양 게이밍 노트북'
  ], { ids: [
    '5f6cd0192af9a21b26db684e1d5e0da9f3c275bcd9ff7a4a2284eef0e310eec8',
    '5270e8af7873b4b9c4d4e75cf31ae62e4a3f1d7e4be3936c4d95dc7de8ae9f4a'
  ], rawMalls: ['ADPICK', 'ADPICK'], labels: ['Hmall', '롯데홈쇼핑'], prices: [6206000, 5884990],
  links: ['https://biz.adpick.co.kr/preview/hmall-offer?fixture=1', 'https://biz.adpick.co.kr/preview/lotte-offer?fixture=1'] });
  const productionIdentities = productionSmoke.products.map(row => {
    const identity = OI.parseOffer({ key: row.mall + '|' + row.product_id, title: row.title,
      mall: row.mall_label, productId: row.product_id, vendorItemId: row.vendor_item_id, price: row.lprice });
    identity.sourceMall = row.mall;
    return identity;
  });
  const productionStrong = P.commonStrongIdentifier(productionIdentities);
  const productionIdentity = P.canonicalIdentity(productionIdentities, productionStrong, 'A');
  const productionKey = P.canonicalKeyOf(productionIdentity);
  /*
   * 운영 ACTIVE 그룹(2026-10-13 승격)의 키는 d8ef9634… 였다. matcher evidence v2 가 노트북의 CPU·GPU 를 모델번호에서
   * 부품으로, «32G» 를 메모리로 읽게 바뀌면서 같은 제목의 정규 식별 · 스냅숏이 달라졌다. 그래서 이 키는 이제 재현되지
   * 않고, 운영의 그 그룹은 새 matcher 로 다시 승격하기 전까지 소비자에서 빠진다(fail-closed — 아래 stale 검사).
   * 이 단언은 «현재 matcher 가 만드는 키» 를 고정해 다음 파서 변경도 같은 방식으로 드러나게 한다.
   */
  const promotedUnderPreviousMatcher = 'd8ef963465eef90d2c91db01d9588f9abd6a78ff6b427f1e09838b8a446a53e0';
  assert.strictEqual(productionKey, 'c926abe10082aebc8f747e117f9661ed0a473697e2d13d8e2fcb304eadfc2f6e',
    'local production-derived smoke fixture yields the canonical key of the current matcher');
  assert.notStrictEqual(productionKey, promotedUnderPreviousMatcher,
    'the group promoted under the previous matcher no longer reproduces its key (re-promotion required)');
  const staleProduction = fixture([
    'HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 2.5K 240Hz 고사양 게이밍 노트북',
    'HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 2.5K 240Hz 고사양 게이밍 노트북'
  ], { rawMalls: ['ADPICK', 'ADPICK'], labels: ['Hmall', '롯데홈쇼핑'], prices: [6206000, 5884990],
    links: ['https://biz.adpick.co.kr/preview/hmall-offer?fixture=1', 'https://biz.adpick.co.kr/preview/lotte-offer?fixture=1'] });
  staleProduction.group.canonical_key = promotedUnderPreviousMatcher;
  const staleRows = await C.collapseItems(staleProduction.inputs, opts(staleProduction.db));
  assert.ok(staleRows.every(row => row.isCanonicalGroup !== true),
    'a canonical group whose persisted key came from the previous matcher fails closed instead of being displayed');
  productionSmoke.group.canonical_key = productionKey;
  productionSmoke.group.identity = productionIdentity;
  productionSmoke.members.forEach((member, i) => { member.identity_snapshot = P.snapshotOf(productionIdentities[i]); });
  const productionCard = (await C.collapseItems(productionSmoke.inputs, opts(productionSmoke.db)))[0];
  assert.strictEqual(productionCard.productId, productionSmoke.inputs[0].productId,
    'production-derived search card preserves the Hmall representative/history identity');
  assert.strictEqual(productionCard.canonicalLowestPrice, 5884990);
  assert.strictEqual(productionCard.canonicalLowestMerchant, '롯데홈쇼핑');
  assert.ok(ui.Card.html(productionCard).includes('최저가 · 롯데홈쇼핑')
    && ui.Card.html(productionCard).includes('5,884,990'),
  'production-derived local search smoke displays the active group lowest offer');
  assert.strictEqual(ui.Card.purchaseInfo(productionCard).link, productionSmoke.products[1].link,
    'production-derived local search CTA follows the actual Lotte offer route');
  assert.strictEqual(ui.Card.purchaseInfo(productionCard).productId, productionSmoke.products[1].product_id);
  const ordinaryMallHtml = ui.Card.html(collapsed[0]);
  assert.ok(ordinaryMallHtml.includes('최저가 · 롯데홈쇼핑') && ordinaryMallHtml.includes('54,000'),
    'search card shows a lower canonical offer from the expected merchant');
  assert.ok(ordinaryMallHtml.includes('롯데홈쇼핑에서 구매'),
    'search card purchase CTA names the same lowest-price seller');
  const cardHtml = ui.Card.html(affiliateCard);
  assert.ok(cardHtml.includes('최저가 · 쿠팡') && cardHtml.includes('5,884,990'),
    'search card main price is the canonical lowest price and seller');
  assert.ok(cardHtml.includes('쿠팡에서 구매'), 'search card CTA names the lowest seller');
  assert.ok(cardHtml.includes('data-pid="700"') && cardHtml.includes('data-vid=""'),
    'rendered card keeps representative product and vendor identity');
  ui.AppState.products[ui.productKey(affiliateCard.title, affiliateCard.mall, affiliateCard.productId, affiliateCard.vendorItemId)] = affiliateCard;
  const readCard = ui.Card.read({
    dataset: { title: affiliateCard.title, mall: affiliateCard.mall, pid: affiliateCard.productId, vid: affiliateCard.vendorItemId, glyph: '✦' },
    querySelector(selector) { return selector === '.p-title' ? { textContent: affiliateCard.title } : null; }
  });
  assert.strictEqual(readCard.lprice, 6206000, 'card history reads representative price, not displayed lowest price');
  assert.strictEqual(readCard.productId, '700', 'card history product ID remains representative');
  assert.strictEqual(readCard.link, affiliateFixture.inputs[0].link, 'history identity keeps representative link');
  assert.strictEqual(readCard.buyInfo.link, affiliateLink, 'purchase CTA uses same lowest offer affiliate link');
  assert.strictEqual(readCard.buyInfo.productId, '701', 'purchase attribution uses lowest offer product ID');
  assert.strictEqual(readCard.buyInfo.vendorItemId, '12345', 'purchase attribution uses lowest offer option ID');
  const aiCard = require('../api/ai.js')._internal.toCard(affiliateCard, null);
  assert.strictEqual(aiCard.canonicalLowestPrice, 5884990, 'AI card exposes the verified lowest display price');
  assert.strictEqual(aiCard.canonicalLowestLink, affiliateLink, 'AI purchase identity keeps the same affiliate offer');
  assert.strictEqual(aiCard.productId, '700', 'AI card retains the representative history identity');
  assert.strictEqual(aiCard.lprice, 6206000, 'AI card does not replace representative price/history identity');

  // Status, freshness, price validity, trust, and option identity fail closed.
  const suspended = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse'], { status: 'SUSPENDED' });
  assert.strictEqual((await C.resolveGroups(suspended.inputs, opts(suspended.db))).groups.length, 0);
  const suspendedRows = new Map(suspended.products.map(row => [row.mall + '|' + row.product_id, row]));
  assert.strictEqual(C._internal.activeCandidate(suspended.group, suspended.members, suspendedRows,
    { config: { enabled: true, percent: 100, allowlist: new Set() } }, { rejected: 0 }), null);
  const stale = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse']);
  stale.products[0].collected_at = new Date(Date.now() - 5 * 86400000).toISOString();
  assert.strictEqual((await C.resolveGroups(stale.inputs, opts(stale.db, { now: Date.now() }))).groups.length, 0);
  const changedIdentity = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse']);
  changedIdentity.products[0].title += ' 블랙';
  assert.strictEqual((await C.resolveGroups(changedIdentity.inputs, opts(changedIdentity.db))).groups.length, 0,
    'identity changes since promotion snapshot fail closed');
  const zero = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse']);
  zero.products[0].lprice = 0;
  assert.strictEqual((await C.resolveGroups(zero.inputs, opts(zero.db))).groups.length, 0);
  const untrusted = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse']);
  assert.strictEqual((await C.resolveGroups(untrusted.inputs, opts(untrusted.db, {
    attachTrust: async rows => rows.forEach(row => { row.trust = { level: 'low', reasons: [] }; })
  }))).groups.length, 0);
  const changedOption = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse'], { vids: ['', 'new-vid'] });
  changedOption.inputs[1].vendorItemId = 'old-vid';
  assert.strictEqual((await C.collapseItems(changedOption.inputs, opts(changedOption.db))).length, 2);
  const changedCatalogOption = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse'], { vids: ['', 'member-vid'] });
  changedCatalogOption.products[1].vendor_item_id = 'current-vid';
  assert.strictEqual((await C.resolveGroups(changedCatalogOption.inputs, opts(changedCatalogOption.db))).groups.length, 0);

  // Deterministic hard conflicts cannot be hidden by an ACTIVE flag or human-origin key.
  const conflict = fixture(['Logitech MX Master 3 Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse'], {
    gtins: ['1234567890128', '1234567890128']
  });
  const conflictResult = await C.resolveGroups(conflict.inputs, opts(conflict.db));
  assert.strictEqual(conflictResult.groups.length, 0);
  assert.ok(conflictResult.stats.rejected > 0, 'the deterministic pair conflict gate was exercised');
  const ambiguity = fixture(['Apple iPhone 17 Pro 256GB', 'Apple iPhone 17 Pro']);
  const ambiguityResult = await C.resolveGroups(ambiguity.inputs, opts(ambiguity.db));
  assert.strictEqual(ambiguityResult.groups.length, 1, 'human-approved missing evidence may remain REVIEW');
  const badKey = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse']);
  badKey.group.canonical_key = 'not-the-identity-key';
  assert.strictEqual((await C.resolveGroups(badKey.inputs, opts(badKey.db))).groups.length, 0);

  const historyFixture = fixture(['Logitech MX Master 3S Wireless Mouse', 'Logitech MX Master 3S Wireless Mouse']);
  const historyGroup = (await C.resolveGroups(historyFixture.inputs, opts(historyFixture.db))).groups[0];
  const today = require('../api/_price').kstToday();
  historyGroup.offers[0].vendorItemId = 'exact-option';
  const historyDb = fakeDb({ price_history: [
    { product_id: historyGroup.offers[0].productId, mall: historyGroup.offers[0].mall, vendor_item_id: '', recorded_at: today + 'T10:00:00+09:00', recorded_date: today, price: 1 },
    { product_id: historyGroup.offers[0].productId, mall: historyGroup.offers[0].mall, vendor_item_id: 'exact-option', recorded_at: today + 'T11:00:00+09:00', recorded_date: today, price: 62000 },
    { product_id: historyGroup.offers[1].productId, mall: historyGroup.offers[1].mall, vendor_item_id: '', recorded_at: today + 'T11:00:00+09:00', recorded_date: today, price: 54000 },
    { product_id: historyGroup.offers[1].productId, mall: 'WRONG_MALL', vendor_item_id: '', recorded_at: today + 'T11:00:00+09:00', recorded_date: today, price: 2 }
  ] });
  const aggregate = await C.loadAggregatedHistory(historyGroup, { db: historyDb });
  assert.deepStrictEqual(aggregate, [{ date: today, price: 54000 }]);
  assert.strictEqual(historyDb.calls.length, 1, 'history is loaded in one batch query');
  const couponLink = `https://link.coupang.com/re/AFFSDP?lptag=${require('../api/_affiliate').SEOSA_COUPANG_LPTAG}&vendorItemId=12345`;
  const exactCoupang = C._internal.toOffer({ product_id: 'cp1', mall: '쿠팡', mall_label: '', title: 'Apple iPhone 17 Pro',
    lprice: 1000000, link: couponLink, image: '', collected_at: new Date().toISOString() },
  { source_mall: '쿠팡', product_id: 'cp1', mall: '쿠팡', vendor_item_id: '12345' });
  assert.ok(exactCoupang && exactCoupang.link === couponLink, 'exact Coupang option affiliate URL is retained');
  const wrongCoupang = C._internal.toOffer({ product_id: 'cp1', mall: '쿠팡', mall_label: '', title: 'Apple iPhone 17 Pro',
    lprice: 1000000, link: couponLink, image: '', collected_at: new Date().toISOString() },
  { source_mall: '쿠팡', product_id: 'cp1', mall: '쿠팡', vendor_item_id: 'different-option' });
  assert.strictEqual(wrongCoupang, null, 'wrong Coupang option affiliate URL is excluded');

  // A bounded DB failure falls back to ungrouped offers.
  const broken = { from() { return { select() { return this; }, in() { return this; }, then(resolve) { resolve({ error: { message: 'missing table' } }); } }; } };
  const fallback = await C.collapseItems(fx.inputs, opts(broken));
  assert.strictEqual(fallback.length, 2);
  assert.ok(C.eligibleForRollout('key', { config: { enabled: true, percent: 100, allowlist: new Set(['key']) } }));
  assert.ok(!C.eligibleForRollout('other', { config: { enabled: true, percent: 100, allowlist: new Set(['key']) } }));
  console.log('canonical consumer tests: PASS');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
