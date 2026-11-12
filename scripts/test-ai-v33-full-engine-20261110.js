'use strict';
const assert=require('node:assert/strict');
const {createEngine}=require('../api/_ai-v3-core');
const {searchCatalog}=require('../api/_ai-v3-catalog');
const item=(id,title,price,source='api')=>({
  title,productId:id,lprice:price,mall:'쿠팡',link:'https://example.org/item/'+id,
  _source:source,shippingFee:null
});
const stored=(id,title,price)=>({
  product_id:id,title,lprice:price,mall:'쿠팡',keyword:'마우스',
  // v3.4: relative date (was '2026-11-10'); the engine's price-age gate
  // would otherwise turn this fixture stale ten days later.
  collected_at:new Date(Date.now()-86400000).toISOString(),link:'https://example.org/item/'+id
});
function catalog(rows,log){
 return {from(){
  let p=[];
  const b={
   select(){return b},
   ilike(k,v){p.push(r=>String(r[k]||'').toLowerCase().includes(String(v).toLowerCase().replace(/%/g,'')));return b},
   eq(k,v){p.push(r=>String(r[k])===String(v));return b},
   gte(k,v){p.push(r=>Number(r[k])>=Number(v));return b},
   lte(k,v){p.push(r=>Number(r[k])<=Number(v));return b},
   not(k,op,v){p.push(r=>!String(r[k]||'').toLowerCase().includes(String(v).toLowerCase().replace(/%/g,'')));return b},
   order(){return b},
   limit(n){log.reads++;return Promise.resolve({data:rows.filter(r=>p.every(f=>f(r))).slice(0,n),error:null})}
  };return b;
 }};
}
let pass=0,fail=0;
async function run(message,mode,liveItems,dbRows=[],sourceFailure=false){
 const log={calls:0,reads:0,term:''};
 const db=catalog(dbRows,log);
 const out=await createEngine({
  planModel:async()=>({mode,query:mode==='none'?'설명': '로지텍 G304 무선 마우스',category:'마우스'}),
  searchProducts:(query,opts)=>searchCatalog(query,{
   ...opts,db,searchStrategy:'live-first',
   mapRow:r=>({productId:r.product_id,title:r.title,lprice:r.lprice,mall:r.mall,link:r.link}),
   liveSearch:async term=>{log.calls++;log.term=term;return sourceFailure?{failed:true,items:[]}:{items:liveItems}}
  }),
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message});
 return {out,log};
}
async function test(name,fn){
 try{await fn();pass++;console.log('PASS '+name)}
 catch(e){fail++;console.error('FAIL '+name+' '+e.stack)}
}
(async()=>{
 await test('1 full engine shows verified provider results at the right budget',async()=>{
  const prices=[18000,19000,19900,21000];
  const live=prices.map((p,i)=>item('live'+i,'로지텍 G304 무선 마우스 '+['블랙','화이트','블루','민트'][i],p));
  const {out,log}=await run('로지텍 G304 무선 마우스 3만원 이하','recommend',live);
  assert.equal(out.status,200);
  assert.equal(log.calls,1);assert.equal(log.reads,0);
  assert.equal(out.stats.retrieval.strategy,'live-first');
  assert.equal(out.stats.retrieval.providerSearchBatches,1);
  assert.equal(out.stats.retrieval.liveEligible,4);
  assert.equal(out.stats.retrieval.dbEligible,0);
  assert.equal(out.stats.retrieval.bySource.api,4);
  assert.equal(out.cards.length,4,JSON.stringify(out.stats));
  assert(out.cards.every(c=>c.price<=30000));
  assert(out.cards.every(c=>c.title.includes('G304')));
 });
 await test('2 full engine mixes validated live and DB fallback without overriding fresh prices',async()=>{
  const {out,log}=await run('로지텍 G304 무선 마우스 3만원 이하','recommend',
   [item('same','로지텍 G304 무선 마우스 화이트',17800)],
   [stored('same','로지텍 G304 무선 마우스 화이트',22200),stored('other','로지텍 G304 무선 마우스 블루',19000)]);
  assert.equal(out.status,200);assert.equal(log.calls,1);assert(log.reads>0);
  assert.equal(out.stats.retrieval.providerSearchBatches,1);
  assert.equal(out.stats.retrieval.bySource.api,1);
  assert(out.stats.retrieval.bySource.db>=1);
  assert.equal(out.cards.find(c=>c.productId==='쿠팡:same').price,17800);
  assert(out.cards.some(c=>c.productId==='쿠팡:other'));
 });
 await test('3 full engine non-shopping questions do not spend product-provider quotas',async()=>{
  const {out,log}=await run('마우스 DPI가 무슨 뜻이야?','none',[]);
  assert.equal(out.status,200);assert.equal(log.calls,0);assert.equal(log.reads,0);
  assert.equal(out.stats.retrieval,undefined);
  assert.equal(out.cards.length,0);
 });
 await test('4 full engine protects against bogus other-model live product',async()=>{
  const {out}=await run('로지텍 G304 무선 마우스 3만원 이하','recommend',[
   item('wrong','로지텍 G502 무선 마우스',18000),
   item('case','로지텍 G304 마우스 케이스',8500)
  ]);
  assert.equal(out.status,200);assert.equal(out.cards.length,0);
 });
 await test('5 engine still serves catalog items when provider is rate-limited',async()=>{
  const {out,log}=await run('로지텍 G304 무선 마우스 3만원 이하','recommend',[],
   [stored('old','로지텍 G304 무선 마우스',25000)],true);
  assert.equal(log.calls,1);assert(out.cards.some(c=>c.productId==='쿠팡:old'));
 });
 console.log(JSON.stringify({passed:pass,failed:fail,total:pass+fail}));
 if(fail)process.exitCode=1;
})();
