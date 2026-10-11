import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProduct, parseTodayDrop, parseAiAnswer } from '../lib/parse.ts';
import { purchaseTarget } from '../lib/affiliate.ts';
import { toSavedItem, restoreSaved } from '../lib/savedModel.ts';

/*
 * Pre-release check «Coupang / ADPICK affiliate link use in native mobile app».
 *
 * These tests prove only what the code does to the URL: nothing. Whether Coupang Partners and
 * ADPICK allow their links in a native app is a policy question these tests cannot answer —
 * docs/STORE_READINESS.md keeps it open until the partners confirm.
 *
 * The samples have the shape of real server links (same hosts, same parameter names);
 * the partner IDs are placeholders.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SAMPLES = [
  // Coupang Partners search API productUrl
  'https://link.coupang.com/re/AFFSDP?lptag=AF0000000&pageKey=8082654809&itemId=20000000000&vendorItemId=95768196637&traceid=V0-153-0000000000000000&requestid=20260930120000000000000000&token=31850C%7CGM',
  // Coupang Partners short link
  'https://link.coupang.com/a/abcdEFGH12',
  // ADPICK commission link
  'https://biz.adpick.co.kr/r0000000',
  // ADPICK tracked link with query and fragment
  'https://adpick.co.kr/?ac=link&ad=00000&aff=0000&subid=seosa-app#m',
];

const row = link => ({ title: 'T', lprice: 1000, mall: '쿠팡', productId: '1', vendorItemId: '2', link });

test('server link → product → purchase target: byte-identical for every sample', () => {
  for (const url of SAMPLES) {
    const p = parseProduct(row(url));
    assert.equal(p.link, url);
    assert.equal(purchaseTarget(p.link, '쿠팡').url, url);
  }
});

test('affiliate parameters (lptag, subid, traceid, vendorItemId, token…) survive unchanged', () => {
  for (const url of SAMPLES) {
    const out = new URL(purchaseTarget(url, '').url);
    const inn = new URL(url);
    assert.equal(out.host, inn.host, 'no host change (no intermediate redirect)');
    assert.equal(out.pathname, inn.pathname);
    assert.deepEqual([...out.searchParams.entries()], [...inn.searchParams.entries()]);
    assert.equal(out.hash, inn.hash);
  }
});

test('the same holds on every path a link travels: today-drop, AI items, saved list', () => {
  const url = SAMPLES[0];
  const drop = parseTodayDrop({ id: 'x', productId: '1', mall: '쿠팡', vendorItemId: '2', title: 'T', currentPrice: 9, previousPrice: 10, dropAmount: 1, dropPct: 10, link: url });
  assert.equal(drop.link, url);
  const ai = parseAiAnswer({ text: 'a', items: [row(url)] });
  assert.equal(ai.items[0].link, url);
  const saved = toSavedItem(parseProduct(row(url)));
  assert.equal(saved.link, url);
  assert.equal(restoreSaved([saved])[0].link, url);
});

test('the buy button hands the URL to the OS as-is: Linking.openURL(target.url), no WebView/in-app browser', () => {
  const buy = src('components/BuyButton.tsx');
  assert.match(buy, /Linking\.openURL\(target\.url\)/);
  assert.match(buy, /purchaseTarget\(link, mallLabel\)/);
  assert.doesNotMatch(buy, /WebView|WebBrowser|openBrowserAsync|openAuthSessionAsync/);
  assert.doesNotMatch(buy, /target\.url\s*\+|`[^`]*\$\{target\.url\}/, 'no string built around the URL');
});

function appSources(dir = ROOT, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'dist', '.expo', 'assets', 'tests', 'docs'].includes(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) appSources(p, out);
    else if (/\.(tsx?|js)$/.test(name)) out.push(p);
  }
  return out;
}

test('no app code builds, rewrites or wraps affiliate URLs', () => {
  const offenders = [];
  for (const f of appSources()) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    // Building partner URLs or adding tracking parameters in the app would change attribution.
    if (/lptag=|subid=|AFFSDP|link\.coupang\.com|adpick\.co\.kr/i.test(s)) offenders.push(`${rel}: partner URL literal`);
    // A relay/redirect in front of the link (…/go?url=, /out?, /redirect) — the web avoids this on purpose.
    if (/[/?&](go|out|redirect|r)\?(url|u|to)=/i.test(s) || /\/redirect\b/i.test(s)) offenders.push(`${rel}: redirect pattern`);
    if (/encodeURIComponent\([^)]*\blink\b/.test(s)) offenders.push(`${rel}: link re-encoded`);
    if (/react-native-webview|expo-web-browser/.test(s)) offenders.push(`${rel}: in-app browser`);
  }
  assert.deepEqual(offenders, []);
});

test('only the buy button and the 마이 screen open external URLs', () => {
  const openers = appSources().filter(f => /Linking\.openURL\(/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(ROOT, f).replace(/\\/g, '/')).sort();
  assert.deepEqual(openers, ['app/(tabs)/me.tsx', 'components/BuyButton.tsx']);
});

test('unsafe links are dropped, never «fixed» into something else', () => {
  for (const bad of ['javascript:alert(1)', '//link.coupang.com/a/x', 'link.coupang.com/a/x', 'intent://x#Intent;end', '']) {
    assert.equal(parseProduct(row(bad)).link, '');
    assert.equal(purchaseTarget(bad, '쿠팡'), null);
  }
});
