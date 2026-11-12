'use strict';
// Shared OFFLINE harness for the frozen v3.4 set: used by run-offline.js and
// by the Promptfoo custom provider (tools/ai-eval/providers/seosa-engine.js),
// so both evaluators drive the engine identically.
//
// Engine = the REAL server pipeline (createEngine + searchCatalog) over a
// frozen catalog snapshot. GPT is replaced by the frozen scripted plan of each
// turn; decideModel takes the server's candidate order (top 4, or 1 for
// «하나만»). Seller search is never injected. Faults from the question are
// applied to the DB / vector channel exactly as declared.
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const SETS = { main: './questions-v34', holdout: './questions-v34-holdout', fixture: './questions-v34-fixture' };
const { loadCorpus, computeGold, faultOverlay, applyOverlay } = require('./gold');
const { judgeQuestion } = require('./judge');
const { cardErrors } = require('./oracle');
const { createSnapshotDb } = require('../../ai-v31-rootcause/snapshot-db');

const ROOT = path.resolve(__dirname, '../../..');
const SINGLE = /(하나만|한\s*개만|딱\s*하나|하나\s*(?:추천|골라|선택|남겨))/;
const ENGINE_FILES = ['_ai-v3-core.js', '_ai-v3-catalog.js', '_ai-v3-identity.js', '_ai-v31-retrieval.js', '_ai-v31-taxonomy.js',
  '_ai-v32-intent.js', '_ai-v32-brands.js', '_ai-v33-official-models.js', '_ai-v34-freshness.js', '_ai-v34-fusion.js',
  '_ai-v34-vector.js', '_ai-v34-text.js', '_ai-v34-embedding.js', '_price.js'];

function failingDb(message) {
  const builder = new Proxy({}, { get(_, prop) {
    if (prop === 'then') return undefined;
    if (prop === 'limit') return async () => { throw new Error(message); };
    return () => builder;
  } });
  return { from() { return builder; }, stats: { queries: 0, rowsReturned: 0 } };
}
const mapRow = r => ({ productId: r.product_id, title: r.title, lprice: r.lprice, mall: r.mall, link: r.link, image: '',
  vendorItemId: r.vendor_item_id || '', collectedAt: r.collected_at instanceof Date ? r.collected_at.toISOString() : r.collected_at });
const withLink = r => ({ ...r, link: 'https://link.invalid/' + encodeURIComponent(r.mall) + '/' + encodeURIComponent(r.product_id), image: '' });
function retrievalMetrics(keys, goldIds) {
  const gold = new Set(goldIds);
  if (!gold.size) return null;
  const at = k => keys.slice(0, k).filter(x => gold.has(x)).length;
  const first = keys.findIndex(x => gold.has(x));
  return { goldCount: gold.size, hit10: at(10) > 0 ? 1 : 0, hit20: at(20) > 0 ? 1 : 0,
    recall10: at(10) / Math.min(10, gold.size), recall20: at(20) / Math.min(20, gold.size),
    mrr20: first >= 0 && first < 20 ? 1 / (first + 1) : 0, candidates: keys.length };
}
// Which engine source produced a run (so results are tied to exact code).
function engineFingerprint(engineRoot) {
  const h = crypto.createHash('sha256');
  for (const f of ENGINE_FILES) {
    const p = path.join(engineRoot, 'api', f);
    h.update(f + '\u0000' + (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : 'missing') + '\u0000');
  }
  return h.digest('hex').slice(0, 16);
}

async function createHarness({ snapshot, engine = 'v34', strategy = 'db-first', pglite, v33Root, k = 40, ef = 100, set = 'main',
  hybridMode = 'expand', vectorWeight = 1, gold: precomputedGold } = {}) {
  if (!snapshot) throw new Error('snapshot required');
  const { questions, meta } = require(SETS[set] || SETS.main);
  const engineRoot = engine === 'v33' ? v33Root : ROOT;
  if (!engineRoot) throw new Error('v33Root (archive of the v3.3 commit) required for engine v33');
  const core = require(path.join(engineRoot, 'api/_ai-v3-core'));
  const catalog = require(path.join(engineRoot, 'api/_ai-v3-catalog'));
  delete process.env.SEOSA_DB_READONLY; // seller search is simply never injected
  const rows = loadCorpus(snapshot).map(withLink);
  const corpus = new Map(rows.map(r => [r.mall + ':' + r.product_id, r]));
  const asOfMs = Date.parse(meta.asOf);
  const ctx = { asOfMs, maxAgeDays: meta.priceAgeLimitDays };
  // (the frozen-hash check already computed the same gold from the same frozen code)
  const gold = precomputedGold || computeGold(questions, rows, { asOf: meta.asOf, maxAgeDays: meta.priceAgeLimitDays });
  const baseDb = createSnapshotDb(rows);
  let pg = null, vectorBase = null;
  if (strategy === 'hybrid') {
    const { pgVectorStore, memoryVectorStore, createVectorSearch } = require(path.join(engineRoot, 'api/_ai-v34-vector'));
    const { hashEmbedder } = require(path.join(engineRoot, 'api/_ai-v34-embedding'));
    const embedder = hashEmbedder({ dims: 256 });
    let store;
    if (pglite) {
      const { openPglite } = require('../_targets');
      pg = await openPglite({ dataDir: pglite });
      store = pgVectorStore({ session: pg.session, embedderId: embedder.id, dims: 256, efSearch: ef });
    } else {
      // small corpora (CI fixture): exact in-memory store over the same documents
      const { productDocument } = require(path.join(engineRoot, 'api/_ai-v34-text'));
      const vectors = await embedder.embed(rows.map(r => productDocument(r).text));
      store = memoryVectorStore(rows.map((row, i) => ({ row, vector: vectors[i] })), { embedderId: embedder.id });
    }
    vectorBase = createVectorSearch({ store, embedder, k });
  }
  const fingerprint = engineFingerprint(engineRoot);

  async function runQuestion(q) {
    const fault = q.fault || {};
    const overlay = faultOverlay(q, rows, asOfMs);
    const qCorpus = overlay ? new Map([...corpus].map(([key, r]) => [key, applyOverlay(r, overlay)])) : corpus;
    const db = fault.db === 'error' ? failingDb('connection terminated unexpectedly')
      : fault.db === 'timeout' ? failingDb('canceling statement due to statement timeout')
        : overlay ? createSnapshotDb(rows.map(r => applyOverlay(r, overlay))) : baseDb;
    const perf = { dbQueries: 0, vectorQueries: 0, vectorMs: [], latencies: [], gptCallsSimulated: 0 };
    let vectorSearch;
    if (vectorBase) {
      vectorSearch = fault.vector === 'error' ? async () => { throw new Error('vector store unavailable'); }
        : fault.vector === 'timeout' ? () => new Promise(resolve => { const t = setTimeout(() => resolve({ rows: [] }), 2500); t.unref && t.unref(); })
          : async args => {
            const found = await vectorBase(args);
            perf.vectorQueries += found.queries || 0;
            return overlay ? { ...found, rows: found.rows.map(r => applyOverlay(r, overlay)) } : found;
          };
    }
    let state = {};
    const usage = { calls: 0 };
    const turnResults = [], turnLog = [];
    let retrieval = null, shown = 0, wrong = 0;
    for (let i = 0; i < q.turns.length; i++) {
      const turn = q.turns[i];
      const calls = [];
      const before = db.stats ? db.stats.queries : 0;
      const deps = {
        planModel: async () => { usage.calls++; return JSON.parse(JSON.stringify(turn.plan)); },
        decideModel: async ({ candidates, message }) => { usage.calls++; return { productIds: candidates.slice(0, SINGLE.test(message) ? 1 : 4).map(c => c.id) }; },
        getUsage: () => ({ ...usage }),
        now: asOfMs,
        searchProducts: async (query, opts) => {
          const items = await catalog.searchCatalog(query, { ...opts, db, mapRow, liveSearch: null, searchStrategy: strategy, vectorSearch,
            hybridMode, vectorWeight });
          calls.push({ query, keys: items.map(x => x.mall + ':' + x.productId) });
          if (items._retrieval && typeof items._retrieval.vectorMs === 'number') perf.vectorMs.push(items._retrieval.vectorMs);
          return items;
        },
        loadDisplayed: ids => catalog.loadProductsByIds(ids, { db, mapRow })
      };
      const t0 = Date.now();
      let result;
      try { result = await core.createEngine(deps, { message: turn.p, history: [], state }); }
      catch (e) { result = { status: 503, error: 'unavailable', answer: '', cards: [], state, stats: {}, _error: String(e.message).slice(0, 120) }; }
      const ms = Date.now() - t0;
      perf.latencies.push(ms);
      const dbq = (db.stats ? db.stats.queries : 0) - before;
      perf.dbQueries += dbq;
      state = result.state || state;
      turnResults.push(result);
      for (const c of result.cards || []) {
        shown++;
        const errs = !turn.spec.sides ? cardErrors(c, turn.spec, qCorpus, ctx)
          : turn.spec.sides.map(s => cardErrors(c, s, qCorpus, ctx)).reduce((a, b) => (a.length <= b.length ? a : b));
        if (errs.length) wrong++;
      }
      const g = gold[q.id][i];
      if (i === 0 && calls[0] && g && !g.dynamic && !g.sides && g.count > 0) retrieval = retrievalMetrics(calls[0].keys, g.ids);
      turnLog.push({ p: turn.p, status: result.status, ms, dbQueries: dbq, answer: String(result.answer || '').slice(0, 260),
        error: result._error, cards: (result.cards || []).map(c => ({ id: c.productId, title: String(c.title).slice(0, 90), price: c.price,
          fresh: c.priceFreshness, ageDays: c.priceAgeDays })),
        stats: { rejectedReasons: result.stats && result.stats.rejectedReasons, noResult: result.stats && result.stats.noResult,
          accepted: result.stats && result.stats.accepted, inspected: result.stats && result.stats.inspected,
          retrieval: result.stats && result.stats.retrieval } });
    }
    perf.gptCallsSimulated = usage.calls;
    const judged = judgeQuestion(q, turnResults, { gold, corpus: qCorpus, ctx });
    return { id: q.id, type: q.type, engine, strategy, fingerprint, turns: turnLog, verdict: judged, retrieval, cards: { shown, wrong }, perf, turnResults };
  }
  return { questions, meta, gold, corpus, ctx, rows, engine, strategy, fingerprint, runQuestion,
    async close() { if (pg) await pg.close(); } };
}
module.exports = { createHarness, retrievalMetrics, failingDb, engineFingerprint, mapRow };
