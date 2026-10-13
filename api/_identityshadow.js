'use strict';
/*
 * Product Identity — Phase 2 Shadow Matching 의 순수 부분.
 *
 * ── 이 파일이 하는 일 ──────────────────────────────────────────────
 *
 *   · Phase 1 결과(clusterOffers)를 shadow 표의 «행» 으로 바꾼다
 *   · 저장 전에 불변식을 검증한다 (하나라도 깨지면 저장하지 않는다)
 *   · run 통계를 만든다
 *
 * ── 이 파일이 하지 않는 일 ─────────────────────────────────────────
 *
 *   · 상품 식별을 다시 구현하지 않는다. 판정은 전부 api/_offeridentity.js 다.
 *   · DB 를 모른다. 네트워크도 모른다. 전부 순수 함수다
 *     (그래서 운영 DB 없이 테스트할 수 있다 — scripts/test-identity-shadow.js).
 *
 * ── 왜 불변식을 코드로 다시 검사하는가 ─────────────────────────────
 *
 * Phase 1 이 all-pairs 로 묶으므로 «이론상» 그룹 안의 모든 쌍은 MATCH 다.
 * 그래도 저장 직전에 다시 센다. shadow 표는 나중에 Phase 3·4 가 읽을 재료이고,
 * 한 번 잘못 저장된 그룹은 «관측된 사실» 처럼 보이기 때문이다. matcher 에 버그가
 * 생기면 조용히 쌓이는 것보다 run 이 실패하는 쪽이 낫다.
 */

const crypto = require('crypto');
const OI = require('./_offeridentity');

/** matcher 계약 이름. 결과가 어떤 판정기에서 나왔는지 run 에 남긴다. */
const MATCHER_ID = 'offer_identity_v1';

/**
 * 저장할 최소 그룹 크기.
 *
 * 1인 그룹은 «묶이지 않았다» 와 같은 말이라 저장해도 정보가 없다. products 전체가
 * 그대로 복사될 뿐이고(7만 행), 그만큼 비교·검수 비용만 든다. 그룹에 들지 못한
 * 상품은 run 통계(source_product_count - 묶인 수)로 복원할 수 있다.
 */
const MIN_GROUP_SIZE = 2;

const VIOLATION = Object.freeze({
  PAIR_NOT_MATCH: 'pair_not_match',          // Invariant B/D
  DUPLICATE_MEMBER: 'duplicate_member',      // Invariant A
  REVIEW_BRIDGE: 'review_bridge',            // Invariant C
  EMPTY_GROUP: 'empty_group',
  UNKNOWN_MEMBER: 'unknown_member'
});

/**
 * 구성원 집합의 지문.
 *
 * Phase 1 의 group.id 는 «입력 순서에 따른 자리» 라 run 사이에 비교할 수 없다.
 * 정렬한 offer key 를 해시하면 같은 묶음이 언제나 같은 값을 받는다.
 */
function groupKeyOf(offerKeys) {
  const sorted = [...new Set((offerKeys || []).map(k => String(k)))].sort();
  return crypto.createHash('sha256').update(sorted.join('\u0000')).digest('hex').slice(0, 32);
}

/** 쌍을 항상 같은 순서로 (A-B 와 B-A 가 두 행이 되지 않게). */
function orderPair(a, b) {
  return String(a) < String(b) ? [a, b] : [b, a];
}

/**
 * 식별에 쓰인 값만 남긴 스냅숏.
 *
 * ★ 상품명을 담지 않는다. 사람이 검수할 때는 (product_id, mall) 로 products 를
 *   보면 된다. 제휴사 응답 본문을 우리 표에 한 벌 더 쌓지 않는다.
 */
function identitySnapshot(id) {
  return {
    brand: id.brand, words: id.words, model: id.primaryAnchor, anchors: id.anchors,
    variants: id.variants, modelNumbers: id.modelNumbers, gtins: id.gtins,
    storage: id.storage, memory: id.memory, specs: id.specs, colors: id.colors,
    quantity: id.quantity, condition: id.condition, transactionType: id.transactionType,
    region: id.region, bundle: id.bundle, accessory: id.accessory, accessoryType: id.accessoryType,
    substitute: id.substitute, year: id.year, deviceClass: id.deviceClass, flags: id.flags
  };
}

/**
 * 저장 대상 그룹 — member_count >= MIN_GROUP_SIZE 인 것만.
 * @param {Array} groups clusterOffers().groups
 */
function storableGroups(groups) {
  return (groups || []).filter(g => g && Array.isArray(g.members) && g.members.length >= MIN_GROUP_SIZE);
}

/**
 * 불변식 검증. 하나라도 깨지면 저장하지 않는다.
 *
 *   A  한 run 에서 같은 (product_id, mall, vendor_item_id) 가 두 그룹에 들어갈 수 없다
 *   B  한 그룹 안 모든 쌍은 MATCH 여야 한다
 *   C  REVIEW 쌍은 같은 그룹에 들어갈 수 없다 (bridge 금지)
 *   D  NO_MATCH 쌍이 같은 그룹에 있으면 실패  (B 가 함께 잡는다 — MATCH 가 아닌 모든 판정)
 *
 * @param {object} o {groups, offersByKey:Map<string,identity>, reviewPairs?:Array<[keyA,keyB]>}
 * @returns {{ok:boolean, violations:Array, checkedPairs:number}}
 */
function validateShadowResult(o) {
  const groups = storableGroups((o && o.groups) || []);
  const offersByKey = (o && o.offersByKey) || new Map();
  const violations = [];

  // A · 빈 그룹 · 모르는 구성원
  const seen = new Map();   // "product|mall|vid" → group_key
  groups.forEach(g => {
    const key = groupKeyOf(g.members);
    if (!g.members.length) { violations.push({ kind: VIOLATION.EMPTY_GROUP, groupKey: key }); return; }
    g.members.forEach(memberKey => {
      const id = offersByKey.get(memberKey);
      if (!id) { violations.push({ kind: VIOLATION.UNKNOWN_MEMBER, groupKey: key, offerKey: memberKey }); return; }
      const triple = `${id.productId}\u0000${id.mall}\u0000${id.vendorItemId || ''}`;
      if (seen.has(triple) && seen.get(triple) !== key) {
        violations.push({ kind: VIOLATION.DUPLICATE_MEMBER, offerKey: memberKey, groupKey: key, otherGroupKey: seen.get(triple) });
      } else seen.set(triple, key);
    });
  });

  // B · D — Phase 1 의 검사기를 그대로 쓴다 (판정을 여기서 다시 만들지 않는다)
  const bad = OI.verifyGroups(groups.map(g => ({ id: groupKeyOf(g.members), members: g.members })), offersByKey);
  bad.forEach(x => violations.push({
    kind: VIOLATION.PAIR_NOT_MATCH, groupKey: x.group, a: x.a, b: x.b,
    decision: x.result && x.result.decision,
    conflicts: (x.result && x.result.conflicts) || [], unknown: (x.result && x.result.unknown) || []
  }));

  // C — REVIEW 로 기록한 쌍이 같은 그룹 안에 있으면 bridge 가 생긴 것이다
  const groupOf = new Map();
  groups.forEach(g => { const key = groupKeyOf(g.members); g.members.forEach(mk => groupOf.set(mk, key)); });
  ((o && o.reviewPairs) || []).forEach(([a, b]) => {
    const ga = groupOf.get(a), gb = groupOf.get(b);
    if (ga && gb && ga === gb) violations.push({ kind: VIOLATION.REVIEW_BRIDGE, groupKey: ga, a, b });
  });

  const checkedPairs = groups.reduce((n, g) => n + (g.members.length * (g.members.length - 1)) / 2, 0);
  return { ok: violations.length === 0, violations, checkedPairs };
}

/**
 * 그룹 → 저장할 행. member 행은 group 행에 매달아 돌려준다
 * (group id 는 INSERT 뒤에야 정해지므로 워커가 채운다).
 *
 * @param {object} o {groups, offersByKey, pairDecision(aKey,bKey)->result, runId, matcher}
 */
function buildGroupRows(o) {
  const groups = storableGroups(o.groups);
  const offersByKey = o.offersByKey;
  const pairDecision = o.pairDecision;

  return groups.map(g => {
    const members = g.members.map(k => offersByKey.get(k)).filter(Boolean);
    const malls = [...new Set(members.map(m => m.mall).filter(Boolean))];
    const priced = members.filter(m => Number(m.price) > 0).sort((x, y) => x.price - y.price || (x.key < y.key ? -1 : 1));

    /*
     * 그룹의 등급은 구성원 쌍 중 «가장 약한» 증거를 따른다. 한 쌍이라도 Tier B 면
     * 그룹 전체를 A 라고 말할 수 없다. 쌍 판정은 Phase 1 것을 그대로 쓴다.
     */
    let tier = 'A';
    const perMember = new Map();
    for (let i = 0; i < g.members.length; i++) {
      for (let j = i + 1; j < g.members.length; j++) {
        const r = pairDecision(g.members[i], g.members[j]);
        if (!r) continue;
        if (r.tier === 'B' || !r.tier) tier = 'B';
        [[g.members[i], r], [g.members[j], r]].forEach(([k, res]) => {
          const cur = perMember.get(k);
          if (!cur || res.confidence < cur.confidence) perMember.set(k, res);
        });
      }
    }

    const row = {
      group_key: groupKeyOf(g.members),
      confidence_tier: tier,
      member_count: members.length,
      merchant_count: malls.length,
      canonical_identity: g.identity || {},
      lowest_price: priced.length ? Math.round(priced[0].price) : 0,
      lowest_mall: priced.length ? String(priced[0].mall || '') : '',
      verification_status: 'UNVERIFIED'
    };
    row._members = members.map(m => {
      const r = perMember.get(m.key) || {};
      return {
        product_id: m.productId,
        mall: m.mall,
        vendor_item_id: m.vendorItemId || '',
        offer_key: m.key,
        decision: 'MATCH',
        confidence: Number(r.confidence) || 0,
        tier: r.tier || tier,
        evidence: r.evidence || [],
        unknown: r.unknown || [],
        identity_snapshot: identitySnapshot(m)
      };
    });
    return row;
  });
}

/**
 * REVIEW 쌍 → 저장할 행. 쌍은 offer_key 오름차순으로 정규화하고 중복은 접는다.
 *
 * @param {Array<{a:object, b:object, result:object}>} pairs
 */
function buildReviewRows(pairs) {
  const byKey = new Map();
  (pairs || []).forEach(p => {
    if (!p || !p.a || !p.b || !p.result) return;
    const [leftKey, rightKey] = orderPair(p.a.key, p.b.key);
    if (leftKey === rightKey) return;
    const id = `${leftKey}\u0000${rightKey}`;
    if (byKey.has(id)) return;
    const left = p.a.key === leftKey ? p.a : p.b;
    const right = left === p.a ? p.b : p.a;
    byKey.set(id, {
      left_offer_key: leftKey,
      left_product_id: left.productId,
      left_mall: left.mall,
      left_vendor_item_id: left.vendorItemId || '',
      right_offer_key: rightKey,
      right_product_id: right.productId,
      right_mall: right.mall,
      right_vendor_item_id: right.vendorItemId || '',
      decision: 'REVIEW',
      confidence: Number(p.result.confidence) || 0,
      tier: p.result.tier || '',
      evidence: p.result.evidence || [],
      unknown: p.result.unknown || [],
      conflicts: p.result.conflicts || []
    });
  });
  return [...byKey.values()];
}

/**
 * run 통계. 숫자는 전부 관측값이다 — 추정하지 않는다.
 *
 * @param {object} o {offers, groups, census, clusterStats, parseFailed, violations, durationMs}
 */
function summarize(o) {
  const offers = o.offers || [];
  const stored = storableGroups(o.groups);
  const census = o.census || { match: 0, review: 0, noMatch: 0, comparisons: 0, skippedBlocks: 0 };
  const sizes = stored.map(g => g.members.length);
  const byMall = {};
  offers.forEach(x => {
    const m = String(x.mall || '').split('/')[0] || 'unknown';
    byMall[m] = (byMall[m] || 0) + 1;
  });
  const crossMerchant = stored.filter(g => new Set(g.members
    .map(k => (o.offersByKey ? (o.offersByKey.get(k) || {}).mall : '')).filter(Boolean)).size > 1).length;

  return {
    source_product_count: o.sourceProductCount != null ? o.sourceProductCount : offers.length,
    parsed_offer_count: offers.length,
    parse_failed_count: o.parseFailed || 0,
    comparison_count: census.comparisons,
    match_pair_count: census.match,
    review_pair_count: census.review,
    no_match_pair_count: census.noMatch,
    group_count: (o.groups || []).length,
    stored_group_count: stored.length,
    cross_merchant_group_count: crossMerchant,
    same_merchant_group_count: stored.length - crossMerchant,
    largest_group_size: sizes.length ? Math.max(...sizes) : 0,
    avg_group_size: sizes.length ? Math.round((sizes.reduce((a, b) => a + b, 0) / sizes.length) * 1000) / 1000 : 0,
    all_pairs_violation_count: (o.violations || []).length,
    error_count: o.errorCount || 0,
    duration_ms: Math.max(0, Math.round(o.durationMs || 0)),
    metadata: Object.assign({
      byMall,
      clusterStats: o.clusterStats || {},
      censusSkippedBlocks: census.skippedBlocks || 0,
      censusCapped: !!census.capped,
      minGroupSize: MIN_GROUP_SIZE
    }, o.metadata || {})
  };
}

module.exports = {
  MATCHER_ID, MIN_GROUP_SIZE, VIOLATION,
  groupKeyOf, orderPair, identitySnapshot, storableGroups,
  validateShadowResult, buildGroupRows, buildReviewRows, summarize
};
