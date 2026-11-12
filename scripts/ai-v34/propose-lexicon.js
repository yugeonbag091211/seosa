'use strict';
// AI v3.4 — turns verified, de-identified failure records into a REVIEW QUEUE.
// It never edits code, the lexicon, embeddings or any database.
//
//   node scripts/ai-v34/propose-lexicon.js --records feedback.jsonl [--reviews reviews.jsonl] --out proposal.json
//
// reviews.jsonl (written by a human): {"key":"<proposal key>","decision":"approve|reject","note":"..."}
// Only APPROVED proposals may be implemented, in a separate branch, by bumping
// LEXICON_VERSION in api/_ai-v34-text.js (which re-embeds exactly the affected
// products) and passing npm run test:ai-v34 + the frozen offline evaluation.
const fs = require('node:fs');
const { assertSafeRecord } = require('../../api/_ai-v34-feedback');
const { LEXICON_VERSION } = require('../../api/_ai-v34-text');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }
const readJsonl = f => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : []);

function propose(records, reviews = [], { minSupport = 3 } = {}) {
  const valid = [];
  let rejectedRecords = 0;
  for (const r of records) { try { assertSafeRecord(r); valid.push(r); } catch { rejectedRecords++; } }
  const groups = new Map();
  for (const r of valid) {
    if (!['reject', 'retry', 'report'].includes(r.signal)) continue;
    const top = Object.entries(r.rejectedReasons || {}).sort((a, b) => b[1] - a[1])[0];
    const cause = r.noResult || (top ? top[0] : 'cards_rejected_by_user');
    const key = [r.category || 'unknown', cause, ...(r.terms || []).filter(t => t.startsWith('model:') || t.startsWith('brand:')).slice(0, 2)].join('|');
    const g = groups.get(key) || { key, category: r.category, cause, terms: (r.terms || []).slice(0, 4), support: 0, sessions: new Set(), days: new Set(), lexiconVersions: new Set() };
    g.support++; g.sessions.add(r.sessionHash); g.days.add(r.day); g.lexiconVersions.add(r.lexiconVersion);
    groups.set(key, g);
  }
  const decided = new Map(reviews.map(x => [x.key, x]));
  const action = cause => ({
    no_verified_match: 'Check retrieval probes/synonyms for this category or model code; add a regression case before changing anything.',
    stale_price_only: 'Prices for this segment are older than the display limit: schedule collection/live re-pricing; do NOT relax the age limit.',
    wrong_model: 'Inspect model-code parsing for the listed code (variant suffixes).', identity_unverified: 'Seller titles omit the identity field; consider identity probes.',
    accessory_not_requested: 'Accessories crowd this category; consider an ACCESSORY_PUSHDOWN word (needs a test).', cards_rejected_by_user: 'Collect reviewed examples first; no automatic action.'
  }[cause] || 'Manual review.');
  const proposals = [...groups.values()].filter(g => g.sessions.size >= minSupport)
    .sort((a, b) => b.sessions.size - a.sessions.size)
    .map(g => ({ key: g.key, category: g.category, cause: g.cause, terms: g.terms, support: g.support, distinctSessions: g.sessions.size,
      days: g.days.size, suggestedAction: action(g.cause), status: decided.has(g.key) ? decided.get(g.key).decision : 'pending_review',
      lexiconVersionsSeen: [...g.lexiconVersions] }));
  return { generatedAt: new Date().toISOString(), currentLexiconVersion: LEXICON_VERSION, records: records.length,
    acceptedRecords: valid.length, rejectedRecords, minSupport, proposals,
    policy: 'Proposals are never applied automatically. Approved items are implemented in a separate branch with tests and a frozen re-evaluation.' };
}
if (require.main === module) {
  const out = propose(readJsonl(arg('--records')), readJsonl(arg('--reviews')), { minSupport: Number(arg('--min-support', 3)) });
  const file = arg('--out');
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ records: out.records, accepted: out.acceptedRecords, rejected: out.rejectedRecords, proposals: out.proposals.length }));
}
module.exports = { propose };
