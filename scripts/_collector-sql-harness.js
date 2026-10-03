'use strict';

/*
 * Test-only: the checked-in collector migration on an in-process PostgreSQL (PGlite, WASM),
 * behind the small supabase-js surface the collector uses (rpc + select/eq/gt/order/limit).
 * No connection string, network or production database is involved.
 * PGlite has a single connection: statements are serialized, so it proves SQL state
 * transitions, not multi-backend lock behavior (scripts/test-collector-ledger-pg.js does).
 */
const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20261003003832_collector_daily_efficiency.sql');

// Argument order and SQL casts of every RPC the collector calls.
const RPCS = {
  collector_query_claim: { args: ['p_source', 'p_normalized_query', 'p_query_hash', 'p_token::uuid', 'p_lease_seconds::int'] },
  collector_query_begin: { args: ['p_source', 'p_date::date', 'p_query_hash', 'p_token::uuid'] },
  collector_query_finish: { args: ['p_source', 'p_date::date', 'p_query_hash', 'p_token::uuid', 'p_status',
    'p_failure_reason', 'p_result::jsonb', 'p_next_retry_at::timestamptz', 'p_result_count::int'] },
  collector_query_invalidate: { args: ['p_source', 'p_date::date', 'p_query_hash', 'p_token::uuid'] },
  collector_query_expire_results: { args: ['p_batch_size::int'] },
  collector_progress_record: { args: ['p_source', 'p_date::date', 'p_events::jsonb'], set: true }
};
const TABLES = new Set(['collector_query_runs', 'collector_product_progress']);
const IDENT = /^[a-z_]+$/;

// Same wire shapes as PostgREST: ISO timestamps and YYYY-MM-DD dates as strings.
const PARSERS = {
  1082: v => v,
  1184: v => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString()
};

function loadPGlite() {
  try { return require('@electric-sql/pglite').PGlite; }
  catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    return require('../.tmp/db-test/node_modules/@electric-sql/pglite').PGlite;
  }
}

async function createSqlHarness() {
  const PGlite = loadPGlite();
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await pg.exec(fs.readFileSync(MIGRATION, 'utf8'));
  await pg.exec('set role service_role');
  const failing = new Set();           // rpc or table names that return a PostgREST-style error
  const calls = [];
  const query = (sql, params) => pg.query(sql, params, { parsers: PARSERS });

  async function rpc(name, args = {}) {
    calls.push(name);
    if (failing.has(name) || failing.has('*')) return { data: null, error: { message: 'injected failure' } };
    const spec = RPCS[name];
    if (!spec) return { data: null, error: { message: `unknown rpc ${name}` } };
    const params = [], parts = [];
    spec.args.forEach(a => {
      const [key, cast] = a.split('::');
      if (!(key in args)) return;
      let v = args[key];
      if (cast === 'jsonb' && v != null && typeof v !== 'string') v = JSON.stringify(v);
      params.push(v);
      parts.push(`${key} => $${params.length}${cast ? '::' + cast : ''}`);
    });
    try {
      const sql = spec.set ? `select * from public.${name}(${parts.join(', ')})`
        : `select public.${name}(${parts.join(', ')}) as value`;
      const { rows } = await query(sql, params);
      return { data: spec.set ? rows : rows[0].value, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  }

  function from(table) {
    const filters = [], params = [];
    let columns = '*', orderBy = '', limit = 1000;
    const push = (op, k, v) => {
      if (!IDENT.test(k)) throw new Error('bad column');
      params.push(v); filters.push(`${k} ${op} $${params.length}`);
    };
    const b = {
      select(cols = '*') { columns = cols; return b; },
      eq(k, v) { push('=', k, v); return b; },
      gt(k, v) { push('>', k, v); return b; },
      order(k, { ascending = true } = {}) {
        if (!IDENT.test(k)) throw new Error('bad column');
        orderBy = ` order by ${k} ${ascending ? 'asc' : 'desc'}`; return b;
      },
      limit(n) { limit = Math.max(0, Math.floor(n)); return b; },
      then(resolve, reject) {
        const run = async () => {
          calls.push(`from:${table}`);
          if (failing.has(table) || failing.has('*') || !TABLES.has(table)) {
            return { data: null, error: { message: `table ${table} unavailable` } };
          }
          if (columns !== '*' && !columns.split(',').every(c => IDENT.test(c.trim()))) throw new Error('bad columns');
          const where = filters.length ? ` where ${filters.join(' and ')}` : '';
          const { rows } = await query(`select ${columns} from public.${table}${where}${orderBy} limit ${limit}`, params);
          return { data: rows, error: null };
        };
        return run().then(resolve, reject);
      }
    };
    return b;
  }

  return {
    pg, client: { rpc, from }, calls,
    fail(name) { failing.add(name); }, heal(name) { if (name) failing.delete(name); else failing.clear(); },
    one: async (sql, params = []) => (await query(sql, params)).rows[0],
    exec: sql => pg.exec(sql),
    close: () => pg.close()
  };
}

module.exports = { createSqlHarness, MIGRATION };
