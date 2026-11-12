'use strict';
// AI v3.4 OFFLINE evaluation runner (frozen question sets).
//
//   node scripts/ai-v34/eval/run-offline.js --snapshot <catalog.jsonl> --engine v34 --strategy hybrid \
//        --pglite <pgdata dir> --out <results.jsonl> [--set main|holdout] [--ids V001,V002]
//        [--hybrid-mode expand|fuse] [--vector-weight 0.5] [--v33-root <archive of fa172f3>]
//
// Measures the SERVER pipeline (retrieval, validation, state, price-age gate,
// outage handling) over a frozen 77,737-row catalog snapshot, with a scripted
// planner standing in for GPT. It does NOT measure GPT planning, live seller
// stock or today's prices. No network is used.
const fs = require('node:fs');
const { createHarness } = require('./harness');
const { summarize } = require('./judge');
const { verifyFrozen } = require('./preregister');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }
const pct = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const avg = arr => arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : null;

async function main() {
  const snapshot = arg('--snapshot');
  const set = arg('--set', 'main');
  const out = arg('--out');
  const only = arg('--ids') ? new Set(arg('--ids').split(',')) : null;
  if (!snapshot) throw new Error('--snapshot required');
  const frozen = verifyFrozen(snapshot, set);
  if (!frozen.ok && !process.argv.includes('--allow-unfrozen')) throw new Error('Evaluation files changed since preregistration: ' + frozen.diffs.join(', '));
  const h = await createHarness({ snapshot, set, engine: arg('--engine', 'v34'), strategy: arg('--strategy', 'db-first'),
    pglite: arg('--pglite'), v33Root: arg('--v33-root'), k: Number(arg('--k', 40)), ef: Number(arg('--ef', 100)),
    hybridMode: arg('--hybrid-mode', 'expand'), vectorWeight: Number(arg('--vector-weight', 1)),
    gold: frozen.ok ? frozen.now.gold : undefined });
  const results = [], latencies = [], vectorMs = [], retrieval = [];
  const perf = { dbQueries: 0, vectorQueries: 0, gptCallsSimulated: 0, turns: 0 };
  let shown = 0, wrong = 0;
  try {
    for (const q of h.questions) {
      if (only && !only.has(q.id)) continue;
      const tq = Date.now();
      const r = await h.runQuestion(q);
      if (process.env.AI_V34_EVAL_PROGRESS === '1') process.stderr.write(q.id + ' ' + (Date.now() - tq) + 'ms ' + r.verdict.final + '\n');
      latencies.push(...r.perf.latencies); vectorMs.push(...r.perf.vectorMs);
      perf.dbQueries += r.perf.dbQueries; perf.vectorQueries += r.perf.vectorQueries; perf.gptCallsSimulated += r.perf.gptCallsSimulated;
      perf.turns += r.turns.length; shown += r.cards.shown; wrong += r.cards.wrong;
      if (r.retrieval) retrieval.push({ id: q.id, ...r.retrieval });
      const { turnResults, ...row } = r;
      results.push(row);
    }
  } finally { await h.close(); }
  const mean = key => retrieval.length ? Math.round(retrieval.reduce((s, x) => s + x[key], 0) / retrieval.length * 1000) / 1000 : null;
  const summary = {
    set, engine: h.engine, strategy: h.strategy, engineFingerprint: h.fingerprint,
    hybridMode: h.strategy === 'hybrid' ? arg('--hybrid-mode', 'expand') : null,
    vectorWeight: h.strategy === 'hybrid' ? Number(arg('--vector-weight', 1)) : null,
    frozen: frozen.ok, corpusSha256: frozen.now.corpus.sha256, asOf: h.meta.asOf,
    judged: summarize(results.map(r => r.verdict)), cards: { shown, wrong },
    retrieval: { questions: retrieval.length, hitRate10: mean('hit10'), hitRate20: mean('hit20'), recall10: mean('recall10'),
      recall20: mean('recall20'), mrr20: mean('mrr20') },
    perf: { turns: perf.turns, avgMs: avg(latencies), p50Ms: pct(latencies, 0.5), p95Ms: pct(latencies, 0.95),
      dbQueries: perf.dbQueries, avgDbQueriesPerTurn: Math.round(perf.dbQueries / Math.max(1, perf.turns) * 10) / 10,
      vectorQueries: perf.vectorQueries, vectorP50Ms: pct(vectorMs, 0.5), vectorP95Ms: pct(vectorMs, 0.95),
      gptCallsSimulated: perf.gptCallsSimulated, realGptCalls: 0, sellerApiCalls: 0, costUsd: 0 }
  };
  if (out) {
    fs.writeFileSync(out, results.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(out.replace(/\.jsonl$/, '') + '.summary.json', JSON.stringify(summary, null, 1) + '\n');
  }
  console.log(JSON.stringify(summary));
}
if (require.main === module) main().catch(e => { console.error('run failed:', e.stack || e.message); process.exit(1); });
