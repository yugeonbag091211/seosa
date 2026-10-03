#!/usr/bin/env node
'use strict';

/*
 * NO_MATCH cause analysis on today's collector state — production access is SELECT only.
 *
 *   node scripts/analyze-nomatch.js [--out report.json] [--relist-out review.json]
 *
 * Reads price_job_state (today's attempted/covered/option lists), the attempted products,
 * the provider search caches and recent price_history dates; no RPC, no write, no provider
 * call. The report holds aggregates only. --relist-out writes the re-registration review list
 * (old/new IDs and titles) for a human: nothing here ever replaces a tracked product ID.
 */
const fs = require('fs');
const { analyze } = require('./_nomatch-analysis');
const { kstToday, kstDayStartUtc } = require('../api/_price');

const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };

async function selectPaged(db, table, columns, apply, key) {
  const out = [];
  let cursor = null;
  for (;;) {
    let q = apply(db.from(table).select(columns)).order(key, { ascending: true }).limit(1000);
    if (cursor != null) q = q.gt(key, cursor);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
    cursor = data[data.length - 1][key];
  }
}

async function loadSnapshot(db) {
  const today = kstToday();
  const { data: rows, error } = await db.from('price_job_state').select('job_date,last_result').limit(1);
  if (error || !rows || !rows[0]) throw new Error('price_job_state unavailable');
  const state = rows[0];
  if (state.job_date !== today) throw new Error(`collector state is for ${state.job_date}, not today ${today}`);
  const malls = {}, products = [], lastPrice = {}, caches = {};
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
  for (const [mall, v] of Object.entries(state.last_result.malls || {})) {
    malls[mall] = { attempted: v.collectorAttempted || [], covered: v.collectorCovered || [], option: v.collectorOptionMismatches || [] };
    const ids = [...new Set(malls[mall].attempted.map(k => k.split('|')[0]))];
    lastPrice[mall] = {};
    for (let i = 0; i < ids.length; i += 150) {
      const chunk = ids.slice(i, i + 150);
      products.push(...await selectPaged(db, 'products', 'id,product_id,mall,keyword,title,link,vendor_item_id,collected_at,lprice',
        q => q.in('product_id', chunk).eq('mall', mall), 'id'));
      const hist = await selectPaged(db, 'price_history', 'id,product_id,recorded_date',
        q => q.in('product_id', chunk).eq('mall', mall).gte('recorded_date', since).lt('recorded_date', today), 'id');
      hist.forEach(h => { if (!lastPrice[mall][h.product_id] || h.recorded_date > lastPrice[mall][h.product_id]) lastPrice[mall][h.product_id] = h.recorded_date; });
    }
  }
  for (const [mall, table] of [['쿠팡', 'coupang_search_cache'], ['ADPICK', 'adpick_search_cache']]) {
    caches[mall] = await selectPaged(db, table, 'keyword,items,fetched_at', q => q, 'keyword');
  }
  return { today, dayStartIso: kstDayStartUtc(today), malls, products, lastPrice, caches };
}

if (require.main === module) {
  (async () => {
    require('./_env');
    // SELECT-only facade: nothing but from().select() chains is reachable.
    const real = require('../api/_supabase');
    const db = { from: table => ({ select: cols => real.from(table).select(cols) }) };
    const { report, relist } = analyze(await loadSnapshot(db));
    const text = JSON.stringify(report, null, 2);
    if (arg('--out')) fs.writeFileSync(arg('--out'), text + '\n');
    if (arg('--relist-out')) fs.writeFileSync(arg('--relist-out'), JSON.stringify(relist, null, 2) + '\n');
    console.log(text);
  })().catch(e => { console.error(`analyze-nomatch failed: ${e.message}`); process.exitCode = 1; });
}

module.exports = { loadSnapshot };
