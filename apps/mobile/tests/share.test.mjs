import test from 'node:test';
import assert from 'node:assert/strict';
import { productShareContent, productShareUrl } from '../lib/share.ts';

test('product share: uses the public SEOSA product page and safely encodes the id', () => {
  assert.equal(productShareUrl('123'), 'https://seosa.ai.kr/p/123');
  assert.equal(productShareUrl('abc / 한글'), 'https://seosa.ai.kr/p/abc%20%2F%20%ED%95%9C%EA%B8%80');
  assert.equal(productShareUrl('  '), 'https://seosa.ai.kr');
});

test('product share: includes title, current price and SEOSA URL without leaking a merchant link', () => {
  const content = productShareContent({ productId: '8082654809', title: '테스트 상품' }, 15900);
  assert.equal(content.title, '테스트 상품');
  assert.equal(content.url, 'https://seosa.ai.kr/p/8082654809');
  assert.match(content.message, /테스트 상품/);
  assert.match(content.message, /현재 15,900원/);
  assert.match(content.message, /SEOSA에서 가격 추이 보기/);
  assert.match(content.message, /https:\/\/seosa\.ai\.kr\/p\/8082654809/);
  assert.equal(content.message.includes('link.coupang.com'), false);
  assert.equal(content.message.includes('biz.adpick.co.kr'), false);
});

test('product share: omits invalid price instead of inventing a number', () => {
  const content = productShareContent({ productId: 'p1', title: '' }, Number.NaN);
  assert.equal(content.title, 'SEOSA 상품');
  assert.equal(content.message.includes('현재'), false);
});
