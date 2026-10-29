'use strict';
/*
 * 대화형 AI 시나리오용 오프라인 하네스 (scripts/test-ai-conversation-memory.js 가 쓴다).
 *
 * api/ai.js 핸들러를 그대로 돌리되, 그 아래의 외부 의존만 바꾼다.
 *   · Supabase  — 읽기 전용 메모리 표. 쓰기를 부르면 즉시 예외(쓰기 시도 수를 센다)
 *   · LLM       — OpenRouter 대역. 시나리오가 «GPT 답변» 을 문자열이나 함수로 정한다
 *   · 쇼핑 검색 — 검색어에 맞는 고정 상품을 돌려준다(쿠팡·ADPICK 호출 0회)
 * 대화는 웹 프론트(public/index.html Chat.send)와 같은 방식으로 이어 간다 — 기록에 질문을 먼저
 * 넣고, 응답의 turnSig·topRecommendationRef·convState 를 다음 요청에 되돌려 보낸다.
 *
 * ★ require 하는 순간 process.env·Module._load·global.fetch 를 바꾼다. 테스트 파일에서만 쓴다.
 */
const path = require('path');
const Module = require('module');

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'offline-conversation-signing-key';
delete process.env.OPENAI_API_KEY;
process.env.OPENROUTER_API_KEY = 'sk-or-v1-OFFLINE-CONVERSATION';
process.env.OPENROUTER_MODELS = 'test/offline:free';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SEOSA_DB_READONLY;
process.env.AI_SEARCH_TIMEOUT_MS = '300';
process.env.AI_ENRICH_TIMEOUT_MS = '600';
process.env.AI_CACHE_TTL_MS = '0';

const DAY = 86400e3;
const kstDate = n => new Date(Date.now() + 9 * 3600e3 - n * DAY).toISOString().slice(0, 10);
const isoAgo = n => new Date(Date.now() - n * DAY).toISOString();

/* ── 가짜 Supabase ─────────────────────────────────────────────── */
const tables = { products: [], price_history: [] };
const counters = { dbWrites: 0, searches: 0, llmMain: 0, llmOther: 0, external: 0 };
function query(table) {
  let rows = (tables[table] || []).slice();
  const q = {
    select() { return q; },
    in(col, vals) { const s = new Set((vals || []).map(String)); rows = rows.filter(r => s.has(String(r[col]))); return q; },
    eq(col, v) { rows = rows.filter(r => String(r[col]) === String(v)); return q; },
    gte(col, v) { rows = rows.filter(r => String(r[col]) >= String(v)); return q; },
    lte(col, v) { rows = rows.filter(r => String(r[col]) <= String(v)); return q; },
    order(col, o) {
      const asc = !o || o.ascending !== false;
      rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      return q;
    },
    limit(n) { rows = rows.slice(0, n); return q; },
    range(a, b) { rows = rows.slice(a, b + 1); return q; },
    then(resolve, reject) { return Promise.resolve({ data: rows.map(r => ({ ...r })), error: null }).then(resolve, reject); }
  };
  ['upsert', 'insert', 'update', 'delete'].forEach(m => {
    q[m] = () => { counters.dbWrites++; throw new Error(`오프라인 하네스에서 DB 쓰기 시도: ${table}.${m}`); };
  });
  return q;
}
const fakeSupabase = { from: t => query(t), rpc: () => { counters.dbWrites++; throw new Error('rpc 금지'); } };
const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './_supabase' || request === '../api/_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};

/* ── 가짜 LLM ──────────────────────────────────────────────────── */
const llmStub = { classify: 'A', resolve: '', answer: '' };
let lastMain = null;
global.fetch = async (url, opts) => {
  if (!String(url).includes('openrouter.ai')) {
    counters.external++;
    throw new Error(`오프라인 하네스에서 예상 밖 외부 호출: ${url}`);
  }
  const body = JSON.parse(opts.body);
  if (body.max_tokens >= 700) {
    counters.llmMain++;
    lastMain = body;
    const content = typeof llmStub.answer === 'function' ? llmStub.answer(body.messages) : llmStub.answer;
    if (content === null) return { ok: false, status: 503, json: async () => ({ error: { message: 'down' } }), text: async () => 'down' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
  }
  counters.llmOther++;
  if (body.max_tokens === 120) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: llmStub.resolve || '' } }] }) };
  }
  const c = typeof llmStub.classify === 'function' ? llmStub.classify(body.messages) : llmStub.classify;
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: c } }] }) };
};

/* ── 인증·CORS·레이트리밋·검색 대역 ─────────────────────────────── */
const auth = require('../api/_auth');
auth.identify = () => ({ ok: true, email: 'conversation@fixture.local' });
const http = require('../api/_http');
http.applyCors = () => true;
http.noStore = () => {};
require('../api/_ratelimit').guard = () => true;

const catalog = [];   // 검색 대역이 고르는 상품 (검색 결과 모양)
const searchLog = [];
const searchEvidenceLog = []; // Exact fixture records returned by each search call.
const shop = require('../api/_shop');
shop.searchAll = async q => {
  counters.searches++;
  const s = String(q || '').toLowerCase();
  searchLog.push(s);
  const hits = catalog.filter(it => (it._keys || []).some(k => s.includes(k)));
  searchEvidenceLog.push(hits.map(it => ({
    productId: it.productId, vendorItemId: it.vendorItemId || '', title: it.title,
    lprice: Number(it.lprice) || 0, oprice: Number(it.oprice) || 0,
    mall: it.mall || '', note: it.oprice > it.lprice
      ? `정가 ${it.oprice}원 · 할인율 ${it.savePct || Math.round((1 - it.lprice / it.oprice) * 100)}%` : ''
  })));
  return { items: hits.map(it => { const o = { ...it, _source: 'api' }; delete o._keys; return o; }), from: 'api', blocked: false };
};
shop.saveProducts = async () => ({ saved: 0 });
require('../api/_trust').attachTrust = async list => {
  (list || []).forEach(it => { if (it) it.trust = { level: 'high', label: '확인된 가격', reasons: ['SEOSA 기록 확인'] }; });
  return list;
};

const llm = require('../api/_llm');
const handler = require('../api/ai.js');

/**
 * 상품 하나를 카탈로그·원장·검색 결과에 함께 등록한다.
 * @param {object} p {pid, vid, mall, title, price, oprice, keys:[검색어 조각], history:[[daysAgo, price]...]}
 */
function addProduct(p) {
  const mall = p.mall || '쿠팡';
  const isCoupang = mall === '쿠팡';
  // 운영과 같은 제휴 링크 꼴 — 카드의 구매 링크·제휴 고지 경로(_affiliate.safeBuyLink)가 그대로 돈다.
  const lptag = require('../api/_affiliate').SEOSA_COUPANG_LPTAG;
  const link = isCoupang
    ? `https://link.coupang.com/re/AFFSDP?lptag=${lptag}&pageKey=${p.pid}&itemId=1${p.pid}&vendorItemId=${p.vid || ''}`
    : `https://biz.adpick.co.kr/link/${p.pid}`;
  tables.products.push({
    product_id: p.pid, mall, mall_label: p.mallLabel || '', title: p.title, lprice: p.price,
    oprice: p.oprice || p.price, save_pct: p.oprice > p.price ? Math.round((1 - p.price / p.oprice) * 100) : 0,
    link, image: '', keyword: (p.keys || [])[0] || '', collected_at: new Date().toISOString(), vendor_item_id: p.vid || ''
  });
  (p.history || []).forEach(([n, price]) => tables.price_history.push({
    product_id: p.pid, mall, vendor_item_id: p.vid || '', price, recorded_date: kstDate(n), recorded_at: isoAgo(n), title: 't', link: ''
  }));
  catalog.push({
    title: p.title, lprice: p.price, oprice: p.oprice || p.price,
    savePct: p.oprice > p.price ? Math.round((1 - p.price / p.oprice) * 100) : 0,
    link, image: '', mall, mallLabel: p.mallLabel || '', productId: p.pid, vendorItemId: p.vid || '',
    isCoupang, _keys: (p.keys || []).map(k => k.toLowerCase())
  });
}

/** Exact fixture history for the product options actually returned as cards. */
function priceHistoryEvidenceForCards(cards) {
  const out = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const rows = tables.price_history.filter(row => String(row.product_id) === String(card.productId || '')
      && (!card.vendorItemId || String(row.vendor_item_id || '') === String(card.vendorItemId))
      && (!card.mall || String(row.mall || '') === String(card.mall)));
    for (const row of rows) out.push({
      productId: String(row.product_id || ''), vendorItemId: String(row.vendor_item_id || ''),
      mall: String(row.mall || ''), price: Number(row.price) || 0,
      observedDate: String(row.recorded_date || row.recorded_at || '')
    });
  }
  return out;
}

/** 한 번의 질문. opts.answer — GPT 답변(문자열·함수·null=공급자 장애). */
async function ask(body, opts = {}) {
  try { llm._internal._reset(); } catch (e) { /* 없으면 그만 */ }
  lastMain = null;
  if (opts.classify !== undefined) llmStub.classify = opts.classify;
  if (opts.resolve !== undefined) llmStub.resolve = opts.resolve;
  llmStub.answer = opts.answer !== undefined ? opts.answer : '확인했습니다.';
  const before = { ...counters };
  let status = 200, payload;
  const res = {
    status(c) { status = c; return this; },
    setHeader() { return this; },
    json(v) { payload = v; return this; },
    end() { payload = {}; return this; }
  };
  const warnings = [];
  const q1 = console.log, q2 = console.warn, q3 = console.error;
  if (!opts.verbose) { console.log = () => {}; console.warn = (...a) => warnings.push(a.map(String).join(' ')); console.error = () => {}; }
  try {
    await handler({ method: 'POST', headers: {}, query: {}, body: Object.assign({ chatHistory: [], contextProducts: [], view: { source: 'none' } }, body) }, res);
  } finally {
    console.log = q1; console.warn = q2; console.error = q3;
  }
  const messages = (lastMain && lastMain.messages) || [];
  return {
    status, body: payload || {}, messages,
    system: (messages[0] && messages[0].content) || '',
    searches: counters.searches - before.searches,
    llmMain: counters.llmMain - before.llmMain,
    warnings
  };
}

/**
 * 웹 프론트처럼 대화를 이어 가는 세션.
 * 기록 상한(10)·서명 참조·대화 상태를 public/index.html Chat.send 와 같은 규칙으로 다룬다.
 */
function session(opts = {}) {
  const s = {
    history: [], prevTop: '', prevTopRef: '', convState: '', limit: opts.limit || 10, turns: [],
    async say(question, o = {}) {
      this.history.push({ role: 'user', text: question });
      const r = await ask({
        question, chatHistory: this.history.slice(-this.limit), prevTop: this.prevTop,
        prevTopRef: this.prevTopRef, convState: this.convState,
        view: o.view || { source: 'none' }, contextProducts: o.contextProducts || []
      }, o);
      const b = r.body || {};
      if (b.topProductId) this.prevTop = String(b.topProductId);
      if (b.topRecommendationRef) this.prevTopRef = String(b.topRecommendationRef);
      else if (b.topProductId && b.items && b.items.length) this.prevTopRef = '';
      if (b.convState) this.convState = String(b.convState);
      const turn = { role: 'assistant', text: b.text || '' };
      if (b.turnSig) turn.sig = String(b.turnSig);
      this.history.push(turn);
      if (this.history.length > this.limit) this.history = this.history.slice(-this.limit);
      this.turns.push({ q: question, r });
      return r;
    },
    /* 새로고침 — 웹은 localStorage 의 대화(최근 10개)·convState·서명 참조를 그대로 다시 읽는다. */
    reload() { return session(Object.assign({}, opts)).restore(this); },
    restore(from) {
      this.history = from.history.slice(); this.prevTop = from.prevTop; this.prevTopRef = from.prevTopRef;
      this.convState = from.convState; return this;
    }
  };
  return s;
}

/** 시스템 프롬프트에서 실제 상품 데이터 블록만. */
const productData = system => (String(system).match(/\n<상품데이터>\n[\s\S]*?\n<\/상품데이터>/) || [''])[0];

module.exports = {
  tables, counters, catalog, searchLog, searchEvidenceLog, llmStub, addProduct, priceHistoryEvidenceForCards, ask, session, productData, kstDate, isoAgo, DAY,
  handler, I: handler._internal
};
