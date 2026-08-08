'use strict';
/*
 * 쿠팡 파트너스 API 단일 통로.
 *
 * 쿠팡 공식 한도 (2026-08 이용제한 안내 기준)
 *   검색 API      1분당  50회
 *   리포트 API    1시간당 500회
 *   모든 API 합계 1분당 100회
 *   링크 생성     1분당  50회
 *   → 경고 3회 누적이면 이용 제한
 *
 * 경고를 다시 받으면 복구가 어려우므로 공식 한도의 40%(기본 분당 20회)에서
 * 스스로 멈춘다. 쿠팡을 부르는 코드는 반드시 searchCoupang()만 쓸 것.
 * 직접 fetch 하면 캐시 / 전역 카운터 / 차단 감지를 전부 우회한다.
 *
 * 방어선은 네 겹이다.
 *   1) Supabase 캐시     — 같은 키워드 재조회는 아예 네트워크를 타지 않는다
 *   2) 인스턴스 리미터   — 분당 상한 + 호출 간 최소 간격(동시 호출 직렬화)
 *   3) 전역 카운터(DB)   — 서버리스 인스턴스가 여러 개여도 합계가 상한을 넘지 않는다
 *   4) 서킷 브레이커     — 429/403/rCode 차단이 오면 정해진 시간 동안 호출 중단
 *
 * 그리고 쿠팡 호출에는 재시도가 없다. 제한 응답을 재시도하면 경고만 더 쌓인다.
 */

const crypto = require('crypto');
const supabase = require('./_supabase');

// 테스트에서만 다른 호스트를 물린다. 운영에서는 절대 설정하지 말 것.
const HOST = process.env.COUPANG_API_HOST || 'https://api-gateway.coupang.com';
const SEARCH_PATH = '/v2/providers/affiliate_open_api/apis/openapi/products/search';

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 자체 상한. 쿠팡 공식 50회/분의 40%. */
const MAX_PER_MIN = Math.min(envNum('COUPANG_MAX_PER_MIN', 20), 40);
/** 호출 사이 최소 간격. 순간적으로 몰리는 걸 막는다. */
const MIN_GAP_MS = envNum('COUPANG_MIN_GAP_MS', 1200);
/** 캐시 수명. 상품 가격은 하루 단위로 봐도 충분하다. */
const CACHE_TTL_MS = envNum('COUPANG_CACHE_TTL_MS', 6 * 60 * 60 * 1000);

/*
 * 실제로 쿠팡에 요청할 상품 수.
 *
 * ★ 이 값을 함부로 올리지 말 것. 쿠팡이 rCode=400 으로 거부한다.
 *
 * 2026-08-08 에 실제로 값을 바꿔가며 확인한 결과:
 *   limit=6  → OK       (호출 이력 68건 전부 성공)
 *   limit=10 → OK       (상품 10건 반환)
 *   limit=15 → rCode=400 "limit is out of range"
 *   limit=20 → rCode=400 "limit is out of range"
 *   limit=50 → rCode=400 (호출 이력 41건 전부 실패)
 * → 쿠팡 검색 API 의 limit 상한은 10 이다.
 *
 * "GitHub Actions 가 7/30 이후 한 행도 못 모은다"는 증상의 진짜 원인이
 * 이것이었다. IP 차단이 아니라 limit 을 쿠팡이 받아주지 않은 것이다
 * (collect-all-prices.js 만 50 을 썼고, cron/search 는 6 이라 멀쩡했다).
 *
 * 한때 이 값을 50 으로 올려 캐시를 공유하려 했는데, 그러면 모든 호출이
 * 50 으로 나가서 정상 동작하던 cron·search 까지 rCode=400 을 받는다.
 * 실제로 그 상태가 배포돼 프로덕션 검색이 0건을 반환했다.
 *
 * 10 을 넘기지 말 것. 쿠팡이 상한을 올리면 그때 환경변수로 조정한다.
 */
const COUPANG_MAX_LIMIT = 10;
const FETCH_LIMIT = Math.min(envNum('COUPANG_FETCH_LIMIT', COUPANG_MAX_LIMIT), COUPANG_MAX_LIMIT);

/** 응답 종류별 호출 중단 시간(분). */
const COOLDOWN_MIN = {
  http429: 15,   // 명시적 레이트리밋 — 넉넉히 쉰다
  http403: 60,   // 이용 제한 / 권한 거부
  http401: 60,   // 서명 실패. 재시도해도 똑같이 실패한다
  httpOther: 5,
  rcode: 60,     // rCode 차단 응답
  htmlDenied: 30,// HTTP 200 인데 본문이 차단 안내 HTML
  network: 2
};

/**
 * HTTP 200 으로 내려온 본문이 사실은 차단/점검 안내 페이지인가?
 *
 * 쿠팡은 거부를 status code 로만 알려주지 않는다. 실제로 받은 응답이
 * "HTTP 200 + <html> Sorry! Access denied ..." 였다. 이걸 단순 JSON 파싱 실패로
 * 넘기면 서킷 브레이커가 열리지 않아서, 사용자가 검색할 때마다 차단된 엔드포인트를
 * 계속 두드리게 된다 — 경고가 쌓여 이용 제한으로 가는 정확히 그 경로다.
 */
function looksDenied(body) {
  return /access denied|forbidden|not authorized|blocked|이용이 제한|접근이 거부|점검/i.test(body || '');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = {
  window: [],        // 최근 60초 호출 시각
  lastCallAt: 0,     // 마지막으로 "예약된" 호출 시각
  blockedUntil: 0,
  blockReason: '',
  /*
   * 전역 카운터/차단 상태(Supabase) 사용 여부.
   *
   * 기본은 켜짐. 끄는 경우는 두 가지다.
   *   - 스키마가 아직 안 올라간 환경 (자동으로 false 가 된다)
   *   - 로컬 개발/테스트 (COUPANG_DISABLE_GLOBAL_GATE=1)
   *
   * 로컬 스위치가 필요한 이유: scripts/dev-server.js 는 운영 Supabase 를 그대로
   * 본다. 로컬에서 차단 응답을 한 번 받으면 coupang_api_state 에 전역 차단이
   * 기록돼서 운영 사이트의 검색까지 같이 멈춘다.
   */
  dbGate: process.env.COUPANG_DISABLE_GLOBAL_GATE !== '1',
  dbGateWarned: false,
  totalCalls: 0,
  totalCacheHits: 0,
  totalDenied: 0
};

function hasKeys() {
  return !!(process.env.COUPANG_ACCESS_KEY && process.env.COUPANG_SECRET_KEY);
}

function sign(method, path, query) {
  const d = new Date();
  const ts = d.getUTCFullYear().toString().slice(-2)
    + String(d.getUTCMonth() + 1).padStart(2, '0')
    + String(d.getUTCDate()).padStart(2, '0')
    + 'T'
    + String(d.getUTCHours()).padStart(2, '0')
    + String(d.getUTCMinutes()).padStart(2, '0')
    + String(d.getUTCSeconds()).padStart(2, '0')
    + 'Z';
  const sig = crypto.createHmac('sha256', process.env.COUPANG_SECRET_KEY)
    .update(ts + method + path + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${process.env.COUPANG_ACCESS_KEY}, `
    + `signed-date=${ts}, signature=${sig}`;
}

function log(source, keyword, decision, extra) {
  console.log(
    `[coupang] source=${source} kw="${String(keyword).slice(0, 30)}" ${decision}`
    + ` win=${state.window.length}/${MAX_PER_MIN}`
    + ` calls=${state.totalCalls} cache=${state.totalCacheHits} denied=${state.totalDenied}`
    + (extra ? ` ${extra}` : '')
  );
}

/* ------------------------------------------------------------------ *
 *  인스턴스 리미터 — 슬롯 예약을 직렬화해서 동시 호출도 간격을 지키게 한다
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

    // 앞 호출로부터 minGapMs 뒤를 잡는다. 동시에 들어와도 서로 다른 슬롯을 받는다.
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

/* ------------------------------------------------------------------ *
 *  전역 카운터 / 차단 상태 (Supabase)
 *  DB가 없거나 스키마가 아직 안 올라갔으면 로컬 리미터만으로 계속 간다.
 *  (검색 기능 자체를 죽이지 않는 게 우선)
 * ------------------------------------------------------------------ */
/**
 * 다시 시도해도 소용없는 실패인가?
 * (스키마 미적용 / Supabase 환경변수 누락 → 매 호출마다 경고를 찍을 이유가 없다)
 */
function permanentGateFailure(msg) {
  return /schema cache|does not exist|could not find|환경변수 누락/i.test(msg || '');
}

async function dbAcquire(source, keyword) {
  if (!state.dbGate) return { allowed: true, callId: null, reason: '', degraded: true };
  try {
    const { data, error } = await supabase.rpc('coupang_acquire', {
      max_per_min: MAX_PER_MIN, src: String(source || ''), kw: String(keyword || '')
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('coupang_acquire 응답 없음');
    return {
      allowed: !!row.allowed,
      callId: row.call_id || null,
      reason: row.reason || '',
      used: row.used
    };
  } catch (e) {
    if (permanentGateFailure(e.message)) {
      state.dbGate = false;
      if (!state.dbGateWarned) {
        state.dbGateWarned = true;
        console.warn(`[coupang] 전역 카운터 없음 — supabase/schema.sql을 Supabase SQL Editor에서 실행하세요. (${e.message})`);
      }
    } else {
      console.warn(`[coupang] 전역 카운터 조회 실패(이번 호출은 로컬 한도로 진행): ${e.message}`);
    }
    return { allowed: true, callId: null, reason: '', degraded: true };
  }
}

async function dbFinish(callId, outcome, httpStatus, rCode, items) {
  if (!callId || !state.dbGate) return;
  try {
    await supabase.rpc('coupang_finish', {
      call_id: callId,
      res: outcome,
      http: httpStatus || 0,
      rcode: String(rCode == null ? '' : rCode),
      n_items: items || 0
    });
  } catch (e) { /* 기록 실패가 검색을 막지는 않는다 */ }
}

/** 로컬 + 전역 모두 호출을 멈춘다. */
async function trip(minutes, reason) {
  state.blockedUntil = Math.max(state.blockedUntil, Date.now() + minutes * 60000);
  state.blockReason = reason;
  console.error(`[coupang] 차단 감지 — ${minutes}분간 호출 중단: ${reason}`);
  if (!state.dbGate) return;
  try {
    await supabase.rpc('coupang_block', { minutes, why: reason });
  } catch (e) { /* 로컬 차단만으로도 이번 인스턴스는 멈춘다 */ }
}

/* ------------------------------------------------------------------ *
 *  캐시
 * ------------------------------------------------------------------ */
async function readCache(keyword) {
  try {
    const { data, error } = await supabase
      .from('coupang_search_cache')
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
    await supabase.from('coupang_search_cache').upsert({
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
function normalize(raw) {
  return (raw || []).map(it => {
    const lprice = parseInt(it.discountPrice || it.productPrice) || 0;
    return {
      productId: String(it.productId || ''),
      title: it.productName || '',
      lprice,
      oprice: parseInt(it.productPrice) || 0,
      link: it.productUrl || '',
      image: it.productImage || ''
    };
  }).filter(i => i.lprice > 0 && i.productId);
}

/**
 * 쿠팡 상품 검색. 실패해도 절대 throw 하지 않고 빈 목록을 돌려준다.
 *
 * @param {string} keyword
 * @param {object} opts
 *   limit        가져올 상품 수 (기본 6)
 *   source       로그/집계용 호출 주체 ('search' | 'cron' | 'collect' | 'diag')
 *   maxWaitMs    간격 대기를 얼마나 참을지. 사용자 요청은 0(기다리지 말고 캐시로)
 *   minGapMs     이 호출에 적용할 최소 간격
 *   useCache     캐시 사용 여부
 *   cacheTtlMs   캐시 수명
 *   forceRefresh 캐시가 신선해도 새로 받아온다 (cron 전용)
 * @returns {{items: Array, error: string|null, from: string, blocked: boolean}}
 *   from: 'cache' | 'stale-cache' | 'api' | 'none'
 */
async function searchCoupang(keyword, opts = {}) {
  const {
    limit = 6,
    source = 'unknown',
    maxWaitMs = 0,
    minGapMs = MIN_GAP_MS,
    useCache = true,
    cacheTtlMs = CACHE_TTL_MS,
    forceRefresh = false
  } = opts;

  const kw = String(keyword || '').trim().slice(0, 80);
  if (!kw) return { items: [], error: '키워드 없음', from: 'none', blocked: false };

  if (!hasKeys()) {
    return {
      items: [], from: 'none', blocked: false,
      error: 'COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 환경변수 없음'
    };
  }

  // 1) 캐시 — 여기서 끝나면 쿠팡 API 호출은 0회다.
  const cached = useCache ? await readCache(kw) : null;
  if (cached && !forceRefresh && cached.ageMs < cacheTtlMs && cached.limit >= limit) {
    state.totalCacheHits++;
    log(source, kw, 'CACHE', `age=${Math.round(cached.ageMs / 1000)}s items=${cached.items.length}`);
    return { items: cached.items.slice(0, limit), error: null, from: 'cache', blocked: false };
  }

  // 호출을 못 하게 됐을 때의 최선 — 오래된 캐시라도 있으면 그걸 쓴다.
  const fallback = (reason, blocked) => {
    state.totalDenied++;
    if (cached) {
      log(source, kw, 'STALE-CACHE', `이유=${reason}`);
      return { items: cached.items.slice(0, limit), error: reason, from: 'stale-cache', blocked: !!blocked };
    }
    log(source, kw, 'SKIP', `이유=${reason}`);
    return { items: [], error: reason, from: 'none', blocked: !!blocked };
  };

  // 2) 인스턴스 리미터 + 서킷 브레이커
  const slot = await reserveSlot(minGapMs, maxWaitMs);
  if (!slot.ok) return fallback(slot.reason, slot.blocked);
  if (slot.waitMs > 0) {
    await sleep(slot.waitMs);
    // 대기하는 동안 앞선 호출이 429/403을 받았을 수 있다. 슬롯을 잡을 때 한 번
    // 봤다고 끝이 아니다 — 다시 확인하지 않으면 이미 차단된 걸 알면서도
    // 예약해둔 만큼(동시성 수 - 1) 더 때리게 된다.
    if (state.blockedUntil > Date.now()) {
      return fallback(`대기 중 차단됨: ${state.blockReason}`, true);
    }
  }

  // 3) 전역 카운터 (인스턴스가 여러 개여도 합계를 지킨다)
  const gate = await dbAcquire(source, kw);
  if (!gate.allowed) return fallback(`전역 제한: ${gate.reason}`, /중단|blocked/.test(gate.reason));

  // 4) 실제 호출 — 재시도 없음
  state.totalCalls++;
  // 호출자가 요구한 수와 상관없이 공용 캐시용으로 넉넉히 받는다 (FETCH_LIMIT 주석 참고).
  // 상한은 100 이 아니라 COUPANG_MAX_LIMIT(10) 이다. 넘기면 rCode=400.
  const reqLimit = Math.max(1, Math.min(COUPANG_MAX_LIMIT, Math.max(limit, FETCH_LIMIT)));
  const query = `keyword=${encodeURIComponent(kw)}&limit=${reqLimit}`;

  let r, text;
  try {
    r = await fetch(`${HOST}${SEARCH_PATH}?${query}`, {
      headers: {
        Authorization: sign('GET', SEARCH_PATH, query),
        // Node 의 기본 User-Agent 는 "node" 다. 파트너 API 앞단 WAF 입장에서는
        // 정체를 밝히지 않는 봇과 구분되지 않는다. 어떤 서비스가 부르는지 밝힌다.
        // (2026-08 차단을 이 헤더로 재현·해소하지는 못했지만, 기본값으로 두는 것보다는 낫다)
        'User-Agent': process.env.COUPANG_USER_AGENT || 'SEOSA/1.0 (+https://seosa.ai.kr)',
        Accept: 'application/json'
      }
    });
    text = await r.text();
  } catch (e) {
    await trip(COOLDOWN_MIN.network, `네트워크 오류: ${e.message}`);
    await dbFinish(gate.callId, 'network_error', 0, '', 0);
    return fallback(`쿠팡 네트워크 오류: ${e.message}`, false);
  }

  if (!r.ok) {
    const mins = COOLDOWN_MIN['http' + r.status] || COOLDOWN_MIN.httpOther;
    const body = (text || '').replace(/<[^>]*>/g, ' ').slice(0, 150);
    await trip(mins, `HTTP ${r.status}: ${body}`);
    await dbFinish(gate.callId, 'http_error', r.status, '', 0);
    return fallback(`쿠팡 API ${r.status}: ${body}`, [401, 403, 429].indexOf(r.status) > -1);
  }

  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!data) {
    /*
     * HTTP 200 인데 JSON 이 아니다.
     *
     * 조용히 캐시로 넘어가면 안 된다 — 쿠팡이 차단 안내 페이지나 점검 페이지를
     * 200 으로 내려주는 경우가 있고, 그러면 사이트는 며칠이고 옛 캐시만
     * 보여주면서 로그에는 "파싱 실패" 한 줄만 남는다. 무엇을 받았는지 남긴다.
     */
    const peek = (text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    console.error(`[coupang] JSON 아님 (http=${r.status} len=${(text || '').length} limit=${reqLimit}): ${peek}`);

    if (looksDenied(peek)) {
      await trip(COOLDOWN_MIN.htmlDenied, `HTML 차단 응답(HTTP 200): ${peek.slice(0, 120)}`);
      await dbFinish(gate.callId, 'blocked_html', r.status, '', 0);
      return fallback(`쿠팡 접근 차단: ${peek.slice(0, 120)}`, true);
    }

    await dbFinish(gate.callId, 'parse_error', r.status, '', 0);
    return fallback('쿠팡 응답 파싱 실패', false);
  }

  const rCode = data.rCode;
  const ok = rCode === undefined || rCode === null || String(rCode) === '200' || String(rCode) === '0';
  if (!ok) {
    const msg = String(data.rMessage || '').replace(/<[^>]*>/g, ' ').slice(0, 150);
    if (String(rCode) === '400') {
      console.warn(`[coupang] rCode=400 파라미터 오류 (서킷 브레이커 미작동): ${msg}`);
      await dbFinish(gate.callId, 'param_error', r.status, rCode, 0);
      return { items: [], error: `쿠팡 rCode=400: ${msg}`, from: 'none', blocked: false };
    }
    await trip(COOLDOWN_MIN.rcode, `rCode=${rCode}: ${msg}`);
    await dbFinish(gate.callId, 'blocked', r.status, rCode, 0);
    return fallback(`쿠팡 rCode=${rCode}: ${msg}`, true);
  }

  const items = normalize((data.data && data.data.productData) || []);
  await dbFinish(gate.callId, 'ok', r.status, rCode, items.length);
  if (useCache) await writeCache(kw, items, reqLimit);

  log(source, kw, 'API', `http=${r.status} items=${items.length}`);
  return { items: items.slice(0, limit), error: null, from: 'api', blocked: false };
}

/** 지금 호출이 가능한 상태인지 (네트워크는 건드리지 않는다). */
function isBlocked() {
  return state.blockedUntil > Date.now();
}

/** 이번 프로세스/인스턴스 누적 통계. */
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

/** 전역(모든 인스턴스 합계) 호출량. 스키마가 없으면 null. */
async function globalUsage() {
  try {
    const { data, error } = await supabase.rpc('coupang_usage');
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    return row || null;
  } catch (e) {
    return { error: e.message };
  }
}

/** 오래된 호출 로그 정리. cron에서 하루 한 번 부른다. */
async function pruneLog(keepDays = 7) {
  try {
    const { data, error } = await supabase.rpc('coupang_prune', { keep_days: keepDays });
    if (error) throw new Error(error.message);
    return data || 0;
  } catch (e) {
    return 0;
  }
}

module.exports = {
  searchCoupang, isBlocked, localStats, globalUsage, pruneLog,
  MAX_PER_MIN, MIN_GAP_MS, CACHE_TTL_MS, FETCH_LIMIT
};
