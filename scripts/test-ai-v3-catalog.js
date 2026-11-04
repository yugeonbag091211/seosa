'use strict';
const assert=require('node:assert/strict');
const {searchCatalog,safeTerm,primaryAnchor,evidenceScore}=require('../api/_ai-v3-catalog');
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.log('FAIL '+name+': '+e.message)}}
const row=(id,title,keyword='아이패드')=>({product_id:id,title,keyword,mall:'쿠팡',lprice:450000,
  link:'https://example.com/'+id,collected_at:'2026-11-03T10:00:00.000Z'});
function mockDB(rules,events){
  return {from(name){assert.equal(name,'products');return {select(cols){
    assert.equal(cols,'*');return {
      eq(col,val){return {limit:async n=>{events.push(['eq',col,val,n]);return {data:(rules('eq',col,val)||[]),error:null}}}},
      ilike(col,val){return {limit:async n=>{events.push(['ilike',col,val,n]);return {data:(rules('ilike',col,val)||[]),error:null}}}}
    };
  }}}};
}
const mapper=r=>({productId:r.product_id,title:r.title,lprice:r.lprice,mall:r.mall,link:r.link});
(async()=>{
 await test('exact title search avoids redundant anchor queries',async()=>{
  const events=[];
  const res=await searchCatalog('아이패드',{db:mockDB((m,c,v)=>m==='ilike'&&c==='title'?[row('1','아이패드 에어 M4 256GB')]:[],events),
    mapRow:mapper,liveSearch:async()=>{throw Error('provider should not be used')}});
  assert.equal(res.length,1);assert.equal(events.length,1);
  assert.equal(res[0].productId,'1');
 });
 await test('long query falls back to read-only DB keyword and title anchors',async()=>{
  const events=[];
  const res=await searchCatalog('아이패드 에어 M4 256GB',{db:mockDB((m,c,v)=>{
    if(m==='ilike'&&c==='keyword'&&v==='%아이패드%')return [
      row('1','아이패드 에어 M4 128GB'),row('2','아이패드 에어 M4 256GB')];
    if(m==='ilike'&&c==='title'&&v==='%아이패드%')return [
      row('2','아이패드 에어 M4 256GB'),row('3','아이패드 프로 128GB')];
    return [];
  },events),mapRow:mapper});
  assert.equal(events.length,4);
  assert.equal(res.length,3);
  assert.equal(res[0].productId,'2'); // correct capacity is ranked first
  assert.equal(res.filter(x=>x.productId==='2').length,1);
 });
 await test('read only Preview suppresses merchant fallback',async()=>{
  const saved=process.env.SEOSA_DB_READONLY;
  process.env.SEOSA_DB_READONLY='1';
  try{
    let calls=0;
    const res=await searchCatalog('찾을 수 없는 상품',{db:mockDB(()=>[],[]),mapRow:mapper,
      liveSearch:async()=>{calls++;return {items:[row('1','상품')]}}});
    assert.equal(res.length,0);assert.equal(calls,0);
  }finally{if(saved===undefined)delete process.env.SEOSA_DB_READONLY;else process.env.SEOSA_DB_READONLY=saved}
 });
 await test('read only DB still returns anchored products without merchant API',async()=>{
  const saved=process.env.SEOSA_DB_READONLY;process.env.SEOSA_DB_READONLY='1';
  try{
    const res=await searchCatalog('아이패드 에어 M4 256GB',{db:mockDB((m,c,v)=>
      m==='ilike'&&c==='keyword'&&v==='%아이패드%'?[row('1','아이패드 에어 M4 256GB')]:[],[]),
      mapRow:mapper,liveSearch:async()=>{throw Error('must not invoke')}});
    assert.equal(res.length,1);
  }finally{if(saved===undefined)delete process.env.SEOSA_DB_READONLY;else process.env.SEOSA_DB_READONLY=saved}
 });
 await test('non-read-only catalog miss may fall back through existing provider',async()=>{
  const saved=process.env.SEOSA_DB_READONLY;delete process.env.SEOSA_DB_READONLY;
  try{
    let count=0;
    const res=await searchCatalog('노트북',{db:mockDB(()=>[],[]),mapRow:mapper,liveSearch:async()=>{count++;return {items:[{productId:'p',title:'그램 노트북'}]}}});
    assert.equal(count,1);assert.equal(res.length,1);
  }finally{if(saved!==undefined)process.env.SEOSA_DB_READONLY=saved}
 });
 await test('database errors fail closed and do not call a seller provider',async()=>{
  let called=false;
  const db={from(){return {select(){return {ilike(){return {limit:async()=>({error:{message:'test'},data:[]})}}}}}}};
  await assert.rejects(()=>searchCatalog('아이패드',{db,liveSearch:async()=>{called=true}}),/Catalog read failed/);
  assert.equal(called,false);
 });
 await test('distinct merchant option identities are not incorrectly deduplicated',async()=>{
  const a={...row('1','아이패드 에어 256GB'),vendor_item_id:'opt1'};
  const b={...row('1','아이패드 에어 256GB'),vendor_item_id:'opt2'};
  const res=await searchCatalog('아이패드',{db:mockDB((m,c)=>m==='ilike'&&c==='title'?[a,b]:[],[]),
    mapRow:mapper});
  assert.equal(res.length,2);
 });
 await test('sanitized query strips unsafe wildcard syntax before ILIKE',()=>{
  assert.equal(safeTerm('%아이패드_에어! 256GB'), '아이패드 에어 256GB');
  assert.equal(primaryAnchor('아이폰16 128GB'),'아이폰');
 });
 await test('title evidence scoring favors matching requested capacity not a claimed benefit',()=>{
  assert(evidenceScore(row('1','iPad Air M4 256GB'),'아이패드 에어 M4 256GB')
    > evidenceScore(row('2','iPad Air M4 128GB'),'아이패드 에어 M4 256GB'));
 });
 console.log(JSON.stringify({passed,failed,total:passed+failed}));
 if(failed)process.exitCode=1;
})().catch(e=>{console.error('Unexpected',e);process.exitCode=1});
