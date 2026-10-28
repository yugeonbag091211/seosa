'use strict';
/* Additional 1,000 unique shopping utterances: 10 category × 10 budget × 10 use cases.
 * Real API handler with MOCK GPT, catalogue and merchant API; 0 real calls. */
const H=require('./_ai-chat-harness');
const BW=require('../api/_ai-budget-window');
const crypto=require('node:crypto');
const cats=['무선 이어폰','무선 헤드셋','블루투스 스피커','무선 마우스','기계식 키보드','USB 웹캠','휴대용 모니터','블루투스 헤드폰','태블릿','노트북'];
const limits=[30000,50000,60000,80000,100000,120000,150000,200000,300000,500000];
const formats=[
 (c,m)=>'통학할 때 사용할 '+c+'을 '+m+'원 이하로 추천해줘',
 (c,m)=>'출퇴근용 '+c+'을 '+m+'원 이하 예산에서 골라줘',
 (c,m)=>'사무실에서 쓸 '+c+', 가격은 '+m+'원 이하로 해줘',
 (c,m)=>'도서관에서 쓰기 좋은 '+c+'을 '+m+'원 이하에서 추천해줘',
 (c,m)=>'집에서 쓰는 '+c+'을 '+m+'원 이하로 찾아줘',
 (c,m)=>'학교 과제용 '+c+' 추천해줘. 예산은 '+m+'원 이하야',
 (c,m)=>'친구에게 선물할 '+c+'을 '+m+'원 이하에서 골라줘',
 (c,m)=>'가방에 휴대하기 좋은 '+c+', '+m+'원 이하로 찾아줘',
 (c,m)=>'내구성을 중요하게 보는 '+c+'을 '+m+'원 이하로 추천해줘',
 (c,m)=>'사용하기 편한 '+c+'을 '+m+'원 이하로 부탁해'
];
const prices=[19000,29900,34900,49000,59000,79000,99000,115000,129000,145000,179000,199000,279000,299000,449000,499000];
for(let k=0;k<cats.length;k++)for(let j=0;j<prices.length;j++){
 const cat=cats[k],p=prices[j];
 H.addProduct({pid:'Q1K-'+k+'-'+j,vid:'Q1KOPT'+k+'-'+j,mall:'쿠팡',
 title:'테스트브랜드 '+cat+' '+(k+1)+'시리즈 '+(j+1)+'형',
 price:p,oprice:Math.round(p*1.12),keys:[cat,cat.replace(/\s/g,'')],history:[[0,p],[1,p]]});
}
let pass=0,fail=0,positive=0,legitEmpty=0;
const seen=new Set(),groups={},failureCases=[];
(async()=>{
 for(const cat of cats)for(const ceiling of limits)for(const fmt of formats){
  const q=fmt(cat,ceiling.toLocaleString('ko-KR'));
  if(seen.has(q))throw Error('DUPLICATE '+q);seen.add(q);
  groups[cat]??={asked:0,pass:0,fail:0};groups[cat].asked++;
  let r=null,err='';
  try{r=await H.ask({question:q,chatHistory:[],contextProducts:[],view:{source:'none'}},
   {classify:'C|'+cat,answer:'서사에서 확인한 상품만 기준으로 추천드립니다.'});}
  catch(e){err=String(e.message||e);}
  const items=r?.body?.items||[];
  const window=BW.nearBudgetWindow([{price:ceiling}],{budgetMax:ceiling,budgetSaid:ceiling},q);
  const lower=window.applies?window.lower:0;
  /*
   * The fixture catalogue is known, so "no result" is only a valid answer when it is true
   * (2026-10-26). Before this, 400/1000 answers were "12만~15만원에서 못 찾음" refusals while
   * 12.9만·14.5만원 offers existed, and the loose text match below counted them as passes.
   *   near-ceiling offer exists → cards, all inside [lower, ceiling]
   *   only cheaper in-budget offers → cards inside the budget AND the fallback notice
   *   nothing inside the budget → a no-result answer is legitimate
   */
  const nearExists=prices.some(p=>p>=lower&&p<=ceiling);
  const inBudgetExists=prices.some(p=>p<=ceiling);
  const text=r?.body?.text||'';
  const valid=r?.status===200&&typeof r.body?.text==='string'&&r.body.text.length>0&&!err
   &&items.every(i=>Number(i.lprice)>0&&Number(i.lprice)<=ceiling&&!!i.productId)
   &&items.every(i=>!BW.avoidsGaming(i))&&!r.body?.comparison?.complete
   &&(nearExists?items.length>0&&items.every(i=>Number(i.lprice)>=lower)
     :inBudgetExists?items.length>0&&/가까운[^\n]*확인된 상품이 없어/.test(text):true);
  const acceptedEmpty=!inBudgetExists&&items.length===0&&/(?:찾|없|확인|조건|검색|후보|결과|범위|추천)/.test(text);
  const success=valid&&(items.length>0||acceptedEmpty);
  if(items.length>0)positive++;else if(acceptedEmpty)legitEmpty++;
  if(success){pass++;groups[cat].pass++;}else{
   fail++;groups[cat].fail++;const f={q,cat,ceiling,lower,status:r?.status,
    prices:items.map(i=>i.lprice),reply:r?.body?.text?.slice(0,125),error:err};
   failureCases.push(f);if(failureCases.length<=100)console.log('AI_NEW_1000_FAIL '+JSON.stringify(f));
  }
 }
 const audit={mode:'REAL_HANDLER_MOCK_GPT',asked:seen.size,unique:seen.size,pass,fail,
  positive,legitimateNoResults:legitEmpty,groups,realGptCalls:0,
  externalCalls:H.counters.external,dbWrites:H.counters.dbWrites,
  corpusSha256:crypto.createHash('sha256').update([...seen].join('\n')).digest('hex')};
 console.log('AI_NEW_1000_AUDIT '+JSON.stringify(audit));
 if(seen.size!==1000||fail||positive<150||H.counters.external||H.counters.dbWrites)process.exitCode=1;
})().catch(e=>{console.error('AI_NEW_1000_FATAL '+(e.stack||e));process.exitCode=1;});
