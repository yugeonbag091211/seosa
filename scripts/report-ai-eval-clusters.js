'use strict';
/**
 * Deterministic, read-only, zero-LLM classification of SEOSA evaluation
 * failures. Input is JSONL produced by offline quality auditors or a later
 * isolated live evaluation. Output contains only hashed case IDs, not full
 * conversations, product names or customer identifiers.
 *
 * Unknown result statuses must never silently become PASS.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FACT = Object.freeze({
  UNKNOWN_PRODUCT_ID: 'product_identity',
  CROSS_PRODUCT_EVIDENCE: 'price_spec_provenance',
  PRICE_MISMATCH: 'price_spec_provenance',
  BUDGET_VIOLATION: 'budget_constraint',
  EXCLUDED_BRAND_VIOLATION: 'exclusion_constraint',
  UNSOURCED_PRICE_HISTORY: 'price_history'
});
const QUALITY = Object.freeze({
  accuracy: 'answer_accuracy',
  questionSatisfaction: 'question_satisfaction',
  priceSpecEvidence: 'price_spec_provenance',
  conversationConsistency: 'conversation_state',
  naturalness: 'answer_naturalness'
});
const LIMIT = 3;
function checksum(row) {
  const stable = String(row.id || row.eval_id || row.question || row.userQuestion || row.user_question || row.index || '');
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 14);
}
function result(row) {
  if (!row || typeof row !== 'object') return 'UNVERIFIED';
  const errors = Array.isArray(row.failures) ? row.failures : Array.isArray(row.ruleFailures) ? row.ruleFailures : [];
  const qs = Object.values(row.quality || {}).filter(x => x && x.verdict);
  if (errors.length || row.verdict === 'FAIL' || row.functionCheck?.after === 'FAIL'
      || qs.some(x => x.verdict === 'FAIL')) return 'FAIL';
  if (row.verdict === 'PASS' || row.functionCheck?.after === 'PASS'
      || qs.length && qs.every(x => x.verdict === 'PASS')) return 'PASS';
  return 'UNVERIFIED';
}
function categories(row) {
  const labels = new Set();
  for (const c of [].concat(row.failures || row.ruleFailures || [])) {
    const name = typeof c === 'string' ? c : c && (c.type || c.code);
    if (FACT[name]) labels.add(FACT[name]);
    else if (name) labels.add('unclassified');
  }
  for (const [key,value] of Object.entries(row.quality || {})) {
    if (value && value.verdict === 'FAIL') labels.add(QUALITY[key] || 'unclassified');
  }
  // Free-text causes are diagnostically useful but are not authoritative
  // labels. Only recognize explicit, narrow patterns. Unknown -> review.
  const why = String(row.errorCause || row.why || '').slice(0, 700);
  if (/상품 ID|상품 식별|다른 상품|다른 옵션|product.?id/i.test(why)) labels.add('product_identity');
  if (/가격.*근거|가격.*불일치|price.?mismatch|spec.?evidence/i.test(why)) labels.add('price_spec_provenance');
  if (/예산|상한|budget/i.test(why)) labels.add('budget_constraint');
  if (/제외|exclude/i.test(why)) labels.add('exclusion_constraint');
  if (/이력|가격 기록|price.?history/i.test(why)) labels.add('price_history');
  if (/대화|문맥|기억|conversation|state.?loss/i.test(why)) labels.add('conversation_state');
  if (/후보 부족|추천 개수|검색 결과|search.?miss/i.test(why)) labels.add('retrieval_or_ranker');
  if (!labels.size) labels.add('unclassified');
  return [...labels].sort();
}
function summarize(records) {
  const counts = { asked: records.length, pass: 0, fail: 0, unverified: 0 };
  const clusters = {};
  for (const row of records) {
    const status = result(row);
    counts[status.toLowerCase()]++;
    if (status !== 'FAIL') continue;
    for (const group of categories(row)) {
      const slot = clusters[group] || (clusters[group] = { failures: 0, caseHashes: [] });
      slot.failures++;
      if (slot.caseHashes.length < LIMIT) slot.caseHashes.push(checksum(row));
    }
  }
  return {
    kind: 'SEOSA_OFFLINE_EVAL_FAILURE_CLUSTER_SUMMARY',
    ...counts,
    clusters: Object.fromEntries(Object.entries(clusters)
      .sort((a,b) => b[1].failures-a[1].failures || a[0].localeCompare(b[0]))),
    privacy: 'case hashes only; no raw user questions or answers',
    limits: 'rule/judge verdicts may be wrong; human review of representative failures required'
  };
}
function parseJsonl(text) {
  return String(text||'').split(/\r?\n/).filter(x=>x.trim()).map((line,i)=>{
    try { return JSON.parse(line); } catch(e) { throw Error('Invalid JSONL line '+(i+1)+': '+e.message); }
  });
}
function main(args=process.argv.slice(2)) {
  const pick=flag=>{ const i=args.indexOf(flag);return i>=0?args[i+1]:null; };
  const input=pick('--input'),output=pick('--out');
  if (!input) { console.error('Usage: node scripts/report-ai-eval-clusters.js --input path.jsonl [--out path.json]');process.exitCode=2;return; }
  const summary=summarize(parseJsonl(fs.readFileSync(path.resolve(input),'utf8')));
  if(output) { fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(path.resolve(output),JSON.stringify(summary,null,2)+'\n'); }
  console.log(JSON.stringify(summary));
  if(summary.unverified>0) process.exitCode=1;
}
if(require.main===module)main();
module.exports={summarize,categories,result,parseJsonl,FACT};
