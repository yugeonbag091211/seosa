'use strict';
const assert=require('node:assert/strict'),H=require('./_ai-chat-harness'),AC=require('../api/_aicontext');
[
 ['LOW','쿠팡','일반 블루투스 유선 헤드셋 1',23900],
 ['MID','쿠팡','스카이 일상용 블루투스 무선 헤드셋 2',109000],
 ['CLOSE','쿠팡','일상용 블루투스 무선 헤드셋 H5',145000],
 ['GAMER','쿠팡','위세리 WG1 무선 게이밍 헤드셋',137700],
 ['CLOSE2','쿠팡','무선 블루투스 통화 헤드셋 Y2',121000],
 ['CHEAP50','쿠팡','일반 블루투스 무선 헤드셋 3',49900]
].forEach(([pid,mall,title,price])=>H.addProduct({pid:'BUDGET-'+pid,vid:'OPT-'+pid,mall,title,price,keys:['헤드셋'],history:[[0,price]]}));
const opts={classify:'C|헤드셋',answer:'서사 가격 기록을 확인해 안내합니다.'};
const n=r=>(r.body.items||[]).map(c=>Number(c.lprice));
(async()=>{
 const s=H.session(),a=await s.say('헤드셋 15만원 이하로 추천해줘',opts);
 assert.equal(a.status,200);assert.ok(n(a).length>=2,'Initial should present near-cap candidates');
 assert.ok(n(a).every(p=>p>=120000&&p<=150000),JSON.stringify(n(a)));
 const b=await s.say('흠 일상용으로 쓰는 헤드셋 게임 헤드셋같은거 말고',opts);
 assert.equal(b.status,200);assert.equal((b.body.items||[]).length,1,'Follow-up must have one card');
 assert.ok(n(b).every(p=>p>=120000&&p<=150000));
 assert.ok((b.body.items||[]).every(c=>!/게이밍|gaming/i.test(c.title)));
 const signed=AC.verifyConversationState(b.body.convState);
 assert.equal(signed.constraints.avoidGaming,true,'Gaming exclusion persisted in signed state');
 const c=await s.say('10만원에서 15만원대로 해줘',opts);
 assert.equal(c.status,200);assert.equal((c.body.items||[]).length,1);
 assert.ok(n(c).every(p=>p>=120000&&p<=150000));
 assert.ok((c.body.items||[]).every(z=>!/게이밍|gaming/i.test(z.title)));
 const low=await H.session().say('헤드셋 5만원 이하로 추천해줘',opts);
 assert.equal(low.status,200);assert.ok(n(low).includes(23900)&&n(low).includes(49900));
 assert.ok(n(low).every(p=>p<=50000));
 console.log('AI_BUDGET_CARDS_AUDIT '+JSON.stringify({turns:4,checks:14,failed:0,realGptCalls:0,externalCalls:H.counters.external,dbWrites:H.counters.dbWrites}));
 if(H.counters.external||H.counters.dbWrites)process.exitCode=1;
})().catch(e=>{console.error('AI_BUDGET_CARDS_FATAL',e.stack||e);process.exitCode=1;});
