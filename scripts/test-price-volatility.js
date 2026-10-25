'use strict';
const assert = require('assert');
const { keyOf, volatilityRanking, slotPlan, pickSearchGroups } = require('./_price-volatility');
const day = n => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 86400000).toISOString();
const row = (id, vid, n, price) => ({ product_id: id, mall: '쿠팡', vendor_item_id: vid, recorded_at: day(n), price });
const data = [
  row('hot','A',0,100), row('hot','A',1,200), row('hot','A',2,100), row('hot','A',3,200),
  row('warm','B',0,100), row('warm','B',1,90),
  row('stable','C',0,100), row('stable','C',1,100),
  row('hot','other-option',0,100), row('hot','other-option',1,100)
].reverse(); // id 순 정렬이 기록 시각 순서라고 가정하면 안 된다.
const noon = volatilityRanking(data, 3);
assert.strictEqual(noon.length,1);
assert.strictEqual(noon[0].key,keyOf({product_id:'hot',mall:'쿠팡',vendor_item_id:'A'}));
assert.strictEqual(noon[0].changes,3);
const evening = volatilityRanking(data,1);
assert.strictEqual(evening.length,2);
assert.strictEqual(evening[1].changes,1);
assert.strictEqual(slotPlan(new Date('2026-10-25T03:05:00Z'),'noon').slot,'noon');
assert.strictEqual(slotPlan(new Date('2026-10-25T10:05:00Z'),'evening').minChanges,1);
assert.strictEqual(slotPlan(new Date('2026-10-25T10:05:00Z'),'noon'),null);
assert.strictEqual(slotPlan(new Date('2026-10-25T02:59:00Z'),'noon'),null);
const groups = pickSearchGroups([{mall:'쿠팡',keyword:'버즈',id:1},{mall:'쿠팡',keyword:'버즈',id:2},{mall:'ADPICK',keyword:'버즈',id:3}],5);
assert.strictEqual(groups.length,2);
assert.strictEqual(groups[0].targets.length,2);
console.log('Adaptive volatility regression PASS (12 assertions)');
