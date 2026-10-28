'use strict';
/* Pure offline checks — NEVER call a real API/DB. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Planner = require('../api/_collectplan');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  PASS', name); }
const dayStartMs = Date.parse('2026-10-18T00:00:00+09:00');
const product = days => ({ collected_at: new Date(dayStartMs - days * 86400000).toISOString() });

check('provider recovery ordering uses dated weights', () => {
  assert.equal(Planner.recoveryProbability('쿠팡', 1), 0.587);
  assert.equal(Planner.recoveryProbability('쿠팡', 8), 0.071);
  assert.equal(Planner.recoveryProbability('ADPICK', 1), 0.48);
  assert.equal(Planner.recoveryProbability('ADPICK', 30), 0.06);
});
check('one recent target beats up to eight stale targets only when expected value is higher', () => {
  const recent = { q: 'recent', rows: [product(2)] };
  const stale = { q: 'stale', rows: Array.from({ length: 5 }, () => product(40)) };
  const sorted = Planner.orderRecoveryQueue([stale, recent], { mall: '쿠팡', dayStartMs });
  assert.deepEqual(sorted.map(x => x.q), ['recent', 'stale']);
});
check('enough stale targets can still win — not a hard discard', () => {
  const a = { q: 'recent', rows: [product(2)] };
  const b = { q: 'stale', rows: Array.from({ length: 10 }, () => product(40)) };
  assert.deepEqual(Planner.orderRecoveryQueue([a,b], { mall:'쿠팡',dayStartMs }).map(x=>x.q), ['stale','recent']);
});
check('ADPICK now prioritizes a recent target over three stale targets', () => {
  const recent = { q:'recent', rows:[product(4)] };
  const stale = { q:'stale', rows:[product(50), product(50), product(50)] };
  assert.deepEqual(Planner.orderRecoveryQueue([stale,recent],{mall:'ADPICK',dayStartMs}).map(x=>x.q),['recent','stale']);
});
check('ADPICK still considers stale groups when their aggregate expected yield is larger', () => {
  const recent = { q:'recent', rows:[product(4)] };
  const stale = { q:'stale', rows:Array.from({length:9}, () => product(50)) };
  assert.deepEqual(Planner.orderRecoveryQueue([recent,stale],{mall:'ADPICK',dayStartMs}).map(x=>x.q),['stale','recent']);
});
check('ADPICK missing / invalid observation dates are never treated as recent', () => {
  assert.equal(Planner.recoveryProbability('ADPICK',null),0.06);
  assert.equal(Planner.recoveryProbability('ADPICK',NaN),0.06);
  assert.equal(Planner.recoveryProbability('ADPICK',7),0.48);
  assert.equal(Planner.recoveryProbability('ADPICK',7.01),0.06);
});
check('stable tie-break keeps original round order', () => {
  const a={q:'a',rows:[product(1)]},b={q:'b',rows:[product(1)]};
  assert.deepEqual(Planner.orderRecoveryQueue([a,b],{mall:'쿠팡',dayStartMs}),[a,b]);
});
check('invalid / missing date remains stale, never treated as fresh', () => {
  assert.equal(Planner.recoveryProbability('쿠팡',null),0.071);
  assert.equal(Planner.recoveryProbability('쿠팡',NaN),0.071);
  assert.equal(Planner.recoveryProbability('쿠팡',7),0.587);
  assert.equal(Planner.recoveryProbability('쿠팡',7.01),0.071);
});
check('no mutation and no disappearance of a search group', () => {
  const a={q:'a',rows:[product(25)]},b={q:'b',rows:[product(2)]};
  const input=[a,b];
  const out=Planner.orderRecoveryQueue(input,{mall:'쿠팡',dayStartMs});
  assert.deepEqual(input,[a,b]);
  assert.equal(out.length,input.length);
  assert.deepEqual(new Set(out),new Set(input));
});
check('source runs only the pure planner and retains existing option filter', () => {
  const s=fs.readFileSync(require.resolve('./collect-all-prices'), 'utf8');
  assert.match(s,/Planner\.orderRecoveryQueue\(/);
  assert.match(s,/const targets = rows\.filter\(p => uncovered\.has/);
  assert.match(s,/!isTerminalOption\(p\)/);
});
console.log('Results:', passed, 'PASS / 0 FAIL');
