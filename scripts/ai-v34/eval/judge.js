'use strict';
// Cross-validated verdicts: the v3.4 oracle (frozen spec + corpus re-check)
// and the pre-existing independent v2 evaluator (scripts/ai-v32-eval/verdict.js,
// requirements derived from the question text). Neither imports api/.
// Agreement → that verdict. Disagreement → NEEDS_REVIEW (never auto-PASS).
// PASS_ONLY = PASS / total; UNVERIFIED and NEEDS_REVIEW count as non-PASS.
const v34 = require('./oracle');
const { verdict: v2verdict } = require('../../ai-v32-eval/verdict');

function v2Label(v34Expect) {
  if (v34Expect === 'FIND' || v34Expect === 'FIND_COMPARE') return 'FIND';
  if (v34Expect === 'NO_RESULT' || v34Expect === 'STALE_ONLY') return 'NO_RESULT';
  if (v34Expect === 'NON_SHOPPING') return 'NON_SHOPPING';
  return 'NEEDS_VERIFICATION'; // OUTAGE: v2 has no outage rubric
}
function asV2Data(result) {
  return { http: result && result.status, cards: (result && result.cards) || [], state: (result && result.state) || {},
    stats: (result && result.stats) || {} };
}
function judgeQuestion(question, turnResults, { gold, corpus, ctx }) {
  const turns = [];
  for (let i = 0; i < question.turns.length; i++) {
    const turn = question.turns[i];
    const result = turnResults[i];
    if (!result) break;
    const previous = i > 0 ? turnResults[i - 1] : null;
    const a = v34.judgeTurn({ turn, result, previous, gold: gold[question.id][i], corpus, ctx });
    const test = { id: question.id + '-T' + (i + 1), p: turn.p, cat: question.cat, ...(i > 0 ? { from: question.id + '-T' + i } : {}) };
    let b;
    try { b = v2verdict(test, asV2Data(result), previous ? asV2Data(previous) : null, { expect: v2Label(a.expect) }); }
    catch (e) { b = { verdict: 'ERROR', outcome: 'V2_EXCEPTION', causes: [String(e.message).slice(0, 80)] }; }
    const final = a.verdict === b.verdict ? a.verdict : 'NEEDS_REVIEW';
    turns.push({ turn: i + 1, v34: { verdict: a.verdict, outcome: a.outcome, expect: a.expect, causes: a.causes },
      v2: { verdict: b.verdict, outcome: b.outcome, causes: (b.causes || []).slice(0, 8) }, final });
  }
  const pick = key => v34.combine(turns.map(t => key === 'final' ? t.final : t[key].verdict));
  return { id: question.id, type: question.type, turns, final: pick('final'), v34: pick('v34'), v2: pick('v2') };
}
function summarize(judged) {
  const count = (key, v) => judged.filter(j => j[key] === v).length;
  const out = { total: judged.length };
  for (const key of ['final', 'v34', 'v2']) {
    out[key] = { PASS: count(key, 'PASS'), FAIL: count(key, 'FAIL'), UNVERIFIED: count(key, 'UNVERIFIED'),
      ...(key === 'final' ? { NEEDS_REVIEW: count(key, 'NEEDS_REVIEW') } : {}) };
    out[key].PASS_ONLY = Math.round(out[key].PASS / judged.length * 1000) / 10;
  }
  out.agreement = judged.filter(j => j.v34 === j.v2).length;
  out.byType = {};
  for (const j of judged) {
    const t = out.byType[j.type] = out.byType[j.type] || { PASS: 0, FAIL: 0, UNVERIFIED: 0, NEEDS_REVIEW: 0 };
    t[j.final]++;
  }
  return out;
}
module.exports = { judgeQuestion, summarize, v2Label };
