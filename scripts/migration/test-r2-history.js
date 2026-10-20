#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const archive=require('../../api/_r2history');
let passed=0;
function check(name,fn){fn();passed++;console.log('PASS '+name);}
const row=(pid='7912306911',v='123',p=25900)=>({product_id:pid,mall:'쿠팡',vendor_item_id:v,recorded_at:'2026-08-14T17:12:36.855Z',recorded_date:'2026-08-15',price:p});
check('stable deterministic shard key',()=>{assert.equal(archive.keyOf('7912306911'),archive.keyOf('7912306911'));});
check('Korean historical product ids supported',()=>{assert.match(archive.keyOf('보관함 신발 제품, 3개'),/^history\/v1\/shards\/[0-9a-f]{2}\.jsonl\.gz$/);});
check('control characters prohibited',()=>{assert.throws(()=>archive.keyOf('test\nabc'));});
check('SQL/URL strings cannot influence object path',()=>{assert.match(archive.keyOf('test/../'+'x'),/^history\/v1\/shards\/[0-9a-f]{2}\.jsonl\.gz$/);});
check('same online and archived reading deduplicates',()=>{
 const old=row();const online={recorded_at:new Date(old.recorded_at),recorded_date:new Date(old.recorded_date),price:old.price,vendor_item_id:old.vendor_item_id};
 const merged=archive.mergeHistory([online],[old],{productId:old.product_id,mall:old.mall});assert.equal(merged.length,1);
});
check('different vendor option not merged',()=>{
 const list=archive.mergeHistory([row('abc','11')],[row('abc','22')]);assert.equal(list.length,2);
});
check('different seller and price not merged',()=>{
 const list=archive.mergeHistory([row('abc','11',20000)],[{...row('abc','11',30000),mall:'ADPICK'}]);assert.equal(list.length,2);
});
console.log('R2_ARCHIVE_UNIT_TESTS '+passed+'/'+passed+' PASS');
