import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, displayableServerText, userMessage } from '../lib/api.ts';
import { purchaseTarget } from '../lib/affiliate.ts';
import { digits, won } from '../lib/format.ts';
import { parseProductKey } from '../lib/identity.ts';
import { parseAiAnswer, parsePoints, parseProduct, parseTodayDrops } from '../lib/parse.ts';
import { createTapGuard } from '../lib/tapGuard.ts';

/*
 * Store reviewer + hostile input pass (2026-10-10). Each case was a way to crash the app, spin
 * forever, show raw server text, or open something other than the server's link.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

function api(respond) {
  return createApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async (url, init) => {
      const r = await respond(new URL(url), init);
      return { status: r.status ?? 200, headers: { get: () => null }, json: async () => { if (r.raw) throw new SyntaxError('bad json'); return r.body; } };
    },
  });
}

test('repeated taps open a screen once; a different target or a later tap still goes through', () => {
  const allow = createTapGuard(700);
  assert.equal(allow('product:1|쿠팡|2', 1000), true);
  assert.equal(allow('product:1|쿠팡|2', 1100), false, 'double tap ignored');
  assert.equal(allow('product:1|쿠팡|2', 1650), false);
  assert.equal(allow('/concierge', 1660), true, 'another target is not blocked');
  assert.equal(allow('product:1|쿠팡|2', 1700), true, 'same target again after another one');
  assert.equal(allow('product:1|쿠팡|2', 2500), true, 'and after the window');
  // Every in-app push of a screen goes through the guard.
  for (const f of ['components/ProductRow.tsx', 'app/(tabs)/index.tsx', 'app/(tabs)/search.tsx', 'app/product/[key].tsx', 'app/concierge.tsx', 'app/(tabs)/me.tsx']) {
    assert.doesNotMatch(src(f), /router\.push\(/, `${f} pushes through pushOnce`);
  }
});

test('server error text: only short Korean sentences reach the screen', () => {
  assert.equal(displayableServerText('요청이 너무 잦아요. 12초 후 다시 시도해 주세요.'), '요청이 너무 잦아요. 12초 후 다시 시도해 주세요.');
  assert.equal(displayableServerText('PRO 자동결제가 켜져 있어요. 구독 해지 후 다시 시도해 주세요.'), 'PRO 자동결제가 켜져 있어요. 구독 해지 후 다시 시도해 주세요.');
  for (const raw of [
    'Too Many Requests', '<html><body>502 Bad Gateway</body></html>', '{"error":"x"}', '오류 {"code":1}',
    'TypeError: x is undefined at handler (api/ai.js:10:5)', '실패 at handler (api/ai.js:10:5)', '실패: undefined',
    '자세한 내용은 https://example.com', '가'.repeat(141), '', '   ', 42, null, { message: '객체' },
  ]) {
    assert.equal(displayableServerText(raw), '', JSON.stringify(raw));
  }
});

test('malformed or hostile payloads never crash: they end as a clear error or an empty, honest list', async () => {
  // Wrong shapes where a list or object is expected.
  await assert.rejects(api(() => ({ body: { items: 'nope' } })).todayDrops(), { kind: 'invalid_response' });
  await assert.rejects(api(() => ({ body: 'text' })).search('x'), { kind: 'invalid_response' });
  await assert.rejects(api(() => ({ raw: true })).home(), { kind: 'invalid_response' });
  await assert.rejects(api(() => ({ body: { points: 'x' } })).history({ productId: '1', mall: '쿠팡', vendorItemId: '' }), { kind: 'invalid_response' });
  await assert.rejects(api(() => ({ body: { text: 5 } })).ask({}, undefined), { kind: 'invalid_response' });
  // Rows with impossible numbers are dropped, never shown as 0원 or negative.
  const rows = [
    { productId: '1', mall: '쿠팡', title: 'zero', lprice: 0 },
    { productId: '2', mall: '쿠팡', title: 'negative', lprice: -1000 },
    { productId: '3', mall: '쿠팡', title: 'nan', lprice: 'abc' },
    { productId: '4', mall: '쿠팡', title: 'inf', lprice: Infinity },
    { productId: '5', mall: '쿠팡', title: '', lprice: 1000 },
    { productId: '', mall: '쿠팡', title: 'no id', lprice: 1000 },
    null, 7, 'row', [],
  ];
  assert.deepEqual(rows.map(parseProduct).filter(Boolean), []);
  assert.deepEqual(parseTodayDrops({ items: [null, { productId: '1', mall: '쿠팡', title: 't', currentPrice: 900, previousPrice: 800, dropAmount: 100, dropPct: 10 }] }), [], 'a "drop" that went up is dropped');
  assert.deepEqual(parsePoints([{ date: '2026-13-99x', price: 1 }, { date: '2026-10-01', price: -1 }, { date: '2026-10-02', price: '1,000' }]), []);
  const ai = parseAiAnswer({ text: '답', items: [null, { productId: '1' }], followups: [1, null, 'x'.repeat(500), '다음'] });
  assert.deepEqual(ai.items, []);
  assert.equal(ai.followups.every(f => f.length <= 60), true);
});

test('huge prices format without exponent or overflow; the drop price line wraps instead of overflowing', () => {
  assert.equal(digits(12_345_678_900), '12,345,678,900');
  assert.equal(won(9_999_999_999_999), '9,999,999,999,999원');
  assert.equal(digits(0), '');
  assert.equal(digits(-5), '');
  assert.equal(digits(Number.NaN), '');
  const big = parseProduct({ productId: '1', mall: '쿠팡', title: '대형 가전', lprice: 98_765_432_100 });
  assert.equal(big.price, 98_765_432_100);
  assert.match(src('components/DropRow.tsx'), /priceLine: \{[^}]*flexWrap: 'wrap'/);
});

test('deep links: oversized parts and control characters are refused; odd but well-formed keys stay inert data', () => {
  assert.equal(parseProductKey('x'.repeat(401)), null);
  assert.equal(parseProductKey(`${'1'.repeat(129)}|쿠팡|2`), null);
  assert.equal(parseProductKey(`1|${'몰'.repeat(41)}|2`), null);
  assert.equal(parseProductKey('1|쿠팡|2\n3'), null);
  assert.equal(parseProductKey('1|쿠팡|\u0000'), null);
  assert.equal(parseProductKey('|쿠팡|2'), null);
  assert.equal(parseProductKey('only-one-part'), null);
  // A script-looking id is just an id: it is sent as an encoded query value and the server answers 404.
  assert.deepEqual(parseProductKey('javascript:alert(1)|쿠팡|<img>'), { productId: 'javascript:alert(1)', mall: '쿠팡', vendorItemId: '<img>' });
  assert.deepEqual(parseProductKey('8082654809|쿠팡|95768196637'), { productId: '8082654809', mall: '쿠팡', vendorItemId: '95768196637' });
});

test('deep link lookup with a hostile id is an encoded query value, never part of the path', async () => {
  const seen = [];
  const client = createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: async url => { seen.push(new URL(url)); return { status: 404, headers: { get: () => null }, json: async () => ({ error: '없음' }) }; } });
  assert.equal(await client.productById('../../api/auth?x=1#y', '쿠팡'), null);
  assert.equal(seen[0].pathname, '/api/history');
  assert.equal(seen[0].searchParams.get('pid'), '../../api/auth?x=1#y');
  assert.equal(seen[0].hash, '');
});

test('purchase links: only absolute http(s) is opened, byte-for-byte; scheme tricks are dropped', () => {
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'intent://scan#Intent;scheme=zxing;end', 'seosa://product/1', 'mailto:a@b.co', 'tel:010', '//evil.example', 'link.coupang.com/a/x', '']) {
    assert.equal(purchaseTarget(bad, '쿠팡'), null, bad);
  }
  const http = 'http://link.coupang.com/a/x?lptag=AF1';
  assert.equal(purchaseTarget(http, '쿠팡').url, http, 'http is not rewritten to https — the server decides the link');
  const weird = 'https://link.coupang.com/a/x?q=%ED%95%9C%EA%B8%80&a=1&a=2#frag';
  assert.equal(purchaseTarget(weird, '쿠팡').url, weird);
});

test('very long, unicode and emoji searches are cut safely and sent as one well-formed query value', async () => {
  const seen = [];
  const client = createApi({ baseUrl: 'https://seosa.ai.kr', fetchImpl: async url => { seen.push(new URL(url)); return { status: 200, headers: { get: () => null }, json: async () => [] }; } });
  await client.search('a'.repeat(79) + '😀😀');
  await client.search('  갤럭시 🎧 버즈 & <b>프로</b> #1 ?x=y  ');
  await client.search('‮evil‬ 이어폰');
  for (const u of seen) {
    assert.equal(u.pathname, '/api/search');
    assert.ok(u.searchParams.get('keyword').length <= 80);
    assert.doesNotThrow(() => decodeURIComponent(u.search), 'no lone surrogate breaks the URL');
  }
  assert.equal(seen[1].searchParams.get('keyword'), '갤럭시 🎧 버즈 & <b>프로</b> #1 ?x=y');
  await assert.rejects(client.search('   '), { kind: 'bad_request' });
});

test('wide screens: the app is one centred column, phones are unaffected', () => {
  // lib/theme.ts imports react-native at runtime, so the constant is read from source.
  const max = Number((/layout = \{ maxWidth: (\d+) \}/.exec(src('lib/theme.ts')) || [])[1]);
  assert.ok(max >= 600 && max <= 768, `column ${max}dp: wider than any phone, narrower than a tablet`);
  const root = src('app/_layout.tsx');
  assert.match(root, /maxWidth: layout\.maxWidth/);
  assert.match(root, /<View style=\{styles\.column\}>\s*<Stack/);
});

test('account deletion outcomes never strand the user: 401 → login, 409 → reason, 5xx → retry text', async () => {
  const client = status => api(() => ({ status, body: { error: status === 409 ? 'PRO 자동결제가 켜져 있어요. 구독 해지 후 다시 시도해 주세요.' : 'internal stack at x.js:1:1' } }));
  await assert.rejects(client(401).deleteAccount('t'), e => e.kind === 'unauthorized');
  await assert.rejects(client(409).deleteAccount('t'), e => userMessage(e) === 'PRO 자동결제가 켜져 있어요. 구독 해지 후 다시 시도해 주세요.');
  await assert.rejects(client(503).deleteAccount('t'), e => userMessage(e) === '지금은 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  await assert.rejects(client(502).deleteAccount('t'), e => !/stack|x\.js/.test(userMessage(e)));
});

test('chart price labels fit: the gutter grows with the widest label (no "1,250,00" clipping)', async () => {
  const { labelGutter } = await import('../lib/chart.ts');
  const pts = price => [{ date: '2026-10-01', price }, { date: '2026-10-02', price: price * 0.9 }];
  const room = price => labelGutter(pts(price)) - 14;          // labels start 14 dp past the plot
  const need = price => String(Math.round(price)).replace(/\B(?=(\d{3})+(?!\d))/g, ',').length * 11 * 0.6;
  for (const price of [9_900, 39_900, 990_000, 1_290_000, 3_450_000, 12_900_000, 129_000_000, 12_345_678_900]) {
    assert.ok(room(price) >= need(price), `${price}: room ${room(price)} < ${need(price)}`);
  }
  assert.equal(labelGutter(pts(39_900)), 64, 'cheap items keep the original gutter');
  assert.equal(labelGutter([]), 64);
  assert.match(src('components/PriceChart.tsx'), /labelGutter\(shown\)/);
  assert.doesNotMatch(src('components/PriceChart.tsx'), /PAD\.right/, 'every position uses the computed gutter');
});
