'use strict';
const assert = require('node:assert/strict');
const gate = require('../api/_product-gate');

function verdict(query, title, price = 500000) {
  return gate.judge(gate.parseQuery(query), { title, price });
}
for (const [query, title, price = 500000] of [
  ['아이패드 10세대', '아이패드 10세대 케이스 + 필름 증정'],
  ['아이패드 10세대', '아이패드 10세대 256GB 케이스 + 필름 증정'],
  ['갤럭시 S24', '갤럭시 S24 케이스 + 충전기 증정'],
  ['로봇 청소기 추천하되 로보락 브랜드는 제외해줘', '로보락 로봇 청소기'],
  ['손목시계 추천하되 카시오 브랜드는 제외해줘', '카시오 손목시계'],
  ['전기장판', '한일 전기장판 조절기'],
  ['필립스 에어프라이어', '필립스 에어프라이어 바스켓'],
  ['코베아 텐트', '코베아 텐트 폴대'],
  ['16GB RAM 노트북', '삼성 노트북 RAM 8GB SSD 16GB'],
  ['16GB RAM 노트북', '삼성 노트북 8GB RAM 16GB SSD'],
  ['16GB RAM 노트북', '노트북 RAM 8GB 16GB'],
  ['16GB RAM 노트북', '노트북 16GB SSD 8GB RAM'],
  ['전기장판 신품만, 중고는 제외해줘', '전기장판 조절기 신품'],
  ['식탁 의자 신품만, 중고는 제외해줘', '식탁 의자 방석 신품'],
  ['일룸 책상', '일룸 책상 서랍'],
  ['가습기 1.7L', '가습기 12L'],
  ['물티슈 100매', '물티슈 10매'],
  ['양말 5켤레', '양말 10켤레'],
  ['로보락 로봇 청소기 중 물통 300ml 사양으로 골라줘', '로보락 로봇 청소기 물통 200ml'],
  ['LG 모니터 중 주사율 144Hz 사양으로 골라줘', 'LG 모니터 주사율 75Hz'],
  ['카시오 손목시계 중 방수 사양으로 골라줘', '카시오 손목시계 비방수'],
  ['카시오 손목시계 중 방수 사양으로 골라줘', '세이코 손목시계 방수'],
  ['위닉스 공기청정기 중 필터 등급 H13 사양으로 골라줘', '위닉스 공기청정기 필터 필터 등급 H13'],
  ['위닉스 공기청정기 중 필터 등급 H13 사양으로 골라줘', '위닉스 공기청정기 필터 등급 H11'],
  ['테팔 프라이팬 중 지름 28cm 사양으로 골라줘', '테팔 프라이팬 지름 24cm'],
  ['노트북 16GB', 'LG 그램 노트북 8GB RAM'],
]) {
  assert.equal(verdict(query, title).ok, false, query + ' / ' + title);
  assert.equal(gate.saveFilter(query, [{title, lprice: 500000}]).save.length, 0, 'must not store ' + title);
}
for (const [query, title, price = 500000] of [
  ['아이패드 10세대', '아이패드 10세대 256GB + 케이스 증정'],
  ['아이패드 10세대', '아이패드 10세대 + 케이스 + 필름 증정'],
  ['갤럭시 S24', '갤럭시 S24 256GB + 케이스 + 충전기 증정'],
  ['로봇 청소기 추천하되 로보락 브랜드는 제외해줘', '삼성 로봇 청소기'],
  ['전기장판', '한일 전기장판'],
  ['텐트 폴대', '코베아 텐트 폴대'],
  ['16GB RAM 노트북', '삼성 노트북 RAM 16GB SSD 512GB'],
  ['16GB RAM 노트북', '삼성 노트북 16GB RAM 512GB SSD'],
  ['64GB RAM 노트북', '삼성 노트북 RAM 64GB SSD 1TB'],
  ['64GB RAM 노트북', '삼성 노트북 64GB RAM 1TB SSD'],
  ['64GB RAM 노트북', '삼성 노트북 SSD 16GB 64GB RAM'],
  ['64GB RAM 노트북', '삼성 노트북 RAM 64GB 1TB SSD'],
  ['64GB RAM 노트북', '삼성 노트북 1TB SSD RAM 64GB'],
  ['식탁 의자 추천하되 한샘 브랜드는 제외해줘', '일룸 식탁 의자'],
  ['가습기 1.7L', '가습기 1700ml'],
  ['책상', '책상 서랍 포함'],
  ['카시오 손목시계 중 방수 사양으로 골라줘', '카시오 손목시계 방수'],
  ['로보락 로봇 청소기 중 물통 300ml 사양으로 골라줘', '로보락 로봇 청소기 물통 300ml'],
  ['위닉스 공기청정기 중 필터 등급 H13 사양으로 골라줘', '위닉스 공기청정기 필터 등급 H13'],
  ['테팔 프라이팬 본품을 사고 싶어. 사은품이 같이 와도 돼', '테팔 프라이팬 본품'],
  ['테팔 프라이팬 중 지름 28cm 사양으로 골라줘', '테팔 프라이팬 지름 28cm'],
  ['식탁 의자에서 원목 조건과 10만원 이하 가격을 동시에 충족하는 것', '한샘 식탁 의자 원목', 60000],
  ['로보락 로봇 청소기에 쓸 전용 브러시만 보여줘', '로보락 로봇 청소기용 전용 브러시'],
]) {
  assert.equal(verdict(query, title, price).ok, true, query + ' / ' + title);
}
for (const [query, title, price, why] of [
  ['전기장판 신품만', '한일 전기장판', 500000, 'condition_unverified'],
  ['가습기 1.7L', '가습기', 500000, 'measure_unverified'],
  ['손목시계 방수', '손목시계', 500000, 'waterproof_unverified'],
  ['100만원 이하 노트북', '삼성 노트북', 0, 'price_unverified'],
  ['식탁 의자 추천하되 한샘 브랜드는 제외해줘', '식탁 의자', 500000, 'excluded_brand_unverified'],
  ['소니 헤드폰 중 무선 사양으로 골라줘', '소니 헤드폰', 500000, 'wireless_unverified'],
  ['위닉스 공기청정기 중 필터 등급 H13 사양으로 골라줘', '위닉스 공기청정기', 500000, 'filter_grade_unverified'],
]) {
  const result = gate.saveFilter(query, [{ title, lprice: price }]);
  assert.equal(result.save.length, 0, 'unknown evidence must not be stored: ' + title);
  assert.equal(result.held.length, 1, 'unknown evidence must be held: ' + title);
  assert.ok(result.held[0].identityWhy.includes(why), result.held[0].identityWhy);
}
const aiUnknown = gate.gateItems('16GB RAM 노트북', [{ title: '삼성 노트북', price: 500000 }], { identityOnly: true });
assert.equal(aiUnknown.kept.length, 1);
assert.equal(aiUnknown.kept[0].identity, 'unverified');
assert.match(aiUnknown.kept[0].identityWhy, /memory_unverified/);
console.log('product gate recovery: 57 cases passed');
