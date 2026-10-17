import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET_PRESETS, presetTargetPrice } from '../lib/alertTarget.ts';

test('alert target presets: expose the intended quick choices', () => {
  assert.deepEqual([...TARGET_PRESETS], [5, 10, 20]);
});

test('alert target presets: round down to a clean 100-won goal', () => {
  assert.equal(presetTargetPrice(15_900, 5), 15_100);
  assert.equal(presetTargetPrice(15_900, 10), 14_300);
  assert.equal(presetTargetPrice(15_900, 20), 12_700);
});

test('alert target presets: small prices use a 10-won step and stay positive', () => {
  assert.equal(presetTargetPrice(990, 10), 890);
  assert.equal(presetTargetPrice(50, 20), 40);
});

test('alert target presets: invalid current price or percentage fails closed', () => {
  assert.equal(presetTargetPrice(0, 10), 0);
  assert.equal(presetTargetPrice(Number.NaN, 10), 0);
  assert.equal(presetTargetPrice(10_000, 0), 0);
  assert.equal(presetTargetPrice(10_000, 100), 0);
});
