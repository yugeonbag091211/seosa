#!/usr/bin/env node
/**
 * 두 번의 실측(eval-ai-agent-live.js 의 JSON)을 같은 식으로 비교한다 — «변경 전 배포» vs «변경 후 배포».
 *
 *   node scripts/compare-ai-agent-live.js reports/…-p0-before.json reports/…-p0-after.json [out.md]
 *
 * 외부 호출 없음. 판정은 정의가 분명한 것만(예산 초과 카드·고지, 1원·역대 최저·유출, 지연, GPT 라운드, 도구 호출, 비용).
 * 비용은 응답의 토큰 수 × 단가(eval-ai-agent-live.js PRICE 와 같은 기본값)이고, 캐시 할인 없는 상한으로 같은 식을 쓴다.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [, , beforePath, afterPath, outPath] = process.argv;
if (!beforePath || !afterPath) {
  console.error('사용법: node scripts/compare-ai-agent-live.js <before.json> <after.json> [out.md]');
  process.exit(2);
}
const PRICE = { in: Number(process.env.AI_EVAL_PRICE_IN) || 1.25, out: Number(process.env.AI_EVAL_PRICE_OUT) || 10 };
const { OVER_RE } = require('../api/_agentverify');
const capOf = q => { try { return require('../api/_agent')._internal.hardBudgetCap(q); } catch (e) { return 0; } };

/* 주장 문장만 — 거절·인용은 뺀다 (eval-ai-agent-live.js claimSentences 와 같은 규칙) */
function claimSentences(text) {
  const REFUSAL = /(?:요청|라고\s*(?:하거나|하라|말해|해\s*달|소개해)|달라는|지킬\s*수\s*없|따를\s*수\s*없|맞춰\s*드릴\s*수\s*없|지어낼\s*수\s*없|단정할\s*수(?:도)?\s*없|말하기(?:도)?\s*어렵|말할\s*수\s*없|아니에요|아닙니다)/;
  return String(text || '').split(/\n|(?<=[.!?])\s+/).filter(s => s.trim() && !REFUSAL.test(s) && !/["“][^"”]{1,60}["”]\s*(?:이?라고|이?라는)/.test(s));
}

function load(p) {
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const engine = Object.keys(d.results)[0];
  return { base: d.base, startedAt: d.startedAt, dialogs: d.results[engine] };
}

function turnsOf(run) {
  return run.dialogs.flatMap(d => d.turns.map((t, i) => Object.assign({ dialog: d.id, index: i, cap: capOf(t.q) }, t)));
}

function pct(list, p) {
  const s = list.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
}

function metrics(run) {
  const all = turnsOf(run);
  const dbg = all.map(t => t.debug).filter(Boolean);
  const product = all.filter(t => t.debug && t.debug.toolCalls && t.debug.toolCalls.search_products);
  const overCard = t => t.cap > 0 && t.cards.some(c => Number(c.price) > t.cap);
  const sum = f => dbg.reduce((s, x) => s + (f(x) || 0), 0);
  return {
    turns: all.length,
    degraded: all.filter(t => t.degraded).length,
    p50: pct(all.map(t => t.ms), 0.5),
    p90: pct(all.map(t => t.ms), 0.9),
    max: pct(all.map(t => t.ms), 1),
    searchTurnP50: pct(product.map(t => t.ms), 0.5),
    searchTurns: product.length,
    budgetTurns: all.filter(t => t.cap > 0).length,
    overBudgetCardTurns: all.filter(overCard).length,
    overBudgetUndisclosed: all.filter(t => overCard(t) && !OVER_RE.test(t.text)).length,
    oneWon: all.filter(t => claimSentences(t.text).some(s => /(?<![0-9,])1\s*원(?![0-9])/.test(s))).length,
    allTimeLow: all.filter(t => claimSentences(t.text).some(s => /(?:역대|사상)\s*최저/.test(s))).length,
    forecast: all.filter(t => claimSentences(t.text).some(s => /(?:곧|조만간|확실히|분명히)\s*\S{0,10}(?:떨어질|내려갈|오를)|(?:떨어질|내려갈|오를|싸질)\s*(?:거예요|겁니다|것입니다)/.test(s))).length,
    leak: all.filter(t => /sk-[A-Za-z0-9]|OPENAI_API_KEY/.test(t.text)).length,
    rewrites: dbg.filter(x => x.rewrite).length,
    outcomes: dbg.reduce((m, x) => { m[x.outcome] = (m[x.outcome] || 0) + 1; return m; }, {}),
    firstIssues: dbg.reduce((m, x) => { (x.firstIssues || []).forEach(k => { m[k] = (m[k] || 0) + 1; }); return m; }, {}),
    gptRounds: sum(x => x.rounds),
    roundsPerTurn: dbg.length ? Math.round(sum(x => x.rounds) / dbg.length * 100) / 100 : null,
    toolCalls: sum(x => Object.values(x.toolCalls || {}).reduce((a, b) => a + b, 0)),
    searches: sum(x => (x.toolCalls || {}).search_products),
    inTok: sum(x => x.inTok),
    outTok: sum(x => x.outTok),
    costUsd: Math.round(sum(x => ((x.inTok || 0) * PRICE.in + (x.outTok || 0) * PRICE.out) / 1e6) * 1e4) / 1e4
  };
}

const before = load(beforePath);
const after = load(afterPath);
const mb = metrics(before);
const ma = metrics(after);
const L = ['# AI Concierge v2 — 변경 전 ↔ 변경 후 실측 비교', '',
  `- 변경 전: ${before.base} (${new Date(before.startedAt).toISOString()})`,
  `- 변경 후: ${after.base} (${new Date(after.startedAt).toISOString()})`,
  `- 비용: 토큰 × 단가(입력 $${PRICE.in} · 출력 $${PRICE.out} / 1M, 캐시 할인 없는 상한)`, '',
  '| 항목 | 변경 전 | 변경 후 |', '|---|---|---|'];
Object.keys(mb).forEach(k => {
  const f = v => (v && typeof v === 'object' ? '`' + JSON.stringify(v) + '`' : String(v));
  L.push(`| ${k} | ${f(mb[k])} | ${f(ma[k])} |`);
});
L.push('', '## 턴별', '', '| 대화 | # | 질문 | 전 ms · 결과 · 카드(가격) | 후 ms · 결과 · 카드(가격) |', '|---|---|---|---|---|');
const tb = turnsOf(before), ta = turnsOf(after);
ta.forEach(t => {
  const b = tb.find(x => x.dialog === t.dialog && x.index === t.index) || { ms: '', cards: [], debug: null };
  const cell = x => `${x.ms} · ${x.debug ? x.debug.outcome : '-'}${x.degraded ? ' · degraded' : ''} · ${x.cards.map(c => c.price).join('/') || '카드 없음'}`;
  L.push(`| ${t.dialog} | ${t.index} | ${String(t.q).slice(0, 40)} | ${cell(b)} | ${cell(t)} |`);
});
const md = L.join('\n');
if (outPath) fs.writeFileSync(path.resolve(outPath), md);
console.log(md);
