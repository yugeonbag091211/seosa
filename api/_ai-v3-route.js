'use strict';
const { applyCors, readBody, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { createEngine } = require('./_ai-v3-core');
const { makeOpenAiAdapter } = require('./_ai-v3-openai');
const crypto = require('crypto');
const { identify } = require('./_auth');
const { profileUserId } = require('./_ai-v3-user-id');
const monitor = require('./_ai-v3-monitor');
function userIdentity(req) {
  const who = identify(req);
  return who.ok ? profileUserId(who.email) : '';
}
function assigned(id, value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  if (!id || !percent) return false;
  return crypto.createHash('sha256').update('seosa-v3-rollout:' + id).digest().readUInt32BE(0) / 0x100000000 * 100 < percent;
}
async function legacy(req, res, deps) {
  res.setHeader('x-ai-version', 'legacy');
  const legacyReq = Object.create(req);
  legacyReq.query = { ...(req.query || {}) };
  delete legacyReq.query.v;
  const incoming = readBody(req);
  legacyReq.body = { ...incoming, question: incoming.question || incoming.message };
  const handler = deps.legacyHandler || require('./ai');
  try {
    const result = await handler(legacyReq, res);
    console.log(JSON.stringify({ event: 'ai_request', version: 'legacy', success: (res.statusCode || 200) < 500 }));
    return result;
  } catch (e) {
    console.log(JSON.stringify({ event: 'ai_request', version: 'legacy', success: false }));
    throw e;
  }
}

async function handler(req, res, deps = {}) {
  if (!applyCors(req, res, 'private')) return;
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = readBody(req);
  const userId = userIdentity(req);
  const sessionId = typeof body.sessionId === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(body.sessionId) ? body.sessionId : '';
  const choose = deps.assigned || assigned;
  const circuit = deps.monitor || monitor;
  if (!deps.testMode) {
    let healthy = false;
    if (process.env.ENABLE_AI_V3 === '1' && choose(userId || sessionId, process.env.AI_V3_ROLLOUT_PERCENT)) {
      try { healthy = await circuit.healthy(); } catch (_) { healthy = false; }
    }
    if (!healthy) return legacy(req, res, deps);
  }
  res.setHeader('x-ai-version', 'v3');
  if (!guard(req, res, { name: 'ai-v3', limit: 12, windowMs: 60000 })) return;
  const message = typeof body.message === 'string' ? body.message : body.question;
  if (typeof message !== 'string' || !message.trim() || message.length > 800)
    return res.status(400).json({ error: 'Invalid message' });
  try {
    const adapter = deps.adapter || makeOpenAiAdapter();
    // v3.4 feature flag: db-first (default) | live-first | hybrid. The vector
    // channel exists only for hybrid with an isolated vector DB configured.
    const { parseStrategy, vectorRuntime } = require('./_ai-v34-strategy');
    const searchStrategy = parseStrategy(process.env.AI_V3_SEARCH_STRATEGY);
    const vector = searchStrategy === 'hybrid' ? vectorRuntime() : { vectorSearch: undefined };
    const searchProducts = deps.searchProducts || (async (query, { identity, minPrice, maxPrice, category, userText, exclusions } = {}) => {
      const { searchCatalog } = require('./_ai-v3-catalog');
      return searchCatalog(query, { identity, minPrice, maxPrice, category, userText, exclusions,
        searchStrategy, vectorSearch: vector.vectorSearch,
        hybridMode: process.env.AI_V34_HYBRID_MODE === 'fuse' ? 'fuse' : 'expand',
        vectorWeight: Number(process.env.AI_V34_VECTOR_WEIGHT) > 0 ? Number(process.env.AI_V34_VECTOR_WEIGHT) : 1,
        liveSearch: async keyword => {
        const { searchAll } = require('./_shop');
        return searchAll(keyword, {
          coupangLimit: 6, adpickLimit: 8,
          coupangOpts: { source: 'ai', maxWaitMs: 1500 },
          adpickOpts: { source: 'ai' }, identityQuery: keyword
        });
      } });
    });
    // v3.2: "그중 …" follow-ups re-load the displayed cards by ID (read-only).
    const loadDisplayed = deps.loadDisplayed || (async ids =>
      require('./_ai-v3-catalog').loadProductsByIds(ids));
    const result = await createEngine({ ...adapter, searchProducts, loadDisplayed, userId }, { ...body, message });
    const ok = result.status < 500;
    let recorded = !!deps.testMode;
    if (!deps.testMode) { try { recorded = await circuit.record('v3', ok); } catch (_) {} }
    if (!ok || !recorded) return legacy(req, res, deps);
    res.setHeader('x-ai-version', 'v3');
    return res.status(result.status).json(result);
  } catch (e) {
    // Never return provider errors, model outputs, stack traces, or secrets.
    console.error('[ai-v3] Request failed:', e.message);
    if (!deps.testMode) { try { await circuit.record('v3', false); } catch (_) {} return legacy(req, res, deps); }
    return res.status(503).json({ error: '지금은 상품 추천을 완료할 수 없어요. 잠시 후 다시 시도해 주세요.' });
  }
}
module.exports = (req, res) => handler(req, res);
module.exports._handler = handler;

module.exports._assigned = assigned;
