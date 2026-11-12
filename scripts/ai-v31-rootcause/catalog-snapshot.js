'use strict';
// Read-only catalog snapshot for OFFLINE replay of the v3 catalog search.
//
// Usage: SEOSA_ORACLE_DB_URL_FILE=<file> node scripts/ai-v31-rootcause/catalog-snapshot.js <out.jsonl>
//
// * Reads only the columns the AI catalog search needs. No links/images, so
//   affiliate URLs never leave the database. The output file must stay outside
//   the repository (scratchpad); it is NOT a test fixture.
// * Session forced read-only; refuses a role that can write to products.
const fs = require('node:fs');

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('output path required');
  const urlFile = process.env.SEOSA_ORACLE_DB_URL_FILE;
  if (!urlFile) throw new Error('SEOSA_ORACLE_DB_URL_FILE is required');
  const { Client } = require('pg');
  const client = new Client({ connectionString: fs.readFileSync(urlFile, 'utf8').trim(), statement_timeout: 60000 });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const priv = await client.query("select has_table_privilege('products','INSERT') i, has_table_privilege('products','UPDATE') u, has_table_privilege('products','DELETE') d");
    if (priv.rows[0].i || priv.rows[0].u || priv.rows[0].d) throw new Error('Refusing: role is not read-only');
    const r = await client.query(
      'select id, product_id, mall, keyword, title, lprice, collected_at, vendor_item_id from products order by id');
    const fd = fs.openSync(out, 'w');
    for (const row of r.rows) {
      fs.writeSync(fd, JSON.stringify({ id: Number(row.id), product_id: row.product_id, mall: row.mall, keyword: row.keyword,
        title: row.title, lprice: row.lprice, collected_at: row.collected_at, vendor_item_id: row.vendor_item_id || '' }) + '\n');
    }
    fs.closeSync(fd);
    console.log(JSON.stringify({ rows: r.rows.length, out }));
  } finally { await client.end(); }
}
main().catch(e => { console.error('snapshot failed:', e.message); process.exit(1); });
