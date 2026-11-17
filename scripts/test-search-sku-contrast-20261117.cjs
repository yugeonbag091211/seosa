'use strict';
// Explicit buyer contracts for SKU attributes, accessories, compatibility and
// storage. Data is synthetic, no external network, production DB, or LLM.
const assert=require('node:assert/strict');
const Gate=require('../api/_product-gate');
let passed=0;
const contrasts=[
  ['앤커 Nano II 65W 충전기','앤커 Nano II 65W 충전기','앤커 Nano II 45W 충전기',55000],
  ['브리타 마렐라 XL 정수기','브리타 마렐라 XL 정수기','브리타 마렐라 쿨 정수기',38000],
  ['캐리어 16L 제습기','캐리어 16L 제습기','캐리어 18L 제습기',290000],
  ['캐리어 16L 제습기 본품이면 사은품이 함께 와도 좋아','캐리어 16L 제습기 본품 + 배수 호스 증정','캐리어 18L 제습기 본품 + 사은품 증정',290000]
];
for(const [q,correct,wrong,price] of contrasts){
 const spec=Gate.parseQuery(q,{titles:[correct,wrong]});
 const yes=Gate.judge(spec,{title:correct,lprice:price});
 assert.equal(yes.ok,true,JSON.stringify({q,correct,idText:spec.idText,hard:yes.hard}));
 passed++;
 const no=Gate.judge(spec,{title:wrong,lprice:price});
 assert.equal(no.ok,false,JSON.stringify({q,wrong,measures:spec.measures,hard:no.hard}));
 passed++;
 const saved=Gate.saveFilter(q,[{title:wrong,lprice:price,productId:'test-wrong'}]);
 assert.equal(saved.save.length,0,'wrong option saved for '+q);
 passed++;
}
const parts=[
 ['후지필름 X-S20용 교체 배터리 찾는 중이야. 본품은 말고','후지필름 X-S20용 교체 배터리 정품','후지필름 X-S20용 다른 부품 교체용'],
 ['티피링크 Archer AX73 와이파이 공유기에 쓸 전원 어댑터만 구매하고 싶어','티피링크 Archer AX73용 전원 어댑터 정품','티피링크 Archer AX73 와이파이 공유기 본품'],
 ['가민 Forerunner 265 스마트워치에 쓸 시계 스트랩만 구매하고 싶어','가민 Forerunner 265용 시계 스트랩 정품','가민 Forerunner 265 스마트워치 본품'],
 ['필립스 HR2228 블렌더에 쓸 칼날만 구매하고 싶어','필립스 HR2228용 칼날 정품','필립스 HR2228 블렌더 본품'],
 ['이케아 KALLAX 2x4 선반에 쓸 선반 바스켓만 구매하고 싶어','이케아 KALLAX 2x4용 선반 바스켓 정품','이케아 KALLAX 2x4 선반 본품'],
 ['한샘 말고 다른 회사의 수납장 추천해줘','삼성전자 수납장 일반형','삼성전자 수납장용 서랍 손잡이 단품'],
 ['무인양품 3단 원목 서랍장 60cm용 서랍 레일 찾는 중이야. 본품은 말고',
  '무인양품 3단 원목 서랍장 60cm용 서랍 레일 정품',
  '무인양품 3단 원목 서랍장 60cm 서랍장 본품']
];
for(const [q,correct,wrong] of parts){
 const spec=Gate.parseQuery(q,{titles:[correct,wrong]});
 const good=Gate.judge(spec,{title:correct,lprice:60000});
 assert.equal(good.ok,true,JSON.stringify({q,correct,wantsAccessory:spec.wantsAccessory,head:spec.head,hard:good.hard}));
 passed++;
 const bad=Gate.judge(spec,{title:wrong,lprice:60000});
 assert.equal(bad.ok,false,JSON.stringify({q,wrong,wantsAccessory:spec.wantsAccessory,head:spec.head,hard:bad.hard}));
 passed++;
 const saved=Gate.saveFilter(q,[{title:wrong,lprice:60000}]);
 assert.equal(saved.save.length,0,'wrong accessory/body persisted: '+wrong);
 passed++;
}
console.log('SEARCH_SKU_ATTRIBUTE_CONTRAST '+passed+' PASS');
