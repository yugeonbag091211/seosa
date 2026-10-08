#!/usr/bin/env node
'use strict';

/* Deterministic, offline tests for identity-bound ranking, price, and references. */
const H = require('./_ai-offline-harness.js');
const S = require('../api/_search.js');
const AC = require('../api/_aicontext.js');
const { stub, call, reset } = H;

let pass = 0;
let fail = 0;
const failures = [];
function ok(value, name, detail = '') {
  if (value) pass++;
  else { fail++; failures.push(name); }
  console.log(`  [${value ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function earbuds() {
  return [
    { title: 'Alpha 무선 이어폰 기본형', lprice: 39000, link: 'https://l/p1', image: '', mall: '쿠팡', productId: 'P1', vendorItemId: 'V1', isCoupang: true },
    { title: 'Beta 무선 이어폰 프로', lprice: 79000, link: 'https://l/p2', image: '', mall: '쿠팡', productId: 'P2', vendorItemId: 'V2', isCoupang: true },
    { title: 'Gamma 무선 이어폰 울트라', lprice: 109000, link: 'https://l/p3', image: '', mall: '쿠팡', productId: 'P3', vendorItemId: 'V3', isCoupang: true }
  ];
}

function mismatch(query, expectedTitle, otherTitle) {
  const analysis = S.analyzeQuery(query, { titles: [expectedTitle, otherTitle] });
  return S.modelVariantMismatch(analysis, otherTitle);
}

async function run() {
  console.log('\n[A] model parser: related variants and false positives');
  ok(!mismatch('G304 BK', 'Logitech G304 BK mouse', 'Logitech G304 LIGHTSPEED Black mouse'),
    'G304 BK is a color code, not a model suffix');
  ok(!mismatch('G304 K/DA', 'Logitech G304 K/DA mouse', 'Logitech G304 LIGHTSPEED mouse'),
    'G304 K/DA does not create a one-letter K model suffix');
  ok(!!mismatch('Galaxy Buds3', 'Samsung Galaxy Buds3 earbuds', 'Samsung Galaxy Buds3 Pro earbuds'),
    'Buds3 and Buds3 Pro remain distinct');
  ok(!!mismatch('AirPods Pro 2', 'Apple AirPods Pro 2 earbuds', 'Apple AirPods Pro 3 earbuds'),
    'AirPods Pro generations remain distinct');
  ok(!!mismatch('iPhone 17 Pro', 'Apple iPhone 17 Pro phone', 'Apple iPhone 17 Pro Max phone'),
    'iPhone Pro and Pro Max remain distinct');
  ok(!!mismatch('Dyson V15 Detect', 'Dyson V15 Detect vacuum', 'Dyson V15 vacuum'),
    'Dyson V15 and V15 Detect remain distinct');
  ok(!!mismatch('MX Master 3S', 'Logitech MX Master 3S mouse', 'Logitech MX Master 3 mouse'),
    'MX Master 3 and 3S remain distinct');
  ok(!!mismatch('iPhone 17 Pro Max', 'Apple iPhone 17 Pro Max', 'Apple iPhone17Pro'),
    'no-space title still exposes missing Pro Max');
  const noSpaceExact = S.analyzeQuery('iPhone 17 Pro Max', { titles: ['Apple iPhone 17 Pro Max', 'Apple iPhone17ProMax'] });
  ok(!S.modelVariantMismatch(noSpaceExact, 'Apple iPhone17ProMax'),
    'no-space title with the requested Pro Max remains an exact match');
  console.log('\n[B] accessory subtype and unrelated top-three candidates');
  const accessoryQuery = 'AirPods Pro 3 charging case';
  const accessoryTitles = ['AirPods Pro 3 charging case', 'AirPods Pro 3 silicone protective case'];
  const accessoryAnalysis = S.analyzeQuery(accessoryQuery, { titles: accessoryTitles });
  ok(S.accessoryRequestMismatch(accessoryAnalysis, accessoryTitles[1]),
    'protective case does not satisfy a charging-case request');
  const contaminated = S.rankItems('Apple AirPods Pro 3', [
    { productId: 'A1', mall: '쿠팡', vendorItemId: 'V1', title: 'Apple AirPods Pro 3 earbuds', lprice: 329000 },
    { productId: 'A2', mall: '쿠팡', vendorItemId: 'V2', title: 'Apple AirPods Pro 2 earbuds', lprice: 199000 },
    { productId: 'A3', mall: '쿠팡', vendorItemId: 'V3', title: 'Apple iPhone 17 phone', lprice: 1000 },
    { productId: 'A4', mall: '쿠팡', vendorItemId: 'V4', title: 'Stainless water bottle', lprice: 500 }
  ]).items.slice(0, 3).map(item => item.productId);
  ok(!contaminated.includes('A3') && !contaminated.includes('A4'),
    'unrelated products stay out of the top three', contaminated.join(','));
  reset([
    { productId: 'A1', mall: '쿠팡', vendorItemId: 'V1', title: 'Apple AirPods Pro 3 earbuds', lprice: 329000, isCoupang: true },
    { productId: 'A2', mall: '쿠팡', vendorItemId: 'V2', title: 'Apple AirPods Pro 2 earbuds', lprice: 199000, isCoupang: true },
    { productId: 'A3', mall: '쿠팡', vendorItemId: 'V3', title: 'Apple iPhone 17 phone', lprice: 1000, isCoupang: true },
    { productId: 'A4', mall: '쿠팡', vendorItemId: 'V4', title: 'Stainless water bottle', lprice: 500, isCoupang: true }
  ]);
  const aiContamination = await call({ question: 'Apple AirPods Pro 3 price', contextProducts: [], chatHistory: [], view: { source: 'none' } }, { sessionKey: 'contamination' });
  const aiTopThree = (aiContamination.body.items || []).slice(0, 3).map(item => item.productId);
  ok(!aiTopThree.includes('A3') && !aiTopThree.includes('A4'),
    'AI recommendation cards also exclude unrelated top-three contamination', aiTopThree.join(','));

  console.log('\n[C] recommendation ordinal and alias binding');
  reset(earbuds());
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = 'Alpha 무선 이어폰 기본형과 Beta 프로, Gamma 울트라를 비교했습니다.';
  const first = await call({ question: '무선 이어폰 추천', contextProducts: [], chatHistory: [], view: { source: 'none' } }, { sessionKey: 'ordinal' });
  const listed = (first.body.items || []).slice(0, 3).map(item => item.productId);
  ok(listed.length === 3 && !!first.body.topRecommendationRef,
    'recommendation returns three identified cards and a signed reference', listed.join(','));
  const history = [{ role: 'user', text: '무선 이어폰 추천' },
    { role: 'assistant', text: first.body.text, sig: first.body.turnSig }];
  stub.llm.classify = 'D|무선 이어폰';
  stub.llm.answer = '첫 번째 상품을 A로 지정했습니다.';
  const aliasA = await call({ question: '이걸 A라고 할게', contextProducts: [], chatHistory: history,
    view: { source: 'none' }, prevTopRef: first.body.topRecommendationRef }, { sessionKey: 'ordinal' });
  const historyA = history.concat([{ role: 'user', text: '이걸 A라고 할게' },
    { role: 'assistant', text: aliasA.body.text, sig: aliasA.body.turnSig }]);
  stub.llm.classify = 'D|무선 이어폰';
  stub.llm.answer = '두 번째 상품입니다.';
  const secondSelection = await call({ question: '두 번째 상품 가격 알려줘', contextProducts: [], chatHistory: historyA,
    view: { source: 'none' }, prevTopRef: aliasA.body.topRecommendationRef }, { sessionKey: 'ordinal' });
  const historySecond = historyA.concat([{ role: 'user', text: '두 번째 상품 가격 알려줘' },
    { role: 'assistant', text: secondSelection.body.text, sig: secondSelection.body.turnSig }]);
  stub.llm.classify = 'D|무선 이어폰';
  stub.llm.answer = '두 번째 상품을 B로 지정했습니다.';
  const aliasB = await call({ question: '이걸 B라고 할게', contextProducts: [], chatHistory: historySecond,
    view: { source: 'none' }, prevTopRef: secondSelection.body.topRecommendationRef }, { sessionKey: 'ordinal' });
  const phrases = ['첫 번째 상품 가격 알려줘', '두 번째 상품 가격 알려줘', '세 번째 상품 가격 알려줘'];
  for (let i = 0; i < phrases.length; i++) {
    const next = await call({ question: phrases[i], contextProducts: [], chatHistory: [], view: { source: 'none' }, prevTopRef: first.body.topRecommendationRef }, { sessionKey: 'ordinal' });
    const ordinalName = ['first', 'second', 'third'][i];
    ok(((next.body.items || [])[0] || {}).productId === listed[i], `${ordinalName} ordinal resolves to its signed list item`,
      `wanted=${listed[i]} got=${((next.body.items || [])[0] || {}).productId || 'none'}`);
  }
  for (let i = 0; i < 2; i++) {
    const alias = String.fromCharCode(65 + i);
    const next = await call({ question: `${alias} 상품 가격 알려줘`, contextProducts: [], chatHistory: historyA, view: { source: 'none' }, prevTopRef: aliasB.body.topRecommendationRef }, { sessionKey: 'ordinal' });
    ok(((next.body.items || [])[0] || {}).productId === listed[i], `${alias} alias binds to the corresponding card`,
      `wanted=${listed[i]} got=${((next.body.items || [])[0] || {}).productId || 'none'}`);
  }

  console.log('\n[D] selected identity and price stay bound to the server catalog row');
  const selected = listed[1];
  const canonical = earbuds().find(item => item.productId === selected);
  const impostor = earbuds().find(item => item.productId !== selected);
  stub.llm.answer = `${impostor.title} is currently 1원.`;
  const bound = await call({
    question: '이 제품 현재 가격 알려줘',
    contextProducts: [{ productId: canonical.productId, vendorItemId: canonical.vendorItemId, mall: canonical.mall,
      title: impostor.title, lprice: 1, price: 1, listPrice: 999999 }],
    chatHistory: [], view: { source: 'modal' }
  }, { sessionKey: 'ordinal' });
  ok(bound.body.topProductId === canonical.productId, 'selected productId survives a forged display title');
  ok(String(bound.body.text).includes(canonical.title), 'server catalog title replaces the client title');
  ok(String(bound.body.text).includes(canonical.lprice.toLocaleString('en-US')) && !/1원|999,999/.test(bound.body.text),
    'price comes from the selected product and vendorItemId', String(bound.body.text).slice(0, 90));
  const wrongOption = await call({
    question: '이 제품 현재 가격 알려줘',
    contextProducts: [{ productId: canonical.productId, vendorItemId: impostor.vendorItemId, mall: canonical.mall,
      title: canonical.title, lprice: canonical.lprice }],
    chatHistory: [], view: { source: 'modal' }
  }, { sessionKey: 'ordinal' });
  ok(!wrongOption.body.topProductId && !String(wrongOption.body.text).includes(canonical.lprice.toLocaleString('en-US')),
    'a different vendorItemId cannot borrow the selected product price');
  const wrongProduct = await call({
    question: '이 제품 현재 가격 알려줘',
    contextProducts: [{ productId: impostor.productId, vendorItemId: canonical.vendorItemId, mall: canonical.mall,
      title: canonical.title, lprice: canonical.lprice }],
    chatHistory: [], view: { source: 'modal' }
  }, { sessionKey: 'ordinal' });
  ok(!wrongProduct.body.topProductId && !String(wrongProduct.body.text).includes(canonical.lprice.toLocaleString('en-US')),
    'a different productId cannot borrow the selected product price');

  const catalogRow = stub.catalog.find(row => String(row.product_id) === canonical.productId);
  const savedTitle = catalogRow && catalogRow.title;
  if (catalogRow) catalogRow.title = impostor.title;
  const titleMutation = await call({ question: 'B 상품 가격 알려줘', contextProducts: [], chatHistory: [],
    view: { source: 'none' }, prevTopRef: aliasB.body.topRecommendationRef }, { sessionKey: 'ordinal' });
  if (catalogRow) catalogRow.title = savedTitle;
  ok(!titleMutation.body.topProductId && !String(titleMutation.body.text).includes(canonical.lprice.toLocaleString('en-US')),
    'a catalog title mutation invalidates the signed product identity');

  console.log('\n[E] signed recommendation cannot replay across browser sessions');
  reset(earbuds());
  stub.email = 'session-A@seosa.local';
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = 'Alpha 무선 이어폰을 추천합니다.';
  const sessionA = await call({ question: '무선 이어폰 추천', contextProducts: [], chatHistory: [], view: { source: 'none' } }, { sessionKey: 'session-A' });
  stub.email = 'session-B@seosa.local';
  const replay = await call({ question: '그거 가격 알려줘', contextProducts: [], chatHistory: [], view: { source: 'none' }, prevTopRef: sessionA.body.topRecommendationRef }, { sessionKey: 'session-B' });
  ok(!!sessionA.body.topRecommendationRef, 'session A receives a signed reference');
  ok(!(replay.body.items || []).length && !replay.body.topProductId,
    'session B cannot resolve session A reference', `cards=${(replay.body.items || []).length} top=${replay.body.topProductId || 'none'}`);
  stub.email = 'qa@seosa.local';

  console.log('\n[F] reference MAC remains mutation-sensitive');
  const valid = AC.createRecommendationRef({ productId: 'MAC-P', vendorItemId: 'MAC-V', mall: '쿠팡' });
  ok(!!AC.verifyRecommendationRef(valid), 'original recommendation reference verifies');
  const macStart = String(valid).lastIndexOf('.') + 1;
  const originalMacChar = String(valid)[macStart];
  const replacementMacChar = originalMacChar === 'A' ? 'B' : 'A';
  const changedMac = String(valid).slice(0, macStart) + replacementMacChar + String(valid).slice(macStart + 1);
  ok(!AC.verifyRecommendationRef(changedMac), 'one-character MAC mutation is rejected');

  console.log(`\n=== RESULT ${pass} PASS / ${fail} FAIL ===`);
  if (fail) {
    console.log('Failed assertions:');
    failures.forEach(name => console.log(`  - ${name}`));
    process.exitCode = 1;
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
