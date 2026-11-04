'use strict';
const { applyCors, readBody, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { createEngine } = require('./_ai-v3-core');
const { makeOpenAiAdapter } = require('./_ai-v3-openai');

async function handler(req, res, deps = {}) {
  if (!applyCors(req, res, 'private')) return;
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Explicit opt-in only: branch previews stay OFF until intentionally configured.
  if (process.env.ENABLE_AI_V3 !== '1' && !deps.testMode)
    return res.status(404).json({ error: 'Not enabled' });
  if (!guard(req, res, { name: 'ai-v3', limit: 12, windowMs: 60000 })) return;
  const body = readBody(req);
  if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 800)
    return res.status(400).json({ error: 'Invalid message' });
  try {
    const adapter = deps.adapter || makeOpenAiAdapter();
    const searchProducts = deps.searchProducts || (async query => {
      const { searchCatalog } = require('./_ai-v3-catalog');
      return searchCatalog(query, { liveSearch: async keyword => {
        const { searchAll } = require('./_shop');
        return searchAll(keyword, {
          coupangLimit: 6, adpickLimit: 8,
          coupangOpts: { source: 'ai', maxWaitMs: 1500 },
          adpickOpts: { source: 'ai' }, identityQuery: keyword
        });
      } });
    });
    const result = await createEngine({ ...adapter, searchProducts }, body);
    return res.status(result.status).json(result);
  } catch (e) {
    // Never return provider errors, model outputs, stack traces, or secrets.
    console.error('[ai-v3] Request failed:', e.message);
    return res.status(503).json({ error: '지금은 상품 추천을 완료할 수 없어요. 잠시 후 다시 시도해 주세요.' });
  }
}
module.exports = (req, res) => handler(req, res);
module.exports._handler = handler;
