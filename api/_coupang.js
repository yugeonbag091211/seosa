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

const HOST = 'https://api-gateway.coupang.com';
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

/** 응답 종류별 호출 중단 시간(분). */
const COOLDOWN_MIN = {
  http429: 15,   // 명시적 레이트리밋 — 넉넉히 쉰다
  http403: 60,   // 이용 제한 / 권한 거부
  http401: 60,   // 서명 실패. 재시도해도 똑같이 실패한다
  httpOther: 5,
  rcode: 60,     // rCode 차단 응답
  network: 2
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = {
  window: [],        // 최근 60초 호출 시각
  lastCallAt: 0,     // 마지막으로 "예약된" 호출 시각
  blockedUntil: 0,
  blockReason: '',
  dbGate: true,      // 전역 카운터 사용 가능 여부(스키마 미적용이면 false)
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
  const reqLimit = Math.max(1, Math.min(100, limit));
  const query = `keyword=${encodeURIComponent(kw)}&limit=${reqLimit}`;

  let r, text;
  try {
    r = await fetch(`${HOST}${SEARCH_PATH}?${query}`, {
      headers: { Authorization: sign('GET', SEARCH_PATH, query) }
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
  MAX_PER_MIN, MIN_GAP_MS, CACHE_TTL_MS
};
