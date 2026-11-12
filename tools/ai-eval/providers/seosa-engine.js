'use strict';
// Promptfoo custom provider — SEOSA AI engine, OFFLINE (frozen snapshot,
// scripted planner, no seller API, no GPT). Returns the RAW turn results;
// grading happens only in the assertions (assertions/judges.js), so the
// provider cannot grade itself.
//   config: { engine: 'v34'|'v33', strategy: 'db-first'|'hybrid' }
//   env:    SEOSA_EVAL_SNAPSHOT, SEOSA_EVAL_PGLITE (hybrid), SEOSA_EVAL_V33_ROOT (v33)
const path = require('node:path');
const { createHarness } = require(path.resolve(__dirname, '../../../scripts/ai-v34/eval/harness'));

const harnesses = new Map();
function harnessFor(config) {
  const key = [config.engine, config.strategy, config.hybridMode || '', config.vectorWeight || ''].join('|');
  if (!harnesses.has(key)) {
    harnesses.set(key, createHarness({ snapshot: process.env.SEOSA_EVAL_SNAPSHOT, engine: config.engine, strategy: config.strategy,
      pglite: process.env.SEOSA_EVAL_PGLITE, v33Root: process.env.SEOSA_EVAL_V33_ROOT, set: process.env.SEOSA_EVAL_SET || 'main',
      hybridMode: config.hybridMode || 'expand', vectorWeight: Number(config.vectorWeight || 1) }));
  }
  return harnesses.get(key);
}
const slimCard = c => ({ productId: c.productId, title: c.title, price: c.price, link: c.link, condition: c.condition,
  budgetStatus: c.budgetStatus, priceFreshness: c.priceFreshness, priceAgeDays: c.priceAgeDays });

class SeosaEngineProvider {
  constructor(options = {}) {
    this.config = { engine: 'v34', strategy: 'db-first', ...(options.config || {}) };
    this.label = options.label;
  }
  id() { return 'seosa-engine:' + this.config.engine + ':' + this.config.strategy; }
  async callApi(prompt, context) {
    const h = await harnessFor(this.config);
    const id = context && context.vars && context.vars.question_id;
    const q = h.questions.find(x => x.id === id);
    if (!q) return { error: 'unknown question ' + id };
    const t0 = Date.now();
    const r = await h.runQuestion(q);
    const output = { id: q.id, turns: r.turnResults.map(x => ({ status: x.status, answer: x.answer || '', cards: (x.cards || []).map(slimCard),
      state: x.state || {}, stats: x.stats || {} })) };
    return {
      output: JSON.stringify(output),
      latencyMs: Date.now() - t0,
      // No real model or seller call happens in this provider.
      tokenUsage: { total: 0, prompt: 0, completion: 0, numRequests: 0 },
      cost: 0,
      metadata: { engine: this.config.engine, strategy: this.config.strategy, fingerprint: r.fingerprint, simulatedPlannerCalls: r.perf.gptCallsSimulated,
        dbQueries: r.perf.dbQueries, vectorQueries: r.perf.vectorQueries }
    };
  }
}
module.exports = SeosaEngineProvider;
