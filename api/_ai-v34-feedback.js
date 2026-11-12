'use strict';
// AI v3.4 — minimal, de-identified retrieval-failure signals (feedback loop).
//
// When a user rejects a recommendation or asks again («이거 말고», «다른 거»,
// «다시 찾아줘»), the route may store ONE small record about the PREVIOUS
// turn. Privacy by construction — the record is built from server state and
// counters, never from the raw message:
//   * no message text, no answer, no card title / product ID / price / link;
//   * no account id, IP or user agent; the session key is an HMAC that rotates
//     daily (records of different days cannot be linked);
//   * terms = only tokens on a versioned whitelist (known brand names, lexicon
//     synonym keys, strict model-code shapes such as "g304", "wh1000xm5").
// Default OFF (AI_V34_FEEDBACK_ENABLED=1), never in read-only mode, and the
// engine/catalog/lexicon are NEVER changed from these records automatically:
// scripts/ai-v34/propose-lexicon.js only writes a review queue for a human.
const crypto = require('node:crypto');
const { BRANDS } = require('./_ai-v32-brands');
const { SYNONYMS, LEXICON_VERSION, modelCodes } = require('./_ai-v34-text');

const SCHEMA = 'ai-v34-feedback/1';
const SIGNALS = new Set(['reject', 'retry', 'refine', 'report']);
const CATEGORIES = new Set(['노트북', '태블릿', '스마트폰', '이어폰', '헤드폰', '마우스', '키보드', '모니터', '스피커', '시계', '공기청정기', '청소기', '외장하드', '기타']);
const REASON_KEYS = new Set(['invalid_listing', 'accessory_not_requested', 'wrong_category', 'used_not_requested', 'identity_mismatch',
  'identity_unverified', 'compatibility_unverified', 'wrong_brand', 'wrong_merchant', 'wrong_model', 'excluded', 'below_min_price',
  'over_budget', 'duplicate', 'stale_price', 'price_time_unknown', 'price_outlier_low', 'wrong_comparison_subject',
  'publication_not_device', 'carrier_contract_price', 'mixed_or_bundle_listing', 'implausible_device_price', 'color_unverified']);
const NO_RESULT = new Set(['stale_price_only', 'provider_unavailable_db_checked', 'no_verified_match', 'nothing_displayed']);
const STRATEGIES = new Set(['db-first', 'live-first', 'hybrid']);
const BRAND_WORDS = new Map(BRANDS.flatMap(([canonical, company]) => company.map(a => [a.normalize('NFKC').toLowerCase(), canonical])));

// From the user's words, only the KIND of feedback is kept.
function feedbackSignal(message) {
  const s = String(message || '');
  if (/(?:신고|잘못된\s*상품|가짜|틀린\s*가격|가격이\s*(?:달라|틀려|다르))/.test(s)) return 'report';
  if (/(?:이거|이건|그거|이것|저거)\s*(?:말고|빼고|별로|아니)|마음에\s*안\s*들|별로(?:야|예요|네)|아닌\s*것\s*같/.test(s)) return 'reject';
  if (/(?:다른\s*(?:거|것|상품|제품)|다시\s*(?:찾|추천|보여)|더\s*(?:보여|찾아|추천))/.test(s)) return 'retry';
  if (/(?:그중|이\s*중|위에서|조건\s*바꿔|더\s*(?:싼|저렴|가벼운|작은|큰))/.test(s)) return 'refine';
  return null;
}
function kstDay(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 10); }
function whitelistedTerms(text) {
  const out = new Set();
  const s = String(text || '').normalize('NFKC').toLowerCase();
  // (fast-check, seed 20261140: «HP» produced 'brand:HP', which the shape check
  // then refused — canonical names are normalized to lower-case tokens)
  for (const [alias, canonical] of BRAND_WORDS) if (alias.length >= 2 && s.includes(alias))
    out.add('brand:' + canonical.normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, ''));
  for (const [canonical, aliases] of SYNONYMS) if (aliases.some(a => s.replace(/\s/g, '').includes(a.replace(/\s/g, '')))) out.add('syn:' + canonical);
  for (const code of modelCodes(s)) if (/^[a-z]{1,6}\d{1,5}[a-z]{0,4}$|^\d{1,3}[a-z]{1,3}\d{2,4}[a-z]{0,3}$/.test(code) && !/^\d{6,}/.test(code)) out.add('model:' + code);
  return [...out].slice(0, 8);
}
function buildFailureRecord({ signal, state = {}, stats = {}, strategy = 'db-first', sessionId, secret, now = Date.now() } = {}) {
  if (!SIGNALS.has(signal)) throw new Error('unknown feedback signal');
  if (!secret || String(secret).length < 16) throw new Error('a server-side HMAC secret (>=16 chars) is required');
  const day = kstDay(now);
  const sessionHash = crypto.createHmac('sha256', String(secret)).update(String(sessionId || 'anonymous') + '|' + day).digest('hex').slice(0, 16);
  const kinds = [];
  if (state.maxPrice != null || state.minPrice != null) kinds.push('budget');
  if (state.brandTerm) kinds.push('brand');
  if (state.modelText || (state.identity && Object.keys(state.identity).length)) kinds.push('model');
  if (Array.isArray(state.exclusions) && state.exclusions.length) kinds.push('exclusion');
  if (state.allowUsed) kinds.push('used');
  for (const f of ['wireless', 'anc', 'externalSsd', 'gaming']) if (state.features && state.features[f]) kinds.push('feature:' + f);
  const reasons = {};
  for (const [k, v] of Object.entries(stats.rejectedReasons || {})) if (REASON_KEYS.has(k) && Number.isSafeInteger(v) && v >= 0) reasons[k] = Math.min(v, 999);
  return {
    schema: SCHEMA, day, signal, sessionHash,
    strategy: STRATEGIES.has(strategy) ? strategy : 'db-first',
    category: CATEGORIES.has(state.category) ? state.category : null,
    cardCount: Math.max(0, Math.min(4, Number(stats.chosen) || 0)),
    noResult: NO_RESULT.has(stats.noResult) ? stats.noResult : null,
    constraintKinds: kinds,
    rejectedReasons: reasons,
    terms: whitelistedTerms([state.lastQuery, state.brandTerm, state.modelText].filter(Boolean).join(' ')),
    lexiconVersion: LEXICON_VERSION
  };
}
const ALLOWED_KEYS = ['schema', 'day', 'signal', 'sessionHash', 'strategy', 'category', 'cardCount', 'noResult', 'constraintKinds',
  'rejectedReasons', 'terms', 'lexiconVersion'];
// Independent re-check before anything is written (defence in depth).
function assertSafeRecord(rec) {
  const keys = Object.keys(rec || {});
  if (keys.some(k => !ALLOWED_KEYS.includes(k))) throw new Error('unexpected field in feedback record');
  const text = JSON.stringify(rec);
  if (text.length > 1200) throw new Error('feedback record too large');
  // server-generated fields are checked by shape (fast-check seed 20261140: a hex
  // HMAC containing «010…» was mistaken for a phone number)
  if (!/^[0-9a-f]{16}$/.test(String(rec.sessionHash || ''))) throw new Error('bad session hash');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.day || ''))) throw new Error('bad day');
  const { sessionHash, day, category, lexiconVersion, ...rest } = rec;
  if (/(?:@|https?:|\d{9,}|010[-\s]?\d{3,4}|[가-힣]{2,}\s[가-힣]{2,}\s[가-힣]{2,})/.test(JSON.stringify(rest)))
    throw new Error('feedback record contains free text, contact data or long digit runs');
  for (const t of rec.terms || []) if (!/^(?:brand|syn|model):[0-9a-z가-힣]{1,24}$/.test(t)) throw new Error('term outside whitelist shape');
  return true;
}
// query(text, values): a parameterized SQL executor on the ISOLATED feedback
// database (ai_v34 schema from db/isolated/2026-11-12-ai-v34-pgvector.sql).
async function recordFeedback(query, rec, env = process.env) {
  if (env.AI_V34_FEEDBACK_ENABLED !== '1') return { stored: false, reason: 'disabled' };
  if (env.SEOSA_DB_READONLY === '1') return { stored: false, reason: 'read_only' };
  assertSafeRecord(rec);
  try {
    await query('insert into ai_v34.retrieval_feedback (day, signal, session_hash, strategy, category, card_count, no_result, ' +
      'constraint_kinds, rejected_reasons, terms, lexicon_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)',
    [rec.day, rec.signal, rec.sessionHash, rec.strategy, rec.category, rec.cardCount, rec.noResult, rec.constraintKinds,
      JSON.stringify(rec.rejectedReasons), rec.terms, rec.lexiconVersion]);
    return { stored: true };
  } catch { return { stored: false, reason: 'db_error' }; }
}
module.exports = { feedbackSignal, buildFailureRecord, assertSafeRecord, recordFeedback, whitelistedTerms, kstDay, SCHEMA };
