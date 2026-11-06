'use strict';
// Deterministic OFFLINE replay of the v3 server pipeline over a read-only
// catalog snapshot, with a scripted planner standing in for GPT.
//
//   node scripts/ai-v31-rootcause/replay.js <snapshot.jsonl> [--ids N022,N061] [--out file.jsonl]
//
// Purpose: isolate SERVER-side retrieval/verification behaviour from GPT
// variance. The scripted plan is what a competent planner would emit for the
// question (product phrase, user category, user budget). It is NOT a measure
// of live accuracy; live GPT runs are separate (scripts/ai-v32-eval).
//
// decideModel stand-in accepts the server's candidate order (top 4), so the
// output shows the best case the server makes available to GPT.
const fs = require('node:fs');
const path = require('node:path');
const { loadSnapshot, createSnapshotDb } = require('./snapshot-db');
const { cases } = require('../ai-v31-online-200-cases');
const { scriptedPlan } = require('./scripted-plans');

function mapRow(r) {
  return { productId: r.product_id, title: r.title, lprice: r.lprice, mall: r.mall, link: r.link,
    image: '', vendorItemId: r.vendor_item_id || '' };
}

async function main() {
  const snapshot = process.argv[2];
  if (!snapshot) throw new Error('snapshot path required');
  const idsArg = process.argv.indexOf('--ids');
  const only = idsArg > 0 ? new Set(process.argv[idsArg + 1].split(',')) : null;
  const outArg = process.argv.indexOf('--out');
  const engineArg = process.argv.indexOf('--engine');
  const engineName = engineArg > 0 ? process.argv[engineArg + 1] : 'current';
  const rows = loadSnapshot(snapshot);
  const db = createSnapshotDb(rows);
  const core = require('../../api/_ai-v3-core');
  const catalog = require('../../api/_ai-v3-catalog');
  const saved = {};
  const out = [];
  for (const test of cases) {
    const needed = !only || only.has(test.id) || [...only].some(id => {
      // keep predecessors of requested follow-ups
      let c = cases.find(x => x.id === id);
      while (c && c.from) { if (c.from === test.id) return true; c = cases.find(x => x.id === c.from); }
      return false;
    });
    if (!needed) continue;
    const prev = test.from ? saved[test.from] : null;
    const state = prev ? prev.state : {};
    let usage = { calls: 0 };
    const adapter = {
      async planModel({ message, state: st }) { usage.calls++; return scriptedPlan(test, st); },
      async decideModel({ candidates, message }) {
        usage.calls++;
        const one = /(?:하나|한\s*개|한\s*제품|딱\s*하나|하나만)/.test(message);
        return { productIds: candidates.slice(0, one ? 1 : 4).map(c => c.id) };
      },
      getUsage: () => ({ ...usage })
    };
    const searchProducts = (query, opts) => catalog.searchCatalog(query, { ...opts, db, mapRow, liveSearch: null });
    const deps = { ...adapter, searchProducts };
    // Same wiring as api/_ai-v3-route.js (only when the engine version has it).
    if (typeof catalog.loadProductsByIds === 'function') deps.loadDisplayed = ids => catalog.loadProductsByIds(ids, { db, mapRow });
    const t0 = Date.now();
    const before = db.stats.queries;
    let result;
    try { result = await core.createEngine(deps, { message: test.p, history: [], state }); }
    catch (e) { result = { status: 500, error: String(e.message), cards: [], state: {}, stats: {} }; }
    saved[test.id] = result;
    out.push({ id: test.id, question: test.p, from: test.from || null, engine: engineName,
      status: result.status, searched: result.stats ? result.stats.searched : null,
      dbQueries: db.stats.queries - before, ms: Date.now() - t0,
      category: result.state && result.state.category, maxPrice: result.state && result.state.maxPrice,
      minPrice: result.state && result.state.minPrice, intent: result.stats && result.stats.intent,
      rejectedReasons: result.stats && result.stats.rejectedReasons, inspected: result.stats && result.stats.inspected,
      answer: String(result.answer || '').slice(0, 200),
      cards: (result.cards || []).map(c => ({ id: c.productId, title: c.title, price: c.price, condition: c.condition })) });
  }
  const text = out.map(x => JSON.stringify(x)).join('\n') + '\n';
  if (outArg > 0) fs.writeFileSync(process.argv[outArg + 1], text);
  else process.stdout.write(text);
}
if (require.main === module) main().catch(e => { console.error('replay failed:', e.stack || e.message); process.exit(1); });
