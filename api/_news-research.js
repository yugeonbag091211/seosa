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

/*
 * 제목을 «재게시본과 원본을 같다고 부르기 위한» 열쇠로 눌러 준다.
 *
 * URL 만으로 중복 제거하면 같은 발표를 여러 도메인이 전한 것이 그대로 남는다.
 * (실측: GDELT 가 OpenAI 발표를 3개 매체가 전한 3건으로 물어 오고, 우리는
 *  이미 openai.com 원문을 RSS 에서 갖고 있는 상황.) 이 함수는 낱말 순서·매체
 *  꼬리·말머리를 털어 낸 뒤 «의미 있는 낱말의 집합» 만 남긴다.
 *
 * ★ 정확 일치는 신뢰가 낮다 — 매체명이 dash 뒤에 붙는 것만으로 키가 달라진다.
 *   그래서 Jaccard 유사도로 넘긴 뒤 임계값을 넘으면 같다고 본다(아래).
 */
function titleTokens(title) {
  return String(title == null ? '' : title)
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[-—–|·:,."'“”‘’!?%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 1);
}

function titleDedupKey(title) {
  return titleTokens(title).slice().sort().join(' ');
}

const TITLE_SIMILARITY_THRESHOLD = 0.6;

function isTitleDuplicate(title, seenTokensArr) {
  const tokens = new Set(titleTokens(title));
  if (!tokens.size) return false;
  for (const prev of seenTokensArr) {
    if (!prev.size) continue;
    let inter = 0;
    tokens.forEach(w => { if (prev.has(w)) inter++; });
    const uni = tokens.size + prev.size - inter;
    if (!uni) continue;
    if (inter / uni >= TITLE_SIMILARITY_THRESHOLD) return true;
  }
  return false;
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

  const seenUrl = new Set();
  const seenTokens = [];
  /* Date가 정상 파싱된 뒤의 미래 시각은 잘못된 근거이므로 허용하지 않는다. */
  const futureCutoff = o.now instanceof Date ? now.getTime() : Date.now();
  const articles = [].concat(gdelt && gdelt.items || [], official && official.items || [])
    .map(normalizeArticle)
    .filter(Boolean)
    .filter(a => {
      const t = new Date(a.publishedAt).getTime();
      return t >= cutoff && t <= futureCutoff;
    })
    .filter(a => relevantToQuestion(a, question))
    .filter(a => {
      if (seenUrl.has(a.url)) return false;
      seenUrl.add(a.url);
      if (isTitleDuplicate(a.title, seenTokens)) return false;
      seenTokens.push(new Set(titleTokens(a.title)));
      return true;
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, NEWS_LIMIT);
  /*
   * partial 은 GDELT/RSS 중 한 경로나 RSS 개별 source 일부가 실패했지만
   * 다른 source는 성공했다는 뜻이다. 응답이 살아 있어도 관측 신호는 남긴다.
   */
  const sourceHadFailure = result => {
    if (!result || !result.stats) return true;
    const stats = result.stats;
    if (stats.cooldown) return true;
    if (Number(stats.failed) > 0) return true;
    return Number(stats.attempted) > 0 && Number(stats.ok) === 0;
  };
  const sourceHadSuccess = result => !!(result && result.stats && Number(result.stats.ok) > 0);
  const partialSources = (sourceHadFailure(gdelt) || sourceHadFailure(official))
    && (sourceHadSuccess(gdelt) || sourceHadSuccess(official));
  const gdeltCooldown = !!(gdelt && gdelt.stats && gdelt.stats.cooldown);
  return {
    ok: articles.length > 0,
    query,
    articles,
    reason: articles.length ? '' : 'no-current-news',
    partialSources,
    gdeltCooldown,
    stats: { gdelt: gdelt && gdelt.stats || null, official: official && official.stats || null }
  };
}

/*
 * degraded 원인 코드.
 *
 * ── 왜 코드가 필요한가 (2026-09-11 감사) ────────────────────────────
 *
 *   예전에는 { degraded: true } 하나로 아래 다섯 가지를 뭉갰다.
 *     · 뉴스 검색 자체가 0건       (근본 원인이 검색 인프라)
 *     · LLM 을 주지 않았다         (호출부 실수)
 *     · LLM 이 실패했다 (rate/quota/timeout/network/nokey/budget/…)
 *     · LLM 이 빈 응답을 돌려줬다
 *     · LLM 은 성공했으나 근거 검증(completeEvidence)이 걸렀다
 *
 *   운영에서 «GDELT 는 죽고 RSS 는 살아 있는데 왜 degraded 인가» 를
 *   판단하려면 원인을 코드로 남겨 두어야 한다. 사용자에게 보여줄 문구는
 *   그대로지만, 관측 로그와 payload.degradedReason 에는 아래 코드 중
 *   하나가 남는다. API key 나 업스트림 원문은 절대 담지 않는다.
 */
const DEGRADED_REASONS = Object.freeze({
  NEWS_NO_ARTICLES: 'NEWS_NO_ARTICLES',           // 검색 자체가 0건
  NEWS_LLM_UNAVAILABLE: 'NEWS_LLM_UNAVAILABLE',   // llm 인자 없음/구조 이상
  NEWS_LLM_RATE_LIMIT: 'NEWS_LLM_RATE_LIMIT',     // 공급자 429
  NEWS_LLM_QUOTA: 'NEWS_LLM_QUOTA',               // 공급자 402/크레딧 소진
  NEWS_LLM_TIMEOUT: 'NEWS_LLM_TIMEOUT',           // per-call 시간 초과
  NEWS_LLM_BUDGET: 'NEWS_LLM_BUDGET',             // 요청 예산 소진
  NEWS_LLM_NOKEY: 'NEWS_LLM_NOKEY',               // 서버 키 미설정
  NEWS_LLM_PARSE: 'NEWS_LLM_PARSE',               // 공급자 응답 parsing 실패
  NEWS_LLM_ERROR: 'NEWS_LLM_ERROR',               // 그 외 실패
  NEWS_LLM_EMPTY: 'NEWS_LLM_EMPTY',               // ok=true 인데 텍스트 비었음
  NEWS_PARSE_FAIL: 'NEWS_PARSE_FAIL',             // 근거 검증 실패
  NEWS_EXCEPTION: 'NEWS_EXCEPTION',               // 예외 catch
  NEWS_PARTIAL_SOURCES: 'NEWS_PARTIAL_SOURCES'    // 소스 일부 실패 (관측용)
});

function reasonFromLlm(reason) {
  switch (reason) {
    case 'rate':      return DEGRADED_REASONS.NEWS_LLM_RATE_LIMIT;
    case 'quota':     return DEGRADED_REASONS.NEWS_LLM_QUOTA;
    case 'timeout':   return DEGRADED_REASONS.NEWS_LLM_TIMEOUT;
    case 'budget':    return DEGRADED_REASONS.NEWS_LLM_BUDGET;
    case 'nokey':     return DEGRADED_REASONS.NEWS_LLM_NOKEY;
    case 'parse':     return DEGRADED_REASONS.NEWS_LLM_PARSE;
    case 'provider':
    case 'network':
    case 'server':    return DEGRADED_REASONS.NEWS_LLM_UNAVAILABLE;
    case 'nomessages':return DEGRADED_REASONS.NEWS_LLM_ERROR;
    default:          return DEGRADED_REASONS.NEWS_LLM_ERROR;
  }
}

async function answer(question, intent, result, opts) {
  const fallback = deterministicSummary(result, intent);
  const articles = (result && result.articles) || [];
  if (!articles.length) {
    return { text: fallback, generated: false, degraded: true, reason: DEGRADED_REASONS.NEWS_NO_ARTICLES };
  }

  const o = opts || {};
  const llm = o.llm;
  if (!llm || typeof llm.chat !== 'function') {
    return { text: fallback, generated: false, degraded: true, reason: DEGRADED_REASONS.NEWS_LLM_UNAVAILABLE };
  }

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

  let r = null;
  let thrown = null;
  try {
    r = await llm.chat({
      role: 'answer',
      messages: [{ role: 'system', content: system }, { role: 'user', content: safe(question, 500) }],
      maxTokens: 1200,
      temperature: 0.1,
      perCallMs: 25000,
      budgetMs: o.budgetMs,
      extra: { reasoning: { enabled: false } }
    });
  } catch (e) { thrown = e; }
  if (thrown) {
    return { text: fallback, generated: false, degraded: true, reason: DEGRADED_REASONS.NEWS_EXCEPTION };
  }
  if (!r || !r.ok) {
    return { text: fallback, generated: false, degraded: true, reason: reasonFromLlm(r && r.reason) };
  }
  const text = String(r.text || '').trim();
  if (!text) {
    return { text: fallback, generated: false, degraded: true, reason: DEGRADED_REASONS.NEWS_LLM_EMPTY, model: r.model || '' };
  }
  if (completeEvidence(text, articles)) {
    /*
     * partialSources 는 «답변은 정상이지만 소스는 절반만 살았다» 상태.
     * degraded 로 올리지는 않되 (사용자 응답은 완전하다) 관측용 reason 은 남긴다.
     */
    if (result && result.partialSources) {
      return { text, generated: true, degraded: false, partial: true, reason: DEGRADED_REASONS.NEWS_PARTIAL_SOURCES, model: r.model || '' };
    }
    return { text, generated: true, degraded: false, model: r.model || '' };
  }
  return { text: fallback, generated: false, degraded: true, reason: DEGRADED_REASONS.NEWS_PARSE_FAIL, model: r.model || '' };
}

module.exports = {
  NEWS_LIMIT, DEFAULT_DAYS, OFFICIAL_AI_FEEDS, timeWindow, buildResearchQuery, normalizeArticle, relevantToQuestion,
  impactFor, ideaFor, deterministicSummary, completeEvidence, titleDedupKey,
  research, answer, DEGRADED_REASONS
};
