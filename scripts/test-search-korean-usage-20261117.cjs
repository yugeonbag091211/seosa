'use strict';
/* Korean consumer phrase regression; pure functions and no provider/API/DB calls. */
const assert = require('node:assert/strict');
const Gate = require('../api/_product-gate');

let count = 0;
function allowed(query,title,price=50000) {
  const spec=Gate.parseQuery(query);
  const v=Gate.judge(spec,{title,price});
  assert.equal(v.ok,true,JSON.stringify({query,title,head:spec.head,idText:spec.idText,hard:v.hard}));
  count++;
}
function blocked(query,title,price=50000) {
  const spec=Gate.parseQuery(query);
  const v=Gate.judge(spec,{title,price});
  assert.equal(v.ok,false,JSON.stringify({query,title,head:spec.head,idText:spec.idText,hard:v.hard}));
  count++;
}

const strapQuery='카시오 손목시계에 쓸 시계 스트랩만 보여줘';
const strapSpec=Gate.parseQuery(strapQuery);
assert.equal(strapSpec.wantsAccessory,true);
assert.ok(!strapSpec.identityWords.includes('쓸'),JSON.stringify(strapSpec.identityWords));
assert.ok(!strapSpec.identityWords.includes('손목시계에'),JSON.stringify(strapSpec.identityWords));
count+=3;
allowed(strapQuery,'카시오 손목시계용 시계 스트랩',10000);
blocked(strapQuery,'카시오 손목시계 본품',50000);

const lidQuery='테팔 프라이팬에 쓸 프라이팬 뚜껑만 보여줘';
allowed(lidQuery,'테팔 프라이팬용 프라이팬 뚜껑',10000);
blocked(lidQuery,'테팔 프라이팬 본품',60000);

const brushQuery='로보락 로봇 청소기에 쓸 전용 브러시만 보여줘';
allowed(brushQuery,'로보락 로봇 청소기용 전용 브러시',10000);
blocked(brushQuery,'로보락 로봇 청소기 본품',500000);

const chairQuery='한샘 식탁 의자 중 원목 사양으로 골라줘';
const chairSpec=Gate.parseQuery(chairQuery);
assert.notEqual(chairSpec.head,'사양','material qualifier must not become merchandise category');count++;
allowed(chairQuery,'한샘 식탁 의자 원목',60000);
blocked(chairQuery,'한샘 식탁 의자 철제',60000);
const unknown=Gate.saveFilter(chairQuery,[{title:'한샘 식탁 의자 원목 무늬',lprice:60000}]);
assert.equal(unknown.save.length,0,'imitation-wood title must not be saved as solid wood');count++;
console.log('SEARCH_KOREAN_USAGE_PHRASE_PASS',count);
