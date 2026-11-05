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
  assert.equal(safeTerm('갤럭시탭 S9 FE+ 128GB'),'갤럭시탭 S9 FE+ 128GB');
 });
 await test('title evidence scoring favors matching requested capacity not a claimed benefit',()=>{
  assert(evidenceScore(row('1','iPad Air M4 256GB'),'아이패드 에어 M4 256GB')
    > evidenceScore(row('2','iPad Air M4 128GB'),'아이패드 에어 M4 256GB'));
 });
 await test('conjunctive catalog lookup rescues exact variant after 40 accessories',async()=>{
  const requests=[];
  const wrong=Array.from({length:40},(_,i)=>row('case'+i,'아이패드 에어 케이스 128GB'));
  const good=row('exact','아이패드 에어 M4 256GB 태블릿');
  const source={from:()=>({select:()=>{
    const filters=[];const builder={
      ilike(column,pattern){filters.push(['ilike',column,pattern]);return builder;},
      eq(column,value){filters.push(['eq',column,value]);return builder;},
      async limit(){requests.push(filters.slice());
        if(filters.some(f=>f[1]==='keyword'&&f[2]==='%아이패드%')
          &&filters.some(f=>f[1]==='title'&&f[2]==='%256%'))
          return {data:[good],error:null};
        if(filters.length===1 && filters[0][1]==='keyword' && filters[0][2]==='%아이패드%')
          return {data:wrong,error:null};
        return {data:[],error:null};
      }
    };return builder;
  }})};
  const out=await searchCatalog('아이패드 에어 M4 256GB',{db:source,mapRow:mapper});
  assert(out.some(x=>x.productId==='exact'));
  assert.equal(out[0].productId,'exact');
  assert(requests.some(fs=>fs.length===2 && fs.some(f=>f[1]==='title'&&f[2]==='%256%')));
 });
 await test('conjunctive lookup still forbids seller-provider RPC in read-only Preview',async()=>{
  const saved=process.env.SEOSA_DB_READONLY;process.env.SEOSA_DB_READONLY='1';
  try{
    let called=false;
    const source={from:()=>({select:()=>{
      const builder={ilike(){return builder},eq(){return builder},limit:async()=>({data:[],error:null})};
      return builder;
    }})};
    const out=await searchCatalog('아이패드 에어 M4 256GB',{db:source,mapRow:mapper,
      liveSearch:async()=>{called=true;return {items:[]}}});
    assert.equal(out.length,0);assert.equal(called,false);
  }finally{if(saved===undefined)delete process.env.SEOSA_DB_READONLY;else process.env.SEOSA_DB_READONLY=saved}
 });
 await test('targeted compact S9FE search rescues base model behind FE Plus listings',async()=>{
   const wrong=Array.from({length:40},(_,i)=>row('plus'+i,'삼성 갤럭시탭 S9 FE 플러스 128GB','갤럭시탭 S9 FE'));
   const good=row('base','삼성전자 갤럭시탭S9FE 11인치 Wi-Fi 128GB SM-X510','갤럭시탭 S9 FE');
   const requests=[];
   const source={from:()=>({select:()=>{
     const filters=[];
     const builder={
       eq(c,v){filters.push([c,v,false]);return builder;},
       ilike(c,v){filters.push([c,v,true]);return builder;},
       async limit(n) {
         requests.push(filters.slice());
         const matched=[...wrong,good].filter(r=>filters.every(([column,pattern,isLike])=>
           isLike ? String(r[column]).toLowerCase().includes(pattern.slice(1,-1).toLowerCase())
                  : String(r[column])===pattern));
         return {data:matched.slice(0,n),error:null};
       }
     };
     return builder;
   }})};
   const { requestedIdentity }=require('../api/_ai-v3-identity');
   const result=await searchCatalog('갤럭시탭 S9 FE',{
     identity:requestedIdentity('갤럭시탭 S9 FE 128GB'),db:source,mapRow:mapper});
   assert.equal(result[0]?.productId,'base');
   assert(requests.some(fs=>fs.some(([c,p])=>c==='title'&&p==='%s9fe%')));
 });
 await test('price-band lookup rescues 12-15 manwon headsets outside first broad 40',async()=>{
   const requests=[];
   const low=row('low','브리츠 블루투스 헤드셋');low.lprice=109000;
   const good=row('sony','소니 WH-CH720N 블루투스 헤드폰');good.lprice=139000;
   const source={from:()=>({select:()=>{
     const filters=[];const builder={
       ilike(c,v){filters.push([c,'ilike',v]);return builder},
       eq(c,v){filters.push([c,'eq',v]);return builder},
       gte(c,v){filters.push([c,'gte',v]);return builder},
       lte(c,v){filters.push([c,'lte',v]);return builder},
       async limit(){requests.push(filters.slice());
         return {data:filters.some(([c])=>c==='lprice') &&
           filters.some(([c,op,v])=>c==='title'&&v==='%헤드폰%')?[good]:[low],error:null};
       }
     };return builder;
   }})};
   const found=await searchCatalog('헤드셋',{db:source,mapRow:mapper,
     minPrice:120000,maxPrice:150000,category:'헤드셋'});
   assert.equal(found[0].productId,'sony');
   assert(requests.some(fs=>fs.some(x=>x[0]==='lprice'&&x[1]==='gte'&&x[2]===120000)));
   assert(requests.some(fs=>fs.some(x=>x[0]==='lprice'&&x[1]==='lte'&&x[2]===150000)));
 });
 console.log(JSON.stringify({passed,failed,total:passed+failed}));
 if(failed)process.exitCode=1;
})().catch(e=>{console.error('Unexpected',e);process.exitCode=1});
