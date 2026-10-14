#!/usr/bin/env node
'use strict';
/*
 * Canonical matcher transition — 외부 호출 0회, DB 0회.
 *
 *   node scripts/test-canonical-transition.js
 *
 * 지키는 것
 *   A. 운영 ACTIVE 그룹(HyperX 16-AH1075TX, 이전 matcher 로 승격)을 새 matcher 로 전부 재검증해 TRANSITION 으로 판정한다
 *   B. 관문 — 이전 matcher 불일치(제목 변화) · 재검증 실패 · 색 정책 · 등급 · 강한 식별자 · 키 충돌 · 판매처 · 식별 변화는 HOLD
 *   C. 식별 변화 판정 — 표현만 바뀐 것과 값이 바뀐 것을 가른다
 *   D. 소비 연속성 — 배포 → STAGE → FINALIZE → REVERT 각 단계에서 가격비교가 끊기지 않고, stale/unsafe 는 fail-closed
 *   E. 워커 — dry-run 쓰기 0, 쓰기 관문, STAGE · FINALIZE 가 계획 그대로의 RPC 만 부른다
 *   F. SQL — additive · compare-and-set · STAGE 는 기존 자리를 건드리지 않는다 · service_role 전용 · 감사 불변
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const OI = require('../api/_offeridentity');
const P = require('../api/_identitypromotion');
const C = require('../api/_canonicalconsumer');
// 뮤테이션 검사(scripts/test-canonical-transition-mutations.js)가 약하게 만든 사본을 끼운다.
const T = require(process.env.CANONICAL_TRANSITION_MODULE || '../api/_canonicaltransition');
const W = require('./run-canonical-transition');
const Model = require('./fixtures/canonical-transition-model');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
const clone = v => JSON.parse(JSON.stringify(v));
const nowIso = new Date().toISOString();

/* ── 운영에서 그대로 옮긴 ACTIVE 그룹 (2026-10-13 승격, 이전 matcher). 제목은 이미 다른 테스트가 쓰는 표기다. ── */
const HYPERX = 'HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 2.5K 240Hz 고사양 게이밍 노트북';
const OLD_KEY = 'd8ef963465eef90d2c91db01d9588f9abd6a78ff6b427f1e09838b8a446a53e0';
const NEW_KEY = 'c926abe10082aebc8f747e117f9661ed0a473697e2d13d8e2fcb304eadfc2f6e';
const PROD_SNAPSHOT = {
  year: '', brand: '', flags: [], gtins: [], model: '', specs: { g: ['32'], k: ['2.5'], hz: ['240'] },
  words: ['hyperx', 'v:max', '게이밍', '고사양', '오멘'], bundle: 'none', colors: [], memory: [], region: '', anchors: [],
  storage: ['1024gb'], included: [], quantity: null, variants: [], accessory: false, condition: 'unstated', substitute: false,
  deviceClass: 'laptop', modelNumbers: ['16ah1075tx', 'rtx5070ti', 'u7270hxplus'], accessoryType: '', conditionStates: [],
  transactionType: 'purchase'
};
const PROD_IDENTITY = {
  tier: 'A', specs: { g: ['32'], k: ['2.5'], hz: ['240'] }, bundle: 'none', storage: ['1024gb'], deviceClass: 'laptop',
  familyWords: ['hyperx', 'v:max', '게이밍', '고사양', '오멘'], modelNumbers: ['16ah1075tx', 'rtx5070ti', 'u7270hxplus'],
  transactionType: 'purchase', strongIdentifier: { type: 'manufacturer_model_number', value: '16ah1075tx' }
};
const LOTTE = '5270e8af7873b4b9c4d4e75cf31ae62e4a3f1d7e4be3936c4d95dc7de8ae9f4a';
const HMALL = '5f6cd0192af9a21b26db684e1d5e0da9f3c275bcd9ff7a4a2284eef0e310eec8';

function productionState(opts = {}) {
  const titles = opts.titles || [HYPERX, HYPERX];
  const products = [
    { id: 1, product_id: LOTTE, mall: 'ADPICK', mall_label: '롯데홈쇼핑', title: titles[0], lprice: 5884990, vendor_item_id: '',
      link: 'https://biz.adpick.co.kr/preview/lotte-offer?fixture=1', image: '', keyword: 'canonical', collected_at: nowIso },
    { id: 2, product_id: HMALL, mall: 'ADPICK', mall_label: 'Hmall', title: titles[1], lprice: 6206000, vendor_item_id: '',
      link: 'https://biz.adpick.co.kr/preview/hmall-offer?fixture=1', image: '', keyword: 'canonical', collected_at: nowIso }
  ];
  const groups = [Object.assign({
    id: 1, canonical_key: OLD_KEY, status: 'ACTIVE', identity: clone(PROD_IDENTITY), confidence_tier: 'A',
    promotion_policy_version: 'promotion_v1', matcher_id: 'offer_identity_v1', matcher_version: 'ea81771507da83c8d1733003c3582e575304ff3c',
    approval_source: 'AUTO_PROMOTION'
  }, opts.group || {})];
  const members = [
    { id: 1, group_id: 1, product_id: LOTTE, source_mall: 'ADPICK', mall: 'ADPICK/롯데홈쇼핑', vendor_item_id: '',
      offer_key: `ADPICK|${LOTTE}`, identity_snapshot: clone(PROD_SNAPSHOT) },
    { id: 2, group_id: 1, product_id: HMALL, source_mall: 'ADPICK', mall: 'ADPICK/Hmall', vendor_item_id: '',
      offer_key: `ADPICK|${HMALL}`, identity_snapshot: clone(PROD_SNAPSHOT) }
  ];
  return { canonical_product_groups: groups, canonical_product_members: members, products: opts.extraProducts ? products.concat(opts.extraProducts) : products };
}

/*
 * 이전 matcher 대역 — «이전 matcher 는 제목이 승격 때와 같으면 저장값을 정확히 재현한다» 를 모델로 둔다.
 * 실제 이전 코드로 재현되는지는 운영 dry-run(--legacy-root = 운영 main)에서 확인했다(reports/canonical-matcher-transition-plan-2026-10-14.md).
 */
function legacyFor(promotedTitles) {
  return {
    snapshot: (row, member) => (promotedTitles.get(member.offer_key) === row.title ? clone(PROD_SNAPSHOT) : { changed: row.title }),
    key: (rows, members) => (members.every((m, i) => promotedTitles.get(m.offer_key) === rows[i].title) ? OLD_KEY : 'changed')
  };
}
const promoted = new Map([[`ADPICK|${LOTTE}`, HYPERX], [`ADPICK|${HMALL}`, HYPERX]]);

function planFor(state, extra = {}) {
  const group = state.canonical_product_groups[0];
  const members = state.canonical_product_members.filter(m => m.group_id === group.id);
  const rowsByKey = new Map(state.products.map(r => [`${r.mall}|${r.product_id}`, r]));
  return T.planGroupTransition(Object.assign({ group, members, rowsByKey, legacy: legacyFor(promoted), matcherVersion: 'matcher-v2-test' }, extra));
}

function fakeDb(tables) {
  const writes = [];
  return {
    tables, writes,
    from(table) {
      const filters = [];
      let max = Infinity;
      const q = {
        select() { return q; },
        in(col, values) { filters.push(row => values.map(String).includes(String(row[col]))); return q; },
        eq(col, value) { filters.push(row => String(row[col]) === String(value)); return q; },
        gt(col, value) { filters.push(row => Number(row[col]) > Number(value)); return q; },
        order() { return q; },
        limit(n) { max = n; return q; },
        then(resolve, reject) {
          const data = (tables[table] || []).filter(row => filters.every(test => test(row))).slice(0, max);
          return Promise.resolve({ data: clone(data), error: null }).then(resolve, reject);
        }
      };
      return q;
    },
    async rpc(fn, params) {
      writes.push({ fn, params: clone(params) });
      return { data: Model.RPC[fn](tables, params), error: null };
    }
  };
}

const consumerOpts = (db, extra = {}) => Object.assign({
  db, config: { enabled: true, percent: 100, allowlist: new Set() },
  attachTrust: async rows => rows.forEach(row => { row.trust = { level: 'high', reasons: [] }; })
}, extra);
const inputsOf = tables => tables.products.slice(0, 2).map(row => ({
  productId: row.product_id, mall: row.mall, mallId: row.mall, vendorItemId: row.vendor_item_id,
  title: row.title, lprice: row.lprice, link: row.link, image: row.image, mallLabel: row.mall_label
}));
const serve = async (tables, extra) => C.resolveGroups(inputsOf(tables), consumerOpts(fakeDb(tables), extra));

(async () => {
  /* ==================================================================
   *  A. 운영 ACTIVE 그룹
   * ================================================================== */
  console.log('=== A. 운영 ACTIVE 그룹 (HyperX 16-AH1075TX) ===');
  {
    const state = productionState();
    const plan = planFor(state);
    ok(plan.verdict === 'TRANSITION', '이전 matcher 로 재현되고 새 matcher 로 전부 MATCH → TRANSITION', JSON.stringify(plan.reasonCodes));
    ok(plan.currentKey === OLD_KEY && plan.nextKey === NEW_KEY, `키 ${OLD_KEY.slice(0, 8)}… → ${NEW_KEY.slice(0, 8)}…`, `${plan.currentKey} → ${plan.nextKey}`);
    ok(plan.rolloutKey === OLD_KEY, 'rollout 은 처음 키로 — 노출 범위가 바뀌지 않는다');
    ok(plan.drift && !plan.drift.material.length && ['modelNumbers', 'specs', 'memory', 'cpu', 'gpu'].every(f => plan.drift.changes.includes(f)),
      '값 변화 없음 · 표현 변화만(칩 코드 → 부품, 32G → 메모리)', JSON.stringify(plan.drift));
    ok(plan.nextIdentity.strongIdentifier.value === '16ah1075tx' && plan.nextTier === 'A', '강한 식별자 16ah1075tx · 등급 A 그대로');
    const s = plan.stage;
    ok(s.p_expected_canonical_key === OLD_KEY && s.p_next_canonical_key === NEW_KEY && s.p_plan_hash === plan.planHash
      && s.p_members.length === 2 && s.p_members.every(m => m.title === HYPERX && JSON.stringify(m.identity_snapshot) === JSON.stringify(PROD_SNAPSHOT)),
    'STAGE 페이로드: 기대 키 · 다음 키 · 계획 해시 · 구성원(제목·저장 스냅숏)');
    const parsed = state.canonical_product_members.map((m, i) => P.snapshotOf(C._internal.parseCurrent(state.products[i], m)));
    ok(s.p_members.every((m, i) => P.stableJson(m.next_identity_snapshot) === P.stableJson(parsed[i])), 'next 스냅숏 = 새 소비자가 계산할 스냅숏 그대로');
    ok(s.p_members.every(m => m.next_identity_snapshot.cpu && m.next_identity_snapshot.gpu), 'next 스냅숏은 CPU·GPU 를 담는다');
    ok(!('stage' in planFor(productionState(), { legacy: null })), '이전 matcher 검증 없이는 STAGE 페이로드를 만들지 않는다');
    const again = planFor(productionState());
    ok(again.planHash === plan.planHash, '같은 입력이면 같은 계획 해시 (멱등 STAGE 의 근거)');
  }

  /* ==================================================================
   *  B. 관문 — 하나라도 아니면 HOLD (배포 뒤 fail-closed)
   * ================================================================== */
  console.log('=== B. 관문 ===');
  {
    const holdWith = (plan, code, name) => ok(plan.verdict === 'HOLD' && plan.reasonCodes.includes(code) && plan.afterDeploy === 'FAIL_CLOSED', name, JSON.stringify(plan.reasonCodes));
    holdWith(planFor(productionState(), { legacy: null }), 'HOLD_PREVIOUS_MATCHER_UNVERIFIED', '이전 matcher 검증 없음 → HOLD');

    const edited = HYPERX.replace('RTX5070Ti', 'RTX5070');
    holdWith(planFor(productionState({ titles: [HYPERX, edited] })), 'HOLD_STALE_UNDER_PREVIOUS_MATCHER',
      '승격 뒤 제목이 바뀐 그룹(이미 stale)을 새 식별로 살려내지 않는다');

    // 이전 matcher 는 차이를 못 봤지만(대역이 저장값을 재현한다고 가정) 새 matcher 는 GPU 가 다르다고 본다 — 전환 금지.
    const gpuState = productionState({ titles: [HYPERX, edited] });
    const lenient = { snapshot: () => clone(PROD_SNAPSHOT), key: () => OLD_KEY };
    const gpuPlan = planFor(gpuState, { legacy: lenient });
    holdWith(gpuPlan, 'HOLD_REVALIDATION_FAILED', '새 matcher 재검증에서 한 쌍이라도 MATCH 가 아니면 HOLD');
    ok(gpuPlan.reasonCodes.includes('REJECT_GPU_CONFLICT') && gpuPlan.revalidation === 'SUSPENDED', '그 이유(GPU 충돌)를 남긴다', JSON.stringify(gpuPlan.reasonCodes));

    holdWith(planFor(productionState(), { requireCatalog: true }), 'HOLD_CATALOG_CONTEXT_MISSING', 'STAGE 에는 카탈로그 문맥 재검증이 필수');

    // 색 정책 — 구성원끼리만 보면 MATCH 인 «양쪽 색 미표기» G304 쌍도, 카탈로그에 색이 여럿 관측되면 전환하지 않는다.
    const g304 = ['로지텍 G304 LIGHTSPEED 무선 게이밍 마우스', '로지텍코리아 G304 LIGHTSPEED 무선 게이밍 마우스'];
    const mouseState = {
      canonical_product_groups: [{ id: 7, canonical_key: 'mouse-old', status: 'ACTIVE', confidence_tier: 'A',
        identity: { tier: 'A', strongIdentifier: { type: 'manufacturer_model_number', value: 'g304' } } }],
      canonical_product_members: [
        { group_id: 7, product_id: 'm1', source_mall: 'ADPICK', mall: 'ADPICK/SSG', vendor_item_id: '', offer_key: 'ADPICK|m1', identity_snapshot: { legacy: 1 } },
        { group_id: 7, product_id: 'm2', source_mall: 'ADPICK', mall: 'ADPICK/Hmall', vendor_item_id: '', offer_key: 'ADPICK|m2', identity_snapshot: { legacy: 2 } }],
      products: [
        { product_id: 'm1', mall: 'ADPICK', mall_label: 'SSG', title: g304[0], lprice: 59900, vendor_item_id: '' },
        { product_id: 'm2', mall: 'ADPICK', mall_label: 'Hmall', title: g304[1], lprice: 59900, vendor_item_id: '' }]
    };
    const mouseLegacy = { snapshot: (row, m) => m.identity_snapshot, key: () => 'mouse-old' };
    const colored = ['로지텍 G304 LIGHTSPEED 무선 게이밍 마우스 블랙', '로지텍 G304 LIGHTSPEED 무선 게이밍 마우스 화이트']
      .map((t, i) => OI.parseOffer({ key: `c${i}`, title: t, mall: 'ADPICK/GS SHOP' }));
    const catalogContext = OI.contextFactory(colored.concat(mouseState.products.map(r => OI.parseOffer({ key: r.product_id, title: r.title, mall: r.mall_label }))));
    // 이전 식별은 «새 matcher 가 구성원끼리 보고 만드는 식별» 과 같다고 둔다 — 식별 변화가 없어도 색 정책이 막는지를 본다.
    const mouseIds = mouseState.canonical_product_members.map((m, i) => C._internal.parseCurrent(mouseState.products[i], m));
    const mouseCheck = P.evaluateExistingMembers(mouseIds, OI.contextFactory(mouseIds));
    const mouseTier = P.effectiveTier(mouseIds, mouseCheck.pairs).tier;
    mouseState.canonical_product_groups[0].identity = P.canonicalIdentity(mouseIds, P.commonStrongIdentifier(mouseIds), mouseTier);
    mouseState.canonical_product_groups[0].confidence_tier = mouseTier;
    const mouseBase = { group: mouseState.canonical_product_groups[0], members: mouseState.canonical_product_members,
      rowsByKey: new Map(mouseState.products.map(r => [`${r.mall}|${r.product_id}`, r])), legacy: mouseLegacy, matcherVersion: 'v2' };
    const memberOnly = T.planGroupTransition(mouseBase);
    ok(memberOnly.verdict === 'TRANSITION', '구성원 문맥만 보면 MATCH (그래서 카탈로그 문맥이 필요하다)', JSON.stringify(memberOnly.reasonCodes));
    const withCatalog = T.planGroupTransition(Object.assign({}, mouseBase, { catalogContext }));
    holdWith(withCatalog, 'HOLD_CATALOG_REVALIDATION_FAILED', '카탈로그에 색이 여럿인 모델의 «양쪽 색 미표기» 그룹은 전환하지 않는다 (#141 색 정책)');
    ok(withCatalog.reasonCodes.includes('HOLD_MISSING_COLOR'), '그 이유는 색 모름', JSON.stringify(withCatalog.reasonCodes));

    holdWith(planFor(productionState({ group: { confidence_tier: 'B', identity: Object.assign(clone(PROD_IDENTITY), { tier: 'B' }) } }),
      { legacy: { snapshot: () => clone(PROD_SNAPSHOT), key: () => OLD_KEY } }), 'HOLD_TIER_CHANGED', '등급이 바뀌면 HOLD');
    holdWith(planFor(productionState({ group: { identity: Object.assign(clone(PROD_IDENTITY), { strongIdentifier: { type: 'manufacturer_model_number', value: '16ah1073tx' } }) } }),
      { legacy: { snapshot: () => clone(PROD_SNAPSHOT), key: () => OLD_KEY } }), 'HOLD_STRONG_IDENTIFIER_CHANGED', '강한 식별자 값이 바뀌면 HOLD');
    holdWith(planFor(productionState(), { takenKeys: new Set([NEW_KEY]) }), 'HOLD_CANONICAL_KEY_COLLISION', '다음 키가 다른 그룹의 키와 겹치면 HOLD');

    const sameMall = productionState();
    sameMall.canonical_product_members.forEach(m => { m.mall = 'ADPICK/Hmall'; });
    holdWith(planFor(sameMall), 'HOLD_NOT_CROSS_MERCHANT', '판매처가 한 곳뿐이면 HOLD');

    holdWith(planFor(productionState({ group: { identity: Object.assign(clone(PROD_IDENTITY), { colors: ['black'] }) } }),
      { legacy: { snapshot: () => clone(PROD_SNAPSHOT), key: () => OLD_KEY } }), 'HOLD_IDENTITY_DRIFT', '값(색)이 바뀌는 전환은 HOLD');

    const missing = productionState();
    missing.products = missing.products.slice(0, 1);
    holdWith(planFor(missing), 'HOLD_PRODUCT_ROW_MISSING', '구성원 상품이 없으면 HOLD');
    const vendor = productionState();
    vendor.products[0].vendor_item_id = 'v9';
    holdWith(planFor(vendor), 'HOLD_VENDOR_OPTION_CHANGED', '옵션이 바뀌면 HOLD');
    holdWith(planFor(productionState({ group: { status: 'SUSPENDED' } })), 'HOLD_GROUP_NOT_ACTIVE', 'ACTIVE 가 아니면 HOLD');
    holdWith(planFor(productionState(), { matcherVersion: '' }), 'HOLD_MATCHER_VERSION_MISSING', 'matcher 버전을 모르면 HOLD');

    // 지금 matcher 로 이미 맞는 그룹 · 이미 STAGE 된 그룹
    const current = productionState();
    current.canonical_product_members.forEach((m, i) => { m.identity_snapshot = P.snapshotOf(C._internal.parseCurrent(current.products[i], m)); });
    current.canonical_product_groups[0].canonical_key = NEW_KEY;
    current.canonical_product_groups[0].identity = planFor(productionState()).nextIdentity;
    ok(planFor(current).verdict === 'ALREADY_CURRENT', '지금 matcher 로 이미 맞으면 ALREADY_CURRENT (할 일 없음)');
    const staged = productionState();
    Model.stage(staged, Object.assign({}, planFor(staged).stage, { p_operator: 't' }));
    const stagedPlan = planFor(staged);
    ok(stagedPlan.verdict === 'ALREADY_STAGED' && stagedPlan.afterDeploy === 'SERVED' && stagedPlan.nextKey === NEW_KEY, 'STAGE 뒤에는 ALREADY_STAGED (배포해도 끊기지 않음)');
    staged.products[1].title = edited;
    holdWith(planFor(staged), 'HOLD_STAGED_SNAPSHOT_STALE', 'STAGE 뒤 제목이 바뀌면 HOLD (staging 값을 믿지 않는다)');

    // 배포 준비 판정 — 모든 ACTIVE 그룹이 ALREADY_CURRENT/ALREADY_STAGED 일 때만
    const sum = plans => T.summarizePlans(plans).readyToDeploy;
    ok(sum([stagedPlan]) === true && sum([planFor(current)]) === true, '배포 준비: 이미 맞거나 STAGE 된 그룹뿐이면 true');
    ok(sum([stagedPlan, planFor(productionState())]) === false, '배포 준비: STAGE 할 그룹이 남으면 false');
    ok(sum([stagedPlan, planFor(productionState(), { legacy: null })]) === false, '배포 준비: HOLD(배포 뒤 fail-closed) 그룹이 있으면 false');
    const holdPlan = Object.assign(planFor(productionState(), { legacy: null }), { groupId: 5 });
    ok(T.summarizePlans([stagedPlan, holdPlan], { acceptFailClosed: ['5'] }).readyToDeploy === true
      && T.summarizePlans([stagedPlan, holdPlan], { acceptFailClosed: ['6'] }).readyToDeploy === false,
    '배포 준비: 운영자가 id 로 적은 HOLD 그룹만 면제 (이유 코드로 자동 면제하지 않는다)');
    ok(T.summarizePlans([holdPlan, planFor(productionState())], { acceptFailClosed: ['5'] }).readyToDeploy === false, '면제해도 STAGE 할 그룹이 남으면 false');
    ok(W.parseArgs(['--check-ready', '--accept-fail-closed', '5, 9']).acceptFailClosed.join() === '5,9' && W.parseArgs([]).acceptFailClosed.length === 0,
      'CLI --accept-fail-closed 는 쉼표 목록, 기본은 비어 있다');
  }

  /* ==================================================================
   *  C. 식별 변화 판정
   * ================================================================== */
  console.log('=== C. 식별 변화 판정 ===');
  {
    const prev = clone(PROD_IDENTITY);
    const next = planFor(productionState()).nextIdentity;
    ok(T.identityDrift(prev, next).material.length === 0, 'HyperX: 표현만 바뀜');
    const drift = (patch, field, name) => ok(T.identityDrift(prev, Object.assign(clone(next), patch)).material.includes(field), name);
    drift({ modelNumbers: ['16ah1075tx', 'newcode123'] }, 'modelNumbers', '새 모델번호가 생기면 값 변화');
    drift({ storage: ['512gb'] }, 'storage', '저장 용량 값이 바뀌면 값 변화');
    drift({ memory: ['16gb'] }, 'memory', '메모리 값이 근거 없이 생기면 값 변화');
    drift({ familyWords: ['hyperx', 'v:max', '게이밍', '고사양', '오멘', '빅터스'] }, 'familyWords', '새 계열 낱말이 생기면 값 변화');
    drift({ specs: { k: ['2.5'], hz: ['144'] } }, 'specs', '규격 값이 바뀌면 값 변화');
    drift({ transactionType: 'rental' }, 'transactionType', '구매 → 렌탈은 값 변화');
    ok(T.identityDrift(Object.assign(clone(prev), { modelNumbers: ['16ah1075tx', 'abc12345'] }), next).material.includes('modelNumbers'),
      '칩이 아닌 모델번호가 사라지면 값 변화');
    ok(T.identityDrift(Object.assign(clone(prev), { brand: 'samsung' }), Object.assign(clone(next), { brand: 'hp' })).material.includes('brand'),
      '브랜드가 다른 브랜드로 바뀌면 값 변화');
    ok(!T.identityDrift(prev, Object.assign(clone(next), { brand: 'hp' })).material.includes('brand'), '브랜드가 없다가 생기는 것은 표현 변화');
  }

  /* ==================================================================
   *  D. 소비 연속성 — 단계마다
   * ================================================================== */
  console.log('=== D. 소비 연속성 ===');
  {
    const tables = productionState();
    const served = r => r.groups.length === 1 && r.groups[0].offers.length === 2;

    // 0) 새 코드 + 아직 STAGE 안 함 → fail-closed. 그래서 «STAGE 먼저, 배포는 그다음» 이다.
    const before = await serve(tables);
    ok(before.groups.length === 0 && before.stats.stale === 1, '새 소비자 + STAGE 전: 그룹은 fail-closed (배포 순서가 중요한 이유)', JSON.stringify(before.stats));

    // 1) STAGE — 기존 자리는 그대로다(지금 운영 코드는 같은 값을 읽는다).
    const plan = planFor(tables);
    const primaryBefore = clone({ g: tables.canonical_product_groups[0], m: tables.canonical_product_members });
    ok(Model.stage(tables, Object.assign({}, plan.stage, { p_operator: 'ops' })).status === 'STAGED', 'STAGE');
    const g = tables.canonical_product_groups[0];
    ok(g.canonical_key === OLD_KEY && P.stableJson(g.identity) === P.stableJson(primaryBefore.g.identity)
      && tables.canonical_product_members.every((m, i) => P.stableJson(m.identity_snapshot) === P.stableJson(primaryBefore.m[i].identity_snapshot)),
    'STAGE 는 canonical_key · identity · identity_snapshot 을 바꾸지 않는다 (옛 코드 소비 그대로)');

    // 2) 배포(새 소비자) — next 자리로 검증해 보여 준다.
    const during = await serve(tables);
    ok(served(during) && during.groups[0].identityVersion === 'next' && during.groups[0].key === NEW_KEY && during.stats.transition === 1,
      '배포 직후: next 자리로 검증해 가격비교를 계속 보여 준다', JSON.stringify(during.stats));
    ok(during.groups[0].offers[0].price === 5884990 && during.groups[0].offers[0].mallLabel === '롯데홈쇼핑', '최저가 판매처·가격 그대로 (롯데홈쇼핑 5,884,990)');

    // 3) FINALIZE — 기존 자리로 옮긴다.
    ok(Model.finalize(tables, { p_group_id: 1, p_expected_next_canonical_key: NEW_KEY, p_expected_plan_hash: plan.planHash, p_operator: 'ops' }).status === 'FINALIZED', 'FINALIZE');
    ok(g.canonical_key === NEW_KEY && g.previous_canonical_key === OLD_KEY && g.rollout_key === OLD_KEY && !g.next_canonical_key, 'FINALIZE 뒤: 새 키 · 이전 키 보존 · rollout 키 고정');
    const after = await serve(tables);
    ok(served(after) && after.groups[0].identityVersion === 'primary' && after.groups[0].key === NEW_KEY, 'FINALIZE 뒤: 기존 자리로 끊김 없이');

    // 4) rollout — 처음 키로 정한다. 허용 목록이 옛 키면 단계 내내 보이고, 새 키만으로는 넓어지지 않는다.
    const allowOld = { config: { enabled: true, percent: 100, allowlist: new Set([OLD_KEY]) } };
    ok(served(await serve(tables, allowOld)), 'FINALIZE 뒤에도 옛 키 허용 목록으로 계속 노출 (끊김 없음)');
    ok((await serve(tables, { config: { enabled: true, percent: 100, allowlist: new Set([NEW_KEY]) } })).groups.length === 0,
      '새 키를 허용 목록에 넣는다고 노출이 넓어지지 않는다 (rollout 은 처음 키)');

    // 5) REVERT — 옛 코드(기존 자리)와 새 코드(next 자리) 모두 읽힌다.
    ok(Model.revert(tables, { p_group_id: 1, p_expected_canonical_key: NEW_KEY, p_operator: 'ops' }).status === 'REVERTED', 'REVERT');
    ok(g.canonical_key === OLD_KEY && g.next_canonical_key === NEW_KEY
      && tables.canonical_product_members.every(m => P.stableJson(m.identity_snapshot) === P.stableJson(PROD_SNAPSHOT)), 'REVERT 뒤 기존 자리는 다시 이전 matcher 값');
    const reverted = await serve(tables);
    ok(served(reverted) && reverted.groups[0].identityVersion === 'next', 'REVERT 뒤에도 새 소비자는 끊김 없이 (next 자리)');

    // 6) ABORT — next 를 지우면 새 소비자는 fail-closed (이전 matcher 값은 새 파서와 다르다).
    ok(Model.abort(tables, { p_group_id: 1, p_expected_next_canonical_key: NEW_KEY, p_operator: 'ops' }).status === 'ABORTED', 'ABORT');
    ok((await serve(tables)).groups.length === 0, 'ABORT 뒤 새 소비자는 fail-closed');
  }
  {
    // unsafe — STAGE 뒤 판매자가 제목을 바꿨다 / next 키가 틀렸다 / 구성원이 서로 다른 자리와 맞는다
    const tables = productionState();
    const plan = planFor(tables);
    Model.stage(tables, Object.assign({}, plan.stage, { p_operator: 'ops' }));
    tables.products[1].title = HYPERX.replace('RTX5070Ti', 'RTX4060');
    ok((await serve(tables)).groups.length === 0, 'STAGE 뒤 제목이 바뀌면 fail-closed');

    const wrongKey = productionState();
    Model.stage(wrongKey, Object.assign({}, planFor(wrongKey).stage, { p_operator: 'ops' }));
    wrongKey.canonical_product_groups[0].next_canonical_key = 'f'.repeat(64);
    ok((await serve(wrongKey)).groups.length === 0, 'next 키가 계산과 다르면 fail-closed');

    const mixed = productionState();
    Model.stage(mixed, Object.assign({}, planFor(mixed).stage, { p_operator: 'ops' }));
    mixed.canonical_product_members[0].identity_snapshot = clone(mixed.canonical_product_members[0].next_identity_snapshot);
    mixed.canonical_product_members[0].next_identity_snapshot = null;
    ok((await serve(mixed)).groups.length === 0, '구성원이 서로 다른 자리와 맞으면(섞이면) fail-closed');

    const conflictStage = productionState();
    const p2 = planFor(conflictStage);
    conflictStage.products[0].title = 'changed after planning';
    ok(Model.stage(conflictStage, Object.assign({}, p2.stage, { p_operator: 'ops' })).status === 'STALE_PRODUCT_CHANGED', 'STAGE 는 계획 뒤 제목이 바뀌면 거절 (TOCTOU)');
    ok(!conflictStage.canonical_product_groups[0].next_canonical_key, '거절되면 아무것도 쓰지 않는다');
  }

  /* ==================================================================
   *  E. 워커
   * ================================================================== */
  console.log('=== E. 워커 ===');
  {
    const tables = productionState();
    const db = fakeDb(tables);
    const legacy = legacyFor(promoted);
    const dry = await W.run(db, { mode: 'plan', legacy, matcherVersion: 'v2', catalog: true });
    ok(dry.writes === 0 && db.writes.length === 0, 'dry-run: 쓰기 0');
    ok(dry.summary.byVerdict.TRANSITION === 1 && dry.summary.readyToDeploy === false, 'dry-run: TRANSITION 1 · 아직 배포하면 안 됨', JSON.stringify(dry.summary));
    ok(dry.plans.every(p => !JSON.stringify(p).includes(HYPERX)), '표준출력용 요약에는 상품명이 없다');
    const ready0 = await W.run(db, { mode: 'check-ready', legacy, matcherVersion: 'v2' });
    ok(ready0.summary.readyToDeploy === false && db.writes.length === 0, 'check-ready: STAGE 전에는 배포 준비 안 됨');

    const refusals = [
      [{ mode: 'stage', legacy, matcherVersion: 'v2', operator: 'ops', env: { IDENTITY_TRANSITION_ENABLED: 'true' } }, 'WRITE_FLAG_REQUIRED'],
      [{ mode: 'stage', legacy, matcherVersion: 'v2', operator: 'ops', write: true, env: {} }, 'IDENTITY_TRANSITION_ENABLED_REQUIRED'],
      [{ mode: 'stage', legacy, matcherVersion: 'v2', write: true, env: { IDENTITY_TRANSITION_ENABLED: 'true' } }, 'OPERATOR_REQUIRED'],
      [{ mode: 'stage', matcherVersion: 'v2', operator: 'ops', write: true, env: { IDENTITY_TRANSITION_ENABLED: 'true' } }, 'LEGACY_MATCHER_REQUIRED'],
      [{ mode: 'stage', legacy, matcherVersion: 'v2', operator: 'ops', write: true, catalog: false, env: { IDENTITY_TRANSITION_ENABLED: 'true' } }, 'CATALOG_CONTEXT_REQUIRED'],
      [{ mode: 'revert', matcherVersion: 'v2', operator: 'ops', write: true, env: { IDENTITY_TRANSITION_ENABLED: 'true' } }, 'GROUP_REQUIRED']
    ];
    for (const [o, code] of refusals) {
      const r = await W.run(db, o);
      ok(r.refused === code && db.writes.length === 0, `쓰기 관문: ${code}`);
    }

    const stage = await W.run(db, { mode: 'stage', legacy, matcherVersion: 'v2', operator: 'ops', write: true, env: { IDENTITY_TRANSITION_ENABLED: 'true' } });
    ok(db.writes.length === 1 && db.writes[0].fn === 'canonical_identity_transition_stage' && stage.rpc[0].status === 'STAGED', 'STAGE: RPC 한 번, 계획 그대로');
    ok(db.writes[0].params.p_operator === 'ops' && db.writes[0].params.p_expected_canonical_key === OLD_KEY && db.writes[0].params.p_next_canonical_key === NEW_KEY, 'STAGE 페이로드에 운영자 · 기대 키 · 다음 키');
    const ready1 = await W.run(db, { mode: 'check-ready', legacy, matcherVersion: 'v2' });
    ok(ready1.summary.readyToDeploy === true && ready1.summary.byVerdict.ALREADY_STAGED === 1, 'check-ready: STAGE 뒤 배포 준비 완료', JSON.stringify(ready1.summary));
    const again = await W.run(db, { mode: 'stage', legacy, matcherVersion: 'v2', operator: 'ops', write: true, env: { IDENTITY_TRANSITION_ENABLED: 'true' } });
    ok(again.writes === 0, 'STAGE 를 다시 돌려도 이미 STAGE 된 그룹은 건너뛴다');

    const fin = await W.run(db, { mode: 'finalize', matcherVersion: 'v2', operator: 'ops', write: true, env: { IDENTITY_TRANSITION_ENABLED: 'true' } });
    ok(fin.rpc.length === 1 && fin.rpc[0].status === 'FINALIZED' && tables.canonical_product_groups[0].canonical_key === NEW_KEY, 'FINALIZE: next 가 지금 matcher 와 맞는 그룹만, 계획 해시로');
    const fin2 = await W.run(db, { mode: 'finalize', matcherVersion: 'v2', operator: 'ops', write: true, env: { IDENTITY_TRANSITION_ENABLED: 'true' } });
    ok(fin2.writes === 0, 'FINALIZE 를 다시 돌려도 아무것도 하지 않는다');
    ok(W.parseArgs(['--stage', '--write', '--operator', 'me', '--legacy-root', '/tmp/x']).mode === 'stage' && W.parseArgs([]).mode === 'plan', 'CLI 기본은 dry-run(plan)');
    ok(!W.transitionEnabled({}) && W.transitionEnabled({ IDENTITY_TRANSITION_ENABLED: 'true' }) && !W.transitionEnabled({ IDENTITY_TRANSITION_ENABLED: 'yes' }), '쓰기 env 는 true/1 만');
  }

  /* ==================================================================
   *  F. SQL
   * ================================================================== */
  console.log('=== F. SQL ===');
  {
    const raw = fs.readFileSync(path.join(ROOT, 'supabase', '2026-10-14-identity-matcher-transition.sql'), 'utf8');
    const sql = raw.replace(/--[^\n]*/g, '');
    ok(!/\b(drop|truncate)\b/i.test(sql), 'DROP · TRUNCATE 없음');
    ok(!/\b(update|insert\s+into|delete\s+from)\s+public\.(products|price_history)\b/i.test(sql), 'products · price_history 를 쓰지 않는다');
    ok((sql.match(/add column(?! if not exists)/gi) || []).length === 0 && /create table if not exists public\.canonical_identity_transitions/i.test(sql),
      '컬럼·표 추가는 모두 IF NOT EXISTS (재실행 안전)');
    const fn = name => { const m = sql.match(new RegExp(`function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i')); return m ? m[0] : ''; };
    const stage = fn('canonical_identity_transition_stage');
    ok(/for update/i.test(stage) && /for share/i.test(stage) && /canonical_key <> p_expected_canonical_key/i.test(stage),
      'STAGE: 그룹 for update · 상품 for share · 기대 키 compare-and-set');
    ok(/identity_snapshot is distinct from v_member->'identity_snapshot'/i.test(stage) && /title is distinct from v_member->>'title'/i.test(stage),
      'STAGE: 저장 스냅숏 · 상품 제목이 계획과 같아야 쓴다');
    ok(/CONFLICT_CANONICAL_KEY_EXISTS/.test(stage), 'STAGE: 다음 키 충돌 거절');
    const stageSets = (stage.match(/\bset\b[\s\S]*?\bwhere\b/gi) || []).join(' ');
    ok(!/\b(canonical_key|identity|identity_snapshot|confidence_tier|status)\s*=/i.test(stageSets.replace(/next_\w+\s*=|updated_at\s*=/gi, '')),
      'STAGE 는 next_* 와 updated_at 만 바꾼다 (기존 자리 그대로 — 지금 운영 코드 무영향)', stageSets.slice(0, 300));
    const finalize = fn('canonical_identity_transition_finalize');
    ok(/rollout_key = coalesce\(rollout_key, canonical_key\)/i.test(finalize) && /previous_canonical_key = canonical_key/i.test(finalize)
      && /canonical_key = next_canonical_key/i.test(finalize) && /identity_snapshot = next_identity_snapshot/i.test(finalize)
      && /next_plan_hash is distinct from p_expected_plan_hash/i.test(finalize), 'FINALIZE: rollout 키 고정 · 이전 값 보존 · next 로 교체 · 계획 해시 확인');
    ok(/identity_snapshot = previous_identity_snapshot/i.test(fn('canonical_identity_transition_revert')) && /next_identity_snapshot = identity_snapshot/i.test(fn('canonical_identity_transition_revert')),
      'REVERT: 이전 값을 기존 자리로, 지금 값을 next 로');
    ok(/next_identity_snapshot = null/i.test(fn('canonical_identity_transition_abort')), 'ABORT: next 만 지운다');
    const functions = ['canonical_identity_transition_stage', 'canonical_identity_transition_finalize', 'canonical_identity_transition_abort', 'canonical_identity_transition_revert'];
    ok(functions.every(f => new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated`, 'i').test(sql)
      && new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role`, 'i').test(sql)), '함수는 service_role 전용');
    ok(functions.every(f => new RegExp(`function public\\.${f}\\([\\s\\S]*?security invoker\\s+set search_path = ''`, 'i').test(sql)), '함수 search_path 고정');
    ok(/before update or delete on public\.canonical_identity_transitions/i.test(sql) && /enable row level security/i.test(sql), '감사 기록은 수정·삭제 불가 · RLS');
    ok(/canonical_product_groups_next_complete_check/.test(sql) && /canonical_product_groups_next_key_idx/.test(sql), 'next_* 는 전부 있거나 전부 없다 · next 키 유일');
    ok(/notify pgrst/i.test(sql), '스키마 캐시 갱신');
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) {
    console.log(failures.slice(0, 20).map(f => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  assert.ok(true);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
