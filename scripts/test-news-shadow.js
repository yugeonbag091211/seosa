#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../api/_market-registry');
const NI = require('../api/_news-intelligence');
const F = require('../api/_news-fetch');
const SHADOW = require('../api/_news-shadow-store');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
function event(overrides) {
  return Object.assign({
    eventId: Math.random().toString(36), eventType: 'SUPPLY_DECREASE', nodes: ['dram'],
    items: [], independentSources: 2, independentSourceCount: 2,
    officialSources: 2, govSources: 0, gdeltOnly: false, singleCompanyPR: false,
    eventStartAt: '2026-01-01T00:00:00.000Z', firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-09-09T00:00:00.000Z', lastConfirmedAt: '2026-09-09T00:00:00.000Z',
    ageDays: 1, oldestAgeDays: 250, maxTrust: 28, rawStrength: 0.65,
    direction: 1
  }, overrides || {});
}

(async () => {
  console.log('\nV2 SHADOW INTELLIGENCE');

  await test('새 event는 ACTIVE이며 lifecycle schema가 완성된다', () => {
    const e = NI.lifecycleEvent(event(), []);
    assert.strictEqual(e.status, 'ACTIVE');
    ['firstSeenAt', 'lastSeenAt', 'lastConfirmedAt', 'eventStartAt', 'expectedEndAt', 'rawStrength', 'effectiveStrength'].forEach(k => assert.ok(e[k] != null));
  });
  await test('반감기는 지났지만 horizon 안인 event는 WEAKENING이다', () => {
    assert.strictEqual(NI.eventStatus(event({ ageDays: 40, oldestAgeDays: 40 }), []), 'WEAKENING');
  });
  await test('짧은 사건은 만료되고 오래된 구조 정책은 영향이 남는다', () => {
    assert.strictEqual(NI.eventStatus(event({ eventType: 'LOGISTICS_DISRUPTION', ageDays: 40 }), []), 'EXPIRED');
    assert.strictEqual(NI.eventStatus(event({ eventType: 'TARIFF_INCREASE', ageDays: 100 }), []), 'ACTIVE');
  });
  await test('새 확인은 오래 시작된 event를 ACTIVE로 갱신한다', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const rows = [
      { title: 'DRAM production cut confirmed by market 감산', url: 'https://www.micron.com/news/old', publishedAt: '2026-07-31T00:00:00Z' },
      { title: 'DRAM production cut confirmed by market 감산', url: 'https://news.skhynix.com/news/new', publishedAt: '2026-09-09T00:00:00Z' }
    ].map(x => NI.normalizeItem(x, now)).map(x => Object.assign({}, x, NI.classify(x)));
    const events = NI.clusterEvents(rows);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].status, 'ACTIVE');
    assert.strictEqual(events[0].independentSourceCount, 2);
  });

  await test('403은 source를 BLOCKED로 만들고 backoff를 건다', () => {
    F.clearSourceBackoff();
    F.noteSourceAttempt('blocked.example', 1000);
    F.noteSourceResult('blocked.example', { ok: false, status: 403, error: 'forbidden', latencyMs: 20 }, 1000);
    const h = F.sourceHealthSnapshot().find(x => x.sourceId === 'blocked.example');
    assert.strictEqual(h.status, 'BLOCKED'); assert.strictEqual(h.http403Count, 1); assert.ok(h.backoffUntil);
  });
  await test('backoff 중 같은 source는 다시 호출하지 않는다', async () => {
    let calls = 0;
    const r = await F.fetchFeeds({ feeds: [{ host: 'blocked.example', url: 'https://blocked.example/rss' }], now: new Date(1001), gapMs: 0, getFn: async () => { calls++; return { ok: true, status: 200, text: '' }; } });
    assert.strictEqual(calls, 0); assert.strictEqual(r.stats.skippedBackoff, 1);
  });
  await test('backoff 뒤 성공하면 HEALTHY로 회복한다', () => {
    F.noteSourceAttempt('blocked.example', 86401002);
    F.noteSourceResult('blocked.example', { ok: true, status: 200, latencyMs: 10 }, 86401002);
    const h = F.sourceHealthSnapshot().find(x => x.sourceId === 'blocked.example');
    assert.strictEqual(h.status, 'HEALTHY'); assert.strictEqual(h.consecutiveFailures, 0); assert.strictEqual(h.backoffUntil, null);
  });

  await test('독립 반대 사건은 contradiction pair와 penalty를 만든다', () => {
    const a = event({ eventId: 'a', eventType: 'SUPPLY_DECREASE', direction: 1 });
    const b = event({ eventId: 'b', eventType: 'SUPPLY_INCREASE', direction: -1 });
    const p = NI.contradictionPairs([a, b], 'ram');
    assert.strictEqual(p.length, 1); assert.strictEqual(p[0].penalty, 35);
  });
  await test('상충 신호는 공격적 결정을 차단한다', () => {
    const a = event({ eventId: 'a', eventType: 'SUPPLY_DECREASE', direction: 1 });
    const b = event({ eventId: 'b', eventType: 'SUPPLY_INCREASE', direction: -1 });
    const adv = NI.advise({ categoryId: 'ram', events: [a, b], stat: { count: 30, low: 80, high: 120, avg30: 100, trendPct: 2 }, price: 85, dealPercentile: .125, dealVerdict: 'BUY' });
    assert.notStrictEqual(adv.advice, 'BUY'); assert.ok(adv.news.contradictionCount > 0);
  });

  await test('그래프 직접/간접 영향은 hop마다 약해진다', () => {
    const direct = R.impactTo('laptop', 'cpu');
    const indirect = R.impactTo('laptop', 'wafer');
    assert.deepStrictEqual(direct.path, ['laptop', 'cpu']);
    assert.ok(direct.impact > indirect.impact); assert.strictEqual(direct.hops, 1); assert.strictEqual(indirect.hops, 2);
    assert.strictEqual(R.layerOf('laptop'), 'PRODUCT_CATEGORY');
    assert.ok(R.marketHierarchyOf('laptop').some(x => x.layer === 'INDUSTRY'));
  });
  await test('실제 graph path가 없으면 영향도도 없다', () => {
    assert.strictEqual(R.impactTo('coffee', 'hbm'), null);
  });
  await test('registry event type마다 halfLifeDays가 있다', () => {
    Object.values(R.EVENT_TYPES).forEach(x => assert.ok(Number.isFinite(x.halfLifeDays)));
  });

  await test('가격 방향 일치는 confirmation과 confidence를 높인다', () => {
    assert.strictEqual(NI.confirmWithPrice(1, { count: 30, change7d: 3 }, 100).status, 'CONFIRMED');
    const e = event();
    assert.ok(NI.confidenceOf(e, .7, { priceConfirmation: 'CONFIRMED' }).score >
      NI.confidenceOf(e, .7, { priceConfirmation: 'NOT_YET_CONFIRMED' }).score);
  });
  await test('가격 방향이 반대면 CONTRADICTED, 표본 부족은 별도다', () => {
    assert.strictEqual(NI.confirmWithPrice(1, { count: 30, change7d: -3 }, 100).status, 'CONTRADICTED');
    assert.strictEqual(NI.confirmWithPrice(1, { count: 3, change7d: 3 }, 100).status, 'INSUFFICIENT_PRICE_DATA');
  });
  await test('가격 contradiction은 confidence를 낮춘다', () => {
    const e = event();
    assert.ok(NI.confidenceOf(e, .7, { priceConfirmation: 'CONTRADICTED' }).score <
      NI.confidenceOf(e, .7, { priceConfirmation: 'NOT_YET_CONFIRMED' }).score);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seosa-shadow-'));
  const predictions = path.join(dir, 'predictions.jsonl');
  try {
    const prediction = SHADOW.normalizePrediction({
      createdAt: '2026-09-01T00:00:00Z', product: 'p1', category: 'ram', decision: 'BUY',
      newsPressureScore: 60, priceOpportunityScore: 70, confidence: 80,
      evidenceIds: ['article-1'], eventIds: ['event-1'], currentPrice: 100,
      priceStatsSnapshot: { observationCount: 30 }, coverageStatus: 'SUPPORTED'
    });
    await test('같은 shadow prediction은 정확히 한 번만 저장된다', () => {
      const a = SHADOW.appendPrediction(prediction, predictions);
      const b = SHADOW.appendPrediction(prediction, predictions);
      assert.strictEqual(a.saved, true); assert.strictEqual(b.duplicate, true);
      assert.strictEqual(SHADOW.loadPredictions(predictions).length, 1);
    });
    await test('+1/+3/+7일 outcome이 각각 평가된다', () => {
      const evaluation = SHADOW.evaluatePrediction(prediction, [
        { at: '2026-09-02T00:00:00Z', price: 101 },
        { at: '2026-09-04T00:00:00Z', price: 103 },
        { at: '2026-09-08T00:00:00Z', price: 107 }
      ], '2026-09-08T01:00:00Z');
      assert.strictEqual(evaluation.horizons['1d'].changePct, 1);
      assert.strictEqual(evaluation.horizons['3d'].changePct, 3);
      assert.strictEqual(evaluation.horizons['7d'].changePct, 7);
    });
    await test('평가 시점 전 horizon만 evaluable이다', () => {
      const evaluation = SHADOW.evaluatePrediction(prediction, [{ at: '2026-09-02T00:00:00Z', price: 101 }], '2026-09-02T01:00:00Z');
      assert.ok(evaluation.horizons['1d']); assert.strictEqual(evaluation.horizons['3d'], null); assert.strictEqual(evaluation.horizons['7d'], null);
    });
    await test('confidence는 확률이 아니라 근거 강도로 저장된다', () => {
      assert.strictEqual(prediction.confidenceMeaning, 'EVIDENCE_STRENGTH_NOT_PROBABILITY');
      assert.strictEqual(JSON.stringify(prediction).includes('probability'), false);
    });
    await test('최소 표본 미달 calibration은 숫자를 만들지 않는다', () => {
      const c = SHADOW.calibration([], 30);
      assert.strictEqual(c.status, 'NOT_ENOUGH_DATA_TO_CALIBRATE');
      assert.strictEqual(c.directionAccuracyByConfidenceLevel, undefined);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await test('UNSUPPORTED 카테고리는 계속 NO_DECISION이다', () => {
    assert.strictEqual(NI.advise({ categoryId: 'coffee', events: [event({ nodes: ['coffee_bean'] })] }).advice, 'NO_DECISION');
  });

  console.log(`\n───── PASS ${pass} / FAIL ${fail}\n`);
  if (fail) process.exitCode = 1;
})();
