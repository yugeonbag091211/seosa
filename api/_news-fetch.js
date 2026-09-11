'use strict';
/*
 * NEWS FETCH — 바깥에서 신호를 가져오는 «유일한» 자리.
 *
 * ── 왜 엔진과 갈라 놓았나 ───────────────────────────────────────────
 *
 * _news-intelligence.js 에는 fetch 가 한 줄도 없다. 계산과 수집을 갈라 두면
 *   · 엔진은 fixture 로 전부 시험할 수 있고
 *   · 외부가 죽어도 엔진의 동작은 변하지 않으며
 *   · "외부 호출 최소화" 를 한 파일만 보면 감사할 수 있다.
 *
 * ── fail-open ───────────────────────────────────────────────────────
 *
 * ★ 이 파일의 모든 함수는 절대 throw 하지 않는다.
 *   뉴스는 SEOSA 의 «보조» 신호다. RSS 한 곳이 죽었다고 검색·가격·핫딜이
 *   같이 멈추면 그건 보조가 아니라 의존이다. 실패는 빈 배열로 돌아온다.
 *
 * ── zero-cost ───────────────────────────────────────────────────────
 *
 * 유료 API 를 부르지 않는다. 여기서 나가는 곳은 공개 RSS 와 GDELT 무료
 * 엔드포인트뿐이고, API 키를 요구하는 경로는 아예 만들어 두지 않았다.
 * (키가 필요해지면 env 자리만 만들고 사람이 결정한다 — 아래 주석 참고)
 */

const R = require('./_market-registry');
const NI = require('./_news-intelligence');

/* 한 번의 호출이 매달릴 수 있는 최대 시간. _coupang.js 와 같은 이유다. */
const TIMEOUT_MS = Number(process.env.NEWS_TIMEOUT_MS) || 8000;
/* 한 피드에서 가져올 최대 항목. 원문 보관이 아니라 신호 탐지가 목적이다. */
const PER_FEED_MAX = 20;
/*
 * 피드 사이 최소 간격 — 남의 서버를 몰아치지 않는다.
 *
 * ★ 250ms 로 시작했다가 1200ms 로 올렸다 (2026-09-10 실측).
 *
 *   Micron IR 과 SEMI 는 처음 확인할 때 200 에 항목 10건을 정상으로 줬는데,
 *   같은 URL 이 감사 실행에서는 403 이 됐다. 2.5초 간격으로 다시 눌러도
 *   여전히 403 이었다 — URL 이 틀린 게 아니라 Cloudflare 가 이 IP 를
 *   그날의 반복 요청 때문에 «평판 불량» 으로 본 것이다.
 *
 *   즉 우리가 너무 자주 눌러서 스스로 문을 닫았다. 남의 무료 피드를 쓰는
 *   쪽이 간격을 넉넉히 두는 것이 맞다. _coupang.js 의 MIN_GAP_MS 와 같은 값이다.
 */
const GAP_MS = Number(process.env.NEWS_GAP_MS) || 2000;

/*
 * 같은 프로세스 안에서 실패한 source 를 즉시 다시 누르지 않는다.
 * 403/429 는 재시도하지 않고 긴 cooldown 을 주며, 일시 오류도 source 별로
 * 지수 backoff 한다. 서버리스 인스턴스가 바뀌면 메모리는 사라지지만 한 번의
 * 수집/감사 실행에서 retry 폭주가 생기는 것은 확실히 막는다.
 */
const SOURCE_BACKOFF = new Map();
const SOURCE_HEALTH = new Map();
const BACKOFF = Object.freeze({
  FORBIDDEN_MS: 24 * 60 * 60 * 1000,
  RATE_LIMIT_MS: 60 * 60 * 1000,
  TRANSIENT_BASE_MS: 5 * 60 * 1000,
  TRANSIENT_MAX_MS: 6 * 60 * 60 * 1000,
  OTHER_MS: 30 * 60 * 1000
});

function sourceIdOf(host) { return String(host || '').toLowerCase().replace(/^www\./, ''); }

function sourceBackoff(host, nowMs) {
  const state = SOURCE_BACKOFF.get(sourceIdOf(host));
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!state || state.until <= now) return null;
  return Object.assign({}, state);
}

function sourceHealthBase(sourceId) {
  return {
    sourceId, status: 'UNKNOWN', lastAttemptAt: null, lastSuccessAt: null,
    consecutiveFailures: 0, http403Count: 0, http429Count: 0,
    timeoutCount: 0, averageLatency: null, backoffUntil: null,
    _latencyTotal: 0, _latencyCount: 0
  };
}

function noteSourceAttempt(host, nowMs) {
  const key = sourceIdOf(host);
  if (!key) return null;
  const state = Object.assign(sourceHealthBase(key), SOURCE_HEALTH.get(key) || {});
  state.lastAttemptAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  SOURCE_HEALTH.set(key, state);
  return publicHealth(state);
}

function publicHealth(state) {
  if (!state) return null;
  const out = Object.assign({}, state);
  delete out._latencyTotal;
  delete out._latencyCount;
  return out;
}

function noteSourceResult(host, result, nowMs) {
  const key = sourceIdOf(host);
  if (!key) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const health = Object.assign(sourceHealthBase(key), SOURCE_HEALTH.get(key) || {});
  const latency = Number(result && result.latencyMs);
  if (Number.isFinite(latency) && latency >= 0) {
    health._latencyTotal += latency;
    health._latencyCount += 1;
    health.averageLatency = Math.round(health._latencyTotal / health._latencyCount);
  }
  if (result && result.ok) {
    SOURCE_BACKOFF.delete(key);
    health.status = 'HEALTHY';
    health.lastSuccessAt = new Date(now).toISOString();
    health.consecutiveFailures = 0;
    health.backoffUntil = null;
    SOURCE_HEALTH.set(key, health);
    return null;
  }

  const previous = SOURCE_BACKOFF.get(key);
  const failures = (previous && previous.failures || 0) + 1;
  const status = Number(result && result.status) || 0;
  let delay;
  if (status === 403) delay = BACKOFF.FORBIDDEN_MS;
  else if (status === 429) delay = BACKOFF.RATE_LIMIT_MS;
  else if (!status || status >= 500) {
    delay = Math.min(BACKOFF.TRANSIENT_BASE_MS * Math.pow(2, failures - 1), BACKOFF.TRANSIENT_MAX_MS);
  } else delay = BACKOFF.OTHER_MS;

  const state = { until: now + delay, failures, status, reason: result && result.error || '' };
  SOURCE_BACKOFF.set(key, state);
  health.consecutiveFailures += 1;
  if (status === 403) health.http403Count += 1;
  if (status === 429) health.http429Count += 1;
  if (!status && result && result.error === 'timeout') health.timeoutCount += 1;
  health.status = status === 403 ? 'BLOCKED' : 'DEGRADED';
  health.backoffUntil = new Date(state.until).toISOString();
  SOURCE_HEALTH.set(key, health);
  return Object.assign({}, state);
}

function clearSourceBackoff() { SOURCE_BACKOFF.clear(); SOURCE_HEALTH.clear(); }

function sourceHealthSnapshot() {
  const out = new Map();
  for (const f of FEEDS) {
    const key = sourceIdOf(f.host), state = SOURCE_HEALTH.get(key);
    out.set(key, publicHealth(state || sourceHealthBase(key)));
  }
  for (const d of PUBLIC_SOURCE_DIAGNOSTICS) {
    const key = sourceIdOf(d.host);
    if (out.has(key)) continue;
    const state = sourceHealthBase(key);
    state.status = d.status === 'NO_RSS' ? 'NO_RSS'
      : d.status === 'BLOCKED' ? 'BLOCKED'
      : d.status === 'WORKING' ? 'UNKNOWN' : 'DISABLED';
    out.set(key, publicHealth(state));
  }
  for (const u of UNREACHABLE_FEEDS) {
    const key = sourceIdOf(u.host);
    if (out.has(key)) continue;
    const state = sourceHealthBase(key);
    state.status = /RSS 미제공/.test(u.reason) ? 'NO_RSS' : 'BLOCKED';
    out.set(key, publicHealth(state));
  }
  for (const [key, state] of SOURCE_HEALTH) out.set(key, publicHealth(state));
  return [...out.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

/*
 * ── 공식 피드 목록 ──────────────────────────────────────────────────
 *
 * ★ 여기 있는 것만 «수집을 시도» 한다. 그리고 수집된 뒤에도
 *   _news-intelligence.normalizeItem 이 도메인을 다시 검사한다.
 *   방어가 두 겹인 이유는, 피드가 리다이렉트로 다른 도메인의 기사를
 *   물고 올 수 있기 때문이다.
 *
 * ★ Google News RSS 와 네이버 뉴스 검색 API 는 «의도적으로 없다».
 *   둘 다 재게시본을 원본처럼 돌려주고, 그러면 독립 출처 계산이 무너진다.
 */
const FEEDS = [
  { url: 'https://nvidianews.nvidia.com/releases.xml',                    host: 'nvidianews.nvidia.com' },
  { url: 'https://blogs.nvidia.com/feed/',                                host: 'blogs.nvidia.com' },
  { url: 'https://ir.amd.com/rss/news-releases.xml',                      host: 'ir.amd.com' },
  { url: 'https://newsroom.intel.com/feed',                               host: 'newsroom.intel.com' },
  { url: 'https://news.samsung.com/global/feed',                          host: 'news.samsung.com' },
  { url: 'https://news.skhynix.com/feed/',                                host: 'news.skhynix.com' },
  /* 2026-09-10 교정: press.aboutamazon.com 은 어떤 경로도 404. 뉴스룸이 이쪽으로 옮겼다. */
  { url: 'https://www.aboutamazon.com/news/rss',                          host: 'www.aboutamazon.com' },
  { url: 'https://news.microsoft.com/feed/',                              host: 'news.microsoft.com' },
  { url: 'https://openai.com/news/rss.xml',                               host: 'openai.com' },
  { url: 'https://blog.google/rss/',                                      host: 'blog.google' },

  /* B. 공식 정부/공공 RSS — 기관의 RSS 안내 페이지에서 확인된 주소만 쓴다. */
  { url: 'https://www.msit.go.kr/user/rss/rss.do?bbsSeqNo=94',            host: 'www.msit.go.kr' },
  { url: 'https://www.customs.go.kr/kcs/selectBoardRss.do?mi=15265&bbsId=1362', host: 'www.customs.go.kr' },
  { url: 'https://www.bok.or.kr/portal/bbs/B0000552/news.rss?menuNo=200690', host: 'www.bok.or.kr' }
];

/*
 * ── 수집을 «포기한» 공식 출처 ────────────────────────────────────────
 *
 * 목록에서 빼되 왜 뺐는지는 남긴다. 다음 사람이 같은 URL 을 다시 넣고
 * 같은 실패를 반복하지 않도록.
 *
 *   TSMC (pr.tsmc.com)  — 시도한 4개 경로 전부 Cloudflare 403.
 *     URL 이 틀린 게 아니라 서버가 봇을 막는다. 브라우저 UA 로 위장하면
 *     통과할 수는 있겠지만, 상대가 명시적으로 세워 둔 접근 통제를 우회하는
 *     짓은 하지 않는다. 승인 없이 넘을 선이 아니다.
 *
 *   ASML (www.asml.com) — 시도한 6개 경로 전부 404. 뉴스 페이지(/en/news)는
 *     200 이므로 사이트는 살아 있고, RSS 제공을 그만둔 것으로 보인다.
 *     HTML 을 긁는 것은 이 기능의 범위가 아니다(원문 대량 수집 금지).
 *
 * ★ 둘 다 SOURCES 의 «허용 목록에는 남겨 둔다». 우리가 직접 못 가져올 뿐,
 *   GDELT 가 그 도메인의 기사를 물어 오면 여전히 tier A 로 인정해야 한다.
 */
const UNREACHABLE_FEEDS = [
  { host: 'investors.micron.com', reason: '정상 RSS URL이나 현재 IP 가 Cloudflare 403 — 반복 호출하지 않는다' },
  { host: 'pr.tsmc.com',  reason: 'Cloudflare 403 (봇 차단) — 우회하지 않는다' },
  { host: 'www.asml.com', reason: 'RSS 미제공 (모든 경로 404, 뉴스 페이지는 정상)' },
  { host: 'www.semi.org', reason: '정상 RSS URL이나 현재 IP 가 Cloudflare 403 — 반복 호출하지 않는다' }
];

/* 2026-09-10 공식 안내/실측 기준. HTML scraping 으로 대체하지 않는다. */
const PUBLIC_SOURCE_DIAGNOSTICS = Object.freeze([
  { name: '산업통상자원부', host: 'motie.go.kr', tier: 'B', status: 'INVALID_URL', reason: 'registry의 구 도메인이 motir.go.kr로 이동; 검증된 RSS endpoint 없음' },
  { name: '과학기술정보통신부', host: 'msit.go.kr', tier: 'B', status: 'WORKING', feedUrl: 'https://www.msit.go.kr/user/rss/rss.do?bbsSeqNo=94' },
  { name: 'KOTRA', host: 'kotra.or.kr', tier: 'B', status: 'BLOCKED', reason: '공식 안내상 RSS 서비스 일시 중단(~2026-09-24)' },
  { name: '관세청', host: 'customs.go.kr', tier: 'B', status: 'WORKING', feedUrl: 'https://www.customs.go.kr/kcs/selectBoardRss.do?mi=15265&bbsId=1362' },
  { name: '한국은행', host: 'bok.or.kr', tier: 'B', status: 'WORKING', feedUrl: 'https://www.bok.or.kr/portal/bbs/B0000552/news.rss?menuNo=200690' },
  { name: '한국무역협회', host: 'kita.net', tier: 'B', status: 'NO_RSS', reason: '공식 공개 RSS를 확인하지 못함' },
  { name: 'SEMI', host: 'semi.org', tier: 'B', status: 'BLOCKED', reason: '정상 RSS URL이나 현재 IP가 Cloudflare 403' },
  { name: 'WSTS', host: 'wsts.org', tier: 'B', status: 'NO_RSS', reason: '공식 공개 RSS를 확인하지 못함' }
]);

/*
 * ── 유료 뉴스 API 자리 ──────────────────────────────────────────────
 *
 * V1 은 키 없이 돈다. 나중에 필요해지면 여기에 «키 이름만» 생기고,
 * 값은 사람이 직접 발급해 환경변수에 넣는다. 코드에 키를 적지 않는다.
 *
 *   NEWSDATA_API_KEY   (미사용 — 승인 전에는 호출 경로를 만들지 않는다)
 *   APITUBE_API_KEY    (미사용)
 *
 * 지금 이 파일에는 두 서비스를 «부르는 코드가 존재하지 않는다». 키를
 * 환경변수에 넣어도 아무 일도 일어나지 않는다 — 그게 승인 전의 올바른 상태다.
 */
function paidNewsEnabled() {
  return false;   // 승인 전에는 어떤 설정에서도 false 다.
}

/* ══════════════════════════════════════════════════════════════════
 *  1. HTTP — 시간 제한이 걸린 한 번의 GET
 * ══════════════════════════════════════════════════════════════════ */

async function get(url, accept, timeoutMs) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        // 정체를 밝힌다. 밝히지 않는 봇은 WAF 에서 먼저 막힌다.
        'User-Agent': process.env.NEWS_USER_AGENT || 'SEOSA/1.0 (+https://seosa.ai.kr)',
        Accept: accept || 'application/rss+xml, application/xml, text/xml, */*'
      }
    });
    /*
     * 429 는 «우리가 너무 자주 불렀다» 는 뜻이다. 재시도하지 않는다 —
     * 제한에 걸린 상대를 다시 부르면 차단만 앞당긴다(_coupang.js 와 같은 규칙).
     */
    if (!r.ok) return {
      ok: false, status: r.status, text: '',
      error: r.status === 429 ? 'rate-limited' : (r.status === 403 ? 'forbidden' : ''),
      latencyMs: Date.now() - started
    };
    return { ok: true, status: r.status, text: await r.text(), latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════════
 *  2. RSS/Atom 파싱
 *
 *  XML 파서를 새로 넣지 않는다. 필요한 것은 항목마다 제목·링크·날짜·요약
 *  네 개뿐이고, 그 정도는 의존성 없이 읽을 수 있다. 파싱에 실패한 항목은
 *  버린다 — 반쯤 읽은 기사를 근거로 쓰지 않는다.
 * ══════════════════════════════════════════════════════════════════ */

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  /*
   * CDATA opener는 일반 HTML tag가 아니다. tag 제거를 먼저 하면
   * <![CDATA[https://...]]> 전체가 한 tag처럼 지워져 정부 RSS의 제목/링크가
   * 빈 값이 된다. CDATA/entity를 먼저 푼 뒤 실제 markup만 제거한다.
   */
  return decodeEntities(String(s == null ? '' : s)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}

function linkOf(block) {
  // Atom 은 <link href="…"/> 형태다.
  const href = block.match(/<link[^>]*\shref=["']([^"']+)["']/i);
  if (href) return decodeEntities(href[1]);
  const t = tag(block, ['link', 'guid']);
  return stripTags(t);
}

/**
 * @returns {Array} 원시 항목 {title, url, publishedAt, summary}
 */
function parseFeed(xml, opts) {
  const o = opts || {};
  const text = String(xml || '');
  if (!text) return [];
  const blocks = text.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  const out = [];

  for (const b of blocks.slice(0, PER_FEED_MAX)) {
    const encoded = tag(b, ['content:encoded']);
    const strong = encoded.match(/<strong(?:\s[^>]*)?>([\s\S]*?)<\/strong>/i);
    const title = stripTags(o.contentStrongTitle && strong ? strong[1] : tag(b, ['title']));
    const url = linkOf(b);
    const date = stripTags(tag(b, ['pubDate', 'published', 'updated', 'dc:date']));
    /*
     * 기본은 피드가 준 짧은 설명만 쓴다. 설명이 없는 공식 changelog RSS는
     * feed 설정이 명시한 경우에만 content:encoded를 읽고 즉시 길이 상한으로
     * 자른다. 정규화 이후에는 원문 전체가 남지 않는다.
     */
    const summarySource = tag(b, ['description', 'summary']) || (o.contentSummary ? encoded : '');
    const summary = stripTags(summarySource).slice(0, NI.SUMMARY_MAX);
    if (!title || !url || !date) continue;
    out.push({ title, url, publishedAt: date, summary });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
 *  3. 공식 피드 수집
 * ══════════════════════════════════════════════════════════════════ */

/**
 * @returns {Promise<{items:Array, stats:object}>}  ★ throw 하지 않는다
 */
async function fetchFeeds(opts) {
  const o = opts || {};
  const list = o.feeds || FEEDS;
  const now = o.now || new Date();
  const getFn = o.getFn || get;
  const sleepFn = o.sleepFn || sleep;
  const gapMs = Number.isFinite(o.gapMs) ? o.gapMs : GAP_MS;
  const items = [];
  const stats = { attempted: 0, ok: 0, failed: 0, skippedBackoff: 0, rawItems: 0, accepted: 0, rejected: 0, errors: [], sources: [] };

  for (const f of list) {
    const blocked = sourceBackoff(f.host, now.getTime());
    if (blocked) {
      stats.skippedBackoff++;
      stats.sources.push({ host: f.host, status: 'BACKOFF', retryAt: new Date(blocked.until).toISOString() });
      continue;
    }
    stats.attempted++;
    noteSourceAttempt(f.host, now.getTime());
    let r;
    try { r = await getFn(f.url, undefined, f.timeoutMs); }
    catch (e) { r = { ok: false, status: 0, text: '', error: String(e && e.message || e) }; }
    if (!r.ok) {
      stats.failed++;
      stats.errors.push({ host: f.host, status: r.status, error: r.error || '' });
      const state = noteSourceResult(f.host, r, now.getTime());
      stats.sources.push({ host: f.host, status: 'FAILED', httpStatus: r.status, retryAt: new Date(state.until).toISOString() });
    } else {
      noteSourceResult(f.host, r, now.getTime());
      let raws = [];
      try { raws = parseFeed(r.text, f); }
      catch (e) { /* parse 아래에서 실패 처리 */ }
      if (!raws.length) {
        stats.failed++;
        stats.errors.push({ host: f.host, status: r.status, error: 'empty-or-invalid-feed' });
        const state = noteSourceResult(f.host, { ok: false, status: r.status, error: 'empty-or-invalid-feed' }, now.getTime());
        stats.sources.push({ host: f.host, status: 'FAILED', httpStatus: r.status, error: 'empty-or-invalid-feed', retryAt: new Date(state.until).toISOString() });
      } else {
        stats.ok++;
        stats.rawItems += raws.length;
        for (const raw of raws) {
          const it = NI.normalizeItem(raw, now);   // ★ 도메인 관문이 여기 있다
          if (!it) { stats.rejected++; continue; }
          stats.accepted++;
          items.push(it);
        }
        stats.sources.push({ host: f.host, status: 'WORKING', rawItems: raws.length });
      }
    }
    // 성공/실패와 무관하게 다음 source 전에 쉰다. 실패 직후 몰아치지 않는다.
    if (gapMs) await sleepFn(gapMs);
  }
  return { items, stats };
}

/* ══════════════════════════════════════════════════════════════════
 *  4. GDELT — 보조 탐색 전용
 *
 *  ★ GDELT 로 들어온 것은 무엇이든 tier C 다. 단독으로는 BUY 근거가 되지
 *    못하고(엔진의 gdeltOnly 관문), 여기서 그 표시를 강제로 붙인다.
 *    호출부가 tier 를 올릴 방법을 남겨 두지 않는다.
 * ══════════════════════════════════════════════════════════════════ */

const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';

/*
 * ★ GDELT 는 «느리고 엄격하다» (2026-09-10 실측으로 확인).
 *
 *   처음에는 공식 피드와 같은 값(간격 250ms · 제한시간 8초)으로 불렀는데
 *   질의 6개가 전부 실패했다. 직접 재 보니
 *     · 응답에 11.4초가 걸렸고 (8초 제한시간에 걸려 timeout)
 *     · 본문은 429 였다: "limit requests to one every 5 seconds"
 *   즉 두 값 모두 틀렸다. 남의 무료 서비스를 몰아친 쪽이 우리다.
 *
 *   그래서 GDELT 에만 따로 값을 준다. 공식 피드까지 느리게 만들 이유는 없다.
 */
const GDELT_GAP_MS = Number(process.env.NEWS_GDELT_GAP_MS) || 5500;
const GDELT_TIMEOUT_MS = Number(process.env.NEWS_GDELT_TIMEOUT_MS) || 20000;

/*
 * GDELT 전용 in-process backoff / single-flight.
 *
 * ── 왜 별도로 두는가 (2026-09-11 실측) ─────────────────────────────
 *
 *   _news-research 는 GDELT 를 요청 1회당 딱 한 번(maxQueries:1)만 부른다.
 *   그런데 production 에서 concierge 요청이 순차로 들어오면 매 요청마다
 *   같은 endpoint 를 다시 두드리게 되고, GDELT 의 "5초에 한 번" 제한을
 *   가볍게 넘어 429 가 재발한다. SOURCE_BACKOFF 는 RSS/공식 피드용이라
 *   GDELT endpoint 에는 걸리지 않았다.
 *
 *   여기서는 두 가지만 한다.
 *     1) 같은 endpoint 에 대한 in-flight 요청을 병합한다 (single-flight).
 *        같은 프로세스 안에서 두 번째 사용자가 오면 첫 번째 결과를 기다린다.
 *     2) 429/timeout 뒤에는 짧은 쿨다운을 걸어 조용히 빈 배열을 돌려준다.
 *        RSS 는 여전히 살아 있으므로 사용자 응답은 죽지 않는다.
 */
const GDELT_COOLDOWN_MS = Number(process.env.NEWS_GDELT_COOLDOWN_MS) || 5 * 60 * 1000;
const GDELT_TRANSIENT_COOLDOWN_MS = Number(process.env.NEWS_GDELT_TRANSIENT_COOLDOWN_MS) || 60 * 1000;
let GDELT_BACKOFF_UNTIL = 0;      // 이 시각 전까지는 요청을 보내지 않는다
let GDELT_LAST_CALL_AT = 0;       // 마지막 요청 시각 — 프로세스 내 gap 강제용
const GDELT_INFLIGHT = new Map(); // url → Promise<get result>

function gdeltBackoffState(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (GDELT_BACKOFF_UNTIL <= now) return null;
  return { until: GDELT_BACKOFF_UNTIL, remainingMs: GDELT_BACKOFF_UNTIL - now };
}

function noteGdeltFailure(result, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const status = Number(result && result.status) || 0;
  let cooldown = 0;
  if (status === 429) cooldown = GDELT_COOLDOWN_MS;
  else if (status === 403) cooldown = GDELT_COOLDOWN_MS;
  else if (!status && result && result.error === 'timeout') cooldown = GDELT_TRANSIENT_COOLDOWN_MS;
  else if (!status || status >= 500) cooldown = GDELT_TRANSIENT_COOLDOWN_MS;
  if (cooldown) GDELT_BACKOFF_UNTIL = Math.max(GDELT_BACKOFF_UNTIL, now + cooldown);
}

function clearGdeltBackoff() {
  GDELT_BACKOFF_UNTIL = 0;
  GDELT_LAST_CALL_AT = 0;
  GDELT_INFLIGHT.clear();
}

/**
 * @param queries 검색어 배열 — 호출 수를 줄이려 짧게 유지한다
 */
async function fetchGdelt(queries, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const span = o.timespanDays || 14;
  const items = [];
  const stats = { attempted: 0, ok: 0, failed: 0, rawItems: 0, accepted: 0, rejected: 0, errors: [], skippedBackoff: 0, backoffUntil: null, cooldown: false };
  const list = (queries || []).slice(0, o.maxQueries || 6);

  const skipBackoff = o.skipBackoffCheck === true;
  const getFn = o.getFn || get;
  const sleepFn = o.sleepFn || sleep;

  for (let qi = 0; qi < list.length; qi++) {
    const q = list[qi];
    // 같은 프로세스 안에서 최근 실패했다면 조용히 건너뛴다.
    const backoff = skipBackoff ? null : gdeltBackoffState(Date.now());
    if (backoff) {
      stats.skippedBackoff++;
      stats.cooldown = true;
      stats.backoffUntil = new Date(backoff.until).toISOString();
      stats.errors.push({ query: q, error: 'cooldown', retryAt: stats.backoffUntil });
      continue;
    }
    stats.attempted++;
    const url = GDELT_ENDPOINT
      + '?query=' + encodeURIComponent(q)
      + '&mode=ArtList&format=json&sort=DateDesc'
      + '&maxrecords=' + (o.maxRecords || 20)
      + '&timespan=' + span + 'd';

    /*
     * 프로세스 내 gap 강제. GDELT 는 5초에 한 번을 명시적으로 요구한다.
     * 두 사용자 요청이 겹쳐 들어오면 두 번째는 여기서 기다린다 (아니면 429).
     */
    if (!skipBackoff) {
      const sinceLast = Date.now() - GDELT_LAST_CALL_AT;
      if (GDELT_LAST_CALL_AT && sinceLast < GDELT_GAP_MS) {
        await sleepFn(GDELT_GAP_MS - sinceLast);
      }
    }

    let r;
    if (GDELT_INFLIGHT.has(url)) {
      // 동일 URL 이 이미 날아가 있다 — 결과를 공유한다.
      r = await GDELT_INFLIGHT.get(url);
    } else {
      const p = getFn(url, 'application/json', GDELT_TIMEOUT_MS);
      GDELT_INFLIGHT.set(url, p);
      try { r = await p; } finally { GDELT_INFLIGHT.delete(url); }
      GDELT_LAST_CALL_AT = Date.now();
    }
    if (!r.ok) {
      stats.failed++;
      stats.errors.push({ query: q, status: r.status, error: r.error || '' });
      noteGdeltFailure(r, Date.now());
      const bo = gdeltBackoffState(Date.now());
      if (bo) { stats.cooldown = true; stats.backoffUntil = new Date(bo.until).toISOString(); }
      continue;
    }
    stats.ok++;

    let json = null;
    try { json = JSON.parse(r.text); } catch (e) { stats.errors.push({ query: q, error: 'json' }); continue; }
    const arts = (json && json.articles) || [];
    stats.rawItems += arts.length;

    for (const a of arts) {
      const it = NI.normalizeItem({
        title: a.title,
        url: a.url,
        publishedAt: gdeltDate(a.seendate),
        summary: '',
        sourceKey: '__gdelt__'                    // ★ 강제 tier C
      }, now);
      if (!it) { stats.rejected++; continue; }
      /* 원 매체 이름은 보여 주되 신뢰도는 GDELT 의 것이다. */
      it.source = `GDELT · ${String(a.domain || '').slice(0, 40)}`;
      stats.accepted++;
      items.push(it);
    }
    // ★ GDELT 는 5초에 한 번이다. 마지막 요청 뒤에는 다음 호출이 없으므로 기다리지 않는다.
    if (qi < list.length - 1) await sleepFn(GDELT_GAP_MS);
  }
  return { items, stats };
}

/** GDELT 의 20260910T120000Z 형태를 ISO 로 옮긴다. */
function gdeltDate(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/* ══════════════════════════════════════════════════════════════════
 *  5. 한 번에 — 수집 → 정규화 → 사건 묶기
 * ══════════════════════════════════════════════════════════════════ */

/**
 * @returns {Promise<{events, items, stats}>}  ★ throw 하지 않는다. 실패는 빈 결과다.
 */
async function collect(opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const stats = { feeds: null, gdelt: null, totalItems: 0, events: 0, dedupeRate: 0, officialRatio: 0 };

  let items = [];
  try {
    if (o.useFeeds !== false) {
      const f = await fetchFeeds({ feeds: o.feeds, now });
      stats.feeds = f.stats;
      items = items.concat(f.items);
    }
    if (o.useGdelt && o.queries && o.queries.length) {
      const g = await fetchGdelt(o.queries, { now, maxQueries: o.maxQueries, maxRecords: o.maxRecords });
      stats.gdelt = g.stats;
      items = items.concat(g.items);
    }
  } catch (e) {
    /* 여기까지 올 일은 없지만, 와도 조용히 빈 결과다. */
    return { events: [], items: [], stats: Object.assign(stats, { error: String(e && e.message || e) }) };
  }

  /* URL 기준 1차 중복 제거 — 같은 기사를 두 피드가 물고 오는 경우 */
  const byUrl = new Map();
  for (const it of items) { const k = NI.dedupeKey(it.url); if (!byUrl.has(k)) byUrl.set(k, it); }
  const uniq = [...byUrl.values()];

  const classified = uniq.map(it => Object.assign({}, it, NI.classify(it)));
  const events = NI.clusterEvents(classified);

  stats.totalItems = items.length;
  stats.uniqueItems = uniq.length;
  stats.events = events.length;
  stats.dedupeRate = items.length ? Math.round((1 - events.length / items.length) * 1000) / 10 : 0;
  const official = uniq.filter(i => i.tier === 'A' || i.tier === 'B').length;
  stats.officialRatio = uniq.length ? Math.round(official / uniq.length * 1000) / 10 : 0;

  return { events, items: classified, stats };
}

module.exports = {
  FEEDS, UNREACHABLE_FEEDS, PUBLIC_SOURCE_DIAGNOSTICS,
  GDELT_ENDPOINT, TIMEOUT_MS, PER_FEED_MAX, GAP_MS, GDELT_GAP_MS, GDELT_TIMEOUT_MS, BACKOFF,
  get, parseFeed, stripTags, decodeEntities, gdeltDate,
  fetchFeeds, fetchGdelt, collect, paidNewsEnabled,
  sourceBackoff, noteSourceAttempt, noteSourceResult, sourceHealthSnapshot, clearSourceBackoff, sourceIdOf,
  gdeltBackoffState, clearGdeltBackoff, GDELT_COOLDOWN_MS, GDELT_TRANSIENT_COOLDOWN_MS
};
