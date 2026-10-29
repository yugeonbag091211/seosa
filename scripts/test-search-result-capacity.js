'use strict';

/**
 * Expanded result-capacity regression.  No real marketplace/API/DB calls.
 * Verifies that a single combined search can expose all 10 Coupang + 20
 * ADPICK slots and that a fresh AI search can inspect/display 12, without
 * violating the one-product-card follow-up behavior tested elsewhere.
 */
const assert = require('node:assert/strict');
const H = require('./_ai-chat-harness');
const shop = require('../api/_shop');

const SI = require('../api/_shopintent');
for (const phrase of ['가격 상한 350,000원으로 무선 이어폰 찾아 줘', '예산 상한 350,000원인 무선 이어폰']) {
  const budget = SI.parseConstraints(phrase);
  assert.equal(budget.budgetMax, 350000, phrase + ': hard ceiling must be preserved');
  assert.equal(budget.budgetSoft, false, phrase + ': explicit ceiling is not soft');
}
const softBudget = SI.parseConstraints('무선 이어폰 35만원 정도로 추천해 줘');
assert.equal(softBudget.budgetSoft, true, 'approximate budget remains flexible');

const KEYWORD = '무선 이어폰';
for (let i = 0; i < 30; i++) {
  H.addProduct({
    pid: 'CAPACITY-QA-' + i,
    vid: 'CAPACITY-QA-OPT-' + i,
    title: '무선 이어폰 검색확장 모델 ' + (i + 1) + ' 블루투스',
    price: 69000 + i * 1000,
    keys: [KEYWORD],
    history: [[1, 69000 + i * 1000], [0, 69000 + i * 1000]]
  });
}
const all = H.catalog.map(({ _keys, ...row }) => row);
const requests = [];
const originalSearchAll = shop.searchAll;

shop.searchAll = async (keyword, options = {}) => {
  requests.push({
    keyword, source: options.coupangOpts && options.coupangOpts.source,
    coupangLimit: options.coupangLimit, adpickLimit: options.adpickLimit
  });
  if (options.coupangOpts && options.coupangOpts.source === 'search') {
    const requested = (options.coupangLimit || 6) + (options.adpickLimit || 10);
    const items = all.slice(0, requested);
    return { items, allItems: items, from: 'api', blocked: false, failed: false };
  }
  return originalSearchAll(keyword, options);
};
shop.saveProducts = async () => ({ saved: 0 });
require('../api/_trust').attachTrust = async () => {};
require('../api/_facets').attachPriceChange = async () => {};
// Require only *after* stubbing searchAll: /api/search destructures imports.
const search = require('../api/search');

(async () => {
  const headers = {};
  let result = null;
  let status = 200;
  const response = {
    status(n) { status = n; return this; },
    setHeader(k, v) { headers[k] = v; return this; },
    json(x) { result = x; return this; }
  };
  await search({ method: 'GET', headers: {}, query: { keyword: KEYWORD } }, response);
  assert.equal(status, 200, 'search endpoint must succeed');
  assert.ok(Array.isArray(result), 'search endpoint must retain array response contract');
  assert.equal(result.length, 30, 'one search should show all 10 + 20 matching provider results');
  assert.equal(requests.length, 1, 'one HTTP search must not trigger repeated searchAll calls');
  assert.equal(requests[0].coupangLimit, 10, 'Coupang per-request limit must stay <= 10');
  assert.equal(requests[0].adpickLimit, 20, 'ADPICK per-request limit must stay <= 20');

  const before = requests.length;
  const reply = await H.ask({ question: '무선 이어폰 추천해 줘' }, {
    classify: 'C|무선 이어폰',
    answer: '검증된 무선 이어폰 후보를 보여드릴게요.'
  });
  assert.equal(reply.status, 200);
  assert.equal(requests.length, before + 1,
    'one AI search must not trigger extra searchAll calls');
  assert.equal(requests.at(-1).source, 'ai');
  assert.equal(requests.at(-1).coupangLimit, 10);
  assert.equal(requests.at(-1).adpickLimit, 20);
  assert.equal(reply.searches, 1, 'mocked shopping search must run once');
  assert.equal((reply.body.items || []).length, 12,
    'AI should expose 12 identity-gated candidates for a broad first-turn request');
  assert.ok((reply.body.items || []).every(c => /무선 이어폰/.test(c.title)),
    'additional cards may not be unrelated merchandise');
  assert.equal(H.counters.external, 0, 'no real marketplace calls');
  assert.equal(H.counters.dbWrites, 0, 'no production DB writes');
  console.log('SEARCH_CAPACITY_PASS: web 30 cards, AI first turn 12 cards, 1 combined provider search each, external 0, DB writes 0');
})().catch(err => { console.error('SEARCH_CAPACITY_FAIL', err); process.exitCode = 1; });
