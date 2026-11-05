'use strict';
const assert=require('node:assert/strict');
const taxonomy=require('../api/_ai-v31-taxonomy');
const {buildProbes}=require('../api/_ai-v31-retrieval');
const {createEngine}=require('../api/_ai-v3-core');
const {searchCatalog}=require('../api/_ai-v3-catalog');
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.log('FAIL '+name+': '+String(e.message).slice(0,400))}}
const row=(id,title,lprice=133510,keyword='헤드폰')=>({
  product_id:id,productId:id,title,lprice,mall:'쿠팡',keyword,link:'https://example.org/item/'+id,
  shippingFee:0,collected_at:'2026-11-05T04:00:00Z'
});
const mapper=r=>({productId:r.product_id,title:r.title,lprice:r.lprice,
  mall:r.mall,link:r.link,shippingFee:0,category:r.keyword});
(async()=>{
await test('user product noun overrides GPT category of complete product',()=>{
 assert.equal(taxonomy.canonicalCategory({message:'에어팟 4 ANC 완제품 추천',planCategory:'완제품',query:'에어팟 4 ANC'}),'이어폰');
});
await test('user product noun overrides GPT category storage device',()=>{
 assert.equal(taxonomy.canonicalCategory({message:'1TB 외장하드. 책 말고 저장장치',planCategory:'저장장치',query:'1TB 외장하드'}),'외장하드');
});
await test('wireless earbuds and external SSD canonicalized',()=>{
 assert.equal(taxonomy.canonicalCategory({message:'무선 이어폰 추천',planCategory:'무선 이어폰'}),'이어폰');
 assert.equal(taxonomy.canonicalCategory({message:'5만원 이하 외장 SSD 추천',planCategory:'외장 SSD'}),'외장하드');
 assert.equal(taxonomy.canonicalCategory({message:'아이패드용 블루투스 키보드 추천',planCategory:'태블릿'}),'키보드');
});
await test('cross category compare is recovered from literal user subject',()=>{
 assert.deepEqual(taxonomy.comparisonFromUtterance('집에서 쓸 청소기와 공기청정기 비교'),{
  query:'청소기',compareQuery:'공기청정기',category:'청소기'
 });
});
await test('bicycle headset stem cap is not an audio headset',()=>{
 assert.equal(taxonomy.productTypeMatches('리젤디자인 헤드셋 스템 캡 탑캡','헤드폰'),false);
 assert.equal(taxonomy.productTypeMatches('Sony WH-CH720N 노이즈캔슬링 헤드폰','헤드폰'),true);
});
await test('in-ear product with misleading headphone words is not headphone',()=>{
 assert.equal(taxonomy.productTypeMatches('[해외] 오픈형 이어 클립 헤드폰 TWS 이어폰 헤드셋','헤드폰'),false);
 assert.equal(taxonomy.productTypeMatches('소니 WF-C710N 이어폰/디지털기기 헤드셋/이어폰','헤드폰'),false);
});
await test('multi-capacity external SSD cannot claim one listing price',()=>{
 const title='[해외] 외장 SSD 1TB, 4TB, 16TB, 128TB 초고속';
 assert.equal(taxonomy.ambiguousOptions(title,'외장하드'),true);
 assert.equal(taxonomy.productTypeMatches(title,'외장하드','외장 SSD'),false);
 assert.equal(taxonomy.productTypeMatches('삼성 외장 SSD T7 1TB','외장하드','외장 SSD'),true);
});
await test('capacity repeated in equivalent units is not ambiguous',()=>{
 assert.equal(taxonomy.ambiguousOptions('WD 1TB 1테라 외장하드','외장하드'),false);
});
await test('per-category retrieval probes anchor brand and named model',()=>{
 const p=buildProbes({category:'외장하드',query:'삼성 외장 SSD T7 1TB',userText:'삼성 외장 SSD T7 1TB 추천'});
 assert(p.some(filters=>filters.some(([c,t])=>c==='title'&&t==='T7')));
 assert(p.some(filters=>filters.some(([c,t])=>c==='title'&&t.includes('외장'))));
});
await test('retrieval plan includes headphone ANC and family variants',()=>{
 const p=buildProbes({category:'헤드폰',query:'ANC 헤드폰',userText:'15만원 이하 ANC 헤드폰 추천'});
 assert(p.some(x=>x.some(([,v])=>v==='노이즈')));
 const q=buildProbes({category:'태블릿',query:'아이패드 에어 M4',identity:{family:'ipad',chip:'m4',screenInches:11},userText:'11인치 아이패드 에어 M4'});
 assert(q.some(x=>x.some(([,v])=>v==='m4')&&x.some(([,v])=>v==='11')));
});
await test('catalog facets find correct product behind 40 irrelevant titles',async()=>{
 const noise=Array.from({length:40},(_,i)=>row('case'+i,'삼성 외장하드 케이스 1TB',15000,'외장하드'));
 const target=row('t7','삼성 외장 SSD T7 1TB 공식인증 정품',150000,'외장하드');
 const filtersSeen=[];
 const source={from:()=>({select:()=>{
  const filters=[],builder={
   ilike(c,v){filters.push([c,'ilike',v]);return builder},
   eq(c,v){filters.push([c,'eq',v]);return builder},
   gte(c,v){filters.push([c,'gte',v]);return builder},
   lte(c,v){filters.push([c,'lte',v]);return builder},
   limit:async n=>{
    filtersSeen.push(filters.slice());
    const candidates=filters.length>=2?[...noise,target]:noise;
    const matched=candidates.filter(r=>filters.every(([c,op,v])=>op==='ilike'
      ?String(r[c]||'').toLowerCase().includes(v.slice(1,-1).toLowerCase())
      :op==='eq'?r[c]===v:op==='gte'?r[c]>=v:r[c]<=v));
    return {data:matched.slice(0,n),error:null};
   }
  };return builder;
 }})};
 const found=await searchCatalog('삼성 외장 SSD T7 1TB',{db:source,mapRow:mapper,
  category:'외장하드',userText:'삼성 외장 SSD T7 1TB'});
 assert(found.some(x=>x.productId==='t7'));
 assert(filtersSeen.some(x=>x.length>=2));
});
await test('GPT misclassification of AirPods complete product is corrected in engine',async()=>{
 const good=row('air4','Apple 2024 에어팟 4 액티브 노이즈 캔슬링 블루투스 이어폰',172160,'이어폰');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'에어팟 4 ANC',category:'완제품'}),
  searchProducts:async()=>[good],
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 },{message:'에어팟 4 ANC 완제품 추천'});
 assert.equal(out.cards.length,1);
 assert.equal(out.state.category,'이어폰');
});
await test('GPT misclassification of external hard drive storage is corrected',async()=>{
 const good=row('wd','[WD공식스토어] WD My Passport 1TB 외장하드',145000,'외장하드');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'1TB 외장하드',category:'저장장치'}),
  searchProducts:async()=>[good],
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 },{message:'1TB 외장하드 하나 추천해줘. 책 말고 저장장치'});
 assert.equal(out.cards.length,1);
 assert.equal(out.state.category,'외장하드');
});
await test('cross-category comparison searches both sides independently',async()=>{
 const calls=[];
 const air=row('air','삼성 공기청정기 블루스카이 20평형',190000,'공기청정기');
 const vacuum=row('vac','삼성 무선 청소기 파워스틱 20V',240000,'청소기');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'',compareQuery:'',category:''}),
  searchProducts:async(query,opt)=>{calls.push({query,cat:opt.category});return opt.category==='청소기'?[vacuum]:[air]},
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'집에서 쓸 청소기와 공기청정기 비교'});
 assert.equal(out.cards.length,2);
 assert.deepEqual(calls.map(x=>x.cat),['청소기','공기청정기']);
});
await test('headset accessory and ear-clip listing fail closed before ranking',async()=>{
 const listings=[
  row('stem','자전거 헤드셋 스템 캡 탑캡',25520),
  row('earclip','오픈형 이어 클립 헤드폰 TWS 이어폰 헤드셋',14900),
  row('sony','소니 WH-CH720N 무선 헤드폰',133510)
 ];
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'헤드셋',category:'헤드셋',maxPrice:150000}),
  searchProducts:async()=>listings,
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'15만원 이하 오디오 헤드셋 추천'});
 assert.deepEqual(out.cards.map(x=>x.title),['소니 WH-CH720N 무선 헤드폰']);
});
await test('wireless headset constraint persists in budget follow-up',async()=>{
 const wired=row('wired','소니 스튜디오 모니터링 헤드폰 MDR-7506 패시브노이즈캔슬링 3.5mm단자',122540);
 const wireless=row('wireless','소니 WH-CH720N 블루투스 무선 헤드폰',139000);
 const deps={
  planModel:async()=>({mode:'recommend',query:'헤드셋',category:'헤드셋',maxPrice:150000,exclusions:['게이밍']}),
  searchProducts:async()=>[wired,wireless],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 };
 const first=await createEngine(deps,{message:'15만원 이하 무선 헤드셋 추천해줘. 게이밍 제외'});
 assert.equal(first.state.features.wireless,true);
 assert.equal(first.cards.length,1);
 const next=await createEngine(deps,{message:'그중 12만원 이상으로만 골라줘',state:first.state});
 assert.equal(next.cards.length,1);
 assert.equal(next.cards[0].title,wireless.title);
 assert.equal(next.state.features.wireless,true);
});
await test('noise cancelling requirement is backed by title, not passive marketing',()=>{
 assert.equal(taxonomy.productTypeMatches('소니 MDR-7506 패시브노이즈캔슬링 PNC 헤드폰','헤드폰','ANC'),false);
 assert.equal(taxonomy.productTypeMatches('소니 WH-CH720N ANC 무선 블루투스 헤드폰','헤드폰','무선 ANC'),true);
});
console.log(JSON.stringify({passed,failed,total:passed+failed}));
if(failed)process.exitCode=1;
})().catch(e=>{console.error('Unexpected test failure',e);process.exitCode=1});
