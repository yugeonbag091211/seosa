'use strict';
/*
 * Aggregate per-merchant source metadata for the public search response.
 * Older clients already understand stale-cache: any stale listing preserves
 * that warning, even if the other merchant successfully answered.
 */
const FRESH=new Set(['api','cache']);
const ALL=new Set(['api','cache','stale-cache','none']);
const source=s=>ALL.has(s)?s:'none';
function summarizeSearchProvenance(search={},visibleItems=search.items||[]){
 const rows=Array.isArray(visibleItems)?visibleItems:[];
 const hasProviderStates=!!search.providerSources;
 const providers=hasProviderStates
   ?[source(search.providerSources.coupang),source(search.providerSources.adpick)]
   :[source(search.from)];
 const shown=rows.map(it=>source(it&&it._source||search.from));
 const hasStale=shown.includes('stale-cache');
 const hasFresh=shown.some(s=>FRESH.has(s));
 const answered=providers.some(s=>FRESH.has(s))||search.freshAnswered===true;
 let summary='none';
 if(rows.length){
   if(hasStale)summary='stale-cache';
   else if(shown.every(s=>s==='api'))summary='api';
   else if(shown.every(s=>FRESH.has(s)))summary='cache';
 }else{
   if(providers.includes('api'))summary='api';
   else if(providers.includes('cache')||answered)summary='cache';
 }
 const complete=providers.length===2
   ?providers.every(s=>FRESH.has(s))
   :providers.length===1&&FRESH.has(providers[0]);
 return {
   source:summary,
   partialStale:hasStale&&hasFresh,
   partialResults:providers.length===2 && !complete,
   blocked:!rows.length&&!answered&&!!(search.blocked||Object.values(search.providerBlocked||{}).some(Boolean)),
   edgeCacheSafe:rows.length>0&&complete&&summary!=='stale-cache'&&summary!=='none'
 };
}
module.exports={summarizeSearchProvenance};
