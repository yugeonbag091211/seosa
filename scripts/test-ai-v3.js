'use strict';
const assert = require('node:assert/strict');
const core = require('../api/_ai-v3-core');
const { PLAN_SCHEMA, DECIDE_SCHEMA, makeOpenAiAdapter } = require('../api/_ai-v3-openai');
const { _handler } = require('../api/ai-v3');
const items = [
  { productId: 'lap1', title: 'LG 그램 노트북 15인치', lprice: 720000, shippingFee: 0, mall: '쿠팡', link: 'https://example.com/lap1', _source: 'api' },
  { productId: 'lap2', title: 'LG 그램 노트북 충전기', lprice: 25000, shippingFee: 0, mall: '쿠팡', link: 'https://example.com/lap2', _source: 'api' },
  { productId: 'lap3', title: 'LG 그램 노트북 16인치', lprice: 810000, shippingFee: 0, mall: '쿠팡', link: 'https://example.com/lap3', _source: 'api' },
  { productId: 'lap4', title: '삼성 갤럭시북 노트북', lprice: 760000, shippingFee: 0, mall: 'ADPICK', link: 'https://example.com/lap4', _source: 'cache' },
  { productId: 'tab1', title: 'Apple iPad 태블릿', lprice: 480000, shippingFee: 0, mall: '쿠팡', link: 'https://example.com/tab1', _source: 'api' },
  { productId: 'bad', title: '노트북 노트북', lprice: 5000, mall: '쿠팡', link: 'javascript:alert(1)' },
  { productId: 'noShip', title: 'ASUS 노트북', lprice: 600000, mall: '쿠팡', link: 'https://example.com/noShip', _source: 'cache' },
];
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.log('FAIL',name,e.message)}}
function makeRes(){
  return { code:200, headers:{}, setHeader(k,v){this.headers[k]=v},status(v){this.code=v;return this},
    json(v){this.payload=v;return this},end(){return this} };
}
(async ()=>{
  await test('strict tool schema includes full required set',()=> {
    assert.equal(PLAN_SCHEMA.additionalProperties,false);
    assert.equal(PLAN_SCHEMA.required.length,Object.keys(PLAN_SCHEMA.properties).length);
    assert.equal(DECIDE_SCHEMA.additionalProperties,false);
  });
  await test('no fake or malformed product ID, price, URL',()=>{
    assert.equal(core.normalize({title:'fake',productId:'2',lprice:12,mall:'X',link:'javascript:alert(1)'}),null);
    assert.equal(core.normalize({title:'fake',productId:'2',lprice:0,mall:'X',link:'https://valid.example'}),null);
  });
  await test('budget with shipping is enforced',()=>{
    const plan=core.sanitizePlan({query:'노트북',category:'노트북',maxPrice:800000}, {}, '노트북 80만원');
    const {accepted}=core.validateCandidates(plan,items);
    assert(accepted.some(x=>x.id==='쿠팡:lap1'));
    assert(!accepted.some(x=>x.id==='쿠팡:lap3'));
    assert(!accepted.some(x=>x.id==='쿠팡:noShip'));
  });
  await test('cross category tablet rejected in laptop search',()=>{
    const plan=core.sanitizePlan({query:'노트북',category:'노트북'}, {}, '노트북');
    assert(!core.validateCandidates(plan,items).accepted.some(x=>x.id==='쿠팡:tab1'));
  });
  await test('excluded vendor and merchant filter',()=>{
    const plan=core.sanitizePlan({query:'노트북',category:'노트북',exclusions:['삼성'],mallOnly:'쿠팡'}, {}, '노트북 삼성 빼고 쿠팡에서');
    assert(!core.validateCandidates(plan,items).accepted.some(x=>x.id==='ADPICK:lap4'));
  });
  await test('model hallucination cannot add invented ID to cards',()=>{
    const plan={mode:'recommend'};
    const got=core.resultFromSelection(plan,[core.normalize(items[0])],{productIds:['쿠팡:fake','쿠팡:lap1','쿠팡:lap1']});
    assert.equal(got.cards.length,1);
    assert.equal(got.cards[0].title,'LG 그램 노트북 15인치');
    assert.equal(got.cards[0].price,720000);
    assert(!got.answer.includes('fake'));
  });
  await test('empty shortlist produces honest no-results',()=>{
    const got=core.resultFromSelection({},[],{productIds:['something']});
    assert.equal(got.cards.length,0);
    assert.match(got.answer,/후보가 없/);
  });
  await test('offline end-to-end uses injected search and model',async()=>{
    let searches=0, decisions=0;
    const out=await core.createEngine({
      planModel: async ()=>({mode:'recommend',query:'노트북',compareQuery:'',category:'노트북',maxPrice:800000,exclusions:['삼성'],mallOnly:'쿠팡',exactModel:''}),
      searchProducts: async()=>{searches++;return items},
      decideModel: async ({candidates})=>{decisions++;return {productIds:['쿠팡:lap1','쿠팡:lap3','쿠팡:tab1']}}
    },{message:'삼성 제외하고 쿠팡에서 80만원 이하 노트북 추천해줘'});
    assert.equal(out.status,200);
    assert.equal(searches,1);assert.equal(decisions,1);
    assert.deepEqual(out.cards.map(x=>x.productId),['쿠팡:lap1']);
    assert.equal(out.state.maxPrice,800000);
  });
  await test('no eligible products skips second model call',async()=>{
    let decisions=0;
    const out=await core.createEngine({
      planModel:async()=>({query:'노트북',category:'노트북',maxPrice:10000}),
      searchProducts:async()=>items,
      decideModel:async()=>{decisions++;return {productIds:[]}}
    },{message:'만원 이하 노트북'});
    assert.equal(decisions,0);assert.equal(out.cards.length,0);
  });
  await test('missing product category does not create arbitrary listing',async()=>{
    const out=await core.createEngine({
      planModel:async()=>({query:'???',category:''}), searchProducts:async()=>{throw Error('should not fetch')},
      decideModel:async()=>{throw Error('should not decide')}
    },{message:'이거 추천해줘'});
    assert.equal(out.cards.length,0);assert.equal(out.stats.searched,false);
  });
  await test('feature flag defaults to OFF at endpoint',async()=>{
    const old=process.env.ENABLE_AI_V3;delete process.env.ENABLE_AI_V3;
    try{
      const res=makeRes();
      await _handler({method:'POST',headers:{},socket:{remoteAddress:'127.0.0.1'},body:{message:'노트북'}},res);
      assert.equal(res.code,404);
    }finally{if(old!==undefined)process.env.ENABLE_AI_V3=old}
  });
  await test('can run test endpoint with mocks but no network',async()=>{
    const res=makeRes();
    await _handler({method:'POST',headers:{},socket:{remoteAddress:'test-v3'},body:{message:'노트북'}},res,{
      testMode:true,
      adapter:{planModel:async()=>({query:'노트북',category:'노트북',maxPrice:800000}),decideModel:async()=>({productIds:['쿠팡:lap1']})},
      searchProducts:async()=>[items[0]]
    });
    assert.equal(res.code,200);
    assert.equal(res.payload.cards[0].price,720000);
  });
  await test('OpenAI tool call contract mocked, no external fetch',async()=>{
    const calls=[];
    const adapter=makeOpenAiAdapter({apiKey:'test',model:'test-model',fetchImpl:async (_u,opts)=>{
      const body=JSON.parse(opts.body);calls.push(body);
      const content=calls.length===1?
        {status:'completed',output:[{type:'function_call',name:'search_products',call_id:'call_1',arguments:JSON.stringify({mode:'recommend',query:'노트북',compareQuery:'',category:'노트북',maxPrice:800000,exclusions:[],mallOnly:'',exactModel:''})}]}:
        {status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({productIds:['쿠팡:lap1']})}]}]};
      return {ok:true,json:async()=>content};
    }});
    const out=await core.createEngine({...adapter,searchProducts:async()=>[items[0]]},{message:'80만원 이하 노트북 추천'});
    assert.equal(out.cards.length,1);
    assert.equal(calls.length,2);
    assert.equal(calls[0].tools[0].name,'search_products');
    assert.equal(calls[0].tools[0].strict,true);
    assert.equal(calls[1].input.at(-1).type,'function_call_output');
    assert.equal(calls[1].text.format.type,'json_schema');
  });
  await test('accessory cannot masquerade as a laptop',()=>{
    const plan=core.sanitizePlan({query:'노트북',category:'노트북',maxPrice:800000}, {}, '노트북');
    assert(!core.validateCandidates(plan,items).accepted.some(x=>x.id==='쿠팡:lap2'));
  });
  await test('null shipping is never interpreted as free shipping',()=>{
    const item={...items[0],shippingFee:null};
    const plan=core.sanitizePlan({query:'노트북',category:'노트북',maxPrice:800000}, {}, '노트북');
    assert.equal(core.normalize(item).shipping,null);
    assert.equal(core.validateCandidates(plan,[item]).accepted.length,0);
  });
  await test('follow-up uses carried state and retains exclusions',async()=>{
    const out=await core.createEngine({
      planModel:async()=>({mode:'recommend',query:'',category:'',maxPrice:null,exclusions:[],mallOnly:''}),
      searchProducts:async()=>items,
      decideModel:async()=>({productIds:['쿠팡:lap1','ADPICK:lap4']})
    },{message:'그중에서 어떤 게 나아?',state:{lastQuery:'노트북',category:'노트북',maxPrice:800000,exclusions:['삼성'],mallOnly:''}});
    assert.equal(out.state.lastQuery,'노트북');
    assert.equal(out.state.maxPrice,800000);
    assert.deepEqual(out.state.exclusions,['삼성']);
    assert.deepEqual(out.cards.map(x=>x.productId),['쿠팡:lap1']);
  });
  await test('explicit nonshopping mode avoids lookup',async()=>{
    const out=await core.createEngine({
      planModel:async()=>({mode:'none',query:'',category:''}),
      searchProducts:async()=>{throw Error('should not search')},
      decideModel:async()=>{throw Error('should not call')}
    },{message:'고마워'});
    assert.equal(out.stats.searched,false);
    assert.equal(out.cards.length,0);
  });
  await test('compare refuses when second product unavailable',async()=>{
    let calls=0;
    const out=await core.createEngine({
      planModel:async()=>({mode:'compare',query:'아이패드',compareQuery:'갤럭시탭',category:'태블릿'}),
      searchProducts:async q=>{calls++;return q==='아이패드'?[items[4]]:[]},
      decideModel:async()=>{throw Error('should not call')}
    },{message:'아이패드 vs 갤럭시탭'});
    assert.equal(calls,2);
    assert.equal(out.cards.length,0);
    assert.match(out.answer,/두 비교 대상/);
  });
  await test('compare with two validated sides returns two cards',async()=>{
    const other={productId:'tab2',title:'삼성 갤럭시탭 태블릿',lprice:420000,shippingFee:0,mall:'쿠팡',link:'https://example.com/tab2',_source:'api'};
    const out=await core.createEngine({
      planModel:async()=>({mode:'compare',query:'아이패드',compareQuery:'갤럭시탭',category:'태블릿'}),
      searchProducts:async q=>q==='아이패드'?[items[4]]:[other],
      decideModel:async()=>({productIds:['쿠팡:tab1','쿠팡:tab2']})
    },{message:'아이패드 vs 갤럭시탭'});
    assert.equal(out.cards.length,2);
    assert.equal(out.cards[1].title,'삼성 갤럭시탭 태블릿');
  });
  await test('v3 DB-first search maps existing product rows without writes',async()=>{
    const {searchCatalog} = require('../api/_ai-v3-catalog');
    let liveCalls=0;
    const row={product_id:'lap1',title:'LG 그램 노트북',lprice:720000,
      mall:'쿠팡',link:'https://example.com/lap1',keyword:'노트북'};
    const database={from:table=>{
      assert.equal(table,'products');
      return {select:cols=>{
        assert.equal(cols,'*');
        return {ilike:(col,pattern)=>{
          assert.equal(col,'title'); assert.equal(pattern,'%노트북%');
          return {limit:async()=>({data:[row],error:null})};
        }};
      }};
    }};
    const result=await searchCatalog('노트북',{db:database,
      mapRow:r=>({productId:r.product_id,title:r.title,lprice:r.lprice,mall:r.mall,link:r.link}),
      liveSearch:async()=>{liveCalls++;return {items:[]}}});
    assert.equal(result.length,1);assert.equal(result[0].productId,'lap1');
    assert.equal(result[0]._source,'db');assert.equal(liveCalls,0);
  });
  await test('v3 DB no match can request live search without DB mutation',async()=>{
    const {searchCatalog} = require('../api/_ai-v3-catalog');
    const empty=()=>({limit:async()=>({data:[],error:null})});
    const database={from:()=>({select:()=>({ilike:empty,eq:empty})})};
    const result=await searchCatalog('노트북',{db:database,
      liveSearch:async()=>({items:[items[0]],failed:false})});
    assert.equal(result.length,1);assert.equal(result[0].productId,'lap1');
  });
  console.log(JSON.stringify({passed,failed,total:passed+failed}));
  if(failed) process.exitCode=1;
})().catch(e=>{console.error('Unexpected test failure:',e);process.exitCode=1});
