'use strict';
const assert=require('node:assert/strict');
const {createEngine}=require('../api/_ai-v3-core');
let passed=0,failed=0;
const make=(id,title,price)=>({productId:id,title,lprice:price,mall:'쿠팡',shippingFee:null,link:'https://example.org/'+id});
async function run(message,category,items){
  return createEngine({
    planModel:async()=>({mode:'recommend',query:message,category}),
    searchProducts:async()=>items,
    decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
  },{message});
}
async function test(label,fn){
  try{await fn();passed++;console.log('PASS '+label)}
  catch(e){failed++;console.error('FAIL '+label+': '+e.stack)}
}
(async()=>{
  await test('H46 full engine filters Hot+Cool and HushJet from Dyson Pure Cool query',async()=>{
    const r=await run('다이슨 공기청정기 퓨어쿨 정품','공기청정기',[
      make('hp2','[다이슨] 다이슨 공기청정기 핫앤쿨 HP2 니켈골드 국내AS',854520),
      make('hush','다이슨 허쉬젯 컴팩트 공기청정기',416010),
      make('pure','다이슨 퓨어쿨 공기청정기 정품',600000)
    ]);
    assert.deepEqual(r.cards.map(x=>x.productId),['쿠팡:pure']);
  });
  await test('H56 full engine excludes adult watches for kids watch request',async()=>{
    const r=await run('어린이 키즈폰 스마트워치 10만원 이하','시계',[
      make('adult','블라우풍트 스마트 워치, 블랙, 5cm, 블루투스',73000),
      make('adult2','DAICOO 통화가능 GPS 블루투스 스마트워치',19900),
      make('kids','어린이 키즈 스마트워치 통화 가능 GPS',85000)
    ]);
    assert.deepEqual(r.cards.map(x=>x.productId),['쿠팡:kids']);
    assert.equal(r.state.maxPrice,100000);
  });
  await test('H40 full engine excludes ungrounded handedness and uncertain option price',async()=>{
    const r=await run('왼손잡이용 무선 마우스 3만원 이하','마우스',[
      make('generic','홈플래닛 저소음 조약돌 슬림디자인 무선마우스',7290),
      make('multi','유선 무선 블루투스 직립형 왼손용 마우스',20900),
      make('ambidextrous','로지텍 M170 무선 마우스 양손잡이용',15650)
    ]);
    assert.deepEqual(r.cards.map(x=>x.productId),['쿠팡:ambidextrous']);
    assert.equal(r.state.maxPrice,30000);
  });
  await test('No verified product does not become a fabricated recommendation',async()=>{
    for(const [q,cat,t] of [
      ['다이슨 공기청정기 퓨어쿨 정품','공기청정기','다이슨 허쉬젯 공기청정기'],
      ['어린이 키즈폰 스마트워치 10만원 이하','시계','블라우풍트 스마트 워치 블루투스'],
      ['왼손잡이용 무선 마우스 3만원 이하','마우스','일반 무선 마우스 2.4G']
    ]){
      const r=await run(q,cat,[make('wrong',t,19000)]);
      assert.equal(r.cards.length,0,q);
      assert.equal(r.stats.searched,true,q);
    }
  });
  console.log(JSON.stringify({passed,failed,total:passed+failed}));
  if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
