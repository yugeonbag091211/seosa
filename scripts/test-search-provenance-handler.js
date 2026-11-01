'use strict';
const assert=require('node:assert/strict');
const Module=require('node:module');
const dbPath=require.resolve('../api/_supabase');
const fakeDb={from(){throw Error('Unexpected DB read in provenance fixture')},rpc(){throw Error('Unexpected RPC')}};
require.cache[dbPath]=Object.assign(new Module(dbPath),{filename:dbPath,id:dbPath,loaded:true,exports:fakeDb});
const shop=require('../api/_shop');
const http=require('../api/_http');
http.applyCors=()=>true;
require('../api/_ratelimit').guard=()=>true;
http.fail=(res,e,ctx)=>res.status(ctx.status||500).json({error:ctx.message});
shop.saveProducts=async()=>({saved:0});
require('../api/_trust').attachTrust=async()=>{};
require('../api/_facets').attachPriceChange=async()=>{};
let fixture={};shop.searchAll=async()=>fixture;
const handler=require('../api/search');
const product=(s,i)=>({title:'무선 이어폰 블루투스 모델 '+i,lprice:49000,oprice:49000,mall:s==='api'?'쿠팡':'ADPICK',_source:s,productId:'QATEST-'+i,link:'https://example.test/p/'+i});
const cases=[
 ['both fresh',['api','api'],['api','api'],'api',false,true],
 ['both cached',['cache','cache'],['cache','cache'],'cache',false,true],
 ['C fresh A stale',['api','stale-cache'],['api','stale-cache'],'stale-cache',true,false],
 ['C stale A fresh',['stale-cache','api'],['stale-cache','api'],'stale-cache',true,false],
 ['C failed A fresh',['none','api'],['api'],'api',false,false],
 ['C fresh A failed',['api','none'],['api'],'api',false,false],
 ['all stale',['stale-cache','stale-cache'],['stale-cache'],'stale-cache',false,false]
];
(async()=>{
 let pass=0;
 for(const [label,sources,productSources,wantSource,partial,edge] of cases){
  const items=productSources.map(product);
  fixture={items,allItems:items,from:sources[0],
   providerSources:{coupang:sources[0],adpick:sources[1]},
   providerBlocked:{coupang:sources[0]==='none',adpick:sources[1]==='none'},
   freshAnswered:sources.some(s=>s==='api'||s==='cache'),failed:false,errors:[]};
  const headers={};let status=200,body=null;
  const res={setHeader(k,v){headers[k]=v;return this;},status(n){status=n;return this;},json(x){body=x;return this;}};
  await handler({method:'GET',headers:{},query:{keyword:'무선 이어폰'}},res);
  assert.equal(status,200,label);
  assert.equal(headers['X-Seosa-Source'],wantSource,label);
  assert.equal(headers['X-Seosa-Partial-Stale']==='1',partial,label);
  assert.equal(/^public/.test(headers['Cache-Control']||''),edge,label);
  assert.ok(Array.isArray(body)&&body.length===items.length,label+' body');
  assert.ok(headers['Access-Control-Expose-Headers'].includes('X-Seosa-Partial-Stale'));
  pass++;
 }
 const front=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','public','index.html'),'utf8');
 assert.ok(front.includes("meta.partialStale = r.headers.get('X-Seosa-Partial-Stale') === '1'"));pass++;
 assert.ok(front.includes('일부 쇼핑몰의 최신 가격을 확인하지 못했어요'));pass++;
 console.log('SEARCH_PROVENANCE_HANDLER',JSON.stringify({asked:pass,pass,fail:0,externalCalls:0,dbWrites:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
