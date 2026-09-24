#!/usr/bin/env node
'use strict';
/*
 * SEOSA 2.0 테스트 러너 — scripts/test-v2-*.js 를 전부 찾아 차례로 돌린다.
 *
 * ── 왜 package.json 에 한 줄씩 넣지 않는가 ──────────────────────────
 *
 * 여섯 기능이 서로 다른 PR 로 들어온다. 각자 npm test 체인 한 줄에 자기
 * 스크립트를 덧붙이면, 그 한 줄(= package.json "test")에서 PR 끼리 반드시
 * 충돌한다. 그래서 체인에는 이 러너 한 줄만 두고, 기능 PR 은 test-v2-*.js
 * 파일을 «추가» 만 한다 (docs/seosa2/CONTRACTS.md §4).
 *
 * ★ 자식 테스트도 SAFE 검사를 받는다. scripts/test-release.js 의 chainScripts
 *   가 이 러너를 만나면 test-v2-*.js 를 펼쳐서 fetch·운영 DB·delete 규칙을
 *   똑같이 검사한다. 러너가 검사의 사각지대가 되지 않는다.
 *
 * 하나라도 실패하면 exit 1. 전부 돌린 뒤 한꺼번에 알린다 (앞에서 멈추면
 * 뒤쪽 기능이 깨진 것을 모른 채 지나간다).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const PATTERN = /^test-v2-[\w-]+\.js$/;

function discover() {
  return fs.readdirSync(DIR).filter(f => PATTERN.test(f)).sort();
}

function main() {
  const files = discover();
  if (!files.length) {
    console.error('[seosa2] test-v2-*.js 를 하나도 찾지 못했다 — 러너가 헛돌고 있다');
    process.exitCode = 1;
    return;
  }
  const results = [];
  for (const f of files) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [path.join(DIR, f)], { stdio: 'inherit', env: process.env });
    results.push({ f, code: r.status == null ? 1 : r.status, ms: Date.now() - started });
  }
  console.log('\n==================== SEOSA 2.0 ====================');
  results.forEach(r => console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.f}  (${r.ms}ms)`));
  const failed = results.filter(r => r.code !== 0);
  console.log(`  합계  ${results.length - failed.length} PASS / ${failed.length} FAIL`);
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { discover, PATTERN };
