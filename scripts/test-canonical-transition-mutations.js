#!/usr/bin/env node
'use strict';

/*
 * Canonical matcher transition — 관문 하나를 지운 사본마다 scripts/test-canonical-transition.js 가 실패해야 한다.
 * 사본은 OS 임시 폴더에만 쓴다(작업 트리의 api/ 를 건드리지 않는다). 대상 문자열은 LF 로 맞춰 CRLF 체크아웃에서도 같다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const API = path.join(ROOT, 'api');
const SOURCE_PATH = path.join(API, '_canonicaltransition.js');
const TEST_PATH = path.join(__dirname, 'test-canonical-transition.js');
const original = fs.readFileSync(SOURCE_PATH, 'utf8').replace(/\r\n/g, '\n');
// 사본이 임시 폴더에서도 같은 모듈을 읽도록 상대 require 를 절대 경로로 바꾼다.
const rewired = original.replace(/require\('\.\/(_[a-z]+)'\)/g, (m, name) => `require(${JSON.stringify(path.join(API, name))})`);

const mutations = [
  ['previous-matcher reproduction gate', "  if (!legacyOk) return hold(['HOLD_STALE_UNDER_PREVIOUS_MATCHER']);\n", ''],
  ['all-pairs revalidation (member context)', "  if (memberCheck.status !== 'ACTIVE') return hold(", '  if (false) return hold('],
  ['all-pairs revalidation (catalog context / color policy)', "    if (catalogCheck.status !== 'ACTIVE') return hold(", '    if (false) return hold('],
  ['catalog context required for STAGE', "  } else if (o.requireCatalog) return hold(['HOLD_CATALOG_CONTEXT_MISSING']);\n", '  }\n'],
  ['tier unchanged', "  if (tierInfo.tier !== group.confidence_tier) return hold(['HOLD_TIER_CHANGED']);\n", ''],
  ['strong identifier unchanged', "    return hold(['HOLD_STRONG_IDENTIFIER_CHANGED']);\n", ''],
  ['next key collision', "  if (o.takenKeys && o.takenKeys.has(nextKey)) return hold(['HOLD_CANONICAL_KEY_COLLISION'], { nextKey });\n", ''],
  ['cross-merchant', "return hold(['HOLD_NOT_CROSS_MERCHANT']);", 'void 0;'],
  ['identity drift hold', "  if (drift.material.length) return hold(['HOLD_IDENTITY_DRIFT'], { drift, nextKey });\n", ''],
  ['vendor option unchanged', "return hold(['HOLD_VENDOR_OPTION_CHANGED']);", 'void 0;'],
  ['staged snapshot stale', "  if (group.next_canonical_key) return hold(['HOLD_STAGED_SNAPSHOT_STALE']);\n", ''],
  ['deploy readiness counts fail-closed groups', '  out.readyToDeploy = out.needsStage === 0 && out.failClosedAfterDeploy === 0;\n', '  out.readyToDeploy = out.needsStage === 0;\n'],
  ['fail-closed acceptance is per group id', "      if (accepted.has(String(p.groupId))) out.acceptedFailClosed++;\n", "      if (accepted.size) out.acceptedFailClosed++;\n"],
  ['drift: new model number is material', 'if (addedCodes.length || removedCodes', 'if (removedCodes'],
  ['drift: brand replaced is material', "if (diff('brand')) (p.brand ? material : changes)", "if (diff('brand')) (changes)"],
  ['drift: new family word is material', "  if (addedWords.length) material.push('familyWords');\n", '']
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-transition-mutants-'));
let killed = 0;
const survivors = [];
try {
  for (let i = 0; i < mutations.length; i++) {
    const [name, target, replacement] = mutations[i];
    if (!rewired.includes(target)) throw new Error(`mutation target not found: ${name}`);
    const mutant = rewired.replace(target, replacement);
    if (mutant === rewired) throw new Error(`mutation changed nothing: ${name}`);
    const mutantPath = path.join(dir, `_canonicaltransition.mutant-${i}.js`);
    fs.writeFileSync(mutantPath, mutant, { flag: 'wx' });
    const r = spawnSync(process.execPath, [TEST_PATH], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
      env: Object.assign({}, process.env, { CANONICAL_TRANSITION_MODULE: mutantPath })
    });
    if (r.status === 0) survivors.push(name);
    else killed++;
  }
  // 사본 그대로(뮤테이션 없음)는 통과해야 한다 — 위의 실패가 경로 재배선 탓이 아님을 보인다.
  const controlPath = path.join(dir, '_canonicaltransition.control.js');
  fs.writeFileSync(controlPath, rewired, { flag: 'wx' });
  const control = spawnSync(process.execPath, [TEST_PATH], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, { CANONICAL_TRANSITION_MODULE: controlPath })
  });
  if (control.status !== 0) throw new Error(`unmutated rewired copy fails the suite:\n${control.stdout}\n${control.stderr}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (survivors.length) {
  console.error(`canonical transition mutation tests: FAIL — survived: ${survivors.join(', ')}`);
  process.exit(1);
}
console.log(`canonical transition mutation tests: PASS (${killed} protections killed)`);
