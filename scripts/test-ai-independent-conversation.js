'use strict';
// Independent mocked-handler regressions; no real model or external shopping call.
const assert=require('node:assert/strict');
const H=require('./_ai-chat-harness');
const AC=require('../api/_aicontext');
[
 {pid:'IND-IPAD',vid:'IPAD-OPT',title:'Apple 아이패드 11 A16 128GB Wi-Fi 태블릿',price:410000,keys:['아이패드']},
 {pid:'IND-TAB',vid:'TAB-OPT',title:'삼성 갤럭시탭 S9 FE 128GB Wi-Fi 태블릿',price:450000,keys:['갤럭시탭']},
 {pid:'IND-CASE',vid:'CASE-OPT',title:'갤럭시탭 S9 FE 호환 케이스 커버',price:5000,keys:['갤럭시탭']},
 {pid:'IND-H1',vid:'H1-OPT',title:'소니 무선 블루투스 헤드셋 WH-CH720N',price:135000,keys:['헤드셋']},
 {pid:'IND-H2',vid:'H2-OPT',title:'소니 무선 통화 헤드셋 WH-CH520',price:122000,keys:['헤드셋']},
 {pid:'IND-GAMER',vid:'G-OPT',title:'로지텍 게이밍 무선 헤드셋 G733',price:125000,keys:['헤드셋']}
 ,{pid:'IND-MAC-MID',vid:'MID-OPT',title:'Apple 맥북 에어 M3 미드나이트 8GB',price:1390000,keys:['맥북']}
 ,{pid:'IND-MAC-STAR',vid:'STAR-OPT',title:'Apple 맥북 에어 M3 스타라이트 8GB',price:1350000,keys:['맥북']}
].forEach(p=>H.addProduct({...p,mall:'쿠팡',history:[[0,p.price]]}));
const opts={classify:'C|무선 헤드셋',answer:'확인된 상품 기준으로 안내합니다.'};
const cards=r=>r.body.items||[];
(async()=>{
 const q='아이패드 11 A16 vs 갤럭시탭 S9 FE 성능 차이 알려줘';
 const before=H.searchLog.length;
 const r=await H.ask({question:q},{classify:'B',answer:'사용 환경을 확인하세요.'});
 const searches=H.searchLog.slice(before);
 assert.equal(searches.length,2,JSON.stringify(searches));
 assert.ok(searches.some(x=>/아이패드/.test(x)&&!/갤럭시탭/.test(x)) && searches.some(x=>/갤럭시탭/.test(x)&&!/아이패드/.test(x)),JSON.stringify(searches));
 assert.deepEqual(new Set(cards(r).map(c=>c.productId)),new Set(['IND-IPAD','IND-TAB']));
 assert.ok(r.body.comparison.complete);
 const q2='아이패드 11 A16 vs 갤럭시탭 S10 울트라 가격 차이 알려줘';
 const n=H.searchLog.length;
 const partial=await H.ask({question:q2},{classify:'B',answer:'사용 환경을 확인하세요.'});
 assert.equal(H.searchLog.slice(n).length,2);
 assert.equal(partial.body.comparison.complete,false);
 assert.deepEqual(cards(partial).map(c=>c.productId),['IND-IPAD']);
 assert.ok(/확인하지 못했/.test(partial.body.text));
 assert.ok(!cards(partial).some(c=>c.productId==='IND-CASE'));
 const s=H.session();
 const a=await s.say('일상용 무선 헤드셋 추천해줘',opts);
 assert.ok(cards(a).length>=1 && !cards(a).some(c=>/게이밍|gaming/i.test(c.title)),JSON.stringify(cards(a)));
 assert.equal(AC.verifyConversationState(a.body.convState).constraints.avoidGaming,true);
 const b=await s.say('예산은 15만원 이하로 바꿔줘',opts);
 assert.equal(cards(b).length,1,JSON.stringify(cards(b)));
 assert.ok(!cards(b).some(c=>/게이밍|gaming/i.test(c.title)));
 assert.equal(AC.verifyConversationState(b.body.convState).constraints.avoidGaming,true);
 const c=await s.say('통화할 때 쓸 거야',opts);
 assert.equal(cards(c).length,1,JSON.stringify(cards(c)));
 assert.ok(!cards(c).some(x=>/게이밍|gaming/i.test(x.title)));
 assert.equal(AC.verifyConversationState(c.body.convState).constraints.avoidGaming,true);
 const pair=H.session();
 const initial=await pair.say('혹시 아이패드 11 A16 vs 갤럭시탭 S9 FE 비교해줘',{classify:'B',answer:'사용 환경을 확인하세요.'});
 assert.equal(initial.body.comparison.complete,true,JSON.stringify(initial.body));
 for(const follow of ['어느 쪽이 더 저렴해?','두 개 판매가를 다시 확인해줘','비교한 두 개 중 가격 낮은 쪽은?', '비교한 두 제품 가격 다시 조회해줘', '두 모델 가격을 다시 확인해줘']) {
   const answer=await pair.say(follow,{classify:'B',answer:'확인해 볼게요.'});
   assert.equal(answer.body.comparison?.complete,true,JSON.stringify({follow,body:answer.body}));
   assert.deepEqual(new Set(cards(answer).map(x=>x.productId)),new Set(['IND-IPAD','IND-TAB']));
 }
 const forged=await H.ask({question:'어느 쪽이 더 저렴해?',convState:'invalid-signed-state'},{classify:'B',answer:'비교할 상품을 알려주세요.'});
 assert.ok(!forged.body.comparison,'Unsigned pair references must not be resolved');
 assert.equal(require('../api/_ai-comparison').isPairFollowup('아이패드는 어느 쪽이 더 저렴해?'),false);
 const alt=H.session();
 await alt.say('소니 무선 블루투스 헤드셋 WH-CH720N 얼마야?',{classify:'D|소니 WH-CH720N',answer:'확인된 가격을 안내합니다.'});
 const alternative=await alt.say('다른 선택지도 찾아줘',opts);
 assert.ok(cards(alternative).length>0,JSON.stringify(alternative.body));
 assert.notEqual(alternative.body.topProductId,'IND-H1');
 const option=H.session();
 await option.say('맥북 에어 M3 미드나이트 8GB 찾아줘',{classify:'D|맥북 에어 M3 미드나이트',answer:'확인한 상품입니다.'});
 const selected=await option.say('스타라이트로 바꿔줘',{classify:'D|맥북 에어 M3 스타라이트',answer:'확인한 상품입니다.'});
 assert.equal(selected.body.topProductId,'IND-MAC-STAR',JSON.stringify(selected.body));
 const same=await option.say('그 옵션의 현재가는 얼마야?',{classify:'D|맥북 에어 M3',answer:'확인한 상품입니다.'});
 assert.deepEqual(cards(same).map(x=>x.productId),['IND-MAC-STAR'],JSON.stringify(same.body));
 assert.equal(cards(same)[0].vendorItemId,'STAR-OPT');
 assert.equal(H.counters.external,0);assert.equal(H.counters.dbWrites,0);
 console.log('AI_INDEPENDENT_CONVERSATION: comparison, signed pair and option memory, alternative, gaming exclusion; PASS; mocked GPT, real GPT 0, external 0, DB writes 0');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
