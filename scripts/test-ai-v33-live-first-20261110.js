'use strict';
// These cases exercise the NON-read-only live path with injected fake suppliers (no network).
// CI (ai-v34-eval.yml) sets SEOSA_DB_READONLY=1 for the whole job, which disables live search, so
// they failed only in CI since 2026-11-12. Cases about read-only mode set the flag themselves.
delete process.env.SEOSA_DB_READONLY;
const assert=require('node:assert/strict');
const {searchCatalog}=require('../api/_ai-v3-catalog');
let passed=0,failed=0;
async function test(label,fn){try{await fn();passed++;console.log('PASS '+label)}catch(e){failed++;console.error('FAIL '+label+' '+e.stack)}}
function fakeDB(rows=[],{error=false}={}){
  const metrics={reads:0};
  const source={metrics,from(){
    let filters=[],order=null;
    const b={
      select(){return b},
      ilike(k,p){const v=String(p).toLowerCase().replace(/%/g,'');filters.push(x=>String(x[k]||'').toLowerCase().includes(v));return b},
      eq(k,v){filters.push(x=>String(x[k])===String(v));return b},
      gte(k,v){filters.push(x=>Number(x[k])>=Number(v));return b},
      lte(k,v){filters.push(x=>Number(x[k])<=Number(v));return b},
      not(k,mode,p){const v=String(p).toLowerCase().replace(/%/g,'');filters.push(x=>!String(x[k]||'').toLowerCase().includes(v));return b},
      order(k,opts){order={k,descending:opts.ascending===false};return b},
      async limit(n){metrics.reads++; if(error)return {data:null,error:{message:'read failed'}};
        const result=rows.filter(x=>filters.every(fn=>fn(x)));
        if(order?.descending)result.sort((a,b)=>String(b[order.k]||'').localeCompare(String(a[order.k]||'')));
        return {data:result.slice(0,n),error:null};
      }
    };return b;
  }};
  return source;
}
const live=(id,title,price=19000,source='api',mall='쿠팡')=>({
  productId:id,title,lprice:price,_source:source,mall,link:'https://example.org/item/'+id,shippingFee:null
});
const db=(id,title,price=19000,mall='쿠팡')=>({
  product_id:id,vendor_item_id:'',title,lprice:price,mall,
  collected_at:'2026-11-10T01:20:00Z',link:'https://example.org/item/'+id,keyword:'마우스'
});
const mapRow=r=>({productId:r.product_id,title:r.title,lprice:r.lprice,mall:r.mall,link:r.link});
const q='무선 마우스 3만원 이하',category='마우스';
const opts=(source,liveSearch,userText=q,other={})=>({
  db:source,liveSearch,mapRow,category,userText,maxPrice:30000,
  searchStrategy:'live-first',...other
});
function four(){
 return ['블랙','화이트','민트','핑크'].map((color,i)=>live('L'+i,'로지텍 무선 마우스 '+color,12000+i*1000));
}
(async()=>{
 await test('1 live 4 verified cards skips DB completely; one supplier call',async()=>{
   const source=fakeDB([db('D1','무선 마우스 DB',19000)]);
   let calls=0;
   const out=await searchCatalog('무선 마우스',opts(source,async()=>{calls++;return {items:four(),failed:false}}));
   assert.equal(calls,1);assert.equal(source.metrics.reads,0);assert.equal(out.length,4);
   assert.deepEqual(out.map(x=>x._source),['api','api','api','api']);
   assert.equal(out._queries,0);
 });
 await test('2 live 2 and DB catalog fill: freshest live SKU wins',async()=>{
   const source=fakeDB([
     db('L1','로지텍 무선 마우스 화이트',20900),
     db('D1','무선 마우스 DB 블루',17900),
     db('D2','무선 마우스 DB 레드',18000),
     db('D3','무선 마우스 DB 오버',45000),
     db('D4','무선 마우스 케이스 DB',3000)]);
   let calls=0;
   const out=await searchCatalog('무선 마우스',opts(source,async()=>{
     calls++;return {items:[live('L1','로지텍 무선 마우스 화이트',14900),live('L2','로지텍 무선 마우스 블랙',15900)]};
   }));
   assert.equal(calls,1);assert(source.metrics.reads>0);
   assert.equal(out[0].productId,'L1');assert.equal(out[0].lprice,14900);
   assert.equal(out.filter(x=>x.productId==='L1').length,1);
   assert(out.some(x=>x.productId==='D1'));assert(out.some(x=>x.productId==='D2'));
   assert(!out.some(x=>x.productId==='D3'||x.productId==='D4'));
   assert(out._queries>0);
 });
 await test('3 incompatible live seller listing never displaces valid DB match',async()=>{
   const source=fakeDB([db('match','로지텍 무선 마우스',18000)]);
   const out=await searchCatalog('로지텍 무선 마우스',opts(source,async()=>({
    items:[live('wrong','삼성 블루투스 마우스',19000)]
   }),'로지텍 무선 마우스 3만원 이하'));
   assert(out.some(x=>x.productId==='match'));
   assert(!out.some(x=>x.productId==='wrong'));
 });
 await test('4 supplier outage uses DB fallback once; no provider retry',async()=>{
   const source=fakeDB([db('good','무선 마우스 DB',21000)]);let calls=0;
   const out=await searchCatalog('무선 마우스',opts(source,async()=>{calls++;return {failed:true,items:[]}}));
   assert.equal(calls,1);assert.equal(out.length,1);assert.equal(out[0].productId,'good');
 });
 await test('5 supplier outage with no DB throws rather than claiming none exists',async()=>{
   await assert.rejects(()=>searchCatalog('무선 마우스',opts(fakeDB(),async()=>({failed:true,items:[]}))),/unavailable/i);
 });
 await test('6 supplier throws; DB fallback remains operational',async()=>{
   const out=await searchCatalog('무선 마우스',opts(fakeDB([db('good','무선 마우스',18000)]),async()=>{throw Error('rate limit')}));
   assert.equal(out[0].productId,'good');
 });
 await test('7 readonly Preview must never call provider or bypass quota lease',async()=>{
   const before=process.env.SEOSA_DB_READONLY;process.env.SEOSA_DB_READONLY='1';
   let calls=0;
   try {
     const source=fakeDB([db('ok','무선 마우스 2.4G',19000)]);
     const out=await searchCatalog('무선 마우스',opts(source,async()=>{calls++;return {items:four()}}));
     assert.equal(calls,0);assert.equal(out[0].productId,'ok');
   }finally{
     if(before===undefined)delete process.env.SEOSA_DB_READONLY;
     else process.env.SEOSA_DB_READONLY=before;
   }
 });
 await test('8 legacy DB-first mode does not change provider behavior',async()=>{
   const source=fakeDB([db('old','무선 마우스',18000)]);let calls=0;
   const out=await searchCatalog('무선 마우스',{...opts(source,async()=>{calls++;return {items:four()}}),searchStrategy:'db-first'});
   assert.equal(calls,0);assert(out.some(x=>x.productId==='old'));
 });
 await test('9 stale-cache and malicious-URL listings excluded from live pool',async()=>{
   const source=fakeDB([db('safe','무선 마우스 DB',19000)]);
   const malicious={...live('mal','무선 마우스 신형',19000),link:'javascript:alert(1)'};
   const out=await searchCatalog('무선 마우스',opts(source,async()=>({
     items:[live('stale','무선 마우스 만료된 가격',9900,'stale-cache'),malicious]
   })));
   assert.deepEqual(out.map(x=>x.productId),['safe']);
 });
 await test('10 seller-budget/variant mismatches cannot enter live candidate list',async()=>{
   const source=fakeDB();const out=await searchCatalog('무선 마우스',opts(source,async()=>({
     items:[live('over','무선 마우스 신형',59000),live('acc','무선 마우스 케이스',8000),
       live('wired','USB 유선 마우스',9000)]
   })));
   assert.equal(out.length,0);
 });
 await test('11 duplicate titles/IDs do not inflate live score',async()=>{
   const source=fakeDB([db('D','무선 마우스 DB',19000)]);
   const items=[live('one','무선 마우스 블랙'),live('two','무선 마우스 블랙'),live('one','무선 마우스 화이트')];
   const out=await searchCatalog('무선 마우스',opts(source,async()=>({items})));
   assert.equal(out.filter(x=>x._source==='api').length,1);
 });
 await test('12 source list remains provider-origin not mislabeled as fresh',async()=>{
   const source=fakeDB([db('dbrow','무선 마우스 DB',18000)]);
   const out=await searchCatalog('무선 마우스',opts(source,async()=>({items:[live('recent','무선 마우스 신형',17000,'cache')]})));
   assert.equal(out[0]._source,'cache');
   assert.equal(out.find(x=>x.productId==='dbrow')._source,'db');
 });
 await test('13 named model present in user intent rejects different model',async()=>{
   const source=fakeDB([db('right','로지텍 G304 무선 마우스',27000)]);
   const out=await searchCatalog('로지텍 마우스',opts(source,async()=>({items:[
     live('wrong','로지텍 G502 무선 마우스',29000),
     live('rightlive','로지텍 G304 무선 게이밍 마우스',28000)]}),'로지텍 G304 무선 마우스 3만원 이하'));
   assert(out.some(x=>x.productId==='rightlive'));
   assert(!out.some(x=>x.productId==='wrong'));
 });
 await test('14 DB outage preserves verified live partial result',async()=>{
   const source=fakeDB([],{error:true});
   const out=await searchCatalog('무선 마우스',opts(source,async()=>({
     items:[live('partial','무선 마우스 블랙',17000)]
   })));
   assert.equal(out.length,1);
   assert.equal(out[0].productId,'partial');
   assert(out._queries>0);
 });
 await test('15 DB and live provider both down is an error',async()=>{
   const source=fakeDB([],{error:true});
   await assert.rejects(()=>searchCatalog('무선 마우스',opts(source,async()=>({failed:true,items:[]}))),/read failed/i);
 });
 await test('16 shortened GPT keyword is enriched with only user-stated brand and model',async()=>{
   const source=fakeDB();
   let supplierTerm='',calls=0;
   await searchCatalog('무선 마우스',opts(source,async term=>{
     calls++;supplierTerm=term;return {items:[]};
   },'로지텍 G304 무선 마우스 3만원 이하'));
   assert.equal(calls,1);
   assert(supplierTerm.includes('로지텍'),supplierTerm);
   assert(supplierTerm.toLowerCase().includes('g304'),supplierTerm);
   assert(supplierTerm.includes('무선 마우스'),supplierTerm);
 });
 await test('17 seller shipping over budget and refurbished inventory rejected',async()=>{
   const source=fakeDB([db('good','무선 마우스 정상',18000)]);
   const a={...live('shipping','무선 마우스',27000),shippingFee:4000};
   const b=live('used','중고 무선 마우스 특가',12000);
   const out=await searchCatalog('무선 마우스',opts(source,async()=>({items:[a,b]})));
   assert.deepEqual(out.map(x=>x.productId),['good']);
 });
 await test('18 only expired provider cache and empty DB is unavailable, not a false inventory absence',async()=>{
   const source=fakeDB();
   await assert.rejects(()=>searchCatalog('무선 마우스',opts(source,async()=>({
     items:[live('expired','무선 마우스 2.4G',11000,'stale-cache')],failed:false
   }))),/unavailable/i);
 });
 await test('19 live-first recovers valid G304 despite DB containing wrong G502 only',async()=>{
   const source=fakeDB([db('wrong','로지텍 G502 무선 마우스',19000)]);
   let liveCalls=0;
   const supplier=async()=>{liveCalls++;return {items:[live('right','로지텍 G304 무선 마우스',18500)]}};
   const request=opts(source,supplier,'로지텍 G304 무선 마우스 3만원 이하');
   const before=await searchCatalog('로지텍 무선 마우스',{...request,searchStrategy:'db-first'});
   assert.equal(liveCalls,0);
   assert(!before.some(x=>x.title.includes('G304')));
   const after=await searchCatalog('로지텍 무선 마우스',request);
   assert.equal(liveCalls,1);
   assert(after.some(x=>x.title.includes('G304')));
   assert(!after.some(x=>x.title.includes('G502')));
 });
 await test('20 foreign/invalid Coupang affiliate links cannot reach buyer cards',async()=>{
   const source=fakeDB([db('fallback','무선 마우스 정상',18000)]);
   const fake={...live('fake','무선 마우스 유혹',17000),
     link:'https://link.coupang.com/re/AFF?lptag=NOT_SEOSA'};
   const out=await searchCatalog('무선 마우스',opts(source,async()=>({items:[fake]})));
   assert.deepEqual(out.map(x=>x.productId),['fallback']);
 });
 console.log(JSON.stringify({passed,failed,total:passed+failed}));
 if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
