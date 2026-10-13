#!/usr/bin/env node
'use strict';

/* Product Identity Phase 3 tests. No external service and no production DB. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const OI = require('../api/_offeridentity');
const SH = require('../api/_identityshadow');
const P = require(process.env.IDENTITY_PROMOTION_MODULE || '../api/_identitypromotion');
const W = require('./run-offer-identity-promotion');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
function ok(condition, name, detail) {
  if (!condition) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`);
  pass++;
}

function makeProducts(titles, malls) {
  return titles.map((title, i) => ({
    id: i + 1, product_id: `p${i + 1}`, mall: malls[i],
    mall_label: malls[i] === 'ADPICK' ? 'SSG' : null,
    title, vendor_item_id: `v${i + 1}`
  }));
}

function shadowFixture(products, opts) {
  const o = opts || {};
  const idByOffer = new Map(products.map(r => [`${r.mall}|${r.product_id}`, r]));
  const ids = (o.memberKeys || [...idByOffer.keys()]).map(key => {
    const row = idByOffer.get(key);
    const display = row.mall_label ? `${row.mall}/${row.mall_label}` : row.mall;
    return OI.parseOffer({ key, title: row.title, mall: display, productId: row.product_id, vendorItemId: row.vendor_item_id });
  });
  const groupId = o.groupId || 1;
  const group = {
    id: groupId, run_id: 1, group_key: o.groupKey || 'test-group-key',
    confidence_tier: o.tier || 'A', member_count: ids.length,
    merchant_count: new Set(ids.map(x => x.mall)).size, canonical_identity: {}
  };
  const members = ids.map((id, i) => ({
    id: i + 1, run_id: 1, group_id: groupId, product_id: id.productId,
    mall: id.mall, vendor_item_id: id.vendorItemId, offer_key: id.key,
    tier: o.tier || 'A', confidence: 0.999, evidence: ['same_gtin'], unknown: [], identity_snapshot: {}
  }));
  return { group, members, ids };
}

/* Small PostgREST fake used to test the runner's write path and idempotency. */
function fakeDb(opts) {
  const o = opts || {};
  const state = {
    reads: [], writes: [], failTable: o.failTable || '',
    tables: {
      products: o.products || [],
      price_history: o.priceHistory || [],
      identity_shadow_runs: o.runs || [{ id: 1, status: 'completed', matcher_id: SH.MATCHER_ID, matcher_version: 'phase2-sha', scope: { limit: 100 } }],
      identity_shadow_groups: o.groups || [],
      identity_shadow_group_members: o.members || [],
      canonical_product_groups: o.canonicalGroups || [],
      canonical_product_members: o.canonicalMembers || [],
      canonical_product_promotions: o.promotions || []
    },
    seq: { canonical_product_groups: 0, canonical_product_members: 0, canonical_product_promotions: 0 }
  };
  Object.keys(state.tables).forEach(t => {
    state.seq[t] = Math.max(0, ...state.tables[t].map(r => Number(r.id) || 0));
  });

  function from(table) {
    const q = { table, op: '', rows: [], patch: null, eq: {}, ins: [], gte: null, gt: null, limit: 0, range: null, in: null, selectOptions: {} };
    const api = {
      select(_columns, options) { if (!q.op) q.op = 'select'; q.selectOptions = options || {}; return api; },
      insert(rows) { q.op = 'insert'; q.ins = Array.isArray(rows) ? rows : [rows]; return api; },
      upsert(rows, options) { q.op = 'upsert'; q.ins = Array.isArray(rows) ? rows : [rows]; q.upsertOptions = options || {}; return api; },
      update(patch) { q.op = 'update'; q.patch = patch; return api; },
      eq(k, v) { q.eq[k] = v; return api; },
      in(k, v) { q.in = [k, v]; return api; },
      gt(k, v) { q.gt = [k, v]; return api; },
      order() { return api; },
      limit(n) { q.limit = n; return api; },
      range(a, b) { q.range = [a, b]; return api; },
      maybeSingle() { return Promise.resolve(execute(true)); },
      then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); }
    };
    function execute(single) {
      const rows = state.tables[table];
      if (!rows) return { data: null, error: { message: `relation "${table}" does not exist`, code: '42P01' } };
      if (q.op === 'insert' || q.op === 'upsert') {
        if (state.failTable === table) return { data: null, error: { code: 'XX000', message: 'injected write failure' } };
        const made = [];
        const conflictColumns = String((q.upsertOptions || {}).onConflict || '').split(',').filter(Boolean);
        for (const input of q.ins) {
          let existing = null;
          if (table === 'canonical_product_groups') existing = rows.find(r => r.canonical_key === input.canonical_key);
          else if (table === 'canonical_product_promotions') existing = rows.find(r =>
            r.shadow_run_id === input.shadow_run_id && r.evaluation_key === input.evaluation_key && r.policy_version === input.policy_version);
          else if (table === 'canonical_product_members') existing = rows.find(r =>
            r.source_mall === input.source_mall && r.product_id === input.product_id);
          if (q.op === 'insert' && existing) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          if (q.op === 'upsert' && existing) {
            if (!(q.upsertOptions || {}).ignoreDuplicates) Object.assign(existing, input);
            if (!(q.upsertOptions || {}).ignoreDuplicates) made.push(existing);
            continue;
          }
          const row = Object.assign({ id: ++state.seq[table] }, input);
          rows.push(row); made.push(row);
        }
        state.writes.push({ table, op: q.op, count: made.length });
        return { data: made, error: null };
      }

      let found = rows.filter(r => Object.keys(q.eq).every(k => r[k] === q.eq[k]));
      if (q.in) found = found.filter(r => q.in[1].includes(r[q.in[0]]));
      if (q.gt) found = found.filter(r => r[q.gt[0]] > q.gt[1]);
      if (q.range) found = found.slice(q.range[0], q.range[1] + 1);
      if (q.limit) found = found.slice(0, q.limit);
      if (q.op === 'update') {
        found.forEach(r => Object.assign(r, q.patch));
        state.writes.push({ table, op: 'update', count: found.length });
        return { data: found, error: null };
      }
      state.reads.push(table);
      if (q.selectOptions && q.selectOptions.head) return { data: null, count: rows.length, error: null };
      return { data: single ? (found[0] || null) : found, count: rows.length, error: null };
    }
    return api;
  }
  return { from, _state: state };
}

function shadowDb(products, titlesByIndexes, mallsByIndexes, opts) {
  const base = shadowFixture(products, opts);
  const keys = base.members.map(m => m.offer_key);
  const db = fakeDb(Object.assign({}, opts, {
    products,
    groups: [base.group],
    members: base.members
  }));
  return { db, group: base.group, members: base.members, keys };
}

function freshIdentity(title, key, mall, productId, vendorItemId) {
  return OI.parseOffer({ key, title, mall, productId, vendorItemId });
}

(async () => {
  /* Schema is additive, restricted, and has no consumer-facing grants. */
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', '2026-10-13-identity-promotion.sql'), 'utf8');
  const executable = sql.split('\n').filter(x => !x.trim().startsWith('--')).join('\n');
  const indexSql = fs.readFileSync(path.join(ROOT, 'supabase', '2026-10-13-identity-promotion-indexes.sql'), 'utf8');
  const noStrings = executable.replace(/'(?:[^']|'')*'/g, "''");
  ['canonical_product_groups', 'canonical_product_members', 'canonical_product_promotions'].forEach(table => {
    ok(new RegExp(`create table if not exists public\\.${table}\\b`).test(executable), `${table} uses create-if-absent`);
    ok(new RegExp(`alter table public\\.${table} enable row level security`).test(executable), `${table} enables RLS`);
    ok(new RegExp(`revoke all on table public\\.${table} from anon, authenticated`).test(executable), `${table} revokes client roles`);
  });
  ok(/canonical_product_members_product_once_idx/.test(executable) || /unique \(source_mall, product_id\)/.test(executable), 'one product offer cannot enter multiple canonical groups');
  ok(/unique \(shadow_run_id, evaluation_key, policy_version\)/.test(executable), 'promotion audit is idempotent per run and policy');
  ok(!/\b(drop|truncate)\s+table\b|\bdelete\s+from\b|\bupdate\s+products\b|\bupdate\s+price_history\b/i.test(noStrings), 'migration has no destructive or production-table writes');
  ok(!/\bproducts\b|\bprice_history\b/i.test(noStrings), 'migration does not touch products or price_history');
  ok(/create index if not exists canonical_product_groups_source_run_idx/.test(indexSql)
    && /create index if not exists canonical_product_members_source_run_idx/.test(indexSql)
    && /create index if not exists canonical_product_promotions_shadow_group_idx/.test(indexSql), 'foreign-key lookup indexes are present');
  ok(!/\b(drop|truncate)\s+table\b|\bdelete\s+from\b|\bupdate\s+products\b|\bupdate\s+price_history\b/i.test(indexSql), 'index migration is additive only');

  /* Matcher and source-run gates. */
  const tierARows = makeProducts([
    'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 신품',
    '삼성 갤럭시 버즈3 프로 SMR630 화이트 4006381333931 새상품'
  ], ['쿠팡', 'ADPICK']);
  const tierA = shadowFixture(tierARows);
  const allTierA = OI.contextFactory(tierA.ids);
  const promoteA = P.evaluateGroup({ run: { status: 'completed' }, group: tierA.group, members: tierA.ids, contextFactory: allTierA, observedRuns: 1, minRuns: 1 });
  ok(promoteA.decision === 'PROMOTE' && promoteA.tier === 'A' && promoteA.strongIdentifier.type === 'gtin', 'Tier A exact GTIN promotion');
  ok(promoteA.canonicalKey && promoteA.canonicalKey.length === 64, 'canonical key is deterministic SHA-256');
  ok(!('unknown' in promoteA.canonicalIdentity) && !Object.values(promoteA.canonicalIdentity).includes(''), 'canonical key omits unknown fields instead of serializing empty values');
  ok(P.canonicalKeyOf(promoteA.canonicalIdentity) === promoteA.canonicalKey, 'canonical key is stable');

  const tierBIds = [
    freshIdentity('Apple AirPods Pro 3 White 신품', '쿠팡|b1', '쿠팡', 'b1', 'v1'),
    freshIdentity('애플 에어팟 프로 3 White 새상품', 'ADPICK|b2', 'ADPICK/SSG', 'b2', 'v2')
  ];
  const tierBGroup = { member_count: 2, merchant_count: 2, confidence_tier: 'B' };
  const promoteB = P.evaluateGroup({ run: { status: 'completed' }, group: tierBGroup, members: tierBIds, observedRuns: 1, minRuns: 1 });
  ok(promoteB.decision === 'PROMOTE' && promoteB.tier === 'B', 'Tier B needs explicit same brand, family, and product model anchor');
  const heldB = P.evaluateGroup({ run: { status: 'completed' }, group: tierBGroup, members: tierBIds, observedRuns: 1, minRuns: 2 });
  ok(heldB.decision === 'HOLD' && heldB.reasonCodes.includes('HOLD_INSUFFICIENT_HISTORY'), 'MIN_RUNS=2 requires a repeated completed observation');
  ok(P.evaluateGroup({ run: { status: 'running' }, group: tierBGroup, members: tierBIds }).reasonCodes.includes('HOLD_SHADOW_RUN_NOT_COMPLETED'), 'incomplete shadow run is never promotable');

  /* Missing important evidence remains a hold even when Phase 1 MATCH accepts defaults. */
  const oneCode = [
    freshIdentity('Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 신품', '쿠팡|m1', '쿠팡', 'm1', ''),
    freshIdentity('Samsung Galaxy Buds3 Pro White 4006381333931 신품', 'ADPICK|m2', 'ADPICK/SSG', 'm2', '')
  ];
  const oneCodeGroup = { member_count: 2, merchant_count: 2, confidence_tier: 'A' };
  const modelHeld = P.evaluateGroup({ run: { status: 'completed' }, group: oneCodeGroup, members: oneCode, observedRuns: 1, minRuns: 1 });
  ok(modelHeld.decision === 'HOLD' && modelHeld.reasonCodes.includes('HOLD_MISSING_MODEL_NUMBER'), 'one-sided manufacturer model number blocks promotion');

  const missingStorage = [
    freshIdentity('Apple iPhone 17 Pro 256GB Black 4006381333931 신품', '쿠팡|s1', '쿠팡', 's1', ''),
    freshIdentity('Apple iPhone 17 Pro Black 4006381333931 신품', 'ADPICK|s2', 'ADPICK/SSG', 's2', '')
  ];
  const storageMatch = OI.matchOffers;
  OI.matchOffers = () => ({ decision: 'MATCH', tier: 'A', evidence: ['same_gtin'], unknown: [], conflicts: [] });
  let storageHeld;
  try { storageHeld = P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 2, merchant_count: 2 }, members: missingStorage, observedRuns: 1 }); }
  finally { OI.matchOffers = storageMatch; }
  ok(storageHeld.decision === 'HOLD' && storageHeld.reasonCodes.includes('HOLD_MISSING_STORAGE'), 'one-sided storage blocks promotion');

  /* run_id=1 real fixture contract: same merchant, Tier B, one-sided G102IC. */
  const liveRun1 = [
    freshIdentity('로지텍 G102IC 2세대 LIGHTSYNC 게이밍 유선마우스', '쿠팡|6011227725', '쿠팡', '6011227725', '70778258892'),
    freshIdentity('로지텍 2세대 LIGHTSYNC 게이밍 유선마우스', '쿠팡|9595729489', '쿠팡', '9595729489', '75960876324')
  ];
  const run1Decision = P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 2, merchant_count: 1, confidence_tier: 'B' }, members: liveRun1, observedRuns: 1 });
  ok(run1Decision.decision === 'REJECT' && run1Decision.reasonCodes.includes('REJECT_NOT_CROSS_MERCHANT'), 'real run_id=1 is rejected by cross-merchant gate');
  const run1CrossMerchant = liveRun1.map((x, i) => Object.assign({}, x, { mall: i ? 'ADPICK/SSG' : '쿠팡', key: `${i ? 'ADPICK' : '쿠팡'}|${x.productId}` }));
  const run1ModelDecision = P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 2, merchant_count: 2, confidence_tier: 'B' }, members: run1CrossMerchant, observedRuns: 1 });
  ok(run1ModelDecision.decision === 'HOLD' && run1ModelDecision.reasonCodes.includes('HOLD_MISSING_MODEL_NUMBER'), 'real run_id=1 model-number omission remains a hold even if merchants differ');
  const generationOnly = [
    Object.assign({}, run1CrossMerchant[1], { productId: 'generation-only-a', key: '쿠팡|generation-only-a', mall: '쿠팡' }),
    Object.assign({}, run1CrossMerchant[1], { productId: 'generation-only-b', key: 'ADPICK|generation-only-b', mall: 'ADPICK/SSG' })
  ];
  const generationDecision = P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 2, merchant_count: 2, confidence_tier: 'B' }, members: generationOnly, observedRuns: 1 });
  ok(run1CrossMerchant[0].flags.includes('generation_anchor') && generationDecision.reasonCodes.includes('HOLD_GENERATION_ONLY_ANCHOR'), 'generation-only anchor cannot qualify Tier B');

  const missingCondition = tierA.ids.map(x => Object.assign({}, x));
  missingCondition[1].condition = 'unstated'; missingCondition[1].conditionStates = [];
  const conditionHeld = P.evaluateGroup({ run: { status: 'completed' }, group: tierA.group, members: missingCondition, observedRuns: 1 });
  ok(conditionHeld.decision === 'HOLD' && conditionHeld.reasonCodes.includes('HOLD_MISSING_CONDITION'), 'one-sided condition blocks promotion');
  const missingVariant = tierA.ids.map(x => Object.assign({}, x));
  missingVariant.forEach(x => { x.primaryAnchor = ''; x.anchors = []; });
  missingVariant[1].variants = [];
  const variantHeld = P.evaluateGroup({ run: { status: 'completed' }, group: tierA.group, members: missingVariant, observedRuns: 1 });
  ok(variantHeld.decision === 'HOLD' && variantHeld.reasonCodes.includes('HOLD_MISSING_VARIANT'), 'one-sided variant metadata blocks promotion');
  const missingQuantity = tierA.ids.map(x => Object.assign({}, x));
  missingQuantity[0].quantity = 2; missingQuantity[1].quantity = null;
  const quantityHeld = P.evaluateGroup({ run: { status: 'completed' }, group: tierA.group, members: missingQuantity, observedRuns: 1 });
  ok(quantityHeld.decision === 'HOLD' && quantityHeld.reasonCodes.includes('HOLD_MISSING_QUANTITY'), 'one-sided quantity blocks promotion');

  /* Hard conflicts and all-pairs are rechecked during promotion. */
  const bridge = [
    freshIdentity('Apple iPhone 17 Pro 256GB Black 4006381333931 신품', '쿠팡|a', '쿠팡', 'a', ''),
    freshIdentity('Apple iPhone 17 Pro 256GB Black 4006381333931 신품', 'ADPICK|b', 'ADPICK/SSG', 'b', ''),
    freshIdentity('Apple iPhone 17 Pro 512GB Black 4006381333931 신품', '네이버|c', '네이버', 'c', '')
  ];
  const bridgeResult = P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 3, merchant_count: 3 }, members: bridge, observedRuns: 1 });
  ok(bridgeResult.decision === 'REJECT' && bridgeResult.reasonCodes.includes('REJECT_STORAGE_CONFLICT'), 'bridge poisoning rejected by all-pairs storage conflict');

  const nonTransitive = [0, 1, 2].map(i => Object.assign({}, tierA.ids[i % tierA.ids.length], {
    key: `merchant${i}|triple${i}`, mall: `merchant${i}`, productId: `triple${i}`
  }));
  const realMatch = OI.matchOffers;
  OI.matchOffers = (a, b) => {
    const pair = [a.key, b.key].sort().join('|');
    return pair === 'merchant0|triple0|merchant2|triple2'
      ? { decision: 'NO_MATCH', tier: '', evidence: [], unknown: [], conflicts: ['storage_mismatch:256gb!=512gb'] }
      : { decision: 'MATCH', tier: 'A', evidence: ['same_gtin'], unknown: [], conflicts: [] };
  };
  let allPairsResult;
  try {
    allPairsResult = P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 3, merchant_count: 3 }, members: nonTransitive, observedRuns: 1 });
  } finally { OI.matchOffers = realMatch; }
  ok(allPairsResult.decision === 'REJECT' && allPairsResult.pairs.length === 3, 'non-transitive pair attack is rejected after checking every pair');
  ok(bridgeResult.pairs.length === 3, 'all three member pairs are revalidated');

  const accessoryPair = [
    freshIdentity('Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 신품', '쿠팡|g1', '쿠팡', 'g1', ''),
    freshIdentity('Samsung Galaxy Buds3 Pro 케이스 SMR630 White 4006381333931 신품', 'ADPICK|g2', 'ADPICK/SSG', 'g2', '')
  ];
  const accessoryResult = P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 2, merchant_count: 2 }, members: accessoryPair, observedRuns: 1 });
  ok(accessoryResult.decision === 'REJECT' && accessoryResult.reasonCodes.includes('REJECT_ACCESSORY_CONFLICT'), 'accessory hard conflict rejected');

  const promotionAttacks = [
    ['AirPods Pro 3 vs case', 'Apple AirPods Pro 3 White 4006381333931 신품', 'Apple AirPods Pro 3 케이스 White 4006381333931 신품'],
    ['iPhone Pro vs Pro Max', 'Apple iPhone 17 Pro 256GB Black 4006381333931 신품', 'Apple iPhone 17 Pro Max 256GB Black 4006381333931 신품'],
    ['iPhone 256GB vs 512GB', 'Apple iPhone 17 Pro 256GB Black 4006381333931 신품', 'Apple iPhone 17 Pro 512GB Black 4006381333931 신품'],
    ['Galaxy Buds3 vs Pro', 'Samsung Galaxy Buds3 White SM-R530 4006381333931 신품', 'Samsung Galaxy Buds3 Pro White SM-R630 4006381333931 신품'],
    ['MX Master 3 vs 3S', 'Logitech MX Master 3 Graphite 4006381333931 신품', 'Logitech MX Master 3S Graphite 4006381333931 신품'],
    ['Dyson V15 vs V15 Detect', 'Dyson V15 cordless vacuum cleaner 4006381333931 신품', 'Dyson V15 Detect cordless vacuum cleaner 4006381333931 신품'],
    ['one vs two units', 'Apple AirPods Pro 3 White 1개 4006381333931 신품', 'Apple AirPods Pro 3 White 2개 4006381333931 신품'],
    ['new vs used', 'Apple AirPods Pro 3 White 4006381333931 신품', 'Apple AirPods Pro 3 White 4006381333931 중고'],
    ['purchase vs rental', 'Apple AirPods Pro 3 White 4006381333931 신품', 'Apple AirPods Pro 3 White 4006381333931 렌탈'],
    ['genuine vs compatible/OEM/replica', 'Apple AirPods Pro 3 White 4006381333931 정품', 'Apple AirPods Pro 3 호환 OEM replica White 4006381333931']
  ];
  promotionAttacks.forEach(([name, left, right]) => {
    const pair = [freshIdentity(left, '쿠팡|left', '쿠팡', 'left', ''), freshIdentity(right, 'ADPICK|right', 'ADPICK/SSG', 'right', '')];
    const attacked = P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 2, merchant_count: 2 }, members: pair, observedRuns: 1 });
    ok(attacked.decision !== 'PROMOTE', `promotion negative attack blocked: ${name}`, attacked.reasonCodes.join(','));
  });
  const existingCheck = P.evaluateExistingMembers(bridge.slice(0, 2));
  ok(existingCheck.status === 'ACTIVE', 'existing exact group is internally valid before cluster poisoning');
  const previousMatcher = OI.matchOffers;
  OI.matchOffers = () => ({ decision: 'NO_MATCH', tier: '', evidence: [], unknown: [], conflicts: [] });
  let existingNoMatch;
  try { existingNoMatch = P.evaluateExistingMembers(bridge.slice(0, 2)); }
  finally { OI.matchOffers = previousMatcher; }
  ok(existingNoMatch.status === 'HOLD' && existingNoMatch.reasonCodes.includes('HOLD_EXISTING_PAIR_NOT_MATCH'), 'existing group with an unexplained NO_MATCH is never considered active');
  ok(P.evaluateExistingMembers([bridge[0]]).status === 'HOLD', 'existing group with an incomplete member snapshot is held');
  const poisonedCheck = P.evaluateExistingMembers([...bridge.slice(0, 2), accessoryPair[1]]);
  ok(poisonedCheck.status === 'SUSPENDED', 'adding accessory evidence suspends a conflicting existing group');
  ok(bridge.length === 3 && bridge.slice(0, 2).every(x => x.productId !== 'c'), 'cluster poisoning does not mutate existing member objects');

  /* Cross-merchant-only and reason outputs. */
  ok(P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 2, merchant_count: 1 }, members: liveRun1 }).decision === 'REJECT', 'same-merchant group cannot be promoted');
  ok(W.promotionEnabled({}) === false && W.promotionEnabled({ IDENTITY_PROMOTION_ENABLED: 'false' }) === false, 'promotion is disabled unless explicitly enabled');
  ok(W.promotionEnabled({ IDENTITY_PROMOTION_ENABLED: 'true' }) === true && W.promotionEnabled({ IDENTITY_PROMOTION_ENABLED: '1' }) === true, 'explicit promotion opt-in accepted');
  const args = W.parseArgs(['--dry-run', '--run-id', '1', '--min-runs', '2', '--explain']);
  ok(args.dryRun && args.runId === 1 && args.minRuns === 2 && args.explain, 'CLI supports fixed run, dry-run, history gate, and explain');
  assert.throws(() => W.parseArgs(['--write']), /--run-id/);
  assert.throws(() => W.parseArgs(['--write', '--run-id', '1']), /--max-promotions/);
  assert.throws(() => W.parseArgs(['--write', '--dry-run', '--run-id', '1', '--max-promotions', '1']), /함께/);
  pass += 3;

  /* dry-run writes zero; a capped write is idempotent; conflict suspends but retains members. */
  const promotableProducts = makeProducts([
    'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 신품',
    '삼성 갤럭시 버즈3 프로 SMR630 화이트 4006381333931 새상품'
  ], ['쿠팡', 'ADPICK']);
  const fixture = shadowFixture(promotableProducts);
  const source = fakeDb({ products: promotableProducts, groups: [fixture.group], members: fixture.members });
  const dry = await W.run(source, { runId: 1, dryRun: true, write: false, log: () => {} });
  ok(dry.summary.promote === 1 && dry.dryRun, 'dry-run evaluates the Tier A group');
  ok(source._state.writes.length === 0, 'dry-run performs zero database writes');
  ok(dry.safety.productsUnchanged && dry.safety.priceHistoryUnchanged, 'dry-run checks production table counts');

  const writer = fakeDb({ products: promotableProducts, groups: [fixture.group], members: fixture.members });
  const writeOpts = { runId: 1, write: true, dryRun: false, maxPromotions: 1, minRuns: 1, matcherVersion: 'test-sha', log: () => {} };
  const firstWrite = await W.run(writer, writeOpts);
  const countsAfterFirst = ['canonical_product_groups', 'canonical_product_members', 'canonical_product_promotions']
    .map(t => writer._state.tables[t].length).join('/');
  const secondWrite = await W.run(writer, writeOpts);
  const countsAfterSecond = ['canonical_product_groups', 'canonical_product_members', 'canonical_product_promotions']
    .map(t => writer._state.tables[t].length).join('/');
  ok(firstWrite.summary.newCanonicalGroups === 1, 'first small write creates one canonical group');
  ok(countsAfterFirst === '1/2/1' && countsAfterSecond === '1/2/1', 'repeated write is idempotent for groups, members, and audit');
  ok(secondWrite.summary.existingCanonicalUnchanged === 1, 'second write recognizes the existing group');
  ok(firstWrite.safety.productsUnchanged && firstWrite.safety.priceHistoryUnchanged
    && secondWrite.safety.productsUnchanged && secondWrite.safety.priceHistoryUnchanged, 'products and price_history counts stay unchanged after writes');

  const auditFailureDb = fakeDb({
    products: promotableProducts, groups: [fixture.group], members: fixture.members,
    failTable: 'canonical_product_promotions'
  });
  let auditFailure = '';
  try { await W.run(auditFailureDb, writeOpts); }
  catch (error) { auditFailure = error.message; }
  ok(auditFailure.includes('promotion audit 저장 실패')
    && auditFailureDb._state.tables.canonical_product_groups[0].status === 'SUSPENDED',
  'audit failure leaves a new canonical group suspended');
  ok(auditFailureDb._state.tables.canonical_product_members.length === 2,
    'audit failure retains members for safe idempotent retry');

  const baseCanon = writer._state.tables.canonical_product_groups[0];
  const beforeMembers = writer._state.tables.canonical_product_members.length;
  const poisonedProducts = makeProducts([
    'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 신품',
    '삼성 갤럭시 버즈3 프로 SMR630 화이트 4006381333931 새상품',
    'Samsung Galaxy Buds3 Pro 케이스 SMR630 White 4006381333931 신품'
  ], ['쿠팡', 'ADPICK', '네이버']);
  const pids = shadowFixture(poisonedProducts, { memberKeys: ['쿠팡|p1', '네이버|p3'], groupKey: 'poison-candidate' });
  const poisonDb = fakeDb({
    products: poisonedProducts,
    groups: [pids.group], members: pids.members,
    canonicalGroups: [Object.assign({}, baseCanon, { status: 'ACTIVE', suspension_reason_codes: [] })],
    canonicalMembers: writer._state.tables.canonical_product_members.map(m => Object.assign({}, m, { group_id: baseCanon.id }))
  });
  const poisonResult = await W.run(poisonDb, writeOpts);
  ok(poisonDb._state.tables.canonical_product_groups[0].status === 'SUSPENDED', 'new hard-conflict evidence suspends existing canonical group');
  ok(poisonDb._state.tables.canonical_product_members.length === beforeMembers, 'cluster poison does not union the malicious offer into existing members');
  ok(poisonResult.summary.suspendedGroups === 1, 'suspension is counted');
  ok(poisonDb._state.tables.canonical_product_promotions.some(x => x.decision === 'REJECT' && x.reason_codes.includes('REJECT_EXISTING_CANONICAL_INVALID')),
    'suspension reason is retained in promotion audit');

  const missingMemberDb = fakeDb({
    products: promotableProducts.slice(0, 1), groups: [fixture.group], members: fixture.members,
    canonicalGroups: [Object.assign({}, baseCanon, { status: 'ACTIVE', suspension_reason_codes: [] })],
    canonicalMembers: writer._state.tables.canonical_product_members.map(m => Object.assign({}, m, { group_id: baseCanon.id }))
  });
  const missingMemberResult = await W.run(missingMemberDb, writeOpts);
  ok(missingMemberDb._state.tables.canonical_product_groups[0].status === 'SUSPENDED', 'missing current product suspends an existing canonical group');
  ok(missingMemberDb._state.tables.canonical_product_members.length === beforeMembers, 'missing product suspension retains every canonical member row');
  ok(missingMemberResult.summary.suspendedGroups === 1
    && missingMemberDb._state.tables.canonical_product_promotions.some(x => x.reason_codes.includes('REJECT_EXISTING_MEMBER_MISSING')),
  'missing member is visible in suspension summary and audit');

  /* Consumers remain zero: only schema, worker, tests, and report may name these tables. */
  const tableNames = ['canonical_product_groups', 'canonical_product_members', 'canonical_product_promotions'];
  const allow = new Set([
    'supabase/2026-10-13-identity-promotion.sql',
    'supabase/2026-10-13-identity-promotion-indexes.sql',
    'scripts/run-offer-identity-promotion.js',
    'scripts/test-identity-promotion.js',
    'scripts/test-identity-promotion-mutations.js',
    'api/_identityreview.js',
    'api/_canonicalconsumer.js',
    'scripts/test-canonical-consumer.js',
    'scripts/test-canonical-consumer-mutations.js',
    'scripts/run-identity-review-ingest.js',
    'scripts/test-identity-review.js',
    'scripts/test-identity-review-mutations.js',
    'supabase/2026-10-13-identity-review-phase4.sql',
    'supabase/2026-10-13-identity-review-phase4-indexes.sql',
    'scripts/verify-migrations.js',
    'reports/product-identity-phase3-promotion-2026-10-13.md'
  ]);
  function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.vercel', '.codex'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(js|ts|tsx|jsx|json|sql|yml|yaml|html|md)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const offenders = walk(ROOT, []).filter(file => {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    return !allow.has(rel) && tableNames.some(name => fs.readFileSync(file, 'utf8').includes(name));
  });
  ok(offenders.length === 0, 'canonical table access stays inside the Phase 5 resolver, approved consumers, and tests', offenders.join(', '));
  const phase5Consumers = ['api/search.js', 'api/history.js', 'api/_product-page.js', 'api/ai.js', 'api/hotdeals.js'];
  ok(phase5Consumers.every(file => fs.readFileSync(path.join(ROOT, file), 'utf8').includes("require('./_canonicalconsumer')")),
    'search, history, detail, AI, and internal hotdeals use the shared resolver');
  const mobileFiles = walk(path.join(ROOT, 'apps', 'mobile'), []).filter(file => /\.(js|ts|tsx|jsx)$/.test(file));
  ok(mobileFiles.every(file => !tableNames.some(name => fs.readFileSync(file, 'utf8').includes(name))),
    'mobile remains backward-compatible and does not read canonical tables');

  console.log(`Phase 3 promotion: ${pass} PASS / 0 FAIL`);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
