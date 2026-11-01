'use strict';
const assert=require('node:assert/strict');
const {summarize,categories,result,parseJsonl}=require('./report-ai-eval-clusters');
let pass=0,fail=0;
function check(label,fn){try{fn();pass++;console.log('PASS',label)}catch(e){fail++;console.error('FAIL',label,e.message)}}
const data=[
 {id:'wrong-id',ruleFailures:['UNKNOWN_PRODUCT_ID'],verdict:'FAIL'},
 {id:'wrong-price',ruleFailures:['PRICE_MISMATCH'],verdict:'FAIL'},
 {id:'wrong-cross',ruleFailures:['CROSS_PRODUCT_EVIDENCE'],verdict:'FAIL'},
 {id:'wrong-budget',ruleFailures:['BUDGET_VIOLATION'],verdict:'FAIL'},
 {id:'wrong-brand',ruleFailures:['EXCLUDED_BRAND_VIOLATION'],verdict:'FAIL'},
 {id:'wrong-history',ruleFailures:['UNSOURCED_PRICE_HISTORY'],verdict:'FAIL'},
 {id:'memory-loss',quality:{conversationConsistency:{verdict:'FAIL',reasons:['조건 소실']}},verdict:'FAIL'},
 {id:'good',quality:{accuracy:{verdict:'PASS'},naturalness:{verdict:'PASS'}},verdict:'PASS'},
 {id:'unclear'}
];
const s=summarize(data);
check('9 records, 7 failures, 1 pass, 1 unverified',()=>assert.deepEqual([s.asked,s.fail,s.pass,s.unverified],[9,7,1,1]));
check('price mismatch and cross-product group together',()=>assert.equal(s.clusters.price_spec_provenance.failures,2));
check('six critical errors independently classified',()=>assert.ok(['product_identity','price_spec_provenance','budget_constraint','exclusion_constraint','price_history'].every(k=>s.clusters[k])));
check('memory loss classified',()=>assert.equal(s.clusters.conversation_state.failures,1));
check('no raw questions or answers in output',()=>assert.ok(!JSON.stringify(s).includes('고객') && s.clusters.product_identity.caseHashes[0].length===14));
check('unknown status never becomes PASS',()=>assert.equal(result({id:'unknown'}),'UNVERIFIED'));
check('false positive label maps to human review',()=>assert.deepEqual(categories({verdict:'FAIL',errorCause:'해석 불가'}),['unclassified']));
check('invalid JSONL fails',()=>assert.throws(()=>parseJsonl('{bad json}'),/Invalid JSONL/));
check('function PASS with missing quality cannot certify answer quality',
 ()=>assert.equal(result({functionCheck:{after:'PASS'},quality:{accuracy:{verdict:'UNVERIFIED'}}}),'UNVERIFIED'));
check('full rubric PASS is accepted',()=>assert.equal(result({
 functionCheck:{after:'PASS'},quality:{accuracy:{verdict:'PASS'},naturalness:{verdict:'PASS'}}
}),'PASS'));
check('baseline before reports its independent quality failures',()=>{
 const rows=[{question:'Q1',functionCheck:{before:'PASS',after:'PASS'},
  before:{quality:{accuracy:{verdict:'FAIL',reasons:['wrong identity']}},errorCause:'상품 식별 오류'},
  quality:{accuracy:{verdict:'PASS'}}},
 {question:'Q2',functionCheck:{before:'PASS',after:'PASS'},
  before:{quality:{accuracy:{verdict:'PASS'}}},quality:{accuracy:{verdict:'PASS'}}}];
 const before=summarize(rows,'before'),after=summarize(rows,'after');
 assert.equal(before.fail,1);assert.equal(before.pass,1);
 assert.equal(after.fail,0);assert.equal(after.pass,2);
 assert.equal(before.clusters.product_identity.failures,1);
});
check('baseline without before evidence is UNVERIFIED',()=>assert.equal(result({quality:{accuracy:{verdict:'PASS'}}},'before'),'UNVERIFIED'));

console.log('CLUSTER_TEST_SUMMARY',JSON.stringify({asked:pass+fail,pass,fail,externalCalls:0,dbWrites:0}));
if(fail)process.exitCode=1;
