'use strict';
/*
 * 100 unseen comparison phrasings: no appended numeric suffix, no
 * classifier teaching the handler the answer. All use REAL /api/ai
 * processing with mock GPT and fixture catalogue. These 100 are separate
 * from the pre-existing 1,000-question audit.
 */
const H=require('./_ai-chat-harness');
const F=require('./_ai-chat-fixtures');
F.ALL.forEach(H.addProduct);
const models=[
 ['그램15','그램16',F.GRAM_15,F.GRAM_16],
 ['그램15','그램 프로',F.GRAM_15,F.GRAM_PRO],
 ['QCY T13 ANC','JBL 튠 비즈2',F.QCY,F.JBL],
 ['소니 WF-1000XM5','에어팟 프로 2',F.SONY,F.AIRPODS],
 ['JBL 튠 비즈2','소니 WF-1000XM5',F.JBL,F.SONY],
 ['QCY T13 ANC','에어팟 프로 2',F.QCY,F.AIRPODS],
 ['그램16','그램 프로',F.GRAM_16,F.GRAM_PRO],
 ['버즈3 프로 블랙','버즈3 프로 화이트',F.BUDS_BLACK,F.BUDS_WHITE],
 ['버즈3 프로 블랙','에어팟 프로 2',F.BUDS_BLACK,F.AIRPODS],
 ['에어팟 프로 2','소니 WF-1000XM5',F.AIRPODS,F.SONY]
];
const format=[
 (a,b)=>`${a}와 ${b} 비교해줘. 가격 차이가 궁금해.`,
 (a,b)=>`${a}랑 ${b} 중 어느 쪽이 좋아?`,
 (a,b)=>`${a}하고 ${b} 중 뭘 고를까?`,
 (a,b)=>`${a} vs ${b} 가격 차이 알려줘.`,
 (a,b)=>`${a}와 ${b} 가성비 비교 부탁해.`,
 (a,b)=>`${a}랑 ${b} 성능 차이 알려줘.`,
 (a,b)=>`${a}하고 ${b} 비교해주세요. 장단점도 알려줘.`,
 (a,b)=>`${a} VS ${b} 중 뭐가 나아?`,
 (a,b)=>`${a}와 ${b} 중 더 저렴한 건?`,
 (a,b)=>`${a}랑 ${b} 비교해줄래? 뭐 살지 모르겠어.`
];
(async()=>{
 let asked=0,pass=0,failed=0;
 const seen=new Set(),failures=[];
 for(const [a,b,left,right] of models)for(const build of format){
   const q=build(a,b);
   if(seen.has(q))throw Error('duplicate '+q);seen.add(q);
   let response,error='';
   try{response=await H.ask({question:q},{
     classify:'B',answer:'제품을 고르려면 사용 환경을 더 확인하세요.'
   });}catch(e){error=String(e.message||e);}
   asked++;
   const items=response?.body?.items||[];
   const key=x=>[x.productId,x.vendorItemId||''].join('|');
   const exp=[left,right].map(x=>[x.pid,x.vid||''].join('|'));
   const result=response?.status===200&&response?.body?.comparison?.complete===true
      &&items.length===2&&exp.every(k=>items.some(c=>key(c)===k))
      &&items.every(c=>exp.includes(key(c)))&&!error;
   if(result)pass++;else {
      failed++;
      const item={q,error,status:response?.status,got:items.map(key),
        expected:exp,excerpt:String(response?.body?.text||'').slice(0,110)};
      failures.push(item);
      if(failures.length<=100)console.log('AI_COMPARE_HOLDOUT_FAIL '+JSON.stringify(item));
   }
 }
 console.log('AI_COMPARE_HOLDOUT_AUDIT '+JSON.stringify({
  mode:'REAL_HANDLER_MOCK_GPT',asked,unique:seen.size,pass,failed,
  actualGptCalls:0,externalCalls:H.counters.external,dbWrites:H.counters.dbWrites
 }));
 if(failed||asked!==100||seen.size!==100||H.counters.external||H.counters.dbWrites)process.exitCode=1;
})().catch(e=>{console.error('AI_COMPARE_HOLDOUT_FATAL',e.stack||e);process.exitCode=1;});
