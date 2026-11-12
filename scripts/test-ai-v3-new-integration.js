'use strict';
const assert = require('node:assert/strict');
const { createEngine } = require('../api/_ai-v3-core');
const { decodeState } = require('../api/_ai-v3-state');

(async () => {
  process.env.AI_V3_STATE_SECRET = 'integration-test-secret';
  let plans = 0, chats = 0, lastOptions;
  const item = { productId:'one', title:'LG 노트북 15인치', lprice:720000, shippingFee:0,
    mall:'쿠팡', link:'https://example.com/item', _source:'api' };
  const deps = {
    planModel: async () => { plans++; return {mode:'recommend',query:'노트북',category:'노트북'}; },
    decideModel: async () => ({productIds:['쿠팡:one']}),
    searchProducts: async (_q, opts) => { lastOptions=opts; return [item]; },
    loadDisplayed: async () => [item],
    classifyModel: async () => ({category:'C'}),
    chatResponse: async () => { chats++; return '안녕하세요. 상품도 찾아드릴게요.'; }
  };
  const chat = await createEngine(deps, {message:'지구는 왜 둥근가요?'});
  assert.match(chat.answer, /안녕하세요/); assert.equal(plans,0); assert.equal(chats,1);
  const failed = await createEngine({...deps, chatResponse:async()=>{throw Error('offline');}}, {message:'지구는 왜 둥근가요?'});
  assert.match(failed.answer,/상품 검색/);
  await createEngine(deps,{message:'고마워요'}); assert.equal(chats,1);
  await createEngine(deps,{message:'노트북이 뭐야?'}); assert.equal(chats,1);
  const beforeComparePlans=plans;
  const informationCompare = await createEngine(deps,{message:'노트북과 태블릿 차이가 뭐야?'});
  assert.equal(informationCompare.stats.searched,false);
  assert.equal(plans,beforeComparePlans);
  const first = await createEngine(deps,{message:'노트북 추천해줘'});
  assert.ok(first.state.token); assert.equal(decodeState(first.state.token).shownProducts[0].price,720000);
  const second = await createEngine(deps,{message:'그거 더 싸게 없어?',state:first.state});
  assert.equal(lastOptions.maxPrice,719999); assert.equal(second.cards.length,0);
  const ordinal = await createEngine(deps,{message:'첫번째꺼 보여줘',state:first.state});
  assert.equal(ordinal.cards[0].productId,'쿠팡:one');
  assert.equal(decodeState(ordinal.state.token).turnCount,2);
  let unrelatedOptions;
  const mouse = {productId:'mouse',title:'로지텍 마우스',lprice:30000,shippingFee:0,
    mall:'쿠팡',link:'https://example.com/mouse',_source:'api'};
  const unrelated = await createEngine({...deps,
    planModel:async()=>({mode:'recommend',query:'마우스',category:'마우스'}),
    searchProducts:async (_q,options)=>{unrelatedOptions=options;return [mouse]},
    decideModel:async()=>({productIds:['쿠팡:mouse']})
  },{message:'저렴한 마우스 추천해줘',state:first.state});
  assert.equal(unrelated.cards[0].productId,'쿠팡:mouse');
  assert.equal(unrelatedOptions.maxPrice,null);
  const token = first.state.token.split('.'); token[1] = (token[1][0] === 'A' ? 'B' : 'A') + token[1].slice(1);
  const tampered = await createEngine(deps,{message:'그거 더 싸게 없어?',state:{...first.state,token:token.join('.')}});
  assert.notEqual(lastOptions.maxPrice,719999);
  assert.equal(decodeState(tampered.state.token).turnCount,1);
  const { token: ignored, ...unsigned } = first.state;
  const stripped = await createEngine(deps,{message:'그거 더 싸게 없어?',state:unsigned});
  assert.equal(decodeState(stripped.state.token).turnCount,1);
  console.log('v3 chat and conversation integration passed');
})().catch(err => { console.error(err); process.exitCode=1; });
