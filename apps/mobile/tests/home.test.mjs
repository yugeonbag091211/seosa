import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../lib/api.ts';
import { AFFILIATE_NOTE } from '../lib/affiliate.ts';
import {
  HERO_DEMO, HERO_DOTS_ZONE, HERO_GUTTER, HERO_SLIDES, HERO_WIDE_MIN, MONTHLY_CARDS, PAGER_START, VETERAN_PLEDGE,
  heroArtBox, heroMetrics, monthlyHeading, monthlyState, monthlySubline, pageIndex, pagerStep, recordStamp, safeFontScale, tileWidth,
} from '../lib/home.ts';
import { parseMonthly } from '../lib/parse.ts';

/*
 * Home parity with the web (2026-10-10): hero banners, «N월 추천 상품», the «MM.DD 수집» stamp.
 * Screens are thin over lib/home.ts and the API client, so the rules are pinned here; the wiring
 * tests read the component sources the way tests/release.test.mjs does.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
// The web page the copy must match: the repo's own by default; SEOSA_WEB_INDEX points the parity
// tests at another copy (e.g. `git show origin/main:public/index.html > /tmp/web.html`).
const WEB_INDEX = process.env.SEOSA_WEB_INDEX || path.resolve(ROOT, '../../public/index.html');

const COUPANG_LINK = 'https://link.coupang.com/re/AFFSDP?lptag=AF0000000&pageKey=108135001&itemId=1&vendorItemId=3802075172';
const product = (over = {}) => ({
  productId: '108135001', mall: '쿠팡', vendorItemId: '3802075172', mallLabel: '쿠팡',
  title: '남성 경량 등산복 자켓', lprice: 6900, link: COUPANG_LINK, image: 'https://ads-partners.coupang.com/image1/x',
  collectedAt: '2026-10-09T22:48:32.181+00:00', ...over,
});
/** The production /api/init `monthly` shape (measured 2026-10-10). */
const MONTHLY = {
  id: 10, month: 10, title: '깊어가는 가을', subtitle: '감성을 더하는 가을의 큐레이션',
  keywords: ['등산복', '할로윈 의상 및 소품', '가습기', '맨투맨', '니트', '텀블러', '화로대', '트레킹 코스'],
  products: [product(), product({ productId: '2', title: '가습기 대용량', lprice: 39000 })],
};

function fakeApi(body, status = 200) {
  return createApi({
    baseUrl: 'https://seosa.ai.kr',
    fetchImpl: async () => ({ status, headers: { get: () => null }, json: async () => body }),
  });
}

/* ── /api/init monthly ─────────────────────────────────────────────── */

test('monthly: the production payload parses field for field', () => {
  const m = parseMonthly(MONTHLY);
  assert.equal(m.month, 10);
  assert.equal(m.title, '깊어가는 가을');
  assert.equal(m.subtitle, '감성을 더하는 가을의 큐레이션');
  assert.deepEqual(m.keywords, MONTHLY.keywords);
  assert.equal(m.products.length, 2);
  assert.equal(m.products[0].link, COUPANG_LINK, 'affiliate link kept byte-for-byte');
  assert.equal(m.products[0].vendorItemId, '3802075172', 'option kept, so the card opens the right price history');
});

test('monthly: hostile or partial rows never crash and never invent content', () => {
  for (const bad of [null, undefined, 'x', 7, [], {}, { month: 10 }, { title: '', keywords: [] }, { title: '  ', keywords: [null, '', 5 > 9] }]) {
    assert.equal(parseMonthly(bad), null, JSON.stringify(bad));
  }
  const m = parseMonthly({
    month: 13, title: '가을 &amp; 겨울', keywords: ['니트', '니트', '', 3, 'x'.repeat(31), ' 맨투맨 '],
    products: [null, { productId: '1', mall: '쿠팡', title: '0원', lprice: 0 }, product()],
  });
  assert.equal(m.month, 0, 'out-of-range month is unknown, not guessed');
  assert.equal(m.title, '가을 & 겨울');
  assert.deepEqual(m.keywords, ['니트', '3', '맨투맨'], 'deduped, trimmed, over-long dropped');
  assert.equal(m.products.length, 1, 'unusable product rows dropped');
  assert.equal(parseMonthly({ month: '9', keywords: ['니트'] }).month, 9);
  assert.equal(parseMonthly({ month: 9.5, keywords: ['니트'] }).month, 0);
});

test('api.home: monthly rides along; a missing or broken monthly leaves the rest of the feed intact', async () => {
  const base = { popular: [{ keyword: '무선 이어폰', count: 34 }], daily: { keyword: '마우스', products: [product()] } };
  const full = await fakeApi({ ...base, monthly: MONTHLY, priceDrop: [] }).home();
  assert.equal(full.monthly.month, 10);
  assert.equal(full.monthly.products.length, 2);
  for (const monthly of [undefined, null, 'oops', { month: 10 }]) {
    const feed = await fakeApi({ ...base, monthly }).home();
    assert.equal(feed.monthly, null);
    assert.deepEqual(feed.popular, ['무선 이어폰']);
    assert.equal(feed.daily.products.length, 1);
  }
});

test('monthly API outage and timeout lead to the retry state without live requests', async () => {
  await assert.rejects(fakeApi({ error: 'mock outage' }, 503).home(), { kind: 'unavailable' });
  assert.equal(monthlyState(undefined, false, true), 'error');

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 1, ...args);
  try {
    const hanging = createApi({
      baseUrl: 'https://seosa.ai.kr',
      fetchImpl: (_url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('mock timeout')), { once: true });
      }),
    });
    await assert.rejects(hanging.home(), { kind: 'timeout' });
    assert.equal(monthlyState(undefined, false, true), 'error');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('monthly parsing bounds long text and oversized product payloads', () => {
  const many = Array.from({ length: 24 }, (_, i) => product({ productId: `monthly-${i}`, lprice: 1000 + i }));
  const m = parseMonthly({
    month: 'not-a-month', title: '가'.repeat(70), subtitle: '나'.repeat(130),
    keywords: Array.from({ length: 40 }, (_, i) => `키워드${i}`), products: many,
  });
  assert.equal(m.month, 0, 'malformed month stays unknown');
  assert.equal([...m.title].length, 60);
  assert.equal(m.title.at(-1), '…');
  assert.equal([...m.subtitle].length, 120);
  assert.equal(m.subtitle.at(-1), '…');
  assert.equal(m.keywords.length, 12);
  assert.equal(m.products.length, 8, 'an oversized response cannot make an unbounded rail');
  assert.equal(monthlyState(m, false, false), 'cards');
});

test('monthly product-only rows are usable; zero products keep the web empty state', () => {
  const onlyProducts = parseMonthly({ month: 10, products: [product()] });
  assert.equal(onlyProducts.products.length, 1);
  assert.equal(monthlyState(onlyProducts, false, false), 'cards');
  const empty = parseMonthly({ month: 10, title: '이번 달 추천', keywords: [], products: [] });
  assert.equal(monthlyState(empty, false, false), 'empty');
});

/* ── «N월 추천 상품» ───────────────────────────────────────────────── */

test('monthly heading follows the curation row and never relabels a stale month', () => {
  assert.equal(monthlyHeading(parseMonthly(MONTHLY)), '10월 추천 상품');
  assert.equal(monthlyHeading({ ...parseMonthly(MONTHLY), month: 9 }), '9월 추천 상품', 'October does not relabel a cached September row');
  assert.equal(monthlyHeading(null), '이달의 추천 상품');
  assert.equal(monthlyHeading({ ...parseMonthly(MONTHLY), month: 0 }), '이달의 추천 상품');
});

test('monthly subline joins whatever banner text exists', () => {
  assert.equal(monthlySubline(parseMonthly(MONTHLY)), '깊어가는 가을 · 감성을 더하는 가을의 큐레이션');
  assert.equal(monthlySubline({ ...parseMonthly(MONTHLY), subtitle: '' }), '깊어가는 가을');
  assert.equal(monthlySubline(null), '');
});

test('monthly section states: loading, error, hidden, empty, cards', () => {
  const m = parseMonthly(MONTHLY);
  assert.equal(monthlyState(undefined, true, false), 'loading');
  assert.equal(monthlyState(undefined, false, true), 'error');
  assert.equal(monthlyState(null, false, false), 'hidden', 'no curation this month → no section');
  assert.equal(monthlyState({ ...m, products: [] }, false, false), 'empty');
  assert.equal(monthlyState(m, false, false), 'cards');
  assert.equal(monthlyState(m, false, true), 'cards', 'a failed refresh keeps the row on screen');
  assert.ok(MONTHLY_CARDS >= 8, 'the server sends 8 (SECTION_SIZE); all of them fit');
});

/* ── «MM.DD 수집» ──────────────────────────────────────────────────── */

test('record stamp: newest collection date among the products, on the KST calendar', () => {
  const now = Date.parse('2026-10-10T03:00:00Z');
  const a = [product({ collectedAt: '2026-10-08T22:00:00Z' })];
  const b = [product({ collectedAt: '2026-10-09T22:48:32.181+00:00' })]; // 10-10 07:48 KST
  assert.equal(recordStamp([a, b], now), '10.10 수집');
  assert.equal(recordStamp([a, undefined, null], now), '10.09 수집');
  assert.equal(recordStamp([[product({ collectedAt: '' })], [product({ collectedAt: 'yesterday' })]], now), '', 'no readable date → no stamp');
  assert.equal(recordStamp([], now), '');
  assert.equal(recordStamp([[product({ collectedAt: '2026-10-20T00:00:00Z' })], a], now), '10.09 수집', 'a date days ahead of the clock is ignored');
});

/* ── Hero layout ───────────────────────────────────────────────────── */

test('hero metrics: compact on phones, side by side from 600 dp; headline scales with width', () => {
  assert.equal(heroMetrics(320).wide, false);
  assert.equal(heroMetrics(390).wide, false);
  assert.equal(heroMetrics(HERO_WIDE_MIN - 1).wide, false);
  assert.equal(heroMetrics(HERO_WIDE_MIN).wide, true);
  assert.equal(heroMetrics(720).wide, true);
  assert.equal(heroMetrics(390).titleSize, 29);
  assert.equal(heroMetrics(320).titleSize, 24);
  assert.ok(heroMetrics(599).titleSize <= 32, 'capped on large phones');
  for (const bad of [0, -1, NaN, Infinity]) assert.equal(heroMetrics(bad).wide, false);
});

test('hero metrics: text uses a proportionate line box and hides art only from 160%', () => {
  for (const scale of [1, 1.3, 1.5]) {
    const m = heroMetrics(390, scale);
    assert.equal(m.showArt, true, `art remains at ${scale}`);
    assert.equal(m.artHeight, 84);
    assert.equal(m.titleLine, Math.round(m.titleSize * 1.18), 'native Text scales the line box with the font');
  }
  assert.equal(heroMetrics(390, 1.6).showArt, false);
  assert.equal(heroMetrics(800, 1.5).titleLine, 44);
  assert.equal(safeFontScale(undefined), 1);
  assert.equal(safeFontScale(NaN), 1);
  assert.equal(safeFontScale(5), 3.5);
  assert.equal(tileWidth(1), 148);
  assert.equal(tileWidth(1.3), 192);
  assert.equal(tileWidth(1.5), 200);
});

test('compact hero art fits beside the dot hit targets at common phone widths', () => {
  for (const width of [320, 375, 390, 430]) {
    const metrics = heroMetrics(width);
    for (const kind of ['shelf', 'ai', 'price', 'memorial']) {
      const box = heroArtBox(kind, metrics);
      assert.equal(box.height, 84, `${kind} at ${width}`);
      assert.ok(box.width > 0 && box.width <= width - 2 * HERO_GUTTER - HERO_DOTS_ZONE, `${kind} width at ${width}`);
    }
  }
});

test('hero metrics: the longest headline line fits one line at every phone width', () => {
  // Pretendard Hangul advance ≤ 0.96 em, minus the -0.04 em tracking; Latin/punctuation/space ≤ 0.6 em.
  const lineWidth = (line, size) => [...line].reduce((w, ch) => w + size * (/[가-힣]/.test(ch) ? 0.92 : 0.56), 0);
  for (const width of [320, 360, 375, 390, 430, 599]) {
    const { titleSize } = heroMetrics(width);
    const room = width - 2 * 20; // gutter both sides
    for (const slide of HERO_SLIDES) {
      for (const line of slide.title) assert.ok(lineWidth(line, titleSize) <= room, `${width}dp: «${line}» at ${titleSize}`);
    }
  }
});

test('page index: rounds to the nearest page and never leaves the range', () => {
  assert.equal(pageIndex(0, 390, 4), 0);
  assert.equal(pageIndex(390, 390, 4), 1);
  assert.equal(pageIndex(390 * 1.4, 390, 4), 1);
  assert.equal(pageIndex(390 * 1.6, 390, 4), 2);
  assert.equal(pageIndex(-200, 390, 4), 0, 'overscroll left');
  assert.equal(pageIndex(390 * 9, 390, 4), 3, 'overscroll right');
  assert.equal(pageIndex(100, 0, 4), 0);
  assert.equal(pageIndex(NaN, 390, 4), 0);
  assert.equal(pageIndex(100, 390, 0), 0);
});

test('carousel dot jumps pin the target through intermediate scroll events in either direction', () => {
  const width = 390;
  let state = pagerStep(PAGER_START, { type: 'dot', index: 3 }, 4);
  assert.deepEqual(state, { index: 3, target: 3 }, '0 → 3 selects the destination immediately');
  for (const page of [0.4, 1.4, 2.4]) {
    state = pagerStep(state, { type: 'scroll', x: width * page, width }, 4);
    assert.deepEqual(state, { index: 3, target: 3 }, 'intermediate pages do not flicker the indicator');
  }
  state = pagerStep(state, { type: 'settle', x: width * 3, width }, 4);
  assert.deepEqual(state, { index: 3, target: null });

  state = pagerStep(state, { type: 'dot', index: 0 }, 4);
  state = pagerStep(state, { type: 'settle', x: width * 2.4, width }, 4);
  assert.deepEqual(state, { index: 0, target: 0 }, '3 → 0 stays pinned');
  state = pagerStep(state, { type: 'settle', x: 0, width }, 4);
  assert.deepEqual(state, { index: 0, target: null });
});

test('carousel rapid dot taps replace the pending target; swipes follow the visible page', () => {
  const width = 390;
  let state = pagerStep(PAGER_START, { type: 'dot', index: 3 }, 4);
  state = pagerStep(state, { type: 'dot', index: 2 }, 4);
  state = pagerStep(state, { type: 'dot', index: 1 }, 4);
  state = pagerStep(state, { type: 'settle', x: width * 2.4, width }, 4);
  assert.deepEqual(state, { index: 1, target: 1 }, 'an older animation ending cannot release the newer target');
  state = pagerStep(state, { type: 'scroll', x: width * 2.4, width }, 4);
  assert.deepEqual(state, { index: 1, target: 1 }, 'latest tap wins while the animation crosses older pages');
  state = pagerStep(state, { type: 'settle', x: width, width }, 4);
  assert.deepEqual(state, { index: 1, target: null });

  state = pagerStep(PAGER_START, { type: 'scroll', x: width * 1.6, width }, 4);
  assert.deepEqual(state, { index: 2, target: null }, 'a normal swipe follows the nearest visible page');
  state = pagerStep(state, { type: 'drag' }, 4);
  assert.deepEqual(state, { index: 2, target: null });
  state = pagerStep(state, { type: 'settle', x: width * 2, width }, 4);
  assert.deepEqual(state, { index: 2, target: null });
});

/* ── Hero content ──────────────────────────────────────────────────── */

test('hero slides: four web banners, each with a reachable action', () => {
  assert.deepEqual(HERO_SLIDES.map(s => s.id), ['brand', 'ai', 'timing', 'veteran']);
  assert.equal(new Set(HERO_SLIDES.map(s => s.id)).size, HERO_SLIDES.length);
  assert.deepEqual(HERO_SLIDES[0].title, ['최저가도,', '고급지게.']);
  assert.equal(HERO_SLIDES[0].cta.label, 'AI Concierge에게 물어보기');
  assert.deepEqual(HERO_SLIDES.map(s => s.cta.action), ['concierge', 'concierge', 'drops', 'pledge']);
  for (const s of HERO_SLIDES) {
    assert.ok(s.label && s.sub && s.title.length === 2 && s.cta.label, s.id);
  }
  assert.deepEqual(HERO_SLIDES.filter(s => s.stamp).map(s => s.id), ['brand'], 'only the brand slide carries the stamp');
  assert.deepEqual(HERO_SLIDES.filter(s => s.note?.kind === 'affiliate').map(s => s.id), ['brand', 'ai'], 'disclosure where the web has it');
});

/** The four .hc-slide blocks of the web's #heroCarousel, in order. */
function webSlides(html) {
  const start = html.indexOf('id="heroCarousel"');
  const end = html.indexOf('/.hc-viewport', start);
  assert.ok(start > 0 && end > start, 'web hero carousel found');
  return html.slice(start, end).split('<div class="hc-slide').slice(1);
}
const plain = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const WEB_ACT = { concierge: 'ai-entry', drops: 'scroll-drop', pledge: 'open-veteran' };

test('hero copy matches the web word for word, slide by slide', t => {
  if (!fs.existsSync(WEB_INDEX)) return t.skip('public/index.html is not next to this app');
  const slides = webSlides(fs.readFileSync(WEB_INDEX, 'utf8'));
  assert.equal(slides.length, HERO_SLIDES.length, 'same number of banners as the web');
  HERO_SLIDES.forEach((s, i) => {
    const block = slides[i];
    assert.ok(block.includes(s.title.join('<br>')), `${s.id}: title`);
    assert.ok(block.includes(s.sub), `${s.id}: sub`);
    assert.ok(block.includes(`data-label="${s.label}"`), `${s.id}: label`);
    const cta = /class="hero-cta"\s+data-act="([^"]+)"[^>]*>([^<]+)</.exec(block);
    assert.ok(cta, `${s.id}: web CTA`);
    assert.equal(cta[2].trim(), s.cta.label, `${s.id}: CTA label`);
    assert.equal(cta[1], WEB_ACT[s.cta.action], `${s.id}: CTA goes where the web's goes`);
    if (s.tag) assert.ok(block.includes(`>${s.tag}<`), `${s.id}: tag`);
    if (s.note?.kind === 'text') assert.ok(block.includes(s.note.text), `${s.id}: note`);
    if (s.note?.kind === 'affiliate') assert.ok(plain(block).includes(AFFILIATE_NOTE), `${s.id}: disclosure`);
  });
  const demo = slides[1] + slides[2];
  for (const text of [HERO_DEMO.tag, HERO_DEMO.ask.join('<br>'), HERO_DEMO.rank, HERO_DEMO.answerTitle, HERO_DEMO.answerPrice, HERO_DEMO.answerFit, HERO_DEMO.verdictBadge, HERO_DEMO.verdictText]) {
    assert.ok(demo.includes(text), `example screen: ${text}`);
  }
});

test('veteran pledge matches the web overlay word for word', t => {
  if (!fs.existsSync(WEB_INDEX)) return t.skip('public/index.html is not next to this app');
  const html = fs.readFileSync(WEB_INDEX, 'utf8');
  const start = html.indexOf('id="veteranOverlay"');
  assert.ok(start > 0, 'web overlay found');
  const overlay = plain(html.slice(start, html.indexOf('<div class="overlay"', start + 10)));
  assert.ok(overlay.includes(VETERAN_PLEDGE.title));
  assert.ok(overlay.includes(VETERAN_PLEDGE.lead));
  for (const p of VETERAN_PLEDGE.paragraphs) assert.ok(overlay.includes(p.map(s => s.text).join('')), p[0].text.slice(0, 20));
  assert.ok(overlay.includes(VETERAN_PLEDGE.footnote));
});

/* ── Wiring ────────────────────────────────────────────────────────── */

test('hero buttons: AI → concierge, timing → 가격하락 tab, pledge → its screen; nothing opens a URL', () => {
  const hero = src('components/HeroCarousel.tsx');
  assert.match(hero, /case 'concierge': pushOnce\('\/concierge'\)/);
  assert.match(hero, /case 'drops': router\.navigate\('\/drops'\)/);
  assert.match(hero, /case 'pledge': pushOnce\('\/pledge'\)/);
  assert.match(hero, /onPress=\{\(\) => runHeroAction\(slide\.cta\.action\)\}/);
  assert.match(hero, /onMomentumScrollEnd=/);
  assert.match(hero, /onScrollBeginDrag=/);
  assert.doesNotMatch(hero, /setTimeout|RELEASE_MS/, 'dot selection is released by scroll events, not a timer');
  for (const f of ['components/HeroCarousel.tsx', 'components/HeroArt.tsx', 'components/MonthlyPicks.tsx', 'components/ProductTile.tsx', 'app/pledge.tsx']) {
    const s = src(f);
    assert.doesNotMatch(s, /router\.push\(/, `${f} pushes through pushOnce`);
    assert.doesNotMatch(s, /Linking|openURL|https?:\/\//, `${f} opens no URL`);
  }
  assert.doesNotMatch(src('components/HeroArt.tsx'), /onPress/, 'drawings are not buttons');
});

test('the pledge screen exists and is registered as a modal', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'app/pledge.tsx')));
  assert.match(src('app/_layout.tsx'), /<Stack\.Screen name="pledge" options=\{\{ presentation: 'modal'/);
  assert.match(src('app/pledge.tsx'), /VETERAN_PLEDGE/);
});

test('monthly cards open the product screen with the option key (same path as list rows)', () => {
  const tile = src('components/ProductTile.tsx');
  assert.match(tile, /onPress=\{\(\) => openProduct\(product\)\}/);
  assert.match(tile, /<Thumb uri=\{product\.image\}/, 'image failure falls back to the Thumb glyph');
  const picks = src('components/MonthlyPicks.tsx');
  assert.match(picks, /onPress=\{\(\) => onKeyword\(k\)\}/);
  assert.match(picks, /monthlyState\(monthly, pending, !!error\)/);
  assert.match(src('components/Thumb.tsx'), /onError=\{\(\) => setFailed\(true\)\}/, 'missing or broken image falls back to the local thumb');
});

test('home order follows the web: search → hero → keywords → drops → selection → monthly → disclosure', () => {
  const home = src('app/(tabs)/index.tsx');
  const at = re => { const m = re.exec(home); assert.ok(m, String(re)); return m.index; };
  const order = [
    at(/accessibilityRole="search"/),
    at(/<HeroCarousel stamp=\{stamp\} \/>/),
    at(/home\.data\.popular\.slice/),
    at(/title="오늘 가격 하락"/),
    at(/title="오늘의 셀렉션"/),
    at(/<MonthlyPicks/),
    at(/<AffiliateNote style/),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(home, /monthly=\{home\.data\?\.monthly\}/);
  assert.match(home, /recordStamp\(\[home\.data\?\.daily\?\.products, home\.data\?\.monthly\?\.products\]\)/);
});
