'use strict';
const assert = require('node:assert/strict');
const { selectFreshEvidence } = require('../api/_ai-search-evidence');
const cases = [
  ['ADPICK real empty; Coupang blocked', {items:[], from:'none', blocked:false, freshAnswered:true,providerSources:{coupang:'none',adpick:'api'}}, false, 0],
  ['Coupang real empty; ADPICK blocked', {items:[], from:'api', blocked:false, freshAnswered:true,providerSources:{coupang:'api',adpick:'none'}}, false, 0],
  ['both suppliers blocked', {items:[], from:'none', blocked:true, freshAnswered:false}, false, 0],
  ['both suppliers unavailable', {items:[], from:'none', blocked:false, freshAnswered:false}, false, 0],
  ['only stale cache', {items:[{_source:'stale-cache',title:'old'}], from:'stale-cache', freshAnswered:false}, false, 0],
  ['stale items with ADPICK fresh empty', {items:[{_source:'stale-cache',title:'old'}], from:'stale-cache', freshAnswered:true,providerSources:{coupang:'stale-cache',adpick:'api'}}, false, 0],
  ['ADPICK fresh items despite Coupang none', {items:[{_source:'api',title:'real'}], from:'none', freshAnswered:true}, true, 1],
  ['ADPICK fresh cache and Coupang stale', {items:[{_source:'cache',title:'real'},{_source:'stale-cache',title:'old'}],from:'stale-cache',freshAnswered:true},true,1],
  ['legacy successful empty stub', {items:[],from:'api'},true,0],
  ['legacy no response stub', {items:[],from:'none'},false,0],
  ['blocked primary but verified secondary empty', {items:[],from:'none',blocked:true,freshAnswered:true,providerSources:{coupang:'none',adpick:'api'}},false,0],
  ['stale-only even with unrelated active flag false', {items:[{_source:'stale-cache'}],from:'none',freshAnswered:false},false,0],
  ['both providers verified zero results', {items:[],from:'api',freshAnswered:true,providerSources:{coupang:'api',adpick:'cache'}},true,0],
  ['one provider fresh items during peer outage', {items:[{_source:'api'}],from:'none',freshAnswered:true,providerSources:{coupang:'none',adpick:'api'}},true,1],
  ['both providers missing no results', {items:[],from:'none',freshAnswered:false,providerSources:{coupang:'none',adpick:'none'}},false,0]
];
for(const [name,input,ok,count] of cases) {
 const got=selectFreshEvidence(input);
 assert.equal(got.ok,ok,name);
 assert.equal(got.items.length,count,name);
 if(!ok) assert.equal(got.items.length,0,'no unverified prices: '+name);
 if (input.providerSources && got.ok) {
   assert.equal(got.partial, !(input.providerSources.coupang==='api'||input.providerSources.coupang==='cache')||
     !(input.providerSources.adpick==='api'||input.providerSources.adpick==='cache'), name+' partial flag');
 }
 console.log('PASS '+name);
}
console.log('AI_SEARCH_EVIDENCE_SUMMARY',JSON.stringify({pass:cases.length,fail:0,externalCalls:0,dbWrites:0}));
