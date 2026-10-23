'use strict';

const assert = require('node:assert/strict');
const { scopeDropPassed } = require('./_verify-ai-live-evaluator');

assert.equal(scopeDropPassed({ verify: { budgetDropped: true }, cards: [{ lprice: 420000 }] }), true,
  'a changed topic passes only when the old budget was dropped and priced cards were returned');
assert.equal(scopeDropPassed({ verify: { budgetDropped: false }, cards: [{ lprice: 420000 }] }), false,
  'the previous product budget must be dropped');
assert.equal(scopeDropPassed({ verify: { budgetDropped: true }, cards: [] }), false,
  'an empty search cannot verify the changed-topic result');
assert.equal(scopeDropPassed({ verify: { budgetDropped: true }, cards: [{ lprice: 0 }] }), false,
  'returned cards must have a positive numeric price');

console.log('PASS live verification evaluator: budget scope requires dropped budget and priced cards');
