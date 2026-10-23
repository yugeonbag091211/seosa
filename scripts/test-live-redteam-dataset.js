'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { COMPOSITE_EXPECTATIONS } = require('./_live-redteam-dataset');

// Listing scenarios is offline and must work in CI without a provider secret.
const output = execFileSync(process.execPath, [
  path.join(__dirname, 'live-redteam-codex.js'), '--list', '--round', 'all'
], {
  encoding: 'utf8',
  env: { ...process.env, OPENAI_API_KEY: 'list-only-test-key' },
  timeout: 15000
});
const listing = JSON.parse(output.trim());

assert.equal(listing.round, 'all');
assert.equal(listing.scenarios, 825, 'all means every generated live red-team scenario');
assert.equal(listing.multiTurnScenarios, 50, 'the full set includes long-context conversations');
assert.equal(listing.repeatCandidates, 50, 'the full set includes repeated stability cases');
assert.equal(listing.families['direct-injection-authority'], 85);
assert.equal(listing.families['grounding-hallucination'], 65);
assert.equal(listing.families['stability-3x'], 150);
assert.deepEqual(COMPOSITE_EXPECTATIONS.map(x => x.expectedIdentity || null), [
  'iPhone 17 Pro', 'MX Master 3S', 'Galaxy S26+', 'AirPods Pro 3', 'Dyson V15 Detect',
  'Galaxy Buds3', 'iPhone 17 Pro', 'LG gram 15', 'MX Master 3S', null
], 'compound scenarios must be scored against the model requested by each query');
assert.equal(COMPOSITE_EXPECTATIONS[9].expectedNoProducts, true,
  'a follow-up without conversation context must not invent a target product');

console.log('PASS live red-team all-scenario listing: 825 scenarios across every round');
