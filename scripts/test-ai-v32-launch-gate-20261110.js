'use strict';
const assert = require('node:assert/strict');
const { summarize } = require('./ai-v32-eval/regrade');
const row = (verdict, outcome='CORRECT_NO_RESULT') => ({
  verdict, outcome, expect: 'NO_RESULT', cards: [],
  cardChecks: [], elapsedMs: 1500, modelUsage: null
});
const s = summarize([
  row('PASS', 'CORRECT_NON_SHOPPING'),
  row('PASS', 'CORRECT_CARDS'),
  row('FAIL', 'WRONG_CARDS'),
  row('UNVERIFIED', 'CORRECT_NO_RESULT'),
  row('UNVERIFIED', 'CORRECT_NO_RESULT')
]);
assert.equal(s.questions, 5);
assert.deepEqual(s.verdicts, { PASS: 2, FAIL: 1, UNVERIFIED: 2 });
assert.deepEqual(s.launchGate, {
  policy: 'PASS_ONLY',
  passed: 2,
  failed: 3,
  unverifiedCountedAsFail: 2,
  successRatePercent: 40
});
assert.equal(s.verdicts.UNVERIFIED, 2, 'Do not destroy diagnostic labels');
assert.equal(s.launchGate.passed + s.launchGate.failed, s.questions);
const empty=summarize([]);
assert.equal(empty.launchGate.passed, 0);
assert.equal(empty.launchGate.failed, 0);
assert.equal(empty.launchGate.successRatePercent, null);
const full=summarize([row('PASS')]);
assert.equal(full.launchGate.successRatePercent, 100);
assert.equal(full.launchGate.failed, 0);
const noPass=summarize([row('UNVERIFIED')]);
assert.equal(noPass.launchGate.successRatePercent, 0);
assert.equal(noPass.launchGate.failed, 1);
console.log(JSON.stringify({passed: 10, failed: 0, launchGate: s.launchGate}));
