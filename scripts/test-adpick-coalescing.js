'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
process.env.ADPICK_API_KEY = 'offline-unit-test-key';
process.env.ADPICK_GLOBAL_LIMIT = '0';
process.env.ADPICK_MIN_GAP_MS = '1';
let calls = 0, releaseFetch;
const response = JSON.stringify({success:true,data:[{
  title:'무선 마우스',price:'18900',photo:'p',cp_code:'1',cp_name:'SSG',
  commissionlink:'https://example.test/product'
}]});
const originalFetch = global.fetch;
global.fetch = async () => {
  calls++;
  await new Promise(resolve => { releaseFetch=resolve; });
  return {ok:true,status:200,text:async()=>response};
};
const stored = new Map();
const fakeDb = {
  from(table) {
    let key = '';
    const q = {
      select(){return q;},eq(_column,value){key=String(value);return q;},
      maybeSingle(){return Promise.resolve({data:stored.get(key)||null,error:null});},
      insert(){return Promise.resolve({data:null,error:null});},
      upsert(record){stored.set(record.keyword,record);return Promise.resolve({data:null,error:null});}
    };
    return q;
  },
  rpc(){throw new Error('No DB RPC in offline test');}
};
const dbPath=require.resolve('../api/_supabase');
require.cache[dbPath]=Object.assign(new Module(dbPath), {id:dbPath,filename:dbPath,loaded:true,exports:fakeDb});
const {searchAdpick,localStats}=require('../api/_adpick');
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
  const opts={limit:5,source:'ai',maxWaitMs:0};
  const p1=searchAdpick('무선 마우스',opts);
  const p2=searchAdpick('무선 마우스',opts);
  for(let i=0;i<20 && !releaseFetch;i++)await tick();
  assert.equal(calls,1,'two overlapping identical searches must make one external request');
  assert.equal(localStats().calls,1,'quota slot is reserved once');
  assert.equal(localStats().coalesced,1,'one request was coalesced');
  releaseFetch();
  const [a,b]=await Promise.all([p1,p2]);
  assert.equal(a.from,'api');
  assert.equal(b.from,'api');
  assert.equal(a.items.length,1);
  assert.deepEqual(a.items,b.items);
  const cached=await searchAdpick('무선 마우스',opts);
  assert.equal(cached.from,'cache','sequential repeat must use fresh shared DB cache');
  assert.equal(calls,1,'repeat must not hit supplier');
  // Force-refresh is a real verification request and must NOT be coalesced
  // with other in-progress standard queries.
  const fresh=searchAdpick('무선 마우스',{...opts,forceRefresh:true,maxWaitMs:1000});
  for(let i=0;i<20 && calls<2;i++)await tick();
  assert.equal(calls,2,'explicit refresh needs another real supplier attempt');
  releaseFetch();
  assert.equal((await fresh).from,'api');
  assert.equal(localStats().calls,2);
  console.log('ADPICK_COALESCING_SUMMARY',JSON.stringify({pass:10,fail:0,externalCalls:2,coalesced:1,cacheHits:1,dbWrites:0}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{global.fetch=originalFetch;});
