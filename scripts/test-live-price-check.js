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

test('snapshot checker requires window coverage days, not the number of times the low itself appeared', () => {
  const q = { kind: 'low30', lowPrice: 293420, lowDate: '2026-10-14', observedDays: 29, lowObservedCount: 1 };
  assert.equal(snapshotQuestionCheck(q,
    '최근 30일 관측 최저가는 293,420원이며, 2026년 10월 14일에 확인됐습니다. 해당 가격은 1일 관측됐습니다.'), false);
  assert.equal(snapshotQuestionCheck(q,
    '최근 30일 관측 최저가는 293,420원이며, 2026년 10월 14일에 확인됐습니다. 최저가는 1일 관측됐고, 최근 30일 가격 기록은 29일치입니다.'), true);
  assert.equal(snapshotQuestionCheck(q,
    '최근 30일 최저 관측가는 293,420원이며, 2026년 10월 14일에 확인됐습니다. 해당 가격은 6일 관측됐습니다. 최근 30일 기록은 29일치입니다.'), false);
});

test('snapshot checker accepts a record-day count in a separate clause with markdown emphasis', () => {
  const q = { kind: 'low7', lowPrice: 125000, lowDate: '2026-10-20', observedDays: 6, lowObservedCount: 1 };
  assert.equal(snapshotQuestionCheck(q,
    '최근 7일 최저 관측가는 **125,000원(2026년 10월 20일)**입니다. 가격 기록은 **6일** 있으며, 해당 최저가는 그중 **1회** 관측됐습니다.'), true);
});

test('snapshot checker distinguishes all-time observed low from a recent-window low', () => {
  assert.equal(snapshotQuestionCheck({ kind: 'allTime', lowPrice: 99890 }, '관측 기록 전체의 역대 최저가는 99,890원입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'allTime', lowPrice: 99890 }, 'SEOSA 보유 가격 기록 전체에서 확인된 최저 관측가도 99,890원입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'allTime', lowPrice: 99890 }, '최근 7일 최저가는 99,890원입니다.'), false);
});

test('snapshot checker only accepts an unconfirmed all-time-low candidate with its date and observation count', () => {
  const q = { kind: 'allTime', lowPrice: 1699000, lowDate: '2026-10-19', observedCount: 1, confirmed: false };
  assert.equal(snapshotQuestionCheck(q, '관측 최저 후보 1,699,000원은 2026년 10월 19일 하루만 관측돼 기록 최저로 확정할 수 없습니다.'), true);
  assert.equal(snapshotQuestionCheck(q, '역대 최저가 1,699,000원입니다.'), false);
  assert.equal(snapshotQuestionCheck(q, '관측 최저 후보 1,699,000원은 2026년 10월 19일 3회 관측돼 확정할 수 없습니다.'), false);
  assert.equal(snapshotQuestionCheck({ ...q, lowPrice: 125000, lowDate: '2026-10-20' }, '현재가는 128,250원이며, 확인된 관측 기록만으로는 역대 최저가라고 할 수 없습니다. 125,000원이 2026년 10월 20일 한 번 관측됐지만, 단 한 번이라 기록 최저인지 확인 중입니다. 현재 가격은 그 후보보다 3,250원 높습니다.'), true);
  assert.equal(snapshotQuestionCheck({ ...q, lowPrice: 125000, lowDate: '2026-10-20' }, '아니요. 현재가는 128,250원이고, SEOSA의 관측 기록 범위에서는 최저가가 아닙니다. 2026년 10월 20일에 125,000원이 관측됐지만 한 번뿐이라 기록 최저가로 확정되지는 않았습니다. 현재 기록은 17일치이며, 최근 30일에는 14일간 가격을 관측했습니다.'), true);
  assert.equal(snapshotQuestionCheck(q, '1,699,000원이 2026년 10월 19일에 관측됐지만 한 번만 확인돼 기록 최저가인지는 아직 확정되지 않았습니다.'), true);
  assert.equal(snapshotQuestionCheck({ ...q, lowPrice: 332100, lowDate: '2026-10-15' },
    '보유한 25일치 기록에서 가장 낮게 관측된 332,100원보다 현재가가 높습니다. 332,100원은 2026년 10월 15일 한 번만 확인돼 기록상 최저가인지는 아직 확정되지 않았습니다.'), true);
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
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB 옵션은 확인된 검색 상품이나 가격 기록이 없어 가격을 말할 수 없습니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '확인된 검색 결과는 256GB 옵션이고, 512GB 옵션 가격은 확인할 수 없습니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB 옵션은 이번 검색 결과에서 확인되지 않습니다. 확인 가능한 상품은 256GB입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '「Galaxy Book4 Pro 512gb」 조건에 정확히 맞는 상품은 찾지 못했어요. 256gb 상품은 1,749,000원입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '검색 결과에서 같은 NT940XGQ-A51AG 모델의 512GB 옵션은 확인되지 않았습니다. 가장 가까운 상품은 256GB 옵션으로 현재 1,749,000원이지만, 용량이 달라 512GB 가격으로 볼 수는 없습니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB 옵션 가격은 확인되지 않았습니다. 확인된 256GB 옵션은 1,749,000원입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB는 확인되지 않았고, 256GB 옵션은 1,749,000원입니다.'), true);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB 옵션은 1,699,000원입니다.'), false);
  assert.equal(snapshotQuestionCheck({ kind: 'unavailable', option: '512GB' }, '512GB는 확인되지 않았지만 1,699,000원에 판매 중입니다.'), false);
});
