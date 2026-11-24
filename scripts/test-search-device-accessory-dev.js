#!/usr/bin/env node
'use strict';

// Development counterexamples: an accessory word or a desk description does
// not prove that the main item is an accessory. No external calls or DB access.
const assert = require('node:assert/strict');
const S = require('../api/_search');
const cases = [
  ['커피머신', '커피머신 원두 투입구 덮개 있는 전자동 커피머신'],
  ['커피머신', '커피머신 원두 전용 추출기 덮개 분리형 본체'],
  ['노트북', '삼성 노트북 본체 저반사 화면 1매 사은품 포함'],
  ['노트북', '노트북 저반사 화면 1매 사은품 제공 삼성 갤럭시북'],
  ['게이밍 노트북', '게이밍 노트북 본체 책상 사은품 일자형']
];
for (const [query, title] of cases) {
  const item = { title, productId: title, lprice: 10000, mall: '쿠팡' };
  const result = S.rankItems(query, [item], { minScore: 0 }).items[0];
  assert.equal(result.relevance, 1, JSON.stringify(result));
}
for (const [query, title] of [
  ['냄비', '냄비 유리 덮개 포함 스테인리스 양수 냄비'],
  ['쓰레기통', '쓰레기통 덮개 있는 자동 센서'],
  ['밥솥', '밥솥 덮개 내장 쿠쿠 전기밥솥'],
  ['전자레인지', '전자레인지 덮개 있는 20L 본체']
]) {
  const item = { title, productId: title, lprice: 10000, mall: '쿠팡' };
  assert.equal(S.filterMainProductCandidates(query, [item]).items.length, 1, title);
}
console.log('Device accessory counterexamples: 9/9 PASS');
