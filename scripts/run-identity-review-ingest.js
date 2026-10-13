#!/usr/bin/env node
'use strict';

/* Phase 4 HOLD-only queue ingest. Dry-run unless --write and the opt-in env are both set. */
const execFileSync = require('child_process').execFileSync;
const OI = require('../api/_offeridentity');
const SH = require('../api/_identityshadow');
const P = require('../api/_identitypromotion');
const R = require('../api/_identityreview');
const Promotion = require('./run-offer-identity-promotion');

const PAGE = 1000;
function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
function parseArgs(argv) {
  const a = argv || [];
  const flag = name => a.includes(name);
  const value = (name, fallback) => {
    const i = a.indexOf(name);
    return i >= 0 && a[i + 1] && !String(a[i + 1]).startsWith('--') ? a[i + 1] : fallback;
  };
  const write = flag('--write');
  if (write && flag('--dry-run')) throw new Error('--write 와 --dry-run 은 함께 쓸 수 없습니다');
  const limit = positiveInt(value('--limit', 0), 0);
  const runId = positiveInt(value('--run-id', 0), 0);
  if (write && !runId) throw new Error('--write 에는 고정된 --run-id 가 필요합니다');
  if (write && !limit) throw new Error('--write 에는 queue 상한 --limit N 이 필요합니다');
  return { runId, limit, write, dryRun: !write, explain: flag('--explain'), minRuns: positiveInt(value('--min-runs', process.env.IDENTITY_PROMOTION_MIN_RUNS || 1), 1) };
}
function enabled(env) { return /^(true|1)$/i.test(String((env || process.env).IDENTITY_REVIEW_ENABLED || '').trim()); }
function matcherVersion() {
  return R.matcherVersion();
}
function errorIf(r, label) {
  if (r && r.error) throw new Error(`${label}: ${r.error.message || r.error.code || 'DB error'}`);
  return r || { data: null };
}
async function loadProducts(db) {
  const rows = [];
  let after = 0;
  for (;;) {
    const r = errorIf(await db.from('products').select('id,product_id,mall,mall_label,title,lprice,vendor_item_id')
      .gt('id', after).order('id', { ascending: true }).limit(PAGE), 'products 읽기 실패');
    const page = r.data || [];
    if (!page.length) break;
    rows.push(...page);
    after = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }
  const offers = rows.map(R.sourceRowToOffer);
  return { rows, offers, byOfferKey: new Map(offers.map(o => [o.key, o])) };
}
async function queueRows(db) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const r = errorIf(await db.from('identity_review_queue')
      .select('group_key,candidate_hash,status,promotion_policy_version,matcher_version')
      .order('id', { ascending: true }).range(from, from + PAGE - 1), 'existing review queue 읽기 실패');
    const page = r.data || [];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}
async function loadCanonicalMembers(db) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const r = errorIf(await db.from('canonical_product_members').select('source_mall,product_id')
      .order('id', { ascending: true }).range(from, from + PAGE - 1), 'canonical member 읽기 실패');
    const page = r.data || [];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}
async function safety(db) {
  return {
    products: await Promotion.countRows(db, 'products'),
    price_history: await Promotion.countRows(db, 'price_history'),
    canonical_groups: await Promotion.countRows(db, 'canonical_product_groups'),
    canonical_members: await Promotion.countRows(db, 'canonical_product_members'),
    canonical_promotions: await Promotion.countRows(db, 'canonical_product_promotions'),
    review_queue: await Promotion.countRows(db, 'identity_review_queue'),
    review_decisions: await Promotion.countRows(db, 'identity_review_decisions')
  };
}

async function run(db, options) {
  const opts = Object.assign({ runId: 0, limit: 0, write: false, dryRun: true, minRuns: 1, explain: false }, options || {});
  const matcher = opts.matcherVersion || matcherVersion();
  const stats = {
    runId: null, shadowGroups: 0, crossMerchantGroups: 0, phase3Hold: 0,
    eligibleHold: 0, queueCandidates: 0, written: 0, hardConflictExcluded: 0,
    alreadyDecided: 0, alreadyQueued: 0, alreadyCanonical: 0, stale: 0,
    promoteNotIngested: 0, rejectNotIngested: 0
  };
  const runRow = await Promotion.loadRun(db, opts.runId);
  if (!runRow || runRow.status !== 'completed') return { failed: true, reason: 'completed_shadow_run_required', stats };
  stats.runId = runRow.id;
  const [groups, shadowMembers, catalog, queue, canonicalMembers] = await Promise.all([
    Promotion.loadRows(db, 'identity_shadow_groups', 'id,run_id,group_key,confidence_tier,member_count,merchant_count,canonical_identity,lowest_price,lowest_mall', runRow.id),
    Promotion.loadRows(db, 'identity_shadow_group_members', 'id,run_id,group_id,product_id,mall,vendor_item_id,offer_key,tier,confidence,evidence,unknown,identity_snapshot', runRow.id),
    loadProducts(db),
    queueRows(db),
    loadCanonicalMembers(db)
  ]);
  const groupedMembers = Promotion.groupMembers(shadowMembers);
  const currentContext = OI.contextFactory(catalog.offers);
  const histories = await Promotion.loadHistoryCounts(db, groups);
  const canonicalSet = new Set(canonicalMembers.map(x => `${x.source_mall}\0${x.product_id}`));
  const existingQueue = new Map(queue.map(x => [
    `${x.group_key}\0${x.promotion_policy_version}\0${x.matcher_version}\0${x.candidate_hash}`, x
  ]));
  const candidates = [];

  for (const group of groups) {
    stats.shadowGroups++;
    const sourceMembers = groupedMembers.get(group.id) || [];
    const fresh = Promotion.offerSnapshotForShadow(sourceMembers, catalog.byOfferKey);
    if (fresh.reasons.length || fresh.offers.length !== Number(group.member_count)) {
      stats.stale++;
      continue;
    }
    if (R.merchantCountOf(fresh.offers) < 2) continue;
    stats.crossMerchantGroups++;
    const evaluation = P.evaluateGroup({
      run: runRow, group, members: fresh.offers, contextFactory: currentContext,
      observedRuns: histories.get(group.group_key) || 0, minRuns: opts.minRuns
    });
    if (evaluation.decision === P.DECISION.PROMOTE) { stats.promoteNotIngested++; continue; }
    if (evaluation.decision === P.DECISION.REJECT) {
      stats.rejectNotIngested++;
      if ((evaluation.pairs || []).some(x => (x.result.conflicts || []).length || x.result.decision === OI.DECISION.NO_MATCH)) stats.hardConflictExcluded++;
      continue;
    }
    stats.phase3Hold++;
    const eligible = R.evaluationIsEligible(evaluation, fresh.offers, group);
    if (!eligible.eligible) {
      if (eligible.reason === 'HARD_CONFLICT') stats.hardConflictExcluded++;
      else if (eligible.reason === 'STALE_OR_INCOMPLETE') stats.stale++;
      continue;
    }
    const alreadyCanonical = fresh.offers.some(x => canonicalSet.has(`${x.sourceMall}\0${x.productId}`));
    if (alreadyCanonical) { stats.alreadyCanonical++; continue; }
    stats.eligibleHold++;
    const row = R.buildQueueRow({ run: runRow, group, evaluation, members: fresh.offers, currentMatcherVersion: matcher });
    const id = `${row.group_key}\0${row.promotion_policy_version}\0${row.matcher_version}\0${row.candidate_hash}`;
    const old = existingQueue.get(id);
    if (old) {
      if (['APPROVED', 'REJECTED', 'DEFERRED', 'STALE'].includes(old.status)) stats.alreadyDecided++;
      else stats.alreadyQueued++;
      continue;
    }
    candidates.push(row);
  }
  stats.queueCandidates = candidates.length;
  const before = await safety(db);
  let after = null;
  if (opts.write) {
    if (!enabled(opts.env)) return { failed: true, reason: 'IDENTITY_REVIEW_ENABLED=true_required', stats, safety: { before, after: null } };
    const limited = opts.limit ? candidates.slice(0, opts.limit) : candidates;
    if (!limited.length) return { failed: false, dryRun: false, stats, safety: { before, after: before }, sample: [] };
    const inserted = errorIf(await db.from('identity_review_queue').upsert(limited, {
      onConflict: 'group_key,promotion_policy_version,matcher_version,candidate_hash', ignoreDuplicates: true
    }).select('id'), 'review queue 적재 실패');
    stats.written = (inserted.data || []).length;
    after = await safety(db);
  }
  return {
    failed: false, dryRun: !opts.write, matcherVersion: matcher,
    policyVersion: P.POLICY_VERSION, stats,
    safety: { before, after, productsUnchanged: !after || before.products === after.products,
      priceHistoryUnchanged: !after || before.price_history === after.price_history,
      canonicalUnchanged: !after || ['canonical_groups', 'canonical_members', 'canonical_promotions'].every(k => before[k] === after[k]) },
    sample: opts.explain ? candidates.slice(0, opts.limit || 20).map(x => ({
      group_key: x.group_key, shadow_group_id: x.source_shadow_group_id, priority: x.priority,
      reason_codes: x.reason_codes, candidate_hash: x.candidate_hash
    })) : [],
    queueRows: opts.includeQueueRows ? candidates.slice(0, opts.limit || 10) : undefined
  };
}

async function main() {
  require('./_env.js');
  const opts = parseArgs(process.argv.slice(2));
  if (opts.write && !enabled()) {
    console.log(JSON.stringify({ event: 'disabled', hint: '실제 쓰기는 IDENTITY_REVIEW_ENABLED=true 와 --write 가 모두 필요합니다' }));
    return;
  }
  const result = await run(require('../api/_supabase'), opts);
  console.log(JSON.stringify({ event: 'identity_review_ingest', ...result }));
  if (result.failed) process.exitCode = 1;
}

if (require.main === module) main().catch(err => {
  console.error(JSON.stringify({ event: 'identity_review_ingest_failed', error: err.message }));
  process.exitCode = 1;
});

module.exports = { parseArgs, enabled, matcherVersion, loadProducts, queueRows, loadCanonicalMembers, safety, run };
