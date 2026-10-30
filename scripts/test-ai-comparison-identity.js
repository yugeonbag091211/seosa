'use strict';

// The real handler is exercised with mock GPT and offline search fixtures.
const assert = require('node:assert/strict');
const H = require('./_ai-chat-harness');
const AC = require('../api/_aicontext');
[
  { pid: 'PAIR-IPAD', vid: '', title: 'Apple 아이패드 11 A16 128GB Wi-Fi 태블릿', price: 410000, keys: ['아이패드'] },
  { pid: 'PAIR-TAB', vid: 'TAB-OPT', title: '삼성 갤럭시탭 S9 FE 128GB Wi-Fi 태블릿', price: 450000, keys: ['갤럭시탭'] }
].forEach(p => H.addProduct({ ...p, mall: '쿠팡', history: [[0, p.price]] }));

(async () => {
  const q = '아이패드 11 A16 vs 갤럭시탭 S9 FE 가격 비교해줘';
  const r = await H.ask({ question: q }, { classify: 'B', answer: '사용 목적을 확인해 보세요.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.comparison.complete, false, JSON.stringify(r.body));
  assert.deepEqual((r.body.items || []).map(x => x.productId), ['PAIR-TAB']);
  assert.ok(!r.body.text.includes('410,000원'), '옵션이 불명확한 가격은 비교에 쓰지 않는다');
  assert.ok(!/표시 가격 차이는/.test(r.body.text), '비교가 불완전하면 차액을 만들지 않는다');
  const state = AC.verifyConversationState(r.body.convState);
  assert.ok(!state || !state.comparison || state.comparison.length === 0, '불완전한 비교는 서명 상태로 저장하지 않는다');

  const ipad = H.catalog.find(x => x.productId === 'PAIR-IPAD');
  ipad.vendorItemId = 'IPAD-OPT';
  const complete = await H.ask({ question: q }, { classify: 'B', answer: '사용 목적을 확인해 보세요.' });
  assert.equal(complete.body.comparison.complete, true);
  assert.deepEqual(new Set((complete.body.items || []).map(x => x.vendorItemId)), new Set(['IPAD-OPT', 'TAB-OPT']));

  ipad.productId = '';
  const noProduct = await H.ask({ question: q }, { classify: 'B', answer: '사용 목적을 확인해 보세요.' });
  assert.equal(noProduct.body.comparison.complete, false);
  assert.deepEqual((noProduct.body.items || []).map(x => x.productId), ['PAIR-TAB']);
  assert.ok(!noProduct.body.text.includes('410,000원'));

  ipad.productId = 'ADPICK-IPAD';
  ipad.vendorItemId = '';
  ipad.mall = 'ADPICK';
  ipad.isCoupang = false;
  ipad.link = 'https://biz.adpick.co.kr/link/ADPICK-IPAD';
  const adpick = await H.ask({ question: q }, { classify: 'B', answer: '사용 목적을 확인해 보세요.' });
  assert.equal(adpick.body.comparison.complete, true, JSON.stringify(adpick.body));
  assert.deepEqual(new Set((adpick.body.items || []).map(x => x.productId)), new Set(['ADPICK-IPAD', 'PAIR-TAB']));
  assert.equal(H.counters.external, 0);
  assert.equal(H.counters.dbWrites, 0);
  console.log('AI_COMPARISON_IDENTITY: 4/4 PASS; mock GPT, external API 0, DB writes 0');
})().catch(e => { console.error(e); process.exitCode = 1; });
