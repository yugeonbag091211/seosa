'use strict';
// Minimal pgvector check on the ISOLATED Neon dev branch (few round trips):
// extension/version, embeddings present, HNSW used by the planner, recall@10
// of HNSW vs exact on 20 query documents, latency incl. Seoul→Singapore RTT.
//   AI_V34_DEV_DB_URL_FILE=<file> node scripts/ai-v34/neon-dev-check.js --allow-host <ep-…> --out <json>
const fs = require('node:fs');
const { openNeonDev } = require('./_targets');
const { queryDocument } = require('../../api/_ai-v34-text');
const { hashEmbedder } = require('../../api/_ai-v34-embedding');
const { vectorLiteral } = require('../../api/_ai-v34-vector');
const { questions } = require('./eval/questions-v34');
function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
(async () => {
  const t = await openNeonDev({ urlFile: process.env.AI_V34_DEV_DB_URL_FILE, allowHost: arg('--allow-host') });
  const out = { target: 'neon-dev', host: t.host, generatedAt: new Date().toISOString() };
  try {
    out.extension = (await t.query("select extversion from pg_extension where extname='vector'")).rows[0];
    out.embeddings = (await t.query('select count(*)::int n, pg_total_relation_size(\'ai_v34.product_embeddings\')::bigint bytes from ai_v34.product_embeddings')).rows[0];
    out.index = (await t.query("select indexdef from pg_indexes where schemaname='ai_v34' and indexname='product_embeddings_hnsw'")).rows[0];
    const embedder = hashEmbedder({ dims: 256 });
    const docs = questions.slice(0, 20).map(q => queryDocument({ query: q.turns[0].plan.query, userText: q.turns[0].p, category: q.turns[0].plan.category }).text);
    const vecs = (await embedder.embed(docs)).map(vectorLiteral);
    const sql = 'select mall, product_id from ai_v34.product_embeddings order by embedding <=> $1::vector limit 10';
    const exact = [], ann = [], latE = [], latA = [];
    for (const v of vecs) {
      await t.query('begin'); await t.query('set local enable_indexscan = off');
      let s = Date.now(); exact.push((await t.query(sql, [v])).rows.map(r => r.mall + ':' + r.product_id)); latE.push(Date.now() - s);
      await t.query('commit');
      await t.query('begin'); await t.query('set local hnsw.ef_search = 100');
      s = Date.now(); ann.push((await t.query(sql, [v])).rows.map(r => r.mall + ':' + r.product_id)); latA.push(Date.now() - s);
      await t.query('commit');
    }
    let hit = 0, total = 0;
    ann.forEach((a, i) => { const truth = new Set(exact[i]); total += truth.size; hit += a.filter(x => truth.has(x)).length; });
    out.queries = vecs.length; out.hnswRecallAt10 = Math.round(hit / Math.max(1, total) * 1000) / 1000;
    out.exactMs = { p50: pct(latE, 0.5), p95: pct(latE, 0.95) }; out.hnswMs = { p50: pct(latA, 0.5), p95: pct(latA, 0.95) };
    await t.query('begin'); await t.query('set local hnsw.ef_search = 100');
    out.plan = (await t.query('explain (analyze, buffers, costs off) ' + sql, [vecs[0]])).rows.map(r => r['QUERY PLAN'])
      .map(l => l.replace(/'\[[^\]]+\]'::vector/, "'<query vector>'::vector"));
    await t.query('commit');
  } finally { await t.close(); }
  if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ ...out, plan: out.plan && out.plan.slice(0, 4) }));
})().catch(e => { console.error('neon check failed:', e.message); process.exit(1); });
