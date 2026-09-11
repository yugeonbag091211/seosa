#!/usr/bin/env node
'use strict';
/*
 * DEGRADED 원인 코드 회귀.
 *
 * 이번 감사에서 «degraded:true» 하나가 다섯 가지 원인을 뭉갠다는 것을 확인했고,
 * _news-research.answer() 가 아래 여덟 가지 reason 을 구분해서 돌려주도록 바꾼
 * 뒤 이 테스트가 그 계약을 잠근다.
 *
 * 각 시나리오는 실제 코드 경로를 있는 그대로 태우고 fake llm / fake fetcher 로
 * 결정론적으로 재현한다. 네트워크 없음.
 */
const NR = require('../api/_news-research');
const NF = require('../api/_news-fetch');

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); PASS++; }
  else { console.log('  ✗ ' + name + (extra ? '  ' + JSON.stringify(extra) : '')); FAIL++; }
}

function fakeLlm(behavior) {
  return {
    MIN_ATTEMPT_MS: 100,
    async chat() { return behavior(); }
  };
}

function articleResult(n) {
  const now = new Date('2026-09-11T00:00:00Z');
  const articles = [];
  for (let i = 0; i < n; i++) {
    articles.push({
      title: `기사 ${i + 1} — OpenAI 발표`,
      summary: 'OpenAI가 새 기능을 공개했다.',
      publishedAt: new Date(now.getTime() - i * 3600 * 1000).toISOString(),
      source: 'OpenAI',
      sourceIdentifier: 'openai.com',
      url: `https://openai.com/news/example-${i + 1}`
    });
  }
  return { ok: true, articles, query: 'test', partialSources: false, gdeltCooldown: false, stats: null };
}

(async function main() {
  console.log('DEGRADED REASON CODES');

  // 1) 검색 자체가 0건
  {
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', { ok: false, articles: [] }, { llm: fakeLlm(() => ({ ok: true, text: '', model: 'x' })) });
    ok('NEWS_NO_ARTICLES', a.degraded && a.reason === 'NEWS_NO_ARTICLES', a);
  }

  // 2) LLM 미제공
  {
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', articleResult(2), {});
    ok('NEWS_LLM_UNAVAILABLE', a.degraded && a.reason === 'NEWS_LLM_UNAVAILABLE', a);
  }

  // 3) LLM 429
  {
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', articleResult(2), {
      llm: fakeLlm(() => ({ ok: false, reason: 'rate', text: '' }))
    });
    ok('NEWS_LLM_RATE_LIMIT', a.degraded && a.reason === 'NEWS_LLM_RATE_LIMIT', a);
  }

  // 4) LLM 402 quota
  {
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', articleResult(2), {
      llm: fakeLlm(() => ({ ok: false, reason: 'quota', text: '' }))
    });
    ok('NEWS_LLM_QUOTA', a.degraded && a.reason === 'NEWS_LLM_QUOTA', a);
  }

  // 5) LLM timeout
  {
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', articleResult(2), {
      llm: fakeLlm(() => ({ ok: false, reason: 'timeout', text: '' }))
    });
    ok('NEWS_LLM_TIMEOUT', a.degraded && a.reason === 'NEWS_LLM_TIMEOUT', a);
  }

  // 6) LLM budget
  {
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', articleResult(2), {
      llm: fakeLlm(() => ({ ok: false, reason: 'budget', text: '' }))
    });
    ok('NEWS_LLM_BUDGET', a.degraded && a.reason === 'NEWS_LLM_BUDGET', a);
  }

  // 7) LLM nokey
  {
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', articleResult(2), {
      llm: fakeLlm(() => ({ ok: false, reason: 'nokey', text: '' }))
    });
    ok('NEWS_LLM_NOKEY', a.degraded && a.reason === 'NEWS_LLM_NOKEY', a);
  }

  // 8) 예외 throw
  {
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', articleResult(2), {
      llm: fakeLlm(() => { throw new Error('boom'); })
    });
    ok('NEWS_EXCEPTION', a.degraded && a.reason === 'NEWS_EXCEPTION', a);
  }

  // 9) LLM 성공, but 근거 검증 실패 (URL 하나 빠뜨림)
  {
    const R = articleResult(2);
    const bad = `### 1. ${R.articles[0].title}\n- 핵심 내용: x\n- 날짜: ${R.articles[0].publishedAt.slice(0,10)}\n- 출처: (${R.articles[0].sourceIdentifier})\n- URL: ${R.articles[0].url}\n- SEOSA: x\n- 적용: y`;
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', R, {
      llm: fakeLlm(() => ({ ok: true, text: bad, model: 'test' }))
    });
    ok('NEWS_PARSE_FAIL', a.degraded && a.reason === 'NEWS_PARSE_FAIL', a);
  }

  // 10) LLM ok=true 인데 텍스트 비었음
  {
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', articleResult(2), {
      llm: fakeLlm(() => ({ ok: true, text: '   ', model: 'test' }))
    });
    ok('NEWS_LLM_EMPTY', a.degraded && a.reason === 'NEWS_LLM_EMPTY', a);
  }

  // 11) 성공한 경우 reason 이 undefined 여야 한다
  {
    const R = articleResult(1);
    const good = [
      '### 1. ' + R.articles[0].title,
      '- 핵심 내용: OpenAI 소식',
      '- 발표/기사 날짜: ' + R.articles[0].publishedAt.slice(0, 10),
      '- 출처: ' + R.articles[0].source + ' (' + R.articles[0].sourceIdentifier + ')',
      '- 원문 URL: ' + R.articles[0].url,
      '- SEOSA에 미치는 영향: 관련 있음',
      '- 적용 가능 아이디어: 실험'
    ].join('\n');
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', R, {
      llm: fakeLlm(() => ({ ok: true, text: good, model: 'test' }))
    });
    ok('성공 시 degraded=false / reason 없음', !a.degraded && !a.reason, a);
  }

  // 12) 성공 + partialSources → degraded=false 지만 reason=NEWS_PARTIAL_SOURCES
  {
    const R = articleResult(1);
    R.partialSources = true;
    const good = [
      '### 1. ' + R.articles[0].title,
      '- 핵심 내용: OpenAI 소식',
      '- 발표/기사 날짜: ' + R.articles[0].publishedAt.slice(0, 10),
      '- 출처: ' + R.articles[0].source + ' (' + R.articles[0].sourceIdentifier + ')',
      '- 원문 URL: ' + R.articles[0].url,
      '- SEOSA에 미치는 영향: 관련 있음',
      '- 적용 가능 아이디어: 실험'
    ].join('\n');
    const a = await NR.answer('오늘 AI 뉴스', 'NEWS_RESEARCH', R, {
      llm: fakeLlm(() => ({ ok: true, text: good, model: 'test' }))
    });
    ok('partial 성공 → degraded=false + partial reason', !a.degraded && a.partial === true && a.reason === 'NEWS_PARTIAL_SOURCES', a);
  }

  console.log('');
  console.log('GDELT BACKOFF / SINGLE-FLIGHT');

  // 13) 429 후 in-process 쿨다운 걸림
  {
    NF.clearGdeltBackoff();
    let calls = 0;
    async function fakeGet() {
      calls++;
      return { ok: false, status: 429, text: '', error: 'rate-limited' };
    }
    // 첫 호출: 429
    const r1 = await NF.fetchGdelt(['test1'], { getFn: fakeGet, sleepFn: () => Promise.resolve() });
    // 두 번째 호출: 쿨다운으로 건너뜀
    const r2 = await NF.fetchGdelt(['test2'], { getFn: fakeGet, sleepFn: () => Promise.resolve() });
    ok('첫 429 는 attempted 1 / failed 1', r1.stats.attempted === 1 && r1.stats.failed === 1, r1.stats);
    ok('둘째는 쿨다운 스킵 — 요청 안 나감', r2.stats.attempted === 0 && r2.stats.skippedBackoff === 1 && r2.stats.cooldown && calls === 1, { r2: r2.stats, calls });
    NF.clearGdeltBackoff();
  }

  // 14) 성공 뒤에는 쿨다운 없음
  {
    NF.clearGdeltBackoff();
    async function okGet() {
      return { ok: true, status: 200, text: JSON.stringify({ articles: [] }) };
    }
    const r1 = await NF.fetchGdelt(['a'], { getFn: okGet, sleepFn: () => Promise.resolve() });
    const r2 = await NF.fetchGdelt(['b'], { getFn: okGet, sleepFn: () => Promise.resolve() });
    ok('성공 후 다음 호출도 통과', r1.stats.ok === 1 && r2.stats.ok === 1 && !r2.stats.cooldown, { r1: r1.stats, r2: r2.stats });
    NF.clearGdeltBackoff();
  }

  console.log('');
  console.log('NEWS RESEARCH — 미래 timestamp / 제목 중복');

  // 15) 미래 날짜 기사 배제
  {
    const now = new Date('2026-09-11T00:00:00Z');
    const future = new Date(now.getTime() + 3 * 86400000).toISOString();
    async function fakeFetchFeeds() {
      return {
        items: [
          { title: 'OpenAI 발표 — 오늘', url: 'https://openai.com/news/today', publishedAt: new Date(now.getTime() - 3600000).toISOString(), source: 'OpenAI', sourceKey: 'openai.com' },
          { title: 'OpenAI 발표 — 3일 뒤 (잘못된 날짜)', url: 'https://openai.com/news/future', publishedAt: future, source: 'OpenAI', sourceKey: 'openai.com' }
        ],
        stats: { attempted: 1, ok: 1, failed: 0 }
      };
    }
    async function fakeFetchGdelt() { return { items: [], stats: { attempted: 1, ok: 1 } }; }
    const R = await NR.research('오늘 AI 뉴스', {
      now,
      fetcher: { fetchFeeds: fakeFetchFeeds, fetchGdelt: fakeFetchGdelt }
    });
    ok('미래 시각 기사는 제외', R.articles.length === 1 && !R.articles.some(a => a.url.endsWith('/future')), R.articles.map(a => a.url));
  }

  // 16) URL 이 다르지만 제목이 사실상 같으면 하나만 남긴다
  {
    const now = new Date('2026-09-11T00:00:00Z');
    async function fakeFetchFeeds() {
      return {
        items: [
          { title: '[속보] OpenAI가 새 쇼핑 기능을 공개했다', url: 'https://openai.com/news/shop', publishedAt: new Date(now.getTime() - 3600000).toISOString(), source: 'OpenAI', sourceKey: 'openai.com' }
        ],
        stats: { attempted: 1, ok: 1 }
      };
    }
    async function fakeFetchGdelt() {
      return {
        items: [
          { title: 'OpenAI가 새 쇼핑 기능을 공개했다 - 매체명', url: 'https://reut.rs/openai-shop', publishedAt: new Date(now.getTime() - 3600000).toISOString(), source: 'GDELT · reuters.com', sourceKey: '__gdelt__' }
        ],
        stats: { attempted: 1, ok: 1 }
      };
    }
    const R = await NR.research('오늘 OpenAI 쇼핑 소식', {
      now,
      fetcher: { fetchFeeds: fakeFetchFeeds, fetchGdelt: fakeFetchGdelt }
    });
    ok('제목이 사실상 같은 재게시본은 병합', R.articles.length === 1, R.articles.map(a => a.url));
  }

  console.log('');
  console.log(`───── PASS ${PASS} / FAIL ${FAIL}`);
  if (FAIL) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
