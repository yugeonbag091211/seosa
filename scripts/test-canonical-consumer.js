'use strict';
const assert = require('assert');
const OI = require('../api/_offeridentity');
const P = require('../api/_identitypromotion');
const C = require(process.env.CANONICAL_CONSUMER_MODULE || '../api/_canonicalconsumer');

function fixture(titles, options = {}) {
  const products = titles.map((title, i) => ({
    product_id: String(700 + i), mall: options.mall || 'ADPICK',
    mall_label: options.labels ? options.labels[i] : ['Hmall', 'Lotte Home Shopping'][i],
    vendor_item_id: options.vids ? options.vids[i] : '', title,
    gtin: options.gtins ? options.gtins[i] : '',
    lprice: [62000, 54000][i], link: 'https://biz.adpick.co.kr/offer/' + i,
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
  assert.strictEqual(collapsed[0].lowestMerchant, 'Lotte Home Shopping');
  assert.strictEqual(collapsed[0].productId, fx.inputs[0].productId, 'the ranked representative remains the card identity');

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
