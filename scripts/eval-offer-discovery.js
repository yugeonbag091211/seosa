#!/usr/bin/env node
/*
 * Candidate Discovery v2 — 운영 카탈로그 dry-run 비교 (읽기 전용).
 *
 *   node scripts/eval-offer-discovery.js                       # Supabase products 를 SELECT 로 읽는다
 *   node scripts/eval-offer-discovery.js --input rows.json     # 미리 내려받은 products 행(JSON 배열)
 *   ... --canonical members.json   # 운영자가 따로 내려받은 canonical 구성원 행(group_id·mall·product_id)
 *                                  — ACTIVE 그룹이 v2 에서 어떻게 되는지. 이 스크립트는 canonical 표를 읽지 않는다.
 *   ... --report-out report.json   # 집계 JSON (상품명 없음)
 *   ... --sample-out audit.json    # 사람이 볼 표본(상품명 포함) — 저장소에 넣지 않는다
 *
 *   BASELINE  parseOffer → clusterOffers (Phase 1 그대로)
 *   NEW       BASELINE + rediscover (api/_offerdiscovery.js) — 판정기는 같은 matchOffers
 *
 * ★ 읽기만 한다. products 를 SELECT 할 뿐 INSERT/UPDATE/DELETE/RPC 를 하지 않는다.
 *   canonical·shadow 표에도 쓰지 않는다.
 * ★ 판매 글 제목은 표준출력에 내보내지 않는다(집계만). --sample-out 을 준 경우에만 로컬 파일로 쓴다 —
 *   ADPICK 응답 저장 조항 때문에 그 파일은 저장소에 넣지 않는다.
 * ★ 불변식이 하나라도 깨지면 exit 1: v2 군집 all-pairs 위반 · 기존 군집 소실 · 기존 군집 분할.
 */
'use strict';

const fs = require('fs');
const OI = require('../api/_offeridentity');
const D = require('../api/_offerdiscovery');
const SH = require('../api/_identityshadow');
const { censusPairs } = require('./run-offer-identity-shadow');

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

/* 결정론 표본 */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* 감사 표본을 고루 뽑기 위한 대략의 분류 — 판정에는 쓰지 않는다. */
const AUDIT_CATEGORIES = [
  ['laptop', /노트북|맥북|macbook|laptop|게이밍\s*pc|그램|갤럭시북/i],
  ['smartphone', /아이폰|iphone|갤럭시\s*(?:s|z|a)\d|스마트폰|자급제|휴대폰/i],
  ['audio', /이어폰|헤드폰|헤드셋|버즈|에어팟|airpods|buds|스피커|사운드바/i],
  ['pc_peripheral', /마우스|키보드|모니터|그래픽카드|rtx|웹캠|공유기|mouse|keyboard/i],
  ['storage', /ssd|외장\s*하드|usb\s*메모리|sd\s*카드|micro\s*sd|nvme|hdd/i],
  ['appliance', /청소기|가습기|제습기|에어프라이어|밥솥|선풍기|믹서|블렌더|전기포트|오븐|세탁기|냉장고|공기청정기|드라이기|면도기|커피머신/i],
  ['fashion', /운동화|러닝화|스니커즈|자켓|재킷|티셔츠|셔츠|팬츠|바지|원피스|가방|백팩|모자|신발|양말|코트|패딩/i],
  ['cosmetics', /크림|세럼|토너|로션|앰플|선크림|쿠션|립|마스카라|샴푸|트리트먼트|클렌징|에센스|향수|왁스/i],
  ['living', /세제|휴지|물티슈|수건|텀블러|냄비|프라이팬|도마|칫솔|치약|수납|매트|이불|베개/i],
  ['food', /두유|커피|라면|과자|아이스크림|현미|쌀|김치|음료|생수|우유|견과/i]
];
function auditCategory(title) {
  const hit = AUDIT_CATEGORIES.find(([, re]) => re.test(title));
  return hit ? hit[0] : 'other';
}

function pct(n, d) { return d ? Math.round((n / d) * 100000) / 1000 : 0; }

(async () => {
  const t0 = Date.now();
  const rows = await loadRows();
  const loadMs = Date.now() - t0;
  const offers = rows.map(r => ({
    key: `${r.mall}|${r.product_id}`,
    title: r.title,
    // 판매처 = 백엔드 mall + ADPICK 제휴몰 표시 이름 (shadow 워커와 같은 정의)
    mall: r.mall_label ? `${r.mall}/${r.mall_label}` : r.mall,
    productId: r.product_id,
    vendorItemId: r.vendor_item_id || '',
    price: r.lprice
  }));

  let t = Date.now();
  const ids = offers.map(OI.parseOffer);
  const parseMs = Date.now() - t;
  const byKey = new Map(ids.map(id => [id.key, id]));

  /* ── BASELINE ── */
  t = Date.now();
  const baseline = OI.clusterOffers(ids);
  const baseClusterMs = Date.now() - t;
  t = Date.now();
  const base = censusPairs(ids, { censusMaxBlock: 2000 });
  const baseCensusMs = Date.now() - t;

  /* ── NEW ── */
  t = Date.now();
  const v2 = D.rediscover(ids, { baseline });
  const rediscoverMs = Date.now() - t;

  /* ── 불변식 ── */
  const multiNew = v2.groups.filter(g => g.size > 1);
  const verdict = SH.validateShadowResult({
    groups: multiNew, offersByKey: byKey,
    reviewPairs: v2.reviews.map(r => [r.a, r.b]).concat(base.reviewPairs.map(p => [p.a.key, p.b.key]))
  });
  const groupOfNew = new Map();
  v2.groups.forEach(g => g.members.forEach(k => groupOfNew.set(k, g.id)));
  const baseMulti = baseline.groups.filter(g => g.size > 1);
  let lostGroups = 0, splitGroups = 0, grownGroups = 0;
  baseMulti.forEach(g => {
    const homes = new Set(g.members.map(k => groupOfNew.get(k)));
    if (homes.has(undefined)) lostGroups++;
    else if (homes.size > 1) splitGroups++;
    else if (v2.groups[[...homes][0]].size > g.size) grownGroups++;
  });
  // 기존 MATCH 쌍이 NO_MATCH 로 퇴보했는가 — matcher 는 그대로이므로 0 이어야 한다(그래도 센다).
  let baseMatchRegressed = 0;
  const ctx = OI.contextFactory(ids);
  base.results.forEach((r, k) => {
    if (r.decision !== OI.DECISION.MATCH) return;
    const [a, b] = k.split('\u0000');
    if (OI.matchOffers(byKey.get(a), byKey.get(b), ctx(byKey.get(a), byKey.get(b))).decision !== OI.DECISION.MATCH) baseMatchRegressed++;
  });

  /* ── ACTIVE canonical 그룹 ── */
  let canonical = null;
  const canonPath = arg('--canonical');
  if (canonPath) {
    const cm = JSON.parse(fs.readFileSync(canonPath, 'utf8'));
    const byGroup = new Map();
    cm.forEach(m => { const k = `${String(m.mall).split('/')[0]}|${m.product_id}`; if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []); byGroup.get(m.group_id).push(k); });
    canonical = [...byGroup.entries()].map(([gid, keys]) => {
      const homes = new Set(keys.map(k => groupOfNew.get(k)));
      const home = homes.size === 1 ? v2.groups[[...homes][0]] : null;
      return { groupId: gid, members: keys.length, foundInSnapshot: keys.every(k => byKey.has(k)), together: homes.size === 1 && !homes.has(undefined), v2Size: home ? home.size : null, changed: home ? home.size !== keys.length : true };
    });
  }

  /* ── 집계 ── */
  const gb = D.groupStats(baseline.groups, byKey);
  const gn = D.groupStats(v2.groups, byKey);
  const n = ids.length;
  const theoretical = (n * (n - 1)) / 2;
  const baseCandidates = base.census.comparisons;
  const newCandidates = baseCandidates + v2.stats.v2.pairs;
  const perMerchant = {};
  const tally = (groups, field) => groups.filter(g => g.size > 1 && new Set(g.members.map(k => byKey.get(k).mall)).size > 1)
    .forEach(g => g.members.forEach(k => { const m = byKey.get(k).mall; perMerchant[m] = perMerchant[m] || { rows: 0, baseline: 0, new: 0 }; perMerchant[m][field]++; }));
  ids.forEach(id => { perMerchant[id.mall] = perMerchant[id.mall] || { rows: 0, baseline: 0, new: 0 }; perMerchant[id.mall].rows++; });
  tally(baseline.groups, 'baseline');
  tally(v2.groups, 'new');
  Object.values(perMerchant).forEach(m => { m.baselineRate = pct(m.baseline, m.rows); m.newRate = pct(m.new, m.rows); });

  const newGroups = v2.groups.filter(g => g.origin === 'new');
  // 새로 «묶인» 상품 = v2 다중 군집에 있지만 기존 다중 군집에는 없던 상품
  const baseGrouped = new Set([].concat(...baseMulti.map(g => g.members)));
  const newRows = multiNew.reduce((s, g) => s + g.members.filter(k => !baseGrouped.has(k)).length, 0);

  /* REVIEW 가 왜 MATCH 가 못 됐는가 — 첫 사유 · 단독 사유 (다음 단계 판단용, 판정에는 쓰지 않는다) */
  const reviewCauses = { first: {}, single: {} };
  const causeOf = u => u.split(':')[0];
  base.reviewPairs.map(p => p.result.unknown).concat(v2.reviews.map(r => r.unknown)).forEach(unknown => {
    const c = causeOf(unknown[0] || 'none');
    reviewCauses.first[c] = (reviewCauses.first[c] || 0) + 1;
    if (unknown.length === 1) reviewCauses.single[c] = (reviewCauses.single[c] || 0) + 1;
  });
  const sortDesc = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  reviewCauses.first = sortDesc(reviewCauses.first);
  reviewCauses.single = sortDesc(reviewCauses.single);

  const summary = {
    rows: n,
    table: {
      products: [n, n],
      candidatePairs: [baseCandidates, newCandidates],
      crossMerchantGroups: [gb.crossMerchantGroups, gn.crossMerchantGroups],
      crossMerchantRows: [gb.crossMerchantRows, gn.crossMerchantRows],
      knownCrossMerchantGroups: [gb.knownCrossMerchantGroups, gn.knownCrossMerchantGroups],
      knownCrossMerchantRows: [gb.knownCrossMerchantRows, gn.knownCrossMerchantRows],
      multiOfferGroups: [gb.multiOfferGroups, gn.multiOfferGroups],
      groupedRows: [gb.groupedRows, gn.groupedRows],
      MATCH: [base.census.match, base.census.match + v2.stats.v2.MATCH],
      REVIEW: [base.census.review, base.census.review + v2.stats.v2.REVIEW],
      NO_MATCH: [base.census.noMatch, base.census.noMatch + v2.stats.v2.NO_MATCH],
      groupedRowRatePct: [pct(gb.groupedRows, n), pct(gn.groupedRows, n)],
      crossMerchantRowRatePct: [pct(gb.crossMerchantRows, n), pct(gn.crossMerchantRows, n)],
      ms: [parseMs + baseClusterMs + baseCensusMs, parseMs + baseClusterMs + baseCensusMs + rediscoverMs]
    },
    regressions: { lostBaselineGroups: lostGroups, splitBaselineGroups: splitGroups, baselineMatchToNonMatch: baseMatchRegressed, grownBaselineGroups: grownGroups },
    discovered: { newGroups: newGroups.length, newCrossMerchantGroups: newGroups.filter(g => g.malls.length > 1).length, newRows, attached: v2.stats.attached, mergedGroups: v2.stats.mergedGroups, blockedMerges: v2.stats.blockedMerges },
    v2: v2.stats.v2,
    reviewCauses,
    baseRecheck: v2.stats.baseRecheck,
    discovery: v2.stats.discovery,
    invariants: { ok: verdict.ok, violations: verdict.violations.length, checkedPairs: verdict.checkedPairs },
    canonical,
    performance: {
      theoreticalPairs: theoretical, candidatePairs: newCandidates, reductionRatio: newCandidates / theoretical,
      loadMs, parseMs, baseClusterMs, baseCensusMs, rediscoverMs, totalMs: Date.now() - t0,
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024)
    },
    perMerchant
  };
  const json = JSON.stringify(summary, null, 2);
  console.log(json);
  const reportOut = arg('--report-out');
  if (reportOut) fs.writeFileSync(reportOut, json);

  const out = arg('--sample-out');
  if (out) {
    const rand = rng(20261014);
    const row = k => { const id = byKey.get(k); return { mall: id.mall, price: id.price, title: id.title }; };
    const judge = (a, b) => OI.matchOffers(byKey.get(a), byKey.get(b), ctx(byKey.get(a), byKey.get(b)));
    // 새로 생긴 MATCH 쌍 — 새·자란 군집 안에서 기존에 함께 있지 않던 쌍 전부
    const baseGroupOf = new Map();
    baseline.groups.forEach(g => g.members.forEach(k => baseGroupOf.set(k, g.id)));
    const newMatchPairs = [];
    v2.groups.filter(g => g.origin !== 'baseline' && g.size > 1).forEach(g => {
      for (let i = 0; i < g.members.length; i++) for (let j = i + 1; j < g.members.length; j++) {
        const a = g.members[i], b = g.members[j];
        if (baseGroupOf.get(a) === baseGroupOf.get(b)) continue;
        const r = judge(a, b);
        newMatchPairs.push({ a: row(a), b: row(b), category: auditCategory(byKey.get(a).title), tier: r.tier, evidence: r.evidence, label: null });
      }
    });
    // 최종 군집의 판매처 교차 MATCH 쌍 층화 표본 — 분류마다 최대 25쌍, 모자라면 나머지에서 채워 최소 150쌍
    const allPairs = [];
    multiNew.forEach(g => {
      for (let i = 0; i < g.members.length; i++) for (let j = i + 1; j < g.members.length; j++) {
        const a = g.members[i], b = g.members[j];
        if (byKey.get(a).mall === byKey.get(b).mall) continue;
        allPairs.push([a, b]);
      }
    });
    const byCat = new Map();
    const rest = [];
    shuffle(allPairs, rand).forEach(([a, b]) => {
      const c = auditCategory(byKey.get(a).title);
      if (!byCat.has(c)) byCat.set(c, []);
      const item = { a: row(a), b: row(b), category: c, tier: judge(a, b).tier, label: null };
      if (byCat.get(c).length < 25) byCat.get(c).push(item); else rest.push(item);
    });
    const stratified = [].concat(...byCat.values());
    stratified.push(...rest.slice(0, Math.max(0, 150 - stratified.length)));
    const reviewSample = shuffle(v2.reviews, rand).slice(0, 120).map(r => ({ a: row(r.a), b: row(r.b), sources: r.sources, relation: r.relation, unknown: r.unknown, label: null }));
    fs.writeFileSync(out, JSON.stringify({
      newMatchPairs,
      stratifiedMatchPairs: stratified,
      v2ReviewSample: reviewSample,
      newGroups: v2.groups.filter(g => g.origin !== 'baseline' && g.size > 1).map(g => ({ origin: g.origin, members: g.members.map(row) }))
    }, null, 1));
    console.error(`표본을 ${out} 에 썼다 (저장소에 넣지 않는다)`);
  }

  const bad = !verdict.ok || lostGroups || splitGroups || baseMatchRegressed;
  if (bad) {
    verdict.violations.slice(0, 5).forEach(v => console.error('violation', JSON.stringify(v)));
    process.exit(1);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
