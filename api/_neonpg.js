'use strict';

/**
 * Neon(PostgreSQL) 위의 supabase-js 호환 계층 — 서버 전용.
 *
 * ── 왜 «호환 계층» 인가 ───────────────────────────────────────────
 *
 * api/ 와 scripts/ 의 60여 개 파일이 supabase.from(...).select(...).eq(...)
 * 모양으로 DB 를 읽고 쓴다. 이걸 파일마다 SQL 로 다시 쓰면 회귀 위험이
 * 파일 수만큼 생긴다. 대신 그 호출 모양을 그대로 받아 같은 결과를 돌려주는
 * 얇은 층을 하나 두고, 이 층 하나를 Supabase(PostgREST) 동작과 맞춘다.
 * api/_supabase.js 가 SEOSA_DB_BACKEND=neon 일 때만 이 모듈을 쓴다.
 *
 * ── 맞춘 동작 (2026-10-21, @supabase/postgrest-js 2.110.8 소스와 대조) ──
 *
 *   결과 모양     { data, error, count, status, statusText, success } — 절대 throw 하지 않는다
 *                 (throwOnError() 를 건 경우만 예외). 빌더 메서드도 동기 예외를 내지 않고
 *                 실행 시점에 error 로 돌려준다.
 *   행 상한       db-max-rows 1,000 (운영 Supabase 와 같음). limit(5000) 이어도 1,000행.
 *                 keysetScan 등 기존 코드가 «서버가 준 최대 크기» 로 끝을 판정한다.
 *   타입          int8·numeric → number, date → 'YYYY-MM-DD', timestamptz →
 *                 '2026-10-21T01:02:03.4567+00:00' (PostgREST JSON 과 같은 글자),
 *                 interval·bytea → 원문 문자열. node-postgres 기본값(Date 객체·문자열 숫자)을
 *                 그대로 두면 .slice(0, 10) · a.id > b.id · 날짜 비교가 조용히 틀린다.
 *   쓰기 값       json/jsonb 컬럼에는 JSON 텍스트를 보낸다. 배열을 그대로 넘기면 pg 가
 *                 Postgres 배열 리터럴('{a,b}')로 바꿔 jsonb 쓰기가 22P02 로 죽는다
 *                 (user_data.wish 같은 찜 목록이 저장되지 않는다).
 *   여러 행 쓰기  컬럼 = 모든 행 키의 합집합, 빠진 키는 NULL (defaultToNull=false 면 DEFAULT).
 *                 행이 많으면 묶음으로 나눠 한 트랜잭션 안에서 보낸다 — 전부 되거나 전부 안 된다.
 *   upsert        onConflict 가 없으면 기본키. 보낸 컬럼 전부 EXCLUDED 로 갱신.
 *   single        0행·2행 이상이면 PGRST116. maybeSingle 은 0행이면 data=null, 2행 이상 PGRST116.
 *   like/ilike    '*' 는 '%' (PostgREST URL 문법). _seo-pages 의 'title.like.SONY*' 가 이걸 쓴다.
 *   or()          'a.is.null,a.gt.2026-…', and()/or() 중첩, not., in.(…), 큰따옴표 값.
 *   abortSignal   중단되면 AbortError 결과(status 0)를 바로 돌려준다 — hotdeals 가 마감 시간에 쓴다.
 *   rpc           이름 붙은 인자 + 선언된 타입으로 캐스트. 집합 반환은 배열, 스칼라는 값,
 *                 void 는 null, 없는 함수는 PGRST202. range()/limit() 은 서버에서 자른다.
 *   UPDATE/DELETE 필터 없으면 거절(21000) — Supabase 의 pg-safeupdate 와 같다.
 *
 * ── 하지 않는 것 ─────────────────────────────────────────────────
 *   · 관계 임베드(select('*, other(*)')), JSON 경로, 캐스트 — 코드베이스가 쓰지 않는다. 쓰면 error.
 *   · storage / auth / realtime — 서사는 Supabase Auth 를 쓰지 않는다(auth_codes 자체 인증).
 *     storage 는 undefined 라 _imagecache 가 스스로 꺼진다.
 *   · 세션 설정(SET) — Neon pooler(PgBouncer transaction mode)는 세션 상태를 보장하지 않고
 *     startup options 의 statement_timeout 을 08P01 로 거절한다(2026-10-21 실측). 문장 시간
 *     제한은 역할 단위(ALTER ROLE … SET statement_timeout)로 건다 — docs/migration 참고.
 */

const pg = require('pg');

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ROWS = (() => {
  const n = Number(process.env.SEOSA_NEON_MAX_ROWS);
  return Number.isInteger(n) && n > 0 ? n : 1000;
})();
const MAX_FILTERS = 80;
// or() 안의 조건 수. PostgREST 에는 따로 상한이 없다(URL 길이만 있다) — 브랜드 허브·사이트맵이
// 브랜드 접두 수백 개를 or() 하나로 보낸다(2026-10-21 /category 503 재현). 바인드 인자 상한 안쪽으로만 막는다.
const MAX_OR_PARTS = 5000;
// Postgres 바인드 인자 상한은 65,535. 한 문장에 그 절반만 쓴다(테스트는 작게 줄여 묶음 경로를 탄다).
const MAX_PARAMS_PER_STATEMENT = (() => {
  const n = Number(process.env.SEOSA_NEON_MAX_PARAMS);
  return Number.isInteger(n) && n >= 10 && n <= 60000 ? n : 30000;
})();
const META_TTL_MS = 10 * 60 * 1000;

// ─── 오류 ─────────────────────────────────────────────────────────

class AdapterError extends Error {
  constructor(message, code, details, hint) {
    super(message);
    this.code = code || '';
    this.detail = details || null;
    this.hint = hint || null;
  }
}

/** PostgREST 가 돌려주는 오류 모양. DB 오류는 SQLSTATE 를 그대로 code 로 쓴다(PostgREST 와 같다). */
function toPostgrestError(e) {
  if (!e) return { message: 'Database error', code: '', details: null, hint: null };
  return {
    message: String(e.message || 'Database error'),
    code: typeof e.code === 'string' ? e.code : (e.code != null ? String(e.code) : ''),
    details: e.detail != null ? e.detail : (e.details != null ? e.details : null),
    hint: e.hint != null ? e.hint : null
  };
}

function abortResult() {
  return {
    success: false,
    error: {
      message: 'AbortError: This operation was aborted',
      details: '',
      hint: 'Request was aborted (timeout or manual cancellation)',
      code: ''
    },
    data: null,
    count: null,
    status: 0,
    statusText: ''
  };
}

function errorResult(e, status) {
  return { success: false, error: toPostgrestError(e), data: null, count: null, status: status || 400, statusText: 'Bad Request' };
}

function okResult(data, count, status, statusText) {
  return { success: true, error: null, data, count: count == null ? null : count, status: status || 200, statusText: statusText || 'OK' };
}

/** throwOnError() 용 — postgrest-js 의 PostgrestError 와 같은 필드를 가진 Error. */
function postgrestThrowable(err) {
  const e = new Error(err.message);
  e.name = 'PostgrestError';
  e.code = err.code;
  e.details = err.details;
  e.hint = err.hint;
  return e;
}

function quoteIdent(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new AdapterError(`Unsafe SQL identifier: ${String(name).slice(0, 60)}`, 'PGRST100');
  }
  return '"' + name + '"';
}

// ─── 타입 (PostgREST JSON 과 같은 값으로) ─────────────────────────

const TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?$/;

/**
 * Postgres 텍스트 출력('2026-10-21 01:02:03.4567+00') → PostgREST JSON 문자열.
 * 소수 자릿수는 원문 그대로 둔다(Date 로 바꾸면 마이크로초가 잘려 키셋 커서가 어긋날 수 있다).
 * 세션 TimeZone 이 UTC 가 아니어도 같은 순간의 UTC 표기로 맞춘다.
 */
function isoTimestamp(text, withZone) {
  const m = TS_RE.exec(text);
  if (!m) return text;   // infinity · BC · 5자리 연도는 원문 그대로
  const [, y, mo, d, h, mi, s, frac = '', sign, oh, om, os] = m;
  if (!withZone) return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac}`;
  const offsetSec = (Number(oh || 0) * 3600 + Number(om || 0) * 60 + Number(os || 0)) * (sign === '-' ? -1 : 1);
  if (offsetSec === 0) return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac}+00:00`;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetSec * 1000;
  return new Date(utc).toISOString().slice(0, 19) + frac + '+00:00';
}

function toNumberish(text) {
  // PostgREST 는 numeric 'NaN'/'Infinity' 를 문자열로 준다.
  return /^-?\d/.test(text) ? Number(text) : text;
}

const arrayOf = fn => text => pg.types.arrayParser.create(text, fn).parse();
const raw = text => text;

const TEXT_PARSERS = {
  20: Number,                                      // int8
  1016: arrayOf(Number),                           // int8[]
  1700: toNumberish,                               // numeric
  1231: arrayOf(toNumberish),                      // numeric[]
  1082: raw,                                       // date
  1182: arrayOf(raw),                              // date[]
  1114: text => isoTimestamp(text, false),         // timestamp
  1115: arrayOf(text => isoTimestamp(text, false)),
  1184: text => isoTimestamp(text, true),          // timestamptz
  1185: arrayOf(text => isoTimestamp(text, true)),
  1186: raw,                                       // interval
  1187: arrayOf(raw),
  17: raw                                          // bytea → '\x…' (PostgREST 와 같은 표기)
};

/** Pool 에만 거는 타입 해석기. pg 전역(pg.types)은 건드리지 않는다 — 다른 스크립트가 pg 를 직접 쓴다. */
const postgrestTypes = {
  getTypeParser(oid, format) {
    if (format === 'binary') return pg.types.getTypeParser(oid, format);
    return TEXT_PARSERS[oid] || pg.types.getTypeParser(oid, 'text');
  }
};

/** 쓰기 값. JSON 본문으로 PostgREST 에 보낼 때와 같은 값이 컬럼에 들어가게 한다. */
function writeValue(value, colInfo) {
  if (value === undefined || value === null) return null;
  if (colInfo && colInfo.json) return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value;               // text[] 등 → pg 가 배열 리터럴로
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** 필터 값. PostgREST 는 URL 문자열로 받으므로 객체·배열은 오지 않는 게 정상이다. */
function filterValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

// ─── 연결 ─────────────────────────────────────────────────────────

let pool = null;

function assertEnabled() {
  if (process.env.SEOSA_DB_BACKEND !== 'neon' || process.env.SEOSA_NEON_EXPERIMENTAL !== '1') {
    throw new AdapterError('Neon adapter explicitly disabled', 'CONFIG');
  }
  if (process.env.VERCEL_ENV === 'production' && process.env.SEOSA_NEON_PRODUCTION_APPROVED !== '1') {
    throw new AdapterError('Neon production transition not approved', 'CONFIG');
  }
}

function getPool() {
  if (pool) return pool;
  assertEnabled();
  const connectionString = process.env.NEON_DATABASE_URL;
  if (!connectionString || !/^postgres(ql)?:\/\//.test(connectionString)) {
    throw new AdapterError('NEON_DATABASE_URL 환경변수 누락 또는 형식 오류', 'CONFIG');
  }
  const max = Number(process.env.SEOSA_NEON_POOL_MAX);
  pool = new pg.Pool({
    connectionString,
    // node-postgres 는 시스템 루트 인증서로 서버 인증서를 검증한다.
    ssl: { rejectUnauthorized: true },
    types: postgrestTypes,
    max: Number.isInteger(max) && max > 0 ? max : 5,
    idleTimeoutMillis: 15000,
    connectionTimeoutMillis: 15000,   // Neon 은 5분 쉬면 잠든다. 깨어나는 데 수 초 걸릴 수 있다
    allowExitOnIdle: true             // 수집 스크립트가 close() 를 잊어도 프로세스가 끝난다
  });
  // 쉬는 연결이 끊기면(Neon 이 잠들거나 pooler 재시작) 'error' 가 난다. 받지 않으면 프로세스가 죽는다.
  pool.on('error', err => {
    console.warn('[neon] idle connection error:', err && err.message);
  });
  return pool;
}

function poolExecutor() {
  return {
    query(text, values) {
      return getPool().query({ text, values });
    },
    async transaction(fn) {
      const client = await getPool().connect();
      let broken = null;
      try {
        await client.query('BEGIN');
        const out = await fn((text, values) => client.query({ text, values }));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; }
        throw e;
      } finally {
        client.release(broken || undefined);
      }
    }
  };
}

// ─── 메타데이터 (쓰기·rpc 에만 필요하다) ─────────────────────────

function createMetaCache(exec, injected) {
  const tables = new Map();
  const functions = new Map();
  return {
    async table(name) {
      if (injected && injected.tables && injected.tables[name]) return injected.tables[name];
      const hit = tables.get(name);
      if (hit && hit.expires > Date.now()) return hit.value;
      const r = await exec.query(
        `/* seosa:meta:table */ select a.attname as col, t.typname as typ, t.typcategory as cat,
           coalesce(a.attnum = any(i.indkey), false) as pk
         from pg_catalog.pg_class c
         join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         join pg_catalog.pg_type t on t.oid = a.atttypid
         left join pg_catalog.pg_index i on i.indrelid = c.oid and i.indisprimary
         where c.relnamespace = 'public'::regnamespace and c.relname = $1
         order by a.attnum`, [name]);
      const columns = {};
      const primaryKey = [];
      for (const row of r.rows) {
        columns[row.col] = { json: row.typ === 'json' || row.typ === 'jsonb', array: row.cat === 'A' };
        if (row.pk) primaryKey.push(row.col);
      }
      const value = { columns, primaryKey };
      tables.set(name, { value, expires: Date.now() + META_TTL_MS });
      return value;
    },
    async functionOverloads(name) {
      if (injected && injected.functions && injected.functions[name]) return injected.functions[name];
      const hit = functions.get(name);
      if (hit && hit.expires > Date.now()) return hit.value;
      const r = await exec.query(
        `/* seosa:meta:function */ select p.proretset as retset, p.pronargs as nargs,
           p.pronargdefaults as ndefaults,
           coalesce(p.proargnames, '{}'::text[]) as argnames,
           coalesce(p.proargmodes::text[], '{}'::text[]) as argmodes,
           array(select pg_catalog.format_type(t, null) from unnest(p.proargtypes) as t) as intypes,
           rt.typname as rettype, rt.typtype as rettyptype
         from pg_catalog.pg_proc p
         join pg_catalog.pg_type rt on rt.oid = p.prorettype
         where p.pronamespace = 'public'::regnamespace and p.proname = $1 and p.prokind = 'f'`, [name]);
      const value = r.rows.map(row => {
        // proargnames 는 OUT/TABLE 인자 이름까지 담는다. 입력 인자(i/b/v)만 proargtypes 와 순서가 맞는다.
        const modes = row.argmodes.length ? row.argmodes : row.argnames.map(() => 'i');
        const inputNames = row.argnames.filter((_, i) => ['i', 'b', 'v'].includes(modes[i] || 'i'));
        const args = row.intypes.map((type, i) => ({
          name: inputNames[i] || null,
          type,
          hasDefault: i >= row.nargs - row.ndefaults
        }));
        let returns;
        if (row.retset) returns = (row.rettyptype === 'c' || row.rettype === 'record') ? 'rows' : 'scalars';
        else if (row.rettype === 'void') returns = 'void';
        else if (row.rettyptype === 'c' || row.rettype === 'record') returns = 'row';
        else returns = 'scalar';
        return { args, returns, retset: row.retset };
      });
      functions.set(name, { value, expires: Date.now() + META_TTL_MS });
      return value;
    }
  };
}

// ─── 필터 ─────────────────────────────────────────────────────────

const OPERATORS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };

function likePattern(value) {
  return String(value).replace(/\*/g, '%');
}

/** PostgREST 목록 값 '(a,"b,c",d)' → ['a','b,c','d'] */
function parseList(text) {
  const s = String(text).trim();
  if (!s.startsWith('(') || !s.endsWith(')')) throw new AdapterError(`Invalid list: ${s.slice(0, 60)}`, 'PGRST100');
  return splitTopLevel(s.slice(1, -1)).map(unquote);
}

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, '$1');
  return s;
}

/** 쉼표로 나누되 괄호·큰따옴표 안은 나누지 않는다. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < text.length) { cur += text[++i]; continue; }
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth < 0) throw new AdapterError('Unbalanced parentheses in filter', 'PGRST100');
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quoted || depth !== 0) throw new AdapterError('Unbalanced filter expression', 'PGRST100');
  if (cur.length) parts.push(cur);
  return parts;
}

/** 하나의 조건을 SQL 로. value 는 PostgREST 문자열 또는 JS 값. */
function conditionSql(column, op, value, args) {
  const col = quoteIdent(column);
  if (op === 'is') {
    const v = value === null ? 'null' : String(value).toLowerCase();
    if (v === 'null') return `${col} IS NULL`;
    if (v === 'not_null') return `${col} IS NOT NULL`;
    if (v === 'true') return `${col} IS TRUE`;
    if (v === 'false') return `${col} IS FALSE`;
    if (v === 'unknown') return `${col} IS UNKNOWN`;
    throw new AdapterError(`Invalid IS value: ${v}`, 'PGRST100');
  }
  if (op === 'in') {
    const list = Array.isArray(value) ? [...new Set(value)] : parseList(value);
    if (!list.length) return 'FALSE';
    return `${col} IN (${list.map(x => { args.push(filterValue(x)); return '$' + args.length; }).join(',')})`;
  }
  if (!OPERATORS[op]) throw new AdapterError(`Unsupported filter operator: ${op}`, 'PGRST100');
  const v = (op === 'like' || op === 'ilike') ? likePattern(value) : filterValue(value);
  args.push(v);
  return `${col} ${OPERATORS[op]} $${args.length}`;
}

/** 'col.op.value' / 'col.not.op.value' / 'and(...)' / 'or(...)' / 'not.and(...)' */
function logicSql(expr, args, depth) {
  if (depth > 6) throw new AdapterError('Filter nesting too deep', 'PGRST100');
  const s = expr.trim();
  const group = /^(not\.)?(and|or)\((.*)\)$/s.exec(s);
  if (group) {
    const inner = logicListSql(group[3], group[2] === 'and' ? ' AND ' : ' OR ', args, depth + 1);
    return group[1] ? `NOT ${inner}` : inner;
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\.(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$/s.exec(s);
  if (!m) throw new AdapterError(`Unsupported filter expression: ${s.slice(0, 80)}`, 'PGRST100');
  const value = m[3] === 'in' ? m[4] : unquote(m[4]);
  const sql = conditionSql(m[1], m[3], value, args);
  return m[2] ? `NOT (${sql})` : sql;
}

function logicListSql(text, joiner, args, depth) {
  const parts = splitTopLevel(text);
  if (!parts.length || parts.length > MAX_OR_PARTS) throw new AdapterError('Unsupported OR filter', 'PGRST100');
  return '(' + parts.map(p => logicSql(p, args, depth)).join(joiner) + ')';
}

/** supabase-js .not(col, op, value) / .filter(col, op, value) 의 op 는 'in' · 'not.eq' 같은 문자열이다. */
function operatorFilterSql(column, op, value, args) {
  const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)$/.exec(String(op));
  if (!m) throw new AdapterError(`Unsupported filter operator: ${op}`, 'PGRST100');
  const v = m[2] === 'in' && typeof value === 'string' ? parseList(value) : value;
  const sql = conditionSql(column, m[2], v, args);
  return m[1] ? `NOT (${sql})` : sql;
}

// ─── 열 목록 ─────────────────────────────────────────────────────

function projectionSql(columns) {
  // postgrest-js 와 같이 따옴표 밖 공백을 지운다.
  const cleaned = String(columns == null ? '*' : columns).replace(/\s+/g, '');
  if (cleaned === '' || cleaned === '*') return '*';
  const tokens = cleaned.split(',');
  if (tokens.length > 120) throw new AdapterError('Projection too long', 'PGRST100');
  return tokens.map(t => {
    const m = /^(?:([A-Za-z_][A-Za-z0-9_]*):)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
    if (!m) throw new AdapterError(`Unsupported select expression: ${t.slice(0, 60)}`, 'PGRST100');
    return m[1] ? `${quoteIdent(m[2])} AS ${quoteIdent(m[1])}` : quoteIdent(m[2]);
  }).join(', ');
}

// ─── 공통 실행 (abort · throwOnError) ─────────────────────────────

class Thenable {
  constructor() {
    this._signal = null;
    this._throw = false;
  }
  abortSignal(signal) { this._signal = signal || null; return this; }
  throwOnError() { this._throw = true; return this; }

  async _run() {
    const signal = this._signal;
    if (signal && signal.aborted) return abortResult();
    let result;
    if (!signal) {
      result = await this._safeExecute();
    } else {
      let onAbort;
      const aborted = new Promise(resolve => {
        onAbort = () => resolve(abortResult());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        // 중단돼도 이미 보낸 문장은 서버에서 끝까지 돈다. 결과만 버린다.
        result = await Promise.race([this._safeExecute(), aborted]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
    if (this._throw && result.error) throw postgrestThrowable(result.error);
    return result;
  }

  async _safeExecute() {
    try {
      return await this._execute();
    } catch (e) {
      return errorResult(e);
    }
  }

  then(onfulfilled, onrejected) { return this._run().then(onfulfilled, onrejected); }
  catch(onrejected) { return this._run().catch(onrejected); }
  finally(fn) { return this._run().finally(fn); }
}

function shapeSingle(rows, mode) {
  if (!mode) return { data: rows };
  if (rows.length > 1 || (mode === 'single' && rows.length === 0)) {
    return {
      error: {
        code: 'PGRST116',
        details: `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
        hint: null,
        message: 'JSON object requested, multiple (or no) rows returned'
      }
    };
  }
  return { data: rows[0] || null };
}

// ─── 표 질의 ─────────────────────────────────────────────────────

class TableQuery extends Thenable {
  constructor(ctx, table, op) {
    super();
    this.ctx = ctx;
    this.table = table;
    this.op = op;                 // select | insert | upsert | update | delete
    this.columns = '*';
    this.countMode = null;
    this.head = false;
    this.returning = null;        // 쓰기 뒤 .select(cols)
    this.payload = null;
    this.options = {};
    this.filters = [];
    this.orders = [];
    this.limitRows = null;
    this.offsetRows = 0;
    this.singleMode = null;
    this.deferred = null;         // 빌더 단계에서 생긴 오류 — 실행할 때 돌려준다
  }

  _defer(fn) {
    if (this.deferred) return this;
    try { fn(); } catch (e) { this.deferred = e; }
    return this;
  }

  select(columns, opts) {
    // 쓰기 뒤 .select() 는 RETURNING 이다.
    if (this.op !== 'select') { this.returning = columns == null ? '*' : columns; return this; }
    this.columns = columns == null ? '*' : columns;
    if (opts && opts.count) this.countMode = opts.count;
    if (opts && opts.head) this.head = true;
    return this;
  }

  _filter(column, op, value) {
    return this._defer(() => { quoteIdent(column); this.filters.push({ column, op, value }); });
  }
  eq(c, v) { return this._filter(c, 'eq', v); }
  neq(c, v) { return this._filter(c, 'neq', v); }
  gt(c, v) { return this._filter(c, 'gt', v); }
  gte(c, v) { return this._filter(c, 'gte', v); }
  lt(c, v) { return this._filter(c, 'lt', v); }
  lte(c, v) { return this._filter(c, 'lte', v); }
  like(c, v) { return this._filter(c, 'like', v); }
  ilike(c, v) { return this._filter(c, 'ilike', v); }
  is(c, v) { return this._filter(c, 'is', v); }
  in(c, values) {
    return this._defer(() => {
      quoteIdent(c);
      if (!Array.isArray(values)) throw new AdapterError('in() requires an array', 'PGRST100');
      this.filters.push({ column: c, op: 'in', value: values });
    });
  }
  match(obj) { for (const [k, v] of Object.entries(obj || {})) this.eq(k, v); return this; }
  not(c, op, v) { return this._defer(() => { quoteIdent(c); this.filters.push({ column: c, op: 'not.' + op, value: v, raw: true }); }); }
  filter(c, op, v) { return this._defer(() => { quoteIdent(c); this.filters.push({ column: c, op, value: v, raw: true }); }); }
  or(expr) { this.filters.push({ or: String(expr) }); return this; }

  order(column, opts = {}) {
    return this._defer(() => { quoteIdent(column); this.orders.push({ column, ascending: opts.ascending !== false, nullsFirst: opts.nullsFirst }); });
  }
  limit(n) { this.limitRows = Number(n); return this; }
  range(from, to) { this.offsetRows = Number(from); this.limitRows = Number(to) - Number(from) + 1; return this; }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }

  _where(args) {
    if (this.filters.length > MAX_FILTERS) throw new AdapterError('Too many filters', 'PGRST100');
    const parts = this.filters.map(f => {
      if (f.or) return logicListSql(f.or, ' OR ', args, 0);
      if (f.raw) return operatorFilterSql(f.column, f.op, f.value, args);
      return conditionSql(f.column, f.op, f.value, args);
    });
    return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
  }

  _paging() {
    const limit = this.limitRows;
    if (limit != null && (!Number.isInteger(limit) || limit < 0)) throw new AdapterError('Invalid limit', 'PGRST103');
    if (!Number.isInteger(this.offsetRows) || this.offsetRows < 0) throw new AdapterError('Invalid offset', 'PGRST103');
    return { limit: limit == null ? MAX_ROWS : Math.min(limit, MAX_ROWS), offset: this.offsetRows };
  }

  async _execute() {
    if (this.deferred) throw this.deferred;
    const table = 'public.' + quoteIdent(this.table);
    if (this.op === 'select') return this._select(table);
    if (this.op === 'insert' || this.op === 'upsert') return this._insert(table);
    if (this.op === 'update') return this._update(table);
    if (this.op === 'delete') return this._delete(table);
    throw new AdapterError(`Unsupported operation ${this.op}`, 'PGRST100');
  }

  async _select(table) {
    const exec = this.ctx.exec;
    // SQL 은 전부 먼저 만든다 — 만드는 중에 실패하면 아무 문장도 보내지 않는다(떠도는 count 질의 없음).
    const cArgs = [];
    const countSql = this.countMode ? `SELECT COUNT(*)::bigint AS count FROM ${table}${this._where(cArgs)}` : null;
    const args = [];
    let text = `SELECT ${projectionSql(this.columns)} FROM ${table}${this._where(args)}`;
    const countOf = async () => {
      if (!countSql) return null;
      const r = await exec.query(countSql, cArgs);
      return Number(r.rows[0].count);
    };
    if (this.head) return okResult(null, await countOf());

    if (this.orders.length) {
      text += ' ORDER BY ' + this.orders.map(o => quoteIdent(o.column)
        + (o.ascending ? ' ASC' : ' DESC')
        + (o.nullsFirst === true ? ' NULLS FIRST' : o.nullsFirst === false ? ' NULLS LAST' : '')).join(', ');
    }
    const { limit, offset } = this._paging();
    args.push(limit); text += ` LIMIT $${args.length}`;
    if (offset) { args.push(offset); text += ` OFFSET $${args.length}`; }
    const [r, count] = await Promise.all([exec.query(text, args), countOf()]);
    const shaped = shapeSingle(r.rows, this.singleMode);
    if (shaped.error) return { success: false, error: shaped.error, data: null, count: null, status: 406, statusText: 'Not Acceptable' };
    return okResult(shaped.data, count);
  }

  async _insert(table) {
    const exec = this.ctx.exec;
    const many = Array.isArray(this.payload);
    const input = many ? this.payload : [this.payload];
    if (!input.length) return okResult(this.returning != null ? [] : null, this.countMode ? 0 : null, 201, 'Created');
    if (input.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new AdapterError('Invalid insert payload', 'PGRST102');

    // postgrest-js: 여러 행이면 columns = 모든 키의 합집합(값이 undefined 인 키 포함).
    // 한 행이면 JSON.stringify 가 undefined 값을 지우므로 그 키는 아예 보내지 않는다.
    const keys = many
      ? [...new Set(input.flatMap(r => Object.keys(r)))]
      : Object.keys(input[0]).filter(k => input[0][k] !== undefined);
    keys.forEach(quoteIdent);

    const meta = await this.ctx.meta.table(this.table);
    if (!Object.keys(meta.columns).length) throw new AdapterError(`relation "public.${this.table}" does not exist`, '42P01');
    for (const k of keys) {
      if (!meta.columns[k]) {
        throw new AdapterError(`Could not find the '${k}' column of '${this.table}' in the schema cache`, 'PGRST204');
      }
    }

    let conflict = null;
    if (this.op === 'upsert') {
      conflict = this.options.onConflict
        ? String(this.options.onConflict).split(',').map(x => x.trim()).filter(Boolean)
        : meta.primaryKey.slice();
      if (!conflict.length) throw new AdapterError(`No conflict target for upsert on ${this.table}`, '42P10');
      conflict.forEach(quoteIdent);
    }
    const useDefault = this.options.defaultToNull === false;

    const buildStatement = (rows, args) => {
      if (!keys.length) {
        // 빈 객체 insert → 전부 기본값
        return `INSERT INTO ${table} DEFAULT VALUES` + this._returningSql();
      }
      const tuples = rows.map(row => '(' + keys.map(k => {
        if (!Object.prototype.hasOwnProperty.call(row, k) || row[k] === undefined) {
          if (useDefault) return 'DEFAULT';
          args.push(null);
          return '$' + args.length;
        }
        args.push(writeValue(row[k], meta.columns[k]));
        return '$' + args.length;
      }).join(', ') + ')');
      let text = `INSERT INTO ${table} (${keys.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')}`;
      if (conflict) {
        text += ` ON CONFLICT (${conflict.map(quoteIdent).join(', ')})`;
        if (this.options.ignoreDuplicates) text += ' DO NOTHING';
        else text += ' DO UPDATE SET ' + keys.map(k => `${quoteIdent(k)} = EXCLUDED.${quoteIdent(k)}`).join(', ');
      }
      return text + this._returningSql();
    };

    const perStatement = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / Math.max(1, keys.length)));
    const chunks = [];
    for (let i = 0; i < input.length; i += perStatement) chunks.push(input.slice(i, i + perStatement));

    if (conflict && !this.options.ignoreDuplicates && chunks.length > 1) {
      // 한 문장이었다면 Postgres 가 21000 으로 거절했을 입력을 묶음 사이에서 조용히 덮어쓰지 않는다.
      const seen = new Set();
      for (const row of input) {
        const key = JSON.stringify(conflict.map(k => row[k] === undefined ? null : row[k]));
        if (seen.has(key)) throw new AdapterError('ON CONFLICT DO UPDATE command cannot affect row a second time', '21000');
        seen.add(key);
      }
    }

    const run = async query => {
      const rows = [];
      let affected = 0;
      for (const chunk of chunks) {
        const args = [];
        const r = await query(buildStatement(chunk, args), args);
        affected += r.rowCount || 0;
        if (r.rows) rows.push(...r.rows);
      }
      return { rows, affected };
    };
    const out = chunks.length > 1 ? await exec.transaction(run) : await run((t, a) => exec.query(t, a));
    return this._writeResult(out, 201, 'Created');
  }

  _returningSql() {
    return this.returning != null ? ' RETURNING ' + projectionSql(this.returning) : '';
  }

  _writeResult(out, status, statusText) {
    const count = this.countMode ? out.affected : null;
    if (this.returning == null) {
      // PostgREST: insert 는 return=minimal 이어도 201, update/delete 는 204.
      const minimal = status === 201 || this.countMode;
      return okResult(null, count, minimal ? status : 204, minimal ? statusText : 'No Content');
    }
    const shaped = shapeSingle(out.rows, this.singleMode);
    if (shaped.error) return { success: false, error: shaped.error, data: null, count: null, status: 406, statusText: 'Not Acceptable' };
    return okResult(shaped.data, count, status, statusText);
  }

  async _update(table) {
    const exec = this.ctx.exec;
    const payload = this.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AdapterError('Invalid update payload', 'PGRST102');
    const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
    keys.forEach(quoteIdent);
    const args = [];
    const where = this._where(args);
    if (!where) throw new AdapterError('UPDATE requires a WHERE clause', '21000');
    if (!keys.length) {
      // PostgREST 는 빈 갱신을 «아무것도 안 함» 으로 받는다.
      return this._writeResult({ rows: [], affected: 0 }, 200, 'OK');
    }
    const meta = await this.ctx.meta.table(this.table);
    for (const k of keys) {
      if (!meta.columns[k]) throw new AdapterError(`Could not find the '${k}' column of '${this.table}' in the schema cache`, 'PGRST204');
    }
    const sets = keys.map(k => { args.push(writeValue(payload[k], meta.columns[k])); return `${quoteIdent(k)} = $${args.length}`; });
    const r = await exec.query(`UPDATE ${table} SET ${sets.join(', ')}${where}${this._returningSql()}`, args);
    return this._writeResult({ rows: r.rows || [], affected: r.rowCount || 0 }, 200, 'OK');
  }

  async _delete(table) {
    const args = [];
    const where = this._where(args);
    if (!where) throw new AdapterError('DELETE requires a WHERE clause', '21000');
    const r = await this.ctx.exec.query(`DELETE FROM ${table}${where}${this._returningSql()}`, args);
    return this._writeResult({ rows: r.rows || [], affected: r.rowCount || 0 }, 200, 'OK');
  }
}

/** supabase.from(table) — 매번 새 빌더를 만든다(postgrest-js 의 cloneRequestState 와 같다). */
class TableRef {
  constructor(ctx, table) { this.ctx = ctx; this.table = table; }
  _q(op) { const q = new TableQuery(this.ctx, this.table, op); q._defer(() => quoteIdent(this.table)); return q; }
  select(columns, opts) { return this._q('select').select(columns, opts); }
  insert(values, opts = {}) {
    const q = this._q('insert');
    q.payload = values; q.options = { defaultToNull: opts.defaultToNull };
    if (opts.count) q.countMode = opts.count;
    return q;
  }
  upsert(values, opts = {}) {
    const q = this._q('upsert');
    q.payload = values;
    q.options = { onConflict: opts.onConflict, ignoreDuplicates: !!opts.ignoreDuplicates, defaultToNull: opts.defaultToNull };
    if (opts.count) q.countMode = opts.count;
    return q;
  }
  update(values, opts = {}) {
    const q = this._q('update');
    q.payload = values;
    if (opts.count) q.countMode = opts.count;
    return q;
  }
  delete(opts = {}) {
    const q = this._q('delete');
    if (opts.count) q.countMode = opts.count;
    return q;
  }
}

// ─── rpc ─────────────────────────────────────────────────────────

class RpcQuery extends Thenable {
  constructor(ctx, name, params) {
    super();
    this.ctx = ctx;
    this.name = name;
    this.params = params || {};
    this.limitRows = null;
    this.offsetRows = 0;
    this.singleMode = null;
  }
  range(from, to) { this.offsetRows = Number(from); this.limitRows = Number(to) - Number(from) + 1; return this; }
  limit(n) { this.limitRows = Number(n); return this; }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }

  async _execute() {
    quoteIdent(this.name);
    const given = Object.entries(this.params).filter(([, v]) => v !== undefined);
    given.forEach(([k]) => quoteIdent(k));
    const overloads = await this.ctx.meta.functionOverloads(this.name);
    const names = given.map(([k]) => k);
    // PostgREST 처럼 인자 이름으로 고른다: 준 이름이 전부 있고, 기본값 없는 인자는 전부 받은 것.
    const fn = overloads.find(o => names.every(n => o.args.some(a => a.name === n))
      && o.args.every(a => a.hasDefault || names.includes(a.name)));
    if (!fn) {
      return errorResult(new AdapterError(
        `Could not find the function public.${this.name}(${names.join(', ')}) in the schema cache`,
        'PGRST202', null, null), 404);
    }
    const args = [];
    const argSql = given.map(([k, v]) => {
      const decl = fn.args.find(a => a.name === k);
      const json = /^jsonb?$/.test(decl.type);
      args.push(json ? (v === null ? null : JSON.stringify(v)) : writeValue(v, null));
      return `${quoteIdent(k)} => $${args.length}::${decl.type}`;
    }).join(', ');
    const call = `public.${quoteIdent(this.name)}(${argSql})`;
    let text = fn.returns === 'scalar' || fn.returns === 'void'
      ? `SELECT ${call} AS value`
      : `SELECT * FROM ${call}`;
    if (fn.retset) {
      const limit = this.limitRows == null ? MAX_ROWS : Math.min(this.limitRows, MAX_ROWS);
      if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(this.offsetRows) || this.offsetRows < 0) {
        throw new AdapterError('Invalid RPC range', 'PGRST103');
      }
      args.push(limit); text += ` LIMIT $${args.length}`;
      if (this.offsetRows) { args.push(this.offsetRows); text += ` OFFSET $${args.length}`; }
    }
    const r = await this.ctx.exec.query(text, args);
    let data;
    if (fn.returns === 'rows') data = r.rows;
    else if (fn.returns === 'scalars') data = r.rows.map(row => row[Object.keys(row)[0]]);
    else if (fn.returns === 'void') data = null;
    else if (fn.returns === 'row') data = r.rows[0] || null;
    else data = r.rows.length ? r.rows[0].value : null;
    if (this.singleMode && Array.isArray(data)) {
      const shaped = shapeSingle(data, this.singleMode);
      if (shaped.error) return { success: false, error: shaped.error, data: null, count: null, status: 406, statusText: 'Not Acceptable' };
      data = shaped.data;
    }
    return okResult(data, null, fn.returns === 'void' ? 204 : 200, fn.returns === 'void' ? 'No Content' : 'OK');
  }
}

// ─── 클라이언트 ───────────────────────────────────────────────────

/**
 * @param {object} [options]
 *   query(text, values)   테스트용 실행기. 주면 Pool 을 만들지 않는다.
 *   transaction(fn)       테스트용. 없으면 query 를 BEGIN/COMMIT 없이 그대로 쓴다.
 *   meta                  테스트용 메타데이터 { tables: { name: {columns, primaryKey} }, functions: { name: [...] } }
 */
function createClient(options = {}) {
  const exec = options.query
    ? {
      query: options.query,
      transaction: options.transaction || (fn => fn(options.query))
    }
    : poolExecutor();
  const ctx = { exec, meta: createMetaCache(exec, options.meta) };
  return {
    from(table) { return new TableRef(ctx, table); },
    rpc(name, params) { return new RpcQuery(ctx, name, params); },
    async close() {
      if (!options.query && pool) {
        const p = pool;
        pool = null;
        await p.end();
      }
    }
  };
}

let shared = null;
function sharedClient() {
  if (!shared) shared = createClient();
  return shared;
}

module.exports = {
  createClient,
  // api/_supabase.js 가 쓰는 공유 클라이언트(공유 Pool·메타데이터 캐시). 첫 사용 때 만든다.
  client: new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      const c = sharedClient();
      const v = c[prop];
      return typeof v === 'function' ? v.bind(c) : v;
    }
  }),
  _internal: { isoTimestamp, toNumberish, likePattern, splitTopLevel, parseList, TEXT_PARSERS, MAX_ROWS, postgrestTypes }
};
