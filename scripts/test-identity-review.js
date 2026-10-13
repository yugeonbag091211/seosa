#!/usr/bin/env node
'use strict';

/* Phase 4 identity review tests: pure matcher gates, mocked API/worker, and migration contract. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OI = require('../api/_offeridentity');
const SH = require('../api/_identityshadow');
const P = require('../api/_identitypromotion');
const R = require(process.env.IDENTITY_REVIEW_MODULE || '../api/_identityreview');
const Worker = require(process.env.IDENTITY_REVIEW_WORKER || './run-identity-review-ingest');
const SQL_PATH = process.env.IDENTITY_REVIEW_SQL || path.join(ROOT, 'supabase', '2026-10-13-identity-review-phase4.sql');
const sql = fs.readFileSync(SQL_PATH, 'utf8');
const indexSql = fs.readFileSync(path.join(ROOT, 'supabase', '2026-10-13-identity-review-phase4-indexes.sql'), 'utf8');
let pass = 0;
function ok(value, name) { assert.ok(value, name); pass++; }
function same(a, b, name) { assert.deepStrictEqual(a, b, name); pass++; }

class FakeDb {
  constructor(tables, rpcResult) {
    this.tables = tables || {};
    this.rpcResult = rpcResult;
    this.rpcCalls = [];
    this.writes = [];
    this.seq = {};
    for (const [name, rows] of Object.entries(this.tables)) this.seq[name] = Math.max(0, ...rows.map(x => Number(x.id) || 0));
  }
  from(table) {
    const q = { table, op: '', eq: {}, in: [], gt: null, lt: null, limit: 0, range: null, opts: {} };
    const api = {
      select(_cols, opts) { if (!q.op) q.op = 'select'; q.opts = opts || {}; return api; },
      insert(rows) { q.op = 'insert'; q.rows = Array.isArray(rows) ? rows : [rows]; return api; },
      upsert(rows, opts) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; q.upsert = opts || {}; return api; },
      update(patch) { q.op = 'update'; q.patch = patch; return api; },
      eq(k, v) { q.eq[k] = v; return api; },
      in(k, v) { q.in.push([k, v]); return api; },
      gt(k, v) { q.gt = [k, v]; return api; },
      lt(k, v) { q.lt = [k, v]; return api; },
      order() { return api; },
      limit(n) { q.limit = n; return api; },
      range(a, b) { q.range = [a, b]; return api; },
      maybeSingle() { return Promise.resolve(execute(true)); },
      then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); }
    };
    const execute = single => {
      const rows = this.tables[table];
      if (!rows) return { data: null, error: { code: '42P01', message: `relation ${table} does not exist` } };
      if (q.op === 'insert' || q.op === 'upsert') {
        const made = [];
        for (const input of q.rows) {
          const conflict = table === 'identity_review_queue' && rows.find(x => x.group_key === input.group_key
            && x.promotion_policy_version === input.promotion_policy_version && x.matcher_version === input.matcher_version
            && x.candidate_hash === input.candidate_hash);
          if (conflict && q.op === 'upsert' && q.upsert.ignoreDuplicates) continue;
          const row = Object.assign({ id: ++this.seq[table] }, input); rows.push(row); made.push(row);
        }
        this.writes.push({ table, op: q.op, count: made.length });
        return { data: made, error: null };
      }
      let found = rows.filter(row => Object.keys(q.eq).every(k => row[k] === q.eq[k]));
      q.in.forEach(([k, values]) => { found = found.filter(row => values.includes(row[k])); });
      if (q.gt) found = found.filter(row => row[q.gt[0]] > q.gt[1]);
      if (q.lt) found = found.filter(row => row[q.lt[0]] < q.lt[1]);
      if (q.op === 'update') {
        found.forEach(row => Object.assign(row, q.patch));
        this.writes.push({ table, op: 'update', count: found.length });
        return { data: single ? found[0] || null : found, error: null };
      }
      if (q.range) found = found.slice(q.range[0], q.range[1] + 1);
      if (q.limit) found = found.slice(0, q.limit);
      if (q.opts.head) return { data: null, count: rows.length, error: null };
      return { data: single ? found[0] || null : found, count: rows.length, error: null };
    };
    return api;
  }
  async rpc(name, args) { this.rpcCalls.push({ name, args }); return { data: this.rpcResult || { status: args.p_decision }, error: null }; }
}

function product(id, mall, title, price, mallLabel) {
  return { id, product_id: `p${id}`, mall, mall_label: mall === 'ADPICK' ? (mallLabel || 'SSG') : '', title,
    lprice: price || 100000, vendor_item_id: `v${id}` };
}
function offers(rows) { return rows.map(R.sourceRowToOffer); }
function groupFixture(rows, groupId, groupKey) {
  const ids = offers(rows);
  return {
    group: { id: groupId, run_id: 1, group_key: groupKey || SH.groupKeyOf(ids.map(x => x.key)),
      confidence_tier: 'A', member_count: ids.length, merchant_count: new Set(ids.map(x => x.mall)).size,
      canonical_identity: {}, lowest_price: Math.min(...rows.map(x => x.lprice)), lowest_mall: rows[0].mall },
    members: ids.map((id, i) => ({ id: groupId * 10 + i, run_id: 1, group_id: groupId,
      product_id: id.productId, mall: id.mall, vendor_item_id: id.vendorItemId || '', offer_key: id.key,
      tier: 'A', confidence: 0.99, evidence: ['same_model'], unknown: [], identity_snapshot: SH.identitySnapshot(id) }))
  };
}
function reviewRow(rows, status) {
  const ms = offers(rows);
  const snapshots = ms.map(m => ({ source_mall: m.sourceMall, product_id: m.productId, mall: m.mall,
    mall_label: m._source.mall_label || '', vendor_item_id: m.vendorItemId || '', offer_key: m.key,
    title: m._source.title, identity_snapshot: SH.identitySnapshot(m), evidence: ['test'] }));
  const groupKey = SH.groupKeyOf(ms.map(x => x.key));
  return { id: 7, source_shadow_run_id: 1, source_shadow_group_id: 1, group_key: groupKey,
    status: status || 'IN_REVIEW', priority: 'HIGH', reason_codes: ['HOLD_MISSING_MODEL_NUMBER'],
    promotion_policy_version: P.POLICY_VERSION, matcher_id: SH.MATCHER_ID, matcher_version: R.matcherVersion(),
    candidate_hash: R.candidateHash(groupKey, snapshots, P.POLICY_VERSION, R.matcherVersion()),
    canonical_identity_snapshot: {}, member_snapshot: snapshots,
    claimed_by: 'admin@example.com', claimed_at: new Date().toISOString(),
    claim_expires_at: new Date(Date.now() + 600000).toISOString() };
}
function response() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; return this; },
    status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
}
async function apiCall(db, req) {
  const file = require.resolve('../api/_supabase');
  const previous = require.cache[file];
  require.cache[file] = { id: file, filename: file, loaded: true, exports: db };
  try { const res = response(); await R.route(req, res); return res; }
  finally { if (previous) require.cache[file] = previous; else delete require.cache[file]; }
}
function authReq(email, method, query, body) {
  const Auth = require('../api/_auth');
  return { method: method || 'GET', headers: { authorization: `Bearer ${Auth.issueToken(email)}`, origin: 'https://seosa.ai.kr' },
    query: query || {}, body: body || {} };
}

async function main() {
  process.env.AUTH_SECRET = 'identity-review-test-signing-key';
  process.env.IDENTITY_REVIEW_ADMIN_EMAILS = 'admin@example.com';

  /* Migration is additive, private, atomic, versioned, and immutable. */
  const sqlExec = sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
  ok(/alter table public\.canonical_product_groups\s+add column if not exists approval_source/.test(sql), 'human approval source is additive');
  for (const table of ['identity_review_queue', 'identity_review_decisions']) {
    ok(new RegExp(`create table if not exists public\\.${table}\\b`).test(sql), `${table} uses create-if-absent`);
    ok(new RegExp(`alter table public\\.${table} enable row level security`).test(sql), `${table} enables RLS`);
    ok(new RegExp(`revoke all on table public\\.${table} from anon, authenticated`).test(sql), `${table} denies client roles`);
  }
  ok(/unique \(group_key, promotion_policy_version, matcher_version, candidate_hash\)/.test(sql), 'ingest is idempotent and evidence-versioned');
  ok(/identity_review_queue_source_group_idx/.test(indexSql), 'source-group foreign key has a covering index');
  ok(/before update or delete on public\.identity_review_decisions/.test(sql), 'decision audit forbids mutation');
  ok(/for update;/.test(sql) && /v_queue\.status <> 'IN_REVIEW'/.test(sql), 'resolution locks queue and compare-and-sets its state');
  ok(/for share\s+loop/.test(sql), 'resolution locks current products against identity changes');
  ok(/CONFLICT_EXISTING_CANONICAL_MEMBERSHIP/.test(sql) && /CONFLICT_CANONICAL_KEY_EXISTS/.test(sql), 'canonical membership and key collisions are blocked in SQL');
  ok(/approval_source/.test(sql) && /'HUMAN_REVIEW'/.test(sql), 'human approval source is recorded on canonical group');
  ok(/security invoker\s+set search_path = ''/i.test(sql), 'RPC runs as invoker with empty search path');
  ok(!/\b(drop|truncate)\s+table\b|\bdelete\s+from\b|\bupdate\s+products\b|\b(insert|update|delete)\s+into?\s+public\.price_history\b/i.test(sqlExec), 'migration contains no destructive or catalog/history writes');

  /* Eligibility and review decision boundaries use Phase 1/3 logic. */
  const missingMpn = [
    product(1, 'COUPANG', 'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 new', 119000),
    product(2, 'ADPICK', 'Samsung Galaxy Buds3 Pro White 4006381333931 new', 128000)
  ];
  const hold = groupFixture(missingMpn, 1);
  const currentOffers = offers(missingMpn), context = OI.contextFactory(currentOffers);
  const evaluation = P.evaluateGroup({ run: { status: 'completed' }, group: hold.group, members: currentOffers,
    contextFactory: context, observedRuns: 1, minRuns: 1 });
  ok(evaluation.decision === 'HOLD', 'fixture is a Phase 3 HOLD');
  ok(R.evaluationIsEligible(evaluation, currentOffers, hold.group).eligible, 'cross-merchant conflict-free HOLD is review eligible');
  const sameMerchant = currentOffers.map(x => Object.assign({}, x, { sourceMall: 'COUPANG', mall: 'COUPANG' }));
  ok(!R.evaluationIsEligible(evaluation, sameMerchant, hold.group).eligible, 'same-merchant group is excluded');
  ok(!R.evaluationIsEligible(Object.assign({}, evaluation, { decision: 'PROMOTE' }), currentOffers, hold.group).eligible, 'PROMOTE is never ingested');
  ok(!R.evaluationIsEligible(Object.assign({}, evaluation, { decision: 'REJECT' }), currentOffers, hold.group).eligible, 'REJECT is never ingested');

  /* Merchant identity contract: ADPICK is the source; mall_label is the displayed merchant. */
  const adpickDifferentRows = [
    product(101, 'ADPICK', 'Samsung Galaxy Buds3 Pro SM-R630 White new', 120000, 'Hmall'),
    product(102, 'ADPICK', 'Samsung Galaxy Buds3 Pro White new', 121000, '롯데홈쇼핑')
  ];
  const adpickDifferent = offers(adpickDifferentRows);
  same(R.merchantCountOf(adpickDifferent), 2, 'ADPICK Hmall vs 롯데홈쇼핑 are two displayed merchants');
  const adpickHoldGroup = groupFixture(adpickDifferentRows, 101);
  const adpickEvaluation = P.evaluateGroup({ run: { status: 'completed' }, group: adpickHoldGroup.group, members: adpickDifferent,
    contextFactory: OI.contextFactory(adpickDifferent), observedRuns: 1, minRuns: 1 });
  ok(adpickEvaluation.merchantCount === 2 && adpickEvaluation.decision === 'HOLD', 'Phase 3 uses displayed merchant identity for ADPICK submalls');
  ok(R.evaluationIsEligible(adpickEvaluation, adpickDifferent, adpickHoldGroup.group).eligible, 'Phase 4 uses the same displayed merchant identity as Phase 3');
  same(adpickDifferent.map(R.displayMerchantName), ['Hmall', '롯데홈쇼핑'], 'admin display shows merchant labels without ADPICK prefix');

  const adpickSameRows = [
    product(103, 'ADPICK', 'Samsung Galaxy Buds3 Pro SM-R630 White new', 120000, 'Hmall'),
    product(104, 'ADPICK', 'Samsung Galaxy Buds3 Pro White new', 121000, 'Hmall')
  ];
  const adpickSame = offers(adpickSameRows);
  same(R.merchantCountOf(adpickSame), 1, 'ADPICK Hmall vs Hmall is one displayed merchant');
  const coupangVsAdpick = offers([
    product(105, 'COUPANG', 'Samsung Galaxy Buds3 Pro SM-R630 White new', 120000),
    product(106, 'ADPICK', 'Samsung Galaxy Buds3 Pro White new', 121000, 'Hmall')
  ]);
  same(R.merchantCountOf(coupangVsAdpick), 2, 'Coupang vs ADPICK Hmall is cross-merchant');
  const newCondition = offers([
    product(15, 'COUPANG', 'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 new'),
    product(16, 'ADPICK', 'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 used')
  ]);
  ok(newCondition[0].condition === 'new' && newCondition[1].condition === 'used'
    && R.hardConflictReport(newCondition, OI.contextFactory(newCondition)).conflicts.length > 0,
  'explicit English new versus used is a hard conflict');
  const newBalance = OI.parseOffer({ title: 'New Balance 574 sneakers', mall: 'COUPANG' });
  same(newBalance.condition, 'unstated', 'New Balance brand name is not parsed as a new product condition');
  const promotedRows = [
    product(3, 'COUPANG', 'Apple iPhone 17 Pro 256GB Black 0195949000001 new', 1400000),
    product(4, 'ADPICK', 'Apple iPhone 17 Pro 256GB Black 0195949000001 new', 1450000)
  ];
  const promoted = offers(promotedRows);
  const promotedEvaluation = P.evaluateGroup({ run: { status: 'completed' }, group: { member_count: 2, merchant_count: 2 }, members: promoted, observedRuns: 1 });
  ok(promotedEvaluation.decision === 'PROMOTE' && !R.evaluationIsEligible(promotedEvaluation, promoted, { member_count: 2 }).eligible, 'Phase 3 PROMOTE remains outside review queue');

  if (process.env.IDENTITY_REVIEW_FOCUS !== 'api-hard-conflict') {
    const storageConflict = offers([
      product(5, 'COUPANG', 'Apple iPhone 17 Pro 256GB Black 4006381333931 new'),
      product(6, 'ADPICK', 'Apple iPhone 17 Pro 512GB Black 4006381333931 new')
    ]);
    const storageApproval = R.makeApproval(storageConflict, OI.contextFactory(storageConflict));
    ok(!storageApproval.ok && storageApproval.error === 'HARD_CONFLICT', '256GB versus 512GB cannot be approved');
    const accessoryConflict = offers([
      product(7, 'COUPANG', 'Apple AirPods Pro 3 0195949000002 new'),
      product(8, 'ADPICK', 'Apple AirPods Pro 3 Case 0195949000002 new')
    ]);
    ok(!R.makeApproval(accessoryConflict, OI.contextFactory(accessoryConflict)).ok, 'main product versus case cannot be approved');
    const modelConflict = offers([
      product(9, 'COUPANG', 'Logitech MX Master 3 0978550000001 new'),
      product(10, 'ADPICK', 'Logitech MX Master 3S 0978550000001 new')
    ]);
    ok(!R.makeApproval(modelConflict, OI.contextFactory(modelConflict)).ok, 'MX Master 3 versus 3S cannot be approved');
    const conditionConflict = offers([
      product(11, 'COUPANG', 'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 new'),
      product(12, 'ADPICK', 'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 used')
    ]);
    ok(!R.makeApproval(conditionConflict, OI.contextFactory(conditionConflict)).ok, 'new versus used cannot be approved');
  }

  /* Full worker path: HOLD-only, dry-run zero writes, idempotency, versioned review and rejection suppression. */
  const fullRows = [
    ...missingMpn,
    ...promotedRows,
    product(13, 'COUPANG', 'Apple iPhone 17 Pro 256GB Black 0195949000001 new'),
    product(14, 'ADPICK', 'Apple iPhone 17 Pro 512GB Black 0195949000001 new')
  ];
  const fixtures = [groupFixture(missingMpn, 1), groupFixture(promotedRows, 2), groupFixture(fullRows.slice(4, 6), 3)];
  const fake = new FakeDb({
    products: fullRows,
    price_history: [],
    identity_shadow_runs: [{ id: 1, status: 'completed', matcher_id: SH.MATCHER_ID, matcher_version: 'shadow-fixture' }],
    identity_shadow_groups: fixtures.map(x => x.group),
    identity_shadow_group_members: fixtures.flatMap(x => x.members),
    canonical_product_groups: [], canonical_product_members: [], canonical_product_promotions: [],
    identity_review_queue: [], identity_review_decisions: []
  });
  const dry = await Worker.run(fake, { runId: 1, dryRun: true, write: false, matcherVersion: 'matcher-fixture' });
  same(fake.writes.length, 0, 'dry-run performs no writes');
  same(dry.stats.queueCandidates, 1, `only one HOLD becomes a queue candidate: ${JSON.stringify(dry.stats)}`);
  same(dry.stats.promoteNotIngested, 1, 'PROMOTE is counted but not queued');
  same(dry.stats.rejectNotIngested, 1, 'hard-conflict REJECT is counted but not queued');
  ok(fake.tables.identity_review_queue.length === 0, 'dry-run does not persist candidate payload');
  ok(dry.safety.productsUnchanged && dry.safety.priceHistoryUnchanged && dry.safety.canonicalUnchanged, 'dry-run proves catalog and canonical safety');
  const write = await Worker.run(fake, { runId: 1, limit: 10, write: true, env: { IDENTITY_REVIEW_ENABLED: 'true' }, matcherVersion: 'matcher-fixture' });
  same(write.stats.written, 1, 'small opt-in ingest writes the eligible HOLD');
  same(fake.tables.identity_review_queue.length, 1, 'exactly one queue row is created');
  ok(fake.tables.identity_review_queue[0].member_snapshot.every(m => m.source_mall
    && m.source_mall === m.offer_key.split('|')[0]), 'queue snapshot preserves source_mall for fresh detail and decision lookup');
  ok(write.safety.productsUnchanged && write.safety.priceHistoryUnchanged && write.safety.canonicalUnchanged, 'queue ingest changes neither products, price history, nor canonical data');
  const duplicate = await Worker.run(fake, { runId: 1, limit: 10, write: true, env: { IDENTITY_REVIEW_ENABLED: 'true' }, matcherVersion: 'matcher-fixture' });
  same(fake.tables.identity_review_queue.length, 1, 'duplicate ingest does not create a second queue row');
  same(duplicate.stats.alreadyQueued, 1, 'duplicate is classified as already queued');
  const versioned = await Worker.run(fake, { runId: 1, dryRun: true, matcherVersion: 'matcher-fixture-v2' });
  same(versioned.stats.queueCandidates, 1, 'a changed matcher version produces a distinct review candidate');
  fake.tables.identity_review_queue[0].status = 'REJECTED';
  const suppressed = await Worker.run(fake, { runId: 1, dryRun: true, matcherVersion: 'matcher-fixture' });
  same(suppressed.stats.alreadyDecided, 1, 'same matcher/policy/evidence rejection is suppressed');
  same((await Worker.run(fake, { runId: 1, dryRun: true, matcherVersion: 'matcher-fixture-v2' })).stats.queueCandidates, 1, 'new matcher version permits re-review');
  ok(!Worker.enabled({ IDENTITY_REVIEW_ENABLED: 'false' }), 'worker defaults to disabled');
  assert.throws(() => Worker.parseArgs(['--write', '--run-id', '1']), /--limit/); pass++;
  assert.throws(() => Worker.parseArgs(['--write', '--run-id', '1', '--limit', '10', '--dry-run']), /dry-run/); pass++;

  /* API auth, claim, server-side conflict blocking, TOCTOU and immutable decisions. */
  const noAuthDb = new FakeDb({ identity_review_queue: [], products: [] });
  const anonymous = await apiCall(noAuthDb, { method: 'GET', headers: {}, query: { action: 'auth' } });
  same(anonymous.statusCode, 401, 'anonymous API access is denied');
  const nonAdmin = await apiCall(noAuthDb, authReq('user@example.com', 'GET', { action: 'auth' }));
  same(nonAdmin.statusCode, 403, 'authenticated non-admin access is denied');
  const authorized = await apiCall(noAuthDb, authReq('admin@example.com', 'GET', { action: 'auth' }));
  same(authorized.statusCode, 200, 'allowlisted admin can authenticate');

  const displayDb = new FakeDb({ identity_review_queue: [reviewRow(missingMpn, 'PENDING')], products: missingMpn });
  const listResult = await apiCall(displayDb, authReq('admin@example.com', 'GET', { action: 'list' }));
  same(listResult.statusCode, 200, 'admin can read queue list');
  const priorityRows = ['LOW', 'MEDIUM', 'HIGH'].map((priority, index) =>
    Object.assign(reviewRow(missingMpn, 'PENDING'), { id: index + 1, priority, created_at: `2026-10-13T00:00:0${index}Z` }));
  const priorityList = await apiCall(new FakeDb({ identity_review_queue: priorityRows }), authReq('admin@example.com', 'GET', { action: 'list' }));
  same(priorityList.body.items.map(x => x.priority), ['HIGH', 'MEDIUM', 'LOW'], 'queue list uses human priority order');
  const detailResult = await apiCall(displayDb, authReq('admin@example.com', 'GET', { action: 'detail', id: '7' }));
  same(detailResult.statusCode, 200, 'admin can read fresh member comparison');
  same(detailResult.body.members.length, 2, 'review detail shows every seller member');
  ok(detailResult.body.comparison.some(x => x.state === 'MISSING'), 'review detail marks missing identity attributes');

  const claimRow = reviewRow(missingMpn, 'PENDING');
  const claimDb = new FakeDb({ identity_review_queue: [claimRow], products: missingMpn });
  const claimed = await apiCall(claimDb, authReq('admin@example.com', 'POST', { action: 'claim' }, { id: 7 }));
  same(claimed.statusCode, 200, 'admin can claim pending review');
  same(claimDb.tables.identity_review_queue[0].status, 'IN_REVIEW', 'claim uses IN_REVIEW compare-and-set');

  const hardRows = [
    product(21, 'COUPANG', 'Apple iPhone 17 Pro 256GB Black 4006381333931 new'),
    product(22, 'ADPICK', 'Apple iPhone 17 Pro 512GB Black 4006381333931 new')
  ];
  const conflictDb = new FakeDb({ identity_review_queue: [reviewRow(hardRows)], products: hardRows });
  const conflict = await apiCall(conflictDb, authReq('admin@example.com', 'POST', { action: 'approve' }, { id: 7, reason_code: 'APPROVE_MISSING_ATTRIBUTE_VERIFIED' }));
  same(conflict.statusCode, 409, 'direct API APPROVE is blocked for explicit storage conflict');
  same(conflict.body.code, 'HARD_CONFLICT', 'hard-conflict block is server-side and explicit');
  same(conflictDb.rpcCalls.length, 0, 'hard conflict never reaches canonical resolution RPC');

  const hardApiFixtures = [
    ['accessory', [product(23, 'COUPANG', 'Apple AirPods Pro 3 0195949000002 new'), product(24, 'ADPICK', 'Apple AirPods Pro 3 Case 0195949000002 new')]],
    ['model', [product(25, 'COUPANG', 'Logitech MX Master 3 0978550000001 new'), product(26, 'ADPICK', 'Logitech MX Master 3S 0978550000001 new')]],
    ['condition', [product(27, 'COUPANG', 'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 new'), product(28, 'ADPICK', 'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 used')]]
  ];
  for (const [name, rows] of hardApiFixtures) {
    const fixtureDb = new FakeDb({ identity_review_queue: [reviewRow(rows)], products: rows });
    const response = await apiCall(fixtureDb, authReq('admin@example.com', 'POST', { action: 'approve' }, {
      id: 7, reason_code: 'APPROVE_MISSING_ATTRIBUTE_VERIFIED', note: `test ${name} conflict`
    }));
    same(response.statusCode, 409, `direct API APPROVE blocks ${name} hard conflict`);
    same(fixtureDb.rpcCalls.length, 0, `${name} conflict never reaches canonical resolution RPC`);
  }

  const staleRows = [missingMpn[0], Object.assign({}, missingMpn[1], { title: 'Samsung Galaxy Buds3 Pro SM-R630 White 4006381333931 new used' })];
  const staleDb = new FakeDb({ identity_review_queue: [reviewRow(missingMpn)], products: staleRows });
  const stale = await apiCall(staleDb, authReq('admin@example.com', 'POST', { action: 'approve' }, { id: 7, reason_code: 'APPROVE_MISSING_ATTRIBUTE_VERIFIED' }));
  same(stale.statusCode, 409, 'TOCTOU identity change blocks approval');
  same(stale.body.status, 'STALE', 'TOCTOU change marks queue STALE');
  same(staleDb.rpcCalls.length, 0, 'stale review never enters resolution RPC');

  const safeDb = new FakeDb({ identity_review_queue: [reviewRow(missingMpn)], products: missingMpn }, { status: 'REJECTED' });
  const rejected = await apiCall(safeDb, authReq('admin@example.com', 'POST', { action: 'reject' }, { id: 7, reason_code: 'REJECT_NOT_SAME_PRODUCT', note: 'test fixture rejection' }));
  same(rejected.statusCode, 200, 'admin REJECT is accepted with a structured reason');
  same(safeDb.rpcCalls[0].args.p_decision, 'REJECT', 'REJECT decision is audited through atomic RPC');
  same(safeDb.rpcCalls[0].args.p_reason_code, 'REJECT_NOT_SAME_PRODUCT', 'structured reason reaches audit');
  const deferDb = new FakeDb({ identity_review_queue: [reviewRow(missingMpn)], products: missingMpn }, { status: 'DEFERRED' });
  const deferred = await apiCall(deferDb, authReq('admin@example.com', 'POST', { action: 'defer' }, { id: 7, reason_code: 'DEFER_NEED_MODEL_NUMBER' }));
  same(deferred.statusCode, 200, 'admin DEFER is accepted');
  same(deferDb.rpcCalls[0].args.p_decision, 'DEFER', 'DEFER is distinct from permanent rejection');
  const deferredRowDb = new FakeDb({ identity_review_queue: [reviewRow(missingMpn, 'DEFERRED')], products: missingMpn });
  const deferredClaim = await apiCall(deferredRowDb, authReq('admin@example.com', 'POST', { action: 'claim' }, { id: 7 }));
  same(deferredClaim.statusCode, 200, 'DEFERRED item can be reopened for later review');
  same(deferredRowDb.tables.identity_review_queue[0].status, 'IN_REVIEW', 'reopened defer retains queue history and claim state');
  const approvedDb = new FakeDb({ identity_review_queue: [reviewRow(missingMpn)], products: missingMpn }, { status: 'APPROVED', canonical_group_id: 99 });
  const approved = await apiCall(approvedDb, authReq('admin@example.com', 'POST', { action: 'approve' }, {
    id: 7, reason_code: 'APPROVE_MISSING_ATTRIBUTE_VERIFIED', note: 'seller spec sheet confirmed same configuration'
  }));
  same(approved.statusCode, 200, 'admin can approve an ambiguity that has a safe canonical identity');
  same(approvedDb.rpcCalls[0].args.p_canonical_members.length, 2, 'APPROVE sends all validated members to atomic canonical writer');
  same(approvedDb.rpcCalls[0].args.p_canonical_identity.strongIdentifier.type, 'gtin', 'approval retains strong-identifier identity');
  const collisionDb = new FakeDb({ identity_review_queue: [reviewRow(missingMpn)], products: missingMpn }, { status: 'CONFLICT_EXISTING_CANONICAL_MEMBERSHIP' });
  const collision = await apiCall(collisionDb, authReq('admin@example.com', 'POST', { action: 'approve' }, { id: 7, reason_code: 'APPROVE_MISSING_ATTRIBUTE_VERIFIED' }));
  same(collision.statusCode, 409, 'existing canonical membership collision is returned as conflict');
  same(collision.body.code, 'CONFLICT_EXISTING_CANONICAL_MEMBERSHIP', 'membership conflict does not move canonical members');

  /* UI and routing are isolated from customer consumers. */
  const history = fs.readFileSync(path.join(ROOT, 'api', 'history.js'), 'utf8');
  ok(history.indexOf("q.__route === 'identity-review'") < history.indexOf("applyCors(req, res, 'public')"), 'private route is dispatched before public wildcard CORS');
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  ok(vercel.rewrites.some(x => x.source === '/api/identity-review' && x.destination.includes('__route=identity-review')), 'review API reuses existing Vercel function');
  ok(vercel.rewrites.some(x => x.source === '/admin/identity-review'), 'admin route is separate from customer UI');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'identity-review.html'), 'utf8');
  ok(/noindex,nofollow/.test(html) && /localStorage\.getItem\('seosa_token'\)/.test(html), 'admin shell has noindex and uses existing signed login token');
  ok(/approve_allowed/.test(html) && /btn\.disabled=true/.test(html), 'review UI disables unsafe approval');
  ok(/merchant_name \|\| m\.mall/.test(html), 'admin UI prefers clean displayed merchant names');
  const consumerFiles = ['api/ai.js','api/search.js','api/_product-page.js','api/_radarapi.js','api/hotdeals.js','api/init.js','api/cron.js','api/rec.js','public/index.html'];
  for (const file of consumerFiles) if (fs.existsSync(path.join(ROOT, file))) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    ok(!/identity_review_queue|identity_review_decisions|canonical_product_groups|canonical_product_members/.test(source), `${file} stays Phase 5 consumer-zero`);
  }
  ok(!/identity_review_queue|identity_review_decisions/.test(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')), 'no scheduler or customer rewrite reads the review tables');
  console.log(`Identity review: ${pass} assertions passed`);
}

main().catch(err => { console.error(err.stack || err.message); process.exitCode = 1; });
