'use strict';
/*
 * Offline, evidence-based stage attribution for SEOSA search evaluation.
 *
 * Usage:
 *   node scripts/search-eval/explain-search-failures.cjs <evaluation.json>
 *       [--questions path/to/questions.json] [--out new-report.json]
 *
 * No HTTP, credentials, database access, writes to the input, or product
 * descriptions in the console output. An explicit --out uses exclusive create.
 * Source report is tied to its recorded source hashes, NOT the current checkout.
 */
const fs = require('node:fs');
const path = require('node:path');

const STAGES = [
  'provider_relevance_filter', 'ranking_or_score_floor',
  'product_gate', 'post_gate_or_result_cutoff', 'unknown'
];
function analyzeSearchFailures(report, questions = []) {
  if (!report || !Array.isArray(report.results) || !report.summary) {
    throw new Error('Expected an evaluation report with summary and results');
  }
  const lookup = new Map((Array.isArray(questions) ? questions : []).map(q => [q.id, q]));
  const stages = Object.fromEntries(STAGES.map(s => [s, 0]));
  const reasonHits = new Map();
  const reasonTargets = new Map();
  const samples = new Map();
  const examplesPerReason = 3;
  let lost = 0, unattributed = 0, empty = 0, failed = 0, unknown = 0;
  for (const row of report.results) {
    if (!row || !row.id) throw new Error('Missing question id');
    if (!row.shownCount) empty++;
    if (row.verdict === 'FAIL') failed++;
    if (row.verdict === 'UNVERIFIED') unknown++;
    for (const miss of row.missedTargets || []) {
      lost++;
      const where = STAGES.includes(miss.where) ? miss.where : 'unknown';
      stages[where]++;
      if (where !== 'product_gate') continue;
      const hit = (row.gate?.rejected || []).find(item => item.id === miss.id);
      if (!hit || !Array.isArray(hit.hard) || !hit.hard.length) {
        unattributed++;
        continue;
      }
      for (const reason of hit.hard) {
        const family = String(reason).split(':')[0];
        reasonHits.set(family, (reasonHits.get(family) || 0) + 1);
        const key = row.id + '/' + miss.id;
        if (!reasonTargets.has(family)) reasonTargets.set(family, new Set());
        reasonTargets.get(family).add(key);
        const ex = samples.get(family) || [];
        if (ex.length < examplesPerReason && !ex.some(a => a.id === row.id)) {
          const q = lookup.get(row.id);
          // All examples are synthetic, and no customer queries/logs are read.
          ex.push({ id: row.id, candidateId: miss.id,
            query: q ? String(q.query || '').slice(0, 100) : undefined,
            reason: String(reason).slice(0, 150) });
          samples.set(family, ex);
        }
      }
    }
  }
  const reasons = [...reasonHits].map(([reason, hits]) => ({
    reason, hits, missingTargetsAffected: reasonTargets.get(reason).size,
    examples: samples.get(reason) || []
  })).sort((a,b)=> b.missingTargetsAffected-a.missingTargetsAffected || b.hits-a.hits || a.reason.localeCompare(b.reason));
  if (Object.values(stages).reduce((a,b)=>a+b,0) !== lost) throw new Error('Stage accounting mismatch');
  return {
    sourceScope: report.summary.scope || null,
    sourceFingerprint: report.summary.api_js_fingerprint || null,
    sourceHashes: report.summary.source_hashes || null,
    questions: report.results.length,
    outcomes: { pass: report.results.length-failed-unknown, fail: failed, unverified: unknown },
    zeroResults: empty,
    missedTargets: lost,
    missingTargetsByStage: stages,
    gateMissesWithoutReason: unattributed,
    gateReasonCount: reasons.length,
    topGateReasons: reasons,
    limitations: [
      'Counts missing candidate instances, not unique buyers or real products.',
      'Reason hits can exceed missed targets because a candidate may have several gate reasons.',
      'Synthetic fixture stage counts do not estimate live supplier recall or accuracy.',
      'Source fingerprints are from the input report; no claim is made about the current branch.'
    ]
  };
}
function main(args) {
  if (!args.length || args[0].startsWith('-')) {
    throw new Error('Usage: node explain-search-failures.cjs <evaluation.json> [--questions file] [--out new.json]');
  }
  const input = path.resolve(args[0]);
  const opt = name => {const i=args.indexOf(name); return i===-1?null:args[i+1];};
  const questionFile = opt('--questions');
  const outFile = opt('--out');
  const report = JSON.parse(fs.readFileSync(input,'utf8'));
  const questions = questionFile ? JSON.parse(fs.readFileSync(path.resolve(questionFile),'utf8')) : [];
  const result = analyzeSearchFailures(report, questions);
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)),{recursive:true});
    fs.writeFileSync(path.resolve(outFile),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  }
  process.stdout.write(JSON.stringify({
    questions:result.questions, outcomes:result.outcomes, zeroResults:result.zeroResults,
    missedTargets:result.missedTargets, stages:result.missingTargetsByStage,
    leadingGateReasons:result.topGateReasons.slice(0,12).map(x=>({
      reason:x.reason,hits:x.hits,missingTargetsAffected:x.missingTargetsAffected
    })),
    fingerprint:result.sourceFingerprint,
    note:'OFFLINE SYNTHETIC / NOT LIVE ACCURACY'
  },null,2)+'\n');
}
module.exports = { analyzeSearchFailures };
if (require.main === module) {
  try {main(process.argv.slice(2));} catch(e) {console.error(e.stack);process.exitCode=1;}
}
