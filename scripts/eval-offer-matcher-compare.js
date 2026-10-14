#!/usr/bin/env node
/*
 * Offer matcher — BASELINE 코드와 이 작업 트리의 코드를 «같은 쌍» 에 돌려 판정 변화를 센다 (읽기 전용).
 *
 *   node scripts/eval-offer-matcher-compare.js --baseline-root <dir> --input rows.json
 *   node scripts/eval-offer-matcher-compare.js --baseline-root <dir>              # Supabase products SELECT
 *   ... --report-out report.json   집계 (상품명 없음)
 *   ... --sample-out audit.json    판정이 바뀐 쌍 전부 + 파싱된 식별 값 (상품명 포함 — 저장소에 넣지 않는다)
 *
 *   <dir> 은 기준 커밋을 풀어 놓은 폴더다:  git archive <base> | tar -x -C <dir>
 *   두 쪽은 각자의 api/_offeridentity.js · api/_offerdiscovery.js 로 후보를 만들고 판정한다.
 *   판정 변화(REVIEW→MATCH · MATCH→REVIEW …)는 두 후보 집합의 합집합에서 센다 —
 *   한쪽에서만 후보인 쌍은 다른 쪽에서 NOT_CANDIDATE 다.
 *
 * ★ 읽기만 한다. products 를 SELECT 할 뿐 INSERT/UPDATE/DELETE/RPC 를 하지 않는다.
 * ★ 불변식이 깨지면 exit 1: NEW 군집 all-pairs 위반.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadRows() {
  const input = arg('--input');
  if (input) return JSON.parse(fs.readFileSync(input, 'utf8'));
  require('./_env.js');
  const supabase = require('../api/_supabase');
  const rows = [];
  let after = 0;
  for (;;) {
    const { data, error } = await supabase.from('products')
      .select('id,product_id,mall,mall_label,title,lprice,vendor_item_id')
      .gt('id', after).order('id', { ascending: true }).limit(1000);
    if (error) throw new Error(error.message);
    if (!data.length) break;
    rows.push(...data);
    after = data[data.length - 1].id;
  }
  return rows;
}

const pct = (n, d) => (d ? Math.round((n / d) * 100000) / 1000 : 0);
const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** 한쪽 코드로 후보·판정·군집을 만든다. */
function side(root, offers) {
  const OI = require(path.join(root, 'api', '_offeridentity'));
  const D = require(path.join(root, 'api', '_offerdiscovery'));
  const t0 = Date.now();
  const ids = offers.map(OI.parseOffer);
  const parseMs = Date.now() - t0;
  const byKey = new Map(ids.map(id => [id.key, id]));
  const ctx = OI.contextFactory(ids);
  const t1 = Date.now();
  const baseline = OI.clusterOffers(ids);
  const v2 = D.rediscover(ids, { baseline });
  const clusterMs = Date.now() - t1;

  const t2 = Date.now();
  const n = ids.length;
  const seen = new Set();
  const decisions = new Map();
  const judge = (i, j) => {
    const p = i < j ? i * n + j : j * n + i;
    if (seen.has(p)) return;
    seen.add(p);
    const a = ids[i], b = ids[j];
    const r = OI.matchOffers(a, b, ctx(a, b));
    decisions.set(pairKey(a.key, b.key), { d: r.decision, tier: r.tier, tags: (r.conflicts.length ? r.conflicts : r.unknown).map(t => t.split(':')[0]) });
  };
  const blocks = new Map();
  ids.forEach((id, i) => OI.blockKeys(id).forEach(k => { if (!blocks.has(k)) blocks.set(k, []); blocks.get(k).push(i); }));
  blocks.forEach(list => { if (list.length > 2000) return; for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) judge(list[x], list[y]); });
  D.discoverCandidates(ids).pairs.forEach(([i, j]) => judge(i, j));
  const judgeMs = Date.now() - t2;
  return { OI, D, ids, byKey, ctx, groups: v2.groups, decisions, ms: { parse: parseMs, cluster: clusterMs, judge: judgeMs, total: parseMs + clusterMs + judgeMs } };
}

(async () => {
  const baseRoot = arg('--baseline-root');
  if (!baseRoot) throw new Error('--baseline-root <dir> 가 필요하다 (git archive <base> | tar -x -C <dir>)');
  const rows = await loadRows();
  const offers = rows.map(r => ({
    key: `${r.mall}|${r.product_id}`, title: r.title,
    mall: r.mall_label ? `${r.mall}/${r.mall_label}` : r.mall,
    productId: r.product_id, vendorItemId: r.vendor_item_id || '', price: r.lprice
  }));

  const B = side(path.resolve(baseRoot), offers);
  const N = side(path.resolve(__dirname, '..'), offers);
  const D = N.D;

  /* ── 판정 분포와 변화 ── */
  const count = dec => { const c = { pairs: dec.size, MATCH: 0, REVIEW: 0, NO_MATCH: 0 }; dec.forEach(v => { c[v.d]++; }); return c; };
  const keys = new Set([...B.decisions.keys(), ...N.decisions.keys()]);
  const transitions = {};
  const changed = [];
  const crossOnly = { base: { MATCH: 0, REVIEW: 0, NO_MATCH: 0 }, new: { MATCH: 0, REVIEW: 0, NO_MATCH: 0 } };
  keys.forEach(k => {
    const b = B.decisions.get(k), x = N.decisions.get(k);
    const bd = b ? b.d : 'NOT_CANDIDATE', nd = x ? x.d : 'NOT_CANDIDATE';
    const [ka, kb] = k.split('\u0000');
    const rel = D.merchantRelation(N.byKey.get(ka), N.byKey.get(kb));
    if (rel !== 'same') { if (b) crossOnly.base[bd]++; if (x) crossOnly.new[nd]++; }
    if (bd === nd) return;
    const t = `${bd}->${nd}`;
    transitions[t] = (transitions[t] || 0) + 1;
    changed.push({ k, bd, nd, b, x, rel });
  });

  /* ── 군집 ── */
  const gb = D.groupStats(B.groups, B.byKey);
  const gn = D.groupStats(N.groups, N.byKey);
  const homeN = new Map();
  N.groups.forEach(g => g.members.forEach(k => homeN.set(k, g.id)));
  const baseMulti = B.groups.filter(g => g.size > 1);
  const newMulti = N.groups.filter(g => g.size > 1);
  let lost = 0, split = 0, grown = 0, shrunk = 0;
  const lostGroups = [];
  baseMulti.forEach(g => {
    const homes = [...new Set(g.members.map(k => homeN.get(k)))];
    const sizes = homes.map(h => N.groups[h].size);
    if (homes.length > 1) { split++; lostGroups.push({ members: g.members, homes: sizes }); }
    else if (sizes[0] === 1) { lost++; lostGroups.push({ members: g.members, homes: sizes }); }
    else if (sizes[0] > g.size) grown++;
    else if (sizes[0] < g.size) shrunk++;
  });
  const baseGrouped = new Set([].concat(...baseMulti.map(g => g.members)));
  const homeB = new Map();
  B.groups.forEach(g => g.members.forEach(k => homeB.set(k, g.id)));
  const fresh = newMulti.filter(g => g.members.every(k => !baseGrouped.has(k)));
  const newRows = newMulti.reduce((s, g) => s + g.members.filter(k => !baseGrouped.has(k)).length, 0);

  /* ── 불변식 ── */
  const SH = require('../api/_identityshadow');
  const verdict = SH.validateShadowResult({ groups: newMulti, offersByKey: N.byKey });

  const n = offers.length;
  const report = {
    rows: n,
    table: {
      candidatePairs: [B.decisions.size, N.decisions.size],
      MATCH: [count(B.decisions).MATCH, count(N.decisions).MATCH],
      REVIEW: [count(B.decisions).REVIEW, count(N.decisions).REVIEW],
      NO_MATCH: [count(B.decisions).NO_MATCH, count(N.decisions).NO_MATCH],
      crossOrUnknownMerchantMATCH: [crossOnly.base.MATCH, crossOnly.new.MATCH],
      crossOrUnknownMerchantREVIEW: [crossOnly.base.REVIEW, crossOnly.new.REVIEW],
      crossMerchantGroups: [gb.crossMerchantGroups, gn.crossMerchantGroups],
      knownCrossMerchantGroups: [gb.knownCrossMerchantGroups, gn.knownCrossMerchantGroups],
      multiOfferGroups: [gb.multiOfferGroups, gn.multiOfferGroups],
      groupedRows: [gb.groupedRows, gn.groupedRows],
      groupingRatePct: [pct(gb.groupedRows, n), pct(gn.groupedRows, n)],
      crossMerchantRowRatePct: [pct(gb.crossMerchantRows, n), pct(gn.crossMerchantRows, n)],
      ms: [B.ms.total, N.ms.total]
    },
    transitions,
    groups: { lostBaselineGroups: lost, splitBaselineGroups: split, shrunkBaselineGroups: shrunk, grownBaselineGroups: grown, newGroups: fresh.length, newCrossMerchantGroups: fresh.filter(g => g.malls.length > 1).length, newGroupedRows: newRows },
    invariants: { ok: verdict.ok, violations: verdict.violations.length },
    timing: { base: B.ms, new: N.ms, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  const reportOut = arg('--report-out');
  if (reportOut) fs.writeFileSync(reportOut, json);

  const out = arg('--sample-out');
  if (out) {
    const view = (id, decision) => id && {
      mall: id.mall, price: id.price, title: id.title, brand: id.brand, words: id.words, anchors: id.anchors, variants: id.variants,
      modelNumbers: id.modelNumbers, cpu: id.cpu, gpu: id.gpu, storage: id.storage, memory: id.memory, specs: id.specs,
      colors: id.colors, quantity: id.quantity, condition: id.condition, accessory: id.accessoryType || (id.accessory ? 'accessory' : ''),
      transaction: id.transactionType, substitute: id.substitute, bundle: id.bundle, decision
    };
    fs.writeFileSync(out, JSON.stringify({
      changed: changed.map(c => {
        const [ka, kb] = c.k.split('\u0000');
        return { from: c.bd, to: c.nd, relation: c.rel, baseTags: c.b ? c.b.tags : null, newTags: c.x ? c.x.tags : null, newTier: c.x ? c.x.tier : null,
          a: view(N.byKey.get(ka)), b: view(N.byKey.get(kb)), label: null };
      }),
      lostOrSplitGroups: lostGroups.map(g => g.members.map(k => view(N.byKey.get(k))))
    }, null, 1));
    console.error(`표본을 ${out} 에 썼다 (저장소에 넣지 않는다)`);
  }
  if (!verdict.ok) { verdict.violations.slice(0, 5).forEach(v => console.error('violation', JSON.stringify(v))); process.exit(1); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
