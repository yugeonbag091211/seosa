'use strict';
const assert = require('node:assert/strict');
const H = require('./_ai-chat-harness');
const BT = require('../api/_ai-budget-target');
const SI = require('../api/_shopintent');
const AC = require('../api/_aicontext');
function p(pid,price,title) {
 return {pid,vid:pid+'-V1',mall:'쿠팡',title,price,keys:['헤드셋','이어폰','headset'],history:[[0,price]]};
}
[
 p('HEAD-9',8900,'테스트 일반 헤드셋 미니 H09'),
 p('HEAD-18',18000,'테스트 일반 헤드셋 데일리 H18'),
 p('HEAD-45',45000,'테스트 일반 헤드셋 H45'),
 p('HEAD-72',72000,'테스트 일반 헤드셋 H72'),
 p('HEAD-119',119000,'테스트 일반 헤드셋 H119'),
 p('HEAD-138',137700,'테스트 일반 헤드셋 H138'),
 p('HEAD-145',145000,'테스트 음악감상 헤드셋 H145'),
 p('HEAD-G149',149000,'테스트 게이밍 헤드셋 G149'),
 p('HEAD-158',158000,'테스트 일반 헤드셋 H158')
].forEach(H.addProduct);
let pass=0,fail=0;
const checks=[];
function check(label,good,evidence) {
 const valid=!!good;
 checks.push({label,pass:valid});
 if(valid)pass++; else {
   fail++;
   console.log('AI_BUDGET_TARGET_FAIL '+JSON.stringify({
     label,evidence:String(typeof evidence==='string'?evidence:JSON.stringify(evidence)).slice(0,700)
   }));
 }
}
const q=r=>r.body.items||[];
const prices=r=>q(r).map(x=>Number(x.lprice));
const ids=r=>q(r).map(x=>x.productId);
(async()=>{
 const a=SI.parseConstraints('헤드셋 15만원 이하로 추천해줘');
 check('15만 원 strict ceiling parsed',a.budgetSaid===150000&&a.budgetMax===150000,a);
 check('15만 원 lower preference 12만',BT.targetWindow(a)?.min===120000,BT.targetWindow(a));
 check('5만 원은 ±3만 원 규칙 미적용',BT.targetWindow(SI.parseConstraints('헤드셋 5만원 이하'))===null,'low');
 check('6만 원은 3만~6만 적용',BT.targetWindow(SI.parseConstraints('헤드셋 6만원 이하'))?.min===30000,'60k');
 check('명시한 10만~15만 하한을 보존',
   BT.targetWindow(SI.parseConstraints('헤드셋 10만원에서 15만원까지'))?.min===120000,'range');
 check('가격 범위 아래/위 hard gate 유지',
   BT.narrowToTarget([{price:100000},{price:120000},{price:150000},{price:150001}],a)
     .within.map(x=>x.price).join(',')==='150000,120000','basic');

 const session=H.session();
 const first=await session.say('헤드셋 15만원 이하로 추천해줘',{classify:'C|헤드셋',answer:'일상용으로 추천해요.'});
 check('첫 추천은 12~15만 원만 노출',q(first).length>0&&prices(first).every(x=>x>=120000&&x<=150000),prices(first));
 check('15만 원 넘는 상품 절대 미노출',!prices(first).includes(158000),prices(first));
 check('초기 첫 턴은 여러 카드 허용',q(first).length>1,ids(first));
 const preference=await session.say('일상에서 쓰는 헤드셋, 게임 헤드셋같은거 말고',{classify:'C|헤드셋',answer:'일상용으로 추천합니다.'});
 check('게이밍 제외 선호 파싱',SI.parseConstraints('일상에서 쓰는 헤드셋, 게임 헤드셋같은거 말고').avoid==='게이밍','parse');
 const preferenceState=AC.verifyConversationState(preference.body.convState);
 check('게이밍 제외 signed state 유지',preferenceState?.constraints?.avoid==='게이밍',preferenceState);
 check('후속 추천은 카드 한 장',q(preference).length===1&&preference.body.forceShowCard===true,ids(preference));
 check('게이밍 모델 후보 제외',!q(preference).some(x=>/게이밍/.test(x.title)),q(preference));

 const next=await session.say('10만원에서 15만원대로 해줘',{classify:'C|헤드셋',answer:'10만~15만 원에서 골라봤어요.'});
 check('범위를 바꿔도 1장만 표시',q(next).length===1&&next.body.forceShowCard===true,ids(next));
 check('기억한 게이밍 제외 유지',q(next).every(x=>!/게이밍/.test(x.title))&&
   AC.verifyConversationState(next.body.convState)?.constraints?.avoid==='게이밍',q(next));
 check('새 상한에 가장 근접한 일상용 모델',ids(next)[0]==='HEAD-145',ids(next));
 check('새 추천 카드 실제 가격 14.5만 원',prices(next)[0]===145000,prices(next));
 check('예산 범위에 없던 2~3만원 카드 제외',!prices(next).some(x=>x<120000),prices(next));

 const low=H.session();
 const lowRes=await low.say('헤드셋 5만원 이하 추천해줘',{classify:'C|헤드셋',answer:'추천 상품입니다.'});
 check('5만원 이하에서는 1~4만 상품 모두 검토',prices(lowRes).includes(18000)&&prices(lowRes).includes(45000),prices(lowRes));
 const sixty=H.session();
 const sixtyRes=await sixty.say('헤드셋 6만원 이하로 추천해줘',{classify:'C|헤드셋',answer:'추천 상품입니다.'});
 check('6만 원 상한은 3만원 이상만',prices(sixtyRes).length>0&&prices(sixtyRes).every(x=>x>=30000&&x<=60000),prices(sixtyRes));
 const none=H.session();
 const noneRes=await none.say('헤드셋 20만원 이하 추천해줘',{classify:'C|헤드셋',answer:'추천 상품입니다.'});
 check('17만~20만 품절 시 싼 상품 임의 대체 안 함',q(noneRes).length===0&&/가격대|범위/.test(noneRes.body.text),noneRes.body.text);
 check('테스트가 외부 API·DB에 쓰기하지 않음',H.counters.external===0&&H.counters.dbWrites===0,H.counters);
 console.log('AI_BUDGET_TARGET_AUDIT '+JSON.stringify({checks:checks.length,passed:pass,failed:fail,
  realGptCalls:0,externalCalls:H.counters.external,dbWrites:H.counters.dbWrites}));
 if(fail)process.exitCode=1;
})().catch(e=>{console.error('AI_BUDGET_TARGET_FATAL',e.stack||e);process.exitCode=1});
