'use strict';
// Promptfoo provider — ISOLATED Vercel Preview E2E (real GPT, real catalog DB
// of that Preview). NOT run in this session: it needs an isolated Preview
// (separate DB branch + quota store) and the user's go-ahead.
// Refuses to start unless:
//   SEOSA_PREVIEW_URL         https://<preview>.vercel.app (never seosa.ai.kr)
//   VERCEL_PROTECTION_BYPASS  protection-bypass secret (sent as a header, never logged)
//   SEOSA_E2E_COST_CAP_USD    hard cap; each request reserves its worst case first
//   SEOSA_E2E_MAX_REQUESTS    hard request cap
// Multi-turn questions are replayed turn by turn with the returned state.
const path = require('node:path');
const { questions } = require(path.resolve(__dirname, '../../../scripts/ai-v34/eval/questions-v34'));

// gpt-4.1-mini list price per 1M tokens (USD), x2 safety margin in the guard.
const PRICE = { input: 0.4, output: 1.6 };
let spentUsd = 0, requests = 0;
function guard() {
  const url = process.env.SEOSA_PREVIEW_URL || '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!/\.vercel\.app$/.test(host)) throw new Error('SEOSA_PREVIEW_URL must be an isolated *.vercel.app Preview');
  if (/(?:^|\.)seosa\.ai\.kr$/.test(host)) throw new Error('Refusing Production');
  if (!process.env.VERCEL_PROTECTION_BYPASS) throw new Error('VERCEL_PROTECTION_BYPASS required');
  const cap = Number(process.env.SEOSA_E2E_COST_CAP_USD), max = Number(process.env.SEOSA_E2E_MAX_REQUESTS);
  if (!(cap > 0 && cap <= 10)) throw new Error('SEOSA_E2E_COST_CAP_USD must be set (0 < cap <= 10)');
  if (!(max > 0)) throw new Error('SEOSA_E2E_MAX_REQUESTS must be set');
  return { url: url.replace(/\/$/, ''), cap, max };
}
class SeosaPreviewProvider {
  id() { return 'seosa-preview-http'; }
  async callApi(prompt, context) {
    const g = guard();
    const q = questions.find(x => x.id === (context && context.vars && context.vars.question_id));
    if (!q) return { error: 'unknown question' };
    let state = {}, history = [];
    const turns = [], usage = { prompt: 0, completion: 0, total: 0, numRequests: 0 };
    const t0 = Date.now();
    for (const turn of q.turns) {
      const worst = (4000 * PRICE.input + 900 * PRICE.output) / 1e6 * 2;
      if (requests >= g.max || spentUsd + worst > g.cap) return { error: 'E2E budget exhausted (requests ' + requests + ', $' + spentUsd.toFixed(4) + ')' };
      requests++;
      const res = await fetch(g.url + '/api/ai?v=3', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vercel-protection-bypass': process.env.VERCEL_PROTECTION_BYPASS },
        body: JSON.stringify({ message: turn.p, history, state }), signal: AbortSignal.timeout(30000) });
      const body = await res.json().catch(() => ({}));
      const mu = (body.stats && body.stats.modelUsage) || {};
      const inT = Number(mu.inputTokens), outT = Number(mu.outputTokens);
      // unmetered response = charge the worst case (never assumed free)
      spentUsd += Number.isFinite(inT) && Number.isFinite(outT) ? (inT * PRICE.input + outT * PRICE.output) / 1e6 : worst;
      usage.prompt += inT || 0; usage.completion += outT || 0; usage.total += (inT || 0) + (outT || 0); usage.numRequests += Number(mu.calls) || 0;
      turns.push({ status: res.status, answer: body.answer || '', cards: body.cards || [], state: body.state || {}, stats: body.stats || {} });
      state = body.state || state;
      history = [...history, { role: 'user', content: turn.p }, { role: 'assistant', content: String(body.answer || '').slice(0, 500) }].slice(-8);
    }
    return { output: JSON.stringify({ id: q.id, turns }), latencyMs: Date.now() - t0, tokenUsage: usage,
      cost: Math.round(spentUsd * 1e6) / 1e6, metadata: { requestsSoFar: requests, spentUsdSoFar: spentUsd } };
  }
}
module.exports = SeosaPreviewProvider;
