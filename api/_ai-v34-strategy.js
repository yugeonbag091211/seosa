'use strict';
// AI v3.4 — retrieval strategy feature flag + optional vector channel wiring.
//
//   AI_V3_SEARCH_STRATEGY = db-first (default) | live-first | hybrid
//   AI_V34_VECTOR_ENABLED = 1            (hybrid only; otherwise vector is 'disabled')
//   AI_V34_VECTOR_DATABASE_URL = <isolated DB holding ai_v34.product_embeddings>
//   AI_V34_EMBEDDER = hash (default) | openai   (openai needs AI_V34_EMBEDDING_COST_CAP_USD)
//
// Safety: the vector channel never uses the main DB connection. A vector URL
// equal to the main database URL is refused unless AI_V34_VECTOR_ALLOW_MAIN_DB=1
// (a separate, explicit production decision). Unknown strategy → db-first.
const STRATEGIES = new Set(['db-first', 'live-first', 'hybrid']);

function parseStrategy(value) {
  const v = String(value || '').trim().toLowerCase();
  return STRATEGIES.has(v) ? v : 'db-first';
}
let cached = null;
function vectorConfigError(env) {
  if (env.AI_V34_VECTOR_ENABLED !== '1') return 'disabled';
  const url = env.AI_V34_VECTOR_DATABASE_URL || '';
  if (!url) return 'missing_vector_database_url';
  const main = [env.NEON_DATABASE_URL, env.DATABASE_URL, env.POSTGRES_URL].filter(Boolean);
  let host;
  try { host = new URL(url).hostname; } catch { return 'invalid_vector_database_url'; }
  const sameAsMain = main.some(m => { try { return new URL(m).hostname === host; } catch { return false; } });
  if (sameAsMain && env.AI_V34_VECTOR_ALLOW_MAIN_DB !== '1') return 'vector_db_is_main_db';
  return '';
}
function buildEmbedder(env) {
  const { hashEmbedder, openAiEmbedder, createCostGuard } = require('./_ai-v34-embedding');
  const dims = Number(env.AI_V34_VECTOR_DIMS) || 256;
  if (env.AI_V34_EMBEDDER === 'openai') {
    const cap = Number(env.AI_V34_EMBEDDING_COST_CAP_USD);
    if (!(cap > 0)) throw new Error('AI_V34_EMBEDDING_COST_CAP_USD required for paid embeddings');
    return openAiEmbedder({ dims, guard: createCostGuard({ capUsd: cap }) });
  }
  return hashEmbedder({ dims });
}
// Returns { vectorSearch, status }. vectorSearch is undefined unless every
// precondition holds; the catalog then reports vectorStatus:'disabled'.
function vectorRuntime(env = process.env) {
  const problem = vectorConfigError(env);
  if (problem) return { vectorSearch: undefined, status: problem };
  if (cached && cached.url === env.AI_V34_VECTOR_DATABASE_URL) return cached.value;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: env.AI_V34_VECTOR_DATABASE_URL, max: 2,
    ssl: { rejectUnauthorized: true }, statement_timeout: 2500, idleTimeoutMillis: 10000 });
  const { pgVectorStore, createVectorSearch } = require('./_ai-v34-vector');
  const embedder = buildEmbedder(env);
  const store = pgVectorStore({
    session: async () => { const c = await pool.connect(); return { query: (t, v) => c.query(t, v), release: () => c.release() }; },
    embedderId: embedder.id, dims: embedder.dims, efSearch: Number(env.AI_V34_HNSW_EF_SEARCH) || 100
  });
  const value = { vectorSearch: createVectorSearch({ store, embedder, k: Number(env.AI_V34_VECTOR_K) || 40 }), status: 'configured' };
  cached = { url: env.AI_V34_VECTOR_DATABASE_URL, value };
  return value;
}
module.exports = { parseStrategy, vectorRuntime, vectorConfigError, STRATEGIES };
