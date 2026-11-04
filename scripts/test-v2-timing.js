#!/usr/bin/env node
'use strict';
/*
 * ① 구매 타이밍 — 완전 오프라인.
 *
 * 여기서 고정하는 것
 *   1) 기록이 모자라거나 멈췄으면 확률을 만들지 않는다 (INSUFFICIENT)
 *   2) 모양이 뚜렷한 기록에서는 맞는 행동을 낸다 (주기 할인 → 평소가는 WAIT · 할인일은 BUY_NOW)
 *   3) 예측이 통하지 않는 기록(무작위 보행)에서는 행동을 권하지 않는다
 *   4) 백테스트에 미래가 새지 않는다 — 시점 t 의 예측 = t 까지 잘라 다시 계산한 예측
 *   5) 판정 엔진(_deal)이 비싸다는 상품에 BUY_NOW 를 내지 않는다 (무작위 200개로 확인)
 *   6) 핸들러는 읽기만 하고 외부를 부르지 않는다
 */

const kit = require('./_v2-testkit');
const { db, state, T, mkReq, mkRes, fetchCalls } = kit.setup('test-v2-timing');

const timing = require('../api/_timing');
const api = require('../api/_timing-api');
const history = require('../api/history');
const { kstToday } = require('../api/_kst');
const I = timing._internal;

/** i 번째 날(0 = 가장 오래됨)의 가격 함수 → 오늘에서 끝나는 일별 계열. null 이면 그날 관측 없음. */
function series(fn, n, endDaysAgo) {
  const out = [];
  const end = endDaysAgo || 0;
  for (let i = 0; i < n; i++) {
    const price = fn(i);
    if (price == null) continue;
    out.push({ date: kstToday(new Date(Date.now() - (end + n - 1 - i) * 86400000)), price });
  }
  return out;
}
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}
const saleEvery14 = shift => i => (((i + shift) % 14 === 12 || (i + shift) % 14 === 13) ? 80000 : 100000);

async function main() {
  /* ── 1. 판단 보류 ─────────────────────────────────────────── */
  T.section('기록이 모자라면 확률을 만들지 않는다');
  {
    const r = timing.analyze([]);
    T.check(r.recommendation.action === 'INSUFFICIENT' && r.forecast.dropProbability === null, '기록 없음 → INSUFFICIENT');
    const few = timing.analyze(series(i => 10000 + i, 5));
    T.check(few.recommendation.action === 'INSUFFICIENT' && few.forecast.expectedMin === null, '5일치 → INSUFFICIENT', few.recommendation);
    const short = timing.analyze(series(i => 10000 + (i % 3) * 100, 12).slice(0, 12).map((p, i, a) => a[i]));
    T.check(short.recommendation.action === 'INSUFFICIENT', '12일치·11일 폭 → INSUFFICIENT (기간 14일 미만)');
    const stale = timing.analyze(series(saleEvery14(0), 60, 15));
    T.check(stale.recommendation.action === 'INSUFFICIENT' && /15일 전/.test(stale.recommendation.reasons[0]),
      '마지막 기록이 15일 전 → 지금에 대해 말하지 않는다', stale.recommendation.reasons);
    T.check(stale.staleDays === 15, 'staleDays 를 그대로 싣는다', stale.staleDays);
    let threw = false;
    try {
      [null, undefined, 'x', 5, [null, {}, { date: 'x', price: 'a' }, { date: '2026-01-01', price: -5 }]]
        .forEach(v => { const r2 = timing.analyze(v); if (r2.recommendation.action !== 'INSUFFICIENT') throw new Error('not insufficient'); });
    } catch (e) { threw = true; }
    T.check(!threw, '쓰레기 입력에도 throw 하지 않고 INSUFFICIENT');
    const future = timing.analyze(series(() => 5000, 20).concat([{ date: '2999-01-01', price: 1 }]));
    T.check(future.lastDate !== '2999-01-01', '미래 날짜 라벨은 관측이 아니다');
  }

  /* ── 2. 모양이 뚜렷한 기록 ─────────────────────────────────── */
  T.section('주기 할인 · 할인일 · 꾸준한 하락 · 고정가');
  {
    const high = timing.analyze(series(saleEvery14(3), 120));
    T.check(high.recommendation.action === 'WAIT', '2주마다 할인하는 상품의 평소가 → WAIT', high.recommendation);
    T.check(high.forecast.method === 'empirical-analog' && high.forecast.dropProbability.pct5 >= 0.9,
      '14일 안 5% 하락 확률이 높게 나온다', high.forecast.dropProbability);
    T.check(high.forecast.expectedMin.p50 === 80000, '예상 최저가 중앙값 = 실제 할인가', high.forecast.expectedMin);
    T.check(high.backtest.verdict === 'reliable' && high.backtest.skill > 0.05,
      '백테스트: 기본값보다 낫다 (skill > 0.05)', high.backtest);
    T.check(high.backtest.bandCoverage >= 0.8, '백테스트: 실제 최저가가 예측 구간 안에 들어온 비율 ≥ 80%', high.backtest.bandCoverage);
    T.check(high.uncertainty.level === 'low', '표본 충분 · 검증 통과 → 불확실성 낮음', high.uncertainty);
    T.check(high.recommendation.reasons.some(r => /과거 \d+일 중 \d+일은 14일 안에 5% 이상/.test(r)),
      '근거 문장에 «실제로 있었던 날의 수» 가 있다', high.recommendation.reasons);

    const saleDay = series(saleEvery14(0), 111);
    const sd = timing.analyze(saleDay);
    T.check(saleDay[saleDay.length - 1].price === 80000 && sd.recommendation.action === 'BUY_NOW',
      '할인 당일 → BUY_NOW', sd.recommendation);
    T.check(sd.forecast.dropProbability.pct5 === 0, '할인 당일에서 더 내려간 적은 없다', sd.forecast.dropProbability);

    const dec = timing.analyze(series(i => Math.round(100000 * Math.pow(0.995, i)), 120));
    T.check(dec.recommendation.action === 'WAIT', '꾸준히 내려가는 상품 → WAIT', dec.recommendation);
    T.check(dec.backtest.verdict === 'reliable', '기본값 자체가 정확해 skill 이 0 이어도 절대 정확도로 믿을 만하다', dec.backtest);
    T.check(dec.recommendation.cautions.some(c => /이미 싼 편이지만/.test(c)),
      '판정 엔진은 «싼 편» 인데 WAIT 이면 그 이유를 밝힌다', dec.recommendation.cautions);

    const flat = timing.analyze(series(() => 50000, 60));
    T.check(flat.recommendation.action === 'NEUTRAL' && /언제 사도 비슷/.test(flat.recommendation.reasons.join(' ')),
      '고정가 → NEUTRAL, 언제 사도 비슷하다고 말한다', flat.recommendation);
  }

  /* ── 3. 통하지 않는 기록 ──────────────────────────────────── */
  T.section('예측이 통하지 않으면 권하지 않는다');
  {
    const rnd = prng(7);
    let p = 100000;
    const rw = timing.analyze(series(() => { p = Math.round(p * (1 + (rnd() - 0.5) * 0.06)); return p; }, 200));
    T.check(rw.backtest.verdict === 'weak', '무작위 보행 → 백테스트 weak', rw.backtest);
    T.check(rw.recommendation.action === 'NEUTRAL', '무작위 보행 → 행동을 권하지 않는다', rw.recommendation.action);
    T.check(rw.uncertainty.level === 'high', '무작위 보행 → 불확실성 높음', rw.uncertainty);

    const sparse = timing.analyze(series(i => (i % 3 === 0 ? 100000 - (i % 9) * 1000 : null), 60));
    T.check(sparse.forecast.method === 'volatility-band' && sparse.recommendation.action === 'NEUTRAL',
      '사례가 모자라면 변동성 밴드로 내려가고, 방향을 모르므로 행동을 권하지 않는다', sparse.forecast.method);
    T.check(sparse.forecast.expectedMin.p10 <= sparse.forecast.expectedMin.p50
      && sparse.forecast.expectedMin.p50 <= sparse.forecast.expectedMin.p90
      && sparse.forecast.expectedMin.p90 <= sparse.forecast.currentPrice, '변동성 밴드 분위는 순서대로이고 현재가 이하');
  }

  /* ── 4. 누설 없음 ─────────────────────────────────────────── */
  T.section('백테스트에 미래가 새지 않는다');
  {
    const rnd = prng(42);
    const pts = series(i => {
      const base = saleEvery14(1)(i);
      return Math.round(base * (1 + (rnd() - 0.5) * 0.04));
    }, 150);
    const clean = I.cleanPoints(pts, kstToday());
    const bt = I.backtestOf(clean, I.positionsOf(clean), I.futuresOf(clean, 14), 14);
    T.check(bt.trace.length >= 60, '검증한 날이 충분하다', bt.trace.length);
    let mismatches = 0, compared = 0;
    for (let k = 0; k < bt.trace.length; k += 7) {
      const tr = bt.trace[k];
      const idx = pts.findIndex(p => p.date === tr.date);
      const prefix = timing.analyze(pts.slice(0, idx + 1), { today: tr.date, horizon: 14 });
      compared++;
      const f = prefix.forecast;
      if (f.method !== 'empirical-analog' || f.dropProbability.pct5 !== tr.prob
        || f.expectedMin.p10 !== tr.band[0] || f.expectedMin.p90 !== tr.band[1]) mismatches++;
    }
    T.check(compared >= 8 && mismatches === 0,
      `시점 t 의 백테스트 예측 = t 까지 자른 기록으로 새로 계산한 예측 (${compared}개 시점)`, { compared, mismatches });

    // 끝이 덜 지난 창을 표본으로 쓰지 않는다
    const fut = I.futuresOf(clean, 14);
    const lastDay = clean[clean.length - 1].d;
    T.check(fut.every((f, i) => !f.complete || clean[i].d + 14 <= lastDay), '다 지나지 않은 창은 표본이 아니다');
  }

  /* ── 5. 절약 가정은 낙관하지 않는다 ───────────────────────── */
  T.section('절약 가정');
  {
    // 100일 동안 2주 할인 주기 → 마지막 40일은 할인 없이 계속 오른다
    const pts = series(i => (i < 100 ? saleEvery14(0)(i) : 100000 + (i - 99) * 800), 140);
    const clean = I.cleanPoints(pts, kstToday());
    const bt = I.backtestOf(clean, I.positionsOf(clean), I.futuresOf(clean, 14), 14);
    T.check(bt.trace.some(r => r.saving !== null && r.saving < 0),
      '패턴이 깨지면 «기다려라» 의 절약은 음수로 기록된다 (창 끝 가격에 샀다고 본다)');
  }

  /* ── 6. 모순 방지 ─────────────────────────────────────────── */
  T.section('판정 엔진과 모순되지 않는다');
  {
    const r1 = I.reconcile('BUY_NOW', { dealVerdict: 'WAIT', backtest: { verdict: 'reliable' } });
    T.check(r1.action === 'NEUTRAL' && r1.notes.length === 1, '판정 WAIT 인데 BUY_NOW → NEUTRAL');
    const r2 = I.reconcile('BUY_NOW', { dealVerdict: 'DONT_BUY', backtest: null });
    T.check(r2.action === 'NEUTRAL', '판정 DONT_BUY 인데 BUY_NOW → NEUTRAL');
    const r3 = I.reconcile('WAIT', { dealVerdict: 'NORMAL', backtest: { verdict: 'weak' } });
    T.check(r3.action === 'NEUTRAL', '백테스트 weak → WAIT 도 권하지 않는다');

    const rnd = prng(2026);
    let violations = 0, buys = 0;
    for (let k = 0; k < 200; k++) {
      const n = 40 + Math.floor(rnd() * 120);
      const amp = 0.02 + rnd() * 0.25;
      const period = 5 + Math.floor(rnd() * 20);
      let p = 20000 + Math.floor(rnd() * 200000);
      const pts = series(i => {
        if (rnd() < 0.1) return null;
        p = Math.max(1000, Math.round(p * (1 + (rnd() - 0.5) * amp * 0.3)));
        return Math.round(p * (1 - (i % period === 0 ? amp : 0)));
      }, n);
      const r = timing.analyze(pts);
      if (r.recommendation.action === 'BUY_NOW') {
        buys++;
        if (r.deal && ['WAIT', 'DONT_BUY'].indexOf(r.deal.verdict) > -1) violations++;
      }
      if (r.forecast.dropProbability) {
        const d = r.forecast.dropProbability;
        if (!(d.pct3 >= d.pct5 && d.pct5 >= d.pct10)) violations++;
      }
    }
    T.check(violations === 0, `무작위 200개: BUY_NOW 와 판정 WAIT/DONT_BUY 가 겹치지 않고, 하락 확률은 3%≥5%≥10% (BUY_NOW ${buys}건)`, violations);
  }

  /* ── 7. 수학 도구 ─────────────────────────────────────────── */
  T.section('수학 도구');
  T.check(Math.abs(I.normCdf(0) - 0.5) < 1e-7 && Math.abs(I.normCdf(1.6449) - 0.95) < 1e-4
    && Math.abs(I.normCdf(-1.96) - 0.025) < 1e-4, '정규 누적분포 근사');
  T.check(I.quantile([1, 2, 3, 4], 0.5) === 2.5 && I.quantile([5], 0.9) === 5, '분위(선형 보간)');
  {
    const a = JSON.stringify(timing.analyze(series(saleEvery14(3), 90)));
    const b = JSON.stringify(timing.analyze(series(saleEvery14(3), 90)));
    T.check(a === b, '같은 입력 → 같은 출력 (결정론)');
    const h7 = timing.analyze(series(saleEvery14(3), 90), { horizon: 7 });
    const h30 = timing.analyze(series(saleEvery14(3), 90), { horizon: 30 });
    const hx = timing.analyze(series(saleEvery14(3), 90), { horizon: 5 });
    T.check(h7.forecast.horizonDays === 7 && h30.forecast.horizonDays === 30 && hx.forecast.horizonDays === 14,
      '기간 7·30 을 받고, 허용 밖이면 14');
    const t0 = Date.now();
    for (let k = 0; k < 5; k++) timing.analyze(series(i => 100000 + Math.round(Math.sin(i / 5) * 5000), 365));
    const ms = (Date.now() - t0) / 5;
    T.check(ms < 150, `365일 기록 분석 ${ms.toFixed(1)}ms (< 150ms)`);
  }

  /* ── 8. 핸들러 ────────────────────────────────────────────── */
  T.section('GET /api/timing');
  db.products = [{ product_id: '700', mall: '쿠팡', vendor_item_id: '7001', title: '2주마다 할인하는 상품', lprice: 100000,
    oprice: 0, image: 'https://img.example/a.jpg', link: 'https://link.coupang.com/a?itemId=1&vendorItemId=7001',
    keyword: '테스트', collected_at: new Date().toISOString() }];
  const prices = [];
  for (let i = 0; i < 120; i++) prices.push(saleEvery14(3)(i));
  db.price_history = kit.historyRows({ productId: '700', vendorItemId: '7001', prices })
    .concat(kit.historyRows({ productId: '700', vendorItemId: '7999', prices: [5000, 5000, 5000], startId: 5000 }));
  {
    const res = mkRes();
    await api.handler(mkReq({ query: {} }), res);
    T.check(res.statusCode === 400 && res.body.code === 'BAD_INPUT', 'productId 없음 → 400');
    const r2 = mkRes();
    await api.handler(mkReq({ query: { productId: '700', horizon: '5' } }), r2);
    T.check(r2.statusCode === 400, '허용 밖 기간 → 400', r2.body);
    const r3 = mkRes();
    await api.handler(mkReq({ method: 'POST', query: { productId: '700' } }), r3);
    T.check(r3.statusCode === 405, 'POST → 405');
  }
  {
    const res = mkRes();
    await api.handler(mkReq({ query: { productId: '700', mall: '쿠팡' } }), res);
    const b = res.body || {};
    const fields = ['ok', 'asOf', 'product', 'observations', 'firstDate', 'lastDate', 'staleDays', 'level', 'deal',
      'forecast', 'recommendation', 'backtest', 'uncertainty', 'points'];
    T.check(res.statusCode === 200 && fields.every(f => f in b), '계약 필드가 전부 있다', Object.keys(b));
    T.check(b.product.title === '2주마다 할인하는 상품' && b.product.vendorItemId === '7001', '상품 요약 · 옵션 식별자');
    T.check(b.points.length === 120 && b.points.every(p => p.price >= 80000), '다른 옵션(5,000원)의 기록이 섞이지 않는다');
    T.check(b.recommendation.action === 'WAIT', 'API 도 평소가 → WAIT', b.recommendation);
    T.check(/s-maxage=300/.test(res.headers['cache-control'] || ''), '공개 캐시 5분');
    T.check(res.headers['access-control-allow-origin'] === '*', 'public CORS');

    const viaHistory = mkRes();
    await history(mkReq({ query: { __route: 'timing', productId: '700', mall: '쿠팡' } }), viaHistory);
    T.check(viaHistory.body && viaHistory.body.recommendation && viaHistory.body.recommendation.action === 'WAIT',
      '/api/history?__route=timing 으로도 같은 답 (vercel rewrite 경로)');
    const legacy = mkRes();
    await history(mkReq({ query: { productId: '700', mall: '쿠팡', vendorItemId: '7001' } }), legacy);
    T.check(JSON.stringify(legacy.body) === JSON.stringify(b.points), '차트 점이 기존 /api/history 와 같다');
  }
  {
    state.failNext.price_history = 'connection reset';
    const res = mkRes();
    const origErr = console.error; console.error = () => {};
    await api.handler(mkReq({ query: { productId: '700' } }), res);
    console.error = origErr;
    T.check(res.statusCode === 500 && !/connection reset/.test(JSON.stringify(res.body)), 'DB 오류 → 500, 내부 메시지는 새지 않는다', res.body);
  }

  T.section('안전');
  T.check(state.writes.length === 0, '어떤 표에도 쓰지 않았다', state.writes);
  T.check(fetchCalls.length === 0, '외부 호출 0회', fetchCalls);

  T.done();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
