'use strict';
const assert=require('node:assert/strict');
const {verdict,holdout,blind}=require('./ai-v3-online-110-verify');
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
await test('explicitly requested used laptop is accepted, never false-flagged as refurbished',()=>{
 const t=blind.find(x=>x.id==='B026');
 const used=card('laptop','HP Elite X2 1012 G2 중고 노트북 i5 8G 256GB',258000);
 used.condition='used_or_refurbished';
 assert.equal(verdict(t,response([used],{category:'노트북',maxPrice:300000}),null).verdict,'PASS');
});
await test('new laptop prompt must still reject secondhand listing',()=>{
 const t=blind.find(x=>x.id==='B025');
 const used=card('laptop','HP 중고 노트북 i5',258000);
 used.condition='used_or_refurbished';
 const v=verdict(t,response([used],{category:'노트북',maxPrice:1000000}),null);
 assert.equal(v.verdict,'FAIL');
 assert(v.errors.includes('card1:used_or_refurbished'));
});
await test('bundle exclusion is grounded in set, not every mention of a mouse',()=>{
 const t=blind.find(x=>x.id==='B016');
 const good=card('kb','로지텍 무선 키보드 K580 정품',99000);
 const s=response([good],{category:'키보드',exclusions:['세트','마우스 결합 세트'],features:{wireless:true}});
 assert.equal(verdict(t,s,null).verdict,'PASS');
});
await test('brand-less Buds3 Pro short query rejects third-party buds and spare unit',()=>{
 const t=blind.find(x=>x.id==='B006');
 const wrong=card('buds','리얼미 버즈 8 프로 블루투스 이어폰',99800);
 const spare=card('unit','삼성 갤럭시 버즈3 프로 오른쪽 한쪽 낱개 유닛 단품 이어폰',83000);
 assert.equal(verdict(t,response([wrong],{category:'이어폰'}),null).verdict,'FAIL');
 assert.equal(verdict(t,response([spare],{category:'이어폰'}),null).verdict,'FAIL');
});
console.log(JSON.stringify({passed:pass,failed:fail,total:pass+fail}));
if(fail)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
