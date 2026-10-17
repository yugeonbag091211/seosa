import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlertsApi } from '../lib/alertsApi.ts';
import { ApiError } from '../lib/api.ts';

function response(status, body, headers = {}) {
  return {
    status,
    headers: { get: name => headers[name] ?? headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const product = {
  productId: '8082654809',
  vendorItemId: 'V123',
  title: '테스트 상품 옵션',
  link: 'https://link.coupang.com/a/test',
  image: 'https://example.com/a.jpg',
  mall: '쿠팡',
};

test('alerts api: save sends exact option identity and bearer auth', async () => {
  let call;
  const api = createAlertsApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async (url, init) => {
      call = { url, init };
      return response(200, { success: true, optionBound: true });
    },
  });

  await api.save({ email: 'a@example.com', token: 'token-1', product, currentPrice: 15900, targetPrice: 14000 });
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer token-1');
  const body = JSON.parse(call.init.body);
  assert.equal(body.productId, product.productId);
  assert.equal(body.vendorItemId, 'V123');
  assert.equal(body.mall, '쿠팡');
  assert.equal(body.targetPrice, 14000);
  assert.equal(body.currentPrice, 15900);
});

test('alerts api: app refuses to create a product-level alert when vendor identity is missing', async () => {
  let called = 0;
  const api = createAlertsApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async () => { called++; return response(200, { success: true }); },
  });

  await assert.rejects(
    () => api.save({ email: 'a@example.com', token: 't', product: { ...product, vendorItemId: '' }, currentPrice: 10000, targetPrice: 9000 }),
    error => error instanceof ApiError && error.kind === 'bad_request' && /옵션/.test(error.message),
  );
  assert.equal(called, 0);
});

test('alerts api: target price must be below the displayed current price', async () => {
  let called = 0;
  const api = createAlertsApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async () => { called++; return response(200, { success: true }); },
  });

  for (const targetPrice of [15900, 16000]) {
    await assert.rejects(
      () => api.save({ email: 'a@example.com', token: 't', product, currentPrice: 15900, targetPrice }),
      error => error instanceof ApiError && error.kind === 'bad_request' && /현재 표시 가격보다 낮게/.test(error.message),
    );
  }
  assert.equal(called, 0);
});

test('alerts api: list uses email query, auth and parses legacy Y/N sent values', async () => {
  let call;
  const api = createAlertsApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async (url, init) => {
      call = { url, init };
      return response(200, [{
        title: 'A', targetPrice: 9000, currentPrice: 10000, mall: '쿠팡',
        productId: 'P1', vendorItemId: 'V1', sent: 'Y', onDeal: false,
      }]);
    },
  });

  const rows = await api.list('a+test@example.com', 'tok');
  assert.match(call.url, /email=a%2Btest%40example\.com/);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers.Authorization, 'Bearer tok');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vendorItemId, 'V1');
  assert.equal(rows[0].sent, true);
});

test('alerts api: remove is authenticated DELETE and carries exact account email plus title', async () => {
  let call;
  const api = createAlertsApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async (url, init) => { call = { url, init }; return response(200, { success: true }); },
  });

  await api.remove('a@example.com', 'tok', '상품 A');
  assert.equal(call.init.method, 'DELETE');
  assert.deepEqual(JSON.parse(call.init.body), { email: 'a@example.com', title: '상품 A' });
});

test('alerts api: server 503 stays an unavailable error', async () => {
  const api = createAlertsApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async () => response(503, { error: '내부 상세 오류' }),
  });
  await assert.rejects(
    () => api.list('a@example.com', 'tok'),
    error => error instanceof ApiError && error.kind === 'unavailable' && error.status === 503,
  );
});
