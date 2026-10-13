#!/usr/bin/env node
/*
 * Cross-merchant offer identity — 운영 카탈로그 오프라인 평가 (읽기 전용).
 *
 *   node scripts/eval-offer-identity-real.js                 # Supabase products 를 SELECT 로 읽는다
 *   node scripts/eval-offer-identity-real.js --input rows.json  # 미리 내려받은 products 행(JSON 배열)
 *   ... --sample-out pairs.json   # 사람이 라벨링할 쌍 표본(제목 포함)을 로컬 파일로
 *   ... --brute 3000              # blocking 누락 검사에 쓸 전수 비교 표본 크기
 *
 * ★ 읽기만 한다. products 를 SELECT 할 뿐 INSERT/UPDATE/DELETE/RPC 를 하지 않는다.
 *   군집 결과를 DB 에 쓰지 않는다 (Phase 1 offline evaluator).
 * ★ 판매 글 제목은 표준출력에 내보내지 않는다(집계만). --sample-out 을 준 경우에만 로컬 파일로 쓴다 —
 *   ADPICK 응답 저장 조항 때문에 그 파일은 저장소에 넣지 않는다.
 */
'use strict';

const fs = require('fs');
const O = require('../api/_offeridentity');

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

/* 결정론 표본 — 실행마다 같은 쌍을 본다. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}=${v}`).join(', ');
}

(async () => {
  const rows = await loadRows();
  const offers = rows.map(r => ({
    key: `${r.mall}|${r.product_id}`,
    title: r.title,
    // 판매처 = 백엔드 mall + ADPICK 제휴몰 표시 이름 (같은 ADPICK 이라도 SSG·롯데홈쇼핑은 다른 판매처다)
    mall: r.mall_label ? `${r.mall}/${r.mall_label}` : r.mall,
    productId: r.product_id,
    vendorItemId: r.vendor_item_id || '',
    price: r.lprice
  }));
  const bySource = {};
  offers.forEach(o => { const k = o.mall.split('/')[0]; bySource[k] = (bySource[k] || 0) + 1; });

  let t = Date.now();
  const parsed = offers.map(O.parseOffer);
  const parseMs = Date.now() - t;
  t = Date.now();
  const res = O.clusterOffers(parsed);
  const clusterMs = Date.now() - t;
  const byKey = new Map(parsed.map(p => [p.key, p]));
  const multi = res.groups.filter(g => g.size > 1);
  const bad = O.verifyGroups(multi, byKey);

  /* 블록 안의 후보 쌍 판정 분포 (블록당 최대 40개만 — 전수 O(N²) 를 피한다) */
  const blocks = new Map();
  parsed.forEach(p => O.blockKeys(p).forEach(k => { if (!blocks.has(k)) blocks.set(k, []); blocks.get(k).push(p); }));
  const seen = new Set();
  const dist = { MATCH: 0, REVIEW: 0, NO_MATCH: 0 };
  const unknownTop = new Map(), conflictTop = new Map();
  const samples = { MATCH: [], REVIEW: [], NO_MATCH: [] };
  const rand = rng(20261013);
  blocks.forEach(list => {
    const l = list.slice(0, 40);
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        const k = l[i].key < l[j].key ? `${l[i].key}\u0000${l[j].key}` : `${l[j].key}\u0000${l[i].key}`;
        if (seen.has(k) || l[i].mall === l[j].mall) continue;   // 판매처 교차 쌍만
        seen.add(k);
        const r = O.matchOffers(l[i], l[j]);
        dist[r.decision]++;
        r.unknown.forEach(u => { const n = u.split(':')[0]; unknownTop.set(n, (unknownTop.get(n) || 0) + 1); });
        r.conflicts.forEach(c => { const n = c.split(':')[0]; conflictTop.set(n, (conflictTop.get(n) || 0) + 1); });
        if (samples[r.decision].length < 400 && rand() < 0.5) samples[r.decision].push({ a: l[i].title, b: l[j].title, pa: l[i].price, pb: l[j].price, r });
      }
    }
  });

  /* blocking 누락 — 무작위 표본 전수 비교에서 MATCH 인데 블록 키를 공유하지 않는 쌍 */
  const bruteN = Math.min(parsed.length, Number(arg('--brute', 3000)));
  const pool = parsed.slice().sort(() => rand() - 0.5).slice(0, bruteN);
  // 무작위 표본에는 MATCH 가 거의 없으므로 다중 그룹 구성원을 더한다.
  multi.slice(0, 300).forEach(g => g.members.forEach(k => pool.push(byKey.get(k))));
  const keysOf = new Map(pool.map(p => [p.key, new Set(O.blockKeys(p))]));
  let brutePairs = 0, bruteMatch = 0, bruteMissed = 0;
  t = Date.now();
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (pool[i].key === pool[j].key) continue;
      brutePairs++;
      if (O.matchOffers(pool[i], pool[j]).decision !== 'MATCH') continue;
      bruteMatch++;
      const a = keysOf.get(pool[i].key), b = keysOf.get(pool[j].key);
      if (![...a].some(k => b.has(k))) bruteMissed++;
    }
  }
  const bruteMs = Date.now() - t;

  const summary = {
    rows: rows.length,
    bySource,
    parseMs, clusterMs,
    clusterStats: res.stats,
    reviewEdges: res.reviews.length,
    allPairsViolations: bad.length,
    crossMerchantCandidatePairs: dist,
    topUnknown: top(unknownTop, 12),
    topConflicts: top(conflictTop, 12),
    blocking: { pool: pool.length, brutePairs, bruteMatch, bruteMissed, bruteMs }
  };
  console.log(JSON.stringify(summary, null, 2));

  const out = arg('--sample-out');
  if (out) {
    const pickN = (list, n) => list.sort(() => rand() - 0.5).slice(0, n).map(x => ({
      a: x.a, b: x.b, pa: x.pa, pb: x.pb, decision: x.r.decision, conflicts: x.r.conflicts, unknown: x.r.unknown, label: null
    }));
    fs.writeFileSync(out, JSON.stringify({
      MATCH: pickN(samples.MATCH, 80), REVIEW: pickN(samples.REVIEW, 80), NO_MATCH: pickN(samples.NO_MATCH, 80),
      groups: multi.map(g => g.members.map(k => [byKey.get(k).mall, byKey.get(k).price, byKey.get(k).title]))
    }, null, 1));
    console.error(`표본을 ${out} 에 썼다 (저장소에 넣지 않는다)`);
  }
  if (bad.length) process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
