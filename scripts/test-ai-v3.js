'use strict';
const assert = require('node:assert/strict');
const core = require('../api/_ai-v3-core');
const { PLAN_SCHEMA, DECIDE_SCHEMA, makeOpenAiAdapter } = require('../api/_ai-v3-openai');
const { _handler } = require('../api/_ai-v3-route');
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
  await test('feature flag defaults to legacy at endpoint',async()=>{
    const old=process.env.ENABLE_AI_V3;delete process.env.ENABLE_AI_V3;
    try{
      const res=makeRes();
      await _handler({method:'POST',headers:{},socket:{remoteAddress:'127.0.0.1'},body:{message:'노트북'}},res,
        { legacyHandler: async (_req, response) => response.status(200).json({text:'legacy'}) });
      assert.equal(res.code,200); assert.equal(res.payload.text,'legacy');
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
      return {ok:true,json:async()=>({...content,usage:{input_tokens:100+calls.length,output_tokens:20,total_tokens:120+calls.length}})};
    }});
    const out=await core.createEngine({...adapter,searchProducts:async()=>[items[0]]},{message:'80만원 이하 노트북 추천'});
    assert.equal(out.cards.length,1);
    assert.equal(calls.length,2);
    assert.equal(calls[0].tools[0].name,'search_products');
    assert.equal(calls[0].tools[0].strict,true);
    assert.equal(calls[1].input.at(-1).type,'function_call_output');
    assert.equal(calls[1].text.format.type,'json_schema');
    assert.equal(out.stats.modelUsage.calls,2);
    assert.equal(out.stats.modelUsage.inputTokens,203);
    assert.equal(out.stats.modelUsage.outputTokens,40);
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
    // This case is about the NON-read-only path. CI (ai-v34-eval.yml) sets
    // SEOSA_DB_READONLY=1 for the whole job, which deliberately disables live
    // search — the test failed only in CI since 2026-11-12. Scope it here.
    const saved=process.env.SEOSA_DB_READONLY;
    delete process.env.SEOSA_DB_READONLY;
    try {
      const result=await searchCatalog('노트북',{db:database,
        liveSearch:async()=>({items:[items[0]],failed:false})});
      assert.equal(result.length,1);assert.equal(result[0].productId,'lap1');
    } finally { if(saved===undefined)delete process.env.SEOSA_DB_READONLY; else process.env.SEOSA_DB_READONLY=saved; }
  });
  await test('price under budget but missing delivery becomes provisional, not confirmed',()=>{
    const plan=core.sanitizePlan({query:'노트북',category:'노트북',maxPrice:800000}, {}, '노트북');
    const p={...items[0],shippingFee:undefined};
    const found=core.validateCandidates(plan,[p]);
    assert.equal(found.accepted.length,0);
    assert.equal(found.provisional.length,1);
    assert.equal(found.provisional[0].budgetTier,'listing_only_shipping_unverified');
    assert.equal(found.provisional[0].shipping,null);
  });
  await test('explicit free shipping evidence verifies total budget',()=>{
    const plan=core.sanitizePlan({query:'노트북',category:'노트북',maxPrice:800000}, {}, '노트북');
    const p={...items[0],shippingFee:null,isFreeShipping:true};
    const found=core.validateCandidates(plan,[p]);
    assert.equal(found.accepted.length,1);
    assert.equal(found.accepted[0].budgetTier,'total_verified');
  });
  await test('price above budget is never offered even provisionally',()=>{
    const plan=core.sanitizePlan({query:'노트북',category:'노트북',maxPrice:800000}, {}, '노트북');
    const found=core.validateCandidates(plan,[{...items[2],shippingFee:null}]);
    assert.equal(found.provisional.length,0);
    assert.equal(found.reasons.over_budget,1);
  });
  await test('second-hand listing is rejected unless user asks for used',()=>{
    const row={...items[4],title:'중고 아이패드 태블릿'};
    const def=core.sanitizePlan({query:'아이패드',category:'태블릿'}, {}, '아이패드 추천');
    assert.equal(core.validateCandidates(def,[row]).reasons.used_not_requested,1);
    const used=core.sanitizePlan({query:'아이패드',category:'태블릿'}, {}, '중고 아이패드 추천');
    assert.equal(core.validateCandidates(used,[row]).accepted.length,1);
  });
  await test('no invented zero shipping or fake total in card',()=>{
    const card=core.resultFromSelection(
      {mode:'recommend'},
      core.validateCandidates({category:'노트북',maxPrice:800000},[{...items[0],shippingFee:null}]).provisional,
      {productIds:['쿠팡:lap1']});
    assert.equal(card.cards.length,1);
    assert.equal(card.cards[0].shippingFee,null);
    assert.equal(card.cards[0].totalPrice,null);
    assert.equal(card.cards[0].budgetStatus,'listing_only_shipping_unverified');
    assert.match(card.answer,/배송비/);
    assert.match(card.answer,/보장할 수 없/);
  });
  await test('full offline v3 recommends provisional with transparent warning',async()=>{
    const out=await core.createEngine({
      planModel:async()=>({mode:'recommend',query:'노트북',category:'노트북',maxPrice:800000}),
      searchProducts:async()=>[{...items[0],shippingFee:undefined}],
      decideModel:async()=>({productIds:['쿠팡:lap1']})
    },{message:'80만원 이하 노트북 추천'});
    assert.equal(out.cards.length,1);
    assert.equal(out.stats.accepted,0);
    assert.equal(out.stats.provisional,1);
    assert.match(out.answer,/배송비/);
  });
  await test('comparison explanation uses only selected actual prices and titles',()=>{
    const a=core.normalize(items[4]);
    const b=core.normalize({productId:'tab2',title:'삼성 갤럭시탭 태블릿',lprice:420000,
      mall:'쿠팡',link:'https://example.com/tab2',_source:'cache'});
    const out=core.resultFromSelection({mode:'compare'},[a,b],
      {productIds:[a.id,b.id,'쿠팡:nonexistent']});
    assert.equal(out.cards.length,2);
    assert.match(out.answer,/60,000원/);
    assert.match(out.answer,/갤럭시탭/);
    assert(out.answer.includes(a.title));
    assert.match(out.answer,/배송비/);
    assert(!out.answer.includes('nonexistent'));
  });
  await test('comparison balances both 40-product pools and checks all searched items',async()=>{
    const make=(prefix,label,count)=>Array.from({length:count},(_,i)=>({
      productId:prefix+i,title:label+' 태블릿 '+i,lprice:300000+i*100,
      mall:'쿠팡',link:'https://example.com/'+prefix+i,shippingFee:0,_source:'api'
    }));
    const left=make('ipad','아이패드',40), right=make('galaxy','갤럭시탭',40);
    let seen;
    const out=await core.createEngine({
      planModel:async()=>({mode:'compare',query:'아이패드',compareQuery:'갤럭시탭',category:'태블릿'}),
      searchProducts:async q=>q==='아이패드'?left:right,
      decideModel:async ({candidates})=>{
        seen=candidates.map(x=>x.id);
        return {productIds:['쿠팡:ipad0','쿠팡:galaxy0']};
      }
    },{message:'아이패드 vs 갤럭시탭'});
    assert.equal(out.stats.inspected,80);
    assert.equal(out.cards.length,2);
    assert(seen.includes('쿠팡:ipad0') && seen.includes('쿠팡:galaxy0'));
    assert.equal(seen.filter(x=>x.startsWith('쿠팡:ipad')).length,8);
    assert.equal(seen.filter(x=>x.startsWith('쿠팡:galaxy')).length,8);
  });
  await test('comparison with an unsupported second target does not show one-sided cards',async()=>{
    const out=await core.createEngine({
      planModel:async()=>({mode:'compare',query:'아이패드',compareQuery:'갤럭시탭',category:'태블릿'}),
      searchProducts:async q=>q==='아이패드'?[items[4]]:[items[4]],
      decideModel:async()=>{throw new Error('should not decide')}
    },{message:'아이패드와 갤럭시탭'});
    assert.equal(out.cards.length,0);
  });
  await test('follow-up comparison keeps both original product queries',async()=>{
    const next=core.sanitizePlan({mode:'compare',query:'',compareQuery:'',category:'태블릿'},
      {lastQuery:'아이패드',compareQuery:'갤럭시탭',category:'태블릿'},'위 둘 중 뭐가 좋아?');
    assert.equal(next.query,'아이패드');
    assert.equal(next.compareQuery,'갤럭시탭');
  });
  await test('user may revoke previously permitted second-hand items',()=>{
    const next=core.sanitizePlan({mode:'recommend',query:'',category:'태블릿'},
      {lastQuery:'아이패드',category:'태블릿',allowUsed:true},'중고 제외하고 추천해줘');
    assert.equal(next.allowUsed,false);
  });
  await test('four model picks cannot make compare explain two same-side cards',async()=>{
    const ipad=(id,price)=>({productId:id,title:'아이패드 태블릿 '+id,lprice:price,
      mall:'쿠팡',link:'https://example.com/'+id,shippingFee:0,_source:'api'});
    const galaxy=(id,price)=>({productId:id,title:'갤럭시탭 태블릿 '+id,lprice:price,
      mall:'쿠팡',link:'https://example.com/'+id,shippingFee:0,_source:'api'});
    const out=await core.createEngine({
      planModel:async()=>({mode:'compare',query:'아이패드',compareQuery:'갤럭시탭',category:'태블릿'}),
      searchProducts:async q=>q==='아이패드'?[ipad('i1',400000),ipad('i2',401000)]:
        [galaxy('g1',350000),galaxy('g2',351000)],
      decideModel:async()=>({productIds:['쿠팡:i1','쿠팡:i2','쿠팡:g1','쿠팡:g2']})
    },{message:'아이패드와 갤럭시탭 비교'});
    assert.equal(out.cards.length,2);
    assert.deepEqual(out.cards.map(c=>c.productId),['쿠팡:i1','쿠팡:g1']);
    assert.match(out.answer,/50,000원/);
    assert(out.answer.includes(out.cards[0].title) && out.answer.includes(out.cards[1].title));
    assert(!out.answer.includes('i2'));
  });
  await test('comparison price uses delivery totals only if both verified',()=>{
    const a=core.normalize({...items[0],shippingFee:60000});
    const b=core.normalize({...items[3],shippingFee:0});
    const got=core.resultFromSelection({mode:'compare'},[a,b],
      {productIds:[a.id,b.id]});
    assert.equal(got.cards.length,2);
    assert.equal(got.cards[0].totalPrice,780000);
    assert.equal(got.cards[1].totalPrice,760000);
    assert.match(got.answer,/20,000원/);
    assert.match(got.answer,/배송비 포함 합계/);
  });
  await test('explicit 12-15 manwon lower bound survives follow-up and removes hangers',()=>{
    const prev={lastQuery:'헤드셋',category:'헤드셋',maxPrice:150000,exclusions:['게이밍']};
    const plan=core.sanitizePlan({mode:'recommend',query:'헤드셋',category:'헤드셋',maxPrice:150000},prev,
      '그중에서 12만원 이상 15만원 이하로 골라줘');
    assert.equal(plan.minPrice,120000);
    const row=(id,title,lprice)=>({productId:id,title,lprice,mall:'쿠팡',
      link:'https://example.com/'+id,shippingFee:0});
    const check=core.validateCandidates(plan,[
      row('low','브리츠 무선 블루투스 헤드셋',111692),
      row('hanger','게임 헤드폰 탁상용 스탠드 헤드셋걸이',128000),
      row('good','브리츠 ANC 헤드셋',139000),
      row('high','브리츠 블루투스 헤드셋',160000)
    ]);
    assert.deepEqual(check.accepted.map(x=>x.id),['쿠팡:good']);
    assert.equal(check.reasons.below_min_price,1);
    assert.equal(check.reasons.accessory_not_requested,1);
    assert.equal(check.reasons.over_budget,1);
  });
  await test('12 to 15 manwon price range sets lower bound without GPT guessing',()=>{
    for (const text of ['12~15만원 헤드셋 추천','12만~15만원 헤드셋 추천',
      '12만원에서 15만원 헤드셋 추천']) {
      const plan=core.sanitizePlan({query:'헤드셋',category:'헤드셋',maxPrice:150000},{},text);
      assert.equal(plan.minPrice,120000,text);
    }
    const noFloor=core.sanitizePlan({query:'헤드셋',category:'헤드셋',maxPrice:150000},{},
      '15만원 이하 헤드셋 추천');
    assert.equal(noFloor.minPrice,null);
  });
  await test('lower price bound is carried until user explicitly changes incompatible budget',()=>{
    const same=core.sanitizePlan({query:'헤드셋',category:'헤드셋',maxPrice:150000},
      {minPrice:120000,maxPrice:150000},'그중에 하나 골라줘');
    assert.equal(same.minPrice,120000);
    const changed=core.sanitizePlan({query:'헤드셋',category:'헤드셋',maxPrice:100000},
      {minPrice:120000,maxPrice:150000},'10만원 이하로 바꿔줘');
    assert.equal(changed.minPrice,null);
  });
  await test('single replacement AirPod is not a complete ANC product',()=>{
    const plan={category:'이어폰',identity:require('../api/_ai-v3-identity').requestedIdentity('에어팟 4 ANC')};
    const p=(id,title)=>({productId:id,title,lprice:160000,shippingFee:0,
      mall:'쿠팡',link:'https://example.com/'+id});
    const got=core.validateCandidates(plan,[
      p('unit','Apple 에어팟 4세대 노이즈 캔슬링 오른쪽 단품'),
      p('whole','Apple 에어팟 4세대 ANC 무선 이어폰')
    ]);
    assert.deepEqual(got.accepted.map(c=>c.id),['쿠팡:whole']);
    assert.equal(got.reasons.accessory_not_requested,1);
  });
  await test('wireless earbud adjective maps to earbud category without admitting headphones',()=>{
    assert.equal(core.categoryOk({title:'Apple 에어팟 4세대 ANC 블루투스 이어폰'},'무선 이어폰'),true);
    assert.equal(core.categoryOk({title:'삼성 갤럭시 버즈3 무선 이어폰'},'무선 이어폰'),true);
  });
  await test('merchant category suffix does not turn earbud into headset',()=>{
    assert.equal(core.categoryOk({
      title:'소니/소니 WF-C710N 나의 첫 번째 노이즈 캔슬링 이어폰/디지털기기 헤드셋/이어폰'
    },'헤드셋'),false);
    assert.equal(core.categoryOk({
      title:'소니 가벼운 노이즈 캔슬링 블루투스 헤드폰, WH-CH720N, 화이트'
    },'헤드셋'),true);
  });
  console.log(JSON.stringify({passed,failed,total:passed+failed}));
  if(failed) process.exitCode=1;
})().catch(e=>{console.error('Unexpected test failure:',e);process.exitCode=1});
