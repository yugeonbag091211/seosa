#!/usr/bin/env node
'use strict';
/*
 * Product Identity — canonical matcher transition 워커.
 *
 *   ACTIVE canonical 그룹 ──READ──▶ api/_canonicaltransition (판정) ──▶ 계획 · (쓰기 모드에서만) RPC
 *
 * 사용법 (기본은 dry-run — 아무것도 쓰지 않는다)
 *   node scripts/run-canonical-transition.js --legacy-root <dir>                 계획만 (STAGE 대상 · HOLD 사유)
 *   node scripts/run-canonical-transition.js --check-ready                       배포해도 끊기지 않는가 (아니면 exit 1)
 *   ... --plan-out plan.json      계획 전체(구성원 제목 포함 — 저장소에 넣지 않는다)
 *   ... --no-catalog              카탈로그 전체 문맥 재검증을 건너뛴다(STAGE 는 거부된다)
 *   ... --accept-fail-closed 3,7  배포 뒤 사라져도 된다고 운영자가 확인한 HOLD 그룹 id (check-ready 가 막지 않는다)
 *
 *   IDENTITY_TRANSITION_ENABLED=true ... --stage --write --operator <id> --legacy-root <dir>
 *   IDENTITY_TRANSITION_ENABLED=true ... --finalize --write --operator <id>
 *   IDENTITY_TRANSITION_ENABLED=true ... --abort --group <id> --write --operator <id>
 *   IDENTITY_TRANSITION_ENABLED=true ... --revert --group <id> --write --operator <id>
 *
 *   <dir> = 지금 운영에 배포된(= 저장된 스냅숏을 만든) matcher 커밋을 풀어 둔 폴더:
 *           git archive <운영 커밋> | tar -x -C <dir>
 *
 * ★ dry-run · check-ready 는 SELECT 만 한다. products · price_history 는 어느 모드에서도 쓰지 않는다.
 * ★ 쓰기는 env · --write · --operator 세 가지가 모두 있어야 한다. STAGE 는 이전 matcher 검증(--legacy-root)과
 *   카탈로그 문맥 재검증이 필수다. 모든 RPC 는 compare-and-set 이라 계획과 DB 가 다르면 아무것도 바꾸지 않는다.
 * ★ 테스트는 CLI 를 거치지 않고 run(db, opts) 를 부른다 (scripts/test-canonical-transition.js).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OI = require('../api/_offeridentity');
const P = require('../api/_identitypromotion');
const Consumer = require('../api/_canonicalconsumer');
const T = require('../api/_canonicaltransition');
const { withDbRetry } = require('../api/_dberror');

const MODES = ['plan', 'check-ready', 'stage', 'finalize', 'abort', 'revert'];
const WRITE_MODES = new Set(['stage', 'finalize', 'abort', 'revert']);

function parseArgs(argv) {
  const a = argv || [];
  const flag = f => a.indexOf(f) > -1;
  const val = name => { const i = a.indexOf(name); return i > -1 && a[i + 1] && !String(a[i + 1]).startsWith('--') ? a[i + 1] : ''; };
  const mode = flag('--check-ready') ? 'check-ready' : flag('--stage') ? 'stage' : flag('--finalize') ? 'finalize'
    : flag('--abort') ? 'abort' : flag('--revert') ? 'revert' : 'plan';
  return {
    mode, write: flag('--write'), operator: val('--operator'), legacyRoot: val('--legacy-root'),
    planOut: val('--plan-out'), group: val('--group'), catalog: !flag('--no-catalog'),
    acceptFailClosed: val('--accept-fail-closed').split(',').map(s => s.trim()).filter(Boolean)
  };
}

function transitionEnabled(env) {
  return /^(true|1)$/i.test(String(((env || process.env).IDENTITY_TRANSITION_ENABLED) || '').trim());
}

function matcherVersion() {
  if (process.env.GITHUB_SHA) return String(process.env.GITHUB_SHA).slice(0, 40);
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return ''; }
}

/**
 * 이전 matcher(지금 운영 코드) — 그 커밋의 소비자 · 승격 모듈로 «저장된 스냅숏을 만든 계산» 을 그대로 다시 한다.
 * 이 계산이 저장값과 같아야만 «승격 뒤 제목이 바뀌지 않았다» 고 말할 수 있다(G3).
 */
function legacyAdapterFromRoot(root) {
  const dir = path.resolve(root);
  const C = require(path.join(dir, 'api', '_canonicalconsumer'));
  const LP = require(path.join(dir, 'api', '_identitypromotion'));
  const parse = (row, member) => C._internal.parseCurrent(row, member);
  return {
    root: dir,
    snapshot: (row, member) => LP.snapshotOf(parse(row, member)),
    key: (rows, members, group) => {
      const ids = members.map((m, i) => parse(rows[i], m));
      const identity = group.identity || {};
      return LP.canonicalKeyOf(LP.canonicalIdentity(ids, identity.strongIdentifier || null, group.confidence_tier));
    }
  };
}

function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }

async function read(q, label) {
  const r = await withDbRetry(() => q);
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  return r.data || [];
}

/** ACTIVE 그룹 · 구성원 · 구성원 상품 · (선택) 카탈로그 전체 — 전부 SELECT. */
async function loadState(db, o) {
  const allGroups = await read(db.from('canonical_product_groups').select('*'), 'canonical groups');
  const groups = allGroups.filter(g => g.status === 'ACTIVE' && (!o.group || String(g.id) === String(o.group)));
  const ids = groups.map(g => g.id);
  const members = ids.length ? await read(db.from('canonical_product_members').select('*').in('group_id', ids), 'canonical members') : [];
  const pids = [...new Set(members.map(m => String(m.product_id)))];
  const rows = [];
  for (const part of chunk(pids, 100)) {
    rows.push(...await read(db.from('products')
      .select('id,product_id,mall,mall_label,title,lprice,link,image,keyword,collected_at,vendor_item_id').in('product_id', part), 'member products'));
  }
  let catalog = null;
  if (o.catalog) {
    catalog = [];
    let after = 0;
    for (;;) {
      const page = await read(db.from('products').select('id,product_id,mall,mall_label,title,lprice,vendor_item_id')
        .gt('id', after).order('id', { ascending: true }).limit(1000), 'catalog');
      if (!page.length) break;
      catalog.push(...page);
      after = page[page.length - 1].id;
      if (page.length < 1000) break;
    }
  }
  return { allGroups, groups, members, rows, catalog };
}

/** 카탈로그 전체로 만든 문맥 — 색 계열 차원 같은 «다른 판매 글에서 관측된» 사실을 재검증에 반영한다. */
function catalogContextOf(catalog) {
  if (!catalog) return null;
  const ids = catalog.map(r => OI.parseOffer({
    key: `${r.mall}|${r.product_id}`, title: r.title, mall: r.mall_label ? `${r.mall}/${r.mall_label}` : r.mall,
    productId: r.product_id, vendorItemId: r.vendor_item_id || '', price: r.lprice
  }));
  return OI.contextFactory(ids);
}

function plansOf(state, o) {
  const rowsByKey = new Map(state.rows.map(r => [`${r.mall}|${r.product_id}`, r]));
  const membersByGroup = new Map();
  state.members.forEach(m => {
    const k = String(m.group_id);
    if (!membersByGroup.has(k)) membersByGroup.set(k, []);
    membersByGroup.get(k).push(m);
  });
  const catalogContext = catalogContextOf(state.catalog);
  return state.groups.map(group => {
    const takenKeys = new Set();
    state.allGroups.forEach(g => {
      if (String(g.id) === String(group.id)) return;
      if (g.canonical_key) takenKeys.add(String(g.canonical_key));
      if (g.next_canonical_key) takenKeys.add(String(g.next_canonical_key));
    });
    return T.planGroupTransition({
      group, members: membersByGroup.get(String(group.id)) || [], rowsByKey,
      legacy: o.legacy, catalogContext, requireCatalog: o.mode === 'stage', takenKeys, matcherVersion: o.matcherVersion
    });
  });
}

/** 제목 없는 요약(표준출력용). */
function brief(plan) {
  return {
    groupId: plan.groupId, verdict: plan.verdict, afterDeploy: plan.afterDeploy, reasonCodes: plan.reasonCodes,
    currentKey: plan.currentKey, nextKey: plan.nextKey || '', rolloutKey: plan.rolloutKey,
    drift: plan.drift || null, planHash: plan.planHash || ''
  };
}

async function run(db, opts) {
  const o = Object.assign({ mode: 'plan', write: false, operator: '', catalog: true, env: process.env, log: () => {} }, opts || {});
  if (!MODES.includes(o.mode)) throw new Error(`unknown mode ${o.mode}`);
  const writing = WRITE_MODES.has(o.mode);
  if (writing) {
    // 쓰기 관문 — 하나라도 없으면 아무것도 읽지도 쓰지도 않는다.
    if (!o.write) return { refused: 'WRITE_FLAG_REQUIRED', writes: 0 };
    if (!transitionEnabled(o.env)) return { refused: 'IDENTITY_TRANSITION_ENABLED_REQUIRED', writes: 0 };
    if (!o.operator) return { refused: 'OPERATOR_REQUIRED', writes: 0 };
    if (o.mode === 'stage' && !o.legacy) return { refused: 'LEGACY_MATCHER_REQUIRED', writes: 0 };
    if (o.mode === 'stage' && !o.catalog) return { refused: 'CATALOG_CONTEXT_REQUIRED', writes: 0 };
    if ((o.mode === 'abort' || o.mode === 'revert') && !o.group) return { refused: 'GROUP_REQUIRED', writes: 0 };
  }
  o.matcherVersion = o.matcherVersion || matcherVersion();

  const state = await loadState(db, { catalog: o.catalog && (o.mode === 'plan' || o.mode === 'stage' || o.mode === 'check-ready'), group: o.group });
  const plans = plansOf(state, o);
  const summary = T.summarizePlans(plans, { acceptFailClosed: o.acceptFailClosed });
  const result = { mode: o.mode, matcherVersion: o.matcherVersion, legacyVerified: Boolean(o.legacy), summary, plans: plans.map(brief), writes: 0, rpc: [] };
  if (!writing) return Object.assign(result, { fullPlans: plans });

  const call = async (fn, params) => {
    const r = await db.rpc(fn, params);
    result.writes++;
    const status = r.error ? `ERROR:${r.error.message}` : ((r.data && r.data.status) || 'UNKNOWN');
    result.rpc.push({ fn, groupId: params.p_group_id, status });
    return status;
  };
  const byId = new Map(state.groups.map(g => [String(g.id), g]));
  if (o.mode === 'stage') {
    for (const plan of plans) {
      if (plan.verdict !== T.VERDICT.TRANSITION) continue;
      await call('canonical_identity_transition_stage', Object.assign({}, plan.stage, { p_operator: o.operator }));
    }
  } else if (o.mode === 'finalize') {
    // 이미 next 자리가 지금 matcher 와 맞는(ALREADY_STAGED) 그룹만 — 계획이 그 사실을 다시 확인했다.
    for (const plan of plans) {
      if (plan.verdict !== T.VERDICT.ALREADY_STAGED) continue;
      await call('canonical_identity_transition_finalize', {
        p_group_id: plan.groupId, p_expected_next_canonical_key: plan.nextKey, p_expected_plan_hash: plan.planHash, p_operator: o.operator
      });
    }
  } else if (o.mode === 'abort') {
    const g = byId.get(String(o.group));
    if (g && g.next_canonical_key) {
      await call('canonical_identity_transition_abort', { p_group_id: g.id, p_expected_next_canonical_key: g.next_canonical_key, p_operator: o.operator });
    }
  } else if (o.mode === 'revert') {
    const g = byId.get(String(o.group));
    if (g && g.previous_canonical_key) {
      await call('canonical_identity_transition_revert', { p_group_id: g.id, p_expected_canonical_key: g.canonical_key, p_operator: o.operator });
    }
  }
  return result;
}

async function main() {
  require('./_env.js');
  const args = parseArgs(process.argv.slice(2));
  const opts = Object.assign({}, args, { legacy: args.legacyRoot ? legacyAdapterFromRoot(args.legacyRoot) : null });
  const db = require('../api/_supabase');
  const r = await run(db, opts);
  const out = Object.assign({}, r);
  delete out.fullPlans;
  console.log(JSON.stringify(out, null, 2));
  if (args.planOut && r.fullPlans) {
    fs.writeFileSync(args.planOut, JSON.stringify(r.fullPlans, null, 1));
    console.error(`계획 ${r.fullPlans.length}건을 ${args.planOut} 에 썼다 (구성원 제목 포함 — 저장소에 넣지 않는다)`);
  }
  if (r.refused) process.exit(2);
  if (args.mode === 'check-ready' && !r.summary.readyToDeploy) process.exit(1);
}

if (require.main === module) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { run, parseArgs, transitionEnabled, legacyAdapterFromRoot, catalogContextOf, plansOf, MODES };
