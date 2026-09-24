'use strict';
/*
 * SEOSA 2.0 테스트 공용 도구 — 완전 오프라인.
 *
 *   const kit = require('./_v2-testkit');
 *   const { db, T } = kit.setup('test-v2-timing');   // ← api 모듈을 require 하기 «전에» 부른다
 *   const timing = require('../api/_timing');
 *
 * ★ 외부 호출 0회. 운영 Supabase·쿠팡·ADPICK·OpenRouter·Resend 를 부르지 않는다.
 *   - api/_supabase 를 가짜로 바꿔 끼운다 (Module._load 가로채기 — test-radar.js 와 같은 방식)
 *   - global.fetch 를 막는다. 불리면 예외를 던지고 fetchCalls 에 남긴다
 *   - SUPABASE_URL / SUPABASE_SECRET_KEY / RESEND_API_KEY 를 지운다
 *
 * ★ 가짜 DB 는 테스트에 필요한 PostgREST 동작만 흉내 낸다. 흉내 내는 범위:
 *   select · insert · upsert(onConflict, ignoreDuplicates) · update · delete ·
 *   eq · neq · in · gt · gte · lt · lte · is · ilike · or(col.op.val,…) ·
 *   order · limit · range · single · maybeSingle · 변경 뒤 .select() ·
 *   UNIQUE 위반(23505) · 표 없음(42P01) · 오류 주입
 */

const path = require('path');
const Module = require('module');

const SUPABASE_PATH = path.resolve(__dirname, '..', 'api', '_supabase.js');

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function likeToRegex(pattern) {
  const esc = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** "a.ilike.%x%,b.eq.3" → 행 판정 함수 (PostgREST or() 의 단순형) */
function parseOr(expr) {
  const parts = String(expr).split(',').map(s => s.trim()).filter(Boolean);
  const preds = parts.map(p => {
    const m = /^([\w]+)\.(eq|neq|ilike|like|gt|gte|lt|lte)\.(.*)$/.exec(p);
    if (!m) throw new Error(`fake or() 가 이해하지 못한 식: ${p}`);
    const [, c, op, v] = m;
    return r => {
      const x = r[c];
      switch (op) {
        case 'eq': return String(x) === v;
        case 'neq': return String(x) !== v;
        case 'ilike': case 'like': return likeToRegex(v).test(String(x == null ? '' : x));
        case 'gt': return cmp(x, isNaN(v) ? v : Number(v)) > 0;
        case 'gte': return cmp(x, isNaN(v) ? v : Number(v)) >= 0;
        case 'lt': return cmp(x, isNaN(v) ? v : Number(v)) < 0;
        case 'lte': return cmp(x, isNaN(v) ? v : Number(v)) <= 0;
        default: return false;
      }
    };
  });
  return r => preds.some(f => f(r));
}

function createFakeSupabase() {
  const db = {};
  const state = {
    missingTables: new Set(),
    uniques: {},          // table → [[col, …], …]
    failNext: {},         // table → error message (한 번 쓰고 사라진다)
    writes: [],           // { table, op, rows }
    reads: [],            // { table }
    rpcCalls: [],
    rpc: {}               // name → async (args) => ({data, error})
  };
  const seq = {};
  const ensure = t => { if (!db[t]) db[t] = []; return db[t]; };

  function uniqueViolation(table, row, ignoreIdx) {
    const rules = state.uniques[table] || [];
    const rows = ensure(table);
    for (const cols of rules) {
      const hit = rows.findIndex((r, i) => i !== ignoreIdx
        && cols.every(c => String(r[c] == null ? '' : r[c]) === String(row[c] == null ? '' : row[c])));
      if (hit > -1) return { cols, index: hit };
    }
    return null;
  }

  function from(table) {
    const filters = [];
    const orders = [];
    let limitN = null, rangeFrom = null, rangeTo = null;
    let single = null;            // 'single' | 'maybe'
    let op = 'select';
    let payload = null, upsertOpts = null;
    let returnRows = false;

    const q = {
      select() { if (op !== 'select') returnRows = true; return q; },
      insert(rows) { op = 'insert'; payload = rows; return q; },
      upsert(rows, opts) { op = 'upsert'; payload = rows; upsertOpts = opts || {}; return q; },
      update(patch) { op = 'update'; payload = patch; return q; },
      delete() { op = 'delete'; return q; },
      eq(c, v) { filters.push(r => String(r[c]) === String(v)); return q; },
      neq(c, v) { filters.push(r => String(r[c]) !== String(v)); return q; },
      in(c, vs) { const s = (vs || []).map(String); filters.push(r => s.indexOf(String(r[c])) > -1); return q; },
      gt(c, v) { filters.push(r => cmp(r[c], v) > 0); return q; },
      gte(c, v) { filters.push(r => cmp(r[c], v) >= 0); return q; },
      lt(c, v) { filters.push(r => cmp(r[c], v) < 0); return q; },
      lte(c, v) { filters.push(r => cmp(r[c], v) <= 0); return q; },
      is(c, v) { filters.push(r => (v === null ? r[c] == null : r[c] === v)); return q; },
      ilike(c, p) { const re = likeToRegex(p); filters.push(r => re.test(String(r[c] == null ? '' : r[c]))); return q; },
      or(expr) { filters.push(parseOr(expr)); return q; },
      order(c, o) { orders.push({ c, asc: !o || o.ascending !== false }); return q; },
      limit(n) { limitN = n; return q; },
      range(a, b) { rangeFrom = a; rangeTo = b; return q; },
      single() { single = 'single'; return q; },
      maybeSingle() { single = 'maybe'; return q; },
      then(resolve, reject) {
        try { resolve(run()); } catch (e) { if (reject) reject(e); else throw e; }
      }
    };

    function matched() { return ensure(table).filter(r => filters.every(f => f(r))); }

    function shape(rows) {
      let out = rows.map(r => Object.assign({}, r));
      if (single === 'single') {
        if (out.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
        return { data: out[0], error: null };
      }
      if (single === 'maybe') return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }

    function run() {
      if (state.missingTables.has(table)) {
        return { data: null, error: { message: `relation "public.${table}" does not exist`, code: '42P01' } };
      }
      if (state.failNext[table]) {
        const message = state.failNext[table];
        delete state.failNext[table];
        return { data: null, error: { message } };
      }
      const rows = ensure(table);

      if (op === 'select') {
        state.reads.push({ table });
        let out = matched();
        if (orders.length) {
          out = out.slice().sort((a, b) => {
            for (const o of orders) { const d = (o.asc ? 1 : -1) * cmp(a[o.c], b[o.c]); if (d) return d; }
            return 0;
          });
        }
        if (rangeFrom != null) out = out.slice(rangeFrom, rangeTo + 1);
        if (limitN != null) out = out.slice(0, limitN);
        return shape(out);
      }

      if (op === 'insert' || op === 'upsert') {
        const list = Array.isArray(payload) ? payload : [payload];
        const affected = [];
        for (const raw of list) {
          const row = Object.assign({}, raw);
          if (op === 'upsert' && upsertOpts.onConflict) {
            const cols = String(upsertOpts.onConflict).split(',').map(s => s.trim());
            const idx = rows.findIndex(r => cols.every(c =>
              String(r[c] == null ? '' : r[c]) === String(row[c] == null ? '' : row[c])));
            if (idx > -1) {
              if (upsertOpts.ignoreDuplicates) continue;
              Object.assign(rows[idx], row);
              affected.push(rows[idx]);
              continue;
            }
          }
          const v = uniqueViolation(table, row, -1);
          if (v) {
            return { data: null, error: { code: '23505',
              message: `duplicate key value violates unique constraint "${table}_${v.cols.join('_')}_key"` } };
          }
          if (row.id == null) { seq[table] = (seq[table] || rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0)) + 1; row.id = seq[table]; }
          rows.push(row);
          affected.push(row);
        }
        state.writes.push({ table, op, rows: affected.map(r => Object.assign({}, r)) });
        return returnRows ? shape(affected) : { data: null, error: null };
      }

      if (op === 'update') {
        const hit = matched();
        for (const r of hit) {
          const next = Object.assign({}, r, payload);
          const v = uniqueViolation(table, next, rows.indexOf(r));
          if (v) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          Object.assign(r, payload);
        }
        state.writes.push({ table, op, rows: hit.map(r => Object.assign({}, r)) });
        return returnRows ? shape(hit) : { data: null, error: null };
      }

      if (op === 'delete') {
        const hit = matched();
        db[table] = rows.filter(r => hit.indexOf(r) === -1);
        state.writes.push({ table, op, rows: hit.map(r => Object.assign({}, r)) });
        return returnRows ? shape(hit) : { data: null, error: null };
      }
      return { data: null, error: { message: `fake: 모르는 연산 ${op}` } };
    }

    return q;
  }

  async function rpc(name, args) {
    state.rpcCalls.push({ name, args });
    if (state.rpc[name]) return state.rpc[name](args);
    return { data: null, error: { message: `Could not find the function public.${name}`, code: 'PGRST202' } };
  }

  return { client: { from, rpc }, db, state };
}

/* ── 가짜 req / res ─────────────────────────────────────────────── */

let ipSeq = 0;
function mkReq(o) {
  o = o || {};
  ipSeq++;
  return {
    method: o.method || 'GET',
    query: Object.assign({}, o.query || {}),
    body: o.body === undefined ? undefined : o.body,
    headers: Object.assign({ 'x-forwarded-for': o.ip || `198.51.100.${ipSeq % 250}` }, o.headers || {}),
    socket: { remoteAddress: o.ip || `198.51.100.${ipSeq % 250}` }
  };
}

function mkRes() {
  const res = {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = true; return this; },
    send(b) { this.body = b; this.ended = true; return this; },
    end(b) { if (b !== undefined) this.body = b; this.ended = true; return this; }
  };
  return res;
}

/* ── 판정 ───────────────────────────────────────────────────────── */

function tester(name) {
  let pass = 0, fail = 0;
  const failures = [];
  return {
    section(title) { console.log(`\n── ${title}`); },
    check(cond, label, detail) {
      if (cond) { pass++; console.log(`  PASS  ${label}`); }
      else {
        fail++; failures.push(label);
        console.log(`  FAIL  ${label}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
      }
      return !!cond;
    },
    async throws(fn, label) {
      try { await fn(); this.check(false, label, '예외가 나지 않았다'); } catch (e) { this.check(true, label); }
    },
    done() {
      console.log(`\n[${name}] PASS ${pass} / FAIL ${fail}`);
      if (fail) {
        console.log('실패 항목:\n  - ' + failures.join('\n  - '));
        process.exitCode = 1;
      }
      return { pass, fail };
    }
  };
}

/**
 * 오프라인 환경을 세우고 가짜 Supabase 를 끼운다. api 모듈을 require 하기 전에 불러야 한다.
 */
function setup(name) {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.COUPANG_ACCESS_KEY;
  delete process.env.COUPANG_SECRET_KEY;
  delete process.env.ADPICK_API_KEY;
  delete process.env.INVESTIGATOR_LIVE_SEARCH;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'v2-test-secret-not-for-production';

  const fake = createFakeSupabase();
  const realLoad = Module._load;
  Module._load = function(request, parent) {
    if (request === './_supabase' || request === '../api/_supabase' || request === SUPABASE_PATH) {
      return fake.client;
    }
    if (parent && parent.filename && /[\\/]api[\\/]/.test(parent.filename) && request === './_supabase.js') {
      return fake.client;
    }
    return realLoad.apply(this, arguments);
  };

  const fetchCalls = [];
  global.fetch = async url => {
    fetchCalls.push(String(url));
    throw new Error(`오프라인 테스트에서 외부 호출: ${url}`);
  };

  return { db: fake.db, fake, state: fake.state, fetchCalls, T: tester(name), mkReq, mkRes };
}

/* ── 가격 기록 픽스처 ───────────────────────────────────────────── */

/** KST 오늘에서 n 일 전의 'YYYY-MM-DD'. */
function daysAgo(n) {
  const { kstToday } = require('../api/_kst');
  return kstToday(new Date(Date.now() - n * 86400000));
}

/** KST 날짜 d 의 정오(= UTC 03:00) ISO — observedKstDate 가 같은 날로 읽는다. */
function noonKst(date) {
  return `${date}T03:00:00.000Z`;
}

/**
 * 가격 배열(오래된 → 최신, 하루 한 점)로 price_history 행을 만든다. 마지막 값이 오늘이다.
 * @param {{productId:string, mall?:string, vendorItemId?:string, prices:number[], startId?:number, endDaysAgo?:number}} o
 */
function historyRows(o) {
  const mall = o.mall || '쿠팡';
  const vid = o.vendorItemId == null ? 'V1' : o.vendorItemId;
  const end = o.endDaysAgo || 0;
  const n = o.prices.length;
  let id = o.startId || 1;
  const out = [];
  o.prices.forEach((p, i) => {
    if (p == null) return;                       // 빈칸 = 그날 관측 없음
    const date = daysAgo(end + (n - 1 - i));
    out.push({
      id: id++, product_id: o.productId, mall, vendor_item_id: vid, price: p,
      recorded_date: date, recorded_at: noonKst(date)
    });
  });
  return out;
}

module.exports = {
  setup, createFakeSupabase, mkReq, mkRes, tester,
  daysAgo, noonKst, historyRows, likeToRegex, parseOr
};
