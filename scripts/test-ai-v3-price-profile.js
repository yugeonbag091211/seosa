'use strict';
const assert = require('node:assert/strict');
// _pricestat imports the normal DB adapter at module load. These tests inject
// their own DB, so no network client or credentials are required.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === '@supabase/supabase-js') return { createClient() { throw new Error('unexpected network'); } };
  return originalLoad.call(this, name, ...args);
};
const { attachPriceStats } = require('../api/_ai-v3-catalog');
const { assessTiming, timingMessage } = require('../api/_ai-v3-timing');
const { applyProfile, updateProfile } = require('../api/_ai-v3-profile');
const { kstToday } = require('../api/_price');

(async () => {
  const date = n => kstToday(new Date(Date.now() - n * 86400000));
  const rows = [5,4,3,2,1,0].map(n => ({product_id:'1', mall:'쿠팡', vendor_item_id:'a', price:10000 + n*100,
    recorded_date:date(n)}));
  rows.push({product_id:'1', mall:'쿠팡', vendor_item_id:'b', price:999999, recorded_date:date(0)});
  let calls = 0;
  const db = { from(table) { assert.equal(table, 'price_history'); calls++;
    const builder = { select(){return this}, in(){return this}, gte(){return this}, order(){return this},
      limit(){return Promise.resolve({data:rows})} }; return builder; } };
  const items = [{ productId:'1', mall:'쿠팡', vendorItemId:'a', price:10000 },
    { productId:'1', mall:'쿠팡', vendorItemId:'', price:10000 }];
  await attachPriceStats(items, db);
  assert.equal(calls, 1);
  assert.equal(items[0].stat.count, 6);
  assert.equal(items[0].stat.high, 10500);
  assert.equal(items[1].stat, undefined);
  assert.equal(assessTiming(items[0], null), null);
  assert.equal(assessTiming(items[0], {...items[0].stat, lastDate:'2000-01-01'}), null);
  const assessment = assessTiming(items[0], items[0].stat);
  assert.ok(assessment && assessment.dealScore >= 0 && assessment.dealScore <= 100);
  assert.match(timingMessage(assessment), /6일의 가격 기록/);
  const profile = { preferredBrands:['삼성'], budgetRange:{min:100,max:200} };
  assert.equal(applyProfile(profile, {mode:'recommend'}).maxPrice, 200);
  assert.equal(applyProfile(profile, {mode:'recommend', maxPrice:500}).maxPrice, 500);
  let rpcArgs;
  const profileDb = {rpc(_name, args) { rpcArgs=args; return Promise.resolve({error:null}); }};
  assert.equal(await updateProfile('a'.repeat(64), {brandTerm:'삼성', category:'노트북', maxPrice:200, explicitBudget:true}, {db:profileDb}), true);
  assert.equal(rpcArgs.p_brand, '삼성');
  assert.equal(rpcArgs.p_category, '노트북');
  assert.equal(rpcArgs.p_budget_max, 200);
  assert.equal(await updateProfile('unverified-email', {}, {db:profileDb}), false);
  console.log('PASS ai-v3 price history, timing and profile');
})().catch(error => { console.error(error); process.exitCode=1; });
