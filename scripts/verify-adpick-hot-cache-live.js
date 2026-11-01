#!/usr/bin/env node
'use strict';
// One real ADPICK call max: verify in-process hot reuse in read-only Preview.
// Does not issue LLM requests, write DB, deploy to Production or alter quotas.
if(process.env.VERCEL_ENV==='production'){
  console.error('FAIL: production use forbidden');process.exit(2);
}
if(!process.env.ADPICK_API_KEY){
  console.error('FAIL: no ADPICK key');process.exit(2);
}
if(!(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) && !process.env.NEON_DATABASE_URL){
  console.error('FAIL: no readonly DB source');process.exit(2);
}
process.env.SEOSA_DB_READONLY='1';
const {searchAdpick,localStats}=require('../api/_adpick');
const db=require('../api/_supabase');
(async()=>{
  const q='아이리버 오픈형 무선 이어폰';
  const opts={source:'ai',limit:20,maxWaitMs:3500};
  const a=await searchAdpick(q,opts);
  const b=await searchAdpick(q,opts);
  const s=localStats(),guard=db.__readOnlyGuard;
  const checks={
    readonly: guard.enabled===true && guard.allowedRpc===0,
    verifiedSupplierCall: a.from==='api' && a.apiCalled===true && a.items.length>0,
    hotReuse: b.from==='cache' && b.hotCache===true && b.items.length===a.items.length,
    noExtraSupplierCall: s.calls===1 && s.hotCacheHits===1,
    noProductionWrites: guard.blockedWrites>=0 && guard.blockedRpc>=1
  };
  for(const [k,v] of Object.entries(checks))console.log((v?'PASS ':'FAIL ')+k);
  console.log('QA_SUMMARY '+JSON.stringify({
    pass:Object.values(checks).filter(Boolean).length,fail:Object.values(checks).filter(x=>!x).length,
    firstSource:a.from,secondSource:b.from,positiveItems:a.items.length,
    actualProviderCalls:s.calls,hotCacheHits:s.hotCacheHits,blockedWrites:guard.blockedWrites,
    blockedRpc:guard.blockedRpc,enabled:guard.enabled
  }));
  if(Object.values(checks).some(x=>!x))process.exitCode=1;
})().catch(e=>{console.error('QA_ERROR '+e.message);process.exitCode=1;});
