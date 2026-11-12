'use strict';
// Promptfoo JavaScript assertions. Two INDEPENDENT judges, each its own
// assertion, so a test passes only when both say PASS; a disagreement shows up
// as one failing assertion (NEEDS_REVIEW in the reports, never auto-PASS).
//   file://assertions/judges.js:v34Oracle   frozen spec + corpus re-check
//   file://assertions/judges.js:v2Evaluator pre-existing text-derived evaluator
// UNVERIFIED is reported as pass:false with score 0.5 and reason «UNVERIFIED»
// (it counts as non-PASS in PASS_ONLY).
const path = require('node:path');
const EVAL = path.resolve(__dirname, '../../../scripts/ai-v34/eval');
const SET_FILES = { main: 'questions-v34', holdout: 'questions-v34-holdout', fixture: 'questions-v34-fixture' };
const { questions, meta } = require(path.join(EVAL, SET_FILES[process.env.SEOSA_EVAL_SET || 'main'] || SET_FILES.main));
const { loadCorpus, computeGold, faultOverlay, applyOverlay } = require(path.join(EVAL, 'gold'));
const oracle = require(path.join(EVAL, 'oracle'));
const { verdict: v2verdict } = require(path.resolve(EVAL, '../../ai-v32-eval/verdict'));
const { v2Label } = require(path.join(EVAL, 'judge'));

let env = null;
function load() {
  if (env) return env;
  const rows = loadCorpus(process.env.SEOSA_EVAL_SNAPSHOT).map(r => ({ ...r, link: 'https://link.invalid/' + r.product_id }));
  const corpus = new Map(rows.map(r => [r.mall + ':' + r.product_id, r]));
  const asOfMs = Date.parse(meta.asOf);
  env = { rows, corpus, ctx: { asOfMs, maxAgeDays: meta.priceAgeLimitDays },
    gold: computeGold(questions, rows, { asOf: meta.asOf, maxAgeDays: meta.priceAgeLimitDays }) };
  return env;
}
function corpusFor(q) {
  const e = load();
  const overlay = faultOverlay(q, e.rows, e.ctx.asOfMs);
  return overlay ? new Map([...e.corpus].map(([k, r]) => [k, applyOverlay(r, overlay)])) : e.corpus;
}
function grade(verdicts, label, detail) {
  const v = oracle.combine(verdicts);
  return { pass: v === 'PASS', score: v === 'PASS' ? 1 : v === 'UNVERIFIED' ? 0.5 : 0,
    reason: label + ' ' + v + (detail ? ': ' + detail : ''),
    namedScores: { [label + '_PASS']: v === 'PASS' ? 1 : 0, [label + '_FAIL']: v === 'FAIL' ? 1 : 0, [label + '_UNVERIFIED']: v === 'UNVERIFIED' ? 1 : 0 } };
}
function parse(output) { return typeof output === 'string' ? JSON.parse(output) : output; }

function v34Oracle(output) {
  const data = parse(output);
  const q = questions.find(x => x.id === data.id);
  const e = load(), corpus = corpusFor(q);
  const turns = q.turns.map((turn, i) => oracle.judgeTurn({ turn, result: data.turns[i], previous: i ? data.turns[i - 1] : null,
    gold: e.gold[q.id][i], corpus, ctx: e.ctx }));
  return grade(turns.map(t => t.verdict), 'v34', turns.flatMap(t => t.causes).slice(0, 6).join(', '));
}
function v2Evaluator(output) {
  const data = parse(output);
  const q = questions.find(x => x.id === data.id);
  const e = load(), corpus = corpusFor(q);
  const asV2 = r => ({ http: r.status, cards: r.cards || [], state: r.state || {}, stats: r.stats || {} });
  const verdicts = [], causes = [];
  q.turns.forEach((turn, i) => {
    const expect = oracle.judgeTurn({ turn, result: data.turns[i], previous: i ? data.turns[i - 1] : null, gold: e.gold[q.id][i], corpus, ctx: e.ctx }).expect;
    const test = { id: q.id + '-T' + (i + 1), p: turn.p, cat: q.cat, ...(i ? { from: q.id + '-T' + i } : {}) };
    const b = v2verdict(test, asV2(data.turns[i]), i ? asV2(data.turns[i - 1]) : null, { expect: v2Label(expect) });
    verdicts.push(b.verdict); causes.push(...(b.causes || []));
  });
  return grade(verdicts, 'v2', causes.slice(0, 6).join(', '));
}
module.exports = { v34Oracle, v2Evaluator };
