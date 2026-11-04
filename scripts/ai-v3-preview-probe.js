#!/usr/bin/env node
'use strict';
// Explicit opt-in only. Uses protected Vercel CLI auth; performs PAID GPT calls.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const deployment = process.argv[2];
if (process.env.AI_V3_ALLOW_PAID_SMOKE !== '1' ||
    !/^https:\/\/seosa-[a-z0-9-]+-seosa\.vercel\.app$/.test(deployment || '')) {
  throw new Error('Require AI_V3_ALLOW_PAID_SMOKE=1 and an explicit approved Preview deployment URL');
}
const cli = 'C:\\nvm4w\\nodejs\\node_modules\\vercel\\dist\\vc.js';
const dir = mkdtempSync(path.join(tmpdir(), 'seosa-v3-online-'));
const tests = [
  { id: 'budget', message: '80만원 이하 사무용 노트북 추천해줘. 게이밍 제외' },
  { id: 'compare', message: '아이패드와 갤럭시탭 비교해줘' },
  { id: 'ipad', message: '아이패드 추천해줘' },
  { id: 'followup', message: '그중에서 70만원 이하로 골라줘', stateFrom: 'budget' }
];
const seen = {};
let allOk = true;
try {
  const only = process.argv[3] || 'all';
  for (const t of tests.filter(x => only === 'all' || x.id === only)) {
    const file = path.join(dir, t.id + '.json');
    const request = { message: t.message, history: [], state: t.stateFrom ? (seen[t.stateFrom]?.state || {}) : {} };
    writeFileSync(file, JSON.stringify(request), 'utf8');
    const begin = performance.now();
    const run = spawnSync(process.execPath, [
      cli, 'curl', '/api/ai?v=3', '--deployment', deployment, '--',
      '--request', 'POST', '--header', 'Content-Type: application/json',
      '--data-binary', '@' + file, '--max-time', '60', '--silent', '--show-error'
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 75000, maxBuffer: 4 * 1024 * 1024 });
    const elapsedMs = Math.round(performance.now() - begin);
    let reply;
    try { reply = JSON.parse(String(run.stdout || '').trim()); }
    catch (e) {
      allOk = false;
      console.log(JSON.stringify({ test: t.id, status: 'unparseable', elapsedMs, cliExit: run.status,
        stderrCode: run.error ? String(run.error.code) : 'none', stdoutLength: (run.stdout||'').length }));
      break;
    }
    seen[t.id] = reply;
    const cards = Array.isArray(reply.cards) ? reply.cards : [];
    const answer = String(reply.answer || '');
    const totals = cards.map(c => ({
      id: c.productId,
      listingPrice: c.price,
      shippingKnown: c.shippingFee !== null,
      budgetStatus: c.budgetStatus,
      used: c.condition === 'used_or_refurbished'
    }));
    const s = reply.stats || {};
    const flags = {
      mentionedShipping: answer.includes('배송비'),
      mentionedPriceDifference: answer.includes('낮습니다') || answer.includes('가격은 같습니다'),
      warnedBudgetNotGuaranteed: answer.includes('보장할 수 없'),
      answerIncludesFirstCard: !!cards[0] && answer.includes(String(cards[0].title)),
      answerIncludesLastCard: !!cards.at(-1) && answer.includes(String(cards.at(-1).title)),
      noUsedProducts: !totals.some(x => x.used)
    };
    console.log(JSON.stringify({
      test: t.id, elapsedMs, responseStatus: reply.status, error: reply.error || null,
      cards: cards.length, fetched: s.fetched ?? null, inspected: s.inspected ?? null,
      accepted: s.accepted ?? null, provisional: s.provisional ?? null,
      rejected: s.rejected ?? null, rejectReasons: s.rejectedReasons || {},
      modelUsage: s.modelUsage || null, flags, totals
    }));
    if (reply.status !== 200 || run.status !== 0) allOk = false;
  }
} finally { rmSync(dir, { force: true, recursive: true }); }
process.exitCode = allOk ? 0 : 1;
