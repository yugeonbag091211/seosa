'use strict';
const assert=require('node:assert/strict');
const {summarizeSearchProvenance:summarize}=require('../api/_search-provenance');
const states=['api','cache','stale-cache','none'];
let pass=0;
function check(name,search,items,expected){
 const got=summarize(search,items);
 for(const k of Object.keys(expected))assert.deepEqual(got[k],expected[k],name+' '+k);
 pass++;
}
for(const c of states)for(const a of states){
 const obj={from:c,providerSources:{coupang:c,adpick:a},
 providerBlocked:{coupang:c==='none',adpick:a==='none'},
 freshAnswered:[c,a].some(s=>s==='api'||s==='cache')};
 const bothFresh=[c,a].every(s=>s==='api'||s==='cache');
 check('empty '+c+'/'+a,obj,[],{
 source:c==='api'||a==='api'?'api':c==='cache'||a==='cache'?'cache':'none',
 blocked:!obj.freshAnswered&&(obj.providerBlocked.coupang||obj.providerBlocked.adpick),edgeCacheSafe:false});
 const all=[{_source:c==='none'?'stale-cache':c},{_source:a==='none'?'stale-cache':a}];
 check('mixed '+c+'/'+a,obj,all,{
 source:all.some(i=>i._source==='stale-cache')?'stale-cache':all.every(i=>i._source==='api')?'api':'cache',
 partialStale:all.some(i=>i._source==='stale-cache')&&all.some(i=>i._source==='api'||i._source==='cache'),
 edgeCacheSafe:bothFresh});
 check('fresh item '+c+'/'+a,obj,[{_source:'api'}],{source:'api',edgeCacheSafe:bothFresh});
 check('stale item '+c+'/'+a,obj,[{_source:'stale-cache'}],{source:'stale-cache',edgeCacheSafe:false});
}
check('legacy',{from:'api'},[{title:'legacy'}],{source:'api',edgeCacheSafe:true});
check('untrusted item',{from:'none',providerSources:{coupang:'api',adpick:'api'}},[{}],{source:'none',edgeCacheSafe:false});
check('partial outage',{from:'api',providerSources:{coupang:'api',adpick:'none'}},[{_source:'api'}],{source:'api',edgeCacheSafe:false});
check('ADPICK verified 0-hit',{from:'none',providerSources:{coupang:'none',adpick:'api'},freshAnswered:true,blocked:true},[],{source:'api',blocked:false});
check('old-only',{from:'stale-cache',providerSources:{coupang:'stale-cache',adpick:'none'}},[{_source:'stale-cache'}],{source:'stale-cache',edgeCacheSafe:false,partialResults:true});
check('both complete',{from:'api',providerSources:{coupang:'api',adpick:'cache'}},[{_source:'api'}],{partialResults:false});
check('one unavailable',{from:'none',providerSources:{coupang:'none',adpick:'api'}},[{_source:'api'}],{partialResults:true});
console.log('SEARCH_PROVENANCE_MATRIX',JSON.stringify({asked:pass,pass,fail:0,actualGptCalls:0,externalCalls:0,dbWrites:0}));
