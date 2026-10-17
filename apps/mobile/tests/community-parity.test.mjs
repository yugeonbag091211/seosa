import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../lib/api.ts';
import { parseCommunityDeals } from '../lib/parse.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const post = {
  id: 'community:92', title: '무선 헤드폰 &amp; 케이스', price: 25000,
  image: 'https://example.com/photo.jpg', sourceUrl: 'https://example.com/deal/92',
  source: 'forum', mall: '쇼핑몰', verified: false, communityOnly: true,
  affiliateUrl: 'https://untrusted.invalid/sale',
};

test('community discoveries use the source link, not guessed merchant or affiliate links', async () => {
  const urls = [];
  const api = createApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async (url) => {
      urls.push(url);
      return { status: 200, headers: { get: () => null }, json: async () => ({ items: [post] }) };
    },
  });
  const items = await api.communityDeals();
  assert.equal(urls.length, 1);
  const u = new URL(urls[0]);
  assert.equal(u.pathname, '/api/hotdeals');
  assert.equal(u.searchParams.get('view'), 'external');
  assert.equal(u.searchParams.get('limit'), '60');
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceUrl, post.sourceUrl);
  assert.equal(items[0].verified, false);
  assert.equal(items[0].title, '무선 헤드폰 & 케이스');
  assert.ok(!('affiliateUrl' in items[0]), 'partner links do not reach the discovery card');
});

test('verified label is only taken from an explicitly server-verified external item', () => {
  const rows = parseCommunityDeals({ items: [
    post,
    { ...post, id: 'external:88', verified: true, communityOnly: false },
    { ...post, id: 'community:99', verified: true, communityOnly: true },
  ] });
  assert.deepEqual(rows.map(p => p.verified), [false, true, false]);
});

test('discard missing, malformed and non-HTTPS source URLs; never invent a 0 won price', () => {
  const rows = parseCommunityDeals({ items: [
    post, null, {}, { ...post, id: '', title: 'x' },
    { ...post, id: 'unsafe', sourceUrl: 'javascript:alert(1)' },
    { ...post, id: 'insecure', sourceUrl: 'http://example.com' },
    { ...post, id: 'missing-title', title: '' },
    { ...post, id: 'price-missing', price: 'not a price' },
  ] });
  assert.deepEqual(rows.map(r => r.id), ['community:92', 'price-missing']);
  assert.equal(rows[1].price, 0, 'zero means unknown, the component prints "가격 확인 필요"');
  assert.match(source('components/CommunityDealRow.tsx'), /가격 확인 필요/);
});

test('website parity: home has category / AI / community feed but keeps price drops and curation', () => {
  const home = source('app/(tabs)/index.tsx');
  for (const feature of ['카테고리', '실시간 핫딜', '서사 AI에게 물어보기', '오늘 가격 하락', 'MonthlyPicks', 'useCommunityDeals', 'HeroCarousel']) {
    assert.ok(home.includes(feature), feature);
  }
  assert.ok(source('app/_layout.tsx').includes('name="community"'));
  assert.ok(source('app/community.tsx').includes('useCommunityDeals'));
});

test('community feed rejects broken endpoint payload', async () => {
  const api = createApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ items: 'bad' }) }),
  });
  await assert.rejects(api.communityDeals(), { kind: 'invalid_response' });
});
