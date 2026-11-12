'use strict';
// Freezes a v3.4 evaluation set BEFORE its first engine run:
//   node scripts/ai-v34/eval/preregister.js --snapshot <catalog.jsonl> [--set main|holdout] [--write]
// Hashes the question/spec file, both judges, the gold builder, the corpus and
// the computed gold sets. run-offline.js refuses to grade when any hash differs.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { loadCorpus, computeGold, sha256 } = require('./gold');

const ROOT = path.resolve(__dirname, '../../..');
const SETS = { main: './questions-v34', holdout: './questions-v34-holdout' };
const load = set => require(SETS[set] || SETS.main);
const JUDGES = ['scripts/ai-v34/eval/oracle.js', 'scripts/ai-v34/eval/gold.js', 'scripts/ai-v34/eval/judge.js', 'scripts/ai-v32-eval/verdict.js'];
const frozenFiles = set => [set === 'holdout' ? 'scripts/ai-v34/eval/questions-v34-holdout.js' : 'scripts/ai-v34/eval/questions-v34.js', ...JUDGES];
const FROZEN = frozenFiles('main');
const outFile = set => path.join(ROOT, 'reports/ai-v34-evaluation/' + (set === 'holdout' ? 'preregistration-holdout.json' : 'preregistration.json'));
// Line endings are normalized so a CRLF checkout hashes the same as LF.
const fileHash = rel => sha256(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'));

function currentHashes(snapshotFile, set = 'main') {
  const { questions, meta } = load(set);
  const rows = loadCorpus(snapshotFile);
  const corpusHash = sha256(fs.readFileSync(snapshotFile));
  const gold = computeGold(questions, rows, { asOf: meta.asOf, maxAgeDays: meta.priceAgeLimitDays });
  const files = Object.fromEntries(frozenFiles(set).map(rel => [rel, fileHash(rel)]));
  return { files, corpus: { sha256: corpusHash, rows: rows.length }, goldSha256: sha256(JSON.stringify(gold)), gold, rows };
}
function goldCounts(gold) {
  return Object.fromEntries(Object.entries(gold).map(([id, turns]) => [id, turns.map(t =>
    t.dynamic ? 'dynamic' : t.sides ? t.sides.map(s => s.count) : t.count)]));
}
function verifyFrozen(snapshotFile, set = 'main') {
  const file = outFile(set);
  if (!fs.existsSync(file)) throw new Error('No ' + path.basename(file) + ' — run preregister.js --write first');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = currentHashes(snapshotFile, set);
  const diffs = [];
  for (const [rel, h] of Object.entries(reg.files)) if (now.files[rel] !== h) diffs.push(rel);
  if (now.corpus.sha256 !== reg.corpus.sha256) diffs.push('corpus');
  if (now.goldSha256 !== reg.goldSha256) diffs.push('gold');
  return { ok: diffs.length === 0, diffs, reg, now };
}
if (require.main === module) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
  const snapshot = arg('--snapshot', '');
  const set = arg('--set', 'main');
  if (!snapshot) { console.error('--snapshot <catalog.jsonl> required'); process.exit(1); }
  const { questions, meta } = load(set);
  const out = outFile(set);
  const h = currentHashes(snapshot, set);
  const head = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();
  const reg = {
    set: meta.set, frozenAt: new Date().toISOString(), gitHeadAtFreeze: head,
    note: 'Frozen before the first engine run on this set. Any later change to these files invalidates graded runs.',
    asOf: meta.asOf, priceAgeLimitDays: meta.priceAgeLimitDays,
    questions: questions.length, turns: questions.reduce((s, q) => s + q.turns.length, 0),
    files: h.files, corpus: h.corpus, goldSha256: h.goldSha256, goldCounts: goldCounts(h.gold),
    policy: { pass: 'both judges PASS', disagreement: 'NEEDS_REVIEW (non-PASS)', unverified: 'non-PASS', passOnly: 'PASS / total' }
  };
  if (process.argv.includes('--write')) {
    if (fs.existsSync(out) && !process.argv.includes('--force')) { console.error(path.basename(out) + ' exists; refusing to overwrite'); process.exit(1); }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(reg, null, 1) + '\n');
    console.log('written', path.relative(ROOT, out));
  }
  console.log(JSON.stringify({ set, files: reg.files, corpus: reg.corpus, goldSha256: reg.goldSha256 }, null, 1));
}
module.exports = { currentHashes, verifyFrozen, FROZEN, frozenFiles, SETS };
