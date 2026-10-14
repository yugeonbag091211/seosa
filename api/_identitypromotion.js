'use strict';

/*
 * Product Identity Phase 3 — promotion policy.
 *
 * This module is pure: it reads no DB, writes no DB, and has no consumer-facing path.
 * Phase 1 MATCH is evidence for evaluation, never approval by itself.
 */

const crypto = require('crypto');
const OI = require('./_offeridentity');

const POLICY_VERSION = 'promotion_v2';
const DECISION = Object.freeze({ PROMOTE: 'PROMOTE', HOLD: 'HOLD', REJECT: 'REJECT' });

const CONFLICT_REASON = Object.freeze({
  gtin_mismatch: 'REJECT_GTIN_CONFLICT',
  brand_mismatch: 'REJECT_BRAND_CONFLICT',
  model_number_mismatch: 'REJECT_MODEL_NUMBER_CONFLICT',
  model_mismatch: 'REJECT_MODEL_CONFLICT',
  variant_mismatch: 'REJECT_VARIANT_CONFLICT',
  storage_mismatch: 'REJECT_STORAGE_CONFLICT',
  memory_mismatch: 'REJECT_MEMORY_CONFLICT',
  color_mismatch: 'REJECT_COLOR_CONFLICT',
  quantity_mismatch: 'REJECT_QUANTITY_CONFLICT',
  condition_mismatch: 'REJECT_CONDITION_CONFLICT',
  transaction_mismatch: 'REJECT_TRANSACTION_CONFLICT',
  region_mismatch: 'REJECT_REGION_CONFLICT',
  year_mismatch: 'REJECT_YEAR_CONFLICT',
  bundle_mismatch: 'REJECT_BUNDLE_CONFLICT',
  main_vs_accessory: 'REJECT_ACCESSORY_CONFLICT',
  accessory_type_mismatch: 'REJECT_ACCESSORY_CONFLICT',
  genuine_vs_substitute: 'REJECT_SUBSTITUTE_CONFLICT',
  merchant_option_mismatch: 'REJECT_MERCHANT_OPTION_CONFLICT',
  category_mismatch: 'REJECT_PRODUCT_FAMILY_CONFLICT',
  cpu_mismatch: 'REJECT_CPU_CONFLICT',
  gpu_mismatch: 'REJECT_GPU_CONFLICT'
});

function unique(values) { return [...new Set(values)]; }

/*
 * Promotion merchant semantics are stricter than source-mall semantics.
 * A bare ADPICK row tells us the affiliate source, not the actual merchant.
 * Treat it as UNKNOWN so it can never satisfy the cross-merchant gate or be
 * auto-promoted beside a labeled ADPICK merchant (or another known merchant).
 */
function promotionMerchantKey(member) {
  const mall = String((member && member.mall) || '').trim();
  if (!mall || mall.toUpperCase() === 'ADPICK') return '';
  if (/^ADPICK\//i.test(mall)) {
    const label = mall.slice(mall.indexOf('/') + 1).trim();
    return label ? `ADPICK/${label}` : '';
  }
  return mall;
}
function promotionMerchantEvidence(members) {
  const keys = (members || []).map(promotionMerchantKey);
  return { merchants: unique(keys.filter(Boolean)), unknownCount: keys.filter(x => !x).length };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => {
    const v = stable(value[key]);
    if (v !== undefined) out[key] = v;
    return out;
  }, {});
}
function stableJson(value) { return JSON.stringify(stable(value)); }

function commonValues(members, field) {
  if (!members.length) return [];
  const lists = members.map(m => unique((m[field] || []).map(String)).sort());
  return lists[0].filter(v => lists.every(xs => xs.includes(v)));
}

function fieldValues(members, getter) {
  return members.map(getter);
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value == null || value === '') return false;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function addOneSidedReason(reasons, values, reason) {
  const present = values.map(hasValue);
  if (present.some(Boolean) && present.some(x => !x)) reasons.push(reason);
}

function compareStableValues(members, getter) {
  const values = members.map(m => stableJson(getter(m)));
  return values.every(v => v === values[0]);
}

function commonStrongIdentifier(members) {
  const gtins = commonValues(members, 'gtins');
  if (gtins.length) return { type: 'gtin', value: gtins[0] };

  const codes = commonValues(members, 'modelNumbers');
  if (codes.length) return { type: 'manufacturer_model_number', value: codes[0] };
  return null;
}

function effectiveTier(members, pairResults) {
  const strong = commonStrongIdentifier(members);
  if (strong) return { tier: 'A', strongIdentifier: strong };
  if (pairResults.every(x => x.result.tier === 'B')) return { tier: 'B', strongIdentifier: null };
  if (pairResults.some(x => x.result.tier === 'A')) return { tier: '', strongIdentifier: null, looseStrongEvidence: true };
  return { tier: '', strongIdentifier: null };
}

function canonicalIdentity(members, strongIdentifier, tier) {
  const identity = {};
  const commonScalar = (key, getter) => {
    const values = members.map(getter);
    if (values.length && values[0] != null && values[0] !== '' && values.every(v => stableJson(v) === stableJson(values[0]))) identity[key] = values[0];
  };
  const commonList = (key, getter) => {
    const values = members.map(m => unique(getter(m) || []).sort());
    if (values.length && values[0].length && values.every(v => stableJson(v) === stableJson(values[0]))) identity[key] = values[0];
  };

  if (strongIdentifier) identity.strongIdentifier = strongIdentifier;
  identity.tier = tier;
  commonScalar('brand', m => m.brand || '');
  commonList('familyWords', m => m.words);
  commonScalar('modelAnchor', m => m.primaryAnchor || '');
  commonList('modelNumbers', m => m.modelNumbers);
  commonList('gtins', m => m.gtins);
  commonList('variants', m => m.variants);
  commonList('storage', m => m.storage);
  commonList('memory', m => m.memory);
  // 컴퓨터의 CPU·GPU (matcher evidence v2). 값이 없는 상품의 키는 예전과 같다(commonList 는 빈 값을 넣지 않는다).
  commonList('cpu', m => m.cpu);
  commonList('gpu', m => m.gpu);
  commonList('colors', m => m.colors);
  commonScalar('quantity', m => m.quantity);
  commonScalar('condition', m => m.condition === 'unstated' ? '' : m.condition);
  commonScalar('transactionType', m => m.transactionType || '');
  commonScalar('region', m => m.region || '');
  commonScalar('year', m => m.year || '');
  commonScalar('bundle', m => m.bundle || '');
  commonScalar('accessoryType', m => m.accessoryType || '');
  commonScalar('deviceClass', m => m.deviceClass || '');
  const specMaps = members.map(m => m.specs || {});
  const specKeys = unique(specMaps.flatMap(x => Object.keys(x))).sort();
  const specs = {};
  specKeys.forEach(k => {
    const vals = specMaps.map(x => unique(x[k] || []).sort());
    if (vals[0].length && vals.every(v => stableJson(v) === stableJson(vals[0]))) specs[k] = vals[0];
  });
  if (Object.keys(specs).length) identity.specs = specs;
  return stable(identity);
}

function canonicalKeyOf(identity) {
  if (!identity) return '';
  const tierAKey = identity.strongIdentifier && identity.strongIdentifier.value;
  const tierBKey = identity.tier === 'B' && identity.brand
    && Array.isArray(identity.familyWords) && identity.familyWords.length
    && identity.modelAnchor;
  if (!tierAKey && !tierBKey) return '';
  // Unknown attributes are omitted. Present values remain in the fingerprint, so known options split keys.
  return crypto.createHash('sha256').update(stableJson(identity)).digest('hex');
}

function snapshotOf(id) {
  return {
    brand: id.brand, words: id.words, model: id.primaryAnchor, anchors: id.anchors,
    variants: id.variants, modelNumbers: id.modelNumbers, gtins: id.gtins,
    storage: id.storage, memory: id.memory, specs: id.specs, colors: id.colors,
    quantity: id.quantity, condition: id.condition, conditionStates: id.conditionStates,
    transactionType: id.transactionType, region: id.region, bundle: id.bundle,
    included: id.included, accessory: id.accessory, accessoryType: id.accessoryType,
    substitute: id.substitute, year: id.year, deviceClass: id.deviceClass, flags: id.flags,
    // CPU·GPU 는 값이 있을 때만 — 컴퓨터가 아닌 상품의 스냅숏은 예전과 같다(stableJson 은 undefined 를 버린다).
    cpu: id.cpu && id.cpu.length ? id.cpu : undefined, gpu: id.gpu && id.gpu.length ? id.gpu : undefined
  };
}

function reasonFromUnknown(unknown) {
  const u = String(unknown || '').split(':')[0];
  const map = {
    storage: 'HOLD_MISSING_STORAGE', memory: 'HOLD_MISSING_MEMORY', color: 'HOLD_MISSING_COLOR',
    quantity: 'HOLD_MISSING_QUANTITY', condition: 'HOLD_MISSING_CONDITION',
    variant: 'HOLD_MISSING_VARIANT', model_detail: 'HOLD_MISSING_MODEL',
    model_number: 'HOLD_MISSING_MODEL_NUMBER', model_number_partial: 'HOLD_MODEL_NUMBER_NOT_EXACT',
    region: 'HOLD_MISSING_REGION', year: 'HOLD_MISSING_YEAR', bundle: 'HOLD_MISSING_BUNDLE',
    bundle_composition: 'HOLD_BUNDLE_COMPOSITION', included_components: 'HOLD_COMPONENT_EVIDENCE',
    size: 'HOLD_MISSING_SIZE', price_gap: 'HOLD_PRICE_GAP', non_new_condition: 'HOLD_NON_NEW_CONDITION',
    non_purchase_listing: 'HOLD_NON_PURCHASE_LISTING', option_choice: 'HOLD_OPTION_CHOICE',
    multi_model_listing: 'HOLD_MULTI_MODEL_LISTING', listing_number: 'HOLD_LISTING_NUMBER',
    no_model_anchor: 'HOLD_MISSING_MODEL', insufficient_evidence: 'HOLD_INSUFFICIENT_EVIDENCE',
    cpu: 'HOLD_MISSING_CPU', cpu_detail: 'HOLD_CPU_NOT_EXACT', gpu: 'HOLD_MISSING_GPU'
  };
  if (u.startsWith('size_')) return 'HOLD_MISSING_SIZE';
  if (u.startsWith('title_words')) return 'HOLD_TITLE_WORD_DRIFT';
  return map[u] || 'HOLD_PAIR_UNKNOWN';
}

function reasonFromConflict(conflict) {
  const key = String(conflict || '').split(':')[0];
  if (key.startsWith('size_mismatch_')) return 'REJECT_SIZE_CONFLICT';
  return CONFLICT_REASON[key] || 'REJECT_HARD_CONFLICT';
}

function pairwise(members, contextFactory) {
  const context = contextFactory || OI.contextFactory(members);
  const pairs = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      pairs.push({ a: members[i], b: members[j], result: OI.matchOffers(members[i], members[j], context(members[i], members[j])) });
    }
  }
  return pairs;
}

function missingAttributeReasons(members) {
  const reasons = [];
  addOneSidedReason(reasons, fieldValues(members, m => m.modelNumbers), 'HOLD_MISSING_MODEL_NUMBER');
  addOneSidedReason(reasons, fieldValues(members, m => m.anchors), 'HOLD_MISSING_MODEL');
  addOneSidedReason(reasons, fieldValues(members, m => m.variants), 'HOLD_MISSING_VARIANT');
  addOneSidedReason(reasons, fieldValues(members, m => m.storage), 'HOLD_MISSING_STORAGE');
  addOneSidedReason(reasons, fieldValues(members, m => m.memory), 'HOLD_MISSING_MEMORY');
  addOneSidedReason(reasons, fieldValues(members, m => m.cpu), 'HOLD_MISSING_CPU');
  addOneSidedReason(reasons, fieldValues(members, m => m.gpu), 'HOLD_MISSING_GPU');
  addOneSidedReason(reasons, fieldValues(members, m => m.colors), 'HOLD_MISSING_COLOR');
  addOneSidedReason(reasons, fieldValues(members, m => m.quantity == null ? null : [m.quantity]), 'HOLD_MISSING_QUANTITY');
  addOneSidedReason(reasons, fieldValues(members, m => m.condition === 'unstated' ? null : [m.condition]), 'HOLD_MISSING_CONDITION');
  addOneSidedReason(reasons, fieldValues(members, m => m.region ? [m.region] : null), 'HOLD_MISSING_REGION');
  addOneSidedReason(reasons, fieldValues(members, m => m.year ? [m.year] : null), 'HOLD_MISSING_YEAR');

  const specKeys = unique(members.flatMap(m => Object.keys(m.specs || {})));
  specKeys.forEach(k => addOneSidedReason(reasons,
    fieldValues(members, m => m.specs && m.specs[k]), 'HOLD_MISSING_SIZE'));
  return unique(reasons);
}

/** Evaluate one saved shadow group against fresh parsed offers and the current Phase 1 matcher. */
function evaluateGroup(input) {
  const o = input || {};
  const run = o.run || {};
  const group = o.group || {};
  const members = (o.members || []).filter(Boolean);
  const reasons = [];
  const add = reason => { if (reason && !reasons.includes(reason)) reasons.push(reason); };

  if (run.status !== 'completed') return result(DECISION.HOLD, ['HOLD_SHADOW_RUN_NOT_COMPLETED']);
  if (members.length < 2 || Number(group.member_count) !== members.length) return result(DECISION.HOLD, ['HOLD_MEMBER_SNAPSHOT_INCOMPLETE']);
  const merchantEvidence = promotionMerchantEvidence(members);
  const merchants = merchantEvidence.merchants;
  if (merchantEvidence.unknownCount) return result(DECISION.HOLD, ['HOLD_UNKNOWN_MERCHANT'], {
    merchantCount: merchants.length, unknownMerchantCount: merchantEvidence.unknownCount
  });
  if (merchants.length < 2) return result(DECISION.REJECT, ['REJECT_NOT_CROSS_MERCHANT'], { merchantCount: merchants.length });
  if (Number(group.merchant_count) !== merchants.length) add('HOLD_MERCHANT_COUNT_MISMATCH');

  const duplicateMembers = new Set();
  members.forEach(m => {
    const k = `${m.productId || ''}\u0000${m.mall || ''}`;
    if (duplicateMembers.has(k)) add('REJECT_DUPLICATE_MEMBER');
    duplicateMembers.add(k);
  });
  if (reasons.some(x => x.startsWith('REJECT_'))) return result(DECISION.REJECT, reasons, { merchantCount: merchants.length });

  const pairs = pairwise(members, o.contextFactory);
  pairs.forEach(p => {
    p.result.conflicts.forEach(c => add(reasonFromConflict(c)));
    if (p.result.decision === OI.DECISION.NO_MATCH && !p.result.conflicts.length) add('REJECT_PAIR_NO_MATCH');
    if (p.result.decision === OI.DECISION.REVIEW) p.result.unknown.forEach(u => add(reasonFromUnknown(u)));
  });
  if (reasons.some(x => x.startsWith('REJECT_'))) return result(DECISION.REJECT, reasons, { merchantCount: merchants.length, pairs });

  missingAttributeReasons(members).forEach(add);
  if (reasons.length) return result(DECISION.HOLD, reasons, { merchantCount: merchants.length, pairs });

  const policyTier = effectiveTier(members, pairs);
  if (policyTier.looseStrongEvidence) add('HOLD_STRONG_IDENTIFIER_NOT_EXACT');
  if (!policyTier.tier) add('HOLD_NO_STRONG_IDENTITY_TIER');

  if (policyTier.tier === 'B') {
    const brands = members.map(m => m.brand || '');
    const wordLists = members.map(m => stableJson(m.words || []));
    const anchors = members.map(m => m.primaryAnchor || '');
    const hasGenerationOnly = members.some(m => (m.flags || []).includes('generation_anchor'));
    if (!brands[0] || !brands.every(x => x === brands[0])) add('HOLD_TIER_B_BRAND_NOT_EXPLICIT');
    if (!wordLists.every(x => x === wordLists[0])) add('HOLD_TIER_B_FAMILY_DRIFT');
    if (!anchors[0] || !anchors.every(x => x === anchors[0])) add('HOLD_TIER_B_MODEL_NOT_EXPLICIT');
    if (hasGenerationOnly && !members.every(m => m.modelNumbers && m.modelNumbers.length)) add('HOLD_GENERATION_ONLY_ANCHOR');
    if (members.some(m => m.multiModel || (m.flags || []).includes('multi_model_listing'))) add('HOLD_MULTI_MODEL_LISTING');
  }

  if (reasons.length) return result(DECISION.HOLD, reasons, { merchantCount: merchants.length, tier: policyTier.tier, pairs });
  const observedRuns = Math.max(0, Number(o.observedRuns) || 0);
  const minRuns = Math.max(1, Math.floor(Number(o.minRuns) || 1));
  if (observedRuns < minRuns) return result(DECISION.HOLD, ['HOLD_INSUFFICIENT_HISTORY'], {
    merchantCount: merchants.length, tier: policyTier.tier, observedRuns, minRuns, pairs
  });

  const identity = canonicalIdentity(members, policyTier.strongIdentifier, policyTier.tier);
  const canonicalKey = canonicalKeyOf(identity);
  if (!canonicalKey) return result(DECISION.HOLD, ['HOLD_CANONICAL_KEY_UNAVAILABLE'], { merchantCount: merchants.length, tier: policyTier.tier, pairs });
  return result(DECISION.PROMOTE, [policyTier.tier === 'A' ? 'PROMOTE_STRONG_IDENTIFIER_EXACT' : 'PROMOTE_TIER_B_EXPLICIT_MODEL'], {
    merchantCount: merchants.length, tier: policyTier.tier, strongIdentifier: policyTier.strongIdentifier,
    canonicalKey, canonicalIdentity: identity, members: members.map(m => ({
      product_id: m.productId, source_mall: (m.key || '').split('|')[0] || m.mall,
      mall: m.mall, vendor_item_id: m.vendorItemId || '', offer_key: m.key,
      identity_snapshot: snapshotOf(m), evidence: unique(pairs.flatMap(p =>
        (p.a.key === m.key || p.b.key === m.key) ? p.result.evidence : []))
    })), pairs
  });
}

function result(decision, reasonCodes, extra) {
  return Object.assign({ decision, reasonCodes: unique(reasonCodes || []) }, extra || {});
}

/** Revalidate all members of an existing canonical group before adding anything to it. */
function evaluateExistingMembers(members, contextFactory) {
  const ids = (members || []).filter(Boolean);
  if (ids.length < 2) return { status: 'HOLD', reasonCodes: ['HOLD_EXISTING_MEMBER_SNAPSHOT_INCOMPLETE'], pairs: [] };
  const pairs = pairwise(ids, contextFactory);
  const conflicts = unique(pairs.flatMap(p => p.result.conflicts.map(reasonFromConflict)));
  if (conflicts.length) return { status: 'SUSPENDED', reasonCodes: conflicts, pairs };
  const noMatch = pairs.some(p => p.result.decision !== OI.DECISION.MATCH);
  if (noMatch) return { status: 'HOLD', reasonCodes: ['HOLD_EXISTING_PAIR_NOT_MATCH'], pairs };
  const unknown = unique(pairs.flatMap(p => p.result.decision === OI.DECISION.MATCH ? [] :
    p.result.unknown.map(reasonFromUnknown)));
  if (unknown.length) return { status: 'HOLD', reasonCodes: unknown, pairs };
  return { status: 'ACTIVE', reasonCodes: [], pairs };
}

module.exports = {
  POLICY_VERSION, DECISION, CONFLICT_REASON,
  stableJson, commonStrongIdentifier, canonicalIdentity, canonicalKeyOf,
  promotionMerchantKey, promotionMerchantEvidence,
  snapshotOf, reasonFromUnknown, reasonFromConflict, pairwise,
  missingAttributeReasons, evaluateGroup, evaluateExistingMembers,
  // matcher 전환(api/_canonicaltransition.js)이 승격과 «같은» 등급 규칙으로 다음 식별을 만들도록.
  effectiveTier
};
