const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual recommendation handler source with isolated imports; no DB or provider calls.
const summer = ['수영복', '물놀이 용품'];
const source = fs.readFileSync(path.join(__dirname, '../api/rec.js'), 'utf8');
const sandbox = {
  module: { exports: {} },
  require(id) { return id === './_shop' ? { TODAY_PICKS: summer } : {}; }
};
vm.runInNewContext(source + '\nmodule.exports.seasonalPicks = seasonalPicks;', sandbox);
const picks = sandbox.module.exports.seasonalPicks;
const at = iso => Array.from(picks(new Date(iso)));
assert.deepEqual(at('2026-05-31T14:59:59Z'), ['무선 이어폰', '노트북', '스마트워치', '키보드', '운동화', '텀블러', '조명', '향수']);
assert.deepEqual(at('2026-05-31T15:00:00Z'), summer);
assert.deepEqual(at('2026-08-31T14:59:59Z'), summer);
assert.ok(!at('2026-08-31T15:00:00Z').includes('물놀이 용품'));
assert.ok(!at('2026-11-25T00:00:00Z').includes('수영복'));
assert.ok(at('2026-12-31T15:00:00Z').includes('노트북'));
console.log('PASS: seasonal recommendation defaults (6 checks)');
