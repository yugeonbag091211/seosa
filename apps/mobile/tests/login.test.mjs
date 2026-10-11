import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, ApiError, userMessage, AGE_REQUIRED_MESSAGE } from '../lib/api.ts';
import { AGE_CONFIRM_LABEL, AGE_UNCHECKED_MESSAGE, EMAIL_INVALID_MESSAGE, codeRequestProblem, requestLoginCode } from '../lib/login.ts';
import { createSessionStore, SESSION_KEY } from '../lib/sessionStore.ts';
import { isSessionUsable } from '../lib/sessionModel.ts';
import { deleteAccountFlow } from '../lib/accountDeletion.ts';

/*
 * Login is for users aged 14 or over (PR #118, api/auth.js): a code request without
 * `ageConfirmed: true` is refused with 400 + needsAgeConfirm. These tests pin the app's half:
 * an unticked box sends nothing, a ticked box sends exactly the boolean true, the screen starts
 * unticked each time, and nothing else about login (code, token, SecureStore, logout, deletion) moved.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WEB_INDEX = process.env.SEOSA_WEB_INDEX || path.resolve(ROOT, '../../public/index.html');

const TOKEN = 'v1.eyJlIjoiYUBiLmNvIn0.signature-value';

/** A server that answers /api/auth the way PR #118's api/auth.js does, and records every request. */
function server(overrides = {}) {
  const calls = [];
  const auth = overrides.auth || (body => {
    if (body.code) {
      return body.code === '123456'
        ? { body: { token: TOKEN, email: body.email, expiresAt: '2099-01-01T00:00:00Z' } }
        : { status: 400, body: { error: '인증 코드가 올바르지 않아요' } };
    }
    if (body.ageConfirmed !== true) return { status: 400, body: { error: AGE_REQUIRED_MESSAGE, needsAgeConfirm: true } };
    return { body: { sent: true, expiresInSec: 600 } };
  });
  const routes = { '/api/auth': (url, init) => auth(JSON.parse(init.body), init), ...overrides.routes };
  const impl = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init, raw: init.body });
    const route = routes[u.pathname];
    if (!route) throw new Error(`unexpected request ${u.pathname}`);
    const r = await route(u, init);
    return { status: r.status ?? 200, headers: { get: () => null }, json: async () => r.body };
  };
  return { api: createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: impl }), calls };
}

const memoryStore = () => {
  const disk = new Map();
  return { disk, store: { get: async k => disk.get(k) ?? null, set: async (k, v) => { disk.set(k, v); }, remove: async k => { disk.delete(k); } } };
};

/* ── Unticked: nothing goes out ── */

test('age: unticked box → no request, a message that says why', async () => {
  const { api, calls } = server();
  const r = await requestLoginCode({ email: 'a@b.co', ageConfirmed: false }, api.requestCode);
  assert.deepEqual(r, { ok: false, reason: 'age', message: AGE_UNCHECKED_MESSAGE });
  assert.equal(calls.length, 0, 'zero API calls');
  assert.match(AGE_UNCHECKED_MESSAGE, /만 14세/);
  assert.equal(codeRequestProblem({ email: 'a@b.co', ageConfirmed: false }), AGE_UNCHECKED_MESSAGE);
});

test('age: a bad e-mail is reported first (the screen\'s order) and nothing goes out', async () => {
  const { api, calls } = server();
  for (const ageConfirmed of [false, true]) {
    const r = await requestLoginCode({ email: 'not-an-email', ageConfirmed }, api.requestCode);
    assert.deepEqual(r, { ok: false, reason: 'email', message: EMAIL_INVALID_MESSAGE });
  }
  assert.equal(calls.length, 0);
});

test('age: the API client refuses anything but the literal true before touching the network', async () => {
  const { api, calls } = server();
  for (const bad of ['true', 1, false, undefined, null, 'yes', {}]) {
    await assert.rejects(api.requestCode('a@b.co', bad), e => e instanceof ApiError && e.reason === 'age_confirmation' && userMessage(e) === AGE_REQUIRED_MESSAGE, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0, 'zero API calls');
});

/* ── Ticked: exactly ageConfirmed: true ── */

test('age: ticked box → one request whose body is exactly { email, ageConfirmed: true }', async () => {
  const { api, calls } = server();
  const r = await requestLoginCode({ email: '  a@b.co ', ageConfirmed: true }, api.requestCode);
  assert.deepEqual(r, { ok: true, expiresInSec: 600 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/auth');
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].raw);
  assert.deepEqual(Object.keys(body).sort(), ['ageConfirmed', 'email']);
  assert.equal(body.ageConfirmed, true);
  assert.equal(typeof body.ageConfirmed, 'boolean');
  assert.equal(body.email, 'a@b.co', 'trimmed like before');
  assert.match(calls[0].raw, /"ageConfirmed":true/);
  assert.doesNotMatch(calls[0].raw, /"ageConfirmed":"/, 'never the string "true"');
});

/* ── The server's age 400, and no regression for the others ── */

test('age: the server\'s age 400 (needsAgeConfirm) gets the app\'s own clear message, whatever its text', async () => {
  for (const text of [AGE_REQUIRED_MESSAGE, 'age confirmation required', '']) {
    const { api } = server({ auth: () => ({ status: 400, body: { error: text, needsAgeConfirm: true } }) });
    const r = await requestLoginCode({ email: 'a@b.co', ageConfirmed: true }, api.requestCode);
    assert.deepEqual(r, { ok: false, reason: 'age', message: AGE_REQUIRED_MESSAGE }, text);
  }
});

test('age: other code-request failures read exactly as before (400 / 401 / 429 / 5xx / network)', async () => {
  const cases = [
    [{ status: 400, body: { error: '이메일 형식이 올바르지 않습니다' } }, '이메일 형식이 올바르지 않습니다'],
    [{ status: 400, body: { error: 'Bad Request' } }, '요청을 처리하지 못했어요.'],
    [{ status: 400, body: { error: '이메일 형식이 올바르지 않습니다', needsAgeConfirm: 'true' } }, '이메일 형식이 올바르지 않습니다'],
    [{ status: 401, body: { error: 'expired', needsAuth: true } }, '로그인이 만료됐어요. 다시 로그인해 주세요.'],
    [{ status: 429, body: { error: '잠시 후 다시 시도해 주세요. 인증 요청이 너무 잦아요.' } }, '잠시 후 다시 시도해 주세요. 인증 요청이 너무 잦아요.'],
    [{ status: 429, body: { error: 'Too Many Requests' } }, '요청이 많아요. 잠시 후 다시 시도해 주세요.'],
    [{ status: 502, body: { error: '인증 메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.', needsAgeConfirm: true } }, '지금은 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'],
    [{ status: 503, body: { error: '지금은 인증 메일을 보낼 수 없어요.' } }, '지금은 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'],
  ];
  for (const [answer, expected] of cases) {
    const { api } = server({ auth: () => answer });
    const r = await requestLoginCode({ email: 'a@b.co', ageConfirmed: true }, api.requestCode);
    assert.deepEqual(r, { ok: false, reason: 'server', message: expected }, JSON.stringify(answer));
  }
  const offline = createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: async () => { throw new TypeError('Network request failed'); } });
  assert.deepEqual(await requestLoginCode({ email: 'a@b.co', ageConfirmed: true }, offline.requestCode),
    { ok: false, reason: 'server', message: '네트워크 연결을 확인한 뒤 다시 시도해 주세요.' });
});

/* ── The screen: unticked on every open, never stored ── */

test('screen: the box starts unticked on every open and is never persisted', () => {
  const screen = src('app/login.tsx');
  assert.match(screen, /const \[ageConfirmed, setAgeConfirmed\] = useState\(false\);/, 'component state, default false');
  assert.doesNotMatch(screen, /useState\(true\)/);
  assert.doesNotMatch(screen, /(secure|AsyncStorage|useLocalData|Store)\b[\s\S]{0,80}ageConfirmed|ageConfirmed[\s\S]{0,80}\b(secure|AsyncStorage|setItem)\b/, 'not written to storage');
  assert.match(screen, /setPhase\('email'\);[^}]*setAgeConfirmed\(false\)/, '«이메일 다시 입력» asks again, like the web\'s restart');
  // The login route is a modal stack screen: closing unmounts it, opening mounts a fresh one.
  assert.match(src('app/_layout.tsx'), /name="login" options=\{\{ presentation: 'modal'/);
  assert.match(screen, /router\.back\(\)/);
});

test('screen: step 1 goes through codeRequestProblem → requestLoginCode, never api.requestCode with a flag of its own', () => {
  const screen = src('app/login.tsx');
  const start = screen.indexOf('const submit');
  const submit = screen.slice(start, start + screen.slice(start).search(/\n\s*return \(\r?\n/));
  assert.ok(submit.length > 200, 'found the submit handler');
  assert.ok(submit.indexOf('codeRequestProblem({ email, ageConfirmed })') > -1);
  assert.ok(submit.indexOf('codeRequestProblem(') < submit.indexOf('setBusy(true)'), 'checked before anything is sent');
  assert.match(submit, /requestLoginCode\(\{ email, ageConfirmed \}, api\.requestCode\)/);
  assert.doesNotMatch(submit, /api\.requestCode\(/, 'no direct call that could skip the check');
  assert.match(submit, /api\.verifyCode\(email\.trim\(\), code\)/, 'step 2 unchanged');
});

test('screen: the checkbox is the app\'s existing one (account-delete) with the web\'s words', () => {
  const screen = src('app/login.tsx');
  assert.match(screen, /accessibilityRole="checkbox"/);
  assert.match(screen, /accessibilityState=\{\{ checked: ageConfirmed \}\}/);
  assert.match(screen, /\{AGE_CONFIRM_LABEL\}/);
  assert.equal(AGE_CONFIRM_LABEL, '만 14세 이상입니다 (필수)');
  const del = src('app/account-delete.tsx');
  const style = (file, name) => (file.match(new RegExp(`\\b${name}: \\{([^}]*)\\}`)) || [])[1];
  assert.equal(style(screen, 'box'), style(del, 'box'), 'same check box');
  assert.equal(style(screen, 'ack').replace(/marginTop: space\.\w+, /, ''), style(del, 'ack').replace(/marginTop: space\.\w+, /, ''), 'same row, only the gap above differs');
});

test('screen: the label matches the web\'s login checkbox (public/index.html #authAge)', t => {
  const html = fs.existsSync(WEB_INDEX) ? fs.readFileSync(WEB_INDEX, 'utf8') : '';
  if (!/id="authAge"/.test(html)) return t.skip('this tree\'s web page predates the age checkbox (PR #118)');
  assert.ok(html.includes(AGE_CONFIRM_LABEL));
});

/* ── Everything else about login is unchanged ── */

test('login end to end: ticked → code → wrong code → token → SecureStore → restart → logout', async () => {
  const { api, calls } = server();
  assert.deepEqual(await requestLoginCode({ email: 'a@b.co', ageConfirmed: true }, api.requestCode), { ok: true, expiresInSec: 600 });
  await assert.rejects(api.verifyCode('a@b.co', '000000'), e => e.kind === 'bad_request' && e.reason === '' && userMessage(e) === '인증 코드가 올바르지 않아요');
  const session = await api.verifyCode('a@b.co', '123456');
  assert.equal(session.token, TOKEN);
  assert.deepEqual(JSON.parse(calls[2].raw), { email: 'a@b.co', code: '123456' }, 'step 2 body unchanged — no ageConfirmed');
  assert.ok(isSessionUsable(session));

  const { disk, store } = memoryStore();
  await createSessionStore(store).save(session);
  assert.deepEqual(JSON.parse(disk.get(SESSION_KEY)), session, 'token in secure storage under the same key');
  assert.deepEqual(await createSessionStore(store).load(), session, 'a relaunch restores it');
  assert.equal(await createSessionStore(store).clear(), true, 'logout');
  assert.equal(disk.has(SESSION_KEY), false);
  assert.equal(await createSessionStore(store).load(), null);
});

test('expired token: not used, dropped from storage on launch; a 401 still reads «로그인이 만료됐어요»', async () => {
  const expired = { token: TOKEN, email: 'a@b.co', expiresAt: '2020-01-01T00:00:00Z' };
  assert.equal(isSessionUsable(expired), false);
  const { disk, store } = memoryStore();
  disk.set(SESSION_KEY, JSON.stringify(expired));
  assert.equal(await createSessionStore(store).load(), null);
  assert.equal(disk.has(SESSION_KEY), false);
  assert.equal(userMessage(new ApiError('unauthorized', 'expired', 401)), '로그인이 만료됐어요. 다시 로그인해 주세요.');
});

test('account deletion after an age-confirmed login: token-only request, then the device forgets everything', async () => {
  const { api, calls } = server({ routes: { '/api/account/delete': () => ({ body: { deleted: true, tables: [], retained: ['payments'] } }) } });
  await requestLoginCode({ email: 'a@b.co', ageConfirmed: true }, api.requestCode);
  const session = await api.verifyCode('a@b.co', '123456');
  const { disk, store } = memoryStore();
  const sessions = createSessionStore(store);
  await sessions.save(session);
  let cacheCleared = false, localCleared = false;
  const r = await deleteAccountFlow({
    token: () => session.token,
    requestDeletion: tk => api.deleteAccount(tk),
    clearSession: () => sessions.clear(),
    clearCache: () => { cacheCleared = true; },
    clearLocalData: () => { localCleared = true; },
  });
  assert.deepEqual(r, { status: 'deleted', tokenRemoved: true });
  const del = calls.find(c => c.url.pathname === '/api/account/delete');
  assert.equal(del.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(del.raw), { confirm: 'delete-account' }, 'no e-mail, no age field');
  assert.equal(disk.has(SESSION_KEY), false);
  assert.ok(cacheCleared && localCleared);
});
