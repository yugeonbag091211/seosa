'use strict';
/** Regression for 2026-11-16: true merchandise vs conversational qualifiers and substrings. */
const assert = require('node:assert/strict');
const gate = require('../api/_product-gate');
const search = require('../api/_search');
let n=0;
function yes(query,title,price=50000) {
  const v=gate.judge(gate.parseQuery(query),{title,price});
  assert.equal(v.ok,true,JSON.stringify({query,title,hard:v.hard})); n++;
}
function no(query,title,price=50000) {
  const v=gate.judge(gate.parseQuery(query),{title,price});
  assert.equal(v.ok,false,JSON.stringify({query,title,hard:v.hard})); n++;
}
yes('테팔 프라이팬 본품을 사고 싶어. 사은품이 같이 와도 돼','테팔 프라이팬 본품');
yes('테팔 프라이팬 본품 사은품 같이 와도 돼','테팔 프라이팬 본품');
no('테팔 프라이팬 본품을 사고 싶어. 사은품이 같이 와도 돼','테팔 프라이팬 손잡이 단품');
yes('테팔 프라이팬 손잡이','테팔 프라이팬 손잡이 단품');
no('아이패드 10세대','아이패드 10세대 케이스 + 필름 증정',500000);
yes('아이패드 10세대','아이패드 10세대 256GB + 케이스 증정',500000);
yes('매트리스 퀸','퀸 매트리스',500000);
no('매트리스 퀸','퀸 매트리스 전용 매트',50000);
yes('양털 슬리퍼','양털 슬리퍼',20000);
assert.equal(search.stripConditionTerms('양털 슬리퍼'),'양털 슬리퍼'); n++;
assert.equal(search.conditionState('양털 슬리퍼'),''); n++;
assert.equal(search.conditionState('리퍼 제품'),'refurbished'); n++;
assert.equal(search.conditionIntent('리퍼나 중고 말고').excluded.has('refurbished'),true);n++;
yes('식탁 의자에서 원목 조건과 10만원 이하 가격을 동시에 충족하는 것','한샘 식탁 의자 원목',60000);
no('식탁 의자에서 원목 조건과 10만원 이하 가격을 동시에 충족하는 것','한샘 식탁 의자 철제',60000);
no('식탁 의자에서 원목 조건과 10만원 이하 가격을 동시에 충족하는 것','원목 도마',60000);
const held=gate.saveFilter('식탁 의자 원목',[{title:'한샘 식탁 의자',lprice:60000}]);
assert.equal(held.save.length,0,'missing material evidence may not enter the catalog');n++;
console.log('SEARCH_GATE_RECOVERY_FOLLOWUP',n,'PASS');
