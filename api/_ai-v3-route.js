'use strict';
const { applyCors, readBody, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { createEngine } = require('./_ai-v3-core');
const { makeOpenAiAdapter } = require('./_ai-v3-openai');
const crypto = require('crypto');
const { identify } = require('./_auth');
const { profileUserId } = require('./_ai-v3-user-id');
const monitor = require('./_ai-v3-monitor');
const { normalizeV3History } = require('./_ai-v3-history');
const AC = require('./_aicontext');
function userIdentity(req) {
  const who = identify(req);
  return who.ok ? profileUserId(who.email) : '';
}
function assigned(id, value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  if (!id || !percent) return false;
  return crypto.createHash('sha256').update('seosa-v3-rollout:' + id).digest().readUInt32BE(0) / 0x100000000 * 100 < percent;
}
/*
 * x-ai-v3-gate — 이 응답을 왜 v3 / legacy 가 냈는지 (2026-11-14). 내용 없는 짧은 낱말만 싣는다.
 *   off                 ENABLE_AI_V3 가 1 이 아니다
 *   not_assigned        롤아웃 비율 밖의 사용자·세션
 *   monitor_unavailable 회로 측정 표를 못 읽는다(운영 11-14: ai_v3_monitor_events 표 없음) — fail-closed
 *   circuit_open        최근 5분 v3 오류율 10% 초과
 *   engine_error        v3 가 예외 → legacy 로 답함
 *   engine_status_5xx   v3 가 5xx → legacy 로 답함
 *   served              v3 가 답함
 * 하네스(scripts/test-100-questions.js)는 이 값으로 «v3 를 시험했는가» 와 «legacy 폴백이 동작했는가» 를 가른다.
 */
async function legacy(req, res, deps, gate) {
  res.setHeader('x-ai-version', 'legacy');
  if (gate) res.setHeader('x-ai-v3-gate', gate);
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
    let gate = 'off';
    if (process.env.ENABLE_AI_V3 === '1') {
      if (!choose(userId || sessionId, process.env.AI_V3_ROLLOUT_PERCENT)) gate = 'not_assigned';
      else {
        let verdict;
        try {
          verdict = typeof circuit.check === 'function' ? await circuit.check()
            : { ok: await circuit.healthy(), reason: 'circuit_open' };
        } catch (_) { verdict = { ok: false, reason: 'monitor_unavailable' }; }
        gate = verdict && verdict.ok ? 'open' : ((verdict && verdict.reason) || 'circuit_open');
      }
    }
    if (gate !== 'open') return legacy(req, res, deps, gate);
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
    // 대화 기록 계약 (api/_ai-v3-history.js): chatHistory(웹·앱) 또는 history 를 하나로, 서명된
    // assistant 발화만 assistant 로, 이번 질문 중복은 뺀다.
    const conversation = normalizeV3History(body, message);
    const result = await createEngine({ ...adapter, searchProducts, loadDisplayed, userId },
      { ...body, message, history: conversation.history });
    const ok = result.status < 500;
    /*
     * 회로 기록 실패가 «좋은 v3 답» 을 버리게 하지 않는다 (2026-11-14). 예전에는 기록을 못 하면
     * 이미 받은 답을 버리고 legacy 를 한 번 더 불러 비용·시간이 두 배였다. 기록 실패는 다음 요청의
     * check() 가 monitor_unavailable 로 v3 를 닫으므로(fail-closed) 회로 안전은 그대로다.
     */
    if (!deps.testMode) { try { await circuit.record('v3', ok); } catch (_) {} }
    if (!ok) return legacy(req, res, deps, 'engine_status_' + (Number(result.status) || 500));
    if (typeof result.answer === 'string' && result.answer) {
      // legacy 와 같은 답변 서명 — 웹·앱이 기록에 저장했다가 돌려주면 다음 질문에서 assistant 로 인정된다.
      const sig = AC.signTurn(result.answer);
      if (sig) result.turnSig = sig;
    }
    result.stats = { ...(result.stats || {}), conversation: conversation.stats };
    res.setHeader('x-ai-version', 'v3');
    res.setHeader('x-ai-v3-gate', 'served');
    return res.status(result.status).json(result);
  } catch (e) {
    // Never return provider errors, model outputs, stack traces, or secrets.
    console.error('[ai-v3] Request failed:', e.message);
    if (!deps.testMode) { try { await circuit.record('v3', false); } catch (_) {} return legacy(req, res, deps, 'engine_error'); }
    return res.status(503).json({ error: '지금은 상품 추천을 완료할 수 없어요. 잠시 후 다시 시도해 주세요.' });
  }
}
module.exports = (req, res) => handler(req, res);
module.exports._handler = handler;

module.exports._assigned = assigned;
