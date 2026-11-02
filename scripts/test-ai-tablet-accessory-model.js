'use strict';
/* Concrete 2026-11-02 Production counterexample + cross-model holdout. */
const assert=require('node:assert/strict');
const AIID=require('../api/_aiidentity');
const H=require('./_ai-chat-harness');

const cases=[
 ['갤럭시탭 S10 FE 케이스만 추천','[기프트] 갤럭시탭S10 FE+ 분리형 블루투스키보드 케이스 CF-16',false],
 ['갤럭시탭 S10 FE 케이스만 추천','삼성 갤럭시탭 S10 FE 케이스 국내정품',true],
 ['갤럭시탭 S10 FE 케이스만 추천','갤럭시탭 S10FE+ TPU 클리어 젤리 케이스',false],
 ['갤럭시탭 S10 FE 케이스만 추천','삼성 갤럭시 탭 S10FE 전용 북커버 케이스',true],
 ['갤럭시탭 S10 FE+ 케이스 추천','갤럭시탭 S10FE 투명 케이스',false],
 ['갤럭시탭 S10 FE+ 케이스 추천','갤럭시탭 S10FE+ TPU 케이스',true],
 ['갤럭시탭 S9 FE 케이스 찾아줘','갤럭시탭 S9 FE＋ 보호 케이스',false],
 ['갤럭시탭 S9 FE+ 케이스 찾아줘','갤럭시탭 S9 FE 투명 케이스',false],
 ['갤럭시탭 S9 FE+ 케이스 찾아줘','갤럭시탭 S9 FE Plus 정품 케이스',true],
 ['갤럭시탭 S10 FE 케이스만 추천','갤럭시탭 S10 FE / S10 FE+ 케이스 옵션 선택',false],
 ['갤럭시탭 S10 FE 본체 추천','삼성 갤럭시탭 S10 FE+ 태블릿 본체',false],
 ['갤럭시탭 S10 FE 본체 추천','삼성 갤럭시탭 S10 FE 태블릿 본체',true]
];
let passed=0;for(const [question,title,shouldAccept] of cases){
 const contract=AIID.buildContract({query:question,userText:question,titles:[title]});
 const actual=AIID.partition([{title,lprice:34900}],contract).items.length>0;
 assert.equal(actual,shouldAccept,JSON.stringify({question,title,actual,shouldAccept}));
 passed++;
}
[
 ['FE',12100,'[해외] 삼성 갤럭시 탭 S10 FE 케이스 실리콘 범퍼'],
 ['PLUS',56900,'[기프트] 갤럭시탭S10 FE+ 분리형 블루투스키보드 케이스 CF-16'],
 ['OTHER',11900,'갤럭시탭 S9 FE 전용 케이스']
].forEach(([id,price,title])=>H.addProduct({pid:'FE-MODEL-'+id,vid:'FE-OPT-'+id,mall:'ADPICK',
 title,price,keys:['갤럭시탭','갤럭시탭 S10 FE','갤럭시탭 S9 FE'],history:[[0,price]]}));
(async()=>{
 const r=await H.ask({question:'갤럭시탭 S10 FE 케이스만 추천해줘'},
   {classify:'C|갤럭시탭 S10 FE 케이스',answer:'확인된 케이스만 추천합니다.'});
 assert.equal(r.status,200);
 const cards=r.body.items||[];
 assert.ok(cards.length>0,'exact S10 FE case should remain available');
 assert.ok(cards.some(x=>x.productId==='FE-MODEL-FE'),JSON.stringify(cards));
 assert.ok(cards.every(x=>x.productId!=='FE-MODEL-PLUS'),'wrong-size FE+ must not appear');
 assert.ok(cards.every(x=>x.productId!=='FE-MODEL-OTHER'),'S9 FE must not appear');
 assert.equal(H.counters.external,0);assert.equal(H.counters.dbWrites,0);
 console.log('AI_GALAXY_FE_ACCESSORY_MODEL '+JSON.stringify({
  checks:cases.length+4,passed:passed+4,failed:0,realGptCalls:0,externalCalls:0,dbWrites:0,
  errorClass:'different-size accessory model not interchangeable'}));
})().catch(e=>{console.error('AI_GALAXY_FE_ACCESSORY_MODEL_FAIL',e.stack||e);process.exitCode=1;});
