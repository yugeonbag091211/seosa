'use strict';

/*
 * One failure taxonomy for the query ledger, daily product progress, providers and SQL.
 *
 * Request level (a provider search):
 *   RATE_LIMIT     429, provider/DB/run/day budget, minute quota, call gap
 *   NETWORK_ERROR  DNS, connection reset, fetch failed — a request left the process
 *   TIMEOUT        abort/timeout, HTTP 408/504
 *   AUTH_ERROR     401/403, missing/invalid credentials, access-denied page
 *   SOURCE_ERROR   provider 5xx, unparsable body, other provider-side failure
 *   INVALID_PRODUCT empty/invalid query, provider parameter error (HTTP 400, rCode=400)
 *   NO_RESULT      the provider answered normally with zero items
 *   UNKNOWN        anything unclassified
 * Product level (a target evaluated against a real response) adds:
 *   NO_MATCH       the response had items, none with the target product ID
 *   OPTION_MISMATCH the product page was present without the tracked option (vendorItemId)
 *   AMBIGUOUS_MATCH reserved: the exact-ID matcher never guesses between candidates
 *   WRITE_REJECTED matched, but price_history did not confirm the write (integrity guard/DB)
 *
 * The SQL migration repeats QUERY_RETRYABLE and PRODUCT_TERMINAL; a test compares them.
 */
const REASONS = Object.freeze(['RATE_LIMIT', 'NETWORK_ERROR', 'TIMEOUT', 'NO_RESULT', 'NO_MATCH',
  'AMBIGUOUS_MATCH', 'OPTION_MISMATCH', 'INVALID_PRODUCT', 'AUTH_ERROR', 'SOURCE_ERROR',
  'WRITE_REJECTED', 'UNKNOWN']);
const REASON_SET = new Set(REASONS);

// A failed request for these may be repeated once per query/day after a backoff.
const QUERY_RETRYABLE = Object.freeze(['RATE_LIMIT', 'NETWORK_ERROR', 'TIMEOUT', 'SOURCE_ERROR', 'UNKNOWN']);
// The request failed without a response: counts against the product's transient retry cap.
const TRANSIENT = QUERY_RETRYABLE;
// No further search for the product on this KST day.
const PRODUCT_TERMINAL = Object.freeze(['INVALID_PRODUCT', 'AUTH_ERROR', 'WRITE_REJECTED']);
// At most one alternate query after the first such evaluation.
const ALTERNATE_LIMITED = Object.freeze(['OPTION_MISMATCH', 'AMBIGUOUS_MATCH']);

const RETRY_POLICY = Object.freeze({
  RATE_LIMIT: 'no immediate repeat; wait for next_retry_at / next run; max 2 requests per query/day',
  NETWORK_ERROR: 'retry after >=2 min backoff; max 2 requests per query/day, 3 transient failures per product/day',
  TIMEOUT: 'retry after >=2 min backoff; max 2 requests per query/day, 3 transient failures per product/day',
  AUTH_ERROR: 'never repeated today (query and product)',
  SOURCE_ERROR: 'retry after >=2 min backoff; max 2 requests per query/day',
  UNKNOWN: 'retry after >=2 min backoff; max 2 requests per query/day',
  NO_RESULT: 'same query never repeated today; alternate queries only through the bounded recovery ladder',
  NO_MATCH: 'same query never repeated today; alternate queries only through the bounded recovery ladder',
  OPTION_MISMATCH: 'same query never repeated today; at most 1 alternate query',
  AMBIGUOUS_MATCH: 'same query never repeated today; at most 1 alternate query',
  INVALID_PRODUCT: 'never searched again today',
  WRITE_REJECTED: 'never searched again today'
});

const has = (list, reason) => list.indexOf(reason) > -1;
const isRetryable = reason => has(QUERY_RETRYABLE, reason);
const isTransient = reason => has(TRANSIENT, reason);
const isProductTerminal = reason => has(PRODUCT_TERMINAL, reason);
const isAlternateLimited = reason => has(ALTERNATE_LIMITED, reason);

const RATE_TEXT = /\b429\b|too many requests|rate.?limit|throttl|quota|budget|분당|전역 제한|호출 간격|간격 제한|사용 횟수|예산|한도|상한/i;
const AUTH_TEXT = /환경변수 없음|키 미설정|키 없음|api.?key|unauthori[sz]ed|forbidden|credential|access.?denied|인증|권한|접근 차단|접근 거부/i;

/** HTTP status → reason. `text` decides 401/403 bodies that explicitly name a rate limit. */
function fromHttpStatus(status, text = '') {
  const s = Number(status);
  if (!Number.isInteger(s) || s < 400) return null;
  if (s === 401 || s === 403) return RATE_TEXT.test(text) ? 'RATE_LIMIT' : 'AUTH_ERROR';
  if (s === 429) return 'RATE_LIMIT';
  if (s === 408 || s === 504) return 'TIMEOUT';
  if (s === 400) return 'INVALID_PRODUCT';
  return 'SOURCE_ERROR';
}

/**
 * Classify a provider result, collector result or reason string.
 * Typed `failureReason` wins when valid; otherwise the message is parsed.
 * Returns null for a successful non-empty result.
 */
function classify(input) {
  const obj = input && typeof input === 'object' ? input : { error: input };
  if (obj.failureReason != null && obj.failureReason !== '') {
    return REASON_SET.has(obj.failureReason) ? obj.failureReason : 'UNKNOWN';
  }
  const message = String(obj.error || obj.reason || '');
  if (!message) return (obj.items || []).length ? null : 'NO_RESULT';
  const status = /(?:API|HTTP)\s*(\d{3})\b/i.exec(message) || /rCode\s*=\s*(\d{3})\b/i.exec(message);
  if (status) return fromHttpStatus(status[1], message);
  if (/OPTION_MISMATCH|RESPONSE_VID_MISSING|TARGET_VID_UNKNOWN/.test(message)) return 'OPTION_MISMATCH';
  if (/AMBIGUOUS/.test(message)) return 'AMBIGUOUS_MATCH';
  if (/NO_PRODUCT_MATCH|NO_MATCH/.test(message)) return 'NO_MATCH';
  if (/WRITE_REJECTED/.test(message)) return 'WRITE_REJECTED';
  if (/NO_TARGET_ID|NO_PRICE|INVALID_PRODUCT|키워드 없음|검색어 없음|파라미터 오류/.test(message)) return 'INVALID_PRODUCT';
  if (RATE_TEXT.test(message)) return 'RATE_LIMIT';
  if (AUTH_TEXT.test(message)) return 'AUTH_ERROR';
  if (/시간 초과|timeout|timed out|AbortError/i.test(message)) return 'TIMEOUT';
  if (/네트워크|network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) return 'NETWORK_ERROR';
  if (/NO_RESULT|검색 결과가 없|no.?result/i.test(message)) return 'NO_RESULT';
  if (/파싱|JSON|응답|차단|중단|blocked|unavailable/i.test(message)) return 'SOURCE_ERROR';
  return 'UNKNOWN';
}

module.exports = { REASONS, QUERY_RETRYABLE, TRANSIENT, PRODUCT_TERMINAL, ALTERNATE_LIMITED, RETRY_POLICY,
  classify, fromHttpStatus, isRetryable, isTransient, isProductTerminal, isAlternateLimited };
