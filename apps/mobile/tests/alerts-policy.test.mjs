import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('mobile price alerts: route and user entry points stay wired', () => {
  const layout = read('../app/_layout.tsx');
  const me = read('../app/(tabs)/me.tsx');
  const product = read('../app/product/[key].tsx');
  assert.match(layout, /<Stack\.Screen name="alerts"/);
  assert.match(me, /label="가격 알림"/);
  assert.match(product, /목표가 알림/);
  assert.match(product, /rememberProduct\(\{ \.\.\.product, price: headline \}\)/);
});

test('mobile price alerts: privacy and terms disclose app alert processing', () => {
  const privacy = read('../../../public/privacy.html');
  const terms = read('../../../public/terms.html');
  assert.match(privacy, /가격 알림 \(웹·앱, 선택\)/);
  assert.match(privacy, /상품 ID·옵션 ID/);
  assert.match(privacy, /가격 알림 요청\(이메일·상품\/옵션 식별 정보·목표 가격\)/);
  assert.match(terms, /웹·앱의 가격 알림/);
});
