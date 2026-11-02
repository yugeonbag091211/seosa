'use strict';
/*
 * Production 2026-11-02 counterexamples:
 * - Galaxy Buds 3 request produced a silicone ear hook
 * - AirPods 4 base request produced AirPods 2 and 5 unrelated generations
 * - S10 FE+ case request produced S9 Ultra / S10 Plus cases
 * Strong named models cannot use siblings as recommendation cards.
 */
const assert=require('node:assert/strict'),H=require('./_ai-chat-harness');
const data=[
 ['AP2','에어팟2세대 새상품 유닛 왼쪽 오른쪽 낱개 본체',89900,['에어팟']],
 ['AP5','Apple 2026 에어팟 5 액티브 노이즈 캔슬링 블루투스 이어폰',195020,['에어팟']],
 ['HOOK','스페이스쉴드 갤럭시 버즈3 호환 유닛 분실방지 실리콘 이어 후크 숏타입',19830,['갤럭시 버즈3','버즈3']],
 ['S9U','삼성 갤럭시탭 S9 울트라 마그네틱 키보드 호환 케이스',39800,['갤럭시탭']],
 ['S10PLUS','아이지 갤럭시탭 S10 플러스 오링 범퍼 케이스',31920,['갤럭시탭']]
];
for(const [pid,title,price,keys] of data)H.addProduct({pid:'NO-SIB-'+pid,vid:'OPT-'+pid,mall:'쿠팡',title,price,keys,history:[[0,price]]});
const good={
 buds:['BUDS3','삼성 갤럭시 버즈3 일반형 무선 이어폰 본품',145000,['갤럭시 버즈3','버즈3']],
 airpods:['AP4','Apple 에어팟 4세대 일반형 무선 이어폰',179000,['에어팟']],
 case:['FEPLUS','삼성 갤럭시탭 S10 FE+ 투명 케이스',25000,['갤럭시탭']]
};
const opts=kind=>({classify:'C|'+(kind==='buds'?'갤럭시 버즈3':kind==='airpods'?'에어팟 4세대':'갤럭시탭 S10 FE+ 케이스'),answer:'확인된 상품만 추천드립니다.'});
const cases=[
 ['buds','갤럭시 버즈3 일반형만, 프로 제외'],
 ['airpods','에어팟 4세대 일반형만, 프로 제외'],
 ['case','갤럭시탭 S10 FE+ 케이스만, FE는 제외']
];
(async()=>{
 let checks=0;
 for(const [kind,q] of cases){
  const r=await H.ask({question:q},opts(kind));
  assert.equal(r.status,200,q);
  assert.equal((r.body.items||[]).length,0,'Wrong-model cards must not be shown: '+JSON.stringify({q,cards:r.body.items}));
  assert.ok(/찾지 못|없|확인/.test(r.body.text),q+': honest no-match answer');
  checks+=3;
 }
 for(const [kind,v] of Object.entries(good)){
  const [pid,title,price,keys]=v;
  H.addProduct({pid:'NO-SIB-'+pid,vid:'OPT-'+pid,mall:'쿠팡',title,price,keys,history:[[0,price]]});
 }
 for(const [kind,q] of cases){
  const r=await H.ask({question:q},opts(kind));
  assert.equal(r.status,200,q);
  assert.ok((r.body.items||[]).length>0,'True exact product must still be returned '+q);
  assert.equal(r.body.items[0].productId,'NO-SIB-'+good[kind][0],JSON.stringify({q,cards:r.body.items}));
  assert.ok(!(r.body.items||[]).some(c=>/NO-SIB-(?:HOOK|AP2|AP5|S9U|S10PLUS)/.test(c.productId)),q+': no sibling/accessory cards');
  checks+=4;
 }
 assert.equal(H.counters.external,0);assert.equal(H.counters.dbWrites,0);
 console.log('AI_MODEL_ABSENCE_SAFETY '+JSON.stringify({checks,pass:checks,fail:0,realGptCalls:0,realMerchantCalls:0,dbWrites:0}));
})().catch(e=>{console.error('AI_MODEL_ABSENCE_SAFETY_FATAL',e.stack||e);process.exitCode=1;});
