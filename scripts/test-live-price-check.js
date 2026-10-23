'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { snapshotQuestionCheck } = require('./_live-price-check');

test('snapshot checker accepts a seven-day low with ordinary Korean spacing', () => {
  assert.equal(snapshotQuestionCheck({ kind: 'low7', lowPrice: 128250 }, '최근 7일 최저 관측가는 128,250원입니다.'), true);
});

test('snapshot checker accepts a thirty-day low with ordinary Korean spacing', () => {
  assert.equal(snapshotQuestionCheck({ kind: 'low30', lowPrice: 659600 }, '최근 30일 최저가는 659,600원입니다.'), true);
});

test('snapshot checker distinguishes all-time observed low from a recent-window low', () => {
  assert.equal(snapshotQuestionCheck({ kind: 'allTime', lowPrice: 99890 }, '관측 기록 전체의 역대 최저가는 99,890원입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'allTime', lowPrice: 99890 }, 'SEOSA 보유 가격 기록 전체에서 확인된 최저 관측가도 99,890원입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'allTime', lowPrice: 99890 }, '최근 7일 최저가는 99,890원입니다.'), false);
});

test('snapshot checker accepts a zero-won change', () => {
  assert.equal(snapshotQuestionCheck({ kind: 'yesterday', delta: 0, yesterdayPrice: 99890, currentPrice: 99890 }, '어제 99,890원, 오늘 99,890원으로 0원 변동입니다.'), true);
});

test('snapshot checker distinguishes increases from decreases', () => {
  assert.equal(snapshotQuestionCheck({ kind: 'yesterday', delta: 15000, yesterdayPrice: 143250, currentPrice: 128250 }, '어제 143,250원에서 오늘 128,250원으로 15,000원 하락했습니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'yesterday', delta: -15000, yesterdayPrice: 659600, currentPrice: 674600 }, '어제 659,600원에서 오늘 674,600원으로 15,000원 올랐습니다.'), true);
});

test('snapshot checker does not treat a missing yesterday observation as a known price change', () => {
  assert.equal(snapshotQuestionCheck({ kind: 'gap' }, '어제 기록이 없어 가격 변화를 확인할 수 없습니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'gap' }, '어제보다 1,000원 하락했습니다.'), false);
  assert.equal(snapshotQuestionCheck({ kind: 'gap' }, '어제 기록은 없지만 1,000원 하락했을 수 있습니다.'), false);
});

test('snapshot checker requires the exact observed current price and date', () => {
  const q = { kind: 'current', currentPrice: 1749000, lastDate: '2026-10-23' };
  assert.equal(snapshotQuestionCheck(q, '현재 확인 가격은 1,749,000원이며 마지막 관측일은 2026년 10월 23일입니다.'), true);
  assert.equal(snapshotQuestionCheck(q, '현재 확인 가격은 1,799,000원이며 마지막 관측일은 2026년 10월 23일입니다.'), false);
});

test('snapshot checker accepts grounded prices around a named history gap but rejects an invented delta', () => {
  const q = { kind: 'gap', gapDate: '2026-10-22', allowedPrices: [40900] };
  assert.equal(snapshotQuestionCheck(q, '2026년 10월 22일 가격 기록은 없습니다. 마지막 확인은 10월 15일 40,900원이고 다음 기록도 10월 23일 40,900원이라 가격 변화는 확인할 수 없습니다.'), true);
  assert.equal(snapshotQuestionCheck(q, '2026년 10월 22일 기록은 없지만 1,000원 하락했을 것 같습니다.'), false);
});

test('snapshot checker requires an unavailable option to stay unpriced', () => {
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '확인된 검색 결과는 256GB 옵션이고, 512GB 옵션 가격은 확인할 수 없습니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB 옵션은 이번 검색 결과에서 확인되지 않습니다. 확인 가능한 상품은 256GB입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB 옵션 가격은 확인되지 않았습니다. 확인된 256GB 옵션은 1,749,000원입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB는 확인되지 않았고, 256GB 옵션은 1,749,000원입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB 옵션은 1,699,000원입니다.'), false);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB는 확인되지 않았지만 1,699,000원에 판매 중입니다.'), false);
});
