'use strict';
const assert=require('node:assert/strict');
const {verdict,holdout}=require('./ai-v3-online-110-verify');
let pass=0,fail=0;
const test=async(label,fn)=>{try{await fn();pass++;console.log('PASS '+label)}catch(e){fail++;console.log('FAIL '+label+' '+String(e.message).slice(0,300))}};
const h=n=>holdout.find(x=>x.id===n);
const card=(productId,title,price)=>({productId,title,price,link:'https://example.org/'+productId,condition:'unknown'});
const response=(cards=[],state={})=>({http:200,apiStatus:200,cards,stats:{searched:true},state:{features:{wireless:false},...state}});
(async()=>{
await test('no stock and allowEmpty flag must remain UNVERIFIED',()=>{
 assert.equal(verdict(h('H04'),response([]),null).verdict,'UNVERIFIED');
 assert.equal(verdict(h('H06'),response([]),null).verdict,'UNVERIFIED');
 assert.equal(verdict(h('H09'),response([]),null).verdict,'UNVERIFIED');
 assert.equal(verdict(h('H13'),response([]),null).verdict,'UNVERIFIED');
});
await test('new item cannot appear in "그중" from previous displayed cards',()=>{
 const old=card('mall:old','에디파이어 무선 블루투스 헤드폰',130000);
 const added=card('mall:new','소니 무선 블루투스 헤드폰',135000);
 const prev=response([old],{features:{wireless:true},maxPrice:140000,presentedProductIds:['mall:old']});
 const next=response([added],{features:{wireless:true},minPrice:120000,maxPrice:140000,presentedProductIds:['mall:new']});
 assert(verdict(h('H02'),next,prev).errors.includes('recommendation_not_among_previously_shown'));
});
await test('empty answer is justified if every PREVIOUS card is outside new price band',()=>{
 const old=card('mall:old','에디파이어 무선 블루투스 헤드폰',99000);
 const prev=response([old],{features:{wireless:true},maxPrice:140000,presentedProductIds:['mall:old']});
 const next=response([],{features:{wireless:true},minPrice:120000,maxPrice:140000,presentedProductIds:[]});
 assert.equal(verdict(h('H02'),next,prev).verdict,'PASS');
});
await test('missing previous IDs does not falsely verify an empty follow-up',()=>{
 const prev=response([card('mall:old','에디파이어 무선 블루투스 헤드폰',99000)],{features:{wireless:true},maxPrice:140000});
 const next=response([],{features:{wireless:true},minPrice:120000,maxPrice:140000});
 assert.equal(verdict(h('H02'),next,prev).verdict,'UNVERIFIED');
});
await test('robot-vacuum dust bag is disallowed even with two cards',()=>{
 const dust=card('a','로보락 Q레보 로봇청소기 먼지봉투 액세서리',71000);
 const stick=card('b','캐치웰 무선청소기',129000);
 const checked=verdict(h('H17'),response([dust,stick]),null);
 assert.equal(checked.verdict,'FAIL');
 assert(checked.errors.some(x=>x.includes('accessory_or_part')));
});
await test('base Galaxy S25 cannot be verified using S25 Edge listing',()=>{
 const wrong=card('a','삼성 갤럭시S25 엣지 256GB 자급제',999000);
 const v=verdict(h('H05'),response([wrong]),null);
 assert.equal(v.verdict,'FAIL');
 assert(v.errors.some(x=>x.includes('identity_mismatch_variant')));
});
await test('valid same-brand supported wireless mouse is accepted',()=>{
 const good=card('a','로지텍 G304 무선 마우스',30000);
 assert.equal(verdict(h('H11'),response([good],{features:{wireless:true},maxPrice:50000}),null).verdict,'PASS');
});
await test('transport status 200 without actual search is FAIL for shopping',()=>{
 assert.equal(verdict(h('H01'),{...response([]),stats:{searched:false}},null).verdict,'FAIL');
});
console.log(JSON.stringify({passed:pass,failed:fail,total:pass+fail}));
if(fail)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
