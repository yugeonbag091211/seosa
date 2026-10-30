'use strict';
const assert = require('node:assert/strict');
const { pacingForSearchCap, MAX_GRACE_MS, MAX_HTTP_MS } = require('../api/_ai-search-pacing');
let checks = 0;
for (const cap of [1, 100, 1500, 5000, 9000, 12000, 14000, 17000, 30000]) {
  const r = pacingForSearchCap(cap);
  assert.ok(r.maxWaitMs >= 0 && r.maxWaitMs <= MAX_GRACE_MS);
  assert.ok(r.timeoutMs >= 1 && r.timeoutMs <= MAX_HTTP_MS);
  assert.ok(r.maxWaitMs + r.timeoutMs <= cap, 'wait plus HTTP timeout must remain under cap: '+cap);
  checks++;
}
assert.deepEqual(pacingForSearchCap(17000), {maxWaitMs:8500,timeoutMs:6500});
assert.deepEqual(pacingForSearchCap(14000), {maxWaitMs:5500,timeoutMs:6500});
assert.deepEqual(pacingForSearchCap(9000), {maxWaitMs:700,timeoutMs:6500});
assert.deepEqual(pacingForSearchCap(1000), {maxWaitMs:0,timeoutMs:800});
checks += 4;
// The pacing plan never changes the provider quota or issues an extra call.
// Existing api/_adpicklimit.js tests exercise the actual limiter.
console.log('PASS AI ADPICK bounded wait/timeout pacing: '+checks+' cases (zero vendor calls)');
