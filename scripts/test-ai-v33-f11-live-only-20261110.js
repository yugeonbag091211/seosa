'use strict';
const assert=require('node:assert/strict');
const {freshOfficialHeadphone}=require('../api/_ai-v33-official-models');
const {searchCatalog}=require('../api/_ai-v3-catalog');
const {createEngine}=require('../api/_ai-v3-core');
const {categoryOk}=require('../api/_ai-v3-core');
const TITLE='[해외] 오리지널 JBL TUNE 770NC 헤드 마운트형 블루투스 이어폰 무선 액티브 노이즈 캔슬링 음악 게임용 장거리 헤드폰';
const QUESTION='JBL TUNE 770NC 무선 헤드폰 8만원 이하';
const merchant={productId:'fresh-tune770',title:TITLE,mall:'ADPICK',link:'https://example.org/adpick/jbl770',lprice:69900,_source:'api'};
const stored={product_id:'historical-tune770',title:TITLE,mall:'ADPICK',link:'https://example.org/adpick/jbl770',lprice:50100,collected_at:'2026-09-17T23:19:57.872Z',keyword:'노이즈 캔슬링'};
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name+': '+e.stack)}}
function db(rows){
 return {from(){
  let filters=[];
  const builder={select(){return builder},ilike(k,pat){const token=String(pat).toLowerCase().replace(/%/g,'');filters.push(x=>String(x[k]||'').toLowerCase().includes(token));return builder},eq(k,v){filters.push(x=>String(x[k])===String(v));return builder},gte(k,v){filters.push(x=>x[k]>=v);return builder},lte(k,v){filters.push(x=>x[k]<=v);return builder},order(){return builder},not(k,op,pat){const token=String(pat).toLowerCase().replace(/%/g,'');filters.push(x=>!String(x[k]||'').toLowerCase().includes(token));return builder},limit(n){return Promise.resolve({data:rows.filter(x=>filters.every(f=>f(x))).slice(0,n),error:null})}};
  return builder;
 }};
}
const mapper=x=>({productId:x.product_id,title:x.title,mall:x.mall,link:x.link,lprice:x.lprice});
function searchOpts(rows,liveSearch){return {db:db(rows),mapRow:mapper,category:'헤드폰',userText:QUESTION,maxPrice:80000,liveSearch,searchStrategy:'live-first'};}
(async()=>{
 await test('official JBL TUNE 770NC mixed Korean vocabulary is a headphone ONLY for fresh provider result',()=>{
  assert(freshOfficialHeadphone({title:TITLE,requestedText:QUESTION,category:'헤드폰',source:'api'}));
  assert(freshOfficialHeadphone({title:TITLE,requestedText:QUESTION,category:'헤드폰',source:'cache'}));
  assert(!freshOfficialHeadphone({title:TITLE,requestedText:QUESTION,category:'헤드폰',source:'db'}));
 });
 await test('other JBL earbud model never inherits 770NC headphone type',()=>{
  const bad=TITLE.replace('770NC','760NC');
  assert(!freshOfficialHeadphone({title:bad,requestedText:QUESTION,category:'헤드폰',source:'api'}));
  assert(!freshOfficialHeadphone({title:TITLE,requestedText:'JBL TUNE 760NC 헤드폰',category:'헤드폰',source:'api'}));
 });
 await test('headphone accessories and earbud-only title never get an exception',()=>{
  assert(!freshOfficialHeadphone({title:TITLE+' 교체용 케이스',requestedText:QUESTION,category:'헤드폰',source:'api'}));
  assert(!freshOfficialHeadphone({title:TITLE.replace('헤드폰','이어폰'),requestedText:QUESTION,category:'헤드폰',source:'api'}));
 });
 await test('live-first supplier result with verified exact model enters catalog candidate set',async()=>{
  const out=await searchCatalog('JBL TUNE 770NC 무선 헤드폰',searchOpts([stored],async()=>({items:[merchant],failed:false})));
  assert.equal(out[0].productId,'fresh-tune770');
  assert.equal(out[0].lprice,69900);
  assert.equal(out[0]._source,'api');
  assert(!out.some(x=>x.productId==='historical-tune770'));
 });
 await test('a stale Neon-only listing is never rescued by this exception',async()=>{
  const before=process.env.SEOSA_DB_READONLY;
  process.env.SEOSA_DB_READONLY='1';
  let supplierCalls=0;
  try {
   const out=await searchCatalog('JBL TUNE 770NC 무선 헤드폰',searchOpts([stored],async()=>{supplierCalls++;return {items:[merchant]}}));
   assert.equal(supplierCalls,0);
   assert.equal(out.length,0,'historical ambiguous product must not be marketed at 50,100 won');
  } finally {if(before===undefined)delete process.env.SEOSA_DB_READONLY;else process.env.SEOSA_DB_READONLY=before;}
 });
 await test('full GPT planning/search/validation recognizes only the fresh official model',async()=>{
  const result=await createEngine({
   planModel:async()=>({mode:'recommend',category:'헤드폰',query:'JBL TUNE 770NC 무선 헤드폰'}),
   searchProducts:(query,opts)=>searchCatalog(query,{...searchOpts([stored],async()=>({items:[merchant],failed:false})),...opts,searchStrategy:'live-first'}),
   decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
  },{message:QUESTION});
  assert.equal(result.status,200);
  assert.equal(result.cards.length,1,JSON.stringify(result.stats));
  assert.equal(result.cards[0].productId,'ADPICK:fresh-tune770');
  assert.equal(result.cards[0].price,69900);
  assert.equal(result.stats.retrieval?.bySource?.api,1);
 });
 console.log(JSON.stringify({passed,failed,total:passed+failed}));
 if(failed)process.exitCode=1;
})();
