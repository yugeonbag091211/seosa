import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, userMessage } from '../lib/api.ts';
import { buildAiRequest } from '../lib/ai.ts';
import { purchaseTarget } from '../lib/affiliate.ts';
import { parseProductKey, productKey, sameProduct } from '../lib/identity.ts';
import { rememberProduct, recallProduct } from '../lib/productCache.ts';
import { dropAsProduct, savedAsProduct } from '../lib/products.ts';
import { restoreSaved, savedStatus, toggleSaved } from '../lib/savedModel.ts';
import { createSessionStore } from '../lib/sessionStore.ts';
import { pushRecent, restoreRecent, suggestions } from '../lib/suggest.ts';
import { verdictView } from '../lib/verdict.ts';
import { buildLinks } from '../lib/links.ts';

/*
 * The user flows the release checklist names (FLOW A–G), driven through the real API client
 * against a fake SEOSA server. Screens are thin over these modules, so a flow that holds here
 * holds on the device unless the rendering itself breaks — which only a device run shows.
 */

const COUPANG_LINK = 'https://link.coupang.com/re/AFFSDP?lptag=AF1234567&subid=seosa&pageKey=8082654809&itemId=21&vendorItemId=95768196637&traceid=V0-1';

function server(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), init });
    const handler = routes[u.pathname];
    const r = handler ? await handler(u, init) : { status: 404, body: { error: '없음' } };
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status ?? 200, headers: { get: k => headers.get(k.toLowerCase()) ?? null }, json: async () => r.body };
  };
  return { api: createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: impl }), calls };
}

const row = { productId: '8082654809', mall: '쿠팡', vendorItemId: '95768196637', title: '삼성 갤럭시 버즈3 프로', lprice: 189000, oprice: 259000, mallLabel: '쿠팡', image: 'https://thumbnail.coupangcdn.com/a.jpg', link: COUPANG_LINK, collectedAt: '2026-10-09' };
const points = [{ date: '2026-10-01', price: 199000 }, { date: '2026-10-05', price: 195000 }, { date: '2026-10-09', price: 189000 }];

test('FLOW A: 홈 → 오늘의 가격 하락 → 상품 상세 → 가격 그래프 → 구매 버튼', async () => {
  const { api, calls } = server({
    '/api/hotdeals': () => ({ body: { items: [{ id: 'd1', productId: row.productId, mall: '쿠팡', vendorItemId: row.vendorItemId, title: row.title, currentPrice: 189000, previousPrice: 199000, dropAmount: 10000, dropPct: 5.03, link: COUPANG_LINK, verified: true, recordedAt: '2026-10-09', previousAt: '2026-10-05' }] } }),
    '/api/history': () => ({ body: { points, deal: { verdict: 'BUY', label: '지금 사도 좋아요', reasons: ['30일 최저가'], cautions: [] } } }),
  });
  const drops = await api.todayDrops();
  assert.equal(calls[0].query.view, 'today-drop');
  const product = dropAsProduct(drops[0]);
  // The tapped row travels with the navigation; the route carries only the option key.
  const key = rememberProduct(product);
  assert.deepEqual(parseProductKey(key), { productId: row.productId, mall: '쿠팡', vendorItemId: row.vendorItemId });
  assert.equal(recallProduct(key), product);
  const history = await api.history(parseProductKey(key));
  assert.deepEqual(calls[1].query, { productId: row.productId, mall: '쿠팡', vendorItemId: row.vendorItemId, deal: '1' });
  assert.equal(history.points.length, 3);
  assert.equal(verdictView(history.points.length, history.deal).kind, 'deal');
  assert.equal(purchaseTarget(product.link, product.mallLabel).url, COUPANG_LINK, 'buy button opens the server link byte-for-byte');
});

test('FLOW B: 검색 → 자동완성 → 결과 → 상품 → 가격 그래프 → 저장', async () => {
  const recent = pushRecent([], '버즈3');
  const popular = ['갤럭시 버즈3 프로', '에어팟 프로'];
  assert.deepEqual(suggestions('버즈', recent, popular).map(s => s.keyword), ['버즈3', '갤럭시 버즈3 프로']);

  const { api, calls } = server({
    '/api/search': () => ({ body: [row], headers: { 'X-Seosa-Source': 'live' } }),
    '/api/history': () => ({ body: { points, deal: null } }),
  });
  const result = await api.search('갤럭시 버즈3 프로');
  assert.equal(calls[0].query.keyword, '갤럭시 버즈3 프로');
  const product = result.items[0];
  const history = await api.history(product);
  assert.equal(history.points.at(-1).price, 189000);

  const saved = toggleSaved([], product, new Date('2026-10-10T00:00:00Z'));
  assert.equal(saved.length, 1);
  assert.ok(sameProduct(saved[0], product), 'saved under the exact option');
  assert.equal(saved[0].link, COUPANG_LINK);
  assert.deepEqual(toggleSaved(saved, product), [], 'second tap unsaves');
});

test('FLOW C: AI 컨시어지 → 질문 → 추천 상품 → 상세 → 구매 이동', async () => {
  const { api, calls } = server({
    '/api/ai': () => ({ body: { text: '**버즈3 프로**가 30일 최저가예요.', items: [row], followups: ['다른 색상은?'], guest: true, topProductId: row.productId, topRecommendationRef: 'r1.sig', turnSig: 't1.sig', convState: 'acs1.state.sig' } }),
  });
  const body = buildAiRequest({ question: '20만원 이하 노이즈캔슬링 이어폰', context: [], history: [], view: { source: 'app' } });
  const answer = await api.ask(body, undefined);
  assert.equal(calls[0].init.headers.Authorization, undefined, 'signed out → guest mode, no login wall');
  assert.equal(answer.guest, true);
  const pick = answer.items[0];
  assert.equal(productKey(pick), `${row.productId}|쿠팡|${row.vendorItemId}`);
  assert.equal(purchaseTarget(pick.link, pick.mallLabel).url, COUPANG_LINK);
  // The follow-up replays the signed turn and the signed previous pick, untouched.
  const next = buildAiRequest({ question: '다른 색상은?', context: [], history: [{ role: 'user', text: body.question }, { role: 'assistant', text: answer.text, sig: answer.turnSig }], prevTopProductId: answer.topProductId, prevTopRef: answer.topRecommendationRef, convState: answer.convState });
  assert.equal(next.chatHistory[1].sig, 't1.sig');
  assert.equal(next.prevTopRef, 'r1.sig');
  // The signed conversation state goes back untouched — it carries the budget past the 10-turn history.
  assert.equal(next.convState, 'acs1.state.sig');
});

test('FLOW C (failure): AI 429 / 401 / 500 / timeout-like errors end in readable text, never a stack or JSON', async () => {
  const cases = [
    [429, { error: '요청이 너무 잦아요. 30초 후 다시 시도해 주세요.' }, '요청이 너무 잦아요. 30초 후 다시 시도해 주세요.'],
    [429, { error: 'Too Many Requests' }, '요청이 많아요. 잠시 후 다시 시도해 주세요.'],
    [401, { error: 'expired', needsAuth: true }, '로그인이 만료됐어요. 다시 로그인해 주세요.'],
    [500, { error: 'TypeError: Cannot read properties of undefined (reading "x") at ai.js:12:3' }, '지금은 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'],
    [400, { error: { code: 'BAD', detail: '질문 없음' } }, '요청을 처리하지 못했어요.'],
  ];
  for (const [status, body, expected] of cases) {
    const { api } = server({ '/api/ai': () => ({ status, body }) });
    await assert.rejects(api.ask({}, undefined), e => userMessage(e) === expected, `${status} ${JSON.stringify(body)}`);
  }
});

test('FLOW D: 로그인 → 세션 유지(재시작) → 로그아웃', async () => {
  const { api } = server({
    '/api/auth': (u, init) => {
      const b = JSON.parse(init.body);
      if (!b.code) {
        // PR #118 api/auth.js: no code without ageConfirmed === true.
        if (b.ageConfirmed !== true) return { status: 400, body: { error: '만 14세 이상만 로그인할 수 있어요. 만 14세 이상인지 확인해 주세요.', needsAgeConfirm: true } };
        return { body: { sent: true, expiresInSec: 600 } };
      }
      return b.code === '123456'
        ? { body: { token: 'v1.eyJlIjoiYUBiLmNvIn0.signature-value', email: b.email, expiresAt: '2099-01-01T00:00:00Z' } }
        : { status: 400, body: { error: '인증 코드가 올바르지 않아요' } };
    },
  });
  assert.deepEqual(await api.requestCode('a@b.co', true), { expiresInSec: 600 });
  await assert.rejects(api.verifyCode('a@b.co', '000000'), e => userMessage(e) === '인증 코드가 올바르지 않아요');
  const session = await api.verifyCode('a@b.co', '123456');
  const disk = new Map();
  const secure = { get: async k => disk.get(k) ?? null, set: async (k, v) => { disk.set(k, v); }, remove: async k => { disk.delete(k); } };
  await createSessionStore(secure).save(session);
  assert.deepEqual(await createSessionStore(secure).load(), session, 'a new launch restores the session');
  assert.equal(await createSessionStore(secure).clear(), true);
  assert.equal(await createSessionStore(secure).load(), null, 'after logout nothing is restored');
});

test('FLOW E: 계정 삭제 요청 계약 — token only, explicit confirmation, no e-mail in the body', async () => {
  const { api, calls } = server({ '/api/account/delete': () => ({ body: { deleted: true, retained: ['payments'] } }) });
  assert.deepEqual(await api.deleteAccount('v1.tok.sig'), { retained: ['payments'] });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer v1.tok.sig');
  assert.deepEqual(JSON.parse(calls[0].init.body), { confirm: 'delete-account' });
});

test('FLOW F: 마이 → 개인정보처리방침 · 이용약관 · 고객지원 are the web pages', () => {
  const l = buildLinks();
  assert.deepEqual([l.privacy, l.terms, l.support], ['https://seosa.ai.kr/privacy', 'https://seosa.ai.kr/terms', 'https://seosa.ai.kr/support']);
});

test('FLOW G: 종료 → 재시작: saved list, recent searches and session come back; corrupted storage does not crash', async () => {
  const product = { productId: '1', mall: '쿠팡', vendorItemId: '2', title: 'T', price: 1000, mallLabel: '쿠팡', image: '', link: COUPANG_LINK, listPrice: 0, savePct: 0, collectedAt: '', isRocket: null, trust: null, priceChange: null };
  const saved = toggleSaved([], product, new Date('2026-10-10T00:00:00Z'));
  const recent = pushRecent(pushRecent([], '에어팟'), '버즈3');
  // What AsyncStorage holds is JSON; a restart parses it back.
  const back = restoreSaved(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(back, saved);
  assert.deepEqual(restoreRecent(JSON.parse(JSON.stringify(recent))), ['버즈3', '에어팟']);
  // Reopening a saved item shows the dated saved price until history arrives, then the server's latest.
  assert.equal(savedAsProduct(back[0], null).price, 1000);
  assert.equal(savedAsProduct(back[0], savedStatus(back[0], [{ date: '2026-10-10', price: 900 }]).latest).price, 900);
  assert.equal(savedAsProduct(back[0], null).link, COUPANG_LINK);

  // Corrupted values after an upgrade or a bad write.
  for (const junk of [null, 42, 'oops', {}, { length: 3 }, [null, 1, 'x', { productId: '' }, { productId: '1', mall: '쿠팡', title: 'T', savedPrice: -5 }]]) {
    assert.deepEqual(restoreSaved(junk), []);
  }
  const recovered = restoreRecent([null, 7, { a: 1 }, '', '   ', 'x'.repeat(5000), '버즈3', '버즈 3']);
  assert.ok(recovered.every(k => typeof k === 'string' && k.length > 0 && k.length <= 80), 'only usable strings survive');
  assert.equal(recovered.filter(k => k.replace(/\s/g, '') === '버즈3').length, 1, 'spacing variants collapse to one');
  assert.deepEqual(restoreRecent('{"broken'), []);
  assert.equal(restoreRecent(Array.from({ length: 50 }, (_, i) => `q${i}`)).length, 10);
});
