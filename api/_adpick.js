'use strict';
/*
 * ADPICK BIZ API 단일 통로.
 *
 * 실제 확인된 스펙 (2026-08-26, 사용자 curl 테스트 기준)
 *   base URL   https://biz.adpick.co.kr/api/{apikey}/{function}
 *              → API 키는 헤더가 아니라 URL 경로에 들어간다. 쿠팡처럼
 *                서명(HMAC)이 없다 — 키 값 자체가 곧 인증이다.
 *   검색       GET /search?q={검색어}&limit={개수}   (limit 최대 20)
 *   응답       { success, message, data: [...] }
 *              data[].title / price / photo / cp_code / cp_name / commissionlink
 *              price 는 문자열 숫자("10755")로 온다.
 *   실패 응답 형식은 아직 실측하지 못했다 — success!==true 인 경우와 HTTP
 *   비정상 상태코드만 실패로 간주하고, 그 이상의 세부 코드 체계를 추측해서
 *   만들지 않는다.
 *
 * 쿠팡(api/_coupang.js)과 다른 점
 *   - HMAC 서명이 없다 (키가 URL에 있음).
 *   - 전역(교차 인스턴스) DB 카운터/차단 RPC를 새로 만들지 않았다. ADPICK의
 *     공식 호출 한도가 아직 문서로 확인되지 않았고, 이 시점의 호출 규모도
 *     크지 않다. 대신 다음 세 겹으로 방어한다.
 *       1) Supabase 캐시(adpick_search_cache) — 같은 키워드 재조회는 API를 타지 않는다
 *       2) 인스턴스 리미터 — 분당 상한 + 최소 호출 간격
 *       3) 인스턴스 로컬 서킷 브레이커 — 오류가 나면 일정 시간 호출을 멈춘다
 *     (3)은 인스턴스별로만 유효하다(서버리스 인스턴스가 여러 개면 각자 판단한다).
 *     교차 인스턴스 차단이 필요해질 만큼 트래픽이 커지면 coupang_api_state
 *     같은 테이블을 추가하면 된다.
 *
 * ADPICK 호출 코드는 반드시 searchAdpick()만 쓸 것. 직접 fetch 하면 캐시와
 * 리미터를 전부 우회한다.
 */

const supabase = require('./_supabase');
const { parsePrice } = require('./_price');

const HOST = process.env.ADPICK_API_HOST || 'https://biz.adpick.co.kr';

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 인스턴스당 자체 상한. 공식 한도가 확인되지 않아 보수적으로 잡는다. */
const MAX_PER_MIN = envNum('ADPICK_MAX_PER_MIN', 20);
/** 호출 사이 최소 간격. */
const MIN_GAP_MS = envNum('ADPICK_MIN_GAP_MS', 1000);
/** 캐시 수명. */
const CACHE_TTL_MS = envNum('ADPICK_CACHE_TTL_MS', 6 * 60 * 60 * 1000);
/** 호출을 못 하게 됐을 때 그래도 쓸 수 있는 캐시의 최대 나이. */
const STALE_MAX_MS = envNum('ADPICK_STALE_MAX_MS', 48 * 60 * 60 * 1000);
/** 한 번의 호출이 매달릴 수 있는 최대 시간. 없으면 서버리스 함수가 멈춘다
 *  (api/_coupang.js TIMEOUT_MS 주석과 같은 이유). */
const TIMEOUT_MS = envNum('ADPICK_TIMEOUT_MS', 8000);

/** API 문서 확인값: limit 최대 20. */
const ADPICK_MAX_LIMIT = 20;
const FETCH_LIMIT = Math.min(envNum('ADPICK_FETCH_LIMIT', ADPICK_MAX_LIMIT), ADPICK_MAX_LIMIT);

/** 응답 종류별 호출 중단 시간(분). */
const COOLDOWN_MIN = {
  http429: 15,
  http403: 60,
  http401: 60,
  httpOther: 5,
  apiError: 10,   // success !== true
  network: 2
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = {
  window: [],
  lastCallAt: 0,
  blockedUntil: 0,
  blockReason: '',
  totalCalls: 0,
  totalCacheHits: 0,
  totalDenied: 0
};

function hasKey() {
  return !!process.env.ADPICK_API_KEY;
}

/**
 * 로그·오류 문자열에서 API 키를 지운다.
 *
 * ★ ADPICK 은 키가 URL 경로에 들어간다 (`/api/{apikey}/search`). 쿠팡처럼
 *   HMAC 헤더가 아니라서, 업스트림이 오류 페이지에 요청 경로를 되비추면
 *   (nginx 404, "Invalid API key: …" 류) 그 본문이 아래 두 곳을 통해 그대로
 *   Vercel 로그에 남는다.
 *     · !r.ok        → trip(reason) / fallback(reason) 의 body
 *     · JSON 아님    → console.error 의 peek
 *
 *   fetch 자체의 네트워크 오류에는 URL 이 실리지 않는 것을 확인했다
 *   (undici 는 message='fetch failed', cause 는 'getaddrinfo …' 뿐).
 *   위험한 것은 업스트림이 돌려주는 본문 쪽이다.
 *
 *   ADPICK 키는 값 하나가 곧 인증이고 회전 절차가 따로 없다. 로그는 사람이
 *   보는 곳이므로 섞이면 그대로 유출이다 (api/_toss.js keySummary 와 같은 원칙).
 *   본문을 버리지 않고 키만 지운다 — 진단 정보는 남아야 한다.
 */
function redact(text) {
  const s = String(text == null ? '' : text);
  const key = process.env.ADPICK_API_KEY || '';
  if (!key) return s;
  return s.split(key).join('***');
}

function log(source, keyword, decision, extra) {
  console.log(
    `[adpick] source=${source} kw="${String(keyword).slice(0, 30)}" ${decision}`
    + ` win=${state.window.length}/${MAX_PER_MIN}`
    + ` calls=${state.totalCalls} cache=${state.totalCacheHits} denied=${state.totalDenied}`
    + (extra ? ` ${extra}` : '')
  );
}

/* ------------------------------------------------------------------ *
 *  인스턴스 리미터 (api/_coupang.js reserveSlot과 동일한 구조)
 * ------------------------------------------------------------------ */
let reserveChain = Promise.resolve();

function reserveSlot(minGapMs, maxWaitMs) {
  const p = reserveChain.then(() => {
    const now = Date.now();

    while (state.window.length && state.window[0] <= now - 60000) state.window.shift();

    if (state.blockedUntil > now) {
      const left = Math.ceil((state.blockedUntil - now) / 1000);
      return { ok: false, blocked: true, reason: `호출 중단 중 (${left}초 남음): ${state.blockReason}` };
    }
    if (state.window.length >= MAX_PER_MIN) {
      return { ok: false, blocked: false, reason: `인스턴스 분당 한도 ${state.window.length}/${MAX_PER_MIN}` };
    }

    const at = Math.max(now, state.lastCallAt + minGapMs);
    const waitMs = at - now;
    if (waitMs > maxWaitMs) {
      return { ok: false, blocked: false, reason: `간격 제한 — ${waitMs}ms 대기 필요` };
    }

    state.lastCallAt = at;
    state.window.push(at);
    return { ok: true, waitMs };
  });

  reserveChain = p.then(() => {}, () => {});
  return p;
}

/** 로컬 서킷 브레이커. */
function trip(minutes, reason) {
  state.blockedUntil = Math.max(state.blockedUntil, Date.now() + minutes * 60000);
  state.blockReason = reason;
  console.error(`[adpick] 차단 감지 — ${minutes}분간 호출 중단: ${reason}`);
}

/* ------------------------------------------------------------------ *
 *  캐시
 * ------------------------------------------------------------------ */
async function readCache(keyword) {
  try {
    const { data, error } = await supabase
      .from('adpick_search_cache')
      .select('items, req_limit, fetched_at')
      .eq('keyword', keyword)
      .maybeSingle();
    if (error || !data) return null;
    return {
      items: Array.isArray(data.items) ? data.items : [],
      limit: data.req_limit || 0,
      ageMs: Date.now() - new Date(data.fetched_at).getTime()
    };
  } catch (e) {
    return null;
  }
}

async function writeCache(keyword, items, limit) {
  try {
    await supabase.from('adpick_search_cache').upsert({
      keyword,
      items,
      req_limit: limit,
      fetched_at: new Date().toISOString()
    }, { onConflict: 'keyword' });
  } catch (e) { /* 캐시 실패는 무시 — 다음 호출 때 다시 시도한다 */ }
}

/* ------------------------------------------------------------------ *
 *  본체
 * ------------------------------------------------------------------ */

/**
 * cp_name(ADPICK이 알려주는 실제 제휴몰 이름) → 화면에 보여줄 짧은 이름.
 *
 * 2026-08-26 다건 실측(여러 키워드, cp_code 9종)으로 실제 확인된 cp_name:
 *   알리익스프레스, 예스이십사, 보리보리, 오늘의집, 더블유컨셉코리아,
 *   SSG, GS SHOP, Hmall, 롯데홈쇼핑
 *
 * 그중 사용자가 지정한 축약 규칙이 있는 것만 짧게 바꾸고(지금까지 실측된
 * 값 중에는 '알리익스프레스'만 해당), 나머지(11번가/G마켓/쿠팡)는 아직
 * 실제 응답에서 관측되지 않았지만 요청받은 규칙이라 패턴은 남겨 둔다.
 *
 * ★ 패턴에 안 걸리면 cp_name 원본을 그대로 보여준다. 확인되지 않은 몰
 *   이름을 지어내거나 임의로 줄이지 않는다 — 'SSG'는 'SSG'로, 'GS SHOP'은
 *   'GS SHOP'으로 그대로 나간다.
 */
function mallLabelFromCpName(cpName) {
  const s = String(cpName || '').trim();
  if (!s) return '';
  if (/알리익스프레스|aliexpress/i.test(s)) return '알리';
  if (/11번가/.test(s)) return '11번가';
  if (/g\s*마켓|지마켓/i.test(s)) return 'G마켓';
  if (/^쿠팡$/.test(s)) return '쿠팡';
  return s;
}

/**
 * ADPICK 응답 상품 → 내부 모양.
 *
 * commissionlink 가 없으면 이 상품을 식별할 방법도, 구매 버튼을 연결할
 * 방법도 없으므로 버린다. price 는 문자열 숫자라 parsePrice 로 정수화한다
 * (0 이하/파싱 불가 항목은 버린다 — api/_price.js parsePrice 규칙과 동일).
 */
function normalize(raw) {
  const out = [];
  let dropped = 0;

  (raw || []).forEach(it => {
    const commissionlink = String((it && it.commissionlink) || '').trim();
    const price = parsePrice(it && it.price);
    if (!commissionlink || !price) { dropped++; return; }

    const cpName = (it && it.cp_name) || '';
    out.push({
      title: (it && it.title) || '',
      price,
      photo: (it && it.photo) || '',
      cpCode: String((it && it.cp_code) || '').trim(),
      cpName,
      // 화면 표시용. mall(백엔드 식별자 'ADPICK')과는 별개다.
      mallLabel: mallLabelFromCpName(cpName),
      commissionlink
    });
  });

  if (dropped) console.warn(`[adpick] 가격/링크를 읽지 못한 상품 ${dropped}건 제외`);
  return out;
}

/**
 * ADPICK 상품 검색. 실패해도 절대 throw 하지 않고 빈 목록을 돌려준다.
 *
 * @returns {{items: Array, error: string|null, from: string, blocked: boolean}}
 *   from: 'cache' | 'stale-cache' | 'api' | 'none'
 */
async function searchAdpick(keyword, opts = {}) {
  const {
    limit = 10,
    source = 'unknown',
    maxWaitMs = 0,
    minGapMs = MIN_GAP_MS,
    useCache = true,
    cacheTtlMs = CACHE_TTL_MS,
    forceRefresh = false
  } = opts;

  const kw = String(keyword || '').trim().slice(0, 80);
  if (!kw) return { items: [], error: '키워드 없음', from: 'none', blocked: false };

  if (!hasKey()) {
    return { items: [], from: 'none', blocked: false, error: 'ADPICK_API_KEY 환경변수 없음' };
  }

  const cached = useCache ? await readCache(kw) : null;
  if (cached && !forceRefresh && cached.ageMs < cacheTtlMs && cached.limit >= limit) {
    state.totalCacheHits++;
    log(source, kw, 'CACHE', `age=${Math.round(cached.ageMs / 1000)}s items=${cached.items.length}`);
    return { items: cached.items.slice(0, limit), error: null, from: 'cache', blocked: false };
  }

  const fallback = (reason, blocked) => {
    state.totalDenied++;
    if (cached && cached.ageMs <= STALE_MAX_MS) {
      log(source, kw, 'STALE-CACHE', `이유=${reason} age=${Math.round(cached.ageMs / 3600000)}h`);
      return { items: cached.items.slice(0, limit), error: reason, from: 'stale-cache', blocked: !!blocked };
    }
    if (cached) {
      log(source, kw, 'CACHE-EXPIRED',
        `이유=${reason} age=${Math.round(cached.ageMs / 3600000)}h > 상한 ${Math.round(STALE_MAX_MS / 3600000)}h`);
    } else {
      log(source, kw, 'SKIP', `이유=${reason}`);
    }
    return { items: [], error: reason, from: 'none', blocked: !!blocked };
  };

  const slot = await reserveSlot(minGapMs, maxWaitMs);
  if (!slot.ok) return fallback(slot.reason, slot.blocked);
  if (slot.waitMs > 0) {
    await sleep(slot.waitMs);
    if (state.blockedUntil > Date.now()) {
      return fallback(`대기 중 차단됨: ${state.blockReason}`, true);
    }
  }

  state.totalCalls++;
  const reqLimit = Math.max(1, Math.min(ADPICK_MAX_LIMIT, Math.max(limit, FETCH_LIMIT)));
  const url = `${HOST}/api/${encodeURIComponent(process.env.ADPICK_API_KEY)}/search`
    + `?q=${encodeURIComponent(kw)}&limit=${reqLimit}`;

  let r, text;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': process.env.ADPICK_USER_AGENT || 'SEOSA/1.0 (+https://seosa.ai.kr)',
        Accept: 'application/json'
      }
    });
    text = await r.text();
  } catch (e) {
    const timedOut = e.name === 'AbortError';
    const why = timedOut
      ? `네트워크 응답 시간 초과 (${TIMEOUT_MS}ms)`
      : `네트워크 오류: ${e.message}`;
    trip(COOLDOWN_MIN.network, why);
    return fallback(`ADPICK ${why}`, false);
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    const mins = COOLDOWN_MIN['http' + r.status] || COOLDOWN_MIN.httpOther;
    const body = redact((text || '').replace(/<[^>]*>/g, ' ')).slice(0, 150);
    trip(mins, `HTTP ${r.status}: ${body}`);
    return fallback(`ADPICK API ${r.status}: ${body}`, [401, 403, 429].indexOf(r.status) > -1);
  }

  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!data) {
    const peek = redact((text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200);
    console.error(`[adpick] JSON 아님 (http=${r.status} len=${(text || '').length}): ${peek}`);
    return fallback('ADPICK 응답 파싱 실패', false);
  }

  // success 필드 판정만 한다. 그 이상의 에러 코드 체계는 실측되지 않았으므로 만들지 않는다.
  if (data.success !== true) {
    const msg = redact(String(data.message || '')).slice(0, 150);
    trip(COOLDOWN_MIN.apiError, `success=false: ${msg}`);
    return fallback(`ADPICK 오류: ${msg}`, false);
  }

  const items = normalize(data.data);
  if (useCache) await writeCache(kw, items, reqLimit);

  log(source, kw, 'API', `http=${r.status} items=${items.length}`);
  return { items: items.slice(0, limit), error: null, from: 'api', blocked: false };
}

function isBlocked() {
  return state.blockedUntil > Date.now();
}

function localStats() {
  const now = Date.now();
  return {
    maxPerMin: MAX_PER_MIN,
    minGapMs: MIN_GAP_MS,
    cacheTtlMs: CACHE_TTL_MS,
    inWindow: state.window.filter(t => t > now - 60000).length,
    calls: state.totalCalls,
    cacheHits: state.totalCacheHits,
    denied: state.totalDenied,
    blocked: isBlocked(),
    blockReason: state.blockReason,
    blockedForSec: isBlocked() ? Math.ceil((state.blockedUntil - now) / 1000) : 0
  };
}

module.exports = {
  searchAdpick, isBlocked, localStats, hasKey, mallLabelFromCpName, redact,
  MAX_PER_MIN, MIN_GAP_MS, CACHE_TTL_MS, STALE_MAX_MS, FETCH_LIMIT
};
