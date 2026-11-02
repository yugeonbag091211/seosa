'use strict';
/*
 * SEOSA seeded property/holdout audit, built from the live 2026-11-02
 * headset-range + apparel failure and OTHER independent shopping categories.
 *
 * 3600 separate assertions: 1200 independently computed two-ended budgets,
 * 1200 offer-identity adversarial input pairs, 1200 ACTUAL api/ai handler
 * executions with fixture merchant data and mock GPT.
 *
 * REAL: routing, constraint interpretation, identity gate, card output,
 * signed conversation state, server fallback.
 * MOCK: LLM, marketplace, DB. No production writes, real merchant/GPT calls
 * or API cost. Do not report as 3600 live GPT calls or 3600 unique prompts.
 *
 * Deterministic seed, report failure examples, fail closed. New bugs are
 * counterexamples to general invariants; never add per-question overrides.
 */
const crypto=require('node:crypto');
const SI=require('../api/_shopintent');
const AIID=require('../api/_aiidentity');
const H=require('./_ai-chat-harness');

const categories=['헤드셋','헤드폰','노트북','태블릿','무선 이어폰','무선 마우스',
 '기계식 키보드','블루투스 스피커','공기청정기','무선청소기','운동화','밥솥'];
const seed=20261102;
const seenQuestions=new Set();
const totals={budget:{checked:0,pass:0,fail:0},identity:{checked:0,pass:0,fail:0},handler:{checked:0,pass:0,fail:0}};
const failures=[];
const digest=crypto.createHash('sha256');
function check(group,label,condition,detail){
  totals[group].checked++;
  if(condition){totals[group].pass++;return;}
  totals[group].fail++;
  if(failures.length<80)failures.push({group,label,detail});
}
function track(q){seenQuestions.add(q);digest.update(q+'\n');}

/* Independent expected bounds; never call the production parser to
 * compute the expected answer. Phrase variants exercise both orders,
 * from/to, comma separated, and upper/lower bound synonyms.
 */
const rangeForms=[
 (c,lo,hi)=>c+' '+lo+'만원 이상 '+hi+'만원 이하 추천해줘',
 (c,lo,hi)=>c+' '+hi+'만원 이하 '+lo+'만원 이상 찾아줘',
 (c,lo,hi)=>c+' 가격 '+lo+'만원 이상, '+hi+'만원 이하만',
 (c,lo,hi)=>'통학용 '+c+' '+lo+'만원~'+hi+'만원에 골라줘',
 (c,lo,hi)=>'집에서 쓸 '+c+' '+lo+'만원에서 '+hi+'만원까지',
 (c,lo,hi)=>'출퇴근 '+c+' '+lo+'만원부터 '+hi+'만원까지',
 (c,lo,hi)=>'예산 '+lo+'만원 이상 '+hi+'만원 이하 '+c,
 (c,lo,hi)=>'가격은 '+hi+'만원 이하 '+lo+'만원 이상인 '+c,
 (c,lo,hi)=>c+'를 '+lo+'만원 이상 '+hi+'만원 이하로 부탁해',
 (c,lo,hi)=>c+' '+lo+'만원~'+hi+'만원 사이에서 추천해줘'
];
for(let c=0;c<categories.length;c++)for(let i=0;i<10;i++)for(let f=0;f<rangeForms.length;f++){
 const lo=3+i*2+c,hi=lo+4+i%3;
 const q=rangeForms[f](categories[c],lo,hi);
 track(q);
 const x=SI.parseConstraints(q);
 check('budget',q,x.budgetMin===lo*10000&&x.budgetMax===hi*10000,
  {expected:[lo*10000,hi*10000],actual:[x.budgetMin,x.budgetMax]});
}

/* 1200 adversarial offer/question pairs. A category word in the
 * description is NOT sufficient to prove that the sold item has that
 * category. Positive controls are checked by the handler layer below.
 */
const wrong=[
 {q:'헤드셋',title:'헤드셋 프린팅 스트릿 반팔 티셔츠'},
 {q:'헤드셋',title:'헤드셋 라운드넥 긴팔 티셔츠'},
 {q:'헤드셋',title:'헤드셋 그래픽 후드티'},
 {q:'헤드폰',title:'헤드폰 캐릭터 맨투맨'},
 {q:'헤드셋',title:'헤드셋 일상룩 의류 티셔츠'},
 {q:'헤드셋',title:'헤드셋 일러스트 라운드넥 반팔'},
 {q:'아이패드',title:'아이패드 전용 호환 터치펜'},
 {q:'갤럭시탭',title:'갤럭시탭 S10 FE 호환 S펜 스타일러스'},
 {q:'아이패드',title:'아이패드 프로 호환 매직키보드'},
 {q:'노트북',title:'노트북으로 돈 버는 법 온라인 교육'},
 {q:'노트북',title:'노트북 입문자 강좌'},
 {q:'갤럭시탭',title:'갤럭시탭 호환 액정 디스플레이 교체 부품'}
];
const locales=['베이직','그레이','화이트','블랙','2026 신상','추천','인기','한정판','정품','프리미엄'];
const wordings=[
 n=>n+' 추천해줘',
 n=>'좋은 '+n+' 골라줘',
 n=>n+' 본품을 찾고 있어',
 n=>n+' 15만원 이하 추천해줘',
 n=>n+' 케이스 말고 본체만',
 n=>'지금 판매 중인 '+n+' 찾아줘',
 n=>'신품 '+n+' 가격 알려줘',
 n=>n+' 중에서 가성비 골라줘',
 n=>'통학용 '+n+' 부탁해',
 n=>n+' 비교해보고 싶어'
];
for(const x of wrong)for(const label of locales)for(const ask of wordings){
 const q=ask(x.q),title=label+' '+x.title;
 const contract=AIID.buildContract({query:q,userText:q,titles:[title]});
 const result=AIID.partition([{title,lprice:54900}],contract);
 const accepted=(result.items||[]).length>0;
 check('identity',q+' | '+title,!accepted,
   {reason:'incorrect product type passed category gate',accepted});
}

/* Full handler holdout. Search results include a verified offer INSIDE
 * the independently specified interval plus cheaper/outside candidates.
 * 1200 prompts: 10 product groups × 10 ranges × 12 unseen wordings.
 * No per-question expected answer strings; check INVARIANTS instead.
 */
const handlerCats=categories.slice(0,10);
const prompts=[
 (c,a,b)=>c+' '+a+'만원 이상 '+b+'만원 이하 골라줘',
 (c,a,b)=>c+' '+b+'만원 이하 '+a+'만원 이상 추천해줘',
 (c,a,b)=>'출근할 때 쓸 '+c+' '+a+'만원 이상 '+b+'만원 이하로',
 (c,a,b)=>'학교에서 사용하는 '+c+', 예산 '+a+'만원 이상 '+b+'만원 이하',
 (c,a,b)=>'실내용 '+c+' '+a+'만원부터 '+b+'만원까지 찾아줘',
 (c,a,b)=>'가성비 좋은 '+c+' '+a+'만원~'+b+'만원 추천',
 (c,a,b)=>c+'는 '+a+'만원 이상이고 '+b+'만원 이하로만',
 (c,a,b)=>'선물용 '+c+' '+b+'만원 이하 '+a+'만원 이상 부탁해',
 (c,a,b)=>'깔끔한 '+c+' '+a+'만원 이상, '+b+'만원 이하',
 (c,a,b)=>c+' '+a+'만원~'+b+'만원 사이에서 골라줘',
 (c,a,b)=>'일상용 '+c+' 가격은 '+a+'만원 이상 '+b+'만원 이하',
 (c,a,b)=>c+' 가격 '+b+'만원 이하, 최소 '+a+'만원 이상으로'
];
const fixturePrices=[];
for(let k=0;k<handlerCats.length;k++){
 const cat=handlerCats[k];
 for(let j=0;j<10;j++){
  const lo=5+j*2+k,hi=lo+4,p=(lo+2)*10000;
  fixturePrices.push({cat,lo,hi,p});
  H.addProduct({pid:'P3600-'+k+'-'+j,vid:'V3600-'+k+'-'+j,mall:'ADPICK',
   title:'테스트브랜드 '+cat+' '+(k+1)+'시리즈 '+(j+1)+'형',
   price:p,keys:[cat,cat.replace(/\s+/g,'')],history:[[0,p],[1,p]]});
 }
 // Real Production trap replicated: apparel with the literal search keyword
 if(cat==='헤드셋'||cat==='헤드폰')H.addProduct({
  pid:'P3600-TRAP-'+k,vid:'V3600-TRAP-'+k,mall:'ADPICK',
  title:cat+' 인기 스트릿 패션 라운드넥 반팔 티셔츠',
  price:55080,keys:[cat],history:[[0,55080]]});
}
(async()=>{
 for(const row of fixturePrices)for(const fn of prompts){
  const q=fn(row.cat,row.lo,row.hi),floor=row.lo*10000,cap=row.hi*10000;
  track(q);
  let r,error='';
  try{r=await H.ask({question:q,chatHistory:[],view:{source:'none'}},
    {classify:'C|'+row.cat,answer:'확인된 상품의 표시 가격만 안내합니다.'});}
  catch(e){error=String(e&&e.message||e);}
  const list=(r&&r.body&&r.body.items)||[];
  const wrongItem=list.find(x=>{
   const p=Number(x.lprice)||0;
   return p<floor||p>cap||!/^\s*테스트브랜드/.test(String(x.title||''))||!x.productId;
  });
  const valid=error===''&&r?.status===200&&list.length>0&&!wrongItem
    &&String(r.body?.text||'').length>0;
  check('handler',q,valid,{error,status:r?.status,
    prices:list.map(c=>Number(c.lprice)),names:list.slice(0,3).map(c=>c.title),
    answer:String(r?.body?.text||'').slice(0,140)});
 }
 const all=Object.values(totals).reduce((s,x)=>s+x.checked,0);
 const passed=Object.values(totals).reduce((s,x)=>s+x.pass,0);
 const fail=Object.values(totals).reduce((s,x)=>s+x.fail,0);
 for(const x of failures.slice(0,40))console.log('AI_HOLDOUT_3600_FAIL '+JSON.stringify(x));
 const summary={seed,mode:'ACTUAL_HANDLER_MOCK_GPT_MERCHANT_DB',
  expectedCases:3600,checked:all,passed,failed:fail,
  uniqueCustomerQuestions:seenQuestions.size,
  checkedByLayer:totals,examples:failures.slice(0,10),
  hash: digest.digest('hex'),
  realGptCalls:0,realMerchantCalls:H.counters.external,
  dbWrites:H.counters.dbWrites};
 console.log('AI_HOLDOUT_3600_SUMMARY '+JSON.stringify(summary));
 if(all!==3600||fail||H.counters.external||H.counters.dbWrites)process.exitCode=1;
})().catch(e=>{console.error('AI_HOLDOUT_3600_FATAL '+String(e.stack||e));process.exitCode=1;});
