'use strict';
// AI v3.4 — vector candidate stores for the hybrid retrieval strategy.
//
//  * memoryVectorStore: exact cosine scan (tests, offline replay).
//  * pgVectorStore:     pgvector (HNSW, cosine) on an ISOLATED database. It
//                       runs read-only SELECTs only; schema and embeddings are
//                       created by scripts/ai-v34/embed-products.js.
//  * createVectorSearch: query text → embedding → nearest products.
// A vector hit is a retrieval CANDIDATE. _ai-v3-catalog re-applies the same
// type/brand/model/identity/budget filters as for keyword hits, then the
// engine validates again — vector similarity alone never makes a card.
const { queryDocument } = require('./_ai-v34-text');
const { cosine } = require('./_ai-v34-embedding');

const SAFE_IDENT = /^[a-z_][a-z0-9_]{0,40}$/;
const vectorLiteral = v => '[' + Array.from(v, x => (Number.isFinite(x) ? x : 0)).join(',') + ']';

function memoryVectorStore(entries, { embedderId = '' } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(e => e && e.row && Array.isArray(e.vector));
  return {
    kind: 'memory', embedderId, size: list.length,
    async search(vec, { k = 40, minPrice = null, maxPrice = null } = {}) {
      const scored = [];
      for (const e of list) {
        const price = Number(e.row.lprice);
        if (minPrice != null && !(price >= minPrice)) continue;
        if (maxPrice != null && !(price <= maxPrice)) continue;
        scored.push([1 - cosine(vec, e.vector), e.row]);
      }
      scored.sort((a, b) => a[0] - b[0] || String(a[1].product_id).localeCompare(String(b[1].product_id)));
      return { rows: scored.slice(0, k).map(([distance, row], i) => ({ ...row, _vectorRank: i + 1, _vectorDistance: Math.round(distance * 1e6) / 1e6 })), queries: 0 };
    }
  };
}

// session(): returns { query(text, values) → {rows}, release() } on ONE
// connection (SET LOCAL needs a transaction on the same connection).
function pgVectorStore({ session, schema = 'ai_v34', productsTable = 'products', embedderId, dims,
  efSearch = 100, iterative = true } = {}) {
  if (typeof session !== 'function') throw new Error('pgVectorStore needs a session() factory');
  if (!SAFE_IDENT.test(schema) || !SAFE_IDENT.test(productsTable)) throw new Error('unsafe identifier');
  if (!embedderId || !(dims > 0)) throw new Error('embedderId and dims are required');
  const ef = Math.max(10, Math.min(1000, Number(efSearch) || 100));
  return {
    kind: 'pgvector', embedderId, dims,
    async search(vec, { k = 40, minPrice = null, maxPrice = null } = {}) {
      if (!vec || vec.length !== dims) throw new Error('query vector has wrong dimensions');
      const limit = Math.max(1, Math.min(200, Number(k) || 40));
      const values = [vectorLiteral(vec), embedderId];
      let where = 'e.embedder_id = $2';
      if (minPrice != null) { values.push(Number(minPrice)); where += ' AND p.lprice >= $' + values.length; }
      if (maxPrice != null) { values.push(Number(maxPrice)); where += ' AND p.lprice <= $' + values.length; }
      values.push(limit);
      const sql = 'SELECT p.id, p.product_id, p.mall, p.keyword, p.title, p.lprice, p.collected_at, p.vendor_item_id, p.link, p.image, ' +
        '(e.embedding <=> $1::vector) AS vector_distance FROM ' + schema + '.product_embeddings e ' +
        'JOIN ' + productsTable + ' p ON p.mall = e.mall AND p.product_id = e.product_id ' +
        'WHERE ' + where + ' ORDER BY e.embedding <=> $1::vector LIMIT $' + values.length;
      const s = await session();
      let queries = 0;
      try {
        await s.query('BEGIN READ ONLY'); queries++;
        await s.query('SET LOCAL hnsw.ef_search = ' + ef); queries++;
        if (iterative) { await s.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'"); queries++; }
        const r = await s.query(sql, values); queries++;
        await s.query('COMMIT'); queries++;
        // relaxed_order may return slightly out-of-order rows: re-sort.
        const rows = (r.rows || []).slice().sort((a, b) => Number(a.vector_distance) - Number(b.vector_distance));
        return { rows: rows.map((row, i) => ({ ...row, _vectorRank: i + 1, _vectorDistance: Number(row.vector_distance) })), queries };
      } catch (e) {
        try { await s.query('ROLLBACK'); } catch {}
        throw e;
      } finally { if (typeof s.release === 'function') s.release(); }
    }
  };
}

function createVectorSearch({ store, embedder, k = 40 } = {}) {
  if (!store || typeof store.search !== 'function') throw new Error('vector store required');
  if (!embedder || typeof embedder.embed !== 'function') throw new Error('embedder required');
  if (store.embedderId && store.embedderId !== embedder.id) throw new Error('embedder/store mismatch');
  return async function vectorSearch({ term = '', userText = '', category = '', identity = {}, minPrice = null, maxPrice = null } = {}) {
    const doc = queryDocument({ query: term, userText, category, identity });
    const [vec] = await embedder.embed([doc.text]);
    const found = await store.search(vec, { k, minPrice, maxPrice });
    return { rows: found.rows || [], queries: found.queries || 0 };
  };
}
// Runs a vector search with a deadline; never throws (hybrid must degrade to
// keyword + live when the vector channel is unavailable).
async function runVectorSearch(fn, args, { timeoutMs = 1500 } = {}) {
  if (typeof fn !== 'function') return { status: 'disabled', rows: [], ms: 0, queries: 0 };
  const t0 = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => fn(args)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('vector timeout'), { code: 'VECTOR_TIMEOUT' })), timeoutMs); })
    ]);
    const rows = Array.isArray(result && result.rows) ? result.rows : [];
    return { status: rows.length ? 'ok' : 'empty', rows, ms: Date.now() - t0, queries: Number(result && result.queries) || 0 };
  } catch (e) {
    return { status: e && e.code === 'VECTOR_TIMEOUT' ? 'timeout' : 'error', rows: [], ms: Date.now() - t0, queries: 0 };
  } finally { clearTimeout(timer); }
}
module.exports = { memoryVectorStore, pgVectorStore, createVectorSearch, runVectorSearch, vectorLiteral };
