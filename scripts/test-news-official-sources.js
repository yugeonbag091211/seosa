#!/usr/bin/env node
'use strict';

const assert = require('assert');
const F = require('../api/_news-fetch');
const NR = require('../api/_news-research');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.stack || e}`); }
}

const NOW = new Date('2026-09-12T01:00:00.000Z');
const source = id => NR.OFFICIAL_AI_FEEDS.find(x => x.id === id);
const anthropic = source('ANTHROPIC_OFFICIAL');
const perplexity = source('PERPLEXITY_OFFICIAL');

function rssItem({ title, url, date, summary, encoded }) {
  return `<item><title><![CDATA[${title || ''}]]></title><link><![CDATA[${url || ''}]]></link>`
    + `<pubDate>${date || ''}</pubDate>`
    + (summary == null ? '' : `<description><![CDATA[${summary}]]></description>`)
    + (encoded == null ? '' : `<content:encoded><![CDATA[${encoded}]]></content:encoded>`)
    + '</item>';
}
const rss = items => `<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`;

function rawFor(feed, overrides) {
  const isAnthropic = feed.id === 'ANTHROPIC_OFFICIAL';
  return Object.assign({
    title: isAnthropic ? 'Claude Platform release notes — September 11, 2026' : 'September 2026',
    url: isAnthropic
      ? 'https://platform.claude.com/docs/en/release-notes/overview#september-11-2026'
      : 'https://docs.perplexity.ai/docs/resources/changelog#september-2026',
    date: 'Fri, 11 Sep 2026 16:00:00 GMT',
    summary: isAnthropic ? 'Anthropic API agent update.' : null,
    encoded: isAnthropic ? null : '<p><strong>Shopping tools arrive in the Perplexity Agent API</strong></p><p>Perplexity added cited product search tools.</p>'
  }, overrides || {});
}

async function fetchFixture(feed, overrides) {
  F.clearSourceBackoff();
  return F.fetchFeeds({
    feeds: [feed], now: NOW, gapMs: 0,
    getFn: async () => ({ ok: true, status: 200, text: rss([rssItem(rawFor(feed, overrides))]) })
  });
}

function itemFor(feed, title, date, url) {
  return {
    title, url, publishedAt: date, shortSummary: `${feed.name} AI API agent update`,
    source: feed.name, sourceKey: feed.host
  };
}

function fakeResearchFetcher(mode) {
  return {
    fetchGdelt: async () => mode.gdelt || ({ items: [], stats: { attempted: 1, ok: 1, failed: 0 } }),
    fetchFeeds: async ({ feeds }) => {
      const feed = feeds[0];
      const entry = mode[feed.id];
      if (entry === 'fail') return { items: [], stats: { attempted: 1, ok: 0, failed: 1, sources: [{ host: feed.host, status: 'FAILED' }] } };
      if (!entry) return { items: [], stats: { attempted: 1, ok: 1, failed: 0, sources: [{ host: feed.host, status: 'WORKING' }] } };
      return { items: Array.isArray(entry) ? entry : [entry], stats: { attempted: 1, ok: 1, failed: 0, sources: [{ host: feed.host, status: 'WORKING' }] } };
    }
  };
}

(async () => {
  console.log('\nOFFICIAL AI NEWS SOURCES');

  await test('Anthropic 공식 RSS metadata', () => {
    assert.deepStrictEqual(
      { domain: anthropic.officialDomain, parser: anthropic.parserType, enabled: anthropic.enabled },
      { domain: 'platform.claude.com', parser: 'rss', enabled: true }
    );
  });
  await test('Anthropic feed success + normalization', async () => {
    const r = await fetchFixture(anthropic);
    assert.strictEqual(r.stats.ok, 1);
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].source, 'Anthropic');
    assert.strictEqual(r.items[0].sourceKey, 'platform.claude.com');
  });
  await test('Anthropic title/date/canonical URL', async () => {
    const { items } = await fetchFixture(anthropic);
    assert.match(items[0].title, /Claude Platform release notes/);
    assert.strictEqual(items[0].publishedAt, '2026-09-11T16:00:00.000Z');
    assert.match(items[0].url, /^https:\/\/platform\.claude\.com\/docs\/en\/release-notes\/overview/);
  });
  await test('Anthropic malformed item drop', async () => {
    const r = await fetchFixture(anthropic, { date: '' });
    assert.strictEqual(r.items.length, 0);
    assert.strictEqual(r.stats.failed, 1);
  });
  await test('Anthropic timeout + configured timeout 전달', async () => {
    F.clearSourceBackoff();
    let timeout;
    const r = await F.fetchFeeds({ feeds: [anthropic], now: NOW, gapMs: 0, getFn: async (u, a, ms) => {
      timeout = ms; return { ok: false, status: 0, text: '', error: 'timeout' };
    } });
    assert.strictEqual(timeout, 8000);
    assert.strictEqual(r.stats.failed, 1);
  });

  await test('Perplexity 공식 RSS metadata', () => {
    assert.deepStrictEqual(
      { domain: perplexity.officialDomain, parser: perplexity.parserType, enabled: perplexity.enabled },
      { domain: 'docs.perplexity.ai', parser: 'rss', enabled: true }
    );
  });
  await test('Perplexity feed success + normalization', async () => {
    const r = await fetchFixture(perplexity);
    assert.strictEqual(r.stats.ok, 1);
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].source, 'Perplexity');
    assert.strictEqual(r.items[0].sourceKey, 'docs.perplexity.ai');
  });
  await test('Perplexity structured content title + summary', async () => {
    const { items } = await fetchFixture(perplexity);
    assert.strictEqual(items[0].title, 'Shopping tools arrive in the Perplexity Agent API');
    assert.match(items[0].shortSummary, /cited product search tools/);
  });
  await test('Perplexity date/canonical URL', async () => {
    const { items } = await fetchFixture(perplexity);
    assert.strictEqual(items[0].publishedAt, '2026-09-11T16:00:00.000Z');
    assert.match(items[0].url, /^https:\/\/docs\.perplexity\.ai\/docs\/resources\/changelog/);
  });
  await test('Perplexity malformed item drop', async () => {
    const r = await fetchFixture(perplexity, { encoded: '<p>missing strong title</p>', title: '' });
    assert.strictEqual(r.items.length, 0);
  });
  await test('Perplexity timeout + configured timeout 전달', async () => {
    F.clearSourceBackoff();
    let timeout;
    const r = await F.fetchFeeds({ feeds: [perplexity], now: NOW, gapMs: 0, getFn: async (u, a, ms) => {
      timeout = ms; return { ok: false, status: 0, text: '', error: 'timeout' };
    } });
    assert.strictEqual(timeout, 8000);
    assert.strictEqual(r.stats.failed, 1);
  });

  await test('Anthropic 실패 시 Perplexity 결과 유지', async () => {
    const p = itemFor(perplexity, 'Perplexity Agent API update', '2026-09-11T16:00:00Z', 'https://docs.perplexity.ai/docs/resources/changelog?p=1');
    const r = await NR.research('Perplexity 최근 AI 업데이트 알려줘', { now: NOW, fetcher: fakeResearchFetcher({ ANTHROPIC_OFFICIAL: 'fail', PERPLEXITY_OFFICIAL: p }) });
    assert.strictEqual(r.articles.length, 1);
    assert.strictEqual(r.articles[0].sourceIdentifier, 'docs.perplexity.ai');
    assert.strictEqual(r.partialSources, true);
  });
  await test('Perplexity 실패 시 Anthropic 결과 유지', async () => {
    const a = itemFor(anthropic, 'Anthropic API agent update', '2026-09-11T16:00:00Z', 'https://platform.claude.com/docs/en/release-notes/overview?a=1');
    const r = await NR.research('Anthropic 최근 발표 알려줘', { now: NOW, fetcher: fakeResearchFetcher({ PERPLEXITY_OFFICIAL: 'fail', ANTHROPIC_OFFICIAL: a }) });
    assert.strictEqual(r.articles.length, 1);
    assert.strictEqual(r.articles[0].sourceIdentifier, 'platform.claude.com');
    assert.strictEqual(r.partialSources, true);
  });
  await test('동일 canonical URL은 최신 한 건', async () => {
    const old = itemFor(perplexity, 'Old Perplexity API update', '2026-09-10T16:00:00Z', 'https://docs.perplexity.ai/docs/resources/changelog#september');
    const fresh = itemFor(perplexity, 'Fresh Perplexity API update', '2026-09-11T16:00:00Z', 'https://docs.perplexity.ai/docs/resources/changelog#september');
    const r = await NR.research('Perplexity 최근 업데이트 알려줘', { now: NOW, fetcher: fakeResearchFetcher({ PERPLEXITY_OFFICIAL: [old, fresh] }) });
    assert.deepStrictEqual(r.articles.map(x => x.title), ['Fresh Perplexity API update']);
  });
  await test('사실상 동일 title은 provider 간 dedup', async () => {
    const a = itemFor(anthropic, '[Update] Agent API shopping tools released', '2026-09-11T16:00:00Z', 'https://platform.claude.com/a');
    const p = itemFor(perplexity, 'Agent API shopping tools released', '2026-09-11T15:00:00Z', 'https://docs.perplexity.ai/p');
    const r = await NR.research('최근 AI agent API 업데이트 알려줘', { now: NOW, fetcher: fakeResearchFetcher({ ANTHROPIC_OFFICIAL: a, PERPLEXITY_OFFICIAL: p }) });
    assert.strictEqual(r.articles.length, 1);
  });
  await test('GDELT 429이어도 신규 공식 source 응답', async () => {
    const a = itemFor(anthropic, 'Anthropic agent API update', '2026-09-11T16:00:00Z', 'https://platform.claude.com/a2');
    const r = await NR.research('Anthropic 최근 업데이트 알려줘', { now: NOW, fetcher: fakeResearchFetcher({
      gdelt: { items: [], stats: { attempted: 0, ok: 0, failed: 0, cooldown: true, skippedBackoff: 1 } },
      ANTHROPIC_OFFICIAL: a, PERPLEXITY_OFFICIAL: 'fail'
    }) });
    assert.strictEqual(r.articles.length, 1);
    assert.strictEqual(r.gdeltCooldown, true);
    assert.strictEqual(r.partialSources, true);
  });
  await test('신규 provider 모두 실패해도 OpenAI 유지', async () => {
    const openai = NR.OFFICIAL_AI_FEEDS.find(x => x.id === 'OPENAI_OFFICIAL');
    const o = itemFor(openai, 'OpenAI API agent update', '2026-09-11T16:00:00Z', 'https://openai.com/news/api-agent');
    const r = await NR.research('최근 OpenAI 업데이트 알려줘', { now: NOW, fetcher: fakeResearchFetcher({
      OPENAI_OFFICIAL: o, ANTHROPIC_OFFICIAL: 'fail', PERPLEXITY_OFFICIAL: 'fail'
    }) });
    assert.strictEqual(r.articles.length, 1);
    assert.strictEqual(r.articles[0].sourceIdentifier, 'openai.com');
  });
  await test('UTC→KST 오늘 경계 유지', async () => {
    const today = itemFor(anthropic, 'Anthropic AI today', '2026-09-11T15:00:00Z', 'https://platform.claude.com/today');
    const yesterday = itemFor(anthropic, 'Anthropic AI yesterday', '2026-09-11T14:59:59Z', 'https://platform.claude.com/yesterday');
    const r = await NR.research('오늘 Anthropic AI 뉴스 알려줘', { now: NOW, fetcher: fakeResearchFetcher({ ANTHROPIC_OFFICIAL: [yesterday, today] }) });
    assert.deepStrictEqual(r.articles.map(x => x.title), ['Anthropic AI today']);
  });
  await test('공식 feed 병렬 격리', async () => {
    let active = 0, maxActive = 0;
    const fetcher = {
      fetchGdelt: async () => ({ items: [], stats: { attempted: 1, ok: 1 } }),
      fetchFeeds: async () => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        return { items: [], stats: { attempted: 1, ok: 1 } };
      }
    };
    await NR.research('최근 AI 뉴스 알려줘', { now: NOW, fetcher });
    assert.ok(maxActive >= 4, `maxActive=${maxActive}`);
  });

  F.clearSourceBackoff();
  console.log(`\n───── PASS ${pass} / FAIL ${fail}`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
