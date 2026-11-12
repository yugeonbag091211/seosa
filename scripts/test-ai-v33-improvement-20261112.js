'use strict';
// Open-source fast-check property tests against the real SEOSA retrieval seam.
// Fully deterministic local fakes: no Neon, merchant API, or LLM requests.
const assert=require('node:assert/strict');
const fc=require('fast-check');
const {searchCatalog,loadProductsByIds}=require('../api/_ai-v3-catalog');

function fakeDB(rows=[]) {
  const metrics={reads:0,sortedReads:0};
  return {metrics,from(){
    const filters=[];let order=null;
    const b={
      select(){return b;},
      ilike(k,p){const part=String(p).replace(/%/g,'').toLowerCase();filters.push(x=>String(x[k]??'').toLowerCase().includes(part));return b;},
      eq(k,v){filters.push(x=>String(x[k])===String(v));return b;},
      in(k,vs){filters.push(x=>vs.map(String).includes(String(x[k])));return b;},
      not(k,operator,p){const part=String(p).replace(/%/g,'').toLowerCase();filters.push(x=>!String(x[k]??'').toLowerCase().includes(part));return b;},
      gte(k,v){filters.push(x=>Number(x[k])>=Number(v));return b;},
      lte(k,v){filters.push(x=>Number(x[k])<=Number(v));return b;},
      order(k,opts){order={key:k,desc:opts.ascending===false};return b;},
      async limit(n){
        metrics.reads++;
        const found=rows.filter(x=>filters.every(fn=>fn(x)));
        if(order){
          metrics.sortedReads++;
          found.sort((a,b)=>String(a[order.key]??'').localeCompare(String(b[order.key]??''))*(order.desc?-1:1));
        }
        return {data:found.slice(0,n),error:null};
      }
    };return b;
  }};
}
const mapRow=x=>({productId:x.product_id,title:x.title,lprice:x.lprice,mall:x.mall,link:x.link});
const makeRow=(id,price,date)=>({
 product_id:id,title:'무선 마우스',lprice:price,mall:'쿠팡',keyword:'마우스',
 collected_at:date,link:'https://example.org/item/'+id
});
function opts(db,liveSearch,maxPrice=30000){
 return {db,liveSearch,mapRow,category:'마우스',userText:'무선 마우스',
   maxPrice,searchStrategy:'live-first'};
}
async function test(name,fn){
 await fn();console.log('PASS '+name);
}
(async()=>{
 const envBefore=process.env.SEOSA_DB_READONLY;
 delete process.env.SEOSA_DB_READONLY;
 try{
   await test('recent matching catalog rows win before SQL LIMIT 40',async()=>{
     const rows=Array.from({length:60},(_,i)=>makeRow('SKU'+i,20000,new Date(Date.UTC(2026,9,1,0,i)).toISOString()));
     const db=fakeDB(rows);
     const found=await searchCatalog('무선 마우스',{...opts(db,undefined),searchStrategy:'db-first'});
     assert.equal(found.length,40);
     assert(found.some(x=>x.productId==='SKU59'),'recent row was buried by LIMIT');
     assert(!found.some(x=>x.productId==='SKU0'),'oldest row should not exhaust page');
     assert(db.metrics.sortedReads>0);
   });
   await test('displayed SKU reload keeps newest duplicate product_id',async()=>{
     const old=makeRow('same',9000,'2026-08-01T00:00:00Z');
     const recent=makeRow('same',18000,'2026-11-11T00:00:00Z');
     const db=fakeDB([old,recent]);
     const cards=await loadProductsByIds(['쿠팡:same'],{db,mapRow});
     assert.equal(cards.length,1);
     assert.equal(cards[0].lprice,18000,'follow-up used stale duplicate price');
     assert(db.metrics.sortedReads>0);
   });
   await test('fast-check: live offer may pass only within price budget',async()=>{
     let checks=0;
     await fc.assert(fc.asyncProperty(
       fc.integer({min:5000,max:50000}),
       fc.integer({min:1000,max:80000}),
       async(maxPrice,price)=>{
         let calls=0;
         const item={productId:'s1',title:'무선 마우스',lprice:price,mall:'쿠팡',
          _source:'api',link:'https://example.org/item/s1'};
         const found=await searchCatalog('무선 마우스',opts(fakeDB([]),async()=>{calls++;return {items:[item]};},maxPrice));
         checks++;
         assert.equal(calls,1);
         if(price>maxPrice)assert.equal(found.length,0);
         else {
           assert.equal(found.length,1);
           assert(found[0].lprice<=maxPrice);
           assert.equal(found[0]._source,'api');
         }
       }
     ),{numRuns:80,seed:20261112});
     assert.equal(checks,80);
   });
   await test('fast-check: unknown shipping that exceeds budget cannot pass as a deal',async()=>{
     await fc.assert(fc.asyncProperty(
       fc.integer({min:5000,max:30000}),
       fc.integer({min:1,max:6000}),
       async(maxPrice,over)=>{
         const item={productId:'s1',title:'무선 마우스',lprice:maxPrice,
          shippingFee:over,mall:'쿠팡',_source:'api',link:'https://example.org/item/s1'};
         const found=await searchCatalog('무선 마우스',opts(fakeDB([]),async()=>({items:[item]}),maxPrice));
         assert.equal(found.length,0);
       }
     ),{numRuns:80,seed:20261113});
   });
   await test('fast-check: stale-cache is never passed through as a live card',async()=>{
     await fc.assert(fc.asyncProperty(fc.integer({min:1000,max:25000}),async(price)=>{
       const item={productId:'stale',title:'무선 마우스',lprice:price,
        mall:'쿠팡',_source:'stale-cache',link:'https://example.org/item/stale'};
       await assert.rejects(
         ()=>searchCatalog('무선 마우스',opts(fakeDB([]),async()=>({items:[item]}))),
         /unavailable/i);
     }),{numRuns:40,seed:20261114});
   });
   await test('DB-first records read-only search provenance even on no-result',async()=>{
     const hitDb=fakeDB([makeRow('one',18000,'2026-11-10T00:00:00Z')]);
     const hit=await searchCatalog('무선 마우스',{...opts(hitDb,undefined),searchStrategy:'db-first'});
     assert.equal(hit._retrieval.strategy,'db-first');
     assert.equal(hit._retrieval.providerSearchBatches,0);
     assert.equal(hit._retrieval.bySource.db,hit.length);
     const noResult=await searchCatalog('무선 마우스',{...opts(fakeDB(),undefined),searchStrategy:'db-first'});
     assert.equal(noResult.length,0);
     assert(noResult._queries>0);
     assert.equal(noResult._retrieval.dbEligible,0);
   });
   console.log(JSON.stringify({passed:6,failed:0,propertyCases:200,db:'fake',providers:'stubbed'}));
 }finally{
   if(envBefore===undefined)delete process.env.SEOSA_DB_READONLY;
   else process.env.SEOSA_DB_READONLY=envBefore;
 }
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});