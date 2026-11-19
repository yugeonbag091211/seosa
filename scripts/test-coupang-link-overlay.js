'use strict';
const assert = require('node:assert/strict');
const O = require('../api/_coupang-link-overlay');
const tagged = 'https://link.coupang.com/re/AFFSDP?lptag=AF8789251&itemId=24367268877&vendorItemId=94530587273&subId=SEOSA2026';
const legacy = 'https://link.coupang.com/re/AFFSDP?lptag=AF8789251&itemId=24367268877&vendorItemId=94530587273';
const item = { productId: '8423575385', vendorItemId: '94530587273', mall: '쿠팡', link: legacy, url: legacy, productUrl: legacy };
const sample = { product_id: '8423575385', item_id: '24367268877', vendor_item_id: '94530587273', sub_id: 'SEOSA2026', landing_url: tagged };
function fakeDb(proof, staged) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      return {
        select() { return this; }, eq() { return this; },
        gte() { return this; }, gt() { return this; },
        in() { return this; },
        async limit() { return { data: table === 'coupang_partner_channel_daily' ? proof : staged, error: null }; }
      };
    }
  };
}
async function main() {
  const saved = { ...process.env };
  try {
    delete process.env.COUPANG_LINKS_ROLLOUT;
    process.env.COUPANG_CHANNEL_SUBID = 'SEOSA2026';
    process.env.COUPANG_LINKS_PERCENT = '100';
    let db = fakeDb([{ clicks: 2 }], [sample]);
    assert.deepEqual(await O.overlay([item], db), [item]);
    assert.equal(db.calls.length, 0, 'default off, no reads');
    process.env.COUPANG_LINKS_ROLLOUT = '1';
    process.env.COUPANG_LINKS_PERCENT = '101';
    db = fakeDb([{ clicks: 2 }], [sample]);
    assert.deepEqual(await O.overlay([item], db), [item]);
    assert.equal(db.calls.length, 0, 'out-of-range rollout off');
    process.env.COUPANG_LINKS_PERCENT = '100';
    db = fakeDb([], [sample]);
    assert.deepEqual(await O.overlay([item], db), [item]);
    assert.deepEqual(db.calls, ['coupang_partner_channel_daily'], 'proof gate stops staging');
    db = fakeDb([{ clicks: 1 }], [sample]);
    const applied = await O.overlay([item], db);
    assert.equal(applied[0].link, tagged);
    assert.equal(applied[0].url, tagged);
    assert.equal(item.link, legacy, 'historical input immutable');
    assert.equal(applied[0].productUrl, tagged);
    assert.deepEqual(db.calls, ['coupang_partner_channel_daily','coupang_channel_deeplinks']);
    db = fakeDb([{ clicks: 1 }], [{ ...sample, landing_url: legacy }]);
    assert.deepEqual(await O.overlay([item], db), [item], 'untagged fails closed');
    db = fakeDb([{ clicks: 1 }], [{ ...sample, vendor_item_id: '90000000000' }]);
    assert.deepEqual(await O.overlay([item], db), [item], 'wrong option fails closed');
    db = fakeDb([{ clicks: 1 }], [sample, { ...sample, item_id: '99999999999' }]);
    assert.deepEqual(await O.overlay([item], db), [item], 'ambiguous option fails closed');
    db = fakeDb([{ clicks: 1 }], [sample]);
    assert.deepEqual(await O.overlay([{ ...item, mall: 'ADPICK' }], db), [{ ...item, mall: 'ADPICK' }]);
    assert.equal(db.calls.length, 0, 'non-Coupang no reads');
    db = fakeDb([{ clicks: 1 }], [sample]);
    const view = { product: { ...item }, canonical: null };
    await O.overlayProductView(view, db);
    assert.equal(view.product.link, tagged);
    assert.equal(O.key({ productId: '8423575385', mall: '쿠팡', vendorItemId: '94530587273' }), '8423575385|94530587273');
    console.log('PASS Coupang staged link overlay: default off, proof, option identity, ambiguity, ADPICK, product view');
  } finally {
    for (const k of ['COUPANG_LINKS_ROLLOUT', 'COUPANG_LINKS_PERCENT', 'COUPANG_CHANNEL_SUBID']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
