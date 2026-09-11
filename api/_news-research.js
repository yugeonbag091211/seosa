'use strict';
/*
 * Concierge 최신 뉴스 조사 파이프라인.
 *
 * 상품 검색과 의존성을 공유하지 않는다. 이 파일이 호출하는 외부 조회는
 * _news-fetch.fetchGdelt(공개 뉴스 검색 API)뿐이다. 조회/생성 실패도 상품
 * 추천으로 내려가지 않고, 확인한 기사만으로 만든 결정론 요약 또는 명시적인
 * 검색 실패 문장으로 끝난다.
 */

const NEWS_LIMIT = 6;
const DEFAULT_DAYS = 14;
const OFFICIAL_AI_FEEDS = Object.freeze([
  { url: 'https://openai.com/news/rss.xml', host: 'openai.com' },
  { url: 'https://blog.google/rss/', host: 'blog.google' }
]);

const ENTITIES = Object.freeze([
  ['OpenAI', /\bOpenAI\b/i],
  ['Anthropic', /\bAnthropic\b/i],
  ['Google Gemini', /\bGoogle\b|\bGemini\b/i],
  ['Perplexity', /\bPerplexity\b/i]
]);

const TOPICS = Object.freeze([
  ['shopping AI', /쇼핑\s*AI|shopping|commerce|checkout/i],
  ['AI agent', /에이전트|agent(?:ic|s)?/i],
  ['search API', /검색\s*API|search\s*API|retrieval/i]
]);

function safe(v, n) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

function sourceId(url, fallback) {
  try { return new URL(String(url || '')).hostname.replace(/^www\./, ''); }
  catch (e) { return safe(fallback, 80) || 'GDELT'; }
}

function timeWindow(question, now) {
  const d = now instanceof Date ? now : new Date();
  /* `오늘의집` 같은 합성어는 오늘 요청이 아니다. */
  if (/(?:^|[\s,])오늘(?=$|[\s,?.!])/.test(String(question || ''))) {
    const kst = new Date(d.getTime() + 9 * 3600000);
    const startUtc = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600000;
    return { days: 1, cutoff: startUtc };
  }
  return { days: DEFAULT_DAYS, cutoff: d.getTime() - DEFAULT_DAYS * 86400000 };
}

/** 사용자 원문을 검색식으로 넘기지 않고, 확인된 의미 축만 조합한다. */
function buildResearchQuery(question) {
  const q = String(question || '');
  const entities = ENTITIES.filter(([, re]) => re.test(q)).map(([name]) => `"${name}"`);
  const topics = TOPICS.filter(([, re]) => re.test(q)).map(([name]) => `"${name}"`);
  const subjects = entities.length ? entities : ['"artificial intelligence"'];
  const focus = topics.length ? topics : ['AI', 'technology'];
  return `(${subjects.join(' OR ')}) (${focus.join(' OR ')})`;
}

function normalizeArticle(raw) {
  if (!raw) return null;
  const title = safe(raw.title, 300);
  const url = safe(raw.url, 500);
  const d = new Date(raw.publishedAt);
  if (!title || !/^https?:\/\//i.test(url) || isNaN(d.getTime())) return null;
  return {
    title,
    summary: safe(raw.shortSummary || raw.summary, 600),
    publishedAt: d.toISOString(),
    source: safe(raw.source, 100) || sourceId(url),
    sourceIdentifier: sourceId(url, raw.source),
    url
  };
}

const GENERIC_AI_RE = /\bAI\b|artificial intelligence|LLM|model|agent|API|Gemini|Claude|ChatGPT|OpenAI|Anthropic|Perplexity|인공지능|모델|에이전트/i;

function relevantToQuestion(article, question) {
  const q = String(question || '');
  const text = `${article.title} ${article.summary} ${article.source} ${article.sourceIdentifier}`;
  const wantedEntities = ENTITIES.filter(([, re]) => re.test(q));
  const wantedTopics = TOPICS.filter(([, re]) => re.test(q));
  const entityHit = !wantedEntities.length || wantedEntities.some(([, re]) => re.test(text));
  const topicHit = wantedTopics.length
    ? wantedTopics.some(([, re]) => re.test(text))
    : GENERIC_AI_RE.test(text);
  /* 회사 이름만 맞는 일반 회사 소식은 관련 뉴스로 올리지 않는다. */
  return entityHit && topicHit;
}

function impactFor(article) {
  const s = `${article.title} ${article.summary}`;
  if (/shopping|commerce|checkout|product|retail|쇼핑|결제|상품/i.test(s)) {
    return '상품 탐색부터 비교·구매 전환까지의 사용자 흐름에 직접 영향을 줄 수 있습니다.';
  }
  if (/agent|에이전트|tool use|computer use/i.test(s)) {
    return 'Concierge가 검색·비교 같은 여러 단계를 실행하는 방식과 자동화 범위에 영향을 줄 수 있습니다.';
  }
  if (/search|retriev|검색|grounding|citation/i.test(s)) {
    return '최신 정보 회수, 출처 검증, 검색 품질을 개선할 가능성이 있습니다.';
  }
  if (/API|model|모델|OpenAI|Anthropic|Gemini|Perplexity/i.test(s)) {
    return 'Concierge의 응답 품질·지연·비용 또는 공급자 선택에 영향을 줄 수 있습니다.';
  }
  return 'SEOSA의 검색·추천 경험에 미치는 영향은 원문을 기준으로 추가 검증이 필요합니다.';
}

function ideaFor(article) {
  const s = `${article.title} ${article.summary}`;
  if (/shopping|commerce|checkout|product|retail|쇼핑|결제|상품/i.test(s)) {
    return '상품 카드·가격 이력·Deal Engine을 새 쇼핑 흐름과 연결하는 작은 실험을 설계합니다.';
  }
  if (/agent|에이전트|tool use|computer use/i.test(s)) {
    return '상품 검색과 정보 검색을 분리한 도구 권한표를 두고, 읽기 전용 에이전트 실험부터 진행합니다.';
  }
  if (/search|retriev|검색|grounding|citation/i.test(s)) {
    return '뉴스 결과에 날짜·원문 URL·출처 식별자를 강제하는 검색 어댑터로 A/B 검증합니다.';
  }
  return '현재 Concierge 대비 정확도·지연·비용을 fixture 기반 평가셋으로 비교합니다.';
}

function deterministicSummary(result, intent) {
  const articles = (result && result.articles) || [];
  if (!articles.length) return '현재 최신 뉴스 검색에 실패했습니다.';

  const out = [intent === 'SEOSA_ANALYSIS'
    ? '확인된 최신 기사 중 SEOSA에 연결되는 항목만 정리했습니다.'
    : '확인된 최신 기사를 날짜와 출처 기준으로 정리했습니다.'];
  articles.forEach((a, i) => {
    out.push('');
    out.push(`### ${i + 1}. ${a.title}`);
    out.push(`- 핵심 내용: ${a.summary || '검색 결과가 제공한 제목 범위에서 확인되며, 세부 내용은 원문 확인이 필요합니다.'}`);
    out.push(`- 발표/기사 날짜: ${a.publishedAt.slice(0, 10)}`);
    out.push(`- 출처: ${a.source} (${a.sourceIdentifier})`);
    out.push(`- 원문 URL: ${a.url}`);
    out.push(`- SEOSA에 미치는 영향: ${impactFor(a)}`);
    out.push(`- 적용 가능 아이디어: ${ideaFor(a)}`);
  });
  return out.join('\n');
}

function completeEvidence(text, articles) {
  const t = String(text || '');
  if (!t.trim()) return false;
  const count = label => t.split(label).length - 1;
  if (!['핵심 내용', '날짜', '출처', 'SEOSA', '적용'].every(x => count(x) >= articles.length)) return false;
  return articles.every(a =>
    t.includes(a.title) && t.includes(a.url) &&
    t.includes(a.publishedAt.slice(0, 10)) && t.includes(a.sourceIdentifier));
}

async function research(question, opts) {
  const o = opts || {};
  const fetcher = o.fetcher || require('./_news-fetch');
  const query = buildResearchQuery(question);
  const now = o.now instanceof Date ? o.now : new Date();
  const window = timeWindow(question, now);
  const days = Number.isFinite(o.timespanDays) ? o.timespanDays : window.days;
  const cutoff = Number.isFinite(o.timespanDays)
    ? now.getTime() - o.timespanDays * 86400000
    : window.cutoff;
  let gdelt;
  let official;
  try {
    const jobs = [fetcher.fetchGdelt([query], {
        maxQueries: 1,
        maxRecords: Math.max(NEWS_LIMIT * 3, 12),
        timespanDays: days,
        now
      })];
    if (typeof fetcher.fetchFeeds === 'function') {
      jobs.push(fetcher.fetchFeeds({ feeds: OFFICIAL_AI_FEEDS, gapMs: 0, now }));
    }
    const settled = await Promise.allSettled(jobs);
    gdelt = settled[0] && settled[0].status === 'fulfilled' ? settled[0].value : { items: [], stats: { failed: 1 } };
    official = settled[1] && settled[1].status === 'fulfilled' ? settled[1].value : { items: [], stats: null };
  } catch (e) {
    return { ok: false, query, articles: [], reason: 'news-search-failed' };
  }

  const seen = new Set();
  const articles = [].concat(gdelt && gdelt.items || [], official && official.items || [])
    .map(normalizeArticle)
    .filter(Boolean)
    .filter(a => new Date(a.publishedAt).getTime() >= cutoff)
    .filter(a => relevantToQuestion(a, question))
    .filter(a => {
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, NEWS_LIMIT);
  return {
    ok: articles.length > 0,
    query,
    articles,
    reason: articles.length ? '' : 'no-current-news',
    stats: { gdelt: gdelt && gdelt.stats || null, official: official && official.stats || null }
  };
}

async function answer(question, intent, result, opts) {
  const fallback = deterministicSummary(result, intent);
  const articles = (result && result.articles) || [];
  if (!articles.length) return { text: fallback, generated: false, degraded: true };

  const o = opts || {};
  const llm = o.llm;
  if (!llm || typeof llm.chat !== 'function') return { text: fallback, generated: false, degraded: true };

  const evidence = articles.map((a, i) => [
    `[N${i + 1}] 제목: ${a.title}`,
    `날짜: ${a.publishedAt.slice(0, 10)}`,
    `출처: ${a.source} (${a.sourceIdentifier})`,
    `원문 URL: ${a.url}`,
    `피드 요약: ${a.summary || '(없음)'}`
  ].join('\n')).join('\n\n');
  const system = [
    '너는 SEOSA의 최신 AI 뉴스 리서처다.',
    '아래 검색 결과만 근거로 사용하고, 각 항목마다 제목·핵심 내용·날짜·출처·원문 URL·SEOSA 영향·적용 아이디어를 모두 쓴다.',
    'URL과 날짜는 입력 그대로 보존한다. 상품을 추천하거나 상품 검색 결과를 언급하지 않는다.',
    intent === 'SEOSA_ANALYSIS' ? 'SEOSA 관점의 직접 영향이 큰 순서로 선별해 분석한다.' : '최신성과 질문 관련성을 기준으로 간결하게 정리한다.',
    '',
    evidence
  ].join('\n');

  try {
    const r = await llm.chat({
      role: 'answer',
      messages: [{ role: 'system', content: system }, { role: 'user', content: safe(question, 500) }],
      maxTokens: 1200,
      temperature: 0.1,
      perCallMs: 25000,
      budgetMs: o.budgetMs,
      extra: { reasoning: { enabled: false } }
    });
    const text = r && r.ok ? String(r.text || '').trim() : '';
    if (completeEvidence(text, articles)) return { text, generated: true, degraded: false, model: r.model || '' };
  } catch (e) { /* 아래 결정론 요약으로 끝낸다. */ }
  return { text: fallback, generated: false, degraded: true };
}

module.exports = {
  NEWS_LIMIT, DEFAULT_DAYS, OFFICIAL_AI_FEEDS, timeWindow, buildResearchQuery, normalizeArticle, relevantToQuestion,
  impactFor, ideaFor, deterministicSummary, completeEvidence,
  research, answer
};
