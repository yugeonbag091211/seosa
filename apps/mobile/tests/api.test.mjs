import assert from 'node:assert/strict';
import test from 'node:test';
import { API_TIMEOUTS, ApiError, createApiClient, userMessage } from '../lib/api.ts';

const product = { title: '테스트 상품', lprice: 1000, mall: '쿠팡', productId: '123' };

test('search uses the existing keyword contract and returns products', async () => {
  const client = createApiClient(async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/search');
    assert.equal(new URL(url).searchParams.get('keyword'), '노트북');
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify([product]), { status: 200 });
  });
  assert.deepEqual(await client.search(' 노트북 '), [product]);
});

test('503 is an outage, not an empty result', async () => {
  const client = createApiClient(async () => new Response('{}', { status: 503 }));
  await assert.rejects(client.search('노트북'), error => {
    assert.equal(error.kind, 'unavailable');
    assert.notEqual(userMessage(error), '검색 결과가 없어요.');
    return true;
  });
});

test('a valid empty search stays an empty result', async () => {
  const client = createApiClient(async () => new Response('[]', { status: 200 }));
  assert.deepEqual(await client.search('없는상품'), []);
});

test('invalid JSON and invalid shape are visible errors', async () => {
  const badJson = createApiClient(async () => new Response('<html>error</html>'));
  await assert.rejects(badJson.search('노트북'), error => error.kind === 'invalid_response');
  const badShape = createApiClient(async () => new Response('{}'));
  await assert.rejects(badShape.search('노트북'), error => error.kind === 'invalid_response');
  const badItem = createApiClient(async () => new Response(JSON.stringify([{ title: 'broken' }])));
  await assert.rejects(badItem.search('노트북'), error => error.kind === 'invalid_response');
});

test('detail keeps product id and mall', async () => {
  const client = createApiClient(async url => {
    const request = new URL(url);
    assert.equal(request.searchParams.get('__route'), 'product');
    assert.equal(request.searchParams.get('pid'), '123');
    assert.equal(request.searchParams.get('mall'), '쿠팡');
    return new Response(JSON.stringify({ product, points: [], deal: null }));
  });
  assert.equal((await client.product('123', '쿠팡')).product.title, product.title);
});

test('malformed detail does not reach the screen', async () => {
  const client = createApiClient(async () => new Response(JSON.stringify({ product, points: [], deal: { verdict: 'BUY' } })));
  await assert.rejects(client.product('123'), error => error.kind === 'invalid_response');
  const wrongId = createApiClient(async () => new Response(JSON.stringify({ product: { ...product, productId: '999' }, points: [], deal: null })));
  await assert.rejects(wrongId.product('123'), error => error.kind === 'invalid_response');
});

test('price history requests the same option and server deal verdict', async () => {
  const client = createApiClient(async url => {
    const request = new URL(url);
    assert.equal(request.pathname, '/api/history');
    assert.equal(request.searchParams.get('productId'), '123');
    assert.equal(request.searchParams.get('mall'), '쿠팡');
    assert.equal(request.searchParams.get('vendorItemId'), 'option-1');
    assert.equal(request.searchParams.get('deal'), '1');
    return new Response(JSON.stringify({ points: [{ date: '2026-09-13', price: 1000 }], deal: { verdict: 'WATCH', label: '지켜볼 만하다', reasons: [], cautions: [] } }));
  });
  const history = await client.history({ ...product, vendorItemId: 'option-1' });
  assert.equal(history.deal.verdict, 'WATCH');
});

test('abort is mapped without showing a network error', async () => {
  const controller = new AbortController();
  const client = createApiClient((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const pending = client.search('노트북', controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error instanceof ApiError && error.kind === 'aborted' && userMessage(error) === '');
});

test('timeout is mapped separately from network failure', async () => {
  const client = createApiClient((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
  }), { searchMs: 5 });
  await assert.rejects(client.search('노트북'), error => error.kind === 'timeout');
});

test('search timeout is longer than detail and preserves explicit cancellation', async () => {
  assert.equal(API_TIMEOUTS.searchMs, 25_000);
  assert.equal(API_TIMEOUTS.detailMs, 15_000);
  const client = createApiClient((_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify([product]))), 25);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  }), { searchMs: 60, detailMs: 5 });
  assert.equal((await client.search('마우스')).length, 1);
  await assert.rejects(client.product('123'), error => error.kind === 'timeout');
});

test('home reads only the internal hotdeal feed', async () => {
  const deal = { title: '마우스', price: 15000, mall: '쿠팡', status: 'VERIFIED_HOT', productId: '123' };
  const client = createApiClient(async url => {
    const request = new URL(url);
    assert.equal(request.pathname, '/api/hotdeals');
    assert.equal(request.searchParams.get('source'), 'internal-history');
    assert.equal(request.searchParams.get('limit'), '4');
    return new Response(JSON.stringify({ items: [deal] }));
  });
  assert.deepEqual(await client.homeDeals(), [deal]);
});
