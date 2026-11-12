'use strict';
// Pre-registration helper: evaluate the holdout oracle specs against the
// read-only catalog (a snapshot file, or the live read-only DB via
// SEOSA_ORACLE_DB_URL_FILE) and write candidate evidence for manual labelling.
//   node scripts/ai-v32-eval/holdout-oracle.js --snapshot <catalog.jsonl> --out <evidence.jsonl>
//   SEOSA_ORACLE_DB_URL_FILE=<file> node scripts/ai-v32-eval/holdout-oracle.js --db --out <evidence.jsonl>
const fs = require('node:fs');
const { cases } = require('./holdout-cases');
const { buildWhere } = require('../ai-v31-rootcause/db-oracle');
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const USED = /(중고|리퍼|refurb|전시|반품|s급|a급|b급|모든등급)/i;
const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : null; };

function matchLocal(rows, spec) {
  const all = (spec.all || []).map(g => g.map(norm).filter(Boolean));
  const not = (spec.not || []).map(norm).filter(Boolean);
  return rows.filter(r => {
    if (!(r.lprice > 0)) return false;
    const t = norm(r.title);
    if (!all.every(g => g.some(a => t.includes(a)))) return false;
    if (not.some(w => t.includes(w))) return false;
    if (spec.min != null && r.lprice < spec.min) return false;
    if (spec.max != null && r.lprice > spec.max) return false;
    if ((spec.used || 'exclude') === 'exclude' && USED.test(r.title)) return false;
    return true;
  }).sort((a, b) => a.lprice - b.lprice);
}
async function main() {
  const out = arg('out');
  if (!out) throw new Error('--out required');
  let fetchMatches;
  if (process.argv.includes('--db')) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: fs.readFileSync(process.env.SEOSA_ORACLE_DB_URL_FILE, 'utf8').trim(), statement_timeout: 30000 });
    await client.connect();
    await client.query('SET default_transaction_read_only = on');
    const priv = (await client.query("select has_table_privilege('products','INSERT') i, has_table_privilege('products','UPDATE') u")).rows[0];
    if (priv.i || priv.u) throw new Error('Refusing: role is not read-only');
    fetchMatches = async spec => {
      const args = [];
      const where = buildWhere(spec, args);
      const r = await client.query('select mall, product_id, title, lprice from products where ' + where + ' order by lprice asc limit 60', args);
      return r.rows.filter(x => (spec.used || 'exclude') !== 'exclude' || !USED.test(x.title));
    };
    fetchMatches.close = () => client.end();
  } else {
    const rows = fs.readFileSync(arg('snapshot'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    fetchMatches = async spec => matchLocal(rows, spec);
  }
  const lines = [];
  for (const c of cases) {
    if (c.expectNoSearch || c.from) { lines.push({ id: c.id, question: c.p, kind: c.expectNoSearch ? 'non_shopping' : 'followup' }); continue; }
    const m = await fetchMatches(c.spec);
    lines.push({ id: c.id, question: c.p, kind: 'catalog', spec: c.spec, matchCount: m.length,
      sample: m.slice(0, 15).map(r => ({ id: r.mall + ':' + r.product_id, title: r.title, price: r.lprice })) });
  }
  if (fetchMatches.close) await fetchMatches.close();
  fs.writeFileSync(out, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(JSON.stringify({ written: out, records: lines.length }));
}
main().catch(e => { console.error('holdout oracle failed:', e.message); process.exit(1); });
