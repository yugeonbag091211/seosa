'use strict';
const assert = require('node:assert/strict');
const Stage = require('./stage-coupang-channel-links');
const original = 'https://www.coupang.com/vp/products/8423575385?itemId=24367268877&vendorItemId=94530587273';
const tagged = 'https://link.coupang.com/re/AFFSDP?lptag=AF8789251&itemId=24367268877&vendorItemId=94530587273&subId=SEOSA2026';
const input = [{
  product_id: '8423575385', item_id: '24367268877',
  vendor_item_id: '94530587273', original_url: original
}];
function payload(landing=tagged, orig=original) {
  return { rCode:'0', data:[{ originalUrl:orig, landingUrl:landing }] };
}
assert.deepEqual(Stage.argsOf([]), {limit:10,offset:0,productId:'',execute:false,write:false});
assert.deepEqual(Stage.argsOf(['--limit=25','--offset=2','--execute','--write']),
  {limit:25,offset:2,productId:'',execute:true,write:true});
assert.equal(Stage.argsOf(['--productId=8423575385']).productId,'8423575385');
for (const bad of ['--limit=26','--limit=-1','--limit=xyz','--offset=-1','--offset=1.5']) {
  assert.throws(() => Stage.argsOf([bad]), /invalid bounded/);
}
assert.equal(Stage.tuple({ product_id:'8423575385',item_id:'24367268877',
  vendor_item_id:'94530587273' }).original_url, original);
assert.equal(Stage.tuple({product_id:'bad',item_id:'24367268877',vendor_item_id:'94530587273'}),null);
assert.equal(Stage.tripleFromUrl(original),'8423575385|24367268877|94530587273');
assert.equal(Stage.tripleFromUrl('https://evil.example/vp/products/8423575385?itemId=24367268877&vendorItemId=94530587273'),'');
assert.equal(Stage.validateBatch(input,payload())[0].landing_url,tagged);
assert.throws(() => Stage.validateBatch(input,{rCode:'5',data:[]}), /not verified/);
assert.throws(() => Stage.validateBatch(input,{rCode:'0',data:[]}), /incomplete/);
assert.throws(() => Stage.validateBatch(input,{rCode:'0',data:[payload().data[0],payload().data[0]]}), /duplicate/);
assert.throws(() => Stage.validateBatch(input,payload(tagged,original.replace('8423575385','8000000000'))), /unexpected/);
assert.throws(() => Stage.validateBatch(input,payload(tagged.replace('subId=SEOSA2026','subId=OTHER2026'))), /unverified/);
assert.throws(() => Stage.validateBatch(input,payload(tagged.replace('vendorItemId=94530587273','vendorItemId=90000000000'))), /invalid|unverified/);
assert.throws(() => Stage.validateBatch(input,payload(tagged.replace('itemId=24367268877','itemId=90000000000'))), /unverified/);
assert.throws(() => Stage.validateBatch(input,payload(tagged.replace('lptag=AF8789251','lptag=AF9999999'))), /invalid/);
console.log('PASS Coupang stage: 18 offline checks, no provider requests or DB writes');
