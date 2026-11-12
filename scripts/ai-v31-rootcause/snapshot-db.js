'use strict';
// In-memory, read-only stand-in for the `products` table built from a
// catalog snapshot (scripts/ai-v31-rootcause/catalog-snapshot.js).
// Implements the subset of the PostgREST-style builder the AI catalog uses:
// select / eq / ilike / gte / lte / in / or(ilike only) / order / limit.
// Without .order(), rows come back in snapshot id order, approximating an
// unordered heap scan (real Postgres order is not reproducible offline).
const fs = require('node:fs');

function likeToRegex(pattern) {
  let re = '';
  for (const ch of String(pattern)) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function loadSnapshot(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const r = JSON.parse(line);
    return { ...r, link: 'https://link.invalid/' + encodeURIComponent(r.mall) + '/' + encodeURIComponent(r.product_id), image: '' };
  });
}

function createSnapshotDb(rows, { onQuery } = {}) {
  const stats = { queries: 0, rowsReturned: 0 };
  function from(table) {
    if (table !== 'products') throw new Error('snapshot has only products');
    return {
      select() {
        const filters = [];
        let orderBy = null, desc = false;
        const builder = {
          eq(c, v) { filters.push(r => String(r[c]) === String(v)); return builder; },
          ilike(c, v) { const re = likeToRegex(v); filters.push(r => re.test(String(r[c] == null ? '' : r[c]))); return builder; },
          gte(c, v) { filters.push(r => Number(r[c]) >= Number(v)); return builder; },
          lte(c, v) { filters.push(r => Number(r[c]) <= Number(v)); return builder; },
          gt(c, v) { filters.push(r => Number(r[c]) > Number(v)); return builder; },
          in(c, values) { const set = new Set(values.map(String)); filters.push(r => set.has(String(r[c]))); return builder; },
          not(c, op, v) {
            if (op !== 'ilike') throw new Error('unsupported not() op: ' + op);
            const re = likeToRegex(v); filters.push(r => !re.test(String(r[c] == null ? '' : r[c]))); return builder;
          },
          or(expr) {
            // Only "col.ilike.pattern,col.ilike.pattern" is supported.
            const parts = String(expr).split(',').map(s => s.trim()).filter(Boolean).map(s => {
              const m = s.match(/^([a-z_]+)\.ilike\.(.*)$/i);
              if (!m) throw new Error('unsupported or() clause: ' + s);
              return { c: m[1], re: likeToRegex(m[2].replace(/\*/g, '%')) };
            });
            filters.push(r => parts.some(p => p.re.test(String(r[p.c] == null ? '' : r[p.c]))));
            return builder;
          },
          order(c, opts = {}) { orderBy = c; desc = opts.ascending === false; return builder; },
          async limit(n) {
            stats.queries++;
            let out = rows.filter(r => filters.every(f => f(r)));
            if (orderBy) {
              out = out.slice().sort((a, b) => {
                const x = a[orderBy], y = b[orderBy];
                const cmp = x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0;
                return desc ? -cmp : cmp;
              });
            }
            out = out.slice(0, n);
            stats.rowsReturned += out.length;
            if (onQuery) onQuery({ filters: filters.length, returned: out.length });
            return { data: out.map(r => ({ ...r })), error: null };
          }
        };
        return builder;
      }
    };
  }
  return { from, stats };
}
module.exports = { loadSnapshot, createSnapshotDb, likeToRegex };
