'use strict';
const assert=require('node:assert/strict');
const CLAIM=require('../api/_ai-card-claims');
const H=require('./_ai-chat-harness');
let count=0;
const used=[{title:'(중고이어폰)애플 에어팟 프로 2세대',lprice:180500}];
const onlyNew=[{title:'Apple 에어팟 프로 2세대 USB-C 새상품',lprice:430600}];
function check(s,cs,expectChanged,expected){
 const result=CLAIM.filterClaims(s,cs);
 assert.equal(result.changed,expectChanged,JSON.stringify({s,result}));
 if(expected)assert.match(result.text,expected,JSON.stringify(result));
 count++;
 return result;
}
check('중고 상품은 제외했고, 다른 모델도 섞지 않았습니다.',used,true,/중고 판매글도 포함/);
check('상품은 각각 다른 판매처 가격이에요. 중고 상품은 제외했고, 다른 모델도 확인했습니다.',used,true,/다른 판매처 가격/);
check('모든 후보는 신품이고 표시 가격은 확정값이 아니에요.',used,true,/중고 판매글도 포함/);
check('중고 제품을 포함하지 않았고, 실제 결제금액은 달라질 수 있어요.',used,true,/중고 판매글도 포함/);
check('중고 상품은 제외하지 않았어요.',used,false,/제외하지 않았어요/);
check('중고 상품은 제외했고 새상품만 안내했어요.',onlyNew,false,/중고 상품은 제외했고/);
check('가격 기록은 하루치뿐이라 판단하기 어려워요.',used,false,/기록은 하루치/);
check('중고는 가격이 낮지만 상태가 다릅니다.',used,false,/상태가 다릅니다/);
check('중고 상품은 제외했고',[],false,/중고 상품은 제외했고/);
// The full AI handler is called, but model, merchant, and DB are fixtures.
for(const [pid,title,price]of [
 ['NEW','Apple 에어팟 프로 2세대 USB-C 무선 이어폰 본품',430600],
 ['USED','(중고이어폰)애플 에어팟 프로 2세대',180500]
])H.addProduct({pid:'CC-'+pid,vid:'CC-'+pid,mall:'ADPICK',title,price,
 keys:['에어팟 프로 2'],history:[[0,price]]});
(async()=>{
 const r=await H.ask({question:'에어팟 프로 2 지금 사도 좋을까?'},{
  classify:'D|에어팟 프로 2',
  answer:'검색된 상품은 가격을 확인했어요. 중고 상품은 제외했고, 다른 후보 가격은 별도로 확인했습니다.'
 });
 assert.equal(r.status,200);
 const items=r.body.items||[];
 assert.ok(items.some(c=>/중고/.test(c.title)),
   'fixture must return an actual used listing to reproduce contradictory claim');
 assert.doesNotMatch(r.body.text,/중고 상품은 제외했고/,
   'the model must not falsely claim used offers were excluded');
 assert.match(r.body.text,/중고 판매글도 포함되어/,
   'user must be informed that returned cards include secondhand listings');
 count+=3;
 assert.equal(H.counters.external,0);assert.equal(H.counters.dbWrites,0);
 console.log('AI_CARD_EXCLUSION_CLAIMS '+JSON.stringify({
  assertions:count,passed:count,failed:0,realGptCalls:0,merchantCalls:0,dbWrites:0}));
})().catch(e=>{console.error('AI_CARD_EXCLUSION_CLAIMS_FATAL',e.stack||e);process.exitCode=1;});
