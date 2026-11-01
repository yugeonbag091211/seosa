'use strict';
// One real ADPICK request maximum. Read-only DB, no GPT and no Production.
if(process.env.VERCEL_ENV==='production')throw new Error('Production denied');
if(!process.env.ADPICK_API_KEY)throw new Error('ADPICK credentials missing');
if(process.env.SEOSA_DB_BACKEND!=='neon'&&!process.env.SUPABASE_SECRET_KEY)throw new Error('DB credentials missing');
process.env.SEOSA_DB_READONLY='1';
const db=require('../api/_supabase');
const {searchAll}=require('../api/_shop');
const {summarizeSearchProvenance}=require('../api/_search-provenance');
const {localStats}=require('../api/_adpick');
(async()=>{
 const result=await searchAll('무선 마우스',{
   coupangLimit:6,adpickLimit:10,
   coupangOpts:{source:'search',maxWaitMs:0},
   adpickOpts:{source:'search',maxWaitMs:3500,forceRefresh:true,timeoutMs:8000}
 });
 const s=summarizeSearchProvenance(result,result.items);
 const ad=localStats(),guard=db.__readOnlyGuard;
 const sources=result.providerSources||{};
 const checks={
   readonly:guard.enabled===true&&guard.allowedRpc===0,
   oneADPICKMax:ad.calls<=1,
   actualADPICK:ad.calls===1&&sources.adpick==='api',
   sourceGrounded:(result.items||[]).some(it=>it&&it._source==='stale-cache')?s.source==='stale-cache':true,
   noPartialCache: (sources.coupang==='none'||sources.adpick==='none'||sources.coupang==='stale-cache'||sources.adpick==='stale-cache')?!s.edgeCacheSafe:true
 };
 Object.keys(checks).forEach(k=>console.log((checks[k]?'PASS ':'FAIL ')+k));
 console.log('PROVENANCE_LIVE_SUMMARY '+JSON.stringify({
  pass:Object.values(checks).filter(Boolean).length,fail:Object.values(checks).filter(v=>!v).length,
  providerSources:sources,reportedSource:s.source,partialStale:s.partialStale,
  edgeCacheSafe:s.edgeCacheSafe,items:result.items.length,
  adpickCalls:ad.calls,blockedWrites:guard.blockedWrites,blockedRpc:guard.blockedRpc
 }));
 if(Object.values(checks).some(v=>!v))process.exitCode=1;
})().catch(e=>{console.error('PROVENANCE_LIVE_ERROR '+e.message);process.exitCode=1;});
