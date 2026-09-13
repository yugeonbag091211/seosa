'use strict';

/**
 * Supabase / PostgREST 오류 분류 — «표가 없다» 와 «지금 DB 가 느리다·안 된다» 를 가른다.
 *
 * ── 왜 필요한가 (2026-09-13 전수 감사) ────────────────────────────
 *
 * 여러 모듈이 /schema cache|does not exist/ 한 줄로 «마이그레이션 전» 을 판정했다.
 * 그런데 PostgREST 는 DB 에 잠깐 붙지 못할 때도 같은 낱말을 쓴다.
 *
 *   PGRST002  "Could not query the database for the schema cache. Retrying."  (503, 일시 장애)
 *   PGRST205  "Could not find the table 'public.x' in the schema cache"      (표 없음)
 *
 * 일시 장애를 «표 없음» 으로 읽으면
 *   · 가격 수집기가 "price_job_state 테이블이 없습니다" 로 멈춘다 (재시도 대신 마이그레이션 안내)
 *   · 쿠팡 전역 호출 카운터 · 인증 시도 RPC · 컬럼 플래그가 프로세스가 끝날 때까지 꺼진다
 *
 * ── 분류 ──────────────────────────────────────────────────────────
 *   TABLE_MISSING / COLUMN_MISSING / FUNCTION_MISSING   영구. 마이그레이션 안내 대상
 *   CONFIG_MISSING                                      환경변수 누락. 영구
 *   DB_TIMEOUT                                          게이트웨이·문장 타임아웃. 일시
 *   DB_UNAVAILABLE                                      연결 실패 · 5xx · 스키마 캐시 재적재 중. 일시
 *   UNKNOWN                                             그 밖. «없다» 고 단정하지 않는다
 */

const KIND = Object.freeze({
  TABLE_MISSING: 'TABLE_MISSING',
  COLUMN_MISSING: 'COLUMN_MISSING',
  FUNCTION_MISSING: 'FUNCTION_MISSING',
  CONFIG_MISSING: 'CONFIG_MISSING',
  DB_TIMEOUT: 'DB_TIMEOUT',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN'
});

const MISSING = new Set([KIND.TABLE_MISSING, KIND.COLUMN_MISSING, KIND.FUNCTION_MISSING]);

function partsOf(err) {
  if (err == null) return { message: '', code: '' };
  if (typeof err === 'string') return { message: err, code: '' };
  return {
    message: String(err.message || err.details || err.hint || ''),
    code: String(err.code || '')
  };
}

function kindOf(message, code) {
  const m = message;
  if (!m && !code) return KIND.UNKNOWN;

  // ★ 일시 장애를 먼저 본다 — PGRST002 문구에도 "schema cache" 가 들어 있다.
  if (/^PGRST00[0-3]$/.test(code)
    || /could not query the database|schema cache.*retrying|too many connections|remaining connection slots|connection (?:to the database )?(?:refused|terminated|reset)/i.test(m)) {
    return KIND.DB_UNAVAILABLE;
  }
  if (code === '57014'
    || /gateway time-?out|\b504\b|statement timeout|canceling statement due to|timed? ?out|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT/i.test(m)) {
    return KIND.DB_TIMEOUT;
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network ?error|\b50[023]\b|bad gateway|service unavailable|error code: 52\d|<html/i.test(m)) {
    return KIND.DB_UNAVAILABLE;
  }
  if (/환경변수 누락|SUPABASE_(?:URL|SECRET_KEY)/.test(m)) return KIND.CONFIG_MISSING;

  if (code === 'PGRST205' || code === '42P01'
    || /could not find the table|relation "?[\w.]+"? does not exist/i.test(m)) {
    return KIND.TABLE_MISSING;
  }
  if (code === 'PGRST204' || code === '42703'
    || /could not find the '?[\w.]+'? column|column "?[\w.]+"? (?:of relation "?[\w.]+"? )?does not exist/i.test(m)) {
    return KIND.COLUMN_MISSING;
  }
  if (code === 'PGRST202' || code === '42883'
    || /could not find the function|function "?[\w.]+"?(?:\(.*\))? does not exist/i.test(m)) {
    return KIND.FUNCTION_MISSING;
  }
  return KIND.UNKNOWN;
}

/**
 * @param {Error|{message?:string, code?:string}|string|null} err
 * @returns {{kind:string, transient:boolean, missing:boolean, message:string}}
 */
function classifyDbError(err) {
  const { message, code } = partsOf(err);
  const kind = kindOf(message, code);
  return {
    kind,
    transient: kind === KIND.DB_TIMEOUT || kind === KIND.DB_UNAVAILABLE,
    missing: MISSING.has(kind),
    message
  };
}

const isTransientDbError = err => classifyDbError(err).transient;
const isMissingTable = err => classifyDbError(err).kind === KIND.TABLE_MISSING;
const isMissingColumn = err => classifyDbError(err).kind === KIND.COLUMN_MISSING;
const isMissingFunction = err => classifyDbError(err).kind === KIND.FUNCTION_MISSING;
const isMissingObject = err => classifyDbError(err).missing;

/**
 * 일시 장애만 다시 시도한다. fn 은 supabase 응답({data, error})을 돌려준다.
 * 영구 오류·성공·마지막 시도는 그대로 돌려준다 — 판정은 호출부가 한다.
 *
 * @param {(attempt:number)=>Promise<{data?:any, error?:any}>} fn
 * @param {{attempts?:number, baseDelayMs?:number, sleep?:(ms:number)=>Promise<void>, onRetry?:Function}} [opts]
 */
async function withDbRetry(fn, opts) {
  const o = opts || {};
  const attempts = Math.max(1, o.attempts || 3);
  const base = o.baseDelayMs == null ? 1000 : o.baseDelayMs;
  const sleep = o.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await fn(attempt);
    const error = last && last.error;
    if (!error) return last;
    const info = classifyDbError(error);
    if (!info.transient || attempt === attempts) return last;
    if (typeof o.onRetry === 'function') o.onRetry(info, attempt);
    await sleep(base * Math.pow(3, attempt - 1));
  }
  return last;
}

module.exports = {
  KIND, classifyDbError, isTransientDbError,
  isMissingTable, isMissingColumn, isMissingFunction, isMissingObject, withDbRetry
};
