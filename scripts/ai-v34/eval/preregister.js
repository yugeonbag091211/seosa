'use strict';
// Freezes the v3.4 evaluation BEFORE the first engine run:
//   node scripts/ai-v34/eval/preregister.js --snapshot <catalog.jsonl> [--write]
// Hashes the question/spec file, both judges, the gold builder, the corpus and
// the computed gold sets. run-offline.js refuses to grade when any hash differs.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { questions, meta } = require('./questions-v34');
const { loadCorpus, computeGold, sha256 } = require('./gold');

const ROOT = path.resolve(__dirname, '../../..');
const FROZEN = ['scripts/ai-v34/eval/questions-v34.js', 'scripts/ai-v34/eval/oracle.js', 'scripts/ai-v34/eval/gold.js',
  'scripts/ai-v34/eval/judge.js', 'scripts/ai-v32-eval/verdict.js'];
const OUT = path.join(ROOT, 'reports/ai-v34-evaluation/preregistration.json');
// Line endings are normalized so a CRLF checkout hashes the same as LF.
const fileHash = rel => sha256(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'));

function currentHashes(snapshotFile) {
  const rows = loadCorpus(snapshotFile);
  const corpusHash = sha256(fs.readFileSync(snapshotFile));
  const gold = computeGold(questions, rows, { asOf: meta.asOf, maxAgeDays: meta.priceAgeLimitDays });
  const files = Object.fromEntries(FROZEN.map(rel => [rel, fileHash(rel)]));
  return { files, corpus: { sha256: corpusHash, rows: rows.length }, goldSha256: sha256(JSON.stringify(gold)), gold, rows };
}
function goldCounts(gold) {
  return Object.fromEntries(Object.entries(gold).map(([id, turns]) => [id, turns.map(t =>
    t.dynamic ? 'dynamic' : t.sides ? t.sides.map(s => s.count) : t.count)]));
}
function verifyFrozen(snapshotFile) {
  if (!fs.existsSync(OUT)) throw new Error('No preregistration.json — run preregister.js --write first');
  const reg = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const now = currentHashes(snapshotFile);
  const diffs = [];
  for (const [rel, h] of Object.entries(reg.files)) if (now.files[rel] !== h) diffs.push(rel);
  if (now.corpus.sha256 !== reg.corpus.sha256) diffs.push('corpus');
  if (now.goldSha256 !== reg.goldSha256) diffs.push('gold');
  return { ok: diffs.length === 0, diffs, reg, now };
}
if (require.main === module) {
  const i = process.argv.indexOf('--snapshot');
  const snapshot = i > 0 ? process.argv[i + 1] : '';
  if (!snapshot) { console.error('--snapshot <catalog.jsonl> required'); process.exit(1); }
  const h = currentHashes(snapshot);
  const head = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();
  const reg = {
    set: meta.set, frozenAt: new Date().toISOString(), gitHeadAtFreeze: head,
    note: 'Frozen before the first engine run on V001-V100. Any later change to these files invalidates graded runs.',
    asOf: meta.asOf, priceAgeLimitDays: meta.priceAgeLimitDays,
    questions: questions.length, turns: questions.reduce((s, q) => s + q.turns.length, 0),
    files: h.files, corpus: h.corpus, goldSha256: h.goldSha256, goldCounts: goldCounts(h.gold),
    policy: { pass: 'both judges PASS', disagreement: 'NEEDS_REVIEW (non-PASS)', unverified: 'non-PASS', passOnly: 'PASS / total' }
  };
  if (process.argv.includes('--write')) {
    if (fs.existsSync(OUT) && !process.argv.includes('--force')) { console.error('preregistration.json exists; refusing to overwrite'); process.exit(1); }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(reg, null, 1) + '\n');
    console.log('written', path.relative(ROOT, OUT));
  }
  console.log(JSON.stringify({ files: reg.files, corpus: reg.corpus, goldSha256: reg.goldSha256 }, null, 1));
}
module.exports = { currentHashes, verifyFrozen, FROZEN };
