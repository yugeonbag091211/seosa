'use strict';

const assert = require('node:assert/strict');
const { scopeDropPassed, confirmedMerchantResult } = require('./_verify-ai-live-evaluator');

assert.equal(scopeDropPassed({ verify: { budgetDropped: true }, cards: [{ lprice: 420000 }] }), true,
  'a changed topic passes only when the old budget was dropped and priced cards were returned');
assert.equal(scopeDropPassed({ verify: { budgetDropped: false }, cards: [{ lprice: 420000 }] }), false,
  'the previous product budget must be dropped');
assert.equal(scopeDropPassed({ verify: { budgetDropped: true }, cards: [] }), false,
  'an empty search cannot verify the changed-topic result');
assert.equal(scopeDropPassed({ verify: { budgetDropped: true }, cards: [{ lprice: 0 }] }), false,
  'returned cards must have a positive numeric price');

assert.equal(confirmedMerchantResult({status:200,verify:{search:'found'},cards:[{lprice:30000}]}),true);
assert.equal(confirmedMerchantResult({status:200,verify:{search:'failed'},cards:[]}),false,
  'a fail-closed search outage is safe but is not a verified shopping search success');
assert.equal(confirmedMerchantResult({status:200,verify:{search:'empty'},cards:[]}),false,
  'zero catalog matches cannot be counted as a product result');
assert.equal(confirmedMerchantResult({status:200,verify:{search:'found'},cards:[]}),false,
  'found state alone without returned products does not prove result coverage');
console.log('PASS live verification evaluator: budget scope and merchant-search coverage');
