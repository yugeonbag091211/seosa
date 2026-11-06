'use strict';
// Re-grade a live result file with the independent v2 evaluator so that the
// v3.1 baseline and the v3.2 run are judged by the SAME criteria.
//   node scripts/ai-v32-eval/regrade.js <results.jsonl> <out-prefix> [--cases online200|holdout]
const fs = require('node:fs');
const path = require('node:path');
const { verdict } = require('./verdict');

function load(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
function casesFor(kind) {
  if (kind === 'holdout') return require('./holdout-cases').cases;
  return require('../ai-v31-online-200-cases').cases;
}
function labelsFor(kind) {
  if (kind === 'holdout') return require('./holdout-cases').labelFor;
  return require('./labels-200').labelFor;
}
function regrade(rows, kind) {
  const cases = casesFor(kind), labelFor = labelsFor(kind);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  const out = [];
  for (const test of cases) {
    const r = byId[test.id];
    if (!r) continue;
    // Normalise both result formats (docs-cleaned v3.1 and v3.2 runner).
    const ids = (r.state && r.state.presentedProductIds) || [];
    const cards = (r.cards || []).map((c, i) => ({ ...c, productId: c.productId || ids[i] }));
    const data = { http: r.http, cards, state: r.state || {}, stats: r.stats || {} };
    const prevRow = test.from ? byId[test.from] : null;
    const previous = prevRow ? { cards: (prevRow.cards || []).map((c, i) => ({ ...c, productId: c.productId || (prevRow.state?.presentedProductIds || [])[i] })),
      state: prevRow.state || {} } : null;
    const v = verdict(test, data, previous, labelFor(test));
    out.push({ id: test.id, question: test.p, category: test.cat || '비쇼핑', from: test.from || null, expect: v.expect,
      verdict: v.verdict, outcome: v.outcome, causes: v.causes, cards: cards.map(c => ({ productId: c.productId, title: c.title, price: c.price, condition: c.condition })),
      cardChecks: v.cardChecks, searched: data.stats.searched, elapsedMs: r.elapsedMs,
      modelUsage: (r.stats && r.stats.modelUsage) || null, dbQueries: r.stats && r.stats.dbQueries, intent: r.stats && r.stats.intent });
  }
  return out;
}
function summarize(graded) {
  const count = k => graded.reduce((m, x) => (m[x[k]] = (m[x[k]] || 0) + 1, m), {});
  const findable = graded.filter(x => x.expect === 'FIND' || (x.expect !== 'NO_RESULT' && x.expect !== 'NON_SHOPPING' && x.expect !== 'NEEDS_VERIFICATION' && x.cards.length));
  const withCards = graded.filter(x => x.cards.length);
  const wrongCards = withCards.filter(x => x.outcome === 'WRONG_CARDS');
  const cardTotal = withCards.reduce((s, x) => s + x.cards.length, 0);
  const badCards = graded.reduce((s, x) => s + (x.cardChecks || []).filter(c => c.errors.length).length, 0);
  const tokens = graded.reduce((m, x) => { const u = x.modelUsage || {}; m.calls += u.calls || 0; m.input += u.inputTokens || 0; m.output += u.outputTokens || 0; return m; }, { calls: 0, input: 0, output: 0 });
  const times = graded.map(x => x.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = p => times.length ? times[Math.max(0, Math.ceil(p * times.length) - 1)] : null;
  return {
    questions: graded.length, verdicts: count('verdict'), outcomes: count('outcome'), expectations: count('expect'),
    findableQuestions: graded.filter(x => x.expect === 'FIND').length,
    findableAnsweredCorrectly: graded.filter(x => x.expect === 'FIND' && x.outcome === 'CORRECT_CARDS').length,
    missedAvailable: graded.filter(x => x.outcome === 'MISSED_AVAILABLE').length,
    questionsWithWrongCards: wrongCards.length, cardsShown: cardTotal, cardsWithErrors: badCards,
    correctNoResult: graded.filter(x => x.outcome === 'CORRECT_NO_RESULT').length,
    tokens, latencyMs: { avg: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null, p50: pct(0.5), p95: pct(0.95) },
    dbQueries: graded.some(x => Number.isFinite(x.dbQueries)) ? {
      avg: +(graded.reduce((s, x) => s + (x.dbQueries || 0), 0) / graded.length).toFixed(2),
      max: Math.max(...graded.map(x => x.dbQueries || 0)) } : null
  };
}
if (require.main === module) {
  const [file, prefix] = process.argv.slice(2);
  const kindArg = process.argv.indexOf('--cases');
  const kind = kindArg > 0 ? process.argv[kindArg + 1] : 'online200';
  const graded = regrade(load(file), kind);
  const summary = summarize(graded);
  fs.writeFileSync(prefix + '-graded.jsonl', graded.map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(prefix + '-graded-summary.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
module.exports = { regrade, summarize, load };
