import assert from 'node:assert/strict';
import test from 'node:test';
import { API_TIMEOUTS, ApiError, apiBaseUrl, createApiClient, productFromParam, userMessage } from '../lib/api.ts';

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

test('productFromParam recovers the exact option a card was showing, vendorItemId included', () => {
  const optionA = { title: '노트북 15인치 · 실버', lprice: 1_200_000, mall: '쿠팡', productId: '123', vendorItemId: 'vendor-a' };
  assert.deepEqual(productFromParam(JSON.stringify(optionA)), optionA);
  assert.equal(productFromParam(undefined), null);
  assert.equal(productFromParam(''), null);
  assert.equal(productFromParam('not json'), null);
  assert.equal(productFromParam(JSON.stringify({ title: 'broken' })), null);
});

test('two cards sharing a productId+mall but different vendorItemId each open their own option', async () => {
  // Coupang packs option variants (e.g. 15인치 vs 17인치) under the same productId+mall; only
  // vendorItemId tells them apart. Each card's own data must reach the detail screen unmixed.
  const optionA = { title: '노트북 15인치', lprice: 1_200_000, mall: '쿠팡', productId: '123', vendorItemId: 'vendor-a' };
  const optionB = { title: '노트북 17인치', lprice: 1_600_000, mall: '쿠팡', productId: '123', vendorItemId: 'vendor-b' };

  // What index.tsx/search.tsx do: serialize the tapped card into the route param.
  const recoveredA = productFromParam(JSON.stringify(optionA));
  const recoveredB = productFromParam(JSON.stringify(optionB));
  assert.deepEqual(recoveredA, optionA);
  assert.deepEqual(recoveredB, optionB);
  assert.notEqual(recoveredA.vendorItemId, recoveredB.vendorItemId);

  // What product/[id].tsx does next: fetch history scoped to that exact option's vendorItemId.
  const requestedVendorIds = [];
  const client = createApiClient(async url => {
    requestedVendorIds.push(new URL(url).searchParams.get('vendorItemId'));
    return new Response(JSON.stringify({ points: [], deal: null }));
  });
  await client.history(recoveredA);
  await client.history(recoveredB);
  assert.deepEqual(requestedVendorIds, ['vendor-a', 'vendor-b']);
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

test('404 is not found, other 5xx are outages, 400 asks for a new keyword', async () => {
  const notFound = createApiClient(async () => new Response('{"error":"상품 없음"}', { status: 404 }));
  await assert.rejects(notFound.product('123'), error => error.kind === 'not_found' && userMessage(error) === '상품 정보를 찾을 수 없어요.');
  for (const status of [500, 502, 504]) {
    const outage = createApiClient(async () => new Response('', { status }));
    await assert.rejects(outage.search('노트북'), error => error.kind === 'unavailable' && error.status === status);
  }
  const bad = createApiClient(async () => new Response('{}', { status: 400 }));
  await assert.rejects(bad.search('노트북'), error => error.kind === 'request' && userMessage(error) === '검색어를 다시 입력해 주세요.');
});

test('no response at all is a network error, not a timeout', async () => {
  const client = createApiClient(async () => { throw new TypeError('Network request failed'); });
  await assert.rejects(client.search('노트북'), error => error.kind === 'network');
});

test('an invalid or insecure base URL is a readable request error, and nothing is fetched', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return new Response('[]'); };
  for (const base of ['not a url', 'http://seosa.ai.kr', 'ftp://seosa.ai.kr']) {
    assert.throws(() => apiBaseUrl(base), error => error instanceof ApiError && error.kind === 'request');
    await assert.rejects(createApiClient(fetcher, {}, base).search('노트북'), error => error.kind === 'request' && userMessage(error) === 'API 주소를 확인해 주세요.');
  }
  assert.equal(calls, 0);
  assert.equal(apiBaseUrl('https://seosa.ai.kr/'), 'https://seosa.ai.kr');
  assert.equal(apiBaseUrl('http://localhost:3000'), 'http://localhost:3000');
});

test('an already-aborted signal never starts a request', async () => {
  let calls = 0;
  const client = createApiClient(async () => { calls += 1; return new Response('[]'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.search('노트북', controller.signal), error => error.kind === 'aborted');
  assert.equal(calls, 0);
});

test('price history without a product id is refused before any request', async () => {
  let calls = 0;
  const client = createApiClient(async () => { calls += 1; return new Response('{}'); });
  await assert.rejects(client.history({ title: 'x', lprice: 1, mall: '쿠팡' }), error => error.kind === 'request');
  assert.equal(calls, 0);
});

test('malformed price history is rejected', async () => {
  const cases = [{ points: 'nope', deal: null }, { points: [{ date: '2026-09-13', price: '1000' }], deal: null }, { points: [], deal: { verdict: 1 } }];
  for (const body of cases) {
    const client = createApiClient(async () => new Response(JSON.stringify(body)));
    await assert.rejects(client.history(product), error => error.kind === 'invalid_response');
  }
});

test('one malformed row does not hide the other results; all-malformed is still an error', async () => {
  const mixed = createApiClient(async () => new Response(JSON.stringify([product, { title: 'broken' }, null])));
  assert.deepEqual(await mixed.search('노트북'), [product]);
  const deal = { title: '마우스', price: 15000, mall: '쿠팡', status: 'VERIFIED_HOT' };
  const home = createApiClient(async () => new Response(JSON.stringify({ items: [{ title: 'x' }, deal] })));
  assert.deepEqual(await home.homeDeals(), [deal]);
  const allBad = createApiClient(async () => new Response(JSON.stringify({ items: [{ title: 'x' }] })));
  await assert.rejects(allBad.homeDeals(), error => error.kind === 'invalid_response');
  const emptyHome = createApiClient(async () => new Response(JSON.stringify({ items: [] })));
  assert.deepEqual(await emptyHome.homeDeals(), []);
});

test('non-text deal reasons never reach the screen', async () => {
  const deal = { verdict: 'UNKNOWN', label: '판정할 근거가 없다', reasons: ['기록이 3일뿐이다', { x: 1 }, '', 7], cautions: [null] };
  const client = createApiClient(async () => new Response(JSON.stringify({ product, points: [], deal })));
  const detail = await client.product('123');
  assert.deepEqual(detail.deal.reasons, ['기록이 3일뿐이다']);
  assert.deepEqual(detail.deal.cautions, []);
});
