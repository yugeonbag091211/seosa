#!/usr/bin/env node
'use strict';

/* Kill required policy mutations in isolated temporary module copies. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'api', '_identitypromotion.js');
const TEST_PATH = path.join(ROOT, 'scripts', 'test-identity-promotion.js');
const original = fs.readFileSync(SOURCE_PATH, 'utf8');
const mutations = [
  {
    name: 'missing model number blocker',
    target: "  addOneSidedReason(reasons, fieldValues(members, m => m.modelNumbers), 'HOLD_MISSING_MODEL_NUMBER');\n",
    replacement: '',
    expectedFailure: 'one-sided manufacturer model number blocks promotion'
  },
  {
    name: 'storage blocker',
    target: "  addOneSidedReason(reasons, fieldValues(members, m => m.storage), 'HOLD_MISSING_STORAGE');\n",
    replacement: '',
    expectedFailure: 'one-sided storage blocks promotion'
  },
  {
    name: 'unknown merchant gate',
    target: "  if (merchantEvidence.unknownCount) return result(DECISION.HOLD, ['HOLD_UNKNOWN_MERCHANT'], {\n    merchantCount: merchants.length, unknownMerchantCount: merchantEvidence.unknownCount\n  });\n",
    replacement: '',
    expectedFailure: 'bare ADPICK cannot satisfy promotion cross-merchant evidence'
  },
  {
    name: 'cross-merchant gate',
    target: "  if (merchants.length < 2) return result(DECISION.REJECT, ['REJECT_NOT_CROSS_MERCHANT'], { merchantCount: merchants.length });\n",
    replacement: '',
    expectedFailure: 'real run_id=1 is rejected by cross-merchant gate'
  },
  {
    name: 'all-pairs validation',
    target: '    for (let j = i + 1; j < members.length; j++) {\n',
    replacement: '    for (let j = i + 1; j === i + 1 && j < members.length; j++) {\n',
    expectedFailure: 'non-transitive pair attack is rejected after checking every pair'
  },
  {
    name: 'hard conflict check',
    target: '    p.result.conflicts.forEach(c => add(reasonFromConflict(c)));\n',
    replacement: '',
    expectedFailure: 'bridge poisoning rejected by all-pairs storage conflict'
  }
];

let killed = 0;
for (const mutation of mutations) {
  if (!original.includes(mutation.target)) throw new Error(`mutation target not found: ${mutation.name}`);
  const mutantPath = path.join(ROOT, 'api', `.identitypromotion-mutant-${process.pid}.js`);
  try {
    fs.writeFileSync(mutantPath, original.replace(mutation.target, mutation.replacement), 'utf8');
    let failure = '';
    try {
      execFileSync(process.execPath, [TEST_PATH], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { IDENTITY_PROMOTION_MODULE: mutantPath }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      failure = `${String(err.stdout || '')}\n${String(err.stderr || '')}`;
    }
    if (!failure) throw new Error(`mutation survived: ${mutation.name}`);
    if (!failure.includes(mutation.expectedFailure)) {
      throw new Error(`mutation failed for an unexpected reason (${mutation.name}): ${failure.slice(-2500)}`);
    }
    killed++;
    console.log(`KILLED ${mutation.name}`);
  } finally {
    if (fs.existsSync(mutantPath)) fs.unlinkSync(mutantPath);
  }
}

console.log(`Promotion mutations: ${killed}/${mutations.length} killed`);
if (killed !== mutations.length) process.exit(1);
