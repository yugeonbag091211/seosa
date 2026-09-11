#!/usr/bin/env node
'use strict';

/* Intent routing + 뉴스 fallback E2E. 모든 외부 호출은 fixture다. */
const assert = require('assert');
const Module = require('module');

process.env.OPENROUTER_API_KEY = 'offline-routing-test';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;

const http = require('../api/_http');
http.applyCors = () => true;
http.noStore = () => {};
const rate = require('../api/_ratelimit');
rate.guard = () => true;

let productSearchCalls = 0;
let generationCalls = 0;
let dealEngineCalls = 0;
const FIXTURE_PUBLISHED_AT = new Date().toISOString();
const FIXTURE_DATE = FIXTURE_PUBLISHED_AT.slice(0, 10);
const fakeShop = {
  searchAll: async () => {
    productSearchCalls++;
    return { items: [{ title: '[오늘담은] 배세트', productId: 'BAD', lprice: 1000 }], allItems: [], from: 'api' };
  },
  saveProducts: async () => {}
};
const fakeLlm = {
  MIN_ATTEMPT_MS: 1,
  chat: async () => { generationCalls++; return { ok: false, reason: 'fixture-generation-failure' }; }
};
const fakeAuth = { identify: () => ({ ok: true, email: 'routing@fixture.local' }) };

const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './_shop' && parent && /[\\/]api[\\/]ai\.js$/.test(parent.filename)) return fakeShop;
  if (request === './_llm' && parent && /[\\/]api[\\/]ai\.js$/.test(parent.filename)) return fakeLlm;
  if (request === './_auth' && parent && /[\\/]api[\\/]ai\.js$/.test(parent.filename)) return fakeAuth;
  if (/^\.\/(?:_deal|_decision|_pricestat)$/.test(request) && parent && /[\\/]api[\\/]ai\.js$/.test(parent.filename)) {
    dealEngineCalls++;
  }
  return realLoad.apply(this, arguments);
};

const newsFetch = require('../api/_news-fetch');
let newsMode = 'ok';
let newsApiCalls = 0;
newsFetch.fetchGdelt = async queries => {
  newsApiCalls++;
  assert.strictEqual(queries.length, 1, '요청당 뉴스 검색 API는 한 번만 호출');
  if (newsMode === 'empty') return { items: [], stats: { failed: 1 } };
  return {
    items: [
      {
        title: 'OpenAI launches agent shopping API',
        url: 'https://example.com/openai-agent-shopping',
        publishedAt: FIXTURE_PUBLISHED_AT,
        shortSummary: 'Agents can retrieve product information with cited sources.',
        source: 'GDELT · example.com'
      }
    ],
    stats: { attempted: 1, ok: 1 }
  };
};
newsFetch.fetchFeeds = async () => ({ items: [], stats: { attempted: 2, ok: 0 } });

const handler = require('../api/ai');
const Intent = require('../api/_intent');
const NewsResearch = require('../api/_news-research');
const { canonicalIntent } = handler._internal;

function call(question) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      setHeader() { return this; },
      json(body) { resolve({ status, body }); return this; },
      end() { resolve({ status, body: {} }); return this; }
    };
    Promise.resolve(handler({
      method: 'POST', headers: {}, query: {}, socket: { remoteAddress: '127.0.0.1' },
      body: { question, contextProducts: [], chatHistory: [], view: { source: 'none' } }
    }, res)).catch(reject);
  });
}

let pass = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e}`); process.exitCode = 1; }
}

(async () => {
  console.log('\nINTENT ROUTING / NEWS PIPELINE');

  const cases = [
    ['오늘 AI 뉴스', 'NEWS_RESEARCH'],
    ['오늘의집 소파 추천', 'PRODUCT_SEARCH'],
    ['오늘 에어팟 사도 돼?', 'PRODUCT_DECISION'],
    ['이 가격 괜찮아?', 'PRODUCT_DECISION'],
    ['좀 기다릴까?', 'PRODUCT_DECISION'],
    ['오늘 나온 에어팟 뉴스 알려줘', 'NEWS_RESEARCH'],
    ['아이폰 가격 뉴스 알려줘', 'NEWS_RESEARCH'],
    ['구글 뉴스에서 에어팟 가격 관련 기사 찾아줘', 'NEWS_RESEARCH'],
    ['최근 가격 떨어진 무선 이어폰 추천', 'PRODUCT_SEARCH'],
    ['요즘 AI 이어폰 뭐가 좋아?', 'PRODUCT_SEARCH'],
    ['Perplexity 쇼핑 기능처럼 추천해줘', 'PRODUCT_SEARCH'],
    ['Perplexity처럼 쇼핑 추천해줘', 'PRODUCT_SEARCH'],
    ['Anthropic 최근 발표 알려줘', 'NEWS_RESEARCH'],
    ['Perplexity 쇼핑 기능 업데이트 있어?', 'NEWS_RESEARCH'],
    ['최근 Anthropic 발표가 SEOSA에 어떤 영향이야?', 'SEOSA_ANALYSIS'],
    ['OpenAI API 가격 알려줘', 'GENERAL_QA'],
    ['최근 OpenAI 쇼핑 기능이 SEOSA에 어떤 영향?', 'SEOSA_ANALYSIS']
  ];
  for (const [q, want] of cases) {
    await test(`"${q}" → ${want}`, () => {
      assert.strictEqual(canonicalIntent(Intent.classify(q).intent), want);
    });
  }

  const problem = '오늘 나온 AI 뉴스 중 SEOSA 같은 AI 쇼핑 서비스에 직접 영향 줄 만한 것만 골라줘. OpenAI, Anthropic, Google, Perplexity, 쇼핑 AI, 에이전트, 검색 API 중심으로 보고 출처랑 날짜도 붙여줘.';
  await test('실제 문제 입력 → SEOSA_ANALYSIS, 상품 검색 0회', async () => {
    productSearchCalls = 0;
    dealEngineCalls = 0;
    const r = await call(problem);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.intent, 'SEOSA_ANALYSIS');
    assert.strictEqual(productSearchCalls, 0);
    assert.strictEqual(dealEngineCalls, 0);
    assert.strictEqual(r.body.newsSources.length, 1);
  });

  await test('상품 관련 명시적 뉴스 요청도 상품/Deal Engine 호출 0회', async () => {
    productSearchCalls = 0;
    dealEngineCalls = 0;
    const r = await call('오늘 나온 에어팟 뉴스 알려줘');
    assert.strictEqual(r.body.intent, 'NEWS_RESEARCH');
    assert.strictEqual(productSearchCalls, 0);
    assert.strictEqual(dealEngineCalls, 0);
  });

  await test('뉴스 AI generation 실패 → 출처/날짜 결정론 요약, 상품 fallback 금지', async () => {
    productSearchCalls = 0;
    dealEngineCalls = 0;
    generationCalls = 0;
    const r = await call('오늘 AI 뉴스 알려줘');
    assert.strictEqual(r.body.intent, 'NEWS_RESEARCH');
    assert.ok(generationCalls > 0, 'generation 실패 경로가 실행돼야 함');
    assert.strictEqual(productSearchCalls, 0);
    assert.strictEqual(dealEngineCalls, 0);
    assert.match(r.body.text, new RegExp(FIXTURE_DATE));
    assert.match(r.body.text, /GDELT · example\.com/);
    assert.match(r.body.text, /https:\/\/example\.com\/openai-agent-shopping/);
    assert.doesNotMatch(r.body.text, /AI 설명을 만들지 못했어요|오늘담은|상품.*추천/);
  });

  await test('뉴스 검색 자체 실패 → 명시적 실패 문구, 상품 fallback 금지', async () => {
    newsMode = 'empty';
    productSearchCalls = 0;
    const r = await call('OpenAI 최신 뉴스 알려줘');
    assert.strictEqual(r.body.text, '현재 최신 뉴스 검색에 실패했습니다.');
    assert.strictEqual(productSearchCalls, 0);
    assert.deepStrictEqual(r.body.newsSources, []);
    newsMode = 'ok';
  });

  await test('뉴스 질문은 실제 뉴스 검색 API 경로를 호출한다', () => {
    assert.ok(newsApiCalls >= 3);
  });

  await test('LLM 분류 코드 N/S를 검색어 없이 파싱한다', () => {
    assert.deepStrictEqual(handler._internal.parseClassification('N|무시할 상품어'), { intent: 'N', query: '' });
    assert.deepStrictEqual(handler._internal.parseClassification('S'), { intent: 'S', query: '' });
  });

  await test('"오늘" 뉴스는 KST 오늘 이전 기사를 섞지 않는다', async () => {
    const item = (title, publishedAt) => ({
      title, publishedAt, url: `https://example.com/${encodeURIComponent(title)}`,
      shortSummary: 'OpenAI agent API update', source: 'fixture'
    });
    const r = await NewsResearch.research('오늘 AI 뉴스', {
      now: new Date('2026-09-11T03:00:00.000Z'),
      fetcher: {
        fetchGdelt: async () => ({ items: [
          item('old', '2026-09-10T12:00:00.000Z'),
          item('today', '2026-09-11T01:00:00.000Z')
        ], stats: {} })
      }
    });
    assert.deepStrictEqual(r.articles.map(x => x.title), ['today']);
  });

  Module._load = realLoad;
  console.log(`\n───── PASS ${pass} / FAIL ${process.exitCode ? 1 : 0}`);
})().catch(e => {
  Module._load = realLoad;
  console.error(e);
  process.exit(1);
});
