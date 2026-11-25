#!/usr/bin/env node
'use strict';

/*
 * 판매 대상(본품) 봉인 세트 채점 — reports/search-sold-object-2026-11-24/PROTOCOL.md
 *
 * 한 번의 실행에서 운영 main · PR #265 원본 · Stage 1 · 최종본과, 최종본에서 구성 요소를
 * 하나씩 뺀 변형을 모두 채점한다. 외부 호출 0 · DB 조회 0.
 *
 * 입력
 *   --labels <holdout-labels.json>   봉인 라벨 (sha256 을 먼저 확인한다)
 *   --lists  <lists.json>            검색어 → 후보 목록(운영 공급자 캐시에서 만든 것)
 *   --module <name>=<path> …         채점할 _search.js 들
 *   --out <report.json>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; }
function args(name) { const out = []; process.argv.forEach((a, i) => { if (a === name) out.push(process.argv[i + 1]); }); return out; }

const EXPECTED_SHA = '9e1957ce1433e99b8d94e2d8664314f12cc42f679ccc8b5d9bb8153b48bed777';
const labelsPath = arg('--labels');
const raw = fs.readFileSync(labelsPath);
// 체크아웃 줄바꿈과 무관하게 커밋된 바이트로 확인한다.
const sha = crypto.createHash('sha256').update(raw.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
if (sha !== EXPECTED_SHA) { console.error(`label hash mismatch: ${sha}`); process.exit(2); }
const labels = JSON.parse(raw.toString('utf8'));
const lists = JSON.parse(fs.readFileSync(arg('--lists'), 'utf8'));
const modules = args('--module').map(spec => {
  const at = spec.indexOf('=');
  return { name: spec.slice(0, at), S: require(path.resolve(spec.slice(at + 1))) };
});

function rankWith(S, q) {
  const src = lists[q.query];
  const items = src.map(it => ({ ...it }));
  const res = S.rankItems(q.query, items, { minScore: 0 });
  return S.sortByRelevance(res.items).map(it => it.productId);
}

const labelOf = new Map();
labels.queries.forEach(q => q.items.forEach(it => labelOf.set(q.query + '\u0000' + it.id, it.label[0])));
const L = (q, id) => labelOf.get(q.query + '\u0000' + id) || '?';

const results = {};
for (const { name, S } of modules) {
  results[name] = {};
  for (const q of labels.queries) results[name][q.query] = rankWith(S, q);
}

function metrics(name, baseline) {
  const qs = labels.queries.filter(q => q.items.some(it => it.label[0] === 'M'));
  let top1 = 0, p3 = 0, p5 = 0, x3 = 0, slots3 = 0;
  let mBase = 0, mMiss = 0, relBase = 0, relMiss = 0;
  const flipsToX = [], top1Changes = [];
  for (const q of qs) {
    const ranked = results[name][q.query];
    const nM = q.items.filter(it => it.label[0] === 'M').length;
    const lab = ranked.map(id => L(q, id));
    if (lab[0] === 'M') top1++;
    p3 += lab.slice(0, 3).filter(l => l === 'M').length / Math.min(3, nM);
    p5 += lab.slice(0, 5).filter(l => l === 'M').length / Math.min(5, nM);
    lab.slice(0, 3).forEach(l => { slots3++; if (l === 'X') x3++; });
    const base = results[baseline][q.query];
    const kept = new Set(ranked);
    base.forEach(id => {
      const l = L(q, id);
      if (l === 'M') { mBase++; if (!kept.has(id)) mMiss++; }
      if (l === 'M' || l === 'V' || l === 'A') { relBase++; if (!kept.has(id)) relMiss++; }
    });
    const b0 = L(q, base[0]), n0 = lab[0];
    if (b0 === 'M' && n0 === 'X') flipsToX.push(q.query);
    if (base[0] !== ranked[0]) top1Changes.push({ query: q.query, from: b0, to: n0 });
  }
  return {
    queries: qs.length,
    top1M: +(top1 / qs.length).toFixed(4), top1MCount: top1,
    p3: +(p3 / qs.length).toFixed(4), p5: +(p5 / qs.length).toFixed(4),
    x3: +(x3 / slots3).toFixed(4), x3Count: x3,
    mOmission: +(mBase ? mMiss / mBase : 0).toFixed(4), mMissing: mMiss,
    relatedOmission: +(relBase ? relMiss / relBase : 0).toFixed(4), relatedMissing: relMiss,
    flipsMtoX: flipsToX, top1Changes
  };
}

const baseline = 'main';
const table = {};
for (const { name } of modules) table[name] = metrics(name, baseline);

/* 구성 요소별 판정: 최종본 vs «그 구성 요소만 뺀» 최종본 (PROTOCOL.md 의 1~5). */
const verdicts = {};
for (const { name } of modules) {
  if (!name.startsWith('final-minus-')) continue;
  const comp = name.slice('final-minus-'.length);
  const W = table.final, O = table[name];
  // 5번: 그 구성 요소를 넣었을 때 1위가 M → X 로 바뀐 검색어
  const flips = labels.queries.filter(q => {
    const a = results[name][q.query], b = results.final[q.query];
    return a.length && b.length && L(q, a[0]) === 'M' && L(q, b[0]) === 'X';
  }).map(q => q.query);
  const c = {
    '1_noNewMainOmission': W.mMissing <= O.mMissing,
    '2_noNewRelatedOmission': W.relatedMissing <= O.relatedMissing,
    '3_top1NotLower': W.top1M >= O.top1M,
    '4_p5NotLower': W.p5 >= O.p5,
    '5_noMtoXFlip': flips.length === 0
  };
  verdicts[comp] = { keep: Object.values(c).every(Boolean), criteria: c, withComponent: { top1M: W.top1M, p5: W.p5, mMissing: W.mMissing, relatedMissing: W.relatedMissing }, without: { top1M: O.top1M, p5: O.p5, mMissing: O.mMissing, relatedMissing: O.relatedMissing }, flipsMtoX: flips };
}

const report = { protocol: labels.protocol, labelsSha256: sha, ranAt: new Date().toISOString(), baseline, externalCalls: 0, dbQueries: 0, table, verdicts };
const out = arg('--out');
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1) + '\n');

console.log('config'.padEnd(24), 'top1M', '  P@3 ', '  P@5 ', '  X@3 ', ' M-miss', ' rel-miss', ' M→X');
for (const [name, m] of Object.entries(table)) {
  console.log(name.padEnd(24), m.top1M.toFixed(3), ' ', m.p3.toFixed(3), ' ', m.p5.toFixed(3), ' ', m.x3.toFixed(3), '  ', String(m.mMissing).padStart(4), '   ', String(m.relatedMissing).padStart(4), '    ', m.flipsMtoX.length);
}
console.log('\nper-component verdict (final vs final-minus-component):');
for (const [comp, v] of Object.entries(verdicts)) {
  console.log(`  ${comp.padEnd(14)} ${v.keep ? 'KEEP' : 'DROP'}  ${JSON.stringify(v.criteria)}  with ${JSON.stringify(v.withComponent)} without ${JSON.stringify(v.without)}${v.flipsMtoX.length ? ' flips ' + v.flipsMtoX.join('|') : ''}`);
}
