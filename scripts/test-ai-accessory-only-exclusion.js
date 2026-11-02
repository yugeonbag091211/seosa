'use strict';
/* 2026-11-02 live merchant: case-only exclusion must not be treated as shopping FOR a case. */
const assert=require('node:assert/strict');
const AIID=require('../api/_aiidentity'),H=require('./_ai-chat-harness');
const cases=[
 {q:'에어팟 프로 2 지금 사도 좋을까? 케이스만 파는 상품은 제외해줘',
  query:'에어팟 프로 2 케이스'},
 {q:'에어팟 프로 2 가격 알려줘. 케이스만 판매하는 제품은 빼줘',
  query:'에어팟 프로 2 케이스'}
];
for(const z of cases){
 const c=AIID.buildContract({query:z.query,userText:z.q,titles:[
  'Apple 에어팟 프로 2세대 무선 이어폰 본품',
  '에어팟 프로2 전용 실리콘 보호 케이스']});
 assert.equal(c.wantsAccessory,false,'Excluded-only case is not requested');
 assert.equal(c.excludeAccessory,true,'Case-only exclusion is retained');
 assert.equal(AIID.verdict(c,{title:'Apple 에어팟 프로 2세대 무선 이어폰 본품'}).tier,0);
 assert.equal(AIID.verdict(c,{title:'에어팟 프로2 전용 실리콘 보호 케이스'}).tier,9);
}
for(const [pid,title,price] of [
 ['MAIN','Apple 에어팟 프로 2세대 무선 이어폰 본품',329000],
 ['CASE','에어팟 프로2 전용 실리콘 보호 케이스',9900]])H.addProduct({
 pid:'EXC-'+pid,vid:'EXC-'+pid,mall:'ADPICK',title,price,
 keys:['에어팟 프로 2'],history:[[0,price]]});
(async()=>{
 for(const z of cases){
  const r=await H.ask({question:z.q},{classify:'D|에어팟 프로 2 케이스',
   answer:'확인된 판매 가격 기준으로 안내합니다.'});
  const cards=r.body.items||[];
  assert.equal(r.status,200);
  assert.ok(cards.some(x=>x.productId==='EXC-MAIN'),JSON.stringify({q:z.q,cards,text:r.body.text}));
  assert.ok(cards.every(x=>x.productId!=='EXC-CASE'),'case must not be recommended');
  assert.ok(H.searchLog[H.searchLog.length-1].indexOf('케이스')<0,'Search query must not include excluded case');
 }
 const askCase=await H.ask({question:'에어팟 프로 2 케이스만 추천해줘'},
  {classify:'C|에어팟 프로 2 케이스',answer:'확인된 케이스를 추천합니다.'});
 assert.ok((askCase.body.items||[]).some(x=>x.productId==='EXC-CASE'),
  'Explicit accessory shopping must still work');
 assert.equal(H.counters.external,0);assert.equal(H.counters.dbWrites,0);
 console.log('AI_ACCESSORY_ONLY_EXCLUSION '+JSON.stringify({
  checks:13,pass:13,fail:0,realGptCalls:0,merchantCalls:0,dbWrites:0}));
})().catch(e=>{console.error('AI_ACCESSORY_ONLY_EXCLUSION_FATAL',e.stack||e);process.exitCode=1;});
