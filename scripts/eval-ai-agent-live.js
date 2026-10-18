#!/usr/bin/env node
/**
 * AI Concierge v1 ↔ v2 실측 비교 (Preview 배포 대상, 실제 OpenAI·쿠팡·DB 사용 → 비용 발생).
 *
 *   AI_EVAL_BASE_URL=https://<preview>.vercel.app node scripts/eval-ai-agent-live.js
 *
 * 같은 대화를 두 엔진에 그대로 보낸다.
 *   v1  헤더 없음 (Preview 의 AI_CONCIERGE_V2_ENABLED 가 비어 있어야 v1 이 된다)
 *   v2  `x-seosa-ai-engine: v2` + `x-seosa-ai-debug: 1` (Production 에서는 둘 다 무시된다)
 * 게스트(로그인 없음)로 보낸다 — 운영과 같은 레이트리밋(분당 30회)을 지키도록 요청 사이를 띄운다.
 *
 * 기록하는 것(지어내지 않는다 — 응답에 없는 값은 null):
 *   답변 원문 · 카드(상품명·가격·productId) · 왕복 지연 · degraded · v2 의 _debug
 *   (라운드·도구 호출·토큰·추정 비용·첫 검증 문제·최종 결과)
 * 자동 판정은 정의가 분명한 것만 한다(아래 CHECKS). 나머지 «적절성» 은 사람이 리포트를 읽고 본다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = String(process.env.AI_EVAL_BASE_URL || '').replace(/\/+$/, '');
/*
 * Preview 가 Vercel Authentication 으로 보호돼 있으면 401 이 난다. Vercel 프로젝트 설정 →
 * Deployment Protection → «Protection Bypass for Automation» 의 비밀값을 이 환경변수로 넘기면
 * x-vercel-protection-bypass 헤더로 보낸다. 값은 출력·기록하지 않는다.
 */
const BYPASS = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
const PAUSE_MS = Number(process.env.AI_EVAL_PAUSE_MS) || 2500;
const ENGINES = String(process.env.AI_EVAL_ENGINES || 'v1,v2').split(',').map(s => s.trim()).filter(Boolean);
const Tools = require('../api/_agenttools');

if (!/^https:\/\//.test(BASE)) {
  console.error('AI_EVAL_BASE_URL 에 Preview 배포 주소(https://…)를 넣어 주세요.');
  process.exit(2);
}

/* 대화 시나리오 — 지시서 12항 A·B 와 1항의 실제 사고 두 건 */
const DIALOGS = [
  { id: 'A1-value-laptop', turns: ['성능좋고 가장 가성비인 노트북 최저가 알려줘', '지금 사는 게 좋을까?'] },
  { id: 'A2-cheapest-laptop', turns: ['가장 저렴한 노트북 알려줘'] },
  { id: 'A3-doc-laptop-500k', turns: ['50만원 이하 문서 작업용 노트북 추천해줘'] },
  { id: 'A4-gaming-laptop-1m', turns: ['100만원 이하 게임용 노트북 추천해줘'] },
  { id: 'A5-anc-headphone-300k', turns: ['30만원 이하 노이즈 캔슬링 헤드폰 추천해줘'] },
  { id: 'A6-value-mouse', turns: ['가성비 좋은 무선 마우스 추천해줘'] },
  { id: 'B1-cheaper', turns: ['성능 좋은 가성비 노트북 추천해줘', '더 싼 거 없어?'] },
  { id: 'B2-second', turns: ['20만원 이하 무선 이어폰 두 개만 추천해줘', '두 번째 거 지금 사도 돼?'] },
  { id: 'B3-chat-then-ref', turns: ['무선 마우스 추천해줘', 'CPU랑 GPU 차이가 뭐야?', '아까 추천한 첫 번째 제품 지금 사도 돼?'] },
  { id: 'B4-switch', turns: ['노트북 추천해줘', '무선 마우스도 추천해줘', '지금 사는 게 좋을까?'] },
  { id: 'G1-knowledge', turns: ['인텔이랑 AMD 차이를 쉽게 설명해줘', '대학생에게 RAM 8GB 충분해?'] },
  { id: 'G2-pushback', turns: ['가성비 좋은 블루투스 스피커 추천해줘', '방금 추천한 거 별로인 것 같은데?', '추천해준 상품의 단점 알려줘'] }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(engine, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (BYPASS) headers['x-vercel-protection-bypass'] = BYPASS;
  if (engine === 'v2') { headers['x-seosa-ai-engine'] = 'v2'; headers['x-seosa-ai-debug'] = '1'; }
  const started = Date.now();
  let status = 0, json = null, error = '';
  try {
    const res = await fetch(`${BASE}/api/ai`, { method: 'POST', headers, body: JSON.stringify(body) });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch (e) {
    error = String(e && e.message || e).slice(0, 120);
  }
  return { status, json, error, ms: Date.now() - started };
}

async function runDialog(engine, dialog) {
  const state = { history: [], ref: '', top: '' };
  const turns = [];
  for (const q of dialog.turns) {
    state.history.push({ role: 'user', text: q });
    const r = await post(engine, {
      question: q, contextProducts: [], chatHistory: state.history.slice(-10), view: { source: 'none' },
      prevTop: state.top, prevTopRef: state.ref
    });
    const b = r.json || {};
    const cards = Array.isArray(b.items) ? b.items.map(it => ({
      title: String(it.title || '').slice(0, 80), price: it.lprice, productId: it.productId, mall: it.mallLabel || it.mall,
      cpuClass: Tools.pcSpecs(it.title).cpu_class_general || null
    })) : [];
    turns.push({
      q, status: r.status, ms: r.ms, error: r.error, engineSeen: b.engine || 'v1',
      text: String(b.text || ''), degraded: b.degraded === true, intent: b.intent || null,
      cards, top: b.topRecommendation ? b.topRecommendation.index : null, followups: b.followups || [],
      debug: b._debug || null
    });
    const turn = { role: 'assistant', text: b.text || '' };
    if (b.turnSig) turn.sig = b.turnSig;
    state.history.push(turn);
    if (b.topProductId) state.top = String(b.topProductId);
    state.ref = String(b.topRecommendationRef || '');
    await sleep(PAUSE_MS);
  }
  return turns;
}

/* 정의가 분명한 자동 판정만. 통과/실패가 아니라 «관찰» 로 적는다. */
const CHECKS = {
  notFoundAfterRecommendation: t => /찾지 못했|확인하지 못했|찾을 수 없/.test(t.text),
  globalLowestClaim: t => /(?:인터넷|온라인|전체|업계|시중)\s*\S{0,6}(?:최저가|가장\s*(?:싸|저렴))/.test(t.text) && !/아니/.test(t.text),
  allTimeLowClaim: t => /(?:역대|사상)\s*최저/.test(t.text),
  hasUrl: t => /https?:\/\//.test(t.text),
  entryCpuTopPick: t => t.cards.length > 0 && (t.top === 0 || t.top === null) && t.cards[0].cpuClass === 'entry'
};

function summarize(results) {
  const rows = [];
  for (const engine of Object.keys(results)) {
    const all = results[engine].flatMap(d => d.turns);
    const ms = all.map(t => t.ms).sort((a, b) => a - b);
    const pct = p => ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : null;
    const dbg = all.map(t => t.debug).filter(Boolean);
    rows.push({
      engine,
      turns: all.length,
      engineActuallyUsed: [...new Set(all.map(t => t.engineSeen))].join(','),
      http200: all.filter(t => t.status === 200).length,
      degraded: all.filter(t => t.degraded).length,
      p50ms: pct(0.5), p90ms: pct(0.9), maxMs: ms.length ? ms[ms.length - 1] : null,
      notFound: all.filter(CHECKS.notFoundAfterRecommendation).length,
      globalLowest: all.filter(CHECKS.globalLowestClaim).length,
      allTimeLow: all.filter(CHECKS.allTimeLowClaim).length,
      urls: all.filter(CHECKS.hasUrl).length,
      entryCpuTopPickOnValueLaptop: results[engine].filter(d => d.id === 'A1-value-laptop').map(d => CHECKS.entryCpuTopPick(d.turns[0])).join(','),
      v2Rewrites: dbg.filter(x => x.rewrite).length,
      v2Outcomes: dbg.reduce((m, x) => { m[x.outcome] = (m[x.outcome] || 0) + 1; return m; }, {}),
      v2FirstIssueKinds: dbg.reduce((m, x) => { (x.firstIssues || []).forEach(k => { m[k] = (m[k] || 0) + 1; }); return m; }, {}),
      v2InTok: dbg.reduce((s, x) => s + (x.inTok || 0), 0),
      v2OutTok: dbg.reduce((s, x) => s + (x.outTok || 0), 0),
      v2CostUsd: Math.round(dbg.reduce((s, x) => s + (x.costUsd || 0), 0) * 1e6) / 1e6,
      v2ToolCalls: dbg.reduce((m, x) => { Object.entries(x.toolCalls || {}).forEach(([k, v]) => { m[k] = (m[k] || 0) + v; }); return m; }, {})
    });
  }
  return rows;
}

function markdown(results, rows, startedAt) {
  const L = [`# AI Concierge v1 ↔ v2 실측 비교`, '', `- 대상: ${BASE}`, `- 시작: ${new Date(startedAt).toISOString()}`, `- 엔진: ${ENGINES.join(', ')}`, ''];
  L.push('## 요약 (자동 집계 — 정의는 scripts/eval-ai-agent-live.js CHECKS)', '');
  L.push('| 항목 | ' + rows.map(r => r.engine).join(' | ') + ' |');
  L.push('|---|' + rows.map(() => '---').join('|') + '|');
  const keys = ['engineActuallyUsed', 'turns', 'http200', 'degraded', 'p50ms', 'p90ms', 'maxMs', 'notFound', 'globalLowest', 'allTimeLow', 'urls',
    'entryCpuTopPickOnValueLaptop', 'v2Rewrites', 'v2Outcomes', 'v2FirstIssueKinds', 'v2InTok', 'v2OutTok', 'v2CostUsd', 'v2ToolCalls'];
  keys.forEach(k => L.push(`| ${k} | ` + rows.map(r => typeof r[k] === 'object' ? '`' + JSON.stringify(r[k]) + '`' : String(r[k])).join(' | ') + ' |'));
  L.push('', '## 대화별 원문', '');
  DIALOGS.forEach(d => {
    L.push(`### ${d.id}`, '');
    d.turns.forEach((q, i) => {
      L.push(`**사용자:** ${q}`, '');
      Object.keys(results).forEach(engine => {
        const t = (results[engine].find(x => x.id === d.id) || { turns: [] }).turns[i];
        if (!t) return;
        L.push(`- **${engine}** (${t.engineSeen}, ${t.ms}ms${t.degraded ? ', degraded' : ''}${t.debug ? `, ${t.debug.outcome}, 도구 ${JSON.stringify(t.debug.toolCalls)}` : ''})`);
        L.push('', '  > ' + t.text.replace(/\n/g, '\n  > '), '');
        if (t.cards.length) L.push('  카드: ' + t.cards.map((c, j) => `${j === t.top ? '★' : ''}${c.title} ${c.price}원${c.cpuClass ? `(${c.cpuClass})` : ''}`).join(' / '), '');
      });
    });
  });
  return L.join('\n');
}

(async () => {
  const startedAt = Date.now();
  // 보호된 Preview 에 비밀값 없이 50번 보내지 않는다 — 한 번 확인하고 멈춘다.
  const probe = await post('v1', { question: '안녕', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  if (probe.status === 401) {
    console.error('Preview 가 Vercel Authentication 으로 보호돼 있다(401). VERCEL_AUTOMATION_BYPASS_SECRET 을 설정하고 다시 실행하세요.');
    process.exit(3);
  }
  const results = {};
  for (const engine of ENGINES) {
    results[engine] = [];
    for (const d of DIALOGS) {
      process.stdout.write(`${engine} ${d.id} … `);
      const turns = await runDialog(engine, d);
      results[engine].push({ id: d.id, turns });
      console.log(turns.map(t => `${t.status}/${t.engineSeen}/${t.ms}ms`).join(' '));
    }
  }
  const rows = summarize(results);
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `ai-agent-v1-v2-live-${stamp}.json`);
  const mdPath = path.join(outDir, `ai-agent-v1-v2-live-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ base: BASE, startedAt, rows, results }, null, 2));
  fs.writeFileSync(mdPath, markdown(results, rows, startedAt));
  console.table(rows.map(r => ({ engine: r.engine, used: r.engineActuallyUsed, p50: r.p50ms, p90: r.p90ms, degraded: r.degraded, notFound: r.notFound, cost: r.v2CostUsd })));
  console.log(`\n기록: ${path.relative(process.cwd(), mdPath)}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
