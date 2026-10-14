'use strict';
/*
 * Product Identity — canonical matcher transition planner (2026-10-14). 순수 함수 · DB 없음.
 *
 * ── 풀려는 문제 ────────────────────────────────────────────────────
 *
 * Phase 5 소비자는 ACTIVE 그룹 구성원의 «저장된 식별 스냅숏 · canonical 키» 가 지금 파서의 결과와 같을 때만
 * 그 그룹을 보여 준다. matcher 를 고치면(PR #141) 같은 제목의 스냅숏·키가 바뀌어, 배포 순간 기존 ACTIVE 그룹이
 * 화면에서 사라진다(운영 HyperX 그룹: d8ef9634… → c926abe1…).
 *
 * ── 전환 방식 ──────────────────────────────────────────────────────
 *
 *   1. 계획(이 파일)   그룹마다 «새 matcher 로 바꿔도 되는가» 를 판정하고, 된다면 다음 식별·키·스냅숏을 만든다.
 *   2. STAGE (DB)      next_* 자리에만 쓴다. 기존 자리는 그대로라 지금 운영 코드는 아무 영향이 없다.
 *   3. 배포            새 소비자(api/_canonicalconsumer.js identityVersion)는 기존 자리 또는 next 자리 중
 *                      «구성원 전부가 지금 파서와 같은» 자리로 검증해 보여 준다 → 가격비교가 끊기지 않는다.
 *   4. FINALIZE (DB)   next_* 를 기존 자리로 옮긴다. 이전 값은 previous_* 에 남는다(REVERT 가능).
 *
 * ── 전환해도 되는 조건 (하나라도 아니면 HOLD — 배포 뒤 fail-closed) ─────
 *
 *   G1 구조       ACTIVE · 구성원 2~20 · offer_key 일관 · 중복 없음
 *   G2 상품 행    구성원 상품이 지금 있고 옵션(vendor_item_id)이 그대로
 *   G3 이전 일치  «이전 matcher» 로 지금 제목을 읽으면 저장된 스냅숏·키가 정확히 나온다
 *                 — 승격 뒤 제목이 바뀐(이미 stale 인) 그룹을 새 식별로 «살려내지» 않는다
 *   G4 재검증     새 matcher 로 모든 쌍이 MATCH (P.evaluateExistingMembers) — 구성원끼리의 문맥과,
 *                 주어지면 카탈로그 전체 문맥(색 계열 차원 등) 둘 다
 *   G5 등급       등급이 그대로이고, Tier A 면 강한 식별자 값이 그대로
 *   G6 키         다음 키가 만들어지고 다른 그룹의 키·다음 키와 겹치지 않는다
 *   G7 판매처     표시 판매처 2곳 이상
 *   G8 식별 변화  값이 바뀐 것은 없고 «표현» 만 바뀌었다(identityDrift) — CPU·GPU 칩 코드가 모델번호에서
 *                 부품으로, 32G 가 규격에서 메모리로 옮겨 간 것 같은 것만 허용한다
 *   G9 자체 검사  만든 next 값을 새 소비자의 identityVersion 에 넣으면 실제로 next 자리로 받아들여진다
 *
 * ★ 이 파일은 판정만 한다. DB 를 읽거나 쓰지 않는다(scripts/run-canonical-transition.js 가 한다).
 */

const crypto = require('crypto');
const OI = require('./_offeridentity');
const P = require('./_identitypromotion');
const Price = require('./_price');
const Consumer = require('./_canonicalconsumer');

const VERDICT = Object.freeze({
  TRANSITION: 'TRANSITION',          // STAGE 해도 된다 (배포 전에 STAGE 해야 끊김이 없다)
  ALREADY_CURRENT: 'ALREADY_CURRENT', // 지금 matcher 로도 기존 자리가 그대로 맞는다 — 할 일 없음
  ALREADY_STAGED: 'ALREADY_STAGED',   // next 자리가 이미 지금 matcher 와 맞는다 — FINALIZE 대상
  HOLD: 'HOLD'                        // 전환하지 않는다 — 새 소비자에서 fail-closed
});

const unique = list => [...new Set(list)];
const list = v => (Array.isArray(v) ? v : []);
const js = v => P.stableJson(v === undefined ? null : v);
const chipCode = c => OI._internal.CHIP_CODE_RE.test(String(c || ''));

/**
 * 이전 정규 식별 → 다음 정규 식별 사이에 «값» 이 바뀌었는가, «표현» 만 바뀌었는가.
 *   material  값이 바뀜 — 사람이 다시 봐야 한다(HOLD_IDENTITY_DRIFT)
 *   changes   표현만 바뀜 — 전환해도 된다
 * @returns {{changes:string[], material:string[]}}
 */
function identityDrift(prev, next) {
  const p = prev || {}, n = next || {};
  const changes = [], material = [];
  const diff = f => js(p[f]) !== js(n[f]);

  // 1) 상품을 가르는 값 — 하나라도 바뀌면 다른 그룹이다
  ['tier', 'transactionType', 'condition', 'quantity', 'region', 'year', 'bundle', 'accessoryType', 'deviceClass', 'colors', 'gtins']
    .forEach(f => { if (diff(f)) material.push(f); });
  const ps = p.strongIdentifier || null, ns = n.strongIdentifier || null;
  if (js(ps && ps.value) !== js(ns && ns.value)) material.push('strongIdentifier');
  else if (js(ps) !== js(ns)) changes.push('strongIdentifier');

  // 2) 브랜드 — 없다가 생기는 것만(HP 를 브랜드로 읽게 된 것). 다른 브랜드로 바뀌거나 사라지면 값 변화다.
  if (diff('brand')) (p.brand ? material : changes).push('brand');

  // 3) 모델번호 — CPU·GPU 칩 코드가 부품으로 빠지는 것만. 새 모델번호가 생기거나 칩이 아닌 코드가 빠지면 값 변화다.
  const removedCodes = list(p.modelNumbers).filter(c => !list(n.modelNumbers).includes(c));
  const addedCodes = list(n.modelNumbers).filter(c => !list(p.modelNumbers).includes(c));
  if (addedCodes.length || removedCodes.some(c => !chipCode(c))) material.push('modelNumbers');
  else if (removedCodes.length) changes.push('modelNumbers');

  // 4) 계열 낱말 — 빠질 수만 있다(판매처 번호 꼬리 · 브랜드로 옮겨 간 낱말). 새 낱말이 생기면 값 변화다.
  const addedWords = list(n.familyWords).filter(w => !list(p.familyWords).includes(w));
  if (addedWords.length) material.push('familyWords');
  else if (diff('familyWords')) changes.push('familyWords');

  // 5) 규격 — g · t 만 빠질 수 있다(메모리·저장 용량으로 옮겨 감). 나머지 규격은 그대로여야 한다.
  const pSpecs = p.specs || {}, nSpecs = n.specs || {};
  const specsOk = Object.keys(nSpecs).every(k => js(pSpecs[k]) === js(nSpecs[k]))
    && Object.keys(pSpecs).filter(k => !(k in nSpecs)).every(k => k === 'g' || k === 't');
  if (!specsOk) material.push('specs');
  else if (diff('specs')) changes.push('specs');

  // 6) 메모리 · 저장 용량 — 값이 «옮겨 갈» 뿐 새 값이 생기지 않는다
  const pool = new Set([
    ...list(p.memory), ...list(p.storage),
    ...list(pSpecs.g).map(v => `${v}gb`), ...list(pSpecs.t).map(v => `${Number(v) * 1024}gb`)
  ]);
  const memoryOk = list(n.memory).every(v => pool.has(v));
  const storageOk = list(n.storage).every(v => pool.has(v))
    && list(p.storage).every(v => list(n.storage).includes(v) || list(n.memory).includes(v));
  if (!memoryOk) material.push('memory');
  else if (diff('memory')) changes.push('memory');
  if (!storageOk) material.push('storage');
  else if (diff('storage')) changes.push('storage');

  // 7) CPU · GPU — 새 필드. 칩 코드가 모델번호에서 빠졌거나 노트북일 때만 «표현 변화» 다.
  const computerish = n.deviceClass === 'laptop' || removedCodes.some(chipCode);
  ['cpu', 'gpu'].forEach(f => { if (list(n[f]).length) (computerish ? changes : material).push(f); });

  // 8) 모델 앵커 · 등급 — «울트라7» 같은 CPU 표기가 앵커·등급으로 읽히던 것이 빠질 때만 바뀔 수 있다
  ['modelAnchor', 'variants'].forEach(f => { if (diff(f)) (list(n.cpu).length ? changes : material).push(f); });

  return { changes: unique(changes), material: unique(material) };
}

function planHashOf(payload) {
  return crypto.createHash('sha256').update(P.stableJson(payload)).digest('hex');
}

/**
 * 그룹 하나의 전환 계획.
 *
 * @param {object} o
 *   group            canonical 그룹 행
 *   members          그 그룹의 구성원 행
 *   rowsByKey        Map(`${mall}|${product_id}` → products 행)
 *   legacy           {snapshot(row, member) → 이전 matcher 스냅숏, key(rows, members, group) → 이전 matcher 키} | null
 *   catalogContext   (x, y) → ctx — 카탈로그 전체 문맥(없으면 구성원 문맥만 본다)
 *   requireCatalog   true 면 catalogContext 가 없을 때 HOLD
 *   takenKeys        Set — 다른 그룹들의 canonical_key · next_canonical_key
 *   matcherVersion   지금 matcher 의 버전(git SHA)
 */
function planGroupTransition(o) {
  const group = (o && o.group) || {};
  const members = list(o && o.members).slice().sort((a, b) => String(a.offer_key).localeCompare(String(b.offer_key)));
  const rowsByKey = (o && o.rowsByKey) || new Map();
  const base = {
    groupId: group.id, currentKey: String(group.canonical_key || ''),
    rolloutKey: Consumer._internal.rolloutKeyOf(group), memberCount: members.length,
    matcherVersion: String((o && o.matcherVersion) || '')
  };
  const hold = (codes, extra) => Object.assign({}, base, { verdict: VERDICT.HOLD, afterDeploy: 'FAIL_CLOSED', reasonCodes: unique(codes) }, extra || {});

  /* G1 구조 */
  if (group.status !== 'ACTIVE') return hold(['HOLD_GROUP_NOT_ACTIVE']);
  if (members.length < 2 || members.length > Consumer._internal.MAX_GROUP_MEMBERS) return hold(['HOLD_MEMBER_COUNT']);
  const seen = new Set();
  for (const m of members) {
    const key = `${m.source_mall || ''}|${m.product_id || ''}`;
    if (!m.source_mall || !m.product_id || String(m.offer_key || '') !== key || seen.has(key)) return hold(['HOLD_MEMBER_STRUCTURE']);
    seen.add(key);
  }

  /* G2 상품 행 */
  const rows = [];
  for (const m of members) {
    const row = rowsByKey.get(String(m.offer_key));
    if (!row || String(row.mall || '') !== String(m.source_mall) || String(row.product_id || '') !== String(m.product_id)) return hold(['HOLD_PRODUCT_ROW_MISSING']);
    if (Price.vendorIdOf(row) !== String(m.vendor_item_id || '')) return hold(['HOLD_VENDOR_OPTION_CHANGED']);
    rows.push(row);
  }

  /* 지금 matcher 로 읽기 — 소비자와 «같은» 함수로 (그래야 STAGE 한 스냅숏이 소비자에서 그대로 맞는다) */
  const identities = members.map((m, i) => Consumer._internal.parseCurrent(rows[i], m));
  const nextSnapshots = identities.map(id => P.snapshotOf(id));
  const memberContext = OI.contextFactory(identities);
  const keyOf = (identity, tier) => P.canonicalKeyOf(P.canonicalIdentity(identities, (identity || {}).strongIdentifier || null, tier));

  const accepted = Consumer._internal.identityVersion(group, members, identities);
  if (accepted && accepted.version === 'primary') {
    return keyOf(group.identity, group.confidence_tier) === base.currentKey
      ? Object.assign({}, base, { verdict: VERDICT.ALREADY_CURRENT, afterDeploy: 'SERVED', reasonCodes: [] })
      : hold(['HOLD_CURRENT_KEY_MISMATCH']);
  }
  if (accepted && accepted.version === 'next') {
    return keyOf(group.next_identity, group.next_confidence_tier) === String(group.next_canonical_key)
      ? Object.assign({}, base, { verdict: VERDICT.ALREADY_STAGED, afterDeploy: 'SERVED', reasonCodes: [], nextKey: String(group.next_canonical_key), planHash: group.next_plan_hash || '' })
      : hold(['HOLD_STAGED_KEY_MISMATCH']);
  }
  if (group.next_canonical_key) return hold(['HOLD_STAGED_SNAPSHOT_STALE']);

  /* G3 이전 matcher 일치 */
  const legacy = o && o.legacy;
  if (!legacy || typeof legacy.snapshot !== 'function' || typeof legacy.key !== 'function') return hold(['HOLD_PREVIOUS_MATCHER_UNVERIFIED']);
  const legacyOk = members.every((m, i) => P.stableJson(legacy.snapshot(rows[i], m)) === P.stableJson(m.identity_snapshot || {}))
    && legacy.key(rows, members, group) === base.currentKey;
  if (!legacyOk) return hold(['HOLD_STALE_UNDER_PREVIOUS_MATCHER']);

  /* G4 재검증 — 모든 쌍 MATCH */
  // 판정은 evaluateExistingMembers 그대로 — 뒤에 붙이는 쌍별 미확인 이유(색 모름 등)는 운영자가 읽을 진단일 뿐이다.
  const pairUnknowns = check => list(check.pairs).flatMap(p => (p.result.decision === OI.DECISION.MATCH ? [] : list(p.result.unknown).map(P.reasonFromUnknown)));
  const memberCheck = P.evaluateExistingMembers(identities, memberContext);
  if (memberCheck.status !== 'ACTIVE') return hold(['HOLD_REVALIDATION_FAILED', ...memberCheck.reasonCodes, ...pairUnknowns(memberCheck)], { revalidation: memberCheck.status });
  if (o.catalogContext) {
    const catalogCheck = P.evaluateExistingMembers(identities, o.catalogContext);
    if (catalogCheck.status !== 'ACTIVE') return hold(['HOLD_CATALOG_REVALIDATION_FAILED', ...catalogCheck.reasonCodes, ...pairUnknowns(catalogCheck)], { revalidation: catalogCheck.status });
  } else if (o.requireCatalog) return hold(['HOLD_CATALOG_CONTEXT_MISSING']);

  /* G5 등급 · 강한 식별자 */
  const tierInfo = P.effectiveTier(identities, memberCheck.pairs);
  if (!tierInfo.tier) return hold(['HOLD_NO_STRONG_IDENTITY_TIER']);
  if (tierInfo.tier !== group.confidence_tier) return hold(['HOLD_TIER_CHANGED']);
  const prevStrong = (group.identity || {}).strongIdentifier || null;
  if (tierInfo.tier === 'A' && js(prevStrong && prevStrong.value) !== js(tierInfo.strongIdentifier && tierInfo.strongIdentifier.value)) {
    return hold(['HOLD_STRONG_IDENTIFIER_CHANGED']);
  }

  /* G6 키 */
  const nextIdentity = P.canonicalIdentity(identities, tierInfo.strongIdentifier, tierInfo.tier);
  const nextKey = P.canonicalKeyOf(nextIdentity);
  if (!nextKey) return hold(['HOLD_CANONICAL_KEY_UNAVAILABLE']);
  if (o.takenKeys && o.takenKeys.has(nextKey)) return hold(['HOLD_CANONICAL_KEY_COLLISION'], { nextKey });

  /* G7 판매처 */
  if (new Set(members.map(m => String(m.mall || '').trim()).filter(Boolean)).size < 2) return hold(['HOLD_NOT_CROSS_MERCHANT']);

  /* G8 식별 변화 */
  const drift = identityDrift(group.identity, nextIdentity);
  if (drift.material.length) return hold(['HOLD_IDENTITY_DRIFT'], { drift, nextKey });

  if (!base.matcherVersion) return hold(['HOLD_MATCHER_VERSION_MISSING']);

  /* G9 자체 검사 — 만든 값을 새 소비자가 정말 next 자리로 받는가 */
  const staged = Object.assign({}, group, { next_canonical_key: nextKey, next_identity: nextIdentity, next_confidence_tier: tierInfo.tier });
  const stagedMembers = members.map((m, i) => Object.assign({}, m, { next_identity_snapshot: nextSnapshots[i] }));
  const check = Consumer._internal.identityVersion(staged, stagedMembers, identities);
  if (!check || check.version !== 'next' || keyOf(nextIdentity, tierInfo.tier) !== nextKey) return hold(['HOLD_SELF_CHECK_FAILED']);

  const stageMembers = members.map((m, i) => ({
    offer_key: m.offer_key, source_mall: m.source_mall, product_id: m.product_id,
    vendor_item_id: m.vendor_item_id || '', title: String(rows[i].title || ''),
    identity_snapshot: m.identity_snapshot || {}, next_identity_snapshot: nextSnapshots[i]
  }));
  const planHash = planHashOf({
    groupId: group.id, from: base.currentKey, to: nextKey, tier: tierInfo.tier, identity: nextIdentity,
    matcherVersion: base.matcherVersion, members: stageMembers
  });
  return Object.assign({}, base, {
    verdict: VERDICT.TRANSITION, afterDeploy: 'SERVED_IF_STAGED_BEFORE_DEPLOY', reasonCodes: [],
    nextKey, nextTier: tierInfo.tier, nextIdentity, drift, planHash,
    stage: {
      p_group_id: group.id, p_expected_canonical_key: base.currentKey, p_next_canonical_key: nextKey,
      p_next_identity: nextIdentity, p_next_confidence_tier: tierInfo.tier, p_next_matcher_version: base.matcherVersion,
      p_plan_hash: planHash, p_members: stageMembers
    }
  });
}

/**
 * 여러 그룹의 계획 요약. 배포 뒤 끊기는 그룹이 있으면 ready=false.
 *
 * acceptFailClosed — 운영자가 «배포 뒤 사라져도 된다» 고 그룹 id 를 하나하나 적은 HOLD 그룹(이미 stale·unsafe).
 * 이유 코드로 자동 면제하지 않는다: --legacy-root 를 잘못 주면 모든 그룹이 «이전 matcher 로도 stale» 로 보여
 * 준비 완료로 착각하게 되기 때문이다.
 */
function summarizePlans(plans, opts) {
  const accepted = new Set(list(opts && opts.acceptFailClosed ? Array.from(opts.acceptFailClosed) : []).map(String));
  const out = { groups: plans.length, byVerdict: {}, byReason: {}, servedAfterDeploy: 0, failClosedAfterDeploy: 0, acceptedFailClosed: 0, needsStage: 0 };
  plans.forEach(p => {
    out.byVerdict[p.verdict] = (out.byVerdict[p.verdict] || 0) + 1;
    p.reasonCodes.forEach(r => { out.byReason[r] = (out.byReason[r] || 0) + 1; });
    if (p.verdict === VERDICT.TRANSITION) out.needsStage++;
    if (p.afterDeploy === 'SERVED') out.servedAfterDeploy++;
    if (p.afterDeploy === 'FAIL_CLOSED') {
      if (accepted.has(String(p.groupId))) out.acceptedFailClosed++;
      else out.failClosedAfterDeploy++;
    }
  });
  // 배포해도 되는가 — 모든 ACTIVE 그룹이 이미 지금 matcher 로 맞거나 next 자리가 STAGE 돼 있어야 한다.
  out.readyToDeploy = out.needsStage === 0 && out.failClosedAfterDeploy === 0;
  return out;
}

module.exports = { VERDICT, identityDrift, planGroupTransition, summarizePlans, planHashOf };
