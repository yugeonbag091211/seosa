'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {review,attachToGraded}=require('./ai-v33-eval/audit-no-result');
const dir=path.join(__dirname,'../reports/ai-v33-negative-proof-20261110');
const evidence=JSON.parse(fs.readFileSync(path.join(dir,'neon-catalog-audit.json'),'utf8'));
const manifest=require('./ai-v33-eval/no-result-probes-20261110.json');
const frozen=require('./ai-v32-eval/fresh50-cases-20261110').cases;
const clone=x=>JSON.parse(JSON.stringify(x));
let passed=0,failed=0;
const test=(name,fn)=>{try{fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name+': '+e.stack)}};
test('whole Neon scan is anchored to 77,820 rows and 20 frozen cases',()=>{
 const s=review(evidence,manifest,frozen);
 assert.equal(s.catalogRows,77820);
 assert.equal(s.searchedCases,20);
 assert.equal(s.roughMatches,26);
 assert.equal(s.statusCounts.NO_BRAND_MODEL_PRICE_MATCH_IN_DB,12);
 assert.equal(s.statusCounts.ONLY_ACCESSORIES_IN_DB,8);
 assert.equal(s.catalogNegativeSupported,20);
 assert.equal(s.globallyNoSellerProven,0);
});
test('all 26 cheap named products independently classified as accessories',()=>{
 const s=review(evidence,manifest,frozen);
 assert.equal(s.items.filter(x=>x.needsReview).length,0);
 assert.equal(s.items.reduce((n,x)=>n+x.likelyAccessories,0),26);
});
test('no-result snapshot can NEVER claim global online stock absence',()=>{
 const s=review(evidence,manifest,frozen);
 assert.equal(s.globallyNoSellerProven,0);
 assert.match(s.disclaimer,/NOT prove no seller/);
});
test('candidate listing of actual K2 HE keyboard must force review',()=>{
 const e=clone(evidence),x=e.results.find(z=>z.id==='D09');
 x.matches.push({title:'키크론 K2 HE 키보드 본체 39,000원 특가',price:39000,productId:'new-keyboard',mall:'쿠팡'});
 x.roughHits++;
 const s=review(e,manifest,frozen);
 assert.equal(s.catalogNegativeSupported,19);
 assert.equal(s.items.find(z=>z.id==='D09').status,'REQUIRES_MANUAL_REVIEW');
});
test('new accessory-looking listing never inherits an older SKU approval',()=>{
 const e=clone(evidence),x=e.results.find(z=>z.id==='D09');
 x.matches[0].productId='different-unreviewed-keyboard-case-id';
 const s=review(e,manifest,frozen);
 assert.equal(s.catalogNegativeSupported,19);
 assert.equal(s.items.find(z=>z.id==='D09').needsReview,1);
});
test('changed listing title must force new review even if ID and price match',()=>{
 const e=clone(evidence),x=e.results.find(z=>z.id==='D09');
 x.matches[0].title+=' + 새 본체 키보드 포함';
 const s=review(e,manifest,frozen);
 assert.equal(s.catalogNegativeSupported,19);
});
test('incomplete evidence candidate list is rejected',()=>{
 const e=clone(evidence);e.results.find(x=>x.id==='D08').matches.pop();
 assert.throws(()=>review(e,manifest,frozen),/incomplete/);
});
test('incorrect frozen price ceiling is rejected',()=>{
 const e=clone(evidence);e.results.find(x=>x.id==='D20').cap=100000;
 assert.throws(()=>review(e,manifest,frozen),/budget mismatch/);
});
test('probe altered after capture is rejected',()=>{
 const e=clone(evidence);e.results.find(x=>x.id==='D14').modelRegex='.*';
 assert.throws(()=>review(e,manifest,frozen),/probe altered/);
});
test('duplicate case evidence is rejected',()=>{
 const e=clone(evidence);e.results[1].id=e.results[0].id;
 assert.throws(()=>review(e,manifest,frozen),/duplicate evidence ID/);
});
test('launch diagnostic UNVERIFIED labels stay UNVERIFIED',()=>{
 const original=[{id:'D01',verdict:'UNVERIFIED',outcome:'CORRECT_NO_RESULT'},
  {id:'F11',verdict:'FAIL',outcome:'MISSED_AVAILABLE'}];
 const s=review(evidence,manifest,frozen),aug=attachToGraded(original,s);
 assert.equal(aug[0].verdict,'UNVERIFIED');
 assert.equal(aug[0].negativeCatalogAudit.supported,true);
 assert.equal(aug[1].verdict,'FAIL');
 assert.equal(aug[1].negativeCatalogAudit,null);
 assert.deepEqual(original.map(x=>x.verdict),['UNVERIFIED','FAIL']);
});
test('known actual-item candidate 0 won and above ceiling cannot be used as evidence',()=>{
 const e=clone(evidence),x=e.results.find(z=>z.id==='D09');
 x.matches[0].price=90000;
 assert.throws(()=>review(e,manifest,frozen),/out-of-bound/);
});
console.log(JSON.stringify({passed,failed,total:passed+failed}));
if(failed)process.exitCode=1;
