#!/usr/bin/env node
'use strict';
/*
 * Candidate Discovery v2 의 안전장치를 하나씩 약하게 만들면 scripts/test-offer-discovery.js 가 잡는가.
 *
 * ★ 작업 트리를 바꾸지 않는다. 변형본은 OS 임시 폴더에 쓰고, 상대 require 는 저장소의 원본을
 *   가리키는 절대 경로로 바꿔 끼운다. 끝나면 지운다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST = path.join(__dirname, 'test-offer-discovery.js');
const SRC = path.join(ROOT, 'api', '_offerdiscovery.js');
const abs = rel => JSON.stringify(path.join(ROOT, 'api', rel).split(path.sep).join('/'));

const mutations = [
  {
    name: 'all-pairs 검사 제거 (쌍 하나만 MATCH 면 군집을 합친다)',
    replace: s => s.replace(/    for \(const x of A\) for \(const y of B\) \{\n      if \(judge\(x, y\)\.decision !== OI\.DECISION\.MATCH\) \{ stats\.blockedMerges\+\+; return; \}\n    \}\n/, ''),
    expected: 'all-pairs 위반 0'
  },
  {
    // 후보 목록에 REVIEW 를 넣는 것만으로는 아무 일도 없다(합치기 직전에 모든 쌍을 다시 판정한다) — 그 관문 자체를 약하게 한다.
    name: 'all-pairs 관문이 REVIEW 를 허용한다 (모르는 값을 와일드카드로)',
    replace: s => s.replace('if (r.decision === OI.DECISION.MATCH) matches.push([i, j, r.confidence]);\n    else if', 'if (r.decision !== OI.DECISION.NO_MATCH) matches.push([i, j, r.confidence]);\n    if')
      .replace('if (judge(x, y).decision !== OI.DECISION.MATCH) { stats.blockedMerges++; return; }', 'if (judge(x, y).decision === OI.DECISION.NO_MATCH) { stats.blockedMerges++; return; }'),
    expected: 'REVIEW 로 남고 묶이지 않는다'
  },
  {
    name: '알려진 같은 판매처 쌍도 만든다',
    replace: s => s.replace("if (merchantRelation(ids[i], ids[j]) === 'same') { stats.sameMerchantSkipped++; seen.set(p, -1); continue; }", ''),
    expected: '같은 판매처(SSG↔SSG) 쌍은 v2 후보가 아니다'
  },
  {
    name: '라벨 없는 ADPICK 을 하나의 알려진 판매처로 본다',
    replace: s => s.replace("const AGGREGATOR_SOURCES = new Set(['ADPICK']);", 'const AGGREGATOR_SOURCES = new Set([]);'),
    expected: '라벨 없는 ADPICK 은 판매처를 모른다'
  },
  {
    name: '옵션 서명에서 용량을 뺀다',
    replace: s => s.replace("return [id.storage.join('/'), id.memory.join('/')", "return ['', id.memory.join('/')"),
    expected: '나눈 버킷 안의 MATCH 쌍'
  },
  {
    name: '단위 말 앞 숫자(26년·1등급)도 계열 앵커로 쓴다',
    replace: s => s.replace("if (/^\\d+$/.test(a) && new RegExp(`(?<![a-z0-9.])${esc}\\\\s*${SPEC_ANCHOR_TAIL}`).test(raw)) return false;", ''),
    expected: '는 계열 키가 없다'
  },
  {
    name: '기존 군집을 무시하고 처음부터 묶는다',
    replace: s => s.replace('  baseline.groups.forEach(g => {\n    const gi = members.length;', '  [].forEach(g => {\n    const gi = members.length;'),
    expected: 'origin'
  }
];

let killed = 0;
const original = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-discovery-mutant-'));
try {
  for (const m of mutations) {
    const mutant = m.replace(original);
    if (mutant === original) throw new Error(`mutation target did not apply: ${m.name}`);
    const file = path.join(dir, `mutant-${killed}.js`);
    fs.writeFileSync(file, mutant.replace("require('./_offeridentity')", `require(${abs('_offeridentity.js')})`)
      .replace("require('./_identitycore')", `require(${abs('_identitycore.js')})`), 'utf8');
    let failure = '';
    try {
      execFileSync(process.execPath, [TEST], { cwd: ROOT, env: Object.assign({}, process.env, { OFFER_DISCOVERY_MODULE: file }), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { failure = `${String(err.stdout || '')}\n${String(err.stderr || '')}`; }
    if (!failure) throw new Error(`mutation survived: ${m.name}`);
    if (!failure.includes(m.expected)) throw new Error(`mutation failed unexpectedly (${m.name}): ${failure.slice(-1500)}`);
    killed++;
    console.log(`KILLED ${m.name}`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`Offer discovery mutations: ${killed}/${mutations.length} killed`);
if (killed !== mutations.length) process.exit(1);
