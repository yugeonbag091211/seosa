#!/usr/bin/env node
'use strict';
/** Zero-network regression for brand-only exclusions and budget-preserving follow-ups. */
const assert = require('node:assert/strict');
const Intent = require('../api/_intent');
const AIID = require('../api/_aiidentity');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, e.message); process.exitCode = 1; }
}
function follow(first, second) {
  return Intent.classify(second, [
    {role:'user',text:first},
    {role:'assistant',text:'추천 결과입니다.'},
    {role:'user',text:second}
  ]);
}
[
  ['전기면도기 추천해줘','예산은 그대로 두고 필립스 모델만','필립스 전기면도기'],
  ['노트북 추천해줘','예산은 그대로 두고 삼성 제품만 보여줘','삼성 노트북'],
  ['무선 이어폰 추천해줘','소니 제품만 보여줘','소니 무선 이어폰'],
  ['노트북 추천','삼성 말고 LG로','LG 노트북']
].forEach(([first,second,want]) => test('brand selection: '+second,()=>{
  const c=follow(first,second);
  assert.equal(c.intent,'C');
  assert.equal(c.query.toLowerCase(),want.toLowerCase());
  assert.equal(c.stateQuery,true);
}));
[
  ['노트북 추천해줘','삼성 절대 빼줘','삼성'],
  ['노트북 추천해줘','절대 삼성 빼줘','삼성'],
  ['노트북 추천해줘','삼성 빼줘','삼성'],
  ['노트북 추천해줘','브랜드는 삼성 절대 빼줘','삼성'],
  ['노트북 추천해줘','삼성 제품은 절대 제외하고 추천해줘','삼성'],
  ['무선 이어폰 추천해줘','소니 절대 빼줘','소니']
].forEach(([first,second,excluded]) => test('excluded brand: '+second,()=>{
  const c=follow(first,second);
  const category=/노트북/.test(first)?'노트북':'무선 이어폰';
  assert.equal(c.intent,'C');
  assert.equal(c.query,category);
  assert.equal(c.stateQuery,true);
  const parsed=AIID.splitNegations(second);
  assert.ok(parsed.negated.some(n=>n.text.includes(excluded)));
  assert.ok(!parsed.positive.includes(excluded));
  const contract=AIID.buildContract({query:c.query,userText:second,titles:[]});
  assert.ok(contract.excluded.some(e=>e.words.some(w=>w.includes(excluded))));
  const blocked=/노트북/.test(first)
    ? '삼성 갤럭시북4 노트북 16GB' : '소니 WF-1000XM5 무선 이어폰';
  const allowed=/노트북/.test(first)
    ? 'LG전자 그램 16 노트북 512GB' : 'QCY T13 무선 이어폰';
  assert.ok(AIID.verdict(contract,{title:blocked}).reasons.some(r=>r.kind==='excluded'));
  assert.ok(!AIID.verdict(contract,{title:allowed}).reasons.some(r=>r.kind==='excluded'));
}));
test('no earlier product: never invent a query',()=>{
  const c=Intent.classify('삼성 절대 빼줘',[{role:'user',text:'삼성 절대 빼줘'}]);
  assert.ok(c.intent==='B' || !c.query);
});
test('ordinary meta instruction stays conversational',()=>{
  const c=follow('노트북 추천해줘','검색 기록을 저장하지 마');
  assert.equal(c.intent,'B');
  assert.notEqual(c.query,'검색 기록');
});
test('first-turn specific product unchanged',()=>{
  const c=Intent.classify('삼성 노트북 추천해줘',[{role:'user',text:'삼성 노트북 추천해줘'}]);
  assert.equal(c.query,'삼성 노트북');
});
test('existing accessory negation is preserved',()=>{
  const c=AIID.splitNegations('아이패드 10세대 케이스 빼고 본품만 추천해줘');
  assert.ok(c.negated.some(n=>n.slots.has('accessory')));
});
console.log('AI_FOLLOWUP_DIRECTIVE_NEGATION',passed,'PASS');
