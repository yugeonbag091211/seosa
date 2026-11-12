'use strict';
// AI v3.4 hybrid retrieval on REAL pgvector (PGlite: PostgreSQL 18 + pgvector
// 0.8, in-process, no network): migration, incremental embedding pipeline,
// HNSW search with SQL price filter, hybrid catalog channels, degradation on
// vector faults, honest outage, strategy flag and isolation guards.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openPglite, applyMigration, loadProducts, assertIsolatedHost, PRODUCTION_HOSTS } = require('./ai-v34/_targets');
const { embedProducts } = require('./ai-v34/embed-products');
const { hashEmbedder } = require('../api/_ai-v34-embedding');
const { pgVectorStore, createVectorSearch, runVectorSearch } = require('../api/_ai-v34-vector');
const { searchCatalog } = require('../api/_ai-v3-catalog');
const { createEngine } = require('../api/_ai-v3-core');
const { requestedIdentity } = require('../api/_ai-v3-identity');
const { parseStrategy, vectorConfigError } = require('../api/_ai-v34-strategy');
const { createSnapshotDb } = require('./ai-v31-rootcause/snapshot-db');

const DAY = 86400000;
const now = Date.now();
// Fixture rows re-dated relative to now (no fixed-date time bombs).
const rows = fs.readFileSync(path.join(__dirname, '../tools/ai-eval/fixtures/catalog-fixture.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).map(r => ({ ...r,
    collected_at: new Date(now - (Date.parse('2026-11-06T05:16:02Z') - Date.parse(r.collected_at))).toISOString(),
    link: 'https://www.example.org/p/' + r.product_id }));
const mapRow = r => ({ productId: r.product_id, title: r.title, lprice: r.lprice, mall: r.mall, link: r.link || ('https://www.example.org/p/' + r.product_id),
  collectedAt: r.collected_at instanceof Date ? r.collected_at.toISOString() : r.collected_at });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

(async () => {
  delete process.env.SEOSA_DB_READONLY;
  const pg = await openPglite();
  try {
    await test('isolated migration applies on PostgreSQL 18 + pgvector 0.8 and is idempotent', async () => {
      await applyMigration(pg); await applyMigration(pg);
      const v = (await pg.query("select extversion from pg_extension where extname='vector'")).rows[0].extversion;
      assert(/^0\.8\./.test(v), 'pgvector ' + v);
      const idx = (await pg.query("select indexdef from pg_indexes where schemaname='ai_v34' and indexname='product_embeddings_hnsw'")).rows[0].indexdef;
      assert(/hnsw/.test(idx) && /vector_cosine_ops/.test(idx));
    });
    const embedder = hashEmbedder({ dims: 256 });
    await test('embedding pipeline records model/dims/version and re-embeds only changed products', async () => {
      await loadProducts(pg, rows);
      const first = await embedProducts({ target: pg, rows, embedder });
      assert.equal(first.embedded, rows.length);
      const again = await embedProducts({ target: pg, rows, embedder });
      assert.equal(again.embedded, 0); assert.equal(again.unchanged, rows.length);
      const changed = rows.map(r => r.product_id === 'f-g304-1' ? { ...r, title: r.title + ' 리뉴얼' } : r);
      const third = await embedProducts({ target: pg, rows: changed, embedder, prune: true });
      assert.equal(third.embedded, 1); assert.equal(third.pruned, 0);
      const meta = (await pg.query("select embedder_id, dims, lexicon_version, count(*)::int n from ai_v34.product_embeddings group by 1,2,3")).rows;
      assert.equal(meta.length, 1); assert.equal(meta[0].dims, 256); assert.equal(meta[0].embedder_id, 'seosa-hash-ngram-v1');
      const runs = (await pg.query('select count(*)::int n from ai_v34.embedding_runs')).rows[0].n;
      assert.equal(runs, 3);
    });
    const store = pgVectorStore({ session: pg.session, embedderId: embedder.id, dims: 256, efSearch: 64 });
    const vectorSearch = createVectorSearch({ store, embedder, k: 20 });
    await test('HNSW search with SQL price bounds (iterative scan) returns only in-range rows', async () => {
      const found = await vectorSearch({ term: '무선 마우스', userText: '3만원 이하 무선 마우스', category: '마우스', maxPrice: 30000 });
      assert(found.rows.length > 0);
      assert(found.rows.every(r => Number(r.lprice) <= 30000));
      assert(found.rows.every((r, i, a) => i === 0 || a[i - 1]._vectorDistance <= r._vectorDistance));
    });
    const db = createSnapshotDb(rows);
    const opts = extra => ({ db, mapRow, liveSearch: null, searchStrategy: 'hybrid', vectorSearch, ...extra });
    await test('hybrid recovers a synonym-only listing («랩탑») the keyword channel cannot see', async () => {
      const kwOnly = await searchCatalog('노트북', { db, mapRow, liveSearch: null, searchStrategy: 'db-first', category: '노트북', userText: '가벼운 노트북', maxPrice: 500000 });
      const hybrid = await searchCatalog('노트북', opts({ category: '노트북', userText: '가벼운 노트북', maxPrice: 500000 }));
      assert(!kwOnly.some(x => x.productId === 'f-laptop-light'));
      assert(hybrid.some(x => x.productId === 'f-laptop-light'), 'vector channel should add the 랩탑 listing');
      assert.equal(hybrid._retrieval.strategy, 'hybrid');
      assert.equal(hybrid._retrieval.vectorStatus, 'ok');
      assert(hybrid._retrieval.vectorOnlyEligible >= 1);
      assert(!hybrid.some(x => ['f-hdmi', 'f-bag'].includes(x.productId)), 'cable/bag must not enter as laptops');
    });
    await test('a similar-but-different model from the vector channel is never eligible, and never a card (S25 Edge ≠ S25 Ultra)', async () => {
      const args = { category: '스마트폰', userText: '갤럭시 S25 울트라', identity: requestedIdentity('갤럭시 S25 울트라') };
      const out = await searchCatalog('갤럭시 S25 울트라', opts(args));
      // The keyword channel is the DB-first list (identity is judged by the
      // engine); what the VECTOR channel adds must already pass identity.
      const vectorOnly = out.filter(x => Array.isArray(x._via) && x._via.length === 1 && x._via[0] === 'vector');
      for (const id of ['f-s25e', 'f-s25case', 'f-s25u-kt']) assert(!vectorOnly.some(x => x.productId === id), id + ' entered via vector');
      const engineOut = await createEngine({
        planModel: async () => ({ mode: 'recommend', query: '갤럭시 S25 울트라', compareQuery: '', category: '스마트폰', maxPrice: null, exclusions: [], mallOnly: '', exactModel: '' }),
        decideModel: async ({ candidates }) => ({ productIds: candidates.map(c => c.id) }),
        searchProducts: (q, o) => searchCatalog(q, { ...o, ...opts({}) })
      }, { message: '갤럭시 S25 울트라 가격 알려줘' });
      assert(engineOut.cards.length >= 1);
      for (const c of engineOut.cards) assert(!['쿠팡:f-s25e', '쿠팡:f-s25case', 'ADPICK:f-s25u-kt'].includes(c.productId), 'wrong card ' + c.productId);
    });
    await test('vector faults degrade to keyword results; they never fail the request', async () => {
      for (const [fault, fn, status] of [['error', async () => { throw new Error('down'); }, 'error'],
        ['timeout', () => new Promise(r => { const t = setTimeout(() => r({ rows: [] }), 400); t.unref(); }), 'timeout']]) {
        const out = await searchCatalog('무선 마우스', { ...opts({ category: '마우스', userText: '무선 마우스' }), vectorSearch: fn, vectorTimeoutMs: 100 });
        assert.equal(out._retrieval.vectorStatus, status, fault);
        assert(out.length > 0, 'keyword results must survive a vector ' + fault);
      }
      assert.equal((await runVectorSearch(undefined, {})).status, 'disabled');
    });
    await test('DB down + vector finds nothing: an outage (throws → 503), never «no such product»', async () => {
      const down = { from() { const b = new Proxy({}, { get(_, p) { if (p === 'then') return undefined; if (p === 'limit') return async () => { throw new Error('db down'); }; return () => b; } }); return b; } };
      await assert.rejects(() => searchCatalog('존재하지않는상품', { ...opts({ category: '마우스', userText: '존재하지않는상품' }), db: down,
        vectorSearch: async () => ({ rows: [] }) }));
    });
    await test('full engine on hybrid: price-age gate and guards still decide the cards', async () => {
      const out = await createEngine({
        planModel: async () => ({ mode: 'recommend', query: '로지텍 G304 무선 마우스', compareQuery: '', category: '마우스', maxPrice: null, exclusions: [], mallOnly: '', exactModel: 'G304' }),
        decideModel: async ({ candidates }) => ({ productIds: candidates.map(c => c.id) }),
        searchProducts: (q, o) => searchCatalog(q, { ...o, ...opts({}) })
      }, { message: '로지텍 G304 무선 마우스 찾아줘' });
      assert(out.cards.length >= 1);
      for (const c of out.cards) {
        assert(/g304/i.test(c.title));
        assert.notEqual(c.productId, '쿠팡:f-g304-old', 'stale (>10 days) price shown');
        assert.notEqual(c.productId, 'ADPICK:f-g304-feet', 'accessory shown');
        assert(c.priceFreshness === 'fresh' && c.priceAgeDays <= 10);
      }
      assert.equal(out.stats.retrieval.strategy, 'hybrid');
    });
  } finally { await pg.close(); }
  await test('strategy flag: unknown → db-first; vector channel refuses the main DB and requires opt-in', async () => {
    assert.equal(parseStrategy(undefined), 'db-first'); assert.equal(parseStrategy('HYBRID'), 'hybrid'); assert.equal(parseStrategy('x'), 'db-first');
    assert.equal(vectorConfigError({}), 'disabled');
    assert.equal(vectorConfigError({ AI_V34_VECTOR_ENABLED: '1', AI_V34_VECTOR_DATABASE_URL: 'postgres://u:p@h1.example/db', NEON_DATABASE_URL: 'postgres://u:p@h1.example/db' }), 'vector_db_is_main_db');
    assert.equal(vectorConfigError({ AI_V34_VECTOR_ENABLED: '1', AI_V34_VECTOR_DATABASE_URL: 'postgres://u:p@h2.example/db', NEON_DATABASE_URL: 'postgres://u:p@h1.example/db' }), '');
  });
  await test('isolation guard refuses the production Neon endpoint even when «confirmed»', async () => {
    const prod = [...PRODUCTION_HOSTS][0];
    assert.throws(() => assertIsolatedHost('postgres://u:p@' + prod + '/db', prod), /production/);
    assert.throws(() => assertIsolatedHost('postgres://u:p@ep-dev.example/db', 'other-host'), /allow-host/);
    assert.equal(assertIsolatedHost('postgres://u:p@ep-dev.example/db', 'ep-dev.example'), 'ep-dev.example');
  });
  console.log(JSON.stringify({ passed, failed: 0, database: 'PGlite (PostgreSQL 18, pgvector 0.8, in-process)' }));
})().catch(e => { console.error(e.stack || e); process.exit(1); });
