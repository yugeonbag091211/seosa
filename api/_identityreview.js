'use strict';

/* Product Identity Phase 4 — human review. No customer-facing consumer imports this module. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const OI = require('./_offeridentity');
const SH = require('./_identityshadow');
const P = require('./_identitypromotion');

const APPROVE_REASONS = Object.freeze([
  'APPROVE_MISSING_ATTRIBUTE_VERIFIED',
  'APPROVE_IDENTICAL_MODEL_BY_EXTERNAL_LABEL',
  'APPROVE_EXACT_CONFIGURATION'
]);
const REJECT_REASONS = Object.freeze([
  'REJECT_DIFFERENT_MODEL', 'REJECT_DIFFERENT_VARIANT', 'REJECT_DIFFERENT_STORAGE',
  'REJECT_BUNDLE_DIFFERENCE', 'REJECT_NOT_SAME_PRODUCT'
]);
const DEFER_REASONS = Object.freeze([
  'DEFER_INSUFFICIENT_EVIDENCE', 'DEFER_NEED_MODEL_NUMBER', 'DEFER_NEED_OPTION_INFO'
]);
const UNKNOWN_LABELS = Object.freeze({
  HOLD_MISSING_MODEL_NUMBER: 'manufacturer model number', HOLD_MISSING_MODEL: 'model',
  HOLD_MISSING_VARIANT: 'variant', HOLD_MISSING_STORAGE: 'storage', HOLD_MISSING_MEMORY: 'memory',
  HOLD_MISSING_COLOR: 'color', HOLD_MISSING_QUANTITY: 'quantity', HOLD_MISSING_CONDITION: 'condition',
  HOLD_MISSING_REGION: 'region', HOLD_MISSING_YEAR: 'year', HOLD_MISSING_SIZE: 'size',
  HOLD_MISSING_BUNDLE: 'bundle', HOLD_COMPONENT_EVIDENCE: 'included components',
  HOLD_INSUFFICIENT_EVIDENCE: 'identity evidence', HOLD_PRICE_GAP: 'price consistency',
  HOLD_MISSING_CPU: 'CPU', HOLD_CPU_NOT_EXACT: 'CPU model', HOLD_MISSING_GPU: 'GPU'
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => {
    if (value[key] !== undefined) out[key] = stable(value[key]);
    return out;
  }, {});
}
function stableJson(value) { return JSON.stringify(stable(value)); }
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

/* Stable across merge commits; changes when any identity decision source changes. */
function matcherVersion() {
  const files = ['_offeridentity.js', '_identitycore.js', '_search.js', '_identitypromotion.js'];
  return `identity:${sha(files.map(name => `${name}\0${fs.readFileSync(path.join(__dirname, name))}`).join('\0'))}`;
}

function rawMember(row, offer) {
  return {
    product_id: String(row.product_id), source_mall: String(row.mall), mall: offer.mall,
    mall_label: String(row.mall_label || ''), vendor_item_id: String(row.vendor_item_id || ''),
    offer_key: offer.key, title: String(row.title || ''), lprice: Number(row.lprice) || 0,
    identity_snapshot: SH.identitySnapshot(offer)
  };
}
function candidateHash(groupKey, members, policyVersion, currentMatcherVersion) {
  const shape = members.map(m => ({
    source_mall: m.source_mall, product_id: m.product_id, mall: m.mall,
    mall_label: m.mall_label, vendor_item_id: m.vendor_item_id, title: m.title,
    identity_snapshot: m.identity_snapshot
  })).sort((a, b) => `${a.source_mall}|${a.product_id}`.localeCompare(`${b.source_mall}|${b.product_id}`));
  return sha(stableJson({ groupKey, shape, policyVersion, matcherVersion: currentMatcherVersion }));
}

function merchantKeyOf(member) { return String((member && member.mall) || '').trim(); }
function merchantCountOf(members) { return new Set((members || []).map(merchantKeyOf).filter(Boolean)).size; }

function evaluationIsEligible(evaluation, members, group) {
  if (!evaluation || evaluation.decision !== P.DECISION.HOLD) return { eligible: false, reason: 'NOT_HOLD' };
  if (members.length < 2 || members.length !== Number(group.member_count)) return { eligible: false, reason: 'STALE_OR_INCOMPLETE' };
  if (merchantCountOf(members) < 2) return { eligible: false, reason: 'NOT_CROSS_MERCHANT' };
  for (const pair of evaluation.pairs || []) {
    if ((pair.result.conflicts || []).length || pair.result.decision === OI.DECISION.NO_MATCH) {
      return { eligible: false, reason: 'HARD_CONFLICT' };
    }
  }
  if (evaluation.reasonCodes.some(x => /^REJECT_/.test(x))) return { eligible: false, reason: 'HARD_CONFLICT' };
  if (evaluation.reasonCodes.some(x => ['HOLD_CURRENT_PRODUCT_MISSING', 'HOLD_MERCHANT_CHANGED', 'HOLD_VENDOR_ITEM_CHANGED', 'HOLD_MEMBER_SNAPSHOT_INCOMPLETE'].includes(x))) {
    return { eligible: false, reason: 'STALE_OR_INCOMPLETE' };
  }
  return { eligible: true, reason: '' };
}

function reviewPriority(evaluation, members) {
  const reasonSet = new Set(evaluation.reasonCodes || []);
  const unknownCount = [...reasonSet].filter(x => x.startsWith('HOLD_MISSING_') || x === 'HOLD_COMPONENT_EVIDENCE').length;
  const exactAnchor = members.length > 1 && members.every(m => m.modelNumbers && m.modelNumbers.length)
    && members.every(m => stableJson(m.modelNumbers) === stableJson(members[0].modelNumbers));
  const sameModelAnchor = members.length > 1 && members.every(m => m.primaryAnchor)
    && members.every(m => m.primaryAnchor === members[0].primaryAnchor);
  const prices = members.map(m => Number(m.price || (m._source && m._source.lprice) || 0)).filter(x => x > 0);
  const hasPriceSpread = prices.length > 1 && Math.max(...prices) > Math.min(...prices);
  if (unknownCount <= 1 && (exactAnchor || sameModelAnchor) && hasPriceSpread) return 'HIGH';
  if (unknownCount <= 3 && (sameModelAnchor || !reasonSet.has('HOLD_MISSING_MODEL'))) return 'MEDIUM';
  return 'LOW';
}

function buildQueueRow({ run, group, evaluation, members, currentMatcherVersion }) {
  const memberSnapshots = members.map(m => ({
    source_mall: m.sourceMall || m.source_mall || '', product_id: m.productId, mall: m.mall,
    mall_label: m._source.mall_label || '', vendor_item_id: m.vendorItemId || '',
    offer_key: m.key, title: m._source.title || '', identity_snapshot: SH.identitySnapshot(m),
    evidence: [...new Set((evaluation.pairs || []).flatMap(p =>
      p.a.key === m.key || p.b.key === m.key ? p.result.evidence || [] : []))]
  })).sort((a, b) => `${a.source_mall}|${a.product_id}`.localeCompare(`${b.source_mall}|${b.product_id}`));
  const hash = candidateHash(group.group_key, memberSnapshots, P.POLICY_VERSION, currentMatcherVersion);
  return {
    source_shadow_run_id: run.id, source_shadow_group_id: group.id,
    group_key: group.group_key, status: 'PENDING', priority: reviewPriority(evaluation, members),
    reason_codes: evaluation.reasonCodes || [], promotion_policy_version: P.POLICY_VERSION,
    matcher_id: SH.MATCHER_ID, matcher_version: currentMatcherVersion,
    candidate_hash: hash,
    canonical_identity_snapshot: group.canonical_identity || {},
    member_snapshot: memberSnapshots,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
}

function hardConflictReport(members, contextFactory) {
  const pairs = P.pairwise(members, contextFactory);
  const conflicts = [];
  pairs.forEach(pair => {
    (pair.result.conflicts || []).forEach(c => conflicts.push({
      a: pair.a.key, b: pair.b.key, code: P.reasonFromConflict(c), detail: c
    }));
    if (pair.result.decision === OI.DECISION.NO_MATCH) conflicts.push({
      a: pair.a.key, b: pair.b.key, code: 'REJECT_PAIR_NO_MATCH', detail: 'NO_MATCH'
    });
  });
  return { pairs, conflicts };
}

function makeApproval(members, contextFactory) {
  const checked = hardConflictReport(members, contextFactory);
  if (checked.conflicts.length) return { ok: false, error: 'HARD_CONFLICT', conflicts: checked.conflicts };
  const strong = P.commonStrongIdentifier(members);
  const tier = strong ? 'A' : (checked.pairs.length && checked.pairs.every(x => x.result.tier === 'B') ? 'B' : '');
  const identity = P.canonicalIdentity(members, strong, tier);
  const canonicalKey = P.canonicalKeyOf(identity);
  if (!canonicalKey || !tier) return { ok: false, error: 'INSUFFICIENT_CANONICAL_IDENTITY', conflicts: [] };
  if (tier === 'B') {
    const anchors = members.map(m => m.primaryAnchor || '');
    const brands = members.map(m => m.brand || '');
    const words = members.map(m => stableJson(m.words || []));
    if (!anchors[0] || !anchors.every(x => x === anchors[0]) || !brands[0] || !brands.every(x => x === brands[0]) || !words.every(x => x === words[0])) {
      return { ok: false, error: 'INSUFFICIENT_CANONICAL_IDENTITY', conflicts: [] };
    }
  }
  return { ok: true, identity, canonicalKey, tier, pairs: checked.pairs };
}

function fieldCompare(members) {
  const fields = [
    ['brand', 'brand'], ['model number', 'modelNumbers'], ['GTIN', 'gtins'], ['model', 'primaryAnchor'],
    ['variant', 'variants'], ['storage', 'storage'], ['memory', 'memory'], ['color', 'colors'],
    ['quantity', 'quantity'], ['condition', 'condition'], ['transaction type', 'transactionType'],
    ['region', 'region'], ['bundle', 'bundle'], ['accessory', 'accessory'], ['accessory type', 'accessoryType']
  ];
  return fields.map(([label, key]) => {
    const values = members.map(m => {
      let v = m[key];
      if (Array.isArray(v)) v = v.length ? v.join(', ') : null;
      if (key === 'condition' && v === 'unstated') v = null;
      if (v === '' || v === undefined) v = null;
      return v;
    });
    const present = values.filter(v => v != null);
    const state = present.length === 0 ? 'UNKNOWN' : present.length < values.length ? 'MISSING' : new Set(present.map(stableJson)).size > 1 ? 'CONFLICT' : 'SAME';
    return { key, label, state, values };
  });
}

function allowlist() {
  return new Set(String(process.env.IDENTITY_REVIEW_ADMIN_EMAILS || '').split(',')
    .map(x => x.trim().toLowerCase()).filter(Boolean));
}

function failOnError(r, label) {
  if (r && r.error) throw new Error(`${label}: ${r.error.message || r.error.code || 'database error'}`);
  return r || { data: null };
}

function displayMerchantName(offer) {
  const label = String((offer && offer._source && offer._source.mall_label) || '').trim();
  if (label) return label;
  const mall = merchantKeyOf(offer);
  const slash = mall.indexOf('/');
  return slash >= 0 ? mall.slice(slash + 1) : mall;
}

function sourceRowToOffer(row) {
  const displayMall = row.mall_label ? `${row.mall}/${row.mall_label}` : row.mall;
  const offer = OI.parseOffer({ key: `${row.mall}|${row.product_id}`, title: row.title,
    mall: displayMall, productId: row.product_id, vendorItemId: row.vendor_item_id || '' });
  offer.sourceMall = String(row.mall || '');
  offer._source = row;
  return offer;
}

async function loadQueue(db, id) {
  let q = db.from('identity_review_queue').select('*');
  if (id) q = q.eq('id', id);
  const r = failOnError(id ? await q.maybeSingle() : await q, 'review queue 읽기 실패');
  return r.data || (id ? null : []);
}

async function currentRowsForQueue(db, queueRow) {
  const snapshots = queueRow.member_snapshot || [];
  const byOfferKey = new Map();
  for (const m of snapshots) {
    const r = failOnError(await db.from('products').select('product_id,mall,mall_label,title,lprice,vendor_item_id')
      .eq('product_id', m.product_id).eq('mall', m.source_mall).eq('vendor_item_id', m.vendor_item_id || ''), '현재 상품 읽기 실패');
    const rows = r.data || [];
    if (rows.length !== 1) return { stale: true, rows: [] };
    const row = rows[0];
    if (String(row.title || '') !== String(m.title || '')
      || String(row.mall_label || '') !== String(m.mall_label || '')
      || String(row.vendor_item_id || '') !== String(m.vendor_item_id || '')) return { stale: true, rows: [] };
    const offer = sourceRowToOffer(row);
    if (stableJson(SH.identitySnapshot(offer)) !== stableJson(m.identity_snapshot)) return { stale: true, rows: [] };
    byOfferKey.set(offer.key, offer);
  }
  return { stale: false, rows: [...byOfferKey.values()] };
}

function currentMatcherIsFresh(row) { return row.matcher_version === matcherVersion(); }

function adminAuth(req, res) {
  const auth = require('./_auth').identify(req);
  if (!auth.ok) { res.status(401).json({ error: auth.reason || '인증이 필요합니다' }); return null; }
  const email = auth.email.trim().toLowerCase();
  if (!allowlist().has(email)) { res.status(403).json({ error: '관리자 권한이 없습니다' }); return null; }
  return email;
}

function badOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = (process.env.ALLOWED_ORIGINS || 'https://seosa.ai.kr,https://www.seosa.ai.kr,https://seosa-chi.vercel.app')
    .split(',').map(x => x.trim()).filter(Boolean);
  return !allowed.includes(origin);
}

async function claim(db, row, reviewer) {
  const now = new Date();
  if (row.status === 'IN_REVIEW' && row.claimed_by === reviewer) return row;
  if (row.status === 'PENDING' || row.status === 'DEFERRED') {
    const r = failOnError(await db.from('identity_review_queue').update({
      status: 'IN_REVIEW', claimed_by: reviewer, claimed_at: now.toISOString(),
      claim_expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(), updated_at: now.toISOString()
    }).eq('id', row.id).eq('status', row.status).select('*'), 'review claim 실패');
    return (r.data || [])[0] || null;
  }
  if (row.status === 'IN_REVIEW' && row.claim_expires_at && Date.parse(row.claim_expires_at) < now.getTime()) {
    const r = failOnError(await db.from('identity_review_queue').update({
      claimed_by: reviewer, claimed_at: now.toISOString(),
      claim_expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(), updated_at: now.toISOString()
    }).eq('id', row.id).eq('status', 'IN_REVIEW').eq('claimed_at', row.claimed_at).select('*'), 'expired claim takeover 실패');
    return (r.data || [])[0] || null;
  }
  return null;
}

async function route(req, res) {
  const { applyCors, noStore, readBody, tooLarge } = require('./_http');
  if (!applyCors(req, res, 'private')) return;
  noStore(res);
  const email = adminAuth(req, res);
  if (!email) return;
  const { guard } = require('./_ratelimit');
  if (!guard(req, res, { name: 'identity-review', limit: req.method === 'GET' ? 90 : 20,
    windowMs: 60_000, key: email })) return;
  if (req.method === 'POST' && tooLarge(readBody(req), 8 * 1024)) return res.status(413).json({ error: '요청이 너무 큽니다' });
  if (req.method === 'POST' && badOrigin(req)) return res.status(403).json({ error: '허용되지 않은 Origin입니다' });
  const q = req.query || {};
  const action = String(q.action || (req.method === 'POST' ? (req.body || {}).action : 'list'));
  const db = require('./_supabase');
  try {
    if (req.method === 'GET' && action === 'auth') return res.status(200).json({ ok: true, email });
    if (req.method === 'GET' && action === 'list') {
      const status = String(q.status || 'PENDING,IN_REVIEW,DEFERRED');
      const statuses = status.split(',').filter(x => ['PENDING', 'IN_REVIEW', 'DEFERRED', 'STALE'].includes(x));
      if (!statuses.length) return res.status(400).json({ error: 'status가 올바르지 않습니다' });
      const r = failOnError(await db.from('identity_review_queue').select(
        'id,source_shadow_run_id,source_shadow_group_id,group_key,status,priority,reason_codes,promotion_policy_version,matcher_id,matcher_version,created_at,updated_at,claimed_by,claim_expires_at'
      ).in('status', statuses).order('priority', { ascending: true }).order('created_at', { ascending: true }).limit(100), 'queue 목록 읽기 실패');
      const priorityRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      const items = (r.data || []).slice().sort((a, b) =>
        (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3)
        || String(a.created_at || '').localeCompare(String(b.created_at || ''))
        || Number(a.id) - Number(b.id));
      return res.status(200).json({ items });
    }
    if (req.method === 'GET' && action === 'detail') {
      const id = Number(q.id);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'id가 올바르지 않습니다' });
      const row = await loadQueue(db, id);
      if (!row) return res.status(404).json({ error: 'review item이 없습니다' });
      const current = await currentRowsForQueue(db, row);
      const offers = current.rows;
      const currentContext = OI.contextFactory(offers);
      const comparison = fieldCompare(offers);
      const conflict = hardConflictReport(offers, currentContext);
      const memberByKey = new Map((row.member_snapshot || []).map(m => [m.offer_key, m]));
      const members = offers.map(o => ({
        product_id: o.productId, source_mall: o.sourceMall, mall: o.mall, merchant_name: displayMerchantName(o),
        title: o._source.title, price: Number(o._source.lprice) || 0,
        vendor_item_id: o.vendorItemId || '', identity: SH.identitySnapshot(o),
        gtin_present: !!(o.gtins && o.gtins.length), model_number: o.modelNumbers && o.modelNumbers.length ? o.modelNumbers.join(', ') : null,
        evidence: memberByKey.get(o.key)?.evidence || []
      }));
      return res.status(200).json({ item: row, members, comparison, conflicts: conflict.conflicts,
        stale: current.stale || !currentMatcherIsFresh(row), approve_allowed: !current.stale && currentMatcherIsFresh(row)
          && !conflict.conflicts.length && !!makeApproval(offers, currentContext).ok,
        unknown_fields: (row.reason_codes || []).map(x => UNKNOWN_LABELS[x]).filter(Boolean) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const body = readBody(req);
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'id가 올바르지 않습니다' });
    const row = await loadQueue(db, id);
    if (!row) return res.status(404).json({ error: 'review item이 없습니다' });
    if (action === 'claim') {
      const claimed = await claim(db, row, email);
      if (!claimed) return res.status(409).json({ error: '이미 다른 검토자가 처리 중이거나 결정이 끝났습니다' });
      return res.status(200).json({ item: claimed });
    }
    if (!['approve', 'reject', 'defer'].includes(action)) return res.status(400).json({ error: 'action이 올바르지 않습니다' });
    if (row.status !== 'IN_REVIEW' || row.claimed_by !== email) return res.status(409).json({ error: '먼저 이 항목을 claim 해야 합니다' });
    const decision = action.toUpperCase();
    const reasonCode = String(body.reason_code || '');
    const allowed = decision === 'APPROVE' ? APPROVE_REASONS : decision === 'REJECT' ? REJECT_REASONS : DEFER_REASONS;
    if (!allowed.includes(reasonCode)) return res.status(400).json({ error: 'reason_code가 올바르지 않습니다' });
    const note = String(body.note || '').trim();
    if (note.length > 1000) return res.status(400).json({ error: 'note는 1000자 이하여야 합니다' });

    const current = await currentRowsForQueue(db, row);
    if (!currentMatcherIsFresh(row) || current.stale) {
      const stale = failOnError(await db.from('identity_review_queue').update({
        status: 'STALE', resolved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        resolution_reason_code: current.stale ? 'STALE_PRODUCT_SNAPSHOT_CHANGED' : 'STALE_MATCHER_VERSION_CHANGED'
      }).eq('id', row.id).eq('status', 'IN_REVIEW').eq('claimed_by', email).select('id'), 'stale 상태 저장 실패');
      return res.status(409).json({ error: '상품 또는 matcher가 변경되었습니다. 다시 검토해 주세요', status: stale.data?.length ? 'STALE' : 'CONFLICT' });
    }
    const offers = current.rows;
    const contextFactory = OI.contextFactory(offers);
    const hard = hardConflictReport(offers, contextFactory);
    if (decision === 'APPROVE' && hard.conflicts.length) {
      return res.status(409).json({ error: '명시적 hard conflict는 승인할 수 없습니다', code: 'HARD_CONFLICT', conflicts: hard.conflicts });
    }
    const approval = decision === 'APPROVE' ? makeApproval(offers, contextFactory) : null;
    if (decision === 'APPROVE' && !approval.ok) return res.status(409).json({
      error: approval.error === 'HARD_CONFLICT' ? '명시적 hard conflict는 승인할 수 없습니다' : '안전한 canonical identity를 구성할 근거가 부족합니다',
      code: approval.error, conflicts: approval.conflicts || []
    });
    if (decision === 'APPROVE' && reasonCode === 'APPROVE_EXACT_CONFIGURATION'
      && fieldCompare(offers).some(x => x.state !== 'SAME')) {
      return res.status(409).json({ error: '모든 구성 속성이 확인된 경우에만 exact configuration 사유를 쓸 수 있습니다', code: 'APPROVAL_REASON_NOT_SUPPORTED' });
    }
    if (decision === 'APPROVE' && reasonCode === 'APPROVE_MISSING_ATTRIBUTE_VERIFIED'
      && !fieldCompare(offers).some(x => x.state === 'MISSING' || x.state === 'UNKNOWN')) {
      return res.status(409).json({ error: '누락 속성이 없으므로 missing attribute 사유를 쓸 수 없습니다', code: 'APPROVAL_REASON_NOT_SUPPORTED' });
    }
    if (decision === 'APPROVE' && reasonCode === 'APPROVE_IDENTICAL_MODEL_BY_EXTERNAL_LABEL'
      && (note.length < 5 || !offers.every(x => x.primaryAnchor) || !offers.every(x => x.primaryAnchor === offers[0].primaryAnchor))) {
      return res.status(409).json({ error: '외부 표기와 동일 모델 근거를 note에 기록해야 합니다', code: 'APPROVAL_REASON_NOT_SUPPORTED' });
    }

    const expectedSnapshot = row.member_snapshot || [];
    const decisionResult = failOnError(await db.rpc('identity_review_resolve', {
      p_queue_id: row.id, p_reviewer: email, p_decision: decision, p_reason_code: reasonCode,
      p_note: note, p_matcher_version: matcherVersion(), p_candidate_hash: row.candidate_hash,
      p_member_snapshot: expectedSnapshot,
      p_after_snapshot: decision === 'APPROVE' ? { canonical_key: approval.canonicalKey, identity: approval.identity, tier: approval.tier } : { status: decision },
      p_canonical_key: decision === 'APPROVE' ? approval.canonicalKey : null,
      p_canonical_identity: decision === 'APPROVE' ? approval.identity : null,
      p_confidence_tier: decision === 'APPROVE' ? approval.tier : null,
      p_canonical_members: decision === 'APPROVE' ? offers.map(m => ({
        product_id: m.productId, source_mall: m.sourceMall, mall: m.mall,
        vendor_item_id: m.vendorItemId || '', offer_key: m.key,
        identity_snapshot: SH.identitySnapshot(m),
        evidence: [...new Set(approval.pairs.flatMap(p => p.a.key === m.key || p.b.key === m.key ? p.result.evidence || [] : []))]
      })) : []
    }), 'review decision 실행 실패');
    const resolved = Array.isArray(decisionResult.data) ? decisionResult.data[0] : decisionResult.data;
    if (resolved && resolved.status === 'STALE') return res.status(409).json({ error: '상품 정보가 변경되었습니다. 다시 검토해 주세요', status: 'STALE' });
    if (resolved && resolved.status === 'CONFLICT_EXISTING_CANONICAL_MEMBERSHIP') return res.status(409).json({ error: '상품이 이미 다른 canonical group에 속합니다', code: resolved.status });
    if (resolved && resolved.status === 'CONFLICT_CANONICAL_KEY_EXISTS') return res.status(409).json({ error: '동일 canonical key가 이미 존재합니다', code: resolved.status });
    if (resolved && resolved.status === 'CONFLICT') return res.status(409).json({ error: '다른 요청이 먼저 결정했습니다', status: 'CONFLICT' });
    return res.status(200).json({ ok: true, decision, result: resolved });
  } catch (e) {
    const conflict = /CONFLICT_EXISTING_CANONICAL_MEMBERSHIP|canonical_product_members_product_once_idx/.test(e.message || '');
    if (conflict) return res.status(409).json({ error: '상품이 이미 다른 canonical group에 속합니다', code: 'CONFLICT_EXISTING_CANONICAL_MEMBERSHIP' });
    if (/CONFLICT_CANONICAL_KEY_EXISTS|canonical_product_groups_canonical_key_key/.test(e.message || '')) return res.status(409).json({ error: '동일 canonical key가 이미 존재합니다', code: 'CONFLICT_CANONICAL_KEY_EXISTS' });
    if (/queue claim|already resolved|decision not allowed/i.test(e.message || '')) return res.status(409).json({ error: 'review 상태가 변경되었습니다' });
    console.error(`[identity-review] ${e.message}`);
    return res.status(500).json({ error: 'review 요청을 처리하지 못했습니다' });
  }
}

module.exports = {
  APPROVE_REASONS, REJECT_REASONS, DEFER_REASONS, matcherVersion, stableJson,
  candidateHash, merchantKeyOf, merchantCountOf, evaluationIsEligible, reviewPriority, buildQueueRow, hardConflictReport,
  makeApproval, fieldCompare, displayMerchantName, sourceRowToOffer, rawMember, allowlist,
  currentRowsForQueue, loadQueue, adminAuth, route
};
