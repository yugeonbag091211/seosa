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

// User asks for a separate accessory without naming a pre-registered accessory token.
// Pass real provider titles to parsing as the production search handler does.
for (const [query, valid, invalid] of [
  ['한샘 식탁 의자에 쓸 의자 방석만 보여줘','한샘 식탁 의자용 의자 방석','한샘 식탁 의자 본품'],
  ['한일 전기장판에 쓸 전기장판 조절기만 보여줘','한일 전기장판용 전기장판 조절기','한일 전기장판 본품'],
  ['필립스 에어프라이어에 쓸 에어프라이어 바스켓만 보여줘','필립스 에어프라이어용 에어프라이어 바스켓','필립스 에어프라이어 본품']
]) {
  const spec = Gate.parseQuery(query,{titles:[valid,invalid]});
  assert.equal(spec.identityWords.some(w=>/에$|쓸$/.test(w)),false,
    JSON.stringify({query,idText:spec.idText,words:spec.identityWords}));
  count++;
  assert.equal(Gate.judge(spec,{title:valid,price:15000}).ok,true,
    JSON.stringify({query,valid,head:spec.head}));
  count++;
  assert.equal(Gate.judge(spec,{title:invalid,price:60000}).ok,false,
    JSON.stringify({query,invalid,head:spec.head}));
  count++;
}
// A free gift is not the sold item. Excluding a host-specific accessory
// must continue to work even if another accessory is bundled with it.
for(const [query,valid,invalid] of [
  ['한일 전기장판 본품을 사고 싶어. 사은품이 같이 와도 돼','한일 전기장판 본품 + 조절기 증정','한일 전기장판 전용 조절기'],
  ['필립스 에어프라이어 본품을 사고 싶어. 사은품이 같이 와도 돼','필립스 에어프라이어 본품 + 바스켓 증정','필립스 에어프라이어 전용 바스켓'],
  ['코베아 텐트 본품을 사고 싶어. 사은품이 같이 와도 돼','코베아 텐트 본품 + 폴대 증정','코베아 텐트 전용 폴대'],
  ['나이키 운동화 본품을 사고 싶어. 사은품이 같이 와도 돼','나이키 운동화 본품 + 깔창 증정','나이키 운동화 전용 깔창'],
  ['위닉스 제습기 본품을 사고 싶어. 사은품이 같이 와도 돼','위닉스 제습기 본품 + 호스 증정','위닉스 제습기 전용 호스']
]) {
  allowed(query,valid,60000);
  blocked(query,invalid,12000);
}
for (const [query, valid] of [
  ['운동화에서 사이즈 270mm 조건과 10만원 이하 가격을 동시에 충족하는 것','운동화 사이즈 270mm'],
  ['책상에서 폭 120cm 조건과 10만원 이하 가격을 동시에 충족하는 것','책상 폭 120cm'],
  ['텐트에서 4인용 조건과 10만원 이하 가격을 동시에 충족하는 것','텐트 4인용']
]) {
  const spec=Gate.parseQuery(query,{titles:[valid]});
  assert.ok(!String(spec.head).includes('에서'),JSON.stringify({query,head:spec.head}));
  assert.ok(!String(spec.head).includes('동시에'),JSON.stringify({query,head:spec.head}));
  count+=2;
}
console.log('SEARCH_KOREAN_USAGE_PHRASE_PASS',count);
