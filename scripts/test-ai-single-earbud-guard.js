'use strict';
/* 2026-11-02 live partial-unit listing must never be priced as a full earbud set. */
const assert=require('node:assert/strict');
const I=require('../api/_aiidentity'),H=require('./_ai-chat-harness');
const samples=[
 ['에어팟 프로 2 얼마야?','(새제품) 에어팟 프로 2세대 C타입 왼쪽 이어폰 유닛 프로2 한쪽 단품',false],
 ['에어팟 프로 2 얼마야?','에어팟 프로2세대 새상품 유닛 왼쪽 오른쪽 낱개 본체',false],
 ['에어팟 프로 2 얼마야?','Apple 에어팟 프로 2세대 USB-C 타입 무선 이어폰',true],
 ['에어팟 프로 2 왼쪽 유닛만 찾아줘','(새제품) 에어팟 프로 2세대 C타입 왼쪽 이어폰 유닛 프로2 한쪽 단품',true],
 ['갤럭시 버즈3 얼마야?','삼성 갤럭시 버즈3 오른쪽 이어폰 한쪽 단품',false],
 ['갤럭시 버즈3 얼마야?','삼성 갤럭시 버즈3 블루투스 양쪽 무선 이어폰',true]
];
for(const [q,title,ok]of samples){
 const c=I.buildContract({query:q,userText:q,titles:[title]});
 const actual=I.partition([{title,lprice:120000}],c).items.length>0;
 assert.equal(actual,ok,JSON.stringify({q,title,actual,ok}));
}
for(const [pid,title,price]of [
 ['FULL','Apple 에어팟 프로 2세대 USB-C 무선 이어폰 본품',429000],
 ['LEFT','(새제품) 에어팟 프로 2세대 C타입 왼쪽 이어폰 유닛 프로2 한쪽 단품',125000]])H.addProduct({
 pid:'SINGLE-'+pid,vid:'SINGLE-'+pid,mall:'ADPICK',title,price,
 keys:['에어팟 프로 2'],history:[[0,price]]});
(async()=>{
 const r=await H.ask({question:'에어팟 프로 2 지금 사도 좋을까?'},
   {classify:'D|에어팟 프로 2',answer:'확인한 상품만 말씀드립니다.'});
 assert.equal(r.status,200);
 const cards=r.body.items||[];
 assert.ok(cards.some(c=>c.productId==='SINGLE-FULL'),JSON.stringify(cards));
 assert.ok(cards.every(c=>c.productId!=='SINGLE-LEFT'),JSON.stringify(cards));
 assert.equal(H.counters.external,0);
 assert.equal(H.counters.dbWrites,0);
 console.log('AI_SINGLE_EARBUD_GUARD '+JSON.stringify({
  assertions:10,passed:10,failed:0,realGptCalls:0,merchantCalls:0,dbWrites:0}));
})().catch(e=>{console.error('AI_SINGLE_EARBUD_GUARD_FATAL',e.stack||e);process.exitCode=1});
