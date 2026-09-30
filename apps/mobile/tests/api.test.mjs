import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError, userMessage, isRetryable, normalizeBaseUrl } from '../lib/api.ts';
import { buildAiRequest } from '../lib/ai.ts';

/** A fake fetch that records calls and answers from a table. */
function fake(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const r = await respond(new URL(url), init);
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status ?? 200,
      headers: { get: k => headers.get(k.toLowerCase()) ?? null },
      json: async () => { if (r.raw !== undefined) throw new Error('bad json'); return r.body; },
    };
  };
  return { impl, calls };
}

const product = { title: 'A', lprice: 1000, mall: '쿠팡', productId: '1', vendorItemId: '2', link: 'https://link.coupang.com/a/xyz' };

test('search: same endpoint and parameter as the web, headers decoded', async () => {
  const f = fake(() => ({ body: [product], headers: { 'X-Seosa-Source': 'cache', 'X-Seosa-Blocked': '1' } }));
  const api = createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl });
  const r = await api.search('  무선 이어폰 ');
  assert.equal(f.calls[0].url.pathname, '/api/search');
  assert.equal(f.calls[0].url.searchParams.get('keyword'), '무선 이어폰');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.equal(r.source, 'cache');
  assert.equal(r.blocked, true);
  assert.equal(r.items[0].link, product.link);
});

test('search: zero results carry the server corrections', async () => {
  const f = fake(() => ({ body: [], headers: { 'X-Seosa-Correct': encodeURIComponent('에어팟'), 'X-Seosa-Suggest': ['이어폰', '버즈'].map(encodeURIComponent).join('|') } }));
  const r = await createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl }).search('에어퐛');
  assert.equal(r.items.length, 0);
  assert.equal(r.corrected, '에어팟');
  assert.deepEqual(r.suggestions, ['이어폰', '버즈']);
});

test('search: 503 (all providers down) is an outage, not "no results"', async () => {
  const f = fake(() => ({ status: 503, body: { error: '검색 공급원 전면 실패: coupang timeout' }, headers: { 'Retry-After': '30' } }));
  await assert.rejects(createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl }).search('x'), e => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.kind, 'unavailable');
    assert.equal(e.retryAfter, 30);
    // Internal server text never reaches the user.
    assert.ok(!userMessage(e).includes('coupang'));
    assert.equal(isRetryable(e), true);
    return true;
  });
});

test('search: a non-empty list with no usable row is a broken contract', async () => {
  const f = fake(() => ({ body: [{ title: 'x' }] }));
  await assert.rejects(createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl }).search('x'), { kind: 'invalid_response' });
});

test('history: option-level query exactly like the web modal', async () => {
  const f = fake(() => ({ body: { points: [{ date: '2026-09-29', price: 1000 }], deal: { verdict: 'OK', label: '보통', reasons: [], cautions: [] } } }));
  const api = createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl });
  const h = await api.history({ productId: '1', mall: '쿠팡', vendorItemId: '2' });
  const q = f.calls[0].url.searchParams;
  assert.equal(f.calls[0].url.pathname, '/api/history');
  assert.equal(q.get('productId'), '1');
  assert.equal(q.get('mall'), '쿠팡');
  assert.equal(q.get('vendorItemId'), '2');
  assert.equal(q.get('deal'), '1');
  assert.equal(q.get('title'), null);   // never a title lookup (the server removed it: mixes products)
  assert.equal(h.points.length, 1);
  assert.equal(h.deal.label, '보통');

  await api.history({ productId: 'h', mall: 'ADPICK', vendorItemId: '' });
  assert.equal(f.calls[1].url.searchParams.has('vendorItemId'), false);
});

test('history: no productId means no request and no history', async () => {
  const f = fake(() => ({ body: {} }));
  const h = await createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl }).history({ productId: '', mall: '쿠팡', vendorItemId: '' });
  assert.deepEqual(h, { points: [], deal: null });
  assert.equal(f.calls.length, 0);
});

test('today drops: the web home query', async () => {
  const f = fake(() => ({ body: { items: [] } }));
  await createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl }).todayDrops();
  assert.equal(f.calls[0].url.pathname, '/api/hotdeals');
  assert.equal(f.calls[0].url.searchParams.get('view'), 'today-drop');
  assert.equal(f.calls[0].url.searchParams.get('limit'), '60');
});

test('history batch sends option keys', async () => {
  const f = fake(() => ({ body: { '1|쿠팡|2': [{ date: '2026-09-29', price: 900 }] } }));
  const m = await createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl }).historyBatch(['1|쿠팡|2', '1|쿠팡|2', 'h|ADPICK']);
  assert.equal(f.calls[0].url.pathname, '/api/history-batch');
  assert.deepEqual(JSON.parse(f.calls[0].url.searchParams.get('keys')), ['1|쿠팡|2', 'h|ADPICK']);
  assert.equal(m['1|쿠팡|2'][0].price, 900);
  assert.deepEqual(m['h|ADPICK'], []);
});

test('auth: two steps, token returned, code never echoed', async () => {
  const f = fake((url, init) => {
    const b = JSON.parse(init.body);
    return b.code ? { body: { token: 'v1.payloadpayload.signature', email: b.email, expiresAt: '2026-10-30T00:00:00Z' } } : { body: { sent: true, expiresInSec: 600 } };
  });
  const api = createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl });
  assert.deepEqual(await api.requestCode('a@b.co'), { expiresInSec: 600 });
  const s = await api.verifyCode('a@b.co', '123456');
  assert.equal(s.token, 'v1.payloadpayload.signature');
  assert.equal(f.calls[0].init.method, 'POST');
});

test('auth: wrong code shows the server message (written for users)', async () => {
  const f = fake(() => ({ status: 400, body: { error: '인증 코드가 올바르지 않아요' } }));
  await assert.rejects(createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl }).verifyCode('a@b.co', '000000'), e => userMessage(e) === '인증 코드가 올바르지 않아요');
});

test('ai: guest sends no Authorization; a session sends Bearer; body carries selectors only', async () => {
  const f = fake(() => ({ body: { text: 'ok', turnSig: 'at1.a.b' } }));
  const api = createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl });
  const body = buildAiRequest({ question: '이거 살까?', context: [{ ...product, price: 1000, mallLabel: '쿠팡', image: '', listPrice: 0, savePct: 0, collectedAt: '', isRocket: null, trust: null, priceChange: null }], history: [] });
  await api.ask(body, undefined);
  await api.ask(body, 'v1.token.sig');
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.equal(f.calls[1].init.headers.Authorization, 'Bearer v1.token.sig');
  const sent = JSON.parse(f.calls[0].init.body);
  assert.equal(JSON.stringify(sent).includes('1000'), false, 'no price in the AI request');
});

test('ai: expired token → unauthorized (never silently downgraded to guest)', async () => {
  const f = fake(() => ({ status: 401, body: { error: 'expired', needsAuth: true, text: '' } }));
  await assert.rejects(createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl }).ask({}, 'v1.x.y'), { kind: 'unauthorized' });
});

test('rate limit and errors map to kinds', async () => {
  const mk = status => createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: fake(() => ({ status, body: { error: 'e' }, headers: { 'Retry-After': '12' } })).impl });
  await assert.rejects(mk(429).todayDrops(), e => e.kind === 'rate_limited' && e.retryAfter === 12 && !isRetryable(e));
  await assert.rejects(mk(404).todayDrops(), { kind: 'not_found' });
  await assert.rejects(mk(500).todayDrops(), { kind: 'unavailable' });
});

test('network failure and timeout', async () => {
  const down = createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: async () => { throw new TypeError('Network request failed'); } });
  await assert.rejects(down.todayDrops(), { kind: 'network' });
  const hang = createApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  const controller = new AbortController();
  const p = hang.search('x', controller.signal);
  controller.abort();
  await assert.rejects(p, { kind: 'aborted' });
});

test('invalid JSON is reported, not treated as empty', async () => {
  const f = fake(() => ({ raw: '<html>' }));
  await assert.rejects(createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: f.impl }).todayDrops(), { kind: 'invalid_response' });
});

test('base URL must be https (http only for local development hosts)', () => {
  assert.equal(normalizeBaseUrl('https://seosa.ai.kr/'), 'https://seosa.ai.kr');
  assert.equal(normalizeBaseUrl('http://localhost:3131'), 'http://localhost:3131');
  assert.throws(() => normalizeBaseUrl('http://seosa.ai.kr'));
  assert.throws(() => normalizeBaseUrl('nonsense'));
});
