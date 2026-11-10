'use strict';
// Follow-up regression suite for gaps uncovered by independent review of the
// original 70-case Preview holdout. Does not modify pre-registered labels.
// Run locally against a reviewed branch: node scripts/test-ai-v32-niche-guardrails-20261110.js
const assert = require('node:assert/strict');
const taxonomy = require('../api/_ai-v31-taxonomy');
const { verdict } = require('./ai-v32-eval/verdict');
const { cases, labelFor } = require('./ai-v32-eval/holdout-cases');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch(e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
const productOk = (title, cat, q) => taxonomy.productTypeMatches(title, cat, q);
function gradeOne(id, title, price) {
  const t = cases.find(x => x.id === id);
  assert(t, 'missing holdout ' + id);
  const card = { productId: 'mock:1', title, price, condition: 'unknown', link:'https://example.org/test' };
  return verdict(t, { http: 200, cards:[card], state:{maxPrice: price > 0 && ['H40','H56'].includes(id) ? (id === 'H40' ? 30000 : 100000) : null}, stats:{searched:true}}, null, labelFor(t));
}

test('H40 generic wireless mouse is not proof of left-handed fit', () => {
  const q = '왼손잡이용 무선 마우스 3만원 이하';
  assert.equal(productOk('홈플래닛 저소음 조약돌 슬림디자인 무선마우스','마우스',q),false);
  const bad = gradeOne('H40','홈플래닛 저소음 조약돌 슬림디자인 무선마우스',7290);
  assert.equal(bad.verdict,'FAIL');
  assert(bad.causes.some(x=>x.includes('left_handed_evidence_missing')));
});
test('H40 explicitly ambidextrous wireless mouse is eligible by title', () => {
  const q = '왼손잡이용 무선 마우스 3만원 이하';
  assert.equal(productOk('로지텍 M170 무선 마우스, 양손잡이용','마우스',q),true);
});
test('H40 multi-variant wired/wireless/BT price is insufficient evidence', () => {
  const q = '왼손잡이용 무선 마우스 3만원 이하';
  assert.equal(productOk('유선 무선 블루투스 직립형 왼손용 마우스','마우스',q),false);
});
test('H46 Dyson Hot+Cool is not Dyson Pure Cool', () => {
  const q = '다이슨 공기청정기 퓨어쿨 정품';
  const title='[다이슨] 다이슨 공기청정기 핫앤쿨 HP2 니켈골드 국내AS';
  assert.equal(productOk(title,'공기청정기',q),false);
  const bad=gradeOne('H46',title,854520);
  assert.equal(bad.verdict,'FAIL');
  assert(bad.causes.some(x=>x.includes('named_product_line_missing')));
});
test('H46 Dyson Pure Cool explicit title can be considered', () => {
  assert.equal(productOk('다이슨 퓨어쿨 공기청정기 정품','공기청정기','다이슨 공기청정기 퓨어쿨 정품'),true);
});
test('H56 general adult Bluetooth watch is not a kids calling watch', () => {
  const q='어린이 키즈폰 스마트워치 10만원 이하';
  const title='블라우풍트 스마트 워치, 블랙, 5cm, 블루투스';
  assert.equal(productOk(title,'시계',q),false);
  const bad=gradeOne('H56',title,73000);
  assert.equal(bad.verdict,'FAIL');
  assert(bad.causes.some(x=>x.includes('kids_watch_evidence_missing')));
});
test('H56 explicit kids smartwatch is not excluded solely by its class', () => {
  assert.equal(productOk('어린이 키즈 스마트워치 통화 가능 GPS','시계','어린이 키즈폰 스마트워치 10만원 이하'),true);
});
test('H47 original disputed label is unchanged and not rewritten post hoc', () => {
  const c=cases.find(x=>x.id==='H47');
  assert.equal(labelFor(c).expect,'FIND');
  assert(/no plain S8/i.test(labelFor(c).note||''));
});
console.log(JSON.stringify({passed,failed,total:passed+failed}));
if(failed)process.exitCode=1;
