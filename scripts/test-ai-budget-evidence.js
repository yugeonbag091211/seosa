'use strict';
// Offline regression: a cheaper verified match may beat near-ceiling options when
// the requested feature is explicitly supported on it and explicitly
// unsupported by every near-ceiling candidate. Missing evidence is not absence.
const assert = require('node:assert/strict');
const H = require('./_ai-chat-harness');
const BW = require('../api/_ai-budget-window');
[
  ['NEAR-A', '노이즈캔슬링 미지원 무선 헤드셋 A', 145000],
  ['NEAR-B', '노이즈캔슬링 미지원 무선 헤드셋 B', 125000],
  ['LOW-ANC', '노이즈캔슬링 지원 무선 헤드셋 C', 79000]
].forEach(([id,title,price]) => H.addProduct({pid:'EXCEPTION-'+id,vid:'OPT-'+id,mall:'쿠팡',title,price,keys:['헤드셋'],history:[[0,price]]}));
(async () => {
 const r=await H.ask({question:'노이즈캔슬링 되는 헤드셋 15만원 이하 추천해줘'}, {classify:'C|헤드셋',answer:'확인한 상품을 안내합니다.'});
 const cards=r.body.items||[];
 assert.ok(cards.some(c=>c.productId==='EXCEPTION-LOW-ANC'), JSON.stringify(cards.map(c=>[c.title,c.lprice])));
 assert.equal(r.body.topProductId,'EXCEPTION-LOW-ANC',JSON.stringify(r.body));
 assert.ok(/노이즈캔슬링/.test(r.body.text) && /확인/.test(r.body.text), r.body.text);
 assert.ok(/미지원/.test(r.body.text), r.body.text);
 const session=H.session();
 await session.say('헤드셋 15만원 이하로 추천해줘',{classify:'C|헤드셋',answer:'확인한 상품을 안내합니다.'});
 const follow=await session.say('노이즈캔슬링이 중요해요',{classify:'C|헤드셋',answer:'확인한 상품을 안내합니다.'});
 const followCards=follow.body.items||[];
 assert.equal(followCards.length,1,JSON.stringify(followCards));
 assert.equal(followCards[0].productId,'EXCEPTION-LOW-ANC',JSON.stringify(followCards));
 assert.ok(/노이즈캔슬링/.test(follow.body.text)&&/확인/.test(follow.body.text),follow.body.text);
 assert.equal(H.counters.external,0); assert.equal(H.counters.dbWrites,0);
 // A cheaper item's extra feature that the user did not request is no reason to bypass the window.
 const near={price:145000,title:'무선 헤드셋 노이즈캔슬링 미지원'};
 const cheaper={price:79000,title:'무선 헤드셋 노이즈캔슬링 지원'};
 const w=BW.nearBudgetWindow([near,cheaper],{budgetMax:150000,budgetSaid:150000},'무선 헤드셋 추천');
 assert.deepEqual(BW.verifiedFeatureAlternatives(w,['무선']),[]);
 assert.deepEqual(BW.verifiedFeatureAlternatives(w,[]),[]);
 assert.deepEqual(BW.verifiedFeatureAlternatives(w,['무선','노이즈캔슬링']),[cheaper]);
 const unknown=BW.nearBudgetWindow([{price:145000,title:'무선 헤드셋'},cheaper],{budgetMax:150000,budgetSaid:150000},'헤드셋 추천');
 assert.deepEqual(BW.verifiedFeatureAlternatives(unknown,['노이즈캔슬링']),[]);
 const ambiguous=BW.nearBudgetWindow([near,{price:79000,title:'노이즈캔슬링 지원 노이즈캔슬링 미지원 헤드셋'}],{budgetMax:150000,budgetSaid:150000},'헤드셋 추천');
 assert.deepEqual(BW.verifiedFeatureAlternatives(ambiguous,['노이즈캔슬링']),[]);
 const noNear=BW.nearBudgetWindow([cheaper],{budgetMax:150000,budgetSaid:150000},'무선 헤드셋 추천');
 assert.deepEqual(BW.verifiedFeatureAlternatives(noNear,['노이즈캔슬링']),[]);
 console.log('AI_BUDGET_EVIDENCE 1 scenario PASS, real GPT 0, external calls 0, DB writes 0');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
