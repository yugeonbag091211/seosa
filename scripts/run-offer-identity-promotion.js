#!/usr/bin/env node
'use strict';

/*
 * Product Identity Phase 3 promotion runner.
 *
 * Reads completed Phase 2 shadow groups and the current products catalog, then
 * revalidates every member pair using the current Phase 1 matcher. Dry-run is
 * the default. Production writes require both --write and
 * IDENTITY_PROMOTION_ENABLED=true, plus an explicit run id and promotion cap.
 */

const { execFileSync } = require('child_process');
const OI = require('../api/_offeridentity');
const SH = require('../api/_identityshadow');
const P = require('../api/_identitypromotion');

const DEFAULTS = Object.freeze({ pageSize: 1000, minRuns: 1, maxPromotions: 0, limit: 0, sample: 10 });

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
  const runId = positiveInt(value('--run-id', 0), 0);
  const groupIds = [...new Set(a.flatMap((x, i) => x === '--group-id' ? [positiveInt(a[i + 1], 0)] : []).filter(Boolean))];
  const write = flag('--write');
  if (write && flag('--dry-run')) throw new Error('--write 와 --dry-run 은 함께 쓸 수 없습니다');
  const opts = {
    runId, groupIds,
    dryRun: !write || flag('--dry-run'),
    write,
    explain: flag('--explain'),
    limit: positiveInt(value('--limit', 0), 0),
    sample: positiveInt(value('--sample', DEFAULTS.sample), DEFAULTS.sample),
    maxPromotions: positiveInt(value('--max-promotions', 0), 0),
    minRuns: positiveInt(value('--min-runs', process.env.IDENTITY_PROMOTION_MIN_RUNS || DEFAULTS.minRuns), DEFAULTS.minRuns)
  };
  if (write && !runId) throw new Error('--write 에는 고정된 --run-id 가 필요합니다');
  if (write && !opts.maxPromotions) throw new Error('--write 에는 소규모 쓰기 상한 --max-promotions N 이 필요합니다');
  return opts;
}

function promotionEnabled(env) {
  const flag = String(((env || process.env).IDENTITY_PROMOTION_ENABLED) || '').trim().toLowerCase();
  return flag === 'true' || flag === '1';
}

function matcherVersion() {
  if (process.env.GITHUB_SHA) return String(process.env.GITHUB_SHA).slice(0, 40);
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (_) { return 'unknown'; }
}

function failOnError(response, label) {
  if (response && response.error) throw new Error(`${label}: ${response.error.message || response.error.code || 'DB error'}`);
  return response || { data: null };
}

async function loadRun(db, runId) {
  let q = db.from('identity_shadow_runs').select('*');
  if (runId) q = q.eq('id', runId);
  else q = q.eq('status', 'completed').order('finished_at', { ascending: false }).limit(1);
  const r = failOnError(await q.maybeSingle(), 'shadow run 읽기 실패');
  return r.data || null;
}

async function loadRows(db, table, columns, runId) {
  const rows = [];
  for (let from = 0; ; from += DEFAULTS.pageSize) {
    let q = db.from(table).select(columns);
    if (runId != null) q = q.eq('run_id', runId);
    q = q.order('id', { ascending: true }).range(from, from + DEFAULTS.pageSize - 1);
    const r = failOnError(await q, `${table} 읽기 실패`);
    const page = r.data || [];
    if (!page.length) break;
    rows.push(...page);
    if (page.length < DEFAULTS.pageSize) break;
  }
  return rows;
}

async function loadProducts(db, opts) {
  const rows = [];
  let after = 0;
  for (;;) {
    const r = failOnError(await db.from('products')
      .select('id, product_id, mall, mall_label, title, vendor_item_id')
      .gt('id', after).order('id', { ascending: true }).limit(DEFAULTS.pageSize), 'products 읽기 실패');
    const page = r.data || [];
    if (!page.length) break;
    rows.push(...page);
    after = page[page.length - 1].id;
    if (page.length < DEFAULTS.pageSize) break;
  }
  const offers = rows.map(row => {
    const displayMall = row.mall_label ? `${row.mall}/${row.mall_label}` : row.mall;
    const id = OI.parseOffer({
      key: `${row.mall}|${row.product_id}`, title: row.title, mall: displayMall,
      productId: row.product_id, vendorItemId: row.vendor_item_id || ''
    });
    id.sourceMall = String(row.mall || '');
    return id;
  });
  return {
    rows,
    offers,
    byOfferKey: new Map(offers.map(x => [x.key, x])),
    sourceRowByOfferKey: new Map(rows.map(x => [`${x.mall}|${x.product_id}`, x]))
  };
}

async function countRows(db, table) {
  const r = failOnError(await db.from(table).select('id', { count: 'exact', head: true }), `${table} count 실패`);
  if (Number.isFinite(r.count)) return r.count;
  return (r.data || []).length;
}

async function safetySnapshot(db, _productCount, currentCanonicalCounts) {
  return {
    products: await countRows(db, 'products'),
    price_history: await countRows(db, 'price_history'),
    canonical_groups: currentCanonicalCounts.groups,
    canonical_members: currentCanonicalCounts.members,
    canonical_promotions: currentCanonicalCounts.promotions
  };
}

async function loadHistoryCounts(db, groups) {
  const keys = [...new Set(groups.map(g => g.group_key).filter(Boolean))];
  const seenByKey = new Map(keys.map(k => [k, new Set()]));
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = failOnError(await db.from('identity_shadow_groups').select('run_id, group_key').in('group_key', chunk), 'shadow history 읽기 실패');
    (r.data || []).forEach(x => { if (seenByKey.has(x.group_key)) seenByKey.get(x.group_key).add(x.run_id); });
  }
  const runIds = [...new Set([...seenByKey.values()].flatMap(x => [...x]))];
  const completed = new Set();
  for (let i = 0; i < runIds.length; i += 500) {
    const r = failOnError(await db.from('identity_shadow_runs').select('id, status').in('id', runIds.slice(i, i + 500)), 'shadow run history 읽기 실패');
    (r.data || []).filter(x => x.status === 'completed').forEach(x => completed.add(x.id));
  }
  const counts = new Map();
  seenByKey.forEach((ids, key) => counts.set(key, [...ids].filter(id => completed.has(id)).length));
  return counts;
}

function groupMembers(rows) {
  const out = new Map();
  rows.forEach(row => {
    if (!out.has(row.group_id)) out.set(row.group_id, []);
    out.get(row.group_id).push(row);
  });
  return out;
}

function emptyStats() {
  return {
    shadowGroupsEvaluated: 0, crossMerchantGroups: 0,
    promote: 0, hold: 0, reject: 0, tierA: 0, tierB: 0,
    missingModelHolds: 0, missingStorageHolds: 0, missingVariantHolds: 0,
    conflictRejects: 0, newCanonicalGroups: 0, existingCanonicalUnchanged: 0,
    suspendedGroups: 0, durationMs: 0
  };
}

function recordDecision(stats, evaluation, fallbackTier) {
  stats.shadowGroupsEvaluated++;
  if (evaluation.merchantCount >= 2) stats.crossMerchantGroups++;
  stats[evaluation.decision.toLowerCase()]++;
  const tier = evaluation.tier || fallbackTier || '';
  if (tier === 'A') stats.tierA++;
  if (tier === 'B') stats.tierB++;
  if (evaluation.decision === P.DECISION.HOLD
    && evaluation.reasonCodes.some(x => ['HOLD_MISSING_MODEL', 'HOLD_MISSING_MODEL_NUMBER', 'HOLD_MODEL_NUMBER_NOT_EXACT'].includes(x))) stats.missingModelHolds++;
  if (evaluation.reasonCodes.includes('HOLD_MISSING_STORAGE')) stats.missingStorageHolds++;
  if (evaluation.reasonCodes.includes('HOLD_MISSING_VARIANT')) stats.missingVariantHolds++;
  if (evaluation.decision === P.DECISION.REJECT && evaluation.reasonCodes.some(x => x.startsWith('REJECT_') && !x.includes('NOT_CROSS_MERCHANT'))) stats.conflictRejects++;
}

function offerSnapshotForShadow(shadowMembers, byOfferKey) {
  const offers = [];
  const reasons = [];
  for (const member of shadowMembers) {
    const offer = byOfferKey.get(member.offer_key);
    if (!offer) { reasons.push('HOLD_CURRENT_PRODUCT_MISSING'); continue; }
    if (offer.mall !== member.mall) { reasons.push('HOLD_MERCHANT_CHANGED'); continue; }
    if (String(offer.vendorItemId || '') !== String(member.vendor_item_id || '')) { reasons.push('HOLD_VENDOR_ITEM_CHANGED'); continue; }
    offers.push(offer);
  }
  return { offers, reasons: [...new Set(reasons)] };
}

async function loadCanonical(db) {
  const groups = await loadRows(db, 'canonical_product_groups',
    'id, canonical_key, status, identity, confidence_tier, promotion_policy_version, matcher_id, matcher_version, source_shadow_run_id, suspension_reason_codes', null);
  const members = await loadRows(db, 'canonical_product_members',
    'id, group_id, product_id, source_mall, mall, vendor_item_id, offer_key, identity_snapshot, evidence, source_shadow_run_id', null);
  return { groups, members, membersByGroup: groupMembers(members) };
}

function sourceKey(offer) { return `${offer.sourceMall || (offer.key || '').split('|')[0]}\u0000${offer.productId || ''}`; }

async function writeAudit(db, run, group, evaluation, canonicalGroupId, opts) {
  const evaluationKey = group ? `shadow:${group.id}` : `canonical:${canonicalGroupId}`;
  const row = {
    shadow_run_id: run.id,
    shadow_group_id: group ? group.id : null,
    evaluation_key: evaluationKey,
    canonical_group_id: canonicalGroupId || null,
    decision: evaluation.decision,
    reason_codes: evaluation.reasonCodes,
    policy_version: P.POLICY_VERSION,
    matcher_id: SH.MATCHER_ID,
    matcher_version: opts.matcherVersion,
    evaluated_at: new Date(opts.now()).toISOString()
  };
  const r = failOnError(await db.from('canonical_product_promotions')
    .upsert(row, { onConflict: 'shadow_run_id,evaluation_key,policy_version' }).select('id'), 'promotion audit 저장 실패');
  return r.data && r.data[0] ? r.data[0].id : null;
}

async function suspendCanonical(db, run, canonicalGroup, reasonCodes, opts) {
  const reasons = [...new Set(reasonCodes)];
  const rejected = reasons.some(x => String(x).startsWith('REJECT_'));
  const now = new Date(opts.now()).toISOString();
  failOnError(await db.from('canonical_product_groups').update({
    status: 'SUSPENDED', suspension_reason_codes: reasons, updated_at: now
  }).eq('id', canonicalGroup.id).select('id'), 'canonical group suspension 실패');
  const evaluation = {
    decision: rejected ? P.DECISION.REJECT : P.DECISION.HOLD,
    reasonCodes: [rejected ? 'REJECT_EXISTING_CANONICAL_INVALID' : 'HOLD_EXISTING_CANONICAL_UNVERIFIED', ...reasons]
  };
  await writeAudit(db, run, null, evaluation, canonicalGroup.id, opts);
  canonicalGroup.status = 'SUSPENDED';
  canonicalGroup.suspension_reason_codes = evaluation.reasonCodes;
  return evaluation;
}

async function activateCanonical(db, canonical, opts) {
  if (canonical.status === 'ACTIVE') return canonical;
  failOnError(await db.from('canonical_product_groups').update({
    status: 'ACTIVE', suspension_reason_codes: [], updated_at: new Date(opts.now()).toISOString()
  }).eq('id', canonical.id).select('id'), 'canonical group 활성화 실패');
  canonical.status = 'ACTIVE';
  canonical.suspension_reason_codes = [];
  return canonical;
}

async function ensureCanonicalGroup(db, run, evaluation, group, existing, opts) {
  let canonical = existing;
  let created = false;
  if (!canonical) {
    const payload = {
      canonical_key: evaluation.canonicalKey,
      status: 'SUSPENDED',
      identity: evaluation.canonicalIdentity,
      confidence_tier: evaluation.tier,
      promotion_policy_version: P.POLICY_VERSION,
      matcher_id: SH.MATCHER_ID,
      matcher_version: opts.matcherVersion,
      source_shadow_run_id: run.id,
      suspension_reason_codes: ['promotion_write_pending'],
      updated_at: new Date(opts.now()).toISOString()
    };
    const ins = await db.from('canonical_product_groups').insert(payload).select('id, canonical_key, status');
    if (ins.error && ins.error.code !== '23505') throw new Error(`canonical group 생성 실패: ${ins.error.message}`);
    if (!ins.error && ins.data && ins.data[0]) {
      canonical = Object.assign({}, payload, ins.data[0]);
      created = true;
    } else {
      const found = failOnError(await db.from('canonical_product_groups').select('*').eq('canonical_key', evaluation.canonicalKey).maybeSingle(), 'canonical group 재조회 실패');
      canonical = found.data;
      if (!canonical) throw new Error('canonical group 유일 키 충돌 뒤 행을 찾지 못했습니다');
    }
  }

  if (canonical.status === 'SUSPENDED'
    && !(canonical.suspension_reason_codes || []).includes('promotion_write_pending')) {
    return { canonical, created: false, refused: 'HOLD_EXISTING_CANONICAL_SUSPENDED' };
  }

  const expected = [...(evaluation.members || [])];
  const beforeRows = failOnError(await db.from('canonical_product_members')
    .select('source_mall, product_id, group_id').eq('group_id', canonical.id), 'canonical members 선행 확인 실패');
  const previouslyPresent = new Set((beforeRows.data || []).map(m => `${m.source_mall}\u0000${m.product_id}`));
  const addedMembers = expected.filter(m => !previouslyPresent.has(`${m.source_mall}\u0000${m.product_id}`)).length;
  if (canonical.status === 'ACTIVE' && addedMembers > 0) {
    failOnError(await db.from('canonical_product_groups').update({
      status: 'SUSPENDED', suspension_reason_codes: ['promotion_write_pending'],
      updated_at: new Date(opts.now()).toISOString()
    }).eq('id', canonical.id).select('id'), 'canonical group pending 전환 실패');
    canonical.status = 'SUSPENDED';
    canonical.suspension_reason_codes = ['promotion_write_pending'];
  }
  const rows = expected.map(m => Object.assign({}, m, {
    group_id: canonical.id,
    source_shadow_run_id: run.id
  }));
  if (rows.length) {
    failOnError(await db.from('canonical_product_members')
      .upsert(rows, { onConflict: 'source_mall,product_id', ignoreDuplicates: true }).select('id'), 'canonical members 저장 실패');
  }
  const current = failOnError(await db.from('canonical_product_members')
    .select('source_mall, product_id, group_id').eq('group_id', canonical.id), 'canonical members 검증 실패');
  const present = new Set((current.data || []).map(m => `${m.source_mall}\u0000${m.product_id}`));
  const missing = expected.filter(m => !present.has(`${m.source_mall}\u0000${m.product_id}`));
  if (missing.length) {
    const reasonCodes = ['promotion_write_pending'];
    failOnError(await db.from('canonical_product_groups').update({
      status: 'SUSPENDED', suspension_reason_codes: reasonCodes,
      updated_at: new Date(opts.now()).toISOString()
    }).eq('id', canonical.id).select('id'), 'canonical group 보류 전환 실패');
    return { canonical, created, refused: 'HOLD_CANONICAL_MEMBER_CONFLICT' };
  }

  return { canonical, created, addedMembers, needsActivation: canonical.status !== 'ACTIVE', refused: '' };
}

async function run(db, options) {
  const opts = Object.assign({ dryRun: true, write: false, runId: 0, groupIds: [], limit: 0, sample: DEFAULTS.sample,
    minRuns: DEFAULTS.minRuns, maxPromotions: 0, explain: false, now: () => Date.now(), matcherVersion: matcherVersion(), log: null }, options || {});
  opts.groupIds = [...new Set((opts.groupIds || []).map(x => positiveInt(x, 0)).filter(Boolean))];
  const log = typeof opts.log === 'function' ? opts.log : (event, extra) => console.log(JSON.stringify(Object.assign({ event }, extra || {})));
  const started = opts.now();
  const summary = emptyStats();
  const detail = [];
  const runRow = await loadRun(db, opts.runId);
  if (!runRow) return { failed: true, reason: opts.runId ? 'shadow_run_missing' : 'no_completed_shadow_run', summary };
  if (runRow.status !== 'completed') return { failed: true, reason: 'shadow_run_not_completed', runId: runRow.id, summary };

  const [groupsRaw, membersRaw, catalog, canonical] = await Promise.all([
    loadRows(db, 'identity_shadow_groups', 'id, run_id, group_key, confidence_tier, member_count, merchant_count, canonical_identity', runRow.id),
    loadRows(db, 'identity_shadow_group_members', 'id, run_id, group_id, product_id, mall, vendor_item_id, offer_key, tier, confidence, evidence, unknown, identity_snapshot', runRow.id),
    loadProducts(db, opts),
    loadCanonical(db)
  ]);
  const requestedGroupIds = new Set(opts.groupIds);
  const selectedGroups = requestedGroupIds.size ? groupsRaw.filter(g => requestedGroupIds.has(Number(g.id))) : groupsRaw;
  const missingGroupIds = opts.groupIds.filter(id => !groupsRaw.some(g => Number(g.id) === Number(id)));
  if (missingGroupIds.length) return { failed: true, reason: 'shadow_group_filter_missing', runId: runRow.id, missingGroupIds, summary };
  const groups = opts.limit ? selectedGroups.slice(0, opts.limit) : selectedGroups;
  const membersByGroup = groupMembers(membersRaw);
  const contextFactory = OI.contextFactory(catalog.offers);
  const historyCounts = await loadHistoryCounts(db, groups);

  const canonicalCounts = {
    groups: canonical.groups.length, members: canonical.members.length,
    promotions: await countRows(db, 'canonical_product_promotions')
  };
  const before = await safetySnapshot(db, catalog.rows.length, canonicalCounts);

  const byCanonicalKey = new Map(canonical.groups.map(g => [g.canonical_key, g]));
  const byCanonicalMember = new Map();
  canonical.members.forEach(m => byCanonicalMember.set(`${m.source_mall}\u0000${m.product_id}`, m));
  const currentOffers = catalog.byOfferKey;
  let promotionsWritten = 0;

  // Existing groups are checked on every write-enabled pass. Hard conflicts suspend the group; rows stay for audit.
  if (opts.write) {
    const byGroup = canonical.membersByGroup;
    for (const cg of canonical.groups.filter(g => g.status === 'ACTIVE')) {
      const memberRows = byGroup.get(cg.id) || [];
      const loaded = memberRows.map(m => currentOffers.get(m.offer_key));
      if (loaded.length < 2 || loaded.some(x => !x)) {
        const missing = loaded.length < 2 ? ['REJECT_EXISTING_MEMBER_SNAPSHOT_INCOMPLETE'] : ['REJECT_EXISTING_MEMBER_MISSING'];
        await suspendCanonical(db, runRow, cg, missing, opts);
        summary.suspendedGroups++;
        continue;
      }
      const checked = P.evaluateExistingMembers(loaded, contextFactory);
      if (checked.status !== 'ACTIVE') {
        await suspendCanonical(db, runRow, cg, checked.reasonCodes, opts);
        summary.suspendedGroups++;
      }
    }
  }

  for (const group of groups) {
    const shadowMembers = membersByGroup.get(group.id) || [];
    const fresh = offerSnapshotForShadow(shadowMembers, currentOffers);
    let evaluation;
    if (fresh.reasons.length || shadowMembers.length !== group.member_count) {
      evaluation = { decision: P.DECISION.HOLD,
        reasonCodes: [...new Set([...fresh.reasons, ...(shadowMembers.length !== group.member_count ? ['HOLD_MEMBER_SNAPSHOT_INCOMPLETE'] : [])])],
        merchantCount: 0, tier: group.confidence_tier || '' };
    } else {
      evaluation = P.evaluateGroup({
        run: runRow, group, members: fresh.offers, contextFactory,
        observedRuns: historyCounts.get(group.group_key) || 0,
        minRuns: opts.minRuns
      });
    }

    const existingIds = new Set();
    fresh.offers.forEach(offer => {
      const existingMember = byCanonicalMember.get(sourceKey(offer));
      if (existingMember) existingIds.add(existingMember.group_id);
    });
    let existing = existingIds.size === 1 ? canonical.groups.find(g => g.id === [...existingIds][0]) : null;
    if (existingIds.size > 1) {
      evaluation = { decision: P.DECISION.HOLD, reasonCodes: ['HOLD_MEMBERS_SPAN_CANONICAL_GROUPS'], merchantCount: evaluation.merchantCount || 0, tier: evaluation.tier || '' };
    }
    if (!existing && evaluation.canonicalKey) existing = byCanonicalKey.get(evaluation.canonicalKey) || null;

    if (existing && fresh.offers.length) {
      const oldRows = canonical.membersByGroup.get(existing.id) || [];
      const oldOffers = oldRows.map(m => currentOffers.get(m.offer_key));
      if (oldOffers.some(x => !x)) {
        evaluation = { decision: P.DECISION.HOLD, reasonCodes: ['HOLD_EXISTING_MEMBER_MISSING'], merchantCount: evaluation.merchantCount || 0, tier: evaluation.tier || '' };
      } else {
        const combinedByKey = new Map([...oldOffers, ...fresh.offers].map(x => [x.key, x]));
        const checked = P.evaluateExistingMembers([...combinedByKey.values()], contextFactory);
        if (checked.status === 'SUSPENDED') {
          await suspendCanonical(db, runRow, existing, checked.reasonCodes, opts);
          summary.suspendedGroups++;
          evaluation = { decision: P.DECISION.REJECT,
            reasonCodes: ['REJECT_EXISTING_CANONICAL_CONFLICT', ...checked.reasonCodes],
            merchantCount: evaluation.merchantCount || 0, tier: evaluation.tier || '' };
        } else if (checked.status === 'HOLD') {
          evaluation = { decision: P.DECISION.HOLD,
            reasonCodes: ['HOLD_EXISTING_CANONICAL_REVIEW', ...checked.reasonCodes],
            merchantCount: evaluation.merchantCount || 0, tier: evaluation.tier || '' };
        } else if (evaluation.decision === P.DECISION.PROMOTE && existing.canonical_key !== evaluation.canonicalKey) {
          evaluation = { decision: P.DECISION.HOLD, reasonCodes: ['HOLD_CANONICAL_KEY_DRIFT'],
            merchantCount: evaluation.merchantCount, tier: evaluation.tier };
        }
      }
    }

    // Write caps turn otherwise promotable candidates into an explicit hold.
    if (opts.write && evaluation.decision === P.DECISION.PROMOTE && promotionsWritten >= opts.maxPromotions) {
      evaluation = Object.assign({}, evaluation, { decision: P.DECISION.HOLD, reasonCodes: [...evaluation.reasonCodes, 'HOLD_WRITE_LIMIT'] });
    }

    if (opts.write && evaluation.decision === P.DECISION.PROMOTE) {
      const ensured = await ensureCanonicalGroup(db, runRow, evaluation, group, existing, opts);
      if (ensured.refused) {
        evaluation = { decision: P.DECISION.HOLD, reasonCodes: [...evaluation.reasonCodes, ensured.refused],
          merchantCount: evaluation.merchantCount, tier: evaluation.tier };
      } else {
        await writeAudit(db, runRow, group, evaluation, ensured.canonical.id, opts);
        await activateCanonical(db, ensured.canonical, opts);
        if (ensured.created) summary.newCanonicalGroups++;
        else if (!ensured.addedMembers && !ensured.needsActivation) summary.existingCanonicalUnchanged++;
        promotionsWritten++;
      }
    } else if (opts.write) {
      await writeAudit(db, runRow, group, evaluation, existing && existing.id, opts);
    }

    recordDecision(summary, evaluation, group.confidence_tier);
    const item = {
      shadow_group_id: group.id, group_key: group.group_key,
      decision: evaluation.decision, tier: evaluation.tier || group.confidence_tier || '',
      merchant_count: evaluation.merchantCount || 0, reason_codes: evaluation.reasonCodes,
      canonical_key: evaluation.canonicalKey || null
    };
    detail.push(item);
    if (opts.explain) log('group_decision', item);
  }

  summary.durationMs = Math.max(0, Math.round(opts.now() - started));
  const after = opts.write ? await safetySnapshot(db, catalog.rows.length, {
    groups: await countRows(db, 'canonical_product_groups'),
    members: await countRows(db, 'canonical_product_members'),
    promotions: await countRows(db, 'canonical_product_promotions')
  }) : null;
  const safety = {
    before, after,
    productsUnchanged: !after || before.products === after.products,
    priceHistoryUnchanged: !after || before.price_history === after.price_history
  };
  const response = {
    dryRun: !opts.write, runId: runRow.id, policyVersion: P.POLICY_VERSION,
    matcherId: SH.MATCHER_ID, matcherVersion: opts.matcherVersion,
    minRuns: opts.minRuns, summary, safety,
    decisions: opts.explain ? detail : detail.slice(0, opts.sample)
  };
  log('promotion_complete', response);
  return response;
}

async function main() {
  require('./_env.js');
  const opts = parseArgs(process.argv.slice(2));
  if (opts.write && !promotionEnabled()) {
    console.log(JSON.stringify({ event: 'disabled', hint: '실제 쓰기는 IDENTITY_PROMOTION_ENABLED=true 와 --write 가 모두 필요합니다' }));
    return;
  }
  const db = require('../api/_supabase');
  const result = await run(db, opts);
  if (result.failed) process.exitCode = 1;
}

if (require.main === module) main().catch(err => {
  console.error(JSON.stringify({ event: 'promotion_failed', error: err.message }));
  process.exitCode = 1;
});

module.exports = {
  DEFAULTS, parseArgs, promotionEnabled, matcherVersion, loadRun, loadRows,
  loadProducts, loadHistoryCounts, countRows, safetySnapshot, offerSnapshotForShadow,
  groupMembers, emptyStats, recordDecision, writeAudit, suspendCanonical,
  ensureCanonicalGroup, activateCanonical, run
};
