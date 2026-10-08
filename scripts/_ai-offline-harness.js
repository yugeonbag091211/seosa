'use strict';
/*
 * /api/ai 를 완전 오프라인으로 돌리는 공용 대역.
 *
 * ── 왜 모듈로 뺐는가 ────────────────────────────────────────────
 *
 * test-ai-pipeline.js 는 같은 대역을 자기 안에 갖고 있다(그 파일은 시나리오별로
 * 캐시·stale·차단 모드를 더 세밀하게 흉내 내므로 그대로 둔다). 이 모듈은
 * 2026-10-08 상품 식별 작업에서 새로 생긴 두 검사가 공유하는 최소 대역이다 —
 * 같은 150줄을 두 번 적어 두면 한쪽만 고쳐지는 날이 온다.
 *
 * ── 대역의 선 ───────────────────────────────────────────────────
 *
 * 대역하는 것: OpenRouter 응답, 쿠팡/ADPICK 검색 결과, price_history 조회,
 *              products 카탈로그 조회, 신뢰도 계산.
 * 대역하지 않는 것: 그 사이의 모든 production 코드 — 분류·검색어 정리·조건
 *              추출·제외·랭킹·프롬프트 조립·firewall·카드 변환·fallback.
 *
 * ★ require 는 반드시 ../api/ai.js 보다 먼저 일어나야 한다. 이 모듈을
 *   먼저 require 하면 그 순서가 보장된다(모듈 끝에서 핸들러를 불러온다).
 */

require('./_env.js');
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-or-v1-OFFLINE-TEST';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'offline-product-identity-signing-key';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
process.env.AI_SEARCH_TIMEOUT_MS = process.env.AI_SEARCH_TIMEOUT_MS || '120';
process.env.AI_ENRICH_TIMEOUT_MS = process.env.AI_ENRICH_TIMEOUT_MS || '40';

const auth = require('../api/_auth');
/*
 * 신원 대역. 시나리오가 stub.guest / stub.email 로 바꾼다.
 * 세션 결속(서명 참조를 다른 사람·다른 브라우저가 재사용하는가)을 재려면
 * «누가 보냈는가» 를 시나리오마다 바꿀 수 있어야 한다.
 */
auth.identify = () => (stub.guest
  ? { ok: false, reason: '로그인이 필요합니다' }
  : { ok: true, email: stub.email });
const http = require('../api/_http');
http.applyCors = () => true;
http.noStore = () => {};
const rl = require('../api/_ratelimit');
rl.guard = () => true;

const shop = require('../api/_shop');
const trust = require('../api/_trust');
const pricestat = require('../api/_pricestat');
const aicontext = require('../api/_aicontext');

/** 시나리오마다 갈아끼우는 대역 상태 */
const stub = {
  email: 'qa@seosa.local',
  guest: false,
  searchItems: [],
  searchMode: 'ok',        // ok | empty | blocked | throw
  catalog: [],
  stats: new Map(),
  llm: {},                 // { classify, resolve, answer, answerStatus, answerMode, finish }
  delays: {},
  captured: {}
};

const delay = ms => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

shop.searchAll = async (keyword) => {
  stub.captured.searchQueries = stub.captured.searchQueries || [];
  stub.captured.searchQueries.push(String(keyword || ''));
  await delay(stub.delays.search);
  if (stub.searchMode === 'throw') throw new Error('쿠팡 연결 실패(스텁)');
  if (stub.searchMode === 'blocked') return { items: [], allItems: [], from: 'none', blocked: true };
  if (stub.searchMode === 'empty') return { items: [], allItems: [], from: 'api', blocked: false };
  /*
   * 쿠팡 결과는 운영과 같이 옵션 식별자를 항상 들고 온다. 명시적으로
   * vendorItemId:'' 를 적은 픽스처는 «옵션 없음» 보안 사례용으로 그대로 둔다.
   */
  const items = stub.searchItems.map(it => {
    const o = Object.assign({}, it, { _source: 'api' });
    if (o.isCoupang === true && o.productId
        && !Object.prototype.hasOwnProperty.call(o, 'vendorItemId')) {
      o.vendorItemId = 'OPT-' + String(o.productId);
    }
    return o;
  });
  return { items, allItems: items, from: 'api', blocked: false };
};

function catalogRowOf(it) {
  return {
    product_id: String(it.productId), mall: it.mall, mall_label: it.mallLabel || '',
    title: it.title, lprice: it.lprice, oprice: it.oprice || it.lprice,
    save_pct: it.savePct || 0, link: it.link || '', image: it.image || '',
    keyword: 'fixture', collected_at: new Date().toISOString(),
    vendor_item_id: it.vendorItemId || ''
  };
}

/*
 * 저장된 검색 결과가 카탈로그가 된다 — 운영의 _shop.recordPrices 와 같이
 * (product_id, mall) 로 한 행이고 같은 배치에서는 최저가 옵션이 남는다.
 * 이 대역이 없으면 .env.local 의 운영 Supabase 로 조회가 나간다.
 */
shop.saveProducts = async (_q, list) => {
  await delay(stub.delays.save);
  const byKey = new Map();
  (list || []).forEach(it => {
    if (!it || !it.productId) return;
    const k = `${it.productId}|${it.mall}`;
    const cur = byKey.get(k);
    if (!cur || it.lprice < cur.lprice) byKey.set(k, it);
  });
  byKey.forEach((it, k) => {
    stub.catalog = stub.catalog.filter(r => `${r.product_id}|${r.mall}` !== k);
    stub.catalog.push(catalogRowOf(it));
  });
};

aicontext.loadCatalogRows = async (ids) => {
  stub.captured.catalogIds = ids;
  const want = new Set((ids || []).map(String));
  return (stub.catalog || []).filter(r => want.has(String(r.product_id)));
};

trust.attachTrust = async (list) => {
  await delay(stub.delays.trust);
  (list || []).forEach(it => {
    if (it) it.trust = { level: 'high', label: '방금 확인된 가격', reasons: [{ text: '방금 쇼핑몰에서 받아온 값' }] };
  });
  return list;
};

pricestat.loadStats = async (keys) => {
  stub.captured.historyKeys = keys;
  await delay(stub.delays.history);
  return stub.stats;
};

/* OpenRouter 만 가로챈다. max_tokens 로 어느 호출인지 가른다(production 상수). */
global.fetch = async (url, opts) => {
  if (!String(url).includes('openrouter.ai')) {
    throw new Error(`오프라인 테스트에서 예상 밖 외부 호출: ${url}`);
  }
  const body = JSON.parse(opts.body);
  if (body.max_tokens >= 700) {
    stub.captured.main = body;
    const mode = stub.llm.answerMode || 'ok';
    if (mode === 'hang') await delay(5000);
    if (mode === 'network') throw new Error('socket hang up');
    if (mode === 'malformed') return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
    if (mode === 'non-json-body') return { ok: true, status: 200, json: async () => ({ hello: 'world' }) };
    const st = stub.llm.answerStatus || 200;
    if (st !== 200) {
      return { ok: false, status: st, headers: { get: () => '' }, text: async () => '{"error":"stub"}' };
    }
    return { ok: true, status: 200,
      json: async () => ({ choices: [{ finish_reason: stub.llm.finish || 'stop',
        message: { content: stub.llm.answer === undefined ? '' : stub.llm.answer } }] }) };
  }
  if (body.max_tokens === 120) {
    stub.captured.resolve = body;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: stub.llm.resolve || '' } }] }) };
  }
  stub.captured.classify = body;
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: stub.llm.classify || 'A' } }] }) };
};

const handler = require('../api/ai.js');

/**
 * 핸들러 1회 호출. res 는 운영에서 Vercel 이 주는 것과 같은 모양만 흉내 낸다.
 *
 * @param {object} body
 * @param {object} [opts]  headers — 요청 헤더(쿠키 등). 응답 헤더는 결과의 headers 로 돌려준다.
 */
function call(body, opts) {
  const reqHeaders = Object.assign({}, (opts && opts.headers) || {});
  return new Promise((resolve, reject) => {
    let code = 200;
    const headers = {};
    const res = {
      status(c) { code = c; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      getHeader(k) { return headers[String(k).toLowerCase()]; },
      json(payload) { resolve({ status: code, body: payload, headers }); return this; },
      end() { resolve({ status: code, body: {}, headers }); return this; }
    };
    Promise.resolve(handler({ method: 'POST', headers: reqHeaders, query: {}, body }, res)).catch(reject);
  });
}

/**
 * 쿠키를 기억하는 브라우저 하나.
 *
 * 서버가 Set-Cookie 로 준 값을 다음 요청의 Cookie 헤더로 돌려보낸다 — 실제
 * 브라우저의 same-origin fetch 와 같은 동작이다. 서로 다른 Browser 는 서로의
 * 쿠키를 모른다(= 서로 다른 세션).
 */
function browser() {
  const jar = new Map();
  const absorb = headers => {
    const raw = headers && headers['set-cookie'];
    (Array.isArray(raw) ? raw : raw ? [raw] : []).forEach(line => {
      const first = String(line).split(';')[0];
      const at = first.indexOf('=');
      if (at > 0) jar.set(first.slice(0, at).trim(), first.slice(at + 1).trim());
    });
  };
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    jar,
    async call(body, extraHeaders) {
      const headers = Object.assign({}, extraHeaders || {});
      if (jar.size) headers.cookie = cookieHeader();
      const r = await call(body, { headers });
      absorb(r.headers);
      return r;
    }
  };
}

/** 시나리오 사이에 LLM 캐시·cooldown 을 비운다. 시나리오는 서로 독립이어야 한다. */
function llmReset() {
  try { require('../api/_llm')._internal._reset(); } catch (e) { /* 없으면 그만 */ }
}

function kstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function daysAgo(n) { return new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10); }

/*
 * 모든 후보에 같은 «모양» 의 가격 기록을 준다.
 *
 * ★ 날짜는 오늘 기준으로 굴린다 (scripts/test-radar.js 머리 주석과 같은 이유 —
 *   고정 날짜를 박으면 30일 창이 지나는 날 검사가 조용히 뜻을 잃는다).
 * ★ 기록의 «유무» 가 순위를 흔들면 측정하려던 식별 신호가 묻힌다. 그래서
 *   후보마다 자기 가격에 비례한 같은 모양을 준다.
 */
function statsFor(items) {
  const m = new Map();
  (items || []).forEach(it => {
    const p = it.lprice;
    m.set(`${it.productId}|${it.mall}|${it.vendorItemId || ''}`, {
      count: 12, lastPrice: p, lastDate: kstToday(), prevPrice: Math.round(p * 1.05),
      low: Math.round(p * 0.95), lowDate: daysAgo(20), lowCount: 2, lowIsLatest: false,
      lowConfirmed: true, avg30: Math.round(p * 1.04), avg30Days: 14,
      trendPct: -4, trendDays: 7, trendFrom: Math.round(p * 1.05), trendFromDate: daysAgo(7),
      points: [{ d: daysAgo(7), p: Math.round(p * 1.05) }, { d: kstToday(), p }],
      high: Math.round(p * 1.1), highDate: daysAgo(30),
      avg7: Math.round(p * 1.01), avg7Days: 7,
      volatility: 5, historyDays: 40, maxGapDays: 2, firstDate: daysAgo(40)
    });
  });
  return m;
}

/** 시나리오 초기화. items 를 주면 그것이 검색 결과이자 가격 기록의 대상이다. */
function reset(items) {
  stub.email = 'qa@seosa.local';
  stub.guest = false;
  stub.searchItems = (items || []).map(it => Object.assign({}, it));
  stub.searchMode = 'ok';
  stub.catalog = [];
  stub.stats = statsFor(stub.searchItems);
  stub.llm = {};
  stub.delays = {};
  stub.captured = {};
  llmReset();
}

module.exports = { stub, call, browser, reset, llmReset, statsFor, kstToday, daysAgo };
