#!/usr/bin/env node
'use strict';
/* 사람이 읽기 위한 출력. node show.js tally | fails [type] [limit] | sample <verdict> <n> [category] | stats */
const fs = require('fs');
const path = require('path');
const DIR = path.resolve(__dirname, '../../reports/production-ai-5000');
const rd = p => fs.existsSync(path.join(DIR, p)) ? fs.readFileSync(path.join(DIR, p), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) : [];
const [cmd, a, b, c] = process.argv.slice(2);

function pct(s, q) { const x = s.slice().sort((m, n) => m - n); return x[Math.floor(x.length * q)] || 0; }
if (cmd === 'tally') {
  const E = rd('evaluations.jsonl');
  const t = {};
  E.forEach(e => { const k = t[e.category] = t[e.category] || { n: 0, PASS: 0, FAIL: 0, UNVERIFIED: 0, INFRA_ERROR: 0 }; k.n++; k[e.verdict]++; });
  Object.entries(t).forEach(([k, v]) => console.log(k.padEnd(10), 'n', v.n, 'P', v.PASS, 'F', v.FAIL, 'U', v.UNVERIFIED, 'I', v.INFRA_ERROR));
  const ty = {}; E.forEach(e => e.failTypes.forEach(x => { ty[x] = (ty[x] || 0) + 1; }));
  console.log(Object.entries(ty).sort((m, n) => n[1] - m[1]).map(([k, v]) => `${k}:${v}`).join(' | '));
  const nt = {}; E.filter(e => e.verdict === 'UNVERIFIED').forEach(e => [...new Set(e.notes.map(n => n.split(':')[0]))].forEach(x => { nt[x] = (nt[x] || 0) + 1; }));
  console.log('UNVERIFIED notes:', Object.entries(nt).sort((m, n) => n[1] - m[1]).map(([k, v]) => `${k}:${v}`).join(' | '));
}
if (cmd === 'stats') {
  const R = rd('responses.jsonl'), L = new Map(rd('server-logs.jsonl').map(l => [l.id, l]));
  const ms = R.map(r => r.ms);
  const logged = R.filter(r => L.has(r.requestId));
  const adp = {}, cou = {}; let gpt = 0, noObs = 0, usd = 0, inTok = 0, outTok = 0, classify = 0;
  logged.forEach(r => {
    const l = L.get(r.requestId);
    (l.adpick || []).forEach(x => { const k = x.decision + (x.http ? ':' + x.http : ''); adp[k] = (adp[k] || 0) + 1; });
    (l.coupang || []).forEach(x => { const k = x.decision + (x.http ? ':' + x.http : ''); cou[k] = (cou[k] || 0) + 1; });
    if (!l.obs) noObs++; else { if (l.obs.model && l.obs.model !== 'none') gpt++; usd += Number(l.obs.costUsd) || 0; inTok += Number(l.obs.inTok) || 0; outTok += Number(l.obs.outTok) || 0; }
  });
  const st = {}; R.forEach(r => { st[r.status] = (st[r.status] || 0) + 1; });
  const other = rd('other-traffic.json');
  console.log(JSON.stringify({ requests: R.length, attempts: R.reduce((s, r) => s + (r.attempts || 1), 0), status: st, ms: { mean: Math.round(ms.reduce((s, x) => s + x, 0) / (ms.length || 1)), p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(...ms) }, logMatched: logged.length, gptAnswered: gpt, modelNone: logged.length - noObs - gpt, obsMissing: noObs, usd: +usd.toFixed(4), inTok, outTok, adpick: adp, coupang: cou }, null, 1));
}
if (cmd === 'fails') {
  const F = rd('failures.jsonl').filter(f => !a || a === 'all' || f.fails.some(x => x.type === a));
  F.slice(0, Number(b || 15)).forEach(f => {
    console.log(`\n[${f.id} ${f.category}${f.session ? ' ' + f.session + '#' + f.turn + ' ' + f.step : ''}] ${[...new Set(f.fails.map(x => x.type))].join(',')}`);
    console.log('Q:', f.question);
    console.log('A:', String(f.answer).replace(/\n+/g, ' / ').slice(0, Number(c || 300)));
    f.cards.slice(0, 4).forEach(x => console.log('  -', x.price, String(x.title).slice(0, 62)));
    f.fails.slice(0, 2).forEach(x => console.log('  !', x.type, x.evidence.slice(0, 170)));
  });
  console.log('\ncount', F.length);
}
if (cmd === 'sample') {
  const E = rd('evaluations.jsonl').filter(e => e.verdict === a && (!c || e.category === c));
  const Q = new Map(rd('questions.jsonl').map(q => [q.id, q]));
  const R = new Map(rd('responses.jsonl').map(r => [r.id, r]));
  const step = Math.max(1, Math.floor(E.length / Number(b || 20)));
  E.filter((_, i) => i % step === 0).slice(0, Number(b || 20)).forEach(e => {
    const r = R.get(e.id);
    console.log(`\n[${e.id} ${e.category} ${e.step || ''}] ${e.notes.join('|').slice(0, 80)}`);
    console.log('Q:', Q.get(e.id).text);
    console.log('A:', String(r.response && r.response.text || '').replace(/\n+/g, ' / ').slice(0, 280));
    (r.response && r.response.items || []).slice(0, 3).forEach(x => console.log('  -', x.lprice, String(x.title).slice(0, 62)));
  });
}
