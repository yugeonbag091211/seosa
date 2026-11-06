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
await test('Buds FE is not Buds3 FE',()=>{
 const {requestedIdentity,checkListingIdentity,extractTitleEvidence}=require('../api/_ai-v3-identity');
 const want=requestedIdentity('갤럭시 버즈 FE');
 assert.equal(checkListingIdentity('갤럭시버즈3FE 무선 블루투스 이어폰',want).ok,false);
 assert.equal(checkListingIdentity('삼성 갤럭시 버즈 FE 무선 이어폰',want).ok,true);
 assert.equal(extractTitleEvidence('삼성 갤럭시 버즈3 프로').series,'3');
});
await test('brand named by user is never replaced by another brand',async()=>{
 const wd=row('wd','WD My Passport 2TB 외장하드',179000);
 const seagate=row('sea','씨게이트 Expansion 2TB 외장하드',199000);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'씨게이트 외장하드 2TB',category:'외장하드'}),
  searchProducts:async()=>[wd,seagate],
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 },{message:'씨게이트 외장하드 2TB 추천'});
 assert.equal(out.cards.length,1);
 assert.equal(out.cards[0].title,seagate.title);
});
await test('iPad accessory compatibility does not require keyboard to be an iPad',async()=>{
 const wrong=row('pc','무선 게이밍 키보드 마우스 세트',25000,'키보드');
 const right=row('ipadkb','아이패드 호환 블루투스 키보드',89000,'키보드');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'아이패드용 키보드',category:'태블릿'}),
  searchProducts:async()=>[wrong,right],
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 },{message:'아이패드용 블루투스 키보드 추천'});
 assert.equal(out.state.category,'키보드');
 assert.equal(out.cards.length,1);assert.equal(out.cards[0].title,right.title);
});
await test('MacBook-compatible storage searches SSD rather than laptop',async()=>{
 const good=row('ssd','삼성 외장 SSD T7 USB-C 1TB 맥북 호환',150000,'외장하드');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'맥북 연결용 외장 SSD',category:'노트북'}),
  searchProducts:async()=>[good],
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 },{message:'맥북 연결용 외장 SSD 추천'});
 assert.equal(out.state.category,'외장하드');
 assert.equal(out.cards.length,1);
});
await test('explicit gaming exclusion does not rely on model generation',async()=>{
 const bad=row('gaming','게이밍 키보드 마우스 세트',49000,'키보드');
 const good=row('office','로지텍 무선 사무용 키보드',99000,'키보드');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'사무용 키보드',category:'키보드',exclusions:[]}),
  searchProducts:async()=>[bad,good],
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 },{message:'게이밍 말고 사무용 키보드 추천'});
 assert.deepEqual(out.cards.map(x=>x.title),[good.title]);
 assert(out.state.exclusions.includes('게이밍'));
});
await test('named iPad 11 M4 screen is not silently unverified',()=>{
 const {requestedIdentity,checkListingIdentity}=require('../api/_ai-v3-identity');
 const need=requestedIdentity('11인치 아이패드 에어 M4');
 assert.equal(checkListingIdentity('Apple 아이패드 에어 11 M4 WiFi 128GB',need).ok,true);
 assert.equal(checkListingIdentity('Apple 아이패드 에어 13 M4 WiFi 128GB',need).ok,false);
});
await test('ebooks and mixed-model promotions never become verified device cards',()=>{
 assert.equal(taxonomy.productTypeMatches('아마존 킨들 이북 리더기 전자책 태블릿 11세대','태블릿'),false);
 assert.equal(taxonomy.productTypeMatches('로보락 ULTRA 청소기 Qrevo 초특가 모아보기!','청소기'),false);
 assert.equal(taxonomy.productTypeMatches('2027 나의하루 다이어리 헤드셋','헤드폰'),false);
 assert.equal(taxonomy.productTypeMatches('무선 게이밍 마우스 Astro A10 헤드셋 오버이어 헤드폰','헤드폰'),false);
});
await test('free gift keyboard attached to an iPad does not count as keyboard listing',()=>{
 assert.equal(taxonomy.productTypeMatches('[블루투스 키보드/무료증정]애플 아이패드 8세대 32GB WiFi전용','키보드','아이패드용 블루투스 키보드'),false);
 assert.equal(taxonomy.productTypeMatches('[사은품 키보드 무료증정] 삼성 갤럭시탭 S9 태블릿','키보드','무선 키보드'),false);
 assert.equal(taxonomy.productTypeMatches('아이패드 호환 블루투스 키보드 한글각인','키보드','아이패드용 블루투스 키보드'),true);
});
await test('wrist-rest and internal notebook replacement keyboard not sold as full keyboard',()=>{
 assert.equal(taxonomy.productTypeMatches('키보드손목받침대 아이리버 무선키보드마우스 블랙','키보드','사무용 키보드'),false);
 assert.equal(taxonomy.productTypeMatches('백라이트 키보드 갤럭시북 950QED 시리즈용 교체형','키보드','사무용 키보드'),false);
});
await test('Seagate 2TB device with bundled pouch is accepted, not misclassified as pouch',async()=>{
 const title='[씨게이트] 씨게이트 외장하드 2TB OneTouch 외장HDD 스페이스그레이 데이터복구+암호화+파우치 증정';
 assert.equal(taxonomy.isPart(title,'외장하드'),false);
 assert.equal(taxonomy.productTypeMatches(title,'외장하드','씨게이트 외장하드 2TB'),true);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'씨게이트 외장하드 2TB',category:'외장하드'}),
  searchProducts:async()=>[row('seagate',title,189000,'외장하드')],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'씨게이트 외장하드 2TB 추천'});
 assert.equal(out.cards.length,1);
});
await test('Bluetooth keyboard case is real keyboard but iPad gift-only listing is not',async()=>{
 const title='DUNNO 아이패드 에어 13 M4 M3 M2 블루투스 키보드 케이스';
 assert.equal(taxonomy.isPart(title,'키보드'),false);
 assert.equal(taxonomy.productTypeMatches(title,'키보드','아이패드용 블루투스 키보드'),true);
 assert.equal(taxonomy.productTypeMatches('[블루투스 키보드/무료증정]애플 아이패드 8세대 32GB WIFI','키보드','아이패드용 블루투스 키보드'),false);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'아이패드용 블루투스 키보드',category:'태블릿'}),
  searchProducts:async()=>[row('keyboard',title,34900,'키보드')],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'아이패드용 블루투스 키보드 추천'});
 assert.equal(out.cards.length,1);
});
await test('SSD-only external HDD wording persists the SSD type constraint',()=>{
 const flags=taxonomy.mergeFeatures({},'15만원 이하 외장하드 중에 SSD 추천',true);
 assert.equal(flags.externalSsd,true);
 const strictText=taxonomy.featureContext('15만원 이하 외장하드 중에 SSD 추천',flags);
 assert.equal(taxonomy.productTypeMatches('WD My Passport 2TB 외장하드','외장하드',strictText),false);
 assert.equal(taxonomy.productTypeMatches('트랜센드 휴대용 슬림 외장SSD M2 480GB','외장하드',strictText),true);
});
await test('read-only faceted lookup rescues genuine SSD after cheap cases',async()=>{
 const good=row('trueSSD','트랜센드 휴대용 슬림 외장SSD M2 480GB',126000,'외장하드');
 const decoys=Array.from({length:40},(_,i)=>row('case'+i,'외장SSD 케이스 '+i,19000,'외장하드'));
 const filtersSeen=[];
 const db={from:()=>({select:()=>{
  const filters=[],b={
   ilike(c,v){filters.push([c,'ilike',v]);return b;},
   eq(c,v){filters.push([c,'eq',v]);return b;},
   gte(c,v){filters.push([c,'gte',v]);return b;},
   lte(c,v){filters.push([c,'lte',v]);return b;},
   async limit(n){filtersSeen.push(filters.slice());
    const items=[...decoys,good].filter(r=>filters.every(([c,op,v])=>
     op==='ilike'?String(r[c]||'').toLowerCase().includes(v.slice(1,-1).toLowerCase()):
     op==='eq'?r[c]===v:op==='gte'?r[c]>=v:r[c]<=v));
    return {data:items.slice(0,n),error:null};
   }
  };return b;
 }})};
 const found=await searchCatalog('SSD 외장하드',{db,mapRow:mapper,maxPrice:150000,
   category:'외장하드',identity:{},userText:'15만원 이하 외장하드 중에 SSD 추천 외장 SSD'});
 assert(found.some(x=>x.productId==='trueSSD'));
 assert(filtersSeen.some(f=>f.some(([c,,v])=>c==='title'&&v==='%480GB%')));
});
await test('iPad-compatible Bluetooth keyboard is found behind generic 40 keyboards',async()=>{
 const title='DUNNO 아이패드 에어 13 M4 M3 M2 블루투스 키보드 케이스';
 const good=row('ipadkb',title,34900,'키보드');
 const generic=Array.from({length:40},(_,i)=>row('generic'+i,'사무용 유선 키보드 '+i,45000,'키보드'));
 const calls=[];
 const db={from:()=>({select:()=>{
  const conditions=[],b={
   ilike(c,v){conditions.push([c,'ilike',v]);return b},
   eq(c,v){conditions.push([c,'eq',v]);return b},
   async limit(n){calls.push(conditions.slice());
    const set=[...generic,good].filter(r=>conditions.every(([c,op,v])=>
      op==='ilike'?String(r[c]||'').toLowerCase().includes(v.slice(1,-1).toLowerCase()):
      r[c]===v));
    return {data:set.slice(0,n),error:null};
   }
  };return b;
 }})};
 const output=await searchCatalog('블루투스 키보드',{db,mapRow:mapper,identity:{},
   category:'키보드',userText:'아이패드용 블루투스 키보드 추천'});
 assert(output.some(x=>x.productId==='ipadkb'));
 assert(calls.some(spec=>spec.filter(([c])=>c==='title').length===3));
});
await test('contradictory Apple iPad Android tablet seller title is rejected',()=>{
 assert.equal(taxonomy.productTypeMatches(
   '[해외] 2026 오리지널 12인치 아이패드 에어 프로 5G 태블릿 안드로이드 15 24GB 램',
   '태블릿'),false);
 assert.equal(taxonomy.productTypeMatches('Apple 아이패드 에어 11 M4 WiFi 128GB','태블릿'),true);
 assert.equal(taxonomy.productTypeMatches('레노버 Idea Tab Pro Gen2 안드로이드 15 태블릿','태블릿'),true);
});
await test('compatible microSD memory card never satisfies tablet listing request',async()=>{
 const title='태블릿 호환용 Extreme 256GB MicroSDXC 카드 Galaxy Tab S9 FE 번들';
 assert.equal(taxonomy.productTypeMatches(title,'태블릿'),false);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'갤럭시탭 S9 FE 256GB',category:'태블릿'}),
  searchProducts:async()=>[row('sd',title,146900,'태블릿')],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'갤럭시탭 S9 FE 256GB 제품 추천'});
 assert.equal(out.cards.length,0);
});
await test('USB cable mentioning external SSD is not a storage drive',async()=>{
 const title='USB A to C 케이블 10피트 10Gbps 데이터 전송 Galaxy S22 iPad Pro 외장 SSD 기기';
 assert.equal(taxonomy.productTypeMatches(title,'외장하드','5만원 이하 외장 SSD 추천'),false);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'외장 SSD',category:'외장하드',maxPrice:50000}),
  searchProducts:async()=>[row('cable',title,43100,'외장하드')],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'5만원 이하 외장 SSD 추천'});
 assert.equal(out.cards.length,0);
});
await test('carrier-subsidized smartphone listing is never treated as outright retail',async()=>{
 const contract='[애플] [공통지원금] 아이폰16e 128G SK 통신사이동 완납개통 제휴카드X';
 assert.equal(taxonomy.productTypeMatches(contract,'스마트폰'),false);
 assert.equal(taxonomy.productTypeMatches('Apple 정품 아이폰 16e 128GB 자급제','스마트폰'),true);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'아이폰16e 128GB',category:'스마트폰'}),
  searchProducts:async()=>[row('offer',contract,605000,'스마트폰')],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'아이폰 16e 128GB 추천'});
 assert.equal(out.cards.length,0);
});
await test('natural Korean what-is-good shopping intent is not treated as small talk',async()=>{
 const out=await createEngine({
  planModel:async()=>({mode:'none',query:'',category:'',maxPrice:1000000}),
  searchProducts:async()=>[row('tab','샤오미 레드미 패드 2 태블릿PC WiFi 128GB',400000,'태블릿')],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'100만원 이하 태블릿 뭐가 좋아?'});
 assert.equal(out.cards.length,1);
 assert.equal(out.stats.searched,true);
});
await test('ordinary question asking what a tablet is remains nonshopping',async()=>{
 let searched=false;
 const out=await createEngine({
  planModel:async()=>({mode:'none',query:'태블릿',category:'태블릿'}),
  searchProducts:async()=>{searched=true;return []},
  decideModel:async()=>({productIds:[]})
 },{message:'태블릿이 뭐야?'});
 assert.equal(searched,false);
 assert.equal(out.stats.searched,false);
});
await test('shopping follow-up price floor survives GPT mode none and carries into final pick',async()=>{
 const cheap=row('cheap','스튜디오 유선 헤드폰 A1',110000,'헤드폰');
 const desired=row('desired','스튜디오 유선 헤드폰 B1',132000,'헤드폰');
 const gameplay=row('gaming','게이밍 블루투스 헤드폰 G1',135000,'헤드폰');
 const opts={
  planModel:async()=>({mode:'none',query:'',category:'',maxPrice:null}),
  searchProducts:async()=>[cheap,desired,gameplay],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 };
 const first=await createEngine(opts,{message:'15만원 이하 헤드폰 추천해줘, 게이밍 제외'});
 assert.equal(first.stats.searched,true);
 assert.equal(first.state.category,'헤드폰');
 assert.equal(first.state.maxPrice,150000);
 assert(first.state.exclusions.includes('게이밍'));
 const second=await createEngine(opts,{message:'그중 12만원 이상으로만 골라줘',state:first.state});
 assert.equal(second.stats.searched,true);
 assert.equal(second.state.minPrice,120000);
 assert.equal(second.state.maxPrice,150000);
 assert.deepEqual(second.cards.map(x=>x.title),[desired.title]);
 const third=await createEngine(opts,{message:'그중에서 한 개만 추천해줘',state:second.state});
 assert.equal(third.stats.searched,true);
 assert.equal(third.state.minPrice,120000);
 assert.equal(third.cards.length,1);
 assert.equal(third.cards[0].title,desired.title);
});
await test('base Galaxy S25 is never substituted with S25 Edge',()=>{
 const {requestedIdentity,checkListingIdentity}=require('../api/_ai-v3-identity');
 const wanted=requestedIdentity('갤럭시 S25 256기가 자급제');
 assert.equal(checkListingIdentity('삼성전자 갤럭시 S25 Edge 자급제 SM-S937N, 256GB',wanted).ok,false);
 assert.equal(checkListingIdentity('삼성전자 갤럭시 S25 자급제 256GB',wanted).ok,true);
});
await test('named device compatibility is not mistaken for actual keyboard category',async()=>{
 const prompt='아이패드 에어에 쓸 블루투스 키보드 케이스 5만원 이하';
 assert.equal(taxonomy.canonicalCategory({message:prompt,planCategory:'태블릿'}),'키보드');
 const good=row('ipadkeyboard','DUNNO 아이패드 에어 M4 M3 블루투스 키보드 케이스',34900,'키보드');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'아이패드 키보드',category:'태블릿',maxPrice:50000}),
  searchProducts:async()=>[good],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:prompt});
 assert.equal(out.state.category,'키보드');
 assert.equal(out.cards.length,1);
 assert.equal(out.cards[0].title,good.title);
 assert.deepEqual(out.state.identity,{});
});
await test('negated product type yields the desired replacement category',async()=>{
 const prompt='이어폰 말고 10만원 이하 오버이어 헤드폰으로 추천';
 assert.equal(taxonomy.explicitType(prompt),'헤드폰');
 const headphone=row('hp','필립스 SHP9500 유선 헤드폰',99000,'헤드폰');
 const earbud=row('buds','갤럭시 버즈 블루투스 이어폰',70000,'이어폰');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'이어폰 헤드폰',category:'이어폰'}),
  searchProducts:async()=>[headphone,earbud],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:prompt});
 assert.equal(out.state.category,'헤드폰');
 assert.equal(out.cards.length,1);
 assert.equal(out.cards[0].title,headphone.title);
});
await test('rental and compatible replacement parts cannot be sold as air purifier',()=>{
 assert.equal(taxonomy.productTypeMatches('[렌탈] 삼성 공기청정기렌탈 60개월 52100','공기청정기','원룸 공기청정기'),false);
 assert.equal(taxonomy.productTypeMatches('고효율 LG호환 퓨리케어1단형 AS181DAW 공기청정기호','공기청정기','원룸 공기청정기'),false);
 assert.equal(taxonomy.productTypeMatches('샤오미 미지아 공기청정기 5','공기청정기','원룸 공기청정기'),true);
});
await test('NAS cloning devices are not verified portable SSDs',()=>{
 assert.equal(taxonomy.productTypeMatches('NAS서버 동시 복제 HDD SSD 외장하드 스토리지 SATA3 3Bay','외장하드','외장 SSD'),false);
 assert.equal(taxonomy.productTypeMatches('트랜센드 초소형 외장SSD ESD310 256GB','외장하드','외장 SSD'),true);
});
await test('same-category comparison separates robot and stick vacuums',async()=>{
 const sentence='로보락이랑 일반 무선청소기 비교해줘';
 assert.deepEqual(taxonomy.comparisonFromUtterance(sentence),{
  query:'로보락',compareQuery:'무선청소기',category:'청소기'
 });
 const robot=row('robot','로보락 Qrevo S 로봇청소기',589000,'청소기');
 const stick=row('stick','삼성 제트 무선청소기',239000,'청소기');
 const calls=[];
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'청소기',category:'청소기'}),
  searchProducts:async(query)=>{calls.push(query);return [robot,stick]},
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:sentence});
 assert.deepEqual(calls,['로보락','무선청소기']);
 assert.equal(out.cards.length,2);
 assert(out.cards.some(x=>x.title===robot.title));
 assert(out.cards.some(x=>x.title===stick.title));
});
await test('robot-vacuum comparison rejects branded dust bags and picks actual appliances',async()=>{
 const prompt='로보락이랑 일반 무선청소기 비교해줘';
 const dust=row('dust','로보락 Q레보 S8 맥스V 울트라 로봇청소기 먼지봉투 액세서리',71100,'청소기');
 const robot=row('real','로보락 Qrevo 로봇청소기',529000,'청소기');
 const stick=row('stick','캐치웰 무선청소기 초경량 스틱 진공청소기',129000,'청소기');
 assert.equal(taxonomy.productTypeMatches(dust.title,'청소기',prompt),false);
 assert.equal(taxonomy.productTypeMatches(robot.title,'청소기',prompt),true);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'청소기',category:'청소기'}),
  searchProducts:async()=>[dust,robot,stick],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:prompt});
 assert.equal(out.cards.length,2);
 assert(out.cards.some(x=>x.title===robot.title));
 assert(out.cards.some(x=>x.title===stick.title));
 assert(!out.cards.some(x=>x.title===dust.title));
});
await test('mouse request does not include keyboard and mouse bundle as pure mouse',()=>{
 assert.equal(taxonomy.productTypeMatches('로지텍 무선 키보드 마우스 세트 MK275','마우스','무선 마우스'),false);
 assert.equal(taxonomy.productTypeMatches('로지텍 G304 무선 마우스','마우스','무선 마우스'),true);
});
await test('그중 filters ONLY previously displayed card IDs, not newly searched listings',async()=>{
 const original=row('old','브리츠 무선 블루투스 헤드폰',135000,'헤드폰');
 const newOne=row('new','소니 무선 블루투스 헤드폰',139000,'헤드폰');
 let call=0;
 const deps={
  planModel:async()=>({mode:'recommend',query:'무선 헤드폰',category:'헤드폰',maxPrice:150000}),
  searchProducts:async()=>{call++;return call===1?[original]:[original,newOne];},
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 };
 const first=await createEngine(deps,{message:'15만원 이하 무선 헤드폰 추천해줘'});
 assert.equal(first.cards.length,1);
 assert.equal(first.state.presentedProductIds.length,1);
 const next=await createEngine(deps,{message:'그중에서 12만원 이상 골라줘',state:first.state});
 assert.equal(next.state.minPrice,120000);
 assert.deepEqual(next.cards.map(x=>x.title),[original.title]);
 assert.equal(next.state.presentedProductIds.length,1);
});
await test('그중 with no matching shown cards does not invent new products',async()=>{
 const shown=row('old','브리츠 블루투스 무선 헤드폰',110000,'헤드폰');
 const unrelated=row('new','소니 블루투스 무선 헤드폰',135000,'헤드폰');
 let call=0;
 const deps={
  planModel:async()=>({mode:'none',query:'',category:''}),
  searchProducts:async()=>++call===1?[shown]:[shown,unrelated],
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 };
 const first=await createEngine(deps,{message:'15만원 이하 무선 헤드폰 추천'});
 assert.equal(first.cards.length,1);
 const next=await createEngine(deps,{message:'그중 12만원 이상으로 골라줘',state:first.state});
 assert.equal(next.stats.searched,true);
 assert.equal(next.state.minPrice,120000);
 assert.equal(next.cards.length,0);
 assert.deepEqual(next.state.presentedProductIds,[]);
 assert.match(next.answer,/앞서 보여드린 상품/);
 const third=await createEngine(deps,{message:'그중에서 한 개만 추천해줘',state:next.state});
 assert.equal(third.cards.length,0);
});
await test('user requires unlocked phone; cheap non-carrier-verified listing must fail closed',async()=>{
 const title='[삼성] 갤럭시S25 256G 정품 미개봉 새상품[이마트몰] [갤럭시S25]';
 assert.equal(taxonomy.productTypeMatches(title,'스마트폰','갤럭시 S25 256기가 자급제로 추천해줘'),false);
 const genuine='삼성전자 갤럭시 S25 256GB 자급제';
 assert.equal(taxonomy.productTypeMatches(genuine,'스마트폰','갤럭시 S25 256기가 자급제로 추천해줘'),true);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'갤럭시 S25',category:'스마트폰'}),
  searchProducts:async()=>[row('offer',title,180420,'스마트폰'),row('unlocked',genuine,959000,'스마트폰')],
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 },{message:'갤럭시 S25 256기가 자급제로 추천해줘'});
 assert.deepEqual(out.cards.map(x=>x.title),[genuine]);
});
await test('drawing pen display not returned as standalone tablet PC',async()=>{
 const pen='[공식 충청점] XPPEN 엑스피펜 ARTIST 12 3rd Pink 액정타블렛 아티스트 12 3세대 핑크 드로잉 태블릿';
 const tablet='레노버 Idea Tab Pro Gen 2 태블릿PC RAM 8GB 128GB';
 assert.equal(taxonomy.productTypeMatches(pen,'태블릿','80만원 안쪽 태블릿 하나'),false);
 assert.equal(taxonomy.productTypeMatches(tablet,'태블릿','80만원 안쪽 태블릿 하나'),true);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'태블릿',category:'태블릿',maxPrice:800000}),
  searchProducts:async()=>[row('pen',pen,341050,'태블릿'),row('tab',tablet,559000,'태블릿')],
  decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
 },{message:'80만원 안쪽으로 태블릿 하나 골라줘'});
 assert.deepEqual(out.cards.map(x=>x.title),[tablet]);
});
await test('iPad Air compatibility phrase requires evidence in keyboard listing',()=>{
 const request='아이패드 에어에 쓸 블루투스 키보드 케이스 5만원 이하';
 const vague='아이노트 블루투스 접이식키보드 X-Folding Touch Plus';
 const linked='DUNNO 아이패드 에어 M4 M3 블루투스 키보드 케이스';
 assert.equal(taxonomy.productTypeMatches(vague,'키보드',request),false);
 assert.equal(taxonomy.productTypeMatches(linked,'키보드',request),true);
});
await test('iPad Air keyboard case does not assume iPad Pro-only fit',()=>{
 const req='아이패드 에어에 쓸 블루투스 키보드 케이스 5만원 이하';
 const pro='아이패드 프로 M5 8세대 M4 7세대 11인치 공용 호환 블루투스 키보드 케이스';
 const air='DUNNO 아이패드 에어 13 M4 M3 M2 블루투스 키보드 케이스';
 assert.equal(taxonomy.productTypeMatches(pro,'키보드',req),false);
 assert.equal(taxonomy.productTypeMatches(air,'키보드',req),true);
});
await test('explicitly exclude mixed-capacity listings with unknown capacity price',()=>{
 const req='15만원 이하 포터블 SSD, 용량 여러개 섞인 판매글 빼고';
 assert.equal(taxonomy.productTypeMatches('샌디스크 외장 SSD E31 대용량 포터블 스토리지','외장하드',req),false);
 assert.equal(taxonomy.productTypeMatches('트랜센드 외장SSD ESD310 + 파우치 세트 256GB','외장하드',req),true);
});
await test('short Galaxy Buds 3 Pro user name enforces exact Samsung product',async()=>{
 const {requestedIdentity,checkListingIdentity}=require('../api/_ai-v3-identity');
 const want=requestedIdentity('버즈3 프로 정품 이어폰');
 assert.equal(want.family,'galaxybuds');
 assert.equal(want.series,'3');
 assert.equal(want.variant,'pro');
 assert.equal(checkListingIdentity('삼성 갤럭시 버즈3 프로 무선 이어폰',want).ok,true);
 assert.equal(checkListingIdentity('리얼미 버즈 에어8 프로 이어폰',want).ok,false);
 const promo='갤럭시 버즈3 프로 오른쪽 한쪽 낱개 유닛 정품 단품 이어폰';
 assert.equal(taxonomy.productTypeMatches(promo,'이어폰'),false);
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'버즈3 프로',category:'이어폰',maxPrice:120000}),
  searchProducts:async()=>[row('unit',promo,81000,'이어폰'),row('realme','리얼미 버즈 에어8 프로 이어폰',90000,'이어폰')],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'버즈3 프로 정품 이어폰 12만원 이하로 찾아줘'});
 assert.equal(out.cards.length,0);
});
await test('iPad Air 11 M4 is compatibility target not a Bluetooth keyboard identity',async()=>{
 const prompt='아이패드 에어 11인치 M4에 맞는 블루투스 키보드 6만원 이하';
 assert.equal(taxonomy.explicitType(prompt),'키보드');
 const good=row('keyboard','아이패드 에어 11 M4 호환 블루투스 키보드',55000,'키보드');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'아이패드 에어 M4 키보드',category:'태블릿',maxPrice:60000}),
  searchProducts:async()=>[good],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:prompt});
 assert.equal(out.state.category,'키보드');
 assert.deepEqual(out.state.identity,{});
 assert.equal(out.cards.length,1);
});
await test('MacBook target does not erase requested SSD storage capacity',async()=>{
 const prompt='맥북에 연결할 외장 SSD 512기가 15만원 이하로 추천';
 assert.equal(taxonomy.explicitType(prompt),'외장하드');
 const good=row('ssd','삼성 외장 SSD 512GB 맥북 호환',120000,'외장하드');
 const laptop=row('book','맥북 M4 512GB 노트북',100000,'노트북');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'맥북 SSD',category:'노트북',maxPrice:150000}),
  searchProducts:async()=>[good,laptop],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:prompt});
 assert.equal(out.state.category,'외장하드');
 assert.deepEqual(out.state.identity,{storageGb:512});
 assert.deepEqual(out.cards.map(c=>c.title),[good.title]);
});
await test('over-ear headphone excludes wireless stage microphone and mono headset',()=>{
 assert.equal(taxonomy.productTypeMatches('UHF 무선 헤드셋 마이크 무대 공연 강의용','헤드폰','오버이어 헤드셋'),false);
 assert.equal(taxonomy.productTypeMatches('브리츠 블루투스 모노 헤드셋 핸즈프리','헤드폰','오버이어 헤드셋'),false);
 assert.equal(taxonomy.productTypeMatches('브리츠 무선 블루투스 오버이어 헤드폰','헤드폰','오버이어 헤드셋'),true);
});
await test('robot vacuum furniture not counted as a vacuum',()=>{
 assert.equal(taxonomy.productTypeMatches('로봇청소기 팬트리 거실 수납장 800','청소기','로봇청소기'),false);
 assert.equal(taxonomy.productTypeMatches('스마트 로봇청소기 자동충전','청소기','로봇청소기'),true);
});
await test('used laptop random assortment is not a priced exact item',()=>{
 assert.equal(taxonomy.productTypeMatches('LG HP 레노버 중고 노트북 1~3세대모음 랜덤발송','노트북','중고 노트북'),false);
 assert.equal(taxonomy.productTypeMatches('HP Elite X2 1012 G2 중고 노트북 8GB 256GB','노트북','중고 노트북'),true);
});
await test('standalone Logitech keyboard excludes bundled mouse sets',async()=>{
 const good=row('single','로지텍 무선 키보드 K580 정품',89000,'키보드');
 const bad=row('bundle','로지텍 무선 키보드 마우스 세트 MK275',39000,'키보드');
 const out=await createEngine({
  planModel:async()=>({mode:'recommend',query:'로지텍 무선 키보드',category:'키보드'}),
  searchProducts:async()=>[good,bad],
  decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
 },{message:'로지텍 무선 키보드 단품만 추천, 마우스 결합 세트 제외'});
 assert.deepEqual(out.cards.map(x=>x.title),[good.title]);
});
await test('matched iPad Air 11 M4 keyboard case not replaced with Pro 11 or Air 13',()=>{
 const prompt='아이패드 에어 11인치 M4에 맞는 블루투스 키보드 6만원 이하';
 assert.equal(taxonomy.productTypeMatches(
  '아이패드 프로 M5 8세대 M4 7세대 11인치 호환 블루투스 키보드 케이스','키보드',prompt),false);
 assert.equal(taxonomy.productTypeMatches(
  'DUNNO 아이패드 에어 13 M4 M3 M2 블루투스 키보드 케이스','키보드',prompt),false);
 assert.equal(taxonomy.productTypeMatches(
  '아이패드 에어 프로 펜슬 수납 블루투스 키보드 케이스','키보드',prompt),false);
 assert.equal(taxonomy.productTypeMatches(
  '아이패드 에어 11 M4 블루투스 키보드 케이스','키보드',prompt),true);
});
await test('AirPods and Galaxy Buds separate spare single units from two-ear set',()=>{
 assert.equal(taxonomy.productTypeMatches('삼성전자 갤럭시 버즈3프로 유닛 정품 낱개 단품','이어폰'),false);
 assert.equal(taxonomy.productTypeMatches('삼성전자 갤럭시 버즈3프로 개별 낱개 단품','이어폰'),false);
 assert.equal(taxonomy.productTypeMatches('삼성전자 갤럭시 버즈3프로 블루투스 이어폰 본체 세트','이어폰'),true);
});
console.log(JSON.stringify({passed,failed,total:passed+failed}));
if(failed)process.exitCode=1;
})().catch(e=>{console.error('Unexpected test failure',e);process.exitCode=1});
