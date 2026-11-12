'use strict';
// AI v3.4 — product embedding pipeline (incremental, auditable).
//
//   node scripts/ai-v34/embed-products.js --target pglite:<dir> --snapshot <catalog.jsonl>
//   AI_V34_DEV_DB_URL_FILE=<file> node scripts/ai-v34/embed-products.js --target neon-dev \
//        --allow-host <ep-….neon.tech> --source-db --limit 3000
//
// * Normalizes title/category/brand/model/specs (_ai-v34-text.productDocument).
// * content_hash = sha256(lexicon version | embedder | dims | document): rows
//   whose hash is unchanged are skipped, so re-runs embed only new/changed
//   products; --prune drops embeddings whose product disappeared.
// * Records embedder id, dims, lexicon version and timestamps per row and per
//   run (ai_v34.embedding_runs).
// * The default embedder is the local hash model (free, no network). The
//   OpenAI embedder needs --embedder openai and --cost-cap-usd; its spend is
//   reserved before every call and the run stops at the cap.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { productDocument, contentHash, LEXICON_VERSION } = require('../../api/_ai-v34-text');
const { hashEmbedder, openAiEmbedder, createCostGuard } = require('../../api/_ai-v34-embedding');
const { vectorLiteral } = require('../../api/_ai-v34-vector');
const { openTarget, applyMigration, loadProducts } = require('./_targets');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const has = name => process.argv.includes(name);

function readSnapshot(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
async function embedProducts({ target, rows, embedder, batch = 128, prune = false, note = '' }) {
  const runId = 'run-' + new Date().toISOString().replace(/[:.]/g, '') + '-' + crypto.randomBytes(3).toString('hex');
  const started = new Date();
  const t0 = Date.now();
  const existing = new Map();
  const prev = await target.query('select mall, product_id, content_hash from ai_v34.product_embeddings where embedder_id = $1', [embedder.id]);
  for (const r of prev.rows) existing.set(r.mall + ':' + r.product_id, r.content_hash);
  const todo = [], seen = new Set();
  let unchanged = 0;
  for (const row of rows) {
    if (!row || !row.product_id || !row.mall || !row.title) continue;
    const key = row.mall + ':' + row.product_id;
    if (seen.has(key)) continue; // duplicate SKU rows: embed once
    seen.add(key);
    const doc = productDocument(row);
    const hash = contentHash(doc.text, { embedderId: embedder.id, dims: embedder.dims });
    if (existing.get(key) === hash) { unchanged++; continue; }
    todo.push({ row, doc, hash });
  }
  let embedded = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const vectors = await embedder.embed(chunk.map(x => x.doc.text));
    const values = [], tuples = [];
    chunk.forEach((x, j) => {
      const b = j * 7;
      tuples.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ',$' + (b + 6) + ',$' + (b + 7) + '::vector, now())');
      values.push(x.row.mall, String(x.row.product_id), embedder.id, embedder.dims, LEXICON_VERSION, x.hash, vectorLiteral(vectors[j]));
    });
    await target.query('insert into ai_v34.product_embeddings (mall, product_id, embedder_id, dims, lexicon_version, content_hash, embedding, embedded_at) values ' +
      tuples.join(',') + ' on conflict (mall, product_id, embedder_id) do update set dims = excluded.dims, lexicon_version = excluded.lexicon_version, ' +
      'content_hash = excluded.content_hash, embedding = excluded.embedding, embedded_at = now() ' +
      'where ai_v34.product_embeddings.content_hash <> excluded.content_hash', values);
    embedded += chunk.length;
  }
  let pruned = 0;
  if (prune) {
    const gone = [...existing.keys()].filter(k => !seen.has(k));
    for (let i = 0; i < gone.length; i += 500) {
      const part = gone.slice(i, i + 500);
      const r = await target.query('delete from ai_v34.product_embeddings where embedder_id = $1 and (mall || \':\' || product_id) = any($2::text[])',
        [embedder.id, part]);
      pruned += r.rowCount || r.affectedRows || 0;
    }
  }
  const usage = embedder.usage();
  await target.query('insert into ai_v34.embedding_runs (run_id, embedder_id, dims, lexicon_version, started_at, finished_at, scanned, embedded, unchanged, pruned, cost_usd, note) ' +
    'values ($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10,$11)',
    [runId, embedder.id, embedder.dims, LEXICON_VERSION, started.toISOString(), seen.size, embedded, unchanged, pruned,
      Number(usage.committedUsd || usage.costUsd || 0), note]);
  return { runId, embedder: embedder.id, dims: embedder.dims, lexiconVersion: LEXICON_VERSION,
    scanned: seen.size, embedded, unchanged, pruned, ms: Date.now() - t0, usage };
}

async function main() {
  const spec = arg('--target', 'pglite');
  const target = await openTarget(spec, { urlFile: process.env.AI_V34_DEV_DB_URL_FILE, allowHost: arg('--allow-host') });
  try {
    await applyMigration(target);
    let rows;
    if (has('--source-db')) {
      const limit = Math.max(1, Math.min(100000, Number(arg('--limit', 3000))));
      const r = await target.query('select id, product_id, mall, keyword, title, lprice, collected_at, vendor_item_id from products order by collected_at desc nulls last limit $1', [limit]);
      rows = r.rows;
    } else {
      const file = arg('--snapshot');
      if (!file) throw new Error('--snapshot <catalog.jsonl> or --source-db is required');
      rows = readSnapshot(file);
      const limit = Number(arg('--limit', 0));
      if (limit > 0) rows = rows.slice(0, limit);
      if (target.kind !== 'neon-dev') await loadProducts(target, rows);
    }
    const dims = Number(arg('--dims', 256));
    const embedder = arg('--embedder', 'hash') === 'openai'
      ? openAiEmbedder({ dims, guard: createCostGuard({ capUsd: Number(arg('--cost-cap-usd', 0)) }) })
      : hashEmbedder({ dims });
    const summary = await embedProducts({ target, rows, embedder, prune: has('--prune'), note: arg('--note', '') });
    console.log(JSON.stringify({ target: target.kind, ...summary }));
  } finally { await target.close(); }
}
if (require.main === module) main().catch(e => { console.error('embed failed:', e.message); process.exit(1); });
module.exports = { embedProducts, readSnapshot };
