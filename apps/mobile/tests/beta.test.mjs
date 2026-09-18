import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createApiClient, productFromParam } from '../lib/api.ts';
import { axisGutter, axisLabels, buildChartModel, CHART, MONO_ADVANCE, spreadLabels } from '../lib/chart.ts';
import { decodeHtmlEntities } from '../lib/text.ts';
import { bodyFamily, PLEX_MONO, PRETENDARD, resolveTypeface } from '../lib/typeface.ts';

const root = new URL('../', import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const exists = path => existsSync(new URL(path.replace(/^\.\//, ''), root));

/* ── product names: HTML entities ─────────────────────────────────── */

test('entities: common named and numeric entities decode, exactly one level', () => {
  assert.equal(decodeHtmlEntities('삼성 갤럭시 &amp; 버즈 &quot;프로&quot; &#39;23 &#x2F; 블랙'), '삼성 갤럭시 & 버즈 "프로" \'23 / 블랙');
  assert.equal(decodeHtmlEntities('A&lt;B&gt;C&nbsp;D'), 'A<B>C D');
  assert.equal(decodeHtmlEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;', 'double-encoded text decodes one level only');
  assert.equal(decodeHtmlEntities('R&D 3&4 &unknown; &#0; &#xD800; &#99999999;'), 'R&D 3&4 &unknown; &#0; &#xD800; &#99999999;');
  assert.equal(decodeHtmlEntities(''), '');
});

test('entities: API product names are decoded once; mall identifiers and carried cards are not rewritten', async () => {
  const raw = { title: '로지텍 M650 &amp; 키보드 &quot;세트&quot;', lprice: 39000, mall: 'A&amp;B', mallLabel: '11&amp;번가', productId: '1' };
  const client = createApiClient(async () => new Response(JSON.stringify([raw])));
  const [item] = await client.search('마우스');
  assert.equal(item.title, '로지텍 M650 & 키보드 "세트"');
  assert.equal(item.mallLabel, '11&번가');
  assert.equal(item.mall, 'A&amp;B', 'mall goes back to the server as a request parameter');

  // A card carried to the detail screen was already decoded; a literal "&amp;" in the real name must survive.
  const literal = { ...item, title: 'Tom &amp; Jerry 공식' };
  assert.equal(productFromParam(JSON.stringify(literal)).title, 'Tom &amp; Jerry 공식');
});

test('entities: the home feed decodes product names in every section', async () => {
  const client = createApiClient(async () => new Response(JSON.stringify({
    priceDrop: [{ title: 'A &amp; B', lprice: 1, mall: '쿠팡', productId: '1' }],
    daily: { keyword: 'k', products: [{ title: '&#54620;&#44544;', lprice: 1, mall: '쿠팡' }] },
  })));
  const feed = await client.home();
  assert.equal(feed.drops[0].title, 'A & B');
  assert.equal(feed.daily.products[0].title, '한글');
});

/* ── typefaces ────────────────────────────────────────────────────── */

test('typeface: weights map to the bundled Pretendard files', () => {
  assert.equal(bodyFamily(undefined), 'Pretendard-Regular');
  assert.equal(bodyFamily('normal'), 'Pretendard-Regular');
  assert.equal(bodyFamily('500'), 'Pretendard-Medium');
  assert.equal(bodyFamily('semibold'), 'Pretendard-SemiBold');
  assert.equal(bodyFamily('bold'), 'Pretendard-Bold');
  assert.equal(bodyFamily(700), 'Pretendard-Bold');
  assert.equal(bodyFamily('800'), 'Pretendard-ExtraBold');
  assert.equal(bodyFamily('900'), 'Pretendard-ExtraBold', 'heavier than bundled clamps to the heaviest file');
  assert.equal(bodyFamily('200'), 'Pretendard-Regular', 'lighter than bundled clamps to Regular');
});

test('typeface: system font until ready; explicit families kept; nested text inherits', () => {
  assert.equal(resolveTypeface({ fontWeight: '700' }, false, false), null, 'not loaded: system font with the declared weight');
  assert.deepEqual(resolveTypeface({ fontWeight: '700' }, true, false), { fontFamily: 'Pretendard-Bold' });
  assert.deepEqual(resolveTypeface({}, true, false), { fontFamily: 'Pretendard-Regular' });
  assert.equal(resolveTypeface({}, true, true), null, 'nested text without a weight keeps the parent face');
  assert.deepEqual(resolveTypeface({ fontWeight: '500' }, true, true), { fontFamily: 'Pretendard-Medium' });
  assert.equal(resolveTypeface({ fontFamily: PLEX_MONO }, true, false), null);
  assert.deepEqual(resolveTypeface({ fontFamily: PLEX_MONO, fontWeight: '600' }, true, false), { fontFamily: PLEX_MONO }, 'single-weight mono drops its weight');
  assert.equal(resolveTypeface({ fontFamily: 'Menlo', fontWeight: '600' }, true, false), null);
});

/* ── price chart: gutter, calendar spacing, labeled guides ────────── */

const HEIGHT = 220;
const opts = { height: HEIGHT, top: 10, bottom: 196, axisFontSize: 10, guideFontSize: 10 };

test('chart gutter: eight-digit prices get a gutter wide enough for their labels (no clipping)', () => {
  const points = [{ date: '2026-09-01', price: 12_000_000 }, { date: '2026-09-02', price: 12_500_000 }];
  const model = buildChartModel(points, 360, opts);
  const widest = Math.max(...model.ticks.map(t => t.label.length));
  assert.equal(model.ticks[0].label, '12,500,000');
  assert(model.left >= widest * 10 * MONO_ADVANCE, `gutter ${model.left} is narrower than "${model.ticks[0].label}"`);
  assert(model.left - 4 - widest * 10 * MONO_ADVANCE >= 0, 'right-aligned labels never start left of the chart');
  assert(model.coords.every(c => c.x >= model.left + CHART.side));
});

test('chart gutter: a narrow chart switches to 만/억 labels that stay distinct', () => {
  const values = [123_450_000, 123_400_000, 123_350_000];
  assert.deepEqual(axisLabels(values, 10, 1000), ['123,450,000', '123,400,000', '123,350,000']);
  const compact = axisLabels(values, 10, 120);
  assert.deepEqual(compact, ['12,345만', '12,340만', '12,335만'], '억 would need four decimals here, so 만 wins');
  assert(axisGutter(compact, 10) < axisGutter(['123,450,000'], 10));
  assert.deepEqual(axisLabels([300_000_000, 200_000_000], 10, 100), ['3억', '2억']);
  assert.deepEqual(axisLabels([12_000_000, 11_000_000], 10, 100), ['1,200만', '1,100만']);
});

test('chart spacing: x follows calendar days, so a collection gap stays visible', () => {
  const points = [{ date: '2026-09-01', price: 1000 }, { date: '2026-09-02', price: 1100 }, { date: '2026-09-11', price: 1200 }];
  const model = buildChartModel(points, 400, { left: 0 });
  assert.equal(model.spacing, 'date');
  const [a, b, c] = model.coords.map(p => p.x);
  assert.equal(a, CHART.side);
  assert.equal(c, 400 - CHART.side);
  assert(Math.abs((b - a) - (c - a) / 10) < 0.001, 'one day of a ten-day span is a tenth of the width');

  const odd = buildChartModel([{ date: 'x', price: 1 }, { date: 'y', price: 2 }, { date: 'z', price: 3 }], 400, { left: 0 });
  assert.equal(odd.spacing, 'index', 'unreadable dates fall back to even spacing');
  assert(Math.abs(odd.coords[1].x - 200) < 0.001);
});

test('chart guides: min/avg/max carry their own text label and value', () => {
  const points = [15000, 16800, 15900].map((price, i) => ({ date: `2026-09-0${i + 1}`, price }));
  const model = buildChartModel(points, 360, { ...opts, average: 15900 });
  assert.deepEqual(model.guides.map(g => g.label), ['최고 16,800', '평균 15,900', '최저 15,000']);
  for (const g of model.guides) {
    assert(g.labelY - g.labelHeight / 2 >= 0 && g.labelY + g.labelHeight / 2 <= HEIGHT, `${g.kind} label inside the chart`);
  }
  assert.match(model.accessibilityLabel, /평균 15,900원/);

  const outside = buildChartModel(points, 360, { ...opts, average: 30000 });
  assert.deepEqual(outside.guides.map(g => g.kind), ['max', 'min'], 'an average outside the drawn range is not drawn');
  assert.deepEqual(buildChartModel(points.map(p => ({ ...p, price: 5000 })), 360, opts).guides, [], 'flat history has no guides');
});

test('chart guides: close lines get labels pushed apart, and a label moves off the price line', () => {
  const close = [10000, 10010, 100000].map((price, i) => ({ date: `2026-09-0${i + 1}`, price }));
  const model = buildChartModel(close, 360, { ...opts, average: 10020 });
  const [, avg, min] = model.guides;
  assert(min.labelY - avg.labelY >= min.labelHeight, 'labels for nearly equal lines do not overlap');

  // The series starts at its highest price, so the 최고 label at the start would sit on the line.
  const startHigh = [20000, 15000, 18000].map((price, i) => ({ date: `2026-09-0${i + 1}`, price }));
  const max = buildChartModel(startHigh, 360, opts).guides.find(g => g.kind === 'max');
  assert.equal(max.anchor, 'end');

  assert.deepEqual(spreadLabels([100, 103, 104], 15, 7, 213), [100, 115, 130]);
  assert.deepEqual(spreadLabels([200, 205, 210], 15, 7, 213), [183, 198, 213]);
});

test('chart: tick labels never repeat when the range is only a few won', () => {
  const model = buildChartModel([{ date: '2026-09-01', price: 1000 }, { date: '2026-09-02', price: 1002 }], 360, opts);
  const labels = model.ticks.map(t => t.label);
  assert.equal(new Set(labels).size, labels.length);
});

/* ── installable beta config ──────────────────────────────────────── */

test('beta config: identifiers, versioning, runtime and update policy are pinned in app.json', () => {
  const { expo } = readJson('app.json');
  assert.equal(expo.ios.bundleIdentifier, 'kr.ai.seosa');
  assert.equal(expo.android.package, 'kr.ai.seosa');
  assert.match(expo.version, /^\d+\.\d+\.\d+$/);
  assert.match(expo.ios.buildNumber, /^\d+$/);
  assert(Number.isInteger(expo.android.versionCode) && expo.android.versionCode >= 1);
  assert.deepEqual(expo.runtimeVersion, { policy: 'appVersion' });
  assert.equal(expo.updates.enabled, false, 'no OTA updates in the beta: every JS change ships as a new build');
  assert.equal(expo.scheme, 'seosa');
  assert.equal(expo.ios.config.usesNonExemptEncryption, false);
});

test('beta config: EAS internal distribution with pinned toolchain and production API', () => {
  const eas = readJson('eas.json');
  const pkg = readJson('package.json');
  assert.equal(eas.cli.appVersionSource, 'local');
  assert.equal(eas.cli.requireCommit, true, 'builds come from a committed tree');
  assert.equal(eas.build.beta.distribution, 'internal');
  assert.equal(eas.build.beta.android.buildType, 'apk');
  assert.equal(eas.build['beta-simulator'].ios.simulator, true);
  assert.equal(eas.build.base.env.EXPO_PUBLIC_API_BASE_URL, 'https://seosa.ai.kr');
  assert.match(eas.build.base.node, /^\d+\.\d+\.\d+$/);
  assert.match(eas.build.base.pnpm, /^\d+\.\d+\.\d+$/);
  assert(pkg.dependencies['expo-splash-screen'] && pkg.dependencies['expo-font']);
});

test('beta config: light and dark launch screens and embedded fonts point at real files', () => {
  const { expo } = readJson('app.json');
  const plugin = name => expo.plugins.find(p => Array.isArray(p) && p[0] === name)?.[1];
  const splash = plugin('expo-splash-screen');
  assert.equal(splash.backgroundColor, '#FFFFFF');
  assert.equal(splash.dark.backgroundColor, '#16181C');
  assert.notEqual(splash.image, splash.dark.image, 'dark mode has its own launch artwork');
  assert(exists(splash.image) && exists(splash.dark.image));

  const fonts = plugin('expo-font').fonts;
  const names = fonts.map(path => path.split('/').pop().replace(/\.(otf|ttf)$/, ''));
  assert.deepEqual(new Set(names), new Set([...Object.values(PRETENDARD), PLEX_MONO]), 'embedded file names are the family names the app asks for');
  assert(fonts.every(exists));
  assert(exists('assets/fonts/Pretendard-OFL.txt') && exists('assets/fonts/IBMPlexMono-OFL.txt'));
});
