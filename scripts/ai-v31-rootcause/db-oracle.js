'use strict';
// Read-only Neon oracle for the online-200 non-PASS questions.
//
// Usage:  SEOSA_ORACLE_DB_URL_FILE=<file holding a read-only connection string> \
//         node scripts/ai-v31-rootcause/db-oracle.js [--out <jsonl>]
//
// Safety:
//  * The connection string is read from a file and is never printed.
//  * The session is forced read-only (default_transaction_read_only=on) and the
//    script refuses to run when the role can INSERT/UPDATE/DELETE products.
//  * Only SELECT statements are issued.
const fs = require('node:fs');
const path = require('node:path');
const { specs, norm } = require('./oracle-specs');

const USED_RE = /(중고|리퍼|refurb|전시|반품|스크래치|b급|used)/i;
const NT = "regexp_replace(lower(title),'[^0-9a-z가-힣]','','g')";

function buildWhere(spec, args) {
  const parts = ['lprice > 0'];
  for (const group of spec.all || []) {
    const alts = group.map(norm).filter(Boolean);
    if (!alts.length) continue;
    parts.push('(' + alts.map(a => { args.push('%' + a + '%'); return NT + ' LIKE $' + args.length; }).join(' OR ') + ')');
  }
  for (const word of (spec.not || []).map(norm).filter(Boolean)) {
    args.push('%' + word + '%');
    parts.push('NOT (' + NT + ' LIKE $' + args.length + ')');
  }
  if (spec.min != null) { args.push(spec.min); parts.push('lprice >= $' + args.length); }
  if (spec.max != null) { args.push(spec.max); parts.push('lprice <= $' + args.length); }
  return parts.join(' AND ');
}

async function main() {
  const urlFile = process.env.SEOSA_ORACLE_DB_URL_FILE;
  if (!urlFile) throw new Error('SEOSA_ORACLE_DB_URL_FILE is required');
  const { Client } = require('pg');
  const client = new Client({ connectionString: fs.readFileSync(urlFile, 'utf8').trim(), statement_timeout: 30000 });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const priv = await client.query("select has_table_privilege('products','INSERT') i, has_table_privilege('products','UPDATE') u, has_table_privilege('products','DELETE') d");
    if (priv.rows[0].i || priv.rows[0].u || priv.rows[0].d) throw new Error('Refusing: role is not read-only');
    const outArg = process.argv.indexOf('--out');
    const out = outArg > 0 ? process.argv[outArg + 1]
      : path.resolve(__dirname, '../../docs/ai-v31-rootcause-2026-11-06/db-oracle.jsonl');
    const results = fs.readFileSync(path.resolve(__dirname, '../../docs/ai-v31-online-200-2026-11-06-results.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const byId = Object.fromEntries(results.map(r => [r.id, r]));
    const lines = [];
    const snapshot = (await client.query('select count(*)::int n, max(collected_at) latest from products')).rows[0];
    for (const spec of specs) {
      const rec = { id: spec.id, question: byId[spec.id] && byId[spec.id].question, verdict: byId[spec.id] && byId[spec.id].verdict };
      if (spec.informational) { rec.kind = 'informational'; rec.review = spec.review; lines.push(rec); continue; }
      if (spec.followup) {
        // Re-load the cards the previous turn actually displayed, by ID.
        const prev = byId[spec.followup];
        const ids = (prev && prev.state && prev.state.presentedProductIds) || [];
        const rows = [];
        for (const pid of ids) {
          const at = pid.indexOf(':');
          const r = await client.query('select mall, product_id, title, lprice, collected_at from products where mall = $1 and product_id = $2',
            [pid.slice(0, at), pid.slice(at + 1)]);
          rows.push(r.rows[0] ? { id: pid, title: r.rows[0].title, price: r.rows[0].lprice, inDb: true } : { id: pid, inDb: false });
        }
        Object.assign(rec, { kind: 'followup', from: spec.followup, rule: spec.rule, previousShown: rows });
        lines.push(rec); continue;
      }
      const args = [];
      const where = buildWhere(spec, args);
      const count = (await client.query('select count(*)::int n from products where ' + where, args)).rows[0].n;
      const sample = (await client.query(
        'select mall, product_id, title, lprice, collected_at from products where ' + where + ' order by lprice asc limit 40', args)).rows;
      const mapped = sample.map(r => ({ id: r.mall + ':' + r.product_id, title: r.title, price: r.lprice, used: USED_RE.test(r.title),
        collected: r.collected_at ? new Date(r.collected_at).toISOString().slice(0, 10) : null }));
      const usedPolicy = spec.used || 'exclude';
      const eligible = mapped.filter(x => usedPolicy === 'any' ? true : usedPolicy === 'only' ? x.used : !x.used);
      Object.assign(rec, { kind: 'catalog', spec: { all: spec.all, not: spec.not, min: spec.min ?? null, max: spec.max ?? null, used: usedPolicy },
        review: spec.review, matchCount: count, sampleCount: mapped.length, eligibleInSample: eligible.length, sample: mapped });
      lines.push(rec);
    }
    fs.writeFileSync(out, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
    console.log(JSON.stringify({ written: out, records: lines.length, catalogRows: snapshot.n, latestCollected: snapshot.latest }));
  } finally {
    await client.end();
  }
}
if (require.main === module) main().catch(e => { console.error('oracle failed:', e.message); process.exit(1); });
module.exports = { buildWhere };
