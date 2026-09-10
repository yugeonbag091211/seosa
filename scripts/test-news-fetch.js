#!/usr/bin/env node
'use strict';

const assert = require('assert');
const F = require('../api/_news-fetch');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.stack || e}`); }
}

const NOW = new Date('2026-09-10T00:00:00.000Z');
const xml = host => `<?xml version="1.0"?><rss><channel><item><title>DRAM 공급 확대</title><link>https://${host}/news/1</link><pubDate>Wed, 09 Sep 2026 00:00:00 GMT</pubDate><description>summary</description></item></channel></rss>`;

(async () => {
  console.log('\nNEWS FETCH SAFETY');
  await t('Tier B registry 8곳을 허용된 상태값으로 분류한다', () => {
    assert.strictEqual(F.PUBLIC_SOURCE_DIAGNOSTICS.length, 8);
    const allowed = new Set(['WORKING', 'NO_RSS', 'BLOCKED', 'INVALID_URL', 'UNSUPPORTED']);
    F.PUBLIC_SOURCE_DIAGNOSTICS.forEach(s => assert.ok(allowed.has(s.status), `${s.host}: ${s.status}`));
  });

  await t('확인된 정부 RSS 3곳만 활성화한다', () => {
    const hosts = new Set(F.FEEDS.map(f => f.host.replace(/^www\./, '')));
    ['msit.go.kr', 'customs.go.kr', 'bok.or.kr'].forEach(h => assert.ok(hosts.has(h), h));
    ['investors.micron.com', 'pr.tsmc.com', 'asml.com', 'semi.org'].forEach(h => assert.ok(!hosts.has(h), h));
  });

  await t('정부 RSS의 CDATA 제목·링크를 지우지 않고 파싱한다', () => {
    const cdata = `<?xml version="1.0"?><rss><channel><item>
      <title><![CDATA[반도체 공급망 보도자료]]></title>
      <link><![CDATA[https://www.msit.go.kr/bbs/view.do?id=1&amp;x=2]]></link>
      <pubDate><![CDATA[Wed, 09 Sep 2026 00:00:00 GMT]]></pubDate>
      <description><![CDATA[<p>요약</p>]]></description>
    </item></channel></rss>`;
    const rows = F.parseFeed(cdata);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].title, '반도체 공급망 보도자료');
    assert.strictEqual(rows[0].url, 'https://www.msit.go.kr/bbs/view.do?id=1&x=2');
    assert.strictEqual(rows[0].summary, '요약');
  });

  await t('403 뒤에는 같은 source를 재호출하지 않고 fail-open 한다', async () => {
    F.clearSourceBackoff();
    const calls = [], sleeps = [];
    const feeds = [
      { host: 'blocked.example', url: 'https://blocked.example/rss' },
      { host: 'news.skhynix.com', url: 'https://news.skhynix.com/feed/' }
    ];
    const first = await F.fetchFeeds({
      feeds, now: NOW, gapMs: 7,
      getFn: async url => {
        calls.push(url);
        return url.includes('blocked')
          ? { ok: false, status: 403, text: '', error: 'forbidden' }
          : { ok: true, status: 200, text: xml('news.skhynix.com') };
      },
      sleepFn: async ms => sleeps.push(ms)
    });
    assert.strictEqual(first.stats.failed, 1);
    assert.strictEqual(first.stats.ok, 1);
    assert.strictEqual(first.items.length, 1);
    assert.deepStrictEqual(sleeps, [7, 7], '실패 뒤에도 요청 간격 필요');

    const second = await F.fetchFeeds({
      feeds: [feeds[0]], now: NOW, gapMs: 0,
      getFn: async url => { calls.push(url); return { ok: true, status: 200, text: xml('blocked.example') }; }
    });
    assert.strictEqual(second.stats.attempted, 0);
    assert.strictEqual(second.stats.skippedBackoff, 1);
    assert.strictEqual(calls.filter(u => u.includes('blocked')).length, 1);
  });

  await t('source별 backoff라 한 곳의 실패가 다른 곳을 막지 않는다', () => {
    assert.ok(F.sourceBackoff('blocked.example', NOW.getTime()));
    assert.strictEqual(F.sourceBackoff('news.skhynix.com', NOW.getTime()), null);
  });

  await t('403은 24시간, 429는 1시간 cooldown이다', () => {
    F.clearSourceBackoff();
    const a = F.noteSourceResult('a.example', { ok: false, status: 403, error: 'forbidden' }, 0);
    const b = F.noteSourceResult('b.example', { ok: false, status: 429, error: 'rate-limited' }, 0);
    assert.strictEqual(a.until, F.BACKOFF.FORBIDDEN_MS);
    assert.strictEqual(b.until, F.BACKOFF.RATE_LIMIT_MS);
  });

  await t('예외와 빈 200 응답도 throw 없이 source failure가 된다', async () => {
    F.clearSourceBackoff();
    const thrown = await F.fetchFeeds({
      feeds: [{ host: 'x.example', url: 'https://x.example/rss' }], now: NOW, gapMs: 0,
      getFn: async () => { throw new Error('network-down'); }
    });
    assert.strictEqual(thrown.stats.failed, 1);

    F.clearSourceBackoff();
    const empty = await F.fetchFeeds({
      feeds: [{ host: 'y.example', url: 'https://y.example/rss' }], now: NOW, gapMs: 0,
      getFn: async () => ({ ok: true, status: 200, text: '<html>not a feed</html>' })
    });
    assert.strictEqual(empty.stats.failed, 1);
    assert.strictEqual(empty.stats.ok, 0);
  });

  F.clearSourceBackoff();
  console.log(`\n───── PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
