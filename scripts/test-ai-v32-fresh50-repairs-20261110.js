'use strict';
const assert=require('node:assert/strict');
const {createEngine}=require('../api/_ai-v3-core');
const {productTypeMatches}=require('../api/_ai-v31-taxonomy');
const {brandsFromUser,brandMatches,buildProbes}=require('../api/_ai-v31-retrieval');
let pass=0,fail=0;
const item=(id,title,lprice)=>({productId:id,title,lprice,mall:'쿠팡',link:'https://example.org/'+id,shippingFee:0});
async function engine(message,category,rows){
 return createEngine({
  planModel:async()=>({mode:'recommend',query:message,category}),
  searchProducts:async()=>rows,
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 },{message});
}
async function test(name,fn){
 try{await fn();pass++;console.log('PASS '+name)}
 catch(e){fail++;console.error('FAIL '+name+': '+e.message)}
}
(async()=>{
 await test('F05 Winix Zero S purchase rejects Tower Edge family',async()=>{
  const q='위닉스 제로S 공기청정기 20만원 이하';
  assert.equal(productTypeMatches('위닉스 타워 엣지 컴팩트 공기청정기 19.8m2','공기청정기',q),false);
  const out=await engine(q,'공기청정기',[
   item('tower','위닉스 타워 엣지 컴팩트 공기청정기 19.8m2',102330),
   item('zero','위닉스 제로S 공기청정기 43.1m2',163990)
  ]);
  assert.deepEqual(out.cards.map(x=>x.productId),['쿠팡:zero']);
 });
 await test('F08 Roborock S8 Pro alone rejects Pro Plus variant',async()=>{
  const q='로보락 S8 Pro 로봇청소기 50만원 이하';
  assert.equal(productTypeMatches('로보락 S8 Pro Plus 로봇청소기','청소기',q),false);
  const out=await engine(q,'청소기',[
   item('pro','로보락 S8 Pro 로봇청소기',419000),
   item('plus','로보락 S8 Pro Plus 로봇청소기',468990)
  ]);
  assert.deepEqual(out.cards.map(x=>x.productId),['쿠팡:pro']);
 });
 await test('F13 seller brand Xenon is user-grounded brand constraint',async()=>{
  const q='제논 입문용 일렉기타 20만원 이하';
  const names=brandsFromUser(q,'기타');
  assert(names.includes('제논'));
  assert.equal(brandMatches('소닉플로 일렉기타 입문용 세트',q,'기타'),false);
  const out=await engine(q,'기타',[
   item('correct','제논 입문용 일렉기타',198000),
   item('wrong','케이투엠 입문용 일렉기타 ELECTRIC GUITAR',119800)
  ]);
  assert.deepEqual(out.cards.map(x=>x.productId),['쿠팡:correct']);
 });
 await test('F14 bass guitar has early brand/model read-only facets',()=>{
  const q='콜트 베이스 기타 30만원 이하';
  const probes=buildProbes({query:'콜트 베이스 기타',category:'기타',userText:q,maxPrice:300000});
  assert(probes.slice(0,4).some(p=>p.some(([k,v])=>k==='title'&&v==='베이스')&&p.some(([k,v])=>k==='title'&&v==='콜트')),JSON.stringify(probes.slice(0,4)));
  assert.equal(productTypeMatches('콜트 일렉트릭 베이스 기타','기타',q),true);
  assert.equal(brandMatches('콜트 일렉트릭 베이스 기타',q,'기타'),true);
 });
 await test('D09 plain keyboard request must not recommend carrying case',async()=>{
  const q='키크론 K2 HE 키보드 5만원 이하';
  assert.equal(productTypeMatches('[해외] 키보드 케이스, 키크론 K2 HE 호환 가방','키보드',q),false);
  const out=await engine(q,'키보드',[
   item('case','[해외] 긱크리아 75% 84키 키보드 케이스 키크론 K2 HE 호환 가방',32400)
  ]);
  assert.equal(out.cards.length,0);
 });
 await test('H37 fitted keyboard case remains allowed when user requests it',()=>{
  const q='갤럭시탭 S9 FE용 키보드 케이스';
  assert.equal(productTypeMatches('갤럭시탭 S9 FE 무선 키보드 케이스','키보드',q),true);
 });
 await test('generic purifier and standard keyboards retain legitimate cards',async()=>{
  const r=await engine('위닉스 공기청정기 추천','공기청정기',[item('tower','위닉스 타워 엣지 컴팩트 공기청정기',110000)]);
  assert.equal(r.cards.length,1);
  const k=await engine('키크론 K2 HE 키보드 추천','키보드',[item('keyboard','키크론 K2 HE 키보드',195000)]);
  assert.equal(k.cards.length,1);
 });
 console.log(JSON.stringify({passed:pass,failed:fail,total:pass+fail}));if(fail)process.exitCode=1;
})();
