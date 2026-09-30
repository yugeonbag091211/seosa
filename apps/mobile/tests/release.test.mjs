import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinks } from '../lib/links.ts';
import { createSessionStore, SESSION_KEY } from '../lib/sessionStore.ts';
import { deleteAccountFlow, DELETED_ON_SERVER } from '../lib/accountDeletion.ts';
import { createApi, ApiError } from '../lib/api.ts';
import { verdictView } from '../lib/verdict.ts';
import { parseProductKey, productKey } from '../lib/identity.ts';
import { routeForAlert } from '../lib/notifications.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ── Policy links · support ── */

test('policy pages are the standalone web URLs', () => {
  const l = buildLinks();
  assert.equal(l.privacy, 'https://seosa.ai.kr/privacy');
  assert.equal(l.terms, 'https://seosa.ai.kr/terms');
});

test('support has no hard-coded address: empty unless EXPO_PUBLIC_SUPPORT_EMAIL is a valid e-mail', () => {
  assert.equal(buildLinks().support, '');
  assert.equal(buildLinks({ supportEmail: '' }).support, '');
  assert.equal(buildLinks({ supportEmail: 'not an email' }).support, '');
  assert.equal(buildLinks({ supportEmail: ' help@example.com ' }).support, 'mailto:help@example.com');
  assert.equal(/@[a-z0-9-]+\.[a-z]/i.test(src('lib/links.ts').replace(/help@example\.com/g, '')), false, 'no e-mail literal in lib/links.ts');
  assert.match(src('lib/config.ts'), /process\.env\.EXPO_PUBLIC_SUPPORT_EMAIL/);
});

test('the 마이 screen opens both policy links and the deletion screen', () => {
  const me = src('app/(tabs)/me.tsx');
  assert.match(me, /openLink\(LINKS\.privacy\)/);
  assert.match(me, /openLink\(LINKS\.terms\)/);
  assert.match(me, /router\.push\('\/account-delete'\)/);
  assert.match(me, /Linking\.openURL/);
  assert.ok(fs.existsSync(path.join(ROOT, 'app/account-delete.tsx')));
});

/* ── Session store: restart, logout ── */

function memoryStore({ failRemove = false } = {}) {
  const m = new Map();
  return {
    m,
    get: async k => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => { m.set(k, v); },
    remove: async k => { if (failRemove) throw new Error('keychain busy'); m.delete(k); },
  };
}
const S = { token: 'v1.eyJlIjoiYUBiLmNvIn0.c2lnbmF0dXJlLXZhbHVl', email: 'a@b.co', expiresAt: '2099-01-01T00:00:00Z' };

test('restart: a saved session is restored by a new store over the same secure storage', async () => {
  const disk = memoryStore();
  await createSessionStore(disk).save(S);
  assert.deepEqual(await createSessionStore(disk).load(), S);
});

test('logout leaves nothing in secure storage', async () => {
  const disk = memoryStore();
  const store = createSessionStore(disk);
  await store.save(S);
  assert.equal(await store.clear(), true);
  assert.equal(await createSessionStore(disk).load(), null);
  assert.equal(disk.m.get(SESSION_KEY) ?? null, null);
});

test('if the keychain refuses delete, the token is overwritten and still unusable', async () => {
  const disk = memoryStore({ failRemove: true });
  const store = createSessionStore(disk);
  await store.save(S);
  assert.equal(await store.clear(), true);
  assert.equal(await createSessionStore(disk).load(), null);
});

test('an expired or corrupt stored token is dropped on launch', async () => {
  const disk = memoryStore();
  disk.m.set(SESSION_KEY, JSON.stringify({ ...S, expiresAt: '2020-01-01T00:00:00Z' }));
  assert.equal(await createSessionStore(disk).load(), null);
  assert.equal(disk.m.has(SESSION_KEY) && disk.m.get(SESSION_KEY) !== '', false);
  disk.m.set(SESSION_KEY, '{broken');
  assert.equal(await createSessionStore(disk).load(), null);
});

test('an invalid session is never written', async () => {
  await assert.rejects(createSessionStore(memoryStore()).save({ token: 'x', email: 'a@b.co', expiresAt: '' }));
});

/* ── Account deletion ── */

function deps(overrides = {}) {
  const log = [];
  const d = {
    token: () => 'v1.tok.sig',
    requestDeletion: async tk => { log.push(['request', tk]); },
    clearSession: async () => { log.push(['session']); return true; },
    clearCache: () => { log.push(['cache']); },
    clearLocalData: async () => { log.push(['local']); },
    ...overrides,
  };
  return { d, log };
}

test('delete: server first, then token, cache and local data are all cleared', async () => {
  const { d, log } = deps();
  const r = await deleteAccountFlow(d);
  assert.deepEqual(r, { status: 'deleted', tokenRemoved: true });
  assert.deepEqual(log[0], ['request', 'v1.tok.sig']);
  assert.deepEqual(log.slice(1).map(x => x[0]).sort(), ['cache', 'local', 'session']);
});

test('delete: a failing cache wipe does not keep the token', async () => {
  const { d, log } = deps({ clearCache: () => { throw new Error('boom'); } });
  const r = await deleteAccountFlow(d);
  assert.equal(r.status, 'deleted');
  assert.ok(log.some(x => x[0] === 'session'));
});

test('delete: reported when secure storage could not drop the token', async () => {
  const { d } = deps({ clearSession: async () => false });
  assert.deepEqual(await deleteAccountFlow(d), { status: 'deleted', tokenRemoved: false });
});

test('delete without a session never calls the server', async () => {
  const { d, log } = deps({ token: () => undefined });
  assert.deepEqual(await deleteAccountFlow(d), { status: 'needs_login' });
  assert.equal(log.length, 0);
});

test('delete with an expired/invalid token (401): signs out, keeps local data, asks to log in', async () => {
  const { d, log } = deps({ requestDeletion: async () => { throw new ApiError('unauthorized', '', 401); } });
  assert.deepEqual(await deleteAccountFlow(d), { status: 'needs_login' });
  assert.deepEqual(log.map(x => x[0]), ['session']);
});

test('delete blocked by PRO auto-renewal (409) or failed (5xx/network): nothing local is touched', async () => {
  for (const err of [new ApiError('bad_request', 'PRO 자동결제가 켜져 있어요. 구독 해지 후 다시 시도해 주세요.', 409), new ApiError('unavailable', '', 503), new ApiError('network', '')]) {
    const { d, log } = deps({ requestDeletion: async () => { throw err; } });
    const r = await deleteAccountFlow(d);
    assert.equal(r.status, err.status === 409 ? 'blocked' : 'failed');
    assert.ok(r.message);
    assert.equal(log.length, 0);
  }
});

test('delete API: POST /api/account/delete, Bearer token, body carries only the confirmation', async () => {
  const calls = [];
  const api = createApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return { status: 200, headers: { get: () => null }, json: async () => ({ deleted: true, tables: ['alerts'], retained: ['payments'] }) }; },
  });
  assert.deepEqual(await api.deleteAccount('v1.tok.sig'), { retained: ['payments'] });
  assert.equal(calls[0].url.pathname, '/api/account/delete');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer v1.tok.sig');
  assert.deepEqual(JSON.parse(calls[0].init.body), { confirm: 'delete-account' });
  await assert.rejects(api.deleteAccount(''), { kind: 'unauthorized' });
  assert.equal(calls.length, 1, 'no request without a token');
});

test('delete API: 401 / 409 / other-user 403 / 5xx map to distinct outcomes', async () => {
  const mk = (status, body) => createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: async () => ({ status, headers: { get: () => null }, json: async () => body }) });
  await assert.rejects(mk(401, { error: 'x', needsAuth: true }).deleteAccount('t'), { kind: 'unauthorized' });
  await assert.rejects(mk(409, { error: 'PRO 자동결제가 켜져 있어요.', code: 'ACTIVE_SUBSCRIPTION' }).deleteAccount('t'), e => e.status === 409);
  await assert.rejects(mk(403, { error: '로그인한 계정만 삭제할 수 있어요' }).deleteAccount('t'), e => e.status === 403);
  await assert.rejects(mk(503, { error: 'internal' }).deleteAccount('t'), { kind: 'unavailable' });
  await assert.rejects(mk(200, { ok: true }).deleteAccount('t'), { kind: 'invalid_response' }, 'success must be explicit');
});

test('the confirmation screen lists exactly what the server deletes (api/_account.js USER_TABLES)', () => {
  assert.deepEqual([...DELETED_ON_SERVER], ['가격 알림', '찜·기록 동기화', '취향 프로필', 'AI 사용 기록', '구독 정보', '인증 코드']);
  const screen = src('app/account-delete.tsx');
  assert.match(screen, /accessibilityRole="checkbox"/, 'explicit acknowledgment before deleting');
  assert.match(screen, /disabled=\{!acknowledged \|\| busy\}/);
  assert.match(screen, /queryClient\.clear\(\)/);
  assert.match(screen, /clearSession: signOut/);
  assert.match(screen, /clearLocalData: clearAll/);
});

/* ── Verdict rule (web Modal.renderVerdict) ── */

test('fewer than two recorded days: "collecting" instead of a verdict', () => {
  const deal = { verdict: 'BUY', label: '지금 사도 좋다', reasons: [], cautions: [], stats: null };
  assert.deepEqual(verdictView(0, deal), { kind: 'collecting' });
  assert.deepEqual(verdictView(1, deal), { kind: 'collecting' });
  assert.deepEqual(verdictView(2, deal), { kind: 'deal', deal });
  assert.equal(verdictView(5, null), null);
});

/* ── Deep links ── */

test('deep link: seosa:// scheme, product route, option key survives URL encoding', () => {
  assert.equal(JSON.parse(src('app.json')).expo.scheme, 'seosa');
  assert.ok(fs.existsSync(path.join(ROOT, 'app/product/[key].tsx')));
  const id = { productId: '8082654809', mall: '쿠팡', vendorItemId: '95768196637' };
  const route = routeForAlert({ kind: 'big_drop', ...id, title: '', body: '' });
  assert.equal(route, '/product/' + encodeURIComponent(productKey(id)));
  assert.deepEqual(parseProductKey(decodeURIComponent(route.split('/').pop())), id);
});
