'use strict';
/**
 * Real /api/ai routing regression for iPad vs Galaxy Tab, discovered in
 * protected Preview runtime: both shopping providers returned HTTP 200,
 * but a combined query was sent and no comparison cards were selected.
 * Tests use fixture results and a mock LLM; no actual API/DB mutations.
 */
const H = require('./_ai-chat-harness');
const F = require('./_ai-chat-fixtures');
const C = require('../api/_ai-comparison');
F.ALL.forEach(H.addProduct);
const ipad={pid:'IPAD-TEST',vid:'IPAD-V1',mall:'쿠팡',title:'Apple 아이패드 11 A16 128GB Wi-Fi 태블릿',price:399000,keys:['아이패드','ipad'],history:[[0,399000]]};
const galaxy={pid:'GTAB-TEST',vid:'GTAB-V1',mall:'쿠팡',title:'삼성전자 갤럭시탭 S10 FE 128GB Wi-Fi 태블릿',price:429000,keys:['갤럭시탭','갤럭시 탭'],history:[[0,429000]]};
H.addProduct(ipad);
H.addProduct(galaxy);
const questions=[
 '아이패드랑 갤럭시탭을 비교해줘',
 '아이패드랑 갤럭시탭 비교해줘',
 '아이패드와 갤럭시탭을 비교해줘',
 '아이패드와 갤럭시탭 비교해주세요',
 '아이패드하고 갤럭시탭 중 뭘 고를까?',
 '아이패드 vs 갤럭시탭 가격 차이 알려줘',
 'iPad vs Galaxy Tab 가격 차이 알려줘'
];
(async()=>{
 let passed=0,failed=0;
 for(const q of questions){
  const parsed=C.parseComparison(q);
  const before=H.searchLog.length;
  const r=await H.ask({question:q},{classify:'B',answer:'사용 환경과 호환 기기를 확인하세요.'});
  const searched=H.searchLog.slice(before);
  const cards=r.body.items||[];
  const have=new Set(cards.map(x=>x.productId));
  const ok=parsed?.length===2&&searched.length===2
    &&!searched.some(x=>x.includes('아이패드 갤럭시탭'))
    &&r.status===200&&have.has(ipad.pid)&&have.has(galaxy.pid)
    &&r.body.comparison?.complete===true;
  if(ok)passed++;else {
   failed++;
   console.log('AI_TABLET_COMPARISON_FAIL '+JSON.stringify({
     question:q,parsed,searched,status:r.status,got:[...have],
     full:r.body.comparison,excerpt:String(r.body.text||'').slice(0,190)
   }));
  }
 }
 console.log('AI_TABLET_COMPARISON_AUDIT '+JSON.stringify({
  questions:questions.length,passed,failed,
  gptApiCalls:0,externalApiCalls:H.counters.external,dbWrites:H.counters.dbWrites
 }));
 if(failed||H.counters.external||H.counters.dbWrites)process.exitCode=1;
})().catch(e=>{console.error('AI_TABLET_COMPARISON_FATAL',e.stack||e);process.exitCode=1});
