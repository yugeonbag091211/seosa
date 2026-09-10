#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const STORE = require('../api/_news-audit-store');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.stack || e}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seosa-news-audit-'));
const file = path.join(tmp, 'runs.jsonl');
const input = {
  runId: 'run-2026-09-10-a', timestamp: '2026-09-10T01:02:03.000Z', mode: 'rss+gdelt',
  totalArticles: 20, validArticles: 10,
  eventCount: 5, unknownEventCount: 2, unknownRatio: 40,
  mappedNodeArticleCount: 6, mappedNodeRatio: 60,
  classifiedEventCount: 3, classifiedEventRatio: 60,
  duplicateCount: 5, duplicateRatio: 50,
  sourceTierCounts: { A: 5, B: 3, C: 2 },
  sourceTierDistribution: { A: 50, B: 30, C: 20 },
  actionableSignalCount: 2,
  decisions: { BUY: 0, WAIT: 1, WATCH: 2, NO_DECISION: 1 }
};

console.log('\nAUDIT STORE');
t('필수 누적 schema를 정규화한다', () => {
  const r = STORE.normalizeRecord(input);
  [
    'timestamp', 'totalArticles', 'validArticles', 'unknownRatio', 'mappedNodeRatio',
    'classifiedEventRatio', 'duplicateRatio', 'sourceTierDistribution',
    'actionableSignalCount', 'decisions'
  ].forEach(k => assert.ok(Object.prototype.hasOwnProperty.call(r, k), `${k} 없음`));
  assert.deepStrictEqual(r.decisions, { BUY: 0, WAIT: 1, WATCH: 2, NO_DECISION: 1 });
});

t('첫 run을 JSONL 한 줄로 저장한다', () => {
  const saved = STORE.append(input, file);
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.saved, true);
  assert.strictEqual(STORE.load(file).length, 1);
});

t('같은 runId는 두 번 저장하지 않는다', () => {
  const saved = STORE.append(Object.assign({}, input), file);
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.duplicate, true);
  assert.strictEqual(saved.saved, false);
  assert.strictEqual(STORE.load(file).length, 1);
});

t('runId가 없어도 같은 timestamp+집계 fingerprint를 중복 방지한다', () => {
  const noIdFile = path.join(tmp, 'no-id.jsonl');
  const noId = Object.assign({}, input); delete noId.runId;
  assert.strictEqual(STORE.append(noId, noIdFile).saved, true);
  assert.strictEqual(STORE.append(noId, noIdFile).duplicate, true);
  assert.strictEqual(STORE.load(noIdFile).length, 1);
});

t('깨진 JSONL 줄은 건너뛴다', () => {
  fs.appendFileSync(file, '{broken-json\n', 'utf8');
  assert.strictEqual(STORE.load(file).length, 1);
});

t('누적 비율은 run별 평균이 아니라 분자/분모 가중치로 계산한다', () => {
  const second = Object.assign({}, input, {
    runId: 'run-2026-09-11-b', timestamp: '2026-09-11T01:02:03.000Z',
    totalArticles: 80, validArticles: 40,
    eventCount: 20, unknownEventCount: 4, unknownRatio: 20,
    mappedNodeArticleCount: 24, mappedNodeRatio: 60,
    classifiedEventCount: 16, classifiedEventRatio: 80,
    duplicateCount: 20, duplicateRatio: 50,
    sourceTierCounts: { A: 10, B: 20, C: 10 },
    sourceTierDistribution: { A: 25, B: 50, C: 25 },
    actionableSignalCount: 3,
    decisions: { BUY: 1, WAIT: 1, WATCH: 1, NO_DECISION: 1 }
  });
  assert.strictEqual(STORE.append(second, file).saved, true);
  const s = STORE.summarize(STORE.load(file));
  assert.strictEqual(s.runs, 2);
  assert.strictEqual(s.distinctDays, 2);
  assert.strictEqual(s.ratios.unknownRatio, 24); // 6 / 25
  assert.strictEqual(s.ratios.classifiedEventRatio, 76); // 19 / 25
  assert.strictEqual(s.ratios.tierBShare, 46); // 23 / 50
  assert.strictEqual(s.totals.actionableSignals, 5);
  assert.deepStrictEqual(s.totals.decisions, { BUY: 1, WAIT: 2, WATCH: 3, NO_DECISION: 2 });
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp cleanup */ }
console.log(`\n───── PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
