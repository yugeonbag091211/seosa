'use strict';
/* 2026-11-02 live partial-unit listing must never be priced as a full earbud set. */
const assert=require('node:assert/strict');
const I=require('../api/_aiidentity'),H=require('./_ai-chat-harness');
const samples=[
 ['에어팟 프로 2 얼마야?','(새제품) 에어팟 프로 2세대 C타입 왼쪽 이어폰 유닛 프로2 한쪽 단품',false],
 ['에어팟 프로 2 얼마야?','에어팟 프로2세대 새상품 유닛 왼쪽 오른쪽 낱개 본체',false],
 ['에어팟 프로 2 얼마야?','Apple 에어팟 프로 2세대 USB-C 타입 무선 이어폰',true],
 ['에어팟 프로 2 왼쪽 유닛만 찾아줘','(새제품) 에어팟 프로 2세대 C타입 왼쪽 이어폰 유닛 프로2 한쪽 단품',true],
 ['에어팟 프로 2 왼쪽 유닛만 찾아줘','Apple 에어팟 프로 2세대 USB-C 타입 무선 이어폰 본품',false],
 ['에어팟 프로 2 왼쪽 유닛만 찾아줘','에어팟 프로 2세대 라이트닝 오른쪽 낱개 중고',false],
 ['에어팟 프로 2 왼쪽 유닛만 찾아줘','에어팟 프로 2 왼쪽 오른쪽 옵션 선택 유닛',false],
 ['에어팟 프로 2 오른쪽 유닛만 찾아줘','에어팟 프로 2세대 라이트닝 왼쪽 낱개',false],
 ['에어팟 프로 2 오른쪽 유닛만 찾아줘','에어팟 프로 2세대 라이트닝 오른쪽 낱개',true],
 ['에어팟 프로 2 한쪽 낱개만 구매','에어팟 프로 2 왼쪽 이어폰 낱개',true],
 ['에어팟 프로 2 한쪽 낱개만 구매','Apple 에어팟 프로 2세대 USB-C 타입 무선 이어폰 본품',false],
 ['갤럭시 버즈3 얼마야?','삼성 갤럭시 버즈3 오른쪽 이어폰 한쪽 단품',false],
 ['갤럭시 버즈3 오른쪽 유닛만 추천해줘','[해외직구] Galaxy Buds3 Pro 버즈3 프로 오른쪽 한쪽 낱개 유닛 SM-R630',false],
 ['갤럭시 버즈3 오른쪽 유닛만 추천해줘','삼성 갤럭시 버즈3 오른쪽 유닛 SM-R530 낱개 단품',true],
 ['갤럭시 버즈3 프로 오른쪽 유닛만 추천해줘','[해외직구] Galaxy Buds3 Pro 버즈3 프로 오른쪽 한쪽 낱개 유닛 SM-R630',true],
 ['Galaxy Buds3 오른쪽 유닛만','Samsung Galaxy Buds3 Pro right-only single earbud unit',false],
 ['갤럭시 버즈3 시리즈 오른쪽 유닛','Galaxy Buds3 Pro 오른쪽 한쪽 낱개 유닛 SM-R630',true],
 ['갤럭시 버즈3 얼마야?','삼성 갤럭시 버즈3 블루투스 양쪽 무선 이어폰',true]
];
for(const [q,title,ok]of samples){
 const c=I.buildContract({query:q,userText:q,titles:[title]});
 const actual=I.partition([{title,lprice:120000}],c).items.length>0;
 assert.equal(actual,ok,JSON.stringify({q,title,actual,ok}));
}
for(const [pid,title,price]of [
 ['FULL','Apple 에어팟 프로 2세대 USB-C 무선 이어폰 본품',429000],
 ['LEFT','(새제품) 에어팟 프로 2세대 C타입 왼쪽 이어폰 유닛 프로2 한쪽 단품',125000],
 ['RIGHT','(새제품) 에어팟 프로 2세대 C타입 오른쪽 이어폰 유닛 프로2 한쪽 단품',120000]])H.addProduct({
 pid:'SINGLE-'+pid,vid:'SINGLE-'+pid,mall:'ADPICK',title,price,
 keys:['에어팟 프로 2'],history:[[0,price]]});
(async()=>{
 const r=await H.ask({question:'에어팟 프로 2 지금 사도 좋을까?'},
   {classify:'D|에어팟 프로 2',answer:'확인한 상품만 말씀드립니다.'});
 assert.equal(r.status,200);
 const cards=r.body.items||[];
 assert.ok(cards.some(c=>c.productId==='SINGLE-FULL'),JSON.stringify(cards));
 assert.ok(cards.every(c=>c.productId!=='SINGLE-LEFT'),JSON.stringify(cards));
 assert.ok(cards.every(c=>c.productId!=='SINGLE-RIGHT'),JSON.stringify(cards));
 const left=await H.ask({question:'에어팟 프로 2 왼쪽 유닛만 찾아줘'},
   {classify:'C|에어팟 프로 2 왼쪽 유닛',answer:'확인된 왼쪽 유닛만 추천합니다.'});
 assert.equal(left.status,200);
 assert.ok((left.body.items||[]).some(c=>c.productId==='SINGLE-LEFT'),JSON.stringify(left.body));
 assert.ok((left.body.items||[]).every(c=>c.productId==='SINGLE-LEFT'),'full pair or right unit contaminates left request');
 const right=await H.ask({question:'에어팟 프로 2 오른쪽 유닛만 찾아줘'},
   {classify:'C|에어팟 프로 2 오른쪽 유닛',answer:'확인된 오른쪽 유닛만 추천합니다.'});
 assert.equal(right.status,200);
 assert.ok((right.body.items||[]).some(c=>c.productId==='SINGLE-RIGHT'),JSON.stringify(right.body));
 assert.ok((right.body.items||[]).every(c=>c.productId==='SINGLE-RIGHT'),'full pair or left unit contaminates right request');
 H.addProduct({
   pid:'SINGLE-BUDS3PRO',vid:'SINGLE-BUDS3PRO',mall:'ADPICK',
   title:'[해외직구] Galaxy Buds3 Pro 버즈3 프로 오른쪽 한쪽 낱개 유닛 정품 단품 이어폰 SM-R630',
   price:81830,keys:['갤럭시 버즈3'],history:[[0,81830]]
 });
 const baseQ='갤럭시 버즈3 오른쪽 유닛만 추천해줘';
 const proOnly=await H.ask({question:baseQ},{
   classify:'C|갤럭시 버즈3 오른쪽 유닛',answer:'검증된 오른쪽 유닛만 추천합니다.'});
 assert.equal(proOnly.status,200);
 assert.equal((proOnly.body.items||[]).length,0,
   'Buds3 Pro must never be offered as Buds3 standard right-only unit');
 H.addProduct({
   pid:'SINGLE-BUDS3BASE',vid:'SINGLE-BUDS3BASE',mall:'ADPICK',
   title:'삼성 갤럭시 버즈3 오른쪽 한쪽 유닛 단품 SM-R530',
   price:99900,keys:['갤럭시 버즈3'],history:[[0,99900]]
 });
 const exactBase=await H.ask({question:baseQ},{
   classify:'C|갤럭시 버즈3 오른쪽 유닛',answer:'검증된 오른쪽 유닛만 추천합니다.'});
 assert.equal(exactBase.status,200);
 assert.ok((exactBase.body.items||[]).some(x=>x.productId==='SINGLE-BUDS3BASE'),
   JSON.stringify(exactBase.body.items));
 assert.ok((exactBase.body.items||[]).every(x=>x.productId!=='SINGLE-BUDS3PRO'),
   'Pro-only right unit is incompatible with standard Buds3');
 assert.equal(H.counters.external,0);
 assert.equal(H.counters.dbWrites,0);
 console.log('AI_SINGLE_EARBUD_GUARD '+JSON.stringify({
  assertions:33,passed:33,failed:0,realGptCalls:0,merchantCalls:0,dbWrites:0}));
})().catch(e=>{console.error('AI_SINGLE_EARBUD_GUARD_FATAL',e.stack||e);process.exitCode=1});
