#!/usr/bin/env node
/*
 * 죽은 product_id 재연결 후보를 뽑는다 — 읽기 전용. 쿠팡 호출 0회.
 *
 *   npm run audit:catalog
 *
 * ── 무엇을 푸는가 ───────────────────────────────────────────────
 *
 * 판매자가 상품을 내리고 새 product_id 로 다시 올리면 우리 카탈로그의 id 가
 * 죽는다. 그 상품은 어떤 검색어로도 다시 잡히지 않는다 — 쿠팡 검색 API 는
 * product_id 를 색인하지 않기 때문이다(2026-09-03 실측, api/_coupang.js 주석).
 * 그래서 매일 "미수집" 으로 남는데, 원인은 수집기가 아니라 카탈로그다.
 *
 * 이 스크립트는 **오늘 이미 받아 둔 검색 응답**(coupang_search_cache)에서
 * 살아 있는 후보를 찾아 등급을 매긴다. 새 호출을 하지 않는다.
 *
 * ── 무엇을 하지 않는가 ──────────────────────────────────────────
 *
 * ★ 아무것도 고치지 않는다. product_id 를 바꾸는 것은 상품 정체성을 바꾸는
 *   일이고, 틀리면 사용자에게 다른 상품의 가격을 보여 주게 된다.
 *   실측으로 제목 기반 판정은 오탐이 반복해서 나왔다(api/_identity.js 주석).
 *   그래서 여기서는 **사람이 볼 목록만** 만든다.
 *
 * 출력: 표준출력 요약 + (인자로 경로를 주면) JSON 상세
 */
'use strict';

require('./_env.js');

const supabase = require('../api/_supabase');
const { judgeSameProduct, overlap } = require('../api/_identity');
const { kstToday, kstDayStartUtc } = require('../api/_price');

const PAGE = 1000;
/** 후보로 볼 최소 제목 겹침. 이보다 낮으면 볼 가치가 없다. */
const MIN_OVERLAP = Number(process.env.CATALOG_MIN_OVERLAP) || 0.8;

async function fetchAll(table, sel, mod) {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(sel).range(from, from + PAGE - 1);
    if (mod) q = mod(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) return all;
  }
}

(async () => {
  const TODAY = kstToday();
  const dayStart = kstDayStartUtc(TODAY);
  const dayEnd = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();

  const products = await fetchAll('products', 'product_id, mall, title, link');
  const isCoupang = p => p.mall === '쿠팡' || (p.link && p.link.includes('coupang'));
  const coupang = products.filter(isCoupang);
  const ourIds = new Set(products.map(p => String(p.product_id)));

  const todayRows = await fetchAll('price_history', 'product_id, mall',
    q => q.gte('recorded_at', dayStart).lt('recorded_at', dayEnd).eq('mall', '쿠팡'));
  const collected = new Set(todayRows.map(r => `${r.product_id}|${r.mall}`));
  const missing = coupang.filter(p => !collected.has(`${p.product_id}|${p.mall}`));

  console.log(`기준 날짜(KST) ${TODAY}`);
  console.log(`쿠팡 대상 ${coupang.length} / 오늘 확보 ${coupang.length - missing.length}`
    + ` / 미수집 ${missing.length}`);

  // 캐시에 담긴 살아 있는 상품 풀 (우리 카탈로그에 없는 것만 후보가 된다)
  const cache = await fetchAll('coupang_search_cache', 'keyword, items, fetched_at');
  const pool = new Map();
  cache.forEach(row => {
    const items = Array.isArray(row.items) ? row.items : [];
    const at = Date.parse(row.fetched_at) || 0;
    items.forEach(it => {
      const pid = String(it && it.productId);
      if (!pid || pid === 'undefined') return;
      if (ourIds.has(pid)) return;
      const got = pool.get(pid);
      if (!got || at > got.at) {
        pool.set(pid, {
          pid, title: it.title || '', vid: it.vendorItemId || '',
          price: it.lprice, at, via: row.keyword
        });
      }
    });
  });
  console.log(`캐시 검색어 ${cache.length}종 → 살아 있는 후보 풀 ${pool.size}개\n`);

  const results = [];
  missing.forEach(p => {
    const ours = p.title || '';
    const cands = [];
    pool.forEach(c => {
      const ov = overlap(ours, c.title);
      if (ov >= MIN_OVERLAP) cands.push({ ...c, overlap: Number(ov.toFixed(2)) });
    });
    cands.sort((a, b) => b.overlap - a.overlap);
    const judged = cands.slice(0, 5).map(c => ({ ...c, ...judgeSameProduct(ours, c.title) }));
    const rank = { A: 0, B: 1, C: 2, D: 3 };
    judged.sort((a, b) => (rank[a.tier] - rank[b.tier]) || (b.overlap - a.overlap));
    results.push({
      oldPid: String(p.product_id), oldTitle: ours,
      tier: judged.length ? judged[0].tier : 'NONE',
      best: judged[0] || null, candidates: judged
    });
  });

  const tally = { A: 0, B: 0, C: 0, D: 0, NONE: 0 };
  results.forEach(r => { tally[r.tier]++; });

  console.log('=== 재연결 후보 등급 ===');
  console.log(`  A  동일 확실   ${String(tally.A).padStart(3)}   정규화 제목 일치 또는 브랜드+모델코드 일치`);
  console.log(`  B  동일 유력   ${String(tally.B).padStart(3)}   브랜드 일치 + 제목 겹침 90%↑`);
  console.log(`  C  모호       ${String(tally.C).padStart(3)}   옵션 단위가 다르거나 근거 약함`);
  console.log(`  D  다른 상품   ${String(tally.D).padStart(3)}   모델·연식·세대·용량·매체·구성 충돌`);
  console.log(`  —  후보 없음   ${String(tally.NONE).padStart(3)}   닮은 상품이 검색에 없다`);

  const ab = results.filter(r => r.tier === 'A' || r.tier === 'B');
  if (ab.length) {
    console.log(`\n=== 사람이 확인할 목록 (${ab.length}건) ===`);
    console.log('※ 이 스크립트는 아무것도 바꾸지 않는다. 아래는 검토용이다.\n');
    ab.forEach(r => {
      console.log(`[${r.tier}] ${r.oldPid} → ${r.best.pid}   ${r.best.reasons.join(' / ')}`);
      console.log(`     지금 : ${r.oldTitle.slice(0, 76)}`);
      console.log(`     후보 : ${String(r.best.title).slice(0, 76)}`);
      console.log(`     가격 ${r.best.price} · vendorItemId ${r.best.vid || '(없음)'}`);
    });
  }

  if (process.argv[2]) {
    require('fs').writeFileSync(process.argv[2], JSON.stringify({ TODAY, tally, results }, null, 1));
    console.log(`\n상세: ${process.argv[2]}`);
  }
  console.log('\n[안내] 재연결은 product_id(상품 정체성)를 바꾸는 작업이라 이 스크립트가 하지 않는다.');
})().catch(e => { console.error(e.message); process.exit(1); });

