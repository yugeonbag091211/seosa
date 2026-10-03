#!/usr/bin/env node
'use strict';

/* Offline, deterministic request-savings replay. No database or shopping API access.
 * Historical response bodies are unavailable: this intentionally predicts no match gain.
 * node scripts/replay-collector-efficiency.js [reports/collector-efficiency-baseline.json]
 */
const fs = require('fs');
const path = require('path');

function number(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

function percentage(numerator, denominator) {
  return denominator ? Math.round(numerator / denominator * 1000000) / 10000 : null;
}

function replay(fixture) {
  if (!fixture || fixture.schema_version !== 1 || !Array.isArray(fixture.days)
      || !Array.isArray(fixture.duplicate_group_histograms)) throw new Error('Invalid evidence schema');
  if (!fixture.period || !/^\d{4}-\d{2}-\d{2}$/.test(fixture.period.through_kst_date)
      || !Number.isFinite(Date.parse(fixture.period.through_kst_date + 'T00:00:00Z'))) throw new Error('Invalid evidence period');
  const seen = new Set();
  const days = fixture.days.map(day => {
    const key = `${day.provider}|${day.kst_date}`;
    if (!['coupang', 'adpick'].includes(day.provider)
        || !/^\d{4}-\d{2}-\d{2}$/.test(day.kst_date) || seen.has(key)) throw new Error('Invalid or duplicate provider/day');
    seen.add(key);
    const calls = number(day.calls, 'calls');
    const unique = number(day.unique_queries, 'unique_queries');
    const duplicates = number(day.duplicate_calls, 'duplicate_calls');
    const reusable = number(day.safely_reusable_calls, 'safely_reusable_calls');
    if (unique > calls || duplicates !== calls - unique || reusable > duplicates) throw new Error('Inconsistent call totals');
    const groups = fixture.duplicate_group_histograms.filter(group => group.provider === day.provider && group.kst_date === day.kst_date);
    let replayDuplicates = 0, replayReusable = 0, repeatedQueries = 0;
    for (const group of groups) {
      const count = number(group.query_groups, 'query_groups');
      const perQuery = number(group.calls_per_query, 'calls_per_query');
      const safe = number(group.safely_reusable_calls_per_query, 'safely_reusable_calls_per_query');
      if (perQuery < 2 || safe >= perQuery) throw new Error('Invalid repeated-query histogram');
      repeatedQueries += count;
      replayDuplicates += count * (perQuery - 1);
      replayReusable += count * safe;
    }
    if (repeatedQueries > unique || replayDuplicates !== duplicates || replayReusable !== reusable) throw new Error('Histogram differs from measured calls');
    return {
      provider: day.provider, kst_date: day.kst_date,
      before_search_calls: calls, unique_queries: unique, before_duplicate_calls: duplicates,
      after_search_calls: calls - replayReusable, after_duplicate_calls: duplicates - replayReusable,
      saved_search_calls: replayReusable, before_duplicate_ratio_pct: percentage(duplicates, calls),
      after_duplicate_ratio_pct: percentage(duplicates - replayReusable, calls - replayReusable),
      call_reduction_pct: percentage(replayReusable, calls),
      additional_attemptable_query_slots: replayReusable,
      additional_product_attempts: null, additional_successful_products: null,
      after_raw_success_rate: null,
    };
  });
  for (const group of fixture.duplicate_group_histograms) {
    if (!seen.has(`${group.provider}|${group.kst_date}`)) throw new Error('Histogram has an unknown provider/day');
  }
  const summarize = rows => {
    const totals = rows.reduce((sum, row) => {
      for (const key of ['before_search_calls', 'unique_queries', 'before_duplicate_calls', 'after_search_calls', 'after_duplicate_calls', 'saved_search_calls']) sum[key] += row[key];
      return sum;
    }, { before_search_calls: 0, unique_queries: 0, before_duplicate_calls: 0, after_search_calls: 0, after_duplicate_calls: 0, saved_search_calls: 0 });
    return { ...totals, call_reduction_pct: percentage(totals.saved_search_calls, totals.before_search_calls),
      duplicate_reduction_pct: percentage(totals.before_duplicate_calls - totals.after_duplicate_calls, totals.before_duplicate_calls),
      before_duplicate_ratio_pct: percentage(totals.before_duplicate_calls, totals.before_search_calls),
      after_duplicate_ratio_pct: percentage(totals.after_duplicate_calls, totals.after_search_calls),
      additional_attemptable_query_slots: totals.saved_search_calls, additional_product_attempts: null,
      additional_successful_products: null, after_raw_success_rate: null };
  };
  return { evidence_period: fixture.period, interpretation: 'Request-savings counterfactual only; successful response reuse may alter matches or prices. Product gain and collection rates require response-level replay or a safe canary.',
    totals: summarize(days), by_provider: Object.fromEntries(['coupang', 'adpick'].map(provider => [provider, summarize(days.filter(row => row.provider === provider))])),
    latest_three_days: summarize(days.filter(day => day.kst_date >= new Date(Date.parse(fixture.period.through_kst_date + 'T00:00:00Z') - 2 * 86400000).toISOString().slice(0, 10))),
    days };
}

if (require.main === module) {
  try {
    const input = process.argv[2] || path.join(__dirname, '../reports/collector-efficiency-baseline.json');
    const fixture = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
    console.log(JSON.stringify(replay(fixture), null, 2));
  } catch (error) { console.error(`Replay failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { replay };
