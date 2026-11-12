'use strict';
const assert=require('node:assert/strict');
const {buildProbes,modelEvidence}=require('../api/_ai-v31-retrieval');
const {parseBudget}=require('../api/_ai-v32-intent');
const {productTypeMatches}=require('../api/_ai-v31-taxonomy');
const {searchCatalog}=require('../api/_ai-v3-catalog');
let passed=0, failed=0;
async function test(name,fn){
  try{await fn();passed++;console.log('PASS '+name)}
  catch(e){failed++;console.error('FAIL '+name+': '+e.stack)}
}
function fakeDB(all){
  return {from(){
    let filters=[], desc=false;
    return {select(){return this},ilike(k,pattern){filters.push(r=>String(r[k]||'').toLowerCase().includes(pattern.toLowerCase().replace(/%/g,'')));return this},
      eq(k,s){filters.push(r=>String(r[k]||'')===String(s));return this},
      gte(k,n){filters.push(r=>Number(r[k])>=n);return this},
      lte(k,n){filters.push(r=>Number(r[k])<=n);return this},
      not(k,method,p){filters.push(r=>!String(r[k]||'').toLowerCase().includes(p.toLowerCase().replace(/%/g,'')));return this},
      order(k,{ascending}){desc=!ascending;return this},
      limit(n){const f=all.filter(r=>filters.every(fn=>fn(r))).sort((a,b)=>desc?String(b.collected_at).localeCompare(String(a.collected_at)):0).slice(0,n);return Promise.resolve({data:f,error:null})}
    };
  }};
}
const item=(id,title,date,price=12900)=>({product_id:id,vendor_item_id:'V'+id,title,keyword:'마우스',lprice:price,mall:'쿠팡',collected_at:date,link:'https://example.org/'+id});
(async()=>{
 await test('H40 first probes include synonym-based mouse facets',()=>{
  const probes=buildProbes({query:'왼손잡이 무선 마우스',category:'마우스',userText:'왼손잡이용 무선 마우스 3만원 이하',maxPrice:30000});
  for(const word of ['왼손','양손잡이','좌우대칭','양손'])
    assert(probes.some(p=>p.some(([c,v])=>c==='title'&&v==='마우스')&&p.some(([c,v])=>c==='title'&&v===word)),word);
  assert(probes.length<=12);
 });
 await test('general wireless mouse does not force extra left-hand facets',()=>{
  const probes=buildProbes({query:'무선 마우스',category:'마우스',userText:'무선 마우스 3만원 이하',maxPrice:30000});
  assert(!probes.some(p=>p.some(([,v])=>v==='양손잡이'||v==='좌우대칭')));
 });
 await test('H40 read-only catalog probes reach an older eligible ambidextrous item beyond 40 generic rows',async()=>{
  const generics=Array.from({length:70},(_,i)=>item('generic'+i,'일반 저소음 무선 마우스 추천 사무용 '+i,'2026-11-09T17:00:00Z'));
  const m170=item('M170','(국내정품) 로지텍코리아 M170 무선 마우스 좌우대칭형 휴대용 컴팩트 마우스로 양손모두사용가능/KH','2026-11-06T20:51:48Z');
  const used=item('M90','로지텍 M90 USB 유선 마우스 블랙 좌우대칭형 디자인으로 왼손잡이도 사용가능','2026-11-09T18:00:00Z',6900);
  const q='왼손잡이용 무선 마우스 3만원 이하';
  const result=await searchCatalog('왼손잡이 무선 마우스',{db:fakeDB([...generics,m170,used]),mapRow:r=>({productId:r.product_id,title:r.title,lprice:r.lprice,mall:r.mall,link:r.link}),category:'마우스',userText:q,maxPrice:30000});
  assert(result.some(x=>x.productId==='M170'),'M170 must be in candidate set');
  assert(result.length<=80);
  assert.equal(productTypeMatches(m170.title,'마우스',q),true);
  assert.equal(productTypeMatches(generics[0].title,'마우스',q),false);
 });
 await test('budget bands preserve Korean tens-of-만원 magnitude',()=>{
  for(const [q,min,max] of [
    ['무선 헤드폰 7만원대',70000,79999],
    ['중고 갤럭시워치 3만원대',30000,39999],
    ['태블릿 15만원대',150000,159999],
    ['레드미 패드 프로 30만원대',300000,399999],
    ['노트북 10만원대',100000,199999],
    ['카메라 100만원대',1000000,1999999]
  ]){const v=parseBudget(q);assert.deepEqual([v.min,v.max],[min,max],q)}
 });
 await test('explicit ceilings are unaffected by round-band parsing',()=>{
  assert.deepEqual([parseBudget('레드미 패드 프로 30만원 이하').min,parseBudget('레드미 패드 프로 30만원 이하').max],[null,300000]);
 });
 await test('H47 Pro is a distinct variant and cannot satisfy bare S8 request',()=>{
  const r=modelEvidence('로보락 S8 Pro Plus 로봇청소기','로보락 S8 로봇청소기 가격 비교');
  assert.equal(r.ok,false,JSON.stringify(r));
 });
 console.log(JSON.stringify({passed,failed,total:passed+failed}));
 if(failed)process.exitCode=1;
})();
