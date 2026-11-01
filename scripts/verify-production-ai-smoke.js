#!/usr/bin/env node
'use strict';
/*
 * Runs in one isolated Preview BUILD after production is deployed.
 * Requests the public PRODUCTION AI endpoint, not a local fixture.
 * No credentials, database SQL, or API secret is read or emitted.
 * Strictly <=3 POST requests, bounded elapsed time, and no retries.
 */
if(process.env.VERCEL_ENV === 'production') {
  console.error('PROD_SMOKE_ABORT cannot run this QA script in Production build');
  process.exit(2);
}
const BASE='https://seosa.ai.kr';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[];
let lastState='',lastRef='',lastSig='',lastText='';
async function ask(label,question,opts={}){
 const payload={
   question,view:{source:'none'},contextProducts:[],
   chatHistory:opts.chatHistory||[{role:'user',content:question}],
   ...(opts.convState?{convState:opts.convState}:{}),
   ...(opts.prevTopRef?{prevTopRef:opts.prevTopRef}:{})
 };
 let r,body;
 try{
  r=await fetch(BASE+'/api/ai',{
    method:'POST',
    headers:{'content-type':'application/json','Accept':'application/json','User-Agent':'SEOSA-Production-Smoke/1.0'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(65000)
  });
  body=await r.json();
 }catch(e){
  const obj={name:label,pass:false,networkFailure:e.name||'unknown'};
  checks.push(obj);console.log('PROD_AI_TEST '+JSON.stringify(obj));return null;
 }
 const cards=Array.isArray(body.items)?body.items:[];
 const prices=cards.map(c=>Number(c.lprice));
 const cap=opts.cap||0;
 const hardPass=Number(r.status)===200 && typeof body.text==='string'&&body.text.trim().length>10
    &&!body.error&&prices.every(p=>Number.isFinite(p)&&p>0)
    &&(!cap||prices.every(p=>p<=cap))
    &&cards.every(c=>typeof c.link==='string'&&/^https:\/\//.test(c.link));
 const obj={name:label,status:r.status,pass:!!hardPass,intent:body.intent||null,
    cards:cards.length,priceOverCap:cap?prices.filter(p=>p>cap).length:0,
    wrongProductCategory:opts.category?cards.filter(c=>!String(c.title||'').includes(opts.category)).length:0,
    hasConversationState:typeof body.convState==='string'&&body.convState.length>0,
    hasText:!!body.text,partialSearch:!!body.partialSearch,
    errorCode:body.error?String(body.error).slice(0,85):null};
 if(obj.wrongProductCategory) obj.pass=false;
 checks.push(obj);console.log('PROD_AI_TEST '+JSON.stringify(obj));
 if(hardPass){
  lastState=body.convState||lastState;
  lastRef=body.topRecommendationRef||lastRef;
  lastSig=body.turnSig||lastSig;
  lastText=body.text||lastText;
 }
 return body;
}
(async()=>{
 const q1='15만원 이하 무선 이어폰 추천해줘';
 const a=await ask('budget-earbuds',q1,{cap:150000,category:'이어폰'});
 if(a && a.convState){
   await sleep(17000);
   const q2='근데 12만원 이하로 바꿔줘';
   await ask('signed-followup-budget',q2,{cap:120000,category:'이어폰',convState:a.convState,
     prevTopRef:a.topRecommendationRef,
     chatHistory:[{role:'user',content:q1},{role:'assistant',content:a.text,turnSig:a.turnSig||''},{role:'user',content:q2}]});
 }
 await sleep(17000);
 await ask('tablet-comparison','아이패드 vs 갤럭시탭 비교해줘');
 const pass=checks.filter(c=>c.pass).length;
 console.log('PROD_SMOKE_SUMMARY '+JSON.stringify({
   asked:checks.length,pass,fail:checks.length-pass,productionDomain:BASE,
   caseNames:checks.map(c=>c.name),
   actualAiHttpRequests:checks.length,noDirectMerchantCallsFromHarness:true
 }));
 if(!checks.length||checks.some(c=>!c.pass))process.exitCode=1;
})().catch(e=>{console.error('PROD_SMOKE_UNHANDLED '+String(e&&e.message||e));process.exitCode=1});
