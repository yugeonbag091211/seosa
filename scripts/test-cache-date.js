#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { kstDateKey, isSameKstDate } = require('../api/_cache-date');

assert.strictEqual(kstDateKey('2026-09-26T15:01:00.000Z'), '2026-09-27');
assert.strictEqual(isSameKstDate('2026-09-26T15:01:00.000Z', '2026-09-27T00:01:00.000Z'), true,
  'same KST date can span UTC dates');
assert.strictEqual(isSameKstDate('2026-09-26T14:59:00.000Z', '2026-09-26T15:01:00.000Z'), false,
  'cache crossing KST midnight is not same-day');
assert.strictEqual(isSameKstDate('not-a-date', Date.now()), false, 'invalid timestamp is never fresh');
console.log('PASS: KST cache date boundary');