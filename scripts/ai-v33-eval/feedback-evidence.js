'use strict';
// Privacy-safe, review-gated evaluation evidence for SEOSA AI v3.3.
// No imports of DB, network, provider clients, or runtime mutation.
// A generated answer NEVER grades itself as PASS: an independent reviewed oracle is required.
const VERDICTS=new Set(['PASS','FAIL','UNVERIFIED']);
const SOURCES=new Set(['api','cache','db','unknown']);
const REASONS=/^[a-z][a-z0-9_]{0,50}$/;
const asInt=(v,max=10000000)=>Number.isSafeInteger(Number(v))&&Number(v)>=0&&Number(v)<=max?Number(v):null;
const safeId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(v)?v:null;
function safeMap(input){
  const clean={};
  if(!input||typeof input!=='object'||Array.isArray(input))return clean;
  for(const [k,v] of Object.entries(input)){
    if(!REASONS.test(k))continue;
    const n=asInt(v,1000000);
    if(n!==null)clean[k]=n;
  }
  return clean;
}
function normalizeEvidence(response,review={}){
  const id=safeId(response?.id||response?.caseId);
  if(!id)throw new Error('Invalid case ID (no raw user text allowed)');
  if(review.id&&review.id!==id)throw new Error('Review ID mismatch');
  const reviewed=review.reviewed===true&&VERDICTS.has(review.verdict);
  // An independently reviewed UNVERIFIED is still UNVERIFIED.
  const verdict=reviewed?review.verdict:'UNVERIFIED';
  const rawSource=response?.stats?.retrieval?.bySource;
  const bySource={};
  if(rawSource&&typeof rawSource==='object') {
    for(const [k,v] of Object.entries(rawSource)){
      if(!SOURCES.has(k))continue;
      const n=asInt(v);
      if(n!==null)bySource[k]=n;
    }
  }
  const reason=typeof review.reason==='string'&&REASONS.test(review.reason)?review.reason:null;
  const modelUsage=response?.stats?.modelUsage||{};
  const cost=Number(review.costUsd);
  return {
    id,verdict,reviewed,
    reason,category:typeof review.category==='string'&&REASONS.test(review.category)?review.category:null,
    http:asInt(response?.http??response?.status,599),
    elapsedMs:asInt(response?.elapsedMs??response?.latencyMs,600000),
    displayedCards:Array.isArray(response?.cards)?Math.min(response.cards.length,100):0,
    dbQueries:asInt(response?.stats?.dbQueries,100000),
    providerSearchBatches:asInt(response?.stats?.retrieval?.providerSearchBatches,100000)??0,
    bySource,
    rejectedReasons:safeMap(response?.stats?.rejectedReasons),
    modelCalls:asInt(modelUsage.calls,100000),
    inputTokens:asInt(modelUsage.inputTokens,100000000),
    outputTokens:asInt(modelUsage.outputTokens,100000000),
    // Only a separately metered amount is included; never invent $0 for unknown charges.
    costUsd:review.costUsd!=null&&Number.isFinite(cost)&&cost>=0&&cost<=10000?cost:null
  };
}
function summarizeEvidence(events){
  const seen=new Set(), counts={PASS:0,FAIL:0,UNVERIFIED:0}, reviewQueue=[], times=[];
  let reviewed=0, observedCost=0, observedCostCases=0;
  const reasons={};
  for(const e of events){
    if(!safeId(e.id)||seen.has(e.id))throw new Error('Duplicate or invalid case ID: '+e.id);
    seen.add(e.id);
    if(!VERDICTS.has(e.verdict))throw new Error('Invalid verdict');
    counts[e.verdict]++;
    if(e.reviewed)reviewed++;
    if(e.elapsedMs!==null&&Number.isFinite(e.elapsedMs))times.push(e.elapsedMs);
    if(e.costUsd!==null&&Number.isFinite(e.costUsd)){observedCost+=e.costUsd;observedCostCases++;}
    if(e.verdict!=='PASS'){
      const reason=e.reason||'needs_oracle_review';
      reasons[reason]=(reasons[reason]||0)+1;
      reviewQueue.push({id:e.id,verdict:e.verdict,reason});
    }
  }
  times.sort((a,b)=>a-b);
  return {
    total:events.length,pass:counts.PASS,fail:counts.FAIL,unverified:counts.UNVERIFIED,
    reviewed,strictPassOnlyPercent:events.length?Number((100*counts.PASS/events.length).toFixed(2)):null,
    p95Ms:times.length?times[Math.ceil(times.length*.95)-1]:null,
    measuredCostUsd:observedCostCases?Number(observedCost.toFixed(6)):null,
    costMeasuredCases:observedCostCases,
    costUnmeasuredCases:events.length-observedCostCases,
    failureReasons:reasons,reviewQueue
  };
}
module.exports={normalizeEvidence,summarizeEvidence};