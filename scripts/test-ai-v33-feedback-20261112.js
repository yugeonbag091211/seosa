'use strict';
const assert=require('node:assert/strict');
const fc=require('fast-check');
const {normalizeEvidence,summarizeEvidence}=require('./ai-v33-eval/feedback-evidence');
let passed=0;
async function test(label,fn){await fn();passed++;console.log('PASS '+label);}
(async()=>{
  const response={
    id:'N011',question:'PRIVATE RAW QUERY 123',answer:'PRIVATE RESPONSE',
    cards:[{title:'PRIVATE PRODUCT',productId:'SECRET'}],
    http:200,elapsedMs:1550,stats:{
      dbQueries:4,retrieval:{strategy:'db-first',bySource:{db:2},providerSearchBatches:0},
      rejectedReasons:{wrong_model:1},modelUsage:{calls:2,inputTokens:123,outputTokens:456}
    }
  };
  await test('never export raw queries, answers, card titles or product IDs',()=>{
    const e=normalizeEvidence(response);
    const str=JSON.stringify(e);
    assert(!str.includes('PRIVATE'));assert(!str.includes('SECRET'));
    assert.equal(e.displayedCards,1);assert.equal(e.bySource.db,2);
    assert.equal(e.dbQueries,4);
  });
  await test('no independently reviewed oracle means UNVERIFIED (not PASS)',()=>{
    const e=normalizeEvidence(response,{verdict:'PASS',reviewed:false});
    assert.equal(e.verdict,'UNVERIFIED');
    assert.equal(summarizeEvidence([e]).strictPassOnlyPercent,0);
    assert.equal(e.costUsd,null);
  });
  await test('only reviewed independent oracle labels can produce PASS',()=>{
    const e=normalizeEvidence(response,{id:'N011',verdict:'PASS',reviewed:true,costUsd:0.0003});
    const s=summarizeEvidence([e]);
    assert.equal(s.pass,1);assert.equal(s.strictPassOnlyPercent,100);
    assert.equal(s.costMeasuredCases,1);assert.equal(s.measuredCostUsd,0.0003);
  });
  await test('cannot silently mix mismatched or duplicate oracle IDs',()=>{
    assert.throws(()=>normalizeEvidence(response,{id:'N022',verdict:'PASS',reviewed:true}),/mismatch/i);
    const e=normalizeEvidence(response);
    assert.throws(()=>summarizeEvidence([e,e]),/Duplicate/i);
  });
  await test('fast-check: every UNVERIFIED reduces strict PASS_ONLY denominator',async()=>{
    await fc.assert(fc.property(fc.array(fc.constantFrom('PASS','FAIL','UNVERIFIED'),{minLength:1,maxLength:70}),grades=>{
      const cases=grades.map((verdict,i)=>normalizeEvidence({id:'T'+i},{id:'T'+i,verdict,reviewed:true}));
      const metrics=summarizeEvidence(cases);
      const expected=Number((100*grades.filter(x=>x==='PASS').length/grades.length).toFixed(2));
      assert.equal(metrics.strictPassOnlyPercent,expected);
      assert.equal(metrics.total,grades.length);
    }),{numRuns:100,seed:20261112});
  });
  console.log(JSON.stringify({passed,failed:0,propertyCases:100,onlineCalls:0}));
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});