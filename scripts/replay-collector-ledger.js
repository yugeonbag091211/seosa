#!/usr/bin/env node
'use strict';

/*
 * Request-level replay of the FINAL query-ledger policy over real provider call logs.
 *
 *   node scripts/replay-collector-ledger.js 2026-09-26 2026-10-02 [--sources collect,cron] [--out file.json]
 *
 * Production access is SELECT-only (coupang_api_calls, adpick_api_calls). No RPC, no write,
 * no provider call. The output holds aggregates only (no query text).
 *
 * Policy simulated per provider + KST date + queryIdentity (api/_collector-query.js):
 *   first call                         → request
 *   after a successful answer           → reused (cache), no request
 *   after an unfinished request ('pending' log row) → never re-requested that day
 *   after AUTH_ERROR / INVALID_PRODUCT  → never re-requested that day
 *   after a retryable failure           → one more request, only ≥ 2 minutes later
 * Historical responses are not stored, so a suppressed call whose real outcome was a success
 * after an earlier failure is reported as `success_at_risk` rather than assumed recovered.
 */
const { queryIdentity, RETRY_MS, MAX_REQUESTS } = require('../api/_collector-query');
const Failure = require('../api/_collector-failure');

/** Historical log row → final failure reason (null = success, 'UNCERTAIN' = unfinished). */
function outcomeReason(provider, row) {
  const outcome = String(row.outcome || '');
  if (outcome === 'ok') return null;
  if (outcome === 'pending') return 'UNCERTAIN';
  if (outcome === 'timeout') return 'TIMEOUT';
  if (outcome === 'network_error') return 'NETWORK_ERROR';
  if (outcome === 'param_error') return 'INVALID_PRODUCT';
  if (outcome === 'parse_error' || outcome === 'invalid_response') return 'SOURCE_ERROR';
  if (outcome === 'blocked_html') return 'AUTH_ERROR';
  if (outcome === '403') return 'AUTH_ERROR';
  if (outcome === '429') return 'RATE_LIMIT';
  if (outcome === 'blocked') return Failure.fromHttpStatus(Number(row.r_code)) || 'SOURCE_ERROR';
  const http = Failure.fromHttpStatus(Number(row.http_status));
  if (http) return http;
  return 'UNKNOWN'; // e.g. ADPICK HTTP 200 success=false
}

/**
 * calls: [{ provider, kstDate, query, at (ms), outcome, http_status, r_code, items }]
 * Returns per provider/day aggregates for the historical (before) and simulated (after) runs.
 */
function simulate(calls) {
  const groups = new Map();
  for (const c of calls) {
    const id = queryIdentity(c.query);
    const key = `${c.provider}|${c.kstDate}|${id}`;
    if (!groups.has(key)) groups.set(key, { provider: c.provider, kstDate: c.kstDate, id, raw: new Set(), calls: [] });
    const g = groups.get(key);
    g.raw.add(String(c.query || '').trim());
    g.calls.push(c);
  }
  const days = new Map();
  const day = (provider, kstDate) => {
    const k = `${provider}|${kstDate}`;
    if (!days.has(k)) days.set(k, { provider, kst_date: kstDate, before_calls: 0, after_calls: 0, identities: 0,
      raw_query_keys: 0, before_duplicate_calls: 0, after_duplicate_calls: 0, suppressed_after_success: 0,
      suppressed_terminal_or_uncertain: 0, suppressed_backoff_or_cap: 0, success_at_risk: 0,
      before_failed_calls: 0, after_failed_requests: 0 });
    return days.get(k);
  };
  for (const g of groups.values()) {
    const d = day(g.provider, g.kstDate);
    d.identities++; d.raw_query_keys += g.raw.size;
    g.calls.sort((a, b) => a.at - b.at || a.seq - b.seq);
    let state = 'none', requests = 0, failedAt = 0, succeeded = false;
    for (const c of g.calls) {
      d.before_calls++;
      const reason = outcomeReason(g.provider, c);
      if (reason) d.before_failed_calls++;
      let allowed = false;
      if (state === 'none') allowed = true;
      else if (state === 'completed') d.suppressed_after_success++;
      else if (state === 'terminal' || state === 'uncertain') d.suppressed_terminal_or_uncertain++;
      else if (state === 'failed') {
        if (requests < MAX_REQUESTS && c.at >= failedAt + RETRY_MS) allowed = true;
        else d.suppressed_backoff_or_cap++;
      }
      if (!allowed) { if (!reason && !succeeded) d.success_at_risk++; continue; }
      d.after_calls++; requests++;
      if (!reason) { state = 'completed'; succeeded = true; }
      else if (reason === 'UNCERTAIN') state = 'uncertain';
      else if (Failure.isRetryable(reason)) { state = 'failed'; failedAt = c.at; d.after_failed_requests++; }
      else { state = 'terminal'; d.after_failed_requests++; }
    }
  }
  const rows = [...days.values()].map(d => ({ ...d,
    before_duplicate_calls: d.before_calls - d.identities,
    after_duplicate_calls: d.after_calls - d.identities,
    saved_calls: d.before_calls - d.after_calls,
    normalization_merged_keys: d.raw_query_keys - d.identities }))
    .sort((a, b) => a.kst_date.localeCompare(b.kst_date) || a.provider.localeCompare(b.provider));
  return rows;
}

function summarize(rows) {
  const keys = ['before_calls', 'after_calls', 'saved_calls', 'identities', 'raw_query_keys', 'normalization_merged_keys',
    'before_duplicate_calls', 'after_duplicate_calls', 'suppressed_after_success', 'suppressed_terminal_or_uncertain',
    'suppressed_backoff_or_cap', 'success_at_risk', 'before_failed_calls', 'after_failed_requests'];
  const t = Object.fromEntries(keys.map(k => [k, rows.reduce((n, r) => n + r[k], 0)]));
  const pct = (n, d) => (d ? Math.round(n / d * 1e6) / 1e4 : null);
  return { ...t, before_duplicate_ratio_pct: pct(t.before_duplicate_calls, t.before_calls),
    after_duplicate_ratio_pct: pct(t.after_duplicate_calls, t.after_calls),
    call_reduction_pct: pct(t.saved_calls, t.before_calls),
    duplicate_reduction_pct: pct(t.before_duplicate_calls - t.after_duplicate_calls, t.before_duplicate_calls) };
}

function report(rows, { from, to, sources }) {
  const last3From = new Date(Date.parse(`${to}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10);
  return {
    period: { from_kst_date: from, through_kst_date: to }, sources,
    policy: 'final query ledger (provider + KST date + queryIdentity; success reuse; 2 requests/query/day; 2-minute backoff; AUTH/INVALID terminal; unfinished = never re-requested)',
    interpretation: 'Request-savings counterfactual. Historical responses are not stored: success_at_risk counts suppressed calls whose real answer was a success after an earlier failure. Product gains are not inferred.',
    totals: summarize(rows),
    by_provider: Object.fromEntries(['coupang', 'adpick'].map(p => [p, summarize(rows.filter(r => r.provider === p))])),
    latest_three_days: { from_kst_date: last3From, ...summarize(rows.filter(r => r.kst_date >= last3From)) },
    days: rows
  };
}

async function loadCalls(db, from, to, sources) {
  const startUtc = new Date(Date.parse(`${from}T00:00:00+09:00`)).toISOString();
  const endUtc = new Date(Date.parse(`${to}T00:00:00+09:00`) + 86400000).toISOString();
  const kst = iso => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);
  const page = async (table, columns, filters) => {
    const out = []; let cursor = 0;
    for (;;) {
      let q = db.from(table).select(columns).order('id', { ascending: true }).limit(1000).gt('id', cursor);
      for (const [op, col, val] of filters) q = q[op](col, val);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...data);
      if (data.length < 1000) return out;
      cursor = data[data.length - 1].id;
    }
  };
  const coupang = await page('coupang_api_calls', 'id,called_at,source,keyword,outcome,http_status,r_code,items',
    [['gte', 'called_at', startUtc], ['lt', 'called_at', endUtc], ['in', 'source', sources]]);
  const adpick = await page('adpick_api_calls', 'id,called_at,kst_date,source,query,outcome,http_status,items',
    [['gte', 'kst_date', from], ['lte', 'kst_date', to], ['in', 'source', sources], ['eq', 'operation', 'search']]);
  return [
    ...coupang.map(r => ({ provider: 'coupang', kstDate: kst(r.called_at), query: r.keyword, at: Date.parse(r.called_at),
      seq: r.id, outcome: r.outcome, http_status: r.http_status, r_code: r.r_code, items: r.items })),
    ...adpick.map(r => ({ provider: 'adpick', kstDate: String(r.kst_date), query: r.query, at: Date.parse(r.called_at),
      seq: r.id, outcome: r.outcome, http_status: r.http_status, items: r.items }))
  ];
}

if (require.main === module) {
  (async () => {
    const [from, to] = process.argv.slice(2, 4);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
      console.error('usage: node scripts/replay-collector-ledger.js FROM_KST_DATE TO_KST_DATE [--sources collect,cron] [--out file]');
      process.exitCode = 1; return;
    }
    const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
    const sources = (arg('--sources') || 'collect').split(',');
    require('./_env');
    // SELECT-only wrapper: anything but from().select() chains throws.
    const real = require('../api/_supabase');
    const db = { from: table => ({ select: cols => real.from(table).select(cols) }) };
    const rows = simulate(await loadCalls(db, from, to, sources));
    const out = report(rows, { from, to, sources });
    const text = JSON.stringify(out, null, 2);
    if (arg('--out')) require('fs').writeFileSync(arg('--out'), text + '\n');
    console.log(text);
  })().catch(e => { console.error(`Replay failed: ${e.message}`); process.exitCode = 1; });
}

module.exports = { simulate, summarize, report, outcomeReason };
