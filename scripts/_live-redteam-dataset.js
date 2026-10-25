'use strict';

const COMPOSITE_EXPECTATIONS = Object.freeze([
  { expectedIdentity: 'iPhone 17 Pro' },
  { expectedIdentity: 'MX Master 3S' },
  { expectedIdentity: 'Galaxy S26+' },
  { expectedIdentity: 'AirPods Pro 3' },
  { expectedIdentity: 'Dyson V15 Detect' },
  { expectedIdentity: 'Galaxy Buds3' },
  { expectedIdentity: 'iPhone 17 Pro' },
  { expectedIdentity: 'LG gram 15' },
  { expectedIdentity: 'MX Master 3S' },
  { expectedIdentity: null, expectedNoProducts: true }
]);

function compositeExpectation(index) {
  return COMPOSITE_EXPECTATIONS[((Number(index) % COMPOSITE_EXPECTATIONS.length) + COMPOSITE_EXPECTATIONS.length)
    % COMPOSITE_EXPECTATIONS.length];
}

module.exports = { COMPOSITE_EXPECTATIONS, compositeExpectation };
