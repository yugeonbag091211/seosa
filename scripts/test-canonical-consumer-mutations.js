'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const modulePath = path.join(__dirname, '..', 'api', '_canonicalconsumer.js');
const testPath = path.join(__dirname, 'test-canonical-consumer.js');
const original = fs.readFileSync(modulePath, 'utf8');
const mutations = [
  ['ACTIVE status gate', "group.status !== 'ACTIVE'", 'false'],
  ['current price freshness gate', '&& currentPriceFresh(row, opts.now)', '&& true'],
  ['catalog vendor option gate', "if (currentVid !== String(member.vendor_item_id || '')) return null;", 'if (false) return null;'],
  ['request vendor option gate', 'if (vendorIdOf(input) === member.vendorItemId)', 'if (true)'],
  ['hard conflict gate', 'if (match.decision === OI.DECISION.NO_MATCH || (match.conflicts || []).length)', 'if (false)'],
  ['canonical identity key gate', 'if (!computed || computed !== version.key) return null;', 'if (false) return null;'],
  ['trusted price gate', "['high', 'medium'].includes(item.trust && item.trust.level)", 'true'],
  ['displayable positive price gate', 'if (Price.isDisplayable(row) && Number(row.lprice) > 0 && currentPriceFresh(row, opts.now)) {', 'if (true) {'],
  ['safe purchase link gate', 'if (!link) return null;', 'if (false) return null;'],
  // 2026-10-14: 스냅숏 비교는 identityVersion() 으로 옮겼다(기존 자리 · matcher 전환 next 자리).
  ['identity snapshot freshness gate', 'const primary = members.every((member, i) => now[i] === P.stableJson(member.identity_snapshot || {}));', 'const primary = true;'],
  ['transition next snapshot gate', 'members.every((member, i) => member.next_identity_snapshot && now[i] === P.stableJson(member.next_identity_snapshot))', 'members.every(member => member.next_identity_snapshot)'],
  ['rollout pinned to first key', 'group.rollout_key || group.canonical_key', 'group.canonical_key'],
  ['feature flag gate','if (!cfg.enabled || cfg.percent <= 0) return items;', 'if (false) return items;']
];

for (let i = 0; i < mutations.length; i++) {
  const [label, before, after] = mutations[i];
  assert.ok(original.includes(before), 'mutation target exists: ' + label);
  const mutantSource = original.replace(before, after);
  assert.notStrictEqual(mutantSource, original, 'mutation changed source: ' + label);
  const mutantPath = path.join(path.dirname(modulePath), '_canonicalconsumer.mutant-' + process.pid + '-' + i + '.js');
  fs.writeFileSync(mutantPath, mutantSource, { flag: 'wx' });
  try {
    const result = spawnSync(process.execPath, [testPath], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, process.env, { CANONICAL_CONSUMER_MODULE: mutantPath })
    });
    assert.notStrictEqual(result.status, 0, 'test suite must fail when protection is removed: ' + label
      + (result.stdout || '') + (result.stderr || ''));
  } finally {
    fs.unlinkSync(mutantPath);
  }
}
console.log('canonical consumer mutation tests: PASS (' + mutations.length + ' protections killed)');
