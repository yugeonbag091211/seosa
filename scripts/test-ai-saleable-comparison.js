'use strict';
const assert=require('node:assert/strict');
const C=require('../api/_ai-comparison');
const AIID=require('../api/_aiidentity');
const bad=[
  '[해외] 삼성 갤럭시 탭 A 8.0 T380 T385 터치 스크린 SM T380 SM-T385용 8인치 유리',
  '갤럭시탭 S9 FE 보호 필름 2매',
  '갤럭시 탭 S10 터치 패널 교체용 부품',
  'Galaxy Tab S9 replacement screen glass',
  '아이패드 에어 11 액정 교체 부품',
  'iPad mini LCD screen replacement'
];
const good=[
  '삼성전자 갤럭시탭 S9 FE 128GB Wi-Fi 태블릿',
  '삼성 갤럭시 탭 A 8.0 32GB WiFi 태블릿 본체',
  'Apple 2025 아이패드 (A16 모델) 128GB Wi-Fi',
  'Apple iPad Air 11 M3 256GB Wi-Fi 태블릿',
  '삼성 갤럭시탭 S10 FE 128GB 터치스크린 지원 태블릿'
];
for(const title of bad)assert.equal(C.isComparableOffer(/아이패드|ipad/i.test(title)?'아이패드':'갤럭시탭',title),false,title);
for(const title of good)assert.equal(C.isComparableOffer(/아이패드|ipad/i.test(title)?'아이패드':'갤럭시탭',title),true,title);
const mk=(title,price,id)=>({title,lprice:price,productId:id,mall:'ADPICK',isCoupang:false,link:'https://merchant.example/'+id});
const normalize=x=>({...x,price:x.lprice,mallId:x.mall});
const polluted=[
 mk(bad[0],15700,'GLASS'),mk(good[0],429000,'TABLET'),
 mk('갤럭시탭 S9 케이스',9900,'CASE')
];
const selected=C.pickExact(polluted,'갤럭시탭',AIID,normalize);
assert.equal(selected&&selected.productId,'TABLET','real device must be selected ahead of cheap glass');
assert.equal(C.pickExact([polluted[0]],'갤럭시탭',AIID,normalize),null,'glass-only must return no confirmed tablet');
assert.equal(C.pickExact([mk(good[2],621300,'IPAD')],'아이패드',AIID,normalize)?.productId,'IPAD');
console.log('AI_TABLET_SALEABLE_COMPARISON '+JSON.stringify({pass:bad.length+good.length+3,fail:0,realGptCalls:0,realMerchantCalls:0,dbWrites:0}));
