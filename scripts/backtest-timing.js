#!/usr/bin/env node
'use strict';
/*
 * ① 구매 타이밍 — 카탈로그 전체 백테스트 (운영 DB 읽기 전용).
 *
 *   node scripts/backtest-timing.js [--limit 200] [--horizon 14] [--min-days 45]
 *
 * API 는 상품 하나의 과거로 그 상품만 검증한다. 이 스크립트는 같은 검증을 여러
 * 상품에 돌려 «이 방법이 SEOSA 카탈로그에서 전반적으로 통하는가» 를 잰다.
 *
 * ★ 읽기 전용이다. products · price_history 를 SELECT 할 뿐 어떤 표에도 쓰지 않는다.
 * ★ 외부 쇼핑 API 를 부르지 않는다. 이미 쌓인 기록만 본다.
 * ★ npm test 체인에 넣지 않는다 — 운영 DB 자격증명이 필요하다.
 *   (SUPABASE_URL / SUPABASE_SECRET_KEY 가 없으면 아무것도 하지 않고 끝난다)
 * ★ 부하: 상품 하나당 price_history 조회 1회. --limit 로 상한을 둔다 (기본 200).
 */

require('./_env');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > -1 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.log('SUPABASE_URL / SUPABASE_SECRET_KEY 가 없어 실행하지 않습니다 (읽기 전용 스크립트).');
    return;
  }
  const supabase = require('../api/_supabase');
  const { loadSeries } = require('../api/_series');
  const timing = require('../api/_timing');
  const { kstToday } = require('../api/_kst');

  const limit = Math.min(1000, arg('limit', 200));
  const horizon = timing.HORIZONS.indexOf(arg('horizon', 14)) > -1 ? arg('horizon', 14) : 14;
  const minDays = arg('min-days', 45);
  const today = kstToday();

  // 최근에 확인된 쿠팡 상품부터. 오래 멈춘 상품은 검증해도 «지금» 에 쓸 수 없다.
  const { data: products, error } = await supabase.from('products')
    .select('product_id, mall, vendor_item_id, title')
    .eq('mall', '쿠팡')
    .order('collected_at', { ascending: false })
    .limit(limit * 3);
  if (error) throw new Error(error.message);

  const agg = { products: 0, samples: 0, brier: 0, base: 0, covered: 0, decisions: 0, hits: 0, savings: [], verdicts: {} };
  for (const p of products || []) {
    if (agg.products >= limit) break;
    const s = await loadSeries({ productId: p.product_id, mall: p.mall, vendorItemId: p.vendor_item_id }, { days: 365 });
    if (s.points.length < minDays) continue;
    const r = timing.analyze(s.points, { today, horizon });
    const b = r.backtest;
    agg.products++;
    agg.verdicts[b.verdict] = (agg.verdicts[b.verdict] || 0) + 1;
    if (!b.samples || b.brier == null) continue;
    agg.samples += b.samples;
    agg.brier += b.brier * b.samples;
    agg.base += b.brierBaseline * b.samples;
    agg.covered += b.bandCoverage * b.samples;
    agg.decisions += b.decisions;
    if (b.decisionHitRate != null) agg.hits += b.decisionHitRate * b.decisions;
    if (b.avgSavingPct != null) agg.savings.push(b.avgSavingPct);
  }

  const w = x => (agg.samples ? Math.round((x / agg.samples) * 1000) / 1000 : null);
  const brier = w(agg.brier), base = w(agg.base);
  console.log(JSON.stringify({
    asOf: today, horizon, productsEvaluated: agg.products, verdicts: agg.verdicts,
    samples: agg.samples, brier, brierBaseline: base,
    skill: brier != null && base > 0 ? Math.round((1 - brier / base) * 1000) / 1000 : null,
    bandCoverage: w(agg.covered),
    decisionHitRate: agg.decisions ? Math.round((agg.hits / agg.decisions) * 1000) / 1000 : null,
    medianWaitSavingPct: agg.savings.length
      ? agg.savings.slice().sort((a, b) => a - b)[Math.floor(agg.savings.length / 2)] : null
  }, null, 2));
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
