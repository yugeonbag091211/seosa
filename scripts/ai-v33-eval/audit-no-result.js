'use strict';
// Catalog-wide title/price evidence audit of frozen NO_RESULT prompts.
// This does NOT certify that no live merchant sells the item.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const patterns={
  D02:/수신기|동글|어댑터/i,
  D04:/전원\s*공급|충전기|어댑터/i,
  D08:/필터|호환용|물걸레|브러쉬|브러시|더스트백|소모품|액세서리/i,
  D09:/키보드\s*케이스|휴대용\s*가방/i,
  D14:/충전\s*플렉스|충전\s*포트|케이블/i,
  D15:/이어팁|케이스|키캡/i,
  D16:/실리콘\s*케이스|핸드폰\s*커버|충전기|크래들/i,
  D18:/케이스|보호필름/i
};
function review(audit,manifest,frozen,reviewed=require('./catalog-accessory-review-20261110.json')){
  assert(Array.isArray(audit.results)&&audit.results.length===20,'20 audited cases required');
  assert(Array.isArray(manifest.criteria)&&manifest.criteria.length===20,'20 immutable audit probes required');
  assert(Number.isSafeInteger(audit.scannedRows)&&audit.scannedRows>=1,'catalog scan row count');
  assert(Number.isFinite(Date.parse(audit.queriedAt)),'query timestamp missing');
  assert(reviewed.scopedToQueryAt===audit.queriedAt,'accessory review applies to a different snapshot');
  assert(Array.isArray(reviewed.rows),'reviewed accessory records are required');
  const reviewById=new Map(reviewed.rows.map(x=>[x.caseId+':'+x.productId,x]));
  assert(reviewById.size===reviewed.rows.length,'duplicate reviewed listing');
  const specById=new Map(manifest.criteria.map(x=>[x.id,x]));
  const caseById=new Map(frozen.map(x=>[x.id,x]));
  const ids=new Set(),items=[];
  for(const entry of audit.results){
    assert(/^D(?:0[1-9]|1\d|20)$/.test(entry.id),'unexpected evidence ID '+entry.id);
    assert(!ids.has(entry.id),'duplicate evidence ID '+entry.id);
    ids.add(entry.id);
    const spec=specById.get(entry.id),original=caseById.get(entry.id);
    assert(spec&&original,'unknown frozen case '+entry.id);
    assert(original.max===spec.cap&&entry.cap===original.max,'budget mismatch '+entry.id);
    for(const [snapshotKey,sourceKey] of [
      ['brandRegex','brandPattern'],['modelRegex','modelPattern'],['otherRegex','otherPattern']]){
      assert(entry[snapshotKey]===spec[sourceKey],'probe altered '+entry.id+' '+snapshotKey);
    }
    assert(Array.isArray(entry.matches)&&entry.roughHits===entry.matches.length,'incomplete matched rows '+entry.id);
    const detail=entry.matches.map(product=>{
      assert(product && typeof product.title==='string' && product.title.trim(),'missing product title');
      assert(Number.isSafeInteger(product.price)&&product.price>0 && product.price<=entry.cap,
        'out-of-bound evidence '+entry.id);
      assert(typeof product.productId==='string'&&product.productId,'incomplete product ID');
      // Only an exact title/price/product-ID record in this *particular*
      // inspected snapshot is approved as an accessory. A NEW listing,
      // even if it contains 'case' or 'filter', must be inspected again.
      const rule=patterns[entry.id];
      const approved=reviewById.get(entry.id+':'+product.productId);
      const isKnownAccessory=!!(approved && approved.title===product.title && approved.price===product.price &&
        approved.reason && rule && rule.test(product.title));
      const explanation=isKnownAccessory?'accessory_or_compatibility_listing':'requires_manual_product_review';
      return {productId:product.productId,title:product.title,price:product.price,reason:explanation};
    });
    const needsReview=detail.filter(x=>x.reason==='requires_manual_product_review');
    const status=needsReview.length?'REQUIRES_MANUAL_REVIEW':
      !detail.length?'NO_BRAND_MODEL_PRICE_MATCH_IN_DB':'ONLY_ACCESSORIES_IN_DB';
    items.push({id:entry.id,budget:entry.cap,titleMatches:detail.length,
      likelyAccessories:detail.length-needsReview.length,needsReview:needsReview.length,
      status,details:detail});
  }
  assert(items.length===20);
  const statusCounts=items.reduce((acc,x)=>(acc[x.status]=(acc[x.status]||0)+1,acc),{});
  return {
    scope:'NEON_PRODUCTS_TITLE_AND_BUDGET_REGEX_SNAPSHOT',
    catalogRows:audit.scannedRows,queriedAt:audit.queriedAt,
    searchedCases:items.length,roughMatches:items.reduce((s,x)=>s+x.titleMatches,0),
    statusCounts,
    catalogNegativeSupported:items.filter(x=>x.status!=='REQUIRES_MANUAL_REVIEW').length,
    globallyNoSellerProven:0,
    disclaimer:'A complete scoped catalog title/price scan does NOT prove no seller inventory worldwide, no unseen synonym, or a current checkout price.',
    items
  };
}
function attachToGraded(graded,proof){
 const index=new Map(proof.items.map(x=>[x.id,x]));
 return graded.map(row=>({...row,
    negativeCatalogAudit:index.has(row.id)?{
      status:index.get(row.id).status,
      supported:index.get(row.id).status!=='REQUIRES_MANUAL_REVIEW',
      scope:proof.scope,titleMatches:index.get(row.id).titleMatches
    }:null
 }));
}
if(require.main===module){
 const dirname=path.join(__dirname,'../../reports/ai-v33-negative-proof-20261110');
 const audit=JSON.parse(fs.readFileSync(path.join(dirname,'neon-catalog-audit.json'),'utf8'));
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'no-result-probes-20261110.json'),'utf8'));
 const frozen=require('../ai-v32-eval/fresh50-cases-20261110').cases;
 const result=review(audit,manifest,frozen);
 const src=path.join(__dirname,'../../reports/ai-v33-online50-readonly-graded-20261110.jsonl');
 const graded=fs.existsSync(src)?fs.readFileSync(src,'utf8').trim().split(/\r?\n/).map(JSON.parse):[];
 if(graded.length){
   assert(graded.length===50,'Original 50-case diagnostic must be complete');
   // STRICT user's scoring policy unchanged: UNVERIFIED is still a release failure.
   const originalCounts=graded.reduce((a,x)=>(a[x.verdict]=(a[x.verdict]||0)+1,a),{});
   assert.deepEqual(originalCounts,{PASS:29,FAIL:1,UNVERIFIED:20});
   result.launchGateFrozen={passed:29,failed:21,successRatePercent:58};
   const catalogOnlySupported=graded.filter(x=>x.verdict==='PASS').length+result.catalogNegativeSupported;
   result.catalogScopedDiagnostic={supported:catalogOnlySupported,total:50,
     ratePercent:100*catalogOnlySupported/50,
     releaseKpiUnchanged:true,marketplaceInventoryUnverified:true,
     caveat:'Post-hoc catalog-only analysis of development-used queries, not independent AI live merchant accuracy.'};
   const augmented=attachToGraded(graded,result);
   assert.deepEqual(augmented.map(x=>x.verdict),graded.map(x=>x.verdict));
   fs.writeFileSync(path.join(dirname,'catalog-audit-graded.jsonl'),augmented.map(JSON.stringify).join('\n')+'\n');
 }
 fs.writeFileSync(path.join(dirname,'catalog-audit-summary.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({cases:result.searchedCases,scanned:result.catalogRows,candidates:result.roughMatches,catalogNegativeSupported:result.catalogNegativeSupported,globalStockProven:0,statuses:result.statusCounts,releaseKpi:result.launchGateFrozen||null}));
}
module.exports={review,attachToGraded};
