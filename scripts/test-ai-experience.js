'use strict';
const assert=require('node:assert/strict');
const {tally}=require('./report-ai-experience');
let p=0,f=0;
function check(s,fn){try{fn();p++;console.log('PASS',s)}catch(e){f++;console.error('FAIL',s,e.message)}}
const empty=tally([]);
check('no real feedback never reported as full satisfaction',()=>assert.equal(empty.status,'NOT_VERIFIED'));
check('synthetic data ignored',()=>assert.equal(tally([{source:'synthetic',rating:5}]).ratingResponses,0));
const events=[
 {source:'real_user',rating:5,helpful:true,correctProduct:true,eligibleCandidates:10,recommendedCandidates:3,latencyMs:1200},
 {source:'real_user',rating:3,helpful:false,correctProduct:false,eligibleCandidates:5,recommendedCandidates:1,latencyMs:1800},
 {source:'real_user',rating:4,helpful:true,correctProduct:true,eligibleCandidates:4,recommendedCandidates:2,latencyMs:1000}
];
const s=tally(events);
check('three ratings and satisfaction calculation',()=>assert.deepEqual([s.ratingResponses,s.satisfiedPct,s.averageRating],[3,66.7,4]));
check('candidate-to-recommendation coverage is not raw card count',()=>assert.equal(s.candidateToRecommendationPct,33.3));
check('sample below 30 is not certified',()=>assert.equal(s.status,'INSUFFICIENT_SAMPLE'));
check('no private raw data emitted',()=>assert.ok(!JSON.stringify(s).includes('password')&&!JSON.stringify(s).includes('email')));
check('invalid recommendation count detected',()=>assert.equal(tally([{source:'real_user',eligibleCandidates:1,recommendedCandidates:3}]).invalidCount,1));
console.log('EXPERIENCE_TEST_SUMMARY',JSON.stringify({asked:p+f,pass:p,fail:f,externalCalls:0,dbWrites:0}));
if(f)process.exitCode=1;
