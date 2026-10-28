#!/usr/bin/env node
'use strict';

/*
 * Price continuity regression — no external calls or database writes.
 * Initial provider-search price is intentionally different from the same
 * product/option's cached catalogue price. Do NOT report the older value as
 * a current checkout price or fabricate a buying recommendation.
 */
const assert = require('node:assert/strict');
const H = require('./_ai-chat-harness');
const F = require('./_ai-chat-fixtures');
const AC = require('../api/_aicontext');
const PC = require('../api/_ai-price-continuity');
F.ALL.forEach(H.addProduct);

async function main() {
  const gram = F.GRAM_15;
  // Isolate this same-offer price contract. Other gram models are covered by
  // ranking tests and must not unexpectedly win this price provenance test.
  H.catalog.filter(it => it.productId !== gram.pid && /그램/.test(it.title))
    .forEach(it => { it._keys = []; });
  const listing = H.catalog.find(it => it.productId === gram.pid);
  const stored = H.tables.products.find(it => it.product_id === gram.pid);
  assert.ok(listing && stored, 'fixture product exists');
  const searchPrice = Number(stored.lprice) + 100000;
  listing.lprice = searchPrice;

  const s = H.session();
  const first = await s.say('노트북 그램으로 추천해줘', {
    classify: 'C|그램 노트북',
    answer: '그램15 모델을 추천드려요. 구매 전에 옵션을 확인해 주세요.'
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.topProductId, gram.pid);
  assert.equal(first.body.items[0].lprice, searchPrice);
  assert.ok(s.prevTopRef, 'issued signed recommendation reference');

  const verified = AC.verifyRecommendationRef(s.prevTopRef);
  assert.equal(verified.searchPrice, searchPrice);
  assert.ok(Number.isFinite(verified.searchAt));
  const altered = s.prevTopRef.slice(0, -2) + (s.prevTopRef.slice(-2, -1) === 'a' ? 'b' : 'a') + s.prevTopRef.slice(-1);
  assert.equal(AC.verifyRecommendationRef(altered), null, 'changed HMAC cannot validate');

  const follow = await s.say('지금 사는 게 좋을까?', {
    answer: '현재 ' + Number(stored.lprice).toLocaleString('en-US') + '원으로 무조건 지금 사세요.'
  });
  assert.equal(follow.status, 200);
  assert.equal(follow.searches, 0, 'no new product search');
  assert.equal(follow.body.items.length, 1, 'same offer and option');
  assert.equal(follow.body.items[0].productId, gram.pid);
  assert.equal(follow.body.degraded, true);
  assert.equal(follow.body.priceConflict.earlierSearchPrice, searchPrice);
  assert.equal(follow.body.priceConflict.storedPrice, Number(stored.lprice));
  assert.ok(follow.body.text.includes(searchPrice.toLocaleString('en-US') + '원'));
  assert.ok(follow.body.text.includes(Number(stored.lprice).toLocaleString('en-US') + '원'));
  assert.ok(!follow.body.text.includes('무조건 지금 사세요'));
  assert.ok(/결제 가격인지 다시 확인하지 못/.test(follow.body.text));
  assert.ok(!/지금 사도 좋은 값/.test(follow.body.text));

  // A follow-up must keep the original signed observation, not overwrite it
  // with the old catalogue price when issuing a new token.
  assert.equal(AC.verifyRecommendationRef(s.prevTopRef).searchPrice, searchPrice);
  const why = await s.say('이거 왜 추천했어?', {
    answer: '가격 기록상 무조건 구매하셔야 해요.'
  });
  assert.equal(why.body.priceConflict.earlierSearchPrice, searchPrice);
  assert.ok(/두 가격은 확인한 시점이/.test(why.body.text));

  assert.equal(PC.priceConflict(verified, {
    productId: gram.pid, vendorItemId: (gram.vid || '') + '-different', mallId: gram.mall || '쿠팡',
    price: Number(stored.lprice)
  }), null, 'different option must never reuse observation');
  assert.equal(PC.priceConflict(verified, {
    productId: gram.pid, vendorItemId: gram.vid || '', mallId: gram.mall || '쿠팡',
    price: searchPrice
  }), null, 'same price is not a conflict');
  assert.equal(H.counters.dbWrites, 0);
  assert.equal(H.counters.external, 0);
  console.log('PRICE_CONTINUITY 22+ assertions PASS: signed price, HMAC, offer identity, follow-up safety');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
