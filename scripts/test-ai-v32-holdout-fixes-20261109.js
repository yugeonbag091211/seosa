'use strict';
const assert=require('node:assert/strict');
const {createEngine}=require('../api/_ai-v3-core');
const {verdict,partWord}=require('./ai-v32-eval/verdict');
const {cases,labelFor}=require('./ai-v32-eval/holdout-cases');
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name+': '+e.message)}}
async function mock(message,planned={mode:'none',query:'',category:''}) {
 let called=0;
 const out=await createEngine({
  planModel:async()=>planned,
  searchProducts:async()=>{called++;return[]},
  decideModel:async()=>({productIds:[]})
 },{message});
 return {out,called};
}
(async()=>{
 await test('H11 bare Galaxy Tab S10 FE Plus 256GB triggers catalog lookup even when LLM selects none',async()=>{
  const q='갤럭시탭 S10 FE 플러스 256GB 와이파이';
  const {out,called}=await mock(q,{mode:'none',query:q,category:'태블릿'});
  assert.equal(called,1);
  assert.equal(out.stats.searched,true);
  assert.equal(out.state.category,'태블릿');
 });
 await test('H11 GPT invented a compare mode and missing second subject: search must still execute',async()=>{
  const q='갤럭시탭 S10 FE 플러스 256GB 와이파이';
  const {out,called}=await mock(q,{mode:'compare',query:q,category:'태블릿',compareQuery:''});
  assert.equal(called,1);assert.equal(out.stats.searched,true);
 });
 await test('H38 independent checker accepts explicit bundle when accessory is only a tail descriptor',()=>{
  const c=cases.find(x=>x.id==='H38');
  const item={productId:'mock:set',title:'[해외] Shipadoo 게이밍 무선 키보드 및 마우스 콤보 세트, 컴퓨터 무선 노트북 데스크탑 사무실 PC 액세서리 무료 무선 마우스',price:14350};
  const v=verdict(c,{http:200,cards:[item],stats:{searched:true},state:{maxPrice:30000,minPrice:null}},null,labelFor(c));
  assert.equal(v.verdict,'PASS',JSON.stringify(v.causes));
 });
 await test('generic product noun alone does not trigger unsolicited catalog search',async()=>{
  const {out,called}=await mock('태블릿',{mode:'none',query:'태블릿',category:'태블릿'});
  assert.equal(called,0);assert.equal(out.stats.searched,false);
 });
 await test('informational OLED explanation stays no-search even with purchase-plan hallucination',async()=>{
  const {out,called}=await mock('OLED 모니터와 LCD는 어떤 차이가 있니?',{mode:'recommend',query:'OLED 모니터',category:'모니터'});
  assert.equal(called,0);assert.equal(out.stats.searched,false);
 });
 await test('H08 프렌즈샵 is not lens accessory: independent evaluator regression',()=>{
  const c=cases.find(x=>x.id==='H08');
  const item={productId:'mock:friends',title:'프렌즈샵/카카오프렌즈 골전도 이어폰 초경량 오픈형 방수 무선 블루투스 이어폰',price:67940};
  const result=verdict(c,{http:200,cards:[item],stats:{searched:true},state:{maxPrice:70000,minPrice:null}},null,labelFor(c));
  assert.equal(result.verdict,'PASS',JSON.stringify(result.causes));
  assert.equal(result.cardChecks[0].errors.length,0);
 });
 await test('standalone replacement lens still detected as a component',()=>{
  assert.equal(partWord('카메라 전용 교체 렌즈 50mm','이어폰'),'렌즈');
 });
 await test('H37 listed S9 FE compatibility counts as explicit keyboard-case support',()=>{
  const c=cases.find(x=>x.id==='H37');
  const card={productId:'mock:case',title:'갤럭시탭 S10 FE / S9 FE / S9 전용 무선 LED 터치패드 키보드 케이스 (태블릿 미포함)',price:53640};
  const v=verdict(c,{http:200,cards:[card],stats:{searched:true},state:{}},null,labelFor(c));
  assert.equal(v.verdict,'PASS',JSON.stringify(v.causes));
  const wrong={...card,title:'갤럭시탭 S10 FE / S8 FE 전용 키보드 케이스'};
  const bad=verdict(c,{http:200,cards:[wrong],stats:{searched:true},state:{}},null,labelFor(c));
  assert(bad.causes.some(x=>x.includes('identity_')));
 });
 await test('H38 wireless keyboard + mouse bundle accepts genuine sets, not single mouse or a receiver',async()=>{
  const taxonomy=require('../api/_ai-v31-taxonomy');
  const q='무선 키보드 마우스 세트 3만원 이하';
  assert.equal(taxonomy.explicitType(q),'키보드');
  const mk=(id,title,price)=>({productId:id,title,lprice:price,mall:'쿠팡',shippingFee:0,link:'https://example.org/'+id});
  const out=await createEngine({
    planModel:async()=>({mode:'recommend',query:'무선 키보드 마우스 세트',category:'마우스'}),
    searchProducts:async()=>[
      mk('set','아이플렉스 무선 마우스키보드 세트, RK-2000, 블랙',13090),
      mk('set2','[기프트] 아이노트 저소음 무선 키보드 마우스 세트 KM777R',29900),
      mk('mouse','로지텍 무선 마우스 단품',15000),
      mk('receiver','키보드 마우스 콤보 USB 수신기 교체품',11950)],
    decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
  },{message:q});
  assert.equal(out.stats.searched,true);
  assert.equal(out.state.category,'키보드');
  assert.deepEqual(out.cards.map(x=>x.productId),['쿠팡:set','쿠팡:set2']);
 });
 await test('H51 explicit Bluetooth speaker condition excludes merely portable model titles',()=>{
  const t=require('../api/_ai-v31-taxonomy');
  const q='마샬 엠버튼 3 블루투스 스피커';
  assert.equal(t.productTypeMatches('마샬 엠버튼3 블루투스 스피커','스피커',q),true);
  assert.equal(t.productTypeMatches('마샬 엠버튼 3 포터블 스피커','스피커',q),false);
 });
 console.log(JSON.stringify({passed,failed,total:passed+failed}));
 if(failed)process.exitCode=1;
})();
