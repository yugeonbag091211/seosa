'use strict';
const assert = require('node:assert/strict');
const { selectFreshEvidence } = require('../api/_ai-search-evidence');
const cases = [
  ['ADPICK real empty; Coupang blocked', {items:[], from:'none', blocked:false, freshAnswered:true}, true, 0],
  ['Coupang real empty; ADPICK blocked', {items:[], from:'api', blocked:false, freshAnswered:true}, true, 0],
  ['both suppliers blocked', {items:[], from:'none', blocked:true, freshAnswered:false}, false, 0],
  ['both suppliers unavailable', {items:[], from:'none', blocked:false, freshAnswered:false}, false, 0],
  ['only stale cache', {items:[{_source:'stale-cache',title:'old'}], from:'stale-cache', freshAnswered:false}, false, 0],
  ['stale items with ADPICK fresh empty', {items:[{_source:'stale-cache',title:'old'}], from:'stale-cache', freshAnswered:true}, true, 0],
  ['ADPICK fresh items despite Coupang none', {items:[{_source:'api',title:'real'}], from:'none', freshAnswered:true}, true, 1],
  ['ADPICK fresh cache and Coupang stale', {items:[{_source:'cache',title:'real'},{_source:'stale-cache',title:'old'}],from:'stale-cache',freshAnswered:true},true,1],
  ['legacy successful empty stub', {items:[],from:'api'},true,0],
  ['legacy no response stub', {items:[],from:'none'},false,0],
  ['blocked primary but verified secondary empty', {items:[],from:'none',blocked:true,freshAnswered:true},true,0],
  ['stale-only even with unrelated active flag false', {items:[{_source:'stale-cache'}],from:'none',freshAnswered:false},false,0]
];
for(const [name,input,ok,count] of cases) {
 const got=selectFreshEvidence(input);
 assert.equal(got.ok,ok,name);
 assert.equal(got.items.length,count,name);
 if(!ok) assert.equal(got.items.length,0,'no unverified prices: '+name);
 console.log('PASS '+name);
}
console.log('AI_SEARCH_EVIDENCE_SUMMARY',JSON.stringify({pass:cases.length,fail:0,externalCalls:0,dbWrites:0}));
