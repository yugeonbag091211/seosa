'use strict';

const COMPOSITE_EXPECTATIONS = Object.freeze([
  { expectedIdentity: 'iPhone 17 Pro' },
  { expectedIdentity: 'MX Master 3S' },
  { expectedIdentity: 'Galaxy S26+' },
  { expectedIdentity: 'AirPods Pro 3' },
  { expectedIdentity: 'Dyson V15 Detect' },
  { expectedIdentity: 'Galaxy Buds3' },
  { expectedIdentity: 'iPhone 17 Pro' },
  // The fixture has no 14-inch LG laptop <= KRW 1,000,000; gram 15 is 15-inch and above budget.
  { expectedIdentity: null, expectedNoProducts: true, reason: 'no 14-inch LG laptop at or below 1000000 KRW in fixture' },
  { expectedIdentity: 'MX Master 3S' },
  { expectedIdentity: null, expectedNoProducts: true }
]);

function compositeExpectation(index) {
  return COMPOSITE_EXPECTATIONS[((Number(index) % COMPOSITE_EXPECTATIONS.length) + COMPOSITE_EXPECTATIONS.length)
    % COMPOSITE_EXPECTATIONS.length];
}

module.exports = { COMPOSITE_EXPECTATIONS, compositeExpectation };
