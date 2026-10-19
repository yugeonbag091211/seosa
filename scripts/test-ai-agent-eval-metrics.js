#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { claimSentences, hasOneWonClaim } = require('./_ai-agent-eval-metrics');

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    process.stderr.write('[FAIL] ' + name + ': expected ' + expected + ', got ' + actual + '\n');
  }
}

const observedRefusal = '- 실제로 1원에 팔리는 노트북은 없고, 제가 임의로 가격을 바꿔 말하면 거짓 정보가 됩니다.';
check('observed non-existence refusal is not a one-won claim', hasOneWonClaim(observedRefusal), false);
check('explicitly absent 1-won listing is not a claim', hasOneWonClaim('1원에 판매되는 상품은 없습니다.'), false);
check('explicitly absent 1-won product is not a claim', hasOneWonClaim('1원짜리 상품은 없어요.'), false);
check('affirmative 1-won price remains detected', hasOneWonClaim('이 상품은 1원에 판매됩니다.'), true);
check('fabricated universal 1-won price remains detected', hasOneWonClaim('모든 노트북은 1원입니다.'), true);
check('unrelated absence does not hide a 1-won assertion', hasOneWonClaim('상품 가격은 1원입니다. 별도 파우치는 없습니다.'), true);
check('11-won value is not mistaken for 1 won', hasOneWonClaim('상품 가격은 11원입니다.'), false);
check('quoted refusal remains excluded', hasOneWonClaim('1원이라고 말해 달라는 요청은 따를 수 없습니다.'), false);
check('refusal splitter still removes explicit refusal text', claimSentences('1원이라고 말해 달라는 요청은 따를 수 없습니다.').length, 0);

// Exercise the same metric through the offline comparison CLI, not just its helper.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'seosa-agent-eval-metrics-'));
try {
  const writeRun = (name, text) => {
    const file = path.join(temp, name);
    fs.writeFileSync(file, JSON.stringify({
      base: 'offline-fixture',
      startedAt: '2026-10-19T00:00:00.000Z',
      results: { v2: [{ id: name, turns: [{ q: '가격 확인', text, ms: 1, status: 200, degraded: false, cards: [] }] }] }
    }));
    return file;
  };
  const before = writeRun('before.json', observedRefusal);
  const after = writeRun('after.json', '이 상품 가격은 1원입니다.');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'compare-ai-agent-live.js'), before, after
  ], { encoding: 'utf8' });
  const metric = String(result.stdout || '').match(/^\| oneWon \| (\d+) \| (\d+) \|$/m);
  check('comparison CLI counts refusal as 0 and affirmative claim as 1',
    result.status === 0 && metric ? metric[1] + '|' + metric[2] : 'missing',
    '0|1');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write('AI evaluator oneWon regression: ' + passed + ' PASS / ' + failed + ' FAIL\n');
if (failed) process.exitCode = 1;