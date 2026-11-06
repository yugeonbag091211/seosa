'use strict';
// Live GPT runner for the v3.x Preview (protected). Calls POST /api/ai?v=3
// through `vercel curl` (automatic protection bypass), without a shell, so
// Korean request bodies are passed byte-exact via --data-binary @file.
//
//   node scripts/ai-v32-eval/run-live.js --deployment <preview-url> --cases online200|holdout|smoke
//        --out <results.jsonl> [--max-tokens 1500000] [--delay-ms 5600]
//
// Safety:
//  * Preview only: refuses production domains.
//  * Never prints secrets; the CLI handles bypass tokens internally.
//  * Usage guard: stops when cumulative model tokens exceed --max-tokens.
//  * Resumable: rows already in --out (same ids/questions) are kept.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const deployment = arg('deployment');
const kind = arg('cases', 'smoke');
const out = arg('out');
const maxTokens = Number(arg('max-tokens', '1500000'));
const delayMs = Number(arg('delay-ms', '5600'));
const vc = arg('vc', 'C:/nvm4w/nodejs/node_modules/vercel/dist/vc.js');
const shim = arg('shim');
const cwd = arg('cwd', 'C:/Users/yugeo/seosa');
if (!deployment || !/^https:\/\/seosa-[a-z0-9-]+-seosa\.vercel\.app$/.test(deployment)) throw new Error('--deployment must be a seosa Preview URL');
if (!out) throw new Error('--out required');

function cases() {
  if (kind === 'holdout') return require('./holdout-cases').cases;
  const all = require('../ai-v31-online-200-cases').cases;
  if (kind === 'smoke') {
    // 10 questions covering every fixed mechanism (intent, guitar, compare,
    // price lookup, model codes, follow-up chain, explanation question).
    const ids = new Set(['N011', 'N022', 'N048', 'N070', 'N157', 'N162', 'N181', 'N182', 'N183', 'N194']);
    return all.filter(c => ids.has(c.id));
  }
  return all;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function call(body) {
  const tmp = path.join(os.tmpdir(), 'seosa-ai-body-' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify(body));
  const args = [...(shim ? ['--require', shim] : []), vc, 'curl', '/api/ai?v=3', '--deployment', deployment, '--yes', '--',
    '-s', '-X', 'POST', '-H', 'content-type: application/json', '--data-binary', '@' + tmp, '-w', '\n__HTTP__%{http_code}', '--max-time', '70'];
  return new Promise(resolve => {
    const started = Date.now();
    execFile(process.execPath, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 90000, windowsHide: true }, (err, stdout) => {
      const elapsedMs = Date.now() - started;
      const text = String(stdout || '');
      const at = text.lastIndexOf('__HTTP__');
      const http = at >= 0 ? Number(text.slice(at + 8).trim()) : 0;
      const raw = at >= 0 ? text.slice(0, at) : text;
      const start = raw.indexOf('{');
      let json = null;
      try { json = JSON.parse(raw.slice(start)); } catch { json = null; }
      resolve({ http, json, elapsedMs, error: err ? String(err.message).slice(0, 120) : null });
    });
  });
}
async function main() {
  const list = cases();
  const done = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
  const keep = [];
  for (const r of done) { const c = list.find(x => x.id === r.id); if (c && c.p === r.question && r.http === 200) keep.push(r); else break; }
  fs.writeFileSync(out, keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
  const saved = Object.fromEntries(keep.map(r => [r.id, r]));
  const tokens = keep.reduce((m, r) => { const u = r.stats?.modelUsage || {}; m.calls += u.calls || 0; m.total += (u.inputTokens || 0) + (u.outputTokens || 0); return m; }, { calls: 0, total: 0 });
  console.log(JSON.stringify({ stage: 'start', kind, questions: list.length, resumed: keep.length, deployment }));
  let last = 0;
  for (const test of list.slice(keep.length)) {
    const wait = delayMs - (Date.now() - last);
    if (last && wait > 0) await sleep(wait);
    last = Date.now();
    const prev = test.from ? saved[test.from] : null;
    const body = { message: test.p, history: [], state: prev ? prev.fullState || {} : {} };
    let res = await call(body);
    if ((res.http === 429 || res.http === 503 || res.http === 0) ) { await sleep(15000); res = await call(body); }
    const d = res.json || {};
    const record = {
      id: test.id, question: test.p, from: test.from || null, http: res.http, elapsedMs: res.elapsedMs,
      answer: String(d.answer || d.error || res.error || '').slice(0, 600),
      cards: (Array.isArray(d.cards) ? d.cards : []).map(c => ({ productId: c.productId, title: c.title, price: c.price,
        condition: c.condition, mall: c.mall, budgetStatus: c.budgetStatus, link: c.link ? 'https://redacted' : '' })),
      stats: d.stats || {},
      state: d.state ? { lastQuery: d.state.lastQuery, category: d.state.category, maxPrice: d.state.maxPrice, minPrice: d.state.minPrice,
        exclusions: d.state.exclusions, identity: d.state.identity, features: d.state.features, presentedProductIds: d.state.presentedProductIds } : {},
      fullState: d.state || {}
    };
    fs.appendFileSync(out, JSON.stringify(record) + '\n');
    saved[test.id] = record;
    const u = record.stats.modelUsage || {};
    tokens.calls += u.calls || 0; tokens.total += (u.inputTokens || 0) + (u.outputTokens || 0);
    console.log(JSON.stringify({ id: test.id, http: res.http, cards: record.cards.length, ms: res.elapsedMs, searched: record.stats.searched,
      first: (record.cards[0] || {}).title ? record.cards[0].title.slice(0, 50) : '', calls: tokens.calls }));
    if (res.http === 429) { console.log(JSON.stringify({ stage: 'rate_limited_stop', at: test.id })); break; }
    if (tokens.total > maxTokens) { console.log(JSON.stringify({ stage: 'usage_guard_stop', at: test.id, tokens })); break; }
  }
  console.log(JSON.stringify({ stage: 'done', tokens }));
}
main().catch(e => { console.error('runner failed:', e.message); process.exitCode = 1; });
