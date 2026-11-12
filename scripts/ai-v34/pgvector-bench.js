'use strict';
// AI v3.4 — Experiment E: exact scan vs HNSW vs IVFFlat on the real embedding
// table (77,737 products) in an ISOLATED database.
//   node scripts/ai-v34/pgvector-bench.js --target pglite:<copy of pgdata> --out reports/.../pgvector-bench.json
//   (--target neon-dev --allow-host <host> for the isolated Neon branch, small --limit)
// Queries = the first-turn query documents of the frozen V001-V100 set
// (question text only, no labels). Recall@10 of an index = overlap with the
// exact top-10. Latency is wall time per query on this machine; PGlite is
// single-threaded WASM, so absolute numbers are NOT Neon numbers.
const fs = require('node:fs');
const { openTarget } = require('./_targets');
const { queryDocument } = require('../../api/_ai-v34-text');
const { hashEmbedder } = require('../../api/_ai-v34-embedding');
const { vectorLiteral } = require('../../api/_ai-v34-vector');
const { questions } = require('./eval/questions-v34');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }
const pct = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
const ms = t0 => Number(process.hrtime.bigint() - t0) / 1e6;

async function main() {
  const target = await openTarget(arg('--target', 'pglite'), { urlFile: process.env.AI_V34_DEV_DB_URL_FILE, allowHost: arg('--allow-host') });
  const out = { target: target.kind, generatedAt: new Date().toISOString(), configs: [] };
  try {
    const ver = await target.query("select extversion from pg_extension where extname='vector'");
    const pgv = await target.query('select version()');
    out.pgvector = ver.rows[0] && ver.rows[0].extversion; out.postgres = String(pgv.rows[0].version).slice(0, 60);
    const embedder = hashEmbedder({ dims: 256 });
    const docs = questions.map(q => { const t = q.turns[0]; return queryDocument({ query: t.plan.query + ' ' + (t.plan.compareQuery || ''), userText: t.p, category: t.plan.category }).text; });
    const vecs = (await embedder.embed(docs)).map(vectorLiteral);
    const limit = Number(arg('--limit', 0));
    await target.exec('drop table if exists ai_v34.bench_vectors');
    let t0 = process.hrtime.bigint();
    await target.exec('create table ai_v34.bench_vectors as select mall, product_id, embedding from ai_v34.product_embeddings' +
      (limit > 0 ? ' order by product_id limit ' + Math.floor(limit) : ''));
    const n = Number((await target.query('select count(*)::int n from ai_v34.bench_vectors')).rows[0].n);
    out.rows = n; out.copyMs = Math.round(ms(t0));
    const sql = 'select mall, product_id from ai_v34.bench_vectors order by embedding <=> $1::vector limit 10';
    async function run(label, setup) {
      const lat = [], tops = [];
      for (const v of vecs) {
        await target.exec('begin; ' + setup);
        const s = process.hrtime.bigint();
        const r = await target.query(sql, [v]);
        lat.push(ms(s));
        await target.exec('commit');
        tops.push(r.rows.map(x => x.mall + ':' + x.product_id));
      }
      await target.exec('begin; ' + setup);
      const plan = await target.query('explain (analyze, buffers, costs off) ' + sql, [vecs[0]]);
      await target.exec('commit');
      return { label, p50Ms: Math.round(pct(lat, 0.5) * 10) / 10, p95Ms: Math.round(pct(lat, 0.95) * 10) / 10, tops,
        plan: plan.rows.map(x => x['QUERY PLAN']).join('\n') };
    }
    const exact = await run('exact (no index, sequential scan)', 'set local enable_indexscan = off;');
    const recall = tops => {
      let hit = 0, total = 0;
      tops.forEach((t, i) => { const truth = new Set(exact.tops[i]); total += truth.size; hit += t.filter(x => truth.has(x)).length; });
      return Math.round(hit / Math.max(1, total) * 1000) / 1000;
    };
    out.configs.push({ ...exact, recallAt10: 1, tops: undefined });
    t0 = process.hrtime.bigint();
    await target.exec('create index bench_hnsw on ai_v34.bench_vectors using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)');
    const hnswBuild = Math.round(ms(t0));
    const hnswSize = Number((await target.query("select pg_relation_size('ai_v34.bench_hnsw') b")).rows[0].b);
    for (const ef of [40, 100, 200]) {
      const r = await run('hnsw m=16 ef_construction=64 ef_search=' + ef, 'set local hnsw.ef_search = ' + ef + ';');
      out.configs.push({ ...r, buildMs: hnswBuild, indexBytes: hnswSize, recallAt10: recall(r.tops), tops: undefined });
    }
    await target.exec('drop index ai_v34.bench_hnsw');
    const lists = Math.max(10, Math.round(Math.sqrt(n)));
    t0 = process.hrtime.bigint();
    await target.exec('create index bench_ivf on ai_v34.bench_vectors using ivfflat (embedding vector_cosine_ops) with (lists = ' + lists + ')');
    const ivfBuild = Math.round(ms(t0));
    const ivfSize = Number((await target.query("select pg_relation_size('ai_v34.bench_ivf') b")).rows[0].b);
    for (const probes of [1, 10, 40]) {
      const r = await run('ivfflat lists=' + lists + ' probes=' + probes, 'set local ivfflat.probes = ' + probes + ';');
      out.configs.push({ ...r, buildMs: ivfBuild, indexBytes: ivfSize, recallAt10: recall(r.tops), tops: undefined });
    }
    await target.exec('drop table ai_v34.bench_vectors');
    out.tableBytes = Number((await target.query("select pg_total_relation_size('ai_v34.product_embeddings') b")).rows[0].b);
  } finally { await target.close(); }
  for (const c of out.configs) delete c.tops;
  const file = arg('--out');
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ target: out.target, rows: out.rows, pgvector: out.pgvector,
    configs: out.configs.map(c => ({ label: c.label, recallAt10: c.recallAt10, p50Ms: c.p50Ms, p95Ms: c.p95Ms, buildMs: c.buildMs, indexMB: c.indexBytes ? Math.round(c.indexBytes / 1048576 * 10) / 10 : null })) }));
}
main().catch(e => { console.error('bench failed:', e.stack || e.message); process.exit(1); });
