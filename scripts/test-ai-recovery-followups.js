'use strict';
// Multi-turn legacy handler with fake shopping/model providers: no network or DB writes.
const assert = require('node:assert/strict');
const H = require('./_ai-chat-harness');
const AC = require('../api/_aicontext');
for (const [pid,title,price,key] of [
  ['R1','삼성 갤럭시북 노트북 16GB RAM',800000,'노트북'],
  ['R2','LG 그램 노트북 16GB RAM',900000,'노트북'],
  ['R3','LG 그램 노트북 8GB RAM',850000,'노트북'],
  ['R4','삼성 무선 청소기 제트',200000,'청소기']
]) H.addProduct({pid,vid:'v'+pid,title,price,keys:[key],history:[[0,price]]});
const ask = (s,q,classify='A') => s.say(q,{classify,answer:'확인했습니다.'});
const cards = r => r.body.items || [];
(async () => {
  const s=H.session({limit:4});
  await ask(s,'노트북 추천해줘');
  let n=H.searchLog.length;
  let r=await ask(s,'삼성 절대 빼줘');
  assert.ok(H.searchLog.slice(n).includes('노트북'));
  assert.ok(cards(r).length && cards(r).every(x=>!/삼성/.test(x.title)));
  assert.deepEqual(AC.verifyConversationState(r.body.convState).excludedBrands,['삼성']);
  await ask(s,'배터리 수명이 중요해');
  n=H.searchLog.length;
  r=await ask(s,'다른 제품 추천해줘','C|노트북');
  assert.ok(H.searchLog.slice(n).includes('노트북'));
  assert.ok(cards(r).length && cards(r).every(x=>!/삼성/.test(x.title)));
  r=await ask(s,'삼성 제품만 보여줘');
  assert.ok(cards(r).some(x=>/삼성/.test(x.title)),JSON.stringify(r.body));
  assert.deepEqual(AC.verifyConversationState(r.body.convState).excludedBrands,[]);
  const t=H.session(); await ask(t,'100만원 이하 노트북 추천해줘');
  n=H.searchLog.length; r=await ask(t,'삼성은 빼고 16GB RAM만');
  assert.ok(H.searchLog.slice(n).some(q=>/노트북/.test(q)&&/16gb/.test(q)),JSON.stringify(H.searchLog.slice(n)));
  assert.ok(cards(r).length && cards(r).every(x=>!/삼성/.test(x.title)&&/16GB/i.test(x.title)&&x.lprice<=1000000),JSON.stringify(cards(r)));
  const saved=AC.verifyConversationState(r.body.convState);
  assert.equal(saved.constraints.budgetMax,1000000);
  assert.deepEqual(saved.excludedBrands,['삼성']);
  // Only the 8 GB laptop remains after the brand exclusion: it is a known
  // contradiction and must not be offered as a 16 GB match.
  const idx=H.catalog.findIndex(p=>p.productId==='R2');
  const [removed]=H.catalog.splice(idx,1);
  const mismatch=H.session(); await ask(mismatch,'100만원 이하 노트북 추천해줘');
  r=await ask(mismatch,'삼성은 빼고 16GB RAM만');
  assert.ok(cards(r).every(x=>!/8GB/i.test(x.title)),JSON.stringify(cards(r)));
  H.catalog.splice(idx,0,removed);
  // A new product kind clears the old brand restriction, including when an
  // older client supplies only history and does not have a signed state.
  for (const historyOnly of [false,true]) {
    const topic=H.session(); await ask(topic,'노트북 추천해줘');
    await ask(topic,'삼성 절대 빼줘','C|노트북');
    if(historyOnly) topic.convState='';
    r=await ask(topic,'삼성 청소기 추천해줘','C|삼성 청소기');
    assert.ok(cards(r).some(x=>x.productId==='R4'),JSON.stringify({historyOnly,body:r.body}));
    assert.deepEqual(AC.verifyConversationState(r.body.convState).excludedBrands,[]);
  }
  // A 64GB RAM request must not become 64GB storage after a refinement.
  H.addProduct({pid:'R5',vid:'V5',title:'LG 노트북 32GB RAM 64GB SSD',price:800000,keys:['노트북'],history:[[0,800000]]});
  H.addProduct({pid:'R6',vid:'V6',title:'LG 노트북 64GB RAM 512GB SSD',price:900000,keys:['노트북'],history:[[0,900000]]});
  const memory=H.session(); await ask(memory,'노트북 추천해줘');
  r=await ask(memory,'64GB RAM만');
  assert.ok(cards(r).some(x=>x.productId==='R6') && cards(r).every(x=>x.productId!=='R5'),JSON.stringify(cards(r)));
  r=await ask(memory,'배터리 수명이 중요해');
  assert.ok(cards(r).some(x=>x.productId==='R6') && cards(r).every(x=>x.productId!=='R5'),JSON.stringify(cards(r)));
  assert.match(AC.verifyConversationState(r.body.convState).product,/64gb RAM/i);
  H.addProduct({pid:'R7',vid:'V7',title:'LG 노트북 32GB RAM 512GB SSD',price:800000,keys:['노트북'],history:[[0,800000]]});
  H.addProduct({pid:'R8',vid:'V8',title:'LG 노트북 16GB RAM 1TB SSD',price:900000,keys:['노트북'],history:[[0,900000]]});
  const memoryChange=H.session(); await ask(memoryChange,'노트북 16GB RAM 512GB SSD 추천해줘');
  r=await ask(memoryChange,'32GB RAM으로');
  let specState=AC.verifyConversationState(r.body.convState).product;
  assert.match(specState,/32gb RAM/i); assert.match(specState,/512gb SSD/i);
  assert.ok(cards(r).some(x=>x.productId==='R7'),JSON.stringify(cards(r)));
  const diskChange=H.session(); await ask(diskChange,'노트북 16GB RAM 512GB SSD 추천해줘');
  r=await ask(diskChange,'1TB SSD로');
  specState=AC.verifyConversationState(r.body.convState).product;
  assert.match(specState,/16gb RAM/i); assert.match(specState,/1tb SSD/i);
  assert.ok(cards(r).some(x=>x.productId==='R8'),JSON.stringify(cards(r)));
  H.addProduct({pid:'R9',vid:'V9',title:'LG 노트북 16GB RAM 512GB SSD',price:900000,keys:['노트북'],history:[[0,900000]]});
  H.addProduct({pid:'R10',vid:'V10',title:'삼성 노트북 16GB RAM 512GB SSD',price:1200000,keys:['노트북'],history:[[0,1200000]]});
  const combined=H.session(); await ask(combined,'100만원 이하 노트북 추천해줘');
  r=await ask(combined,'16GB RAM 512GB SSD로');
  assert.ok(cards(r).some(x=>x.productId==='R9'),JSON.stringify(cards(r)));
  assert.ok(cards(r).every(x=>!/8GB RAM/i.test(x.title)&&x.lprice<=1000000),JSON.stringify(cards(r)));
  assert.equal(AC.verifyConversationState(r.body.convState).constraints.budgetMax,1000000);
  assert.equal(H.counters.external,0); assert.equal(H.counters.dbWrites,0);
  console.log('AI recovery multi-turn follow-ups PASS; mocked providers; no external calls or DB writes');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
