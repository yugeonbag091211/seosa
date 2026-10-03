'use strict';

const crypto = require('crypto');
const { kstDateKey } = require('./_cache-date');
const Failure = require('./_collector-failure');

const MAX_REQUESTS = 2;
const MAX_PAYLOAD_BYTES = 160000;
const RETRY_MS = 2 * 60 * 1000;
// Covers the collector's longest provider slot wait (Coupang 120 s) so a queued claim cannot expire before begin.
const LEASE_SECONDS = 180;
const PROVIDER_QUERY_MAX = 80;
const FIELDS = {
  coupang: ['productId', 'title', 'lprice', 'oprice', 'mall', 'link', 'image', 'itemId', 'vendorItemId', 'isRocket', 'isFreeShipping'],
  adpick: ['title', 'price', 'photo', 'cpCode', 'cpName', 'mallLabel', 'commissionlink']
};

/*
 * Canonical query identity (CANONICAL v1). The SQL claim RPC re-checks the invariants
 * (NFKC, no ASCII upper case, single inner spaces, no edge space) and the SHA-256.
 *   NFKC          full-width ／ compatibility forms → ASCII ("Ｓ２４" = "s24")
 *   ignorables    zero-width space/joiners, soft hyphen, BOM are removed
 *   whitespace    any Unicode space/control run (NBSP, U+3000, tab, NEL) → one space; trimmed
 *   case          lower case
 * Punctuation, digits and Hangul are kept as-is: "A+B" ≠ "A B", "128GB" ≠ "256GB",
 * "버즈3" ≠ "버즈 3". Over-merging would reuse another product's search response.
 */
const IGNORABLE = /[\u00AD\u180E\u200B-\u200D\u2060-\u2064\uFEFF]/gu;
// C0/C1 controls are separators (NEL U+0085 is not in JS \s); SQL rejects them in a canonical query.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu;
function normalizeQuery(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(IGNORABLE, '').replace(CONTROL, ' ')
    .replace(/\s+/gu, ' ').trim().toLowerCase().normalize('NFKC');
}
/** The exact text a provider sends (api/_coupang.js / _adpick.js trim and cap at 80). */
function providerQuery(value) {
  return String(value == null ? '' : value).trim().slice(0, PROVIDER_QUERY_MAX);
}
/** Ledger/progress identity of a keyword as actually sent to the provider. */
function queryIdentity(value) {
  return normalizeQuery(providerQuery(value));
}
function queryHash(value) {
  return crypto.createHash('sha256').update(normalizeQuery(value), 'utf8').digest('hex');
}
function ledgerEnabled(opts = {}) {
  return process.env.PRICE_QUERY_LEDGER === '1'
    && (opts.collectionMode === true || ['collect', 'cron'].includes(opts.source));
}
const failureReason = result => Failure.classify(result);
function validItem(source, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.title !== 'string') return false;
  return source === 'coupang'
    ? !!item.productId && Number.isSafeInteger(item.lprice) && item.lprice > 0 && typeof item.link === 'string'
    : Number.isSafeInteger(item.price) && item.price > 0 && typeof item.commissionlink === 'string' && !!item.commissionlink;
}
function payloadFor(source, result, now) {
  const pick = list => list.map(item => Object.fromEntries(FIELDS[source]
    .filter(field => item[field] !== undefined).map(field => [field, item[field]])));
  const items = result.items || [];
  const allItems = result.allItems || items;
  if (!Array.isArray(items) || !Array.isArray(allItems) || items.length > 20 || allItems.length > 20
      || !items.every(item => validItem(source, item)) || !allItems.every(item => validItem(source, item))) return null;
  const fetchedAt = result.resultFetchedAt || new Date(now).toISOString();
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs) || fetchedMs > now + 1000 || kstDateKey(fetchedMs) !== kstDateKey(now)) return null;
  const payload = { version: 1, source, items: pick(items), allItems: pick(allItems), fetchedAt };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) return null;
  return payload;
}
function validPayload(source, payload, now) {
  if (!payload || payload.version !== 1 || payload.source !== source
      || !Array.isArray(payload.items) || !Array.isArray(payload.allItems) || typeof payload.fetchedAt !== 'string') return false;
  const normalized = payloadFor(source, { items: payload.items, allItems: payload.allItems, resultFetchedAt: payload.fetchedAt }, now);
  return !!normalized;
}
function skip(reason, state, extra = {}) {
  return { items: [], allItems: [], from: 'none', error: reason, blocked: false, apiCalled: false, queryState: state,
    ...extra, failureReason: 'failureReason' in extra ? extra.failureReason : 'SOURCE_ERROR' };
}

function createQueryLedger({ db, clock = Date.now, token = crypto.randomUUID } = {}) {
  if (!db || typeof db.rpc !== 'function') throw new TypeError('query ledger requires db.rpc');
  async function rpc(name, args) {
    const response = await db.rpc(name, args);
    if (response.error) throw new Error('query ledger unavailable'); // DB details can contain credentials.
    return Array.isArray(response.data) ? response.data[0] : response.data;
  }
  /*
   * In-process coalescing: a concurrent caller with the same provider/query identity in this
   * process awaits the first result instead of seeing its own claim as in flight. Across
   * processes the SQL claim decides. The follower never counts as a request.
   */
  const inProcess = new Map();
  async function run(source, keyword, opts, execute) {
    const id = `${source}|${queryIdentity(keyword)}`;
    const leader = inProcess.get(id);
    if (leader) return follow(await leader, opts);
    const p = runOnce(source, keyword, opts, execute);
    inProcess.set(id, p);
    try { return await p; } finally { inProcess.delete(id); }
  }
  function follow(r, opts) {
    if (!r.error && (r.from === 'api' || r.from === 'cache')) {
      return { ...r, items: (r.items || []).slice(0, opts.limit || 20), from: 'cache', apiCalled: false, queryState: 'cached' };
    }
    return { ...r, items: [], allItems: [], apiCalled: false, queryState: r.queryState === 'completed' ? 'shared_failure' : r.queryState };
  }
  async function runOnce(source, keyword, opts, execute) {
    if (!FIELDS[source]) return skip('Unsupported collector source', 'invalid', { failureReason: 'INVALID_PRODUCT' });
    // Providers send at most 80 characters; ledger identity describes the request actually sent.
    const normalized = queryIdentity(keyword);
    if (!normalized) return skip('키워드 없음', 'invalid', { failureReason: 'INVALID_PRODUCT' });
    const hash = queryHash(normalized);
    const claimToken = token();
    let claim;
    const base = { p_source: source, p_normalized_query: normalized, p_query_hash: hash };
    try {
      claim = await rpc('collector_query_claim', { ...base, p_token: claimToken, p_lease_seconds: LEASE_SECONDS });
      if (!claim || !claim.kst_date) return skip('Query ledger unavailable', 'unavailable', { queryHash: hash });
      if (claim.action === 'cached') {
        if (!validPayload(source, claim.result, clock())) {
          // Compare the token of the observed row: another worker's newer valid cache is never invalidated.
          const repaired = await rpc('collector_query_invalidate', {
            p_source: source, p_date: claim.kst_date, p_query_hash: hash, p_token: claim.claim_token
          });
          return skip('Query cache integrity check failed; recovery deferred', 'corrupt', { queryHash: hash,
            failureReason: 'SOURCE_ERROR', nextRetryAt: repaired && repaired.next_retry_at });
        }
        return { items: claim.result.items.slice(0, opts.limit || 20), allItems: claim.result.allItems,
          error: null, from: 'cache', blocked: false, apiCalled: false, queryHash: hash, queryState: 'cached',
          failureReason: claim.result.items.length ? null : 'NO_RESULT', resultFetchedAt: claim.result.fetchedAt };
      }
      // Another worker owns the claim: not a failure of this target, and no request was made.
      if (claim.action === 'inflight') return skip('Query in flight in another collector', 'inflight', {
        queryHash: hash, failureReason: null });
      if (claim.action !== 'claimed') return skip('Query already handled or deferred today', claim.action || 'deferred', {
        queryHash: hash, failureReason: claim.failure_reason || 'UNKNOWN', nextRetryAt: claim.next_retry_at
      });
    } catch (_) { return skip('Query ledger unavailable', 'unavailable', { queryHash: hash, failureReason: null }); }

    const identity = { p_source: source, p_date: claim.kst_date, p_query_hash: hash, p_token: claimToken };
    let begun = false;
    const beforeRequest = async () => {
      if (begun) return false; // one actual fetch per claim, never an in-function retry loop
      try {
        const started = await rpc('collector_query_begin', identity);
        begun = started === true || !!(started && started.started);
        return begun;
      } catch (_) { return false; }
    };
    let result;
    try { result = await execute(beforeRequest); }
    catch (_) {
      result = skip('Collector provider failed', 'provider_error', { failureReason: 'UNKNOWN', apiCalled: begun });
    }
    result.apiCalled = begun; // authoritative: cache/limiter skips cannot claim a request
    const reason = failureReason(result);
    const success = !result.error && (result.from === 'api' || result.from === 'cache');
    const payload = success ? payloadFor(source, result, clock()) : null;
    const finalReason = success && !payload ? 'SOURCE_ERROR' : reason;
    // AUTH_ERROR / INVALID_PRODUCT / NO_RESULT are never retried today; SQL enforces the same list.
    const retryAt = Failure.isRetryable(finalReason) ? new Date(clock() + RETRY_MS).toISOString() : null;
    try {
      const finished = await rpc('collector_query_finish', { ...identity,
        p_status: payload ? 'completed' : (begun ? 'failed' : 'deferred'),
        p_failure_reason: finalReason, p_result: payload, p_next_retry_at: retryAt,
        p_result_count: payload ? payload.allItems.length : 0
      });
      if (!finished) result.ledgerError = 'Query completion not acknowledged';
    } catch (_) { result.ledgerError = 'Query completion not acknowledged'; }
    return { ...result, items: (result.items || []).slice(0, opts.limit || 20),
      failureReason: finalReason, queryHash: hash, queryState: 'completed', nextRetryAt: retryAt };
  }
  return { run };
}

let providerLedger;
function runProviderQuery(source, keyword, opts, execute) {
  if (!ledgerEnabled(opts)) return execute(null);
  if (!providerLedger) providerLedger = createQueryLedger({ db: require('./_supabase') });
  return providerLedger.run(source, keyword, opts, execute);
}

// Called once by an enabled collector run; never by a provider or module import.
// Clears bounded expired cache payloads; query counters/progress/catalog/history are preserved.
async function expireQueryResults({ db = require('./_supabase'), batchSize = 1000 } = {}) {
  const size = Math.max(1, Math.min(1000, Number.isFinite(batchSize) ? Math.floor(batchSize) : 1000));
  const { data, error } = await db.rpc('collector_query_expire_results', { p_batch_size: size });
  if (error || !Number.isInteger(data) || data < 0) throw new Error('Query cache expiry unavailable');
  return data;
}

module.exports = { normalizeQuery, providerQuery, queryIdentity, queryHash, ledgerEnabled, failureReason,
  validPayload, payloadFor, createQueryLedger, runProviderQuery, expireQueryResults,
  MAX_REQUESTS, RETRY_MS, LEASE_SECONDS, MAX_PAYLOAD_BYTES, PROVIDER_QUERY_MAX };
