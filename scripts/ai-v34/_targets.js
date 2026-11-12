'use strict';
// AI v3.4 — database targets for vector work. ISOLATED TARGETS ONLY.
//
//  pglite      local in-process PostgreSQL 18 + pgvector 0.8 (no network)
//  neon-dev    a Neon development branch created for this work. The URL is
//              read from a file (never printed), the exact hostname must be
//              confirmed with --allow-host, and the production endpoint is
//              refused by name even if confirmed.
//
// NOTE (2026-11-12): scripts/migration/_neon-sandbox.js still allow-lists
// ep-gentle-art-aoaa97v4 as «isolated». Since 2026-10-21 that endpoint serves
// the DEFAULT/PRODUCTION branch (migration-test-20261020). It is denied here.
const fs = require('node:fs');
const path = require('node:path');

const PRODUCTION_HOSTS = new Set([
  'ep-gentle-art-aoaa97v4.c-2.ap-southeast-1.aws.neon.tech',
  'ep-gentle-art-aoaa97v4-pooler.c-2.ap-southeast-1.aws.neon.tech'
]);
const MIGRATION = path.resolve(__dirname, '../../db/isolated/2026-11-12-ai-v34-pgvector.sql');

async function openPglite({ dataDir } = {}) {
  const { PGlite } = require('@electric-sql/pglite');
  const { vector } = require('@electric-sql/pglite-pgvector');
  const db = await PGlite.create({ ...(dataDir ? { dataDir } : {}), extensions: { vector } });
  const query = (text, values) => db.query(text, values);
  return { kind: 'pglite', host: 'local', query, exec: text => db.exec(text),
    session: async () => ({ query, release() {} }), close: () => db.close() };
}
function assertIsolatedHost(url, allowHost) {
  const host = new URL(url).hostname;
  if (PRODUCTION_HOSTS.has(host)) throw new Error('Refusing the production Neon endpoint');
  if (!allowHost || allowHost !== host) throw new Error('Confirm the isolated target with --allow-host <exact hostname>');
  return host;
}
async function openNeonDev({ urlFile, allowHost }) {
  if (!urlFile) throw new Error('AI_V34_DEV_DB_URL_FILE (a file holding the dev-branch URL) is required');
  const url = fs.readFileSync(urlFile, 'utf8').trim();
  const host = assertIsolatedHost(url, allowHost);
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: true }, statement_timeout: 300000 });
  await client.connect();
  const query = (text, values) => client.query(text, values);
  return { kind: 'neon-dev', host, query, exec: text => client.query(text),
    session: async () => ({ query, release() {} }), close: () => client.end() };
}
async function openTarget(spec, opts = {}) {
  if (spec === 'pglite' || spec === 'pglite:memory') return openPglite();
  if (spec && spec.startsWith('pglite:')) return openPglite({ dataDir: spec.slice(7) });
  if (spec === 'neon-dev') return openNeonDev(opts);
  throw new Error('unknown target ' + spec);
}
async function applyMigration(target) {
  await target.exec(fs.readFileSync(MIGRATION, 'utf8'));
}
// Minimal `products` table for LOCAL targets (Neon dev branches already have
// the real table copied from their parent branch).
async function loadProducts(target, rows, { batch = 1000 } = {}) {
  if (target.kind === 'neon-dev') throw new Error('Never load snapshot rows into a Neon branch');
  await target.exec(`create table if not exists products (
    id bigint primary key, product_id text not null, mall text not null, keyword text, title text not null,
    lprice integer, collected_at timestamptz, vendor_item_id text default '', link text default '', image text default '');
    create index if not exists products_mall_pid on products (mall, product_id);`);
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const values = [], tuples = [];
    chunk.forEach((r, j) => {
      const b = j * 8;
      tuples.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ',$' + (b + 6) + ',$' + (b + 7) + ',$' + (b + 8) + ')');
      values.push(r.id, String(r.product_id), r.mall, r.keyword || '', r.title, r.lprice == null ? null : Number(r.lprice),
        r.collected_at || null, r.vendor_item_id || '');
    });
    await target.query('insert into products (id, product_id, mall, keyword, title, lprice, collected_at, vendor_item_id) values ' +
      tuples.join(',') + ' on conflict (id) do nothing', values);
  }
}
module.exports = { openTarget, openPglite, openNeonDev, applyMigration, loadProducts, assertIsolatedHost, PRODUCTION_HOSTS, MIGRATION };
