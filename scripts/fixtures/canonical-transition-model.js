'use strict';
/*
 * 테스트 전용 — supabase/2026-10-14-identity-matcher-transition.sql 의 STAGE / FINALIZE / ABORT / REVERT 가
 * 그룹·구성원 행을 «어떻게 바꾸는가» 를 그대로 옮긴 모델. 실제 DB 가 없는 CI 에서 소비자가 전환의 각 단계마다
 * 그룹을 끊김 없이(또는 fail-closed 로) 읽는지 확인하는 데만 쓴다.
 *
 * ★ SQL 이 바뀌면 이것도 바꾼다. scripts/test-canonical-transition.js 의 정적 검사가 SQL 쪽 대입 목록을 고정한다.
 */

const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

function stage(tables, params) {
  const group = tables.canonical_product_groups.find(g => String(g.id) === String(params.p_group_id));
  if (!group || group.status !== 'ACTIVE' || group.canonical_key !== params.p_expected_canonical_key) return { status: 'CONFLICT_GROUP_CHANGED' };
  if (group.next_canonical_key) {
    return group.next_canonical_key === params.p_next_canonical_key && group.next_plan_hash === params.p_plan_hash
      ? { status: 'ALREADY_STAGED' } : { status: 'CONFLICT_ALREADY_STAGED' };
  }
  const members = tables.canonical_product_members.filter(m => String(m.group_id) === String(group.id));
  if (members.length < 2 || members.length !== params.p_members.length) return { status: 'CONFLICT_MEMBER_SET_CHANGED' };
  for (const pm of params.p_members) {
    const row = members.find(m => m.offer_key === pm.offer_key);
    if (!row || row.source_mall !== pm.source_mall || row.product_id !== pm.product_id
      || String(row.vendor_item_id || '') !== String(pm.vendor_item_id || '')
      || JSON.stringify(row.identity_snapshot) !== JSON.stringify(pm.identity_snapshot) || !pm.next_identity_snapshot) {
      return { status: 'CONFLICT_MEMBER_SET_CHANGED' };
    }
    const product = (tables.products || []).find(p => p.mall === row.source_mall && p.product_id === row.product_id);
    if (!product || product.title !== pm.title || String(product.vendor_item_id || '') !== String(pm.vendor_item_id || '')) return { status: 'STALE_PRODUCT_CHANGED' };
  }
  if (tables.canonical_product_groups.some(g => String(g.id) !== String(group.id)
    && (g.canonical_key === params.p_next_canonical_key || g.next_canonical_key === params.p_next_canonical_key))) {
    return { status: 'CONFLICT_CANONICAL_KEY_EXISTS' };
  }
  Object.assign(group, {
    next_canonical_key: params.p_next_canonical_key, next_identity: clone(params.p_next_identity),
    next_confidence_tier: params.p_next_confidence_tier, next_matcher_version: params.p_next_matcher_version,
    next_plan_hash: params.p_plan_hash, next_staged_at: 'now'
  });
  params.p_members.forEach(pm => { members.find(m => m.offer_key === pm.offer_key).next_identity_snapshot = clone(pm.next_identity_snapshot); });
  return { status: 'STAGED' };
}

function finalize(tables, params) {
  const group = tables.canonical_product_groups.find(g => String(g.id) === String(params.p_group_id));
  if (!group || group.status !== 'ACTIVE' || group.next_canonical_key !== params.p_expected_next_canonical_key
    || group.next_plan_hash !== params.p_expected_plan_hash) return { status: 'CONFLICT_NOT_STAGED' };
  const members = tables.canonical_product_members.filter(m => String(m.group_id) === String(group.id));
  if (members.some(m => !m.next_identity_snapshot)) return { status: 'CONFLICT_MEMBER_SET_CHANGED' };
  if (tables.canonical_product_groups.some(g => String(g.id) !== String(group.id) && g.canonical_key === group.next_canonical_key)) return { status: 'CONFLICT_CANONICAL_KEY_EXISTS' };
  Object.assign(group, {
    rollout_key: group.rollout_key || group.canonical_key,
    previous_canonical_key: group.canonical_key, previous_identity: group.identity,
    previous_confidence_tier: group.confidence_tier, previous_matcher_version: group.matcher_version,
    canonical_key: group.next_canonical_key, identity: group.next_identity,
    confidence_tier: group.next_confidence_tier, matcher_version: group.next_matcher_version,
    next_canonical_key: null, next_identity: null, next_confidence_tier: null, next_matcher_version: null,
    next_plan_hash: null, next_staged_at: null, transitioned_at: 'now'
  });
  members.forEach(m => Object.assign(m, {
    previous_identity_snapshot: m.identity_snapshot, identity_snapshot: m.next_identity_snapshot, next_identity_snapshot: null
  }));
  return { status: 'FINALIZED' };
}

function abort(tables, params) {
  const group = tables.canonical_product_groups.find(g => String(g.id) === String(params.p_group_id));
  if (!group || group.next_canonical_key !== params.p_expected_next_canonical_key) return { status: 'CONFLICT_NOT_STAGED' };
  Object.assign(group, { next_canonical_key: null, next_identity: null, next_confidence_tier: null, next_matcher_version: null, next_plan_hash: null, next_staged_at: null });
  tables.canonical_product_members.filter(m => String(m.group_id) === String(group.id)).forEach(m => { m.next_identity_snapshot = null; });
  return { status: 'ABORTED' };
}

function revert(tables, params) {
  const group = tables.canonical_product_groups.find(g => String(g.id) === String(params.p_group_id));
  if (!group || group.status !== 'ACTIVE' || group.canonical_key !== params.p_expected_canonical_key
    || !group.previous_canonical_key || group.next_canonical_key) return { status: 'CONFLICT_NOT_REVERTIBLE' };
  const members = tables.canonical_product_members.filter(m => String(m.group_id) === String(group.id));
  if (members.some(m => !m.previous_identity_snapshot)) return { status: 'CONFLICT_MEMBER_SET_CHANGED' };
  Object.assign(group, {
    next_canonical_key: group.canonical_key, next_identity: group.identity, next_confidence_tier: group.confidence_tier,
    next_matcher_version: group.matcher_version, next_plan_hash: `revert:${group.canonical_key}`, next_staged_at: 'now',
    canonical_key: group.previous_canonical_key, identity: group.previous_identity,
    confidence_tier: group.previous_confidence_tier, matcher_version: group.previous_matcher_version,
    previous_canonical_key: null, previous_identity: null, previous_confidence_tier: null, previous_matcher_version: null, transitioned_at: null
  });
  members.forEach(m => Object.assign(m, {
    next_identity_snapshot: m.identity_snapshot, identity_snapshot: m.previous_identity_snapshot, previous_identity_snapshot: null
  }));
  return { status: 'REVERTED' };
}

const RPC = {
  canonical_identity_transition_stage: stage,
  canonical_identity_transition_finalize: finalize,
  canonical_identity_transition_abort: abort,
  canonical_identity_transition_revert: revert
};

module.exports = { stage, finalize, abort, revert, RPC };
