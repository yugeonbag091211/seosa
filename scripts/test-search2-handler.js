'use strict';
// End-to-end search handler contract with in-memory merchant and DB stubs.
// No live API calls, database writes, pricing/affiliate mutation or cloud cost.
const assert=require('node:assert/strict');
const Module=require('node:module');
const dbPath=require.resolve('../api/_supabase');
require.cache[dbPath]=Object.assign(new Module(dbPath),{
 filename:dbPath,id:dbPath,loaded:true,exports:{
 from(){throw Error('Unexpected DB read')},rpc(){throw Error('Unexpected RPC')}
}});
const shop=require('../api/_shop');
const http=require('../api/_http');
http.applyCors=()=>true;
require('../api/_ratelimit').guard=()=>true;
http.fail=(res,e,ctx)=>res.status(ctx.status||500).json({error:ctx.message});
let writes=0,reads=0;
shop.saveProducts=async()=>{writes++;};
require('../api/_trust').attachTrust=async()=>{};
require('../api/_facets').attachPriceChange=async()=>{};
const products=[
 {title:'무선 이어폰 클립형 블루투스 A1',mall:'쿠팡',lprice:53000,oprice:53000,_source:'api',productId:'a1',link:'https://example.test/01'},
 {title:'삼성 무선 이어폰 갤럭시 버즈2',mall:'ADPICK',lprice:130000,oprice:130000,_source:'api',productId:'b2',link:'https://example.test/02'},
 {title:'무선 이어폰 이어팁 교체용 세트',mall:'ADPICK',lprice:9000,oprice:9000,_source:'api',productId:'c3',link:'https://example.test/03'},
 {title:'무선 이어폰 오픈형 Q2',mall:'쿠팡',lprice:21000,oprice:21000,_source:'api',productId:'d4',link:'https://example.test/04'}
];
shop.searchAll=async()=>({items:products.map(x=>({...x})),allItems:products.map(x=>({...x})),
 from:'api',providerSources:{coupang:'api',adpick:'api'},providerBlocked:{coupang:false,adpick:false},
 freshAnswered:true,failed:false,errors:[]});
const handler=require('../api/search');
async function call(engine){
 const headers={};let status=200,body=null;
 const res={setHeader(k,v){headers[k]=v;return this;},status(n){status=n;return this;},
 json(value){body=value;return this;}};
 await handler({method:'GET',headers:{},query:{
   keyword:'무선 이어폰',...(engine?{engine}:{})
 }},res);
 assert.equal(status,200);assert(Array.isArray(body));return {headers,body};
}
(async()=>{
 const legacy=await call(null);
 const experimental=await call('mini');
 const experimental21=await call('mini21');
 assert.equal(legacy.headers['X-Seosa-Search-Engine'],undefined);
 assert.equal(experimental.headers['X-Seosa-Search-Engine'],'mini');
 assert.equal(experimental21.headers['X-Seosa-Search-Engine'],'mini21');
 assert.equal(experimental21.body.length,legacy.body.length);
 assert.deepEqual(new Set(experimental21.body.map(x=>x.productId)),new Set(legacy.body.map(x=>x.productId)));
 assert(experimental21.body.findIndex(x=>x.productId==='c3') >
   experimental21.body.findIndex(x=>x.productId==='a1'),'ear tips must follow actual earphones');
 for(const id of legacy.body.map(x=>x.productId)){
   const before=legacy.body.find(x=>x.productId===id);
   const after=experimental21.body.find(x=>x.productId===id);
   assert.equal(after.lprice,before.lprice);
   assert.equal(after.link,before.link);
 }
 assert.equal(legacy.body.length,experimental.body.length);
 assert.deepEqual(new Set(legacy.body.map(x=>x.productId)),new Set(experimental.body.map(x=>x.productId)));
 for(const id of legacy.body.map(x=>x.productId)){
   const before=legacy.body.find(x=>x.productId===id);
   const after=experimental.body.find(x=>x.productId===id);
   assert.equal(after.lprice,before.lprice,id);
   assert.equal(after.link,before.link,id);
 }
 assert(!/^public/.test(experimental.headers['Cache-Control']||''));
 assert(!/^public/.test(experimental21.headers['Cache-Control']||''));
 assert(legacy.headers['Access-Control-Expose-Headers'].includes('X-Seosa-Search-Engine'));
 assert(experimental.headers['Access-Control-Expose-Headers'].includes('X-Seosa-Search-Engine'));
 const unknown=await call('unrecognized');
 assert.equal(unknown.headers['X-Seosa-Search-Engine'],undefined);
 assert.deepEqual(legacy.body,unknown.body);
 assert.equal(reads,0);
 assert.equal(writes,4); // One existing save path per request; Search21 causes NO extra writes.
 console.log('PASS handler default-unchanged + opt-in MiniSearch + strict fallback');
 console.log('PASS links, prices, source IDs, candidate counts, cache isolation');
 console.log('PASS no extra DB writes, no actual network calls');
})().catch(e=>{console.error(e);process.exitCode=1;});
