#!/usr/bin/env node
'use strict';

/* Verify that the Phase 4 negative tests kill weakened security and idempotency gates. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const TEST = path.join(__dirname, 'test-identity-review.js');
const apiPath = path.join(ROOT, 'api', '_identityreview.js');
const workerPath = path.join(__dirname, 'run-identity-review-ingest.js');
const sqlPath = path.join(ROOT, 'supabase', '2026-10-13-identity-review-phase4.sql');
const mutations = [
  {
    name: 'admin auth gate', file: apiPath, env: 'IDENTITY_REVIEW_MODULE',
    replace: source => source.replace("const auth = require('./_auth').identify(req);", "const auth = { ok: true, email: 'admin@example.com' };"),
    expected: 'anonymous API access is denied'
  },
  {
    name: 'hard-conflict server gate', file: apiPath, env: 'IDENTITY_REVIEW_MODULE',
    extraEnv: { IDENTITY_REVIEW_FOCUS: 'api-hard-conflict' },
    replace: source => {
      const withoutApiGate = source.replace(/    if \(decision === 'APPROVE' && hard\.conflicts\.length\) \{[\s\S]*?\r?\n    \}\r?\n/, '');
      if (withoutApiGate === source) throw new Error('mutation target not found: hard-conflict API gate');
      const helperGate = "  if (checked.conflicts.length) return { ok: false, error: 'HARD_CONFLICT', conflicts: checked.conflicts };";
      if (!withoutApiGate.includes(helperGate)) throw new Error('mutation target not found: makeApproval hard-conflict gate');
      return withoutApiGate.replace(helperGate, helperGate.replace('if (checked.conflicts.length)', 'if (false && checked.conflicts.length)'));
    },
    expected: 'direct API APPROVE is blocked for explicit storage conflict'
  },
  {
    name: 'stale snapshot gate', file: apiPath, env: 'IDENTITY_REVIEW_MODULE',
    replace: source => source
      .replace(/    if \(String\(row\.title \|\| ''\)[\s\S]*?return \{ stale: true, rows: \[\] \};/, '    if (false) return { stale: true, rows: [] };')
      .replace(/    if \(stableJson\(SH\.identitySnapshot\(offer\)\)[\s\S]*?return \{ stale: true, rows: \[\] \};/, '    if (false) return { stale: true, rows: [] };'),
    expected: 'TOCTOU change marks queue STALE'
  },
  {
    name: 'canonical membership collision gate', file: sqlPath, env: 'IDENTITY_REVIEW_SQL',
    replace: source => source.replace(/    if exists \(\n      select 1 from public\.canonical_product_members cm[\s\S]*?    end if;\n/, ''),
    expected: 'canonical membership and key collisions are blocked in SQL'
  },
  {
    name: 'double-submit row lock', file: sqlPath, env: 'IDENTITY_REVIEW_SQL',
    replace: source => source.replace('  for update;\n', '  ;\n'),
    expected: 'resolution locks queue and compare-and-sets its state'
  },
  {
    name: 'rejection suppression', file: workerPath, env: 'IDENTITY_REVIEW_WORKER',
    replace: source => source.replace(
      "if (['APPROVED', 'REJECTED', 'DEFERRED', 'STALE'].includes(old.status)) stats.alreadyDecided++;",
      "if (old.status === 'REJECTED') { candidates.push(row); continue; }\n      if (['APPROVED', 'REJECTED', 'DEFERRED', 'STALE'].includes(old.status)) stats.alreadyDecided++;"
    ),
    expected: 'same matcher/policy/evidence rejection is suppressed'
  }
];

let killed = 0;
for (const mutation of mutations) {
  // Keep literal and regex mutation targets stable across Windows and Unix checkouts.
  const original = fs.readFileSync(mutation.file, 'utf8').replace(/\r\n/g, '\n');
  const mutant = mutation.replace(original);
  if (mutant === original) throw new Error(`mutation target did not apply: ${mutation.name}`);
  const temp = path.join(path.dirname(mutation.file), `.${path.basename(mutation.file, path.extname(mutation.file))}-mutant-${process.pid}${path.extname(mutation.file)}`);
  try {
    fs.writeFileSync(temp, mutant, 'utf8');
    let failure = '';
    try {
      execFileSync(process.execPath, [TEST], {
        cwd: ROOT,
        env: Object.assign({}, process.env, mutation.extraEnv || {}, { [mutation.env]: temp }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) { failure = `${String(err.stdout || '')}\n${String(err.stderr || '')}`; }
    if (!failure) throw new Error(`mutation survived: ${mutation.name}`);
    if (!failure.includes(mutation.expected)) throw new Error(`mutation failed unexpectedly (${mutation.name}): ${failure.slice(-1800)}`);
    killed++;
    console.log(`KILLED ${mutation.name}`);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
console.log(`Identity review mutations: ${killed}/${mutations.length} killed`);
if (killed !== mutations.length) process.exit(1);
