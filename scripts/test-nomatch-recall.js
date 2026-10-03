#!/usr/bin/env node
'use strict';

/*
 * NO_MATCH recall: measured recovery prior, recent-first ladder order, exact matching,
 * read-only analysis, ADPICK run-time configuration. Offline: no DB, no provider.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
Object.assign(process.env, { PRICE_BATCH_INTERVAL_MS: '1', PRICE_SECOND_PASS: '1', PRICE_SECOND_PASS_ROUNDS: '3',
  PRICE_SECOND_PASS_MAX_CALLS: '1', PRICE_CACHE_HINT: '0', PRICE_FACET_MIN_GROUP: '100' });

function inject(rel, value) {
  const file = require.resolve(path.join(__dirname, '..', rel));
  const mod = new Module(file); mod.filename = file; mod.loaded = true; mod.exports = value;
  require.cache[file] = mod;
}
const forbidden = () => { throw new Error('Unexpected real database/provider access in offline test'); };
inject('api/_supabase.js', { from: forbidden, rpc: forbidden });
inject('api/_notify.js', { send: forbidden });
inject('api/_coupang.js', { searchCoupang: forbidden, isBlocked: () => false, localStats: () => ({}) });
inject('api/_adpick.js', { searchAdpick: forbidden, isBlocked: () => false, localStats: () => ({}),
  hasKey: () => false, recordExternalCall: forbidden, redact: String });
const Planner = require('../api/_collectplan');
const Q = require('../api/_query');
const C = require('./collect-all-prices');
const { adpickProductId } = require('../api/_shop');
const A = require('./_nomatch-analysis');
const { loadSnapshot } = require('./analyze-nomatch');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.error(`[FAIL] ${name}: ${e.stack || e.message}`); }
}
const DAY = 86400000;
const dayStartMs = Date.parse('2026-10-03T00:00:00+09:00');
const at = days => new Date(dayStartMs - days * DAY + 3600000).toISOString();

async function main() {
  // ── measured prior and queue order ──────────────────────────────────────
  await test('Coupang recovery prior: last price ≤7 days 0.587, older or never 0.071 (2026-10-03 replay)', () => {
    assert.equal(Planner.recoveryProbability('쿠팡', 0), 0.587);
    assert.equal(Planner.recoveryProbability('쿠팡', 7), 0.587);
    assert.equal(Planner.recoveryProbability('쿠팡', 7.01), 0.071);
    assert.equal(Planner.recoveryProbability('쿠팡', null), 0.071);
    assert.equal(Planner.recoveryProbability('쿠팡', Infinity), 0.071);
  });
  await test('ADPICK prior is flat (49 executed queries cannot separate the classes)', () => {
    assert.equal(Planner.recoveryProbability('ADPICK', 1), Planner.recoveryProbability('ADPICK', 30));
  });
  await test('queue: a recently priced target outranks a shared query of stale targets', () => {
    const recent = { collected_at: at(2) }, stale = { collected_at: at(20) };
    const out = Planner.orderRecoveryQueue([
      { q: 'stale shared', rows: [stale, { ...stale }] }, { q: 'recent single', rows: [recent] }
    ], { mall: '쿠팡', dayStartMs });
    assert.deepEqual(out.map(x => x.q), ['recent single', 'stale shared']);
  });
  await test('queue ties keep the previous order: shared count, then original position', () => {
    const r = () => ({ collected_at: at(1) });
    const out = Planner.orderRecoveryQueue([{ q: 'a', rows: [r()] }, { q: 'b', rows: [r(), r()] }, { q: 'c', rows: [r()] }],
      { mall: '쿠팡', dayStartMs });
    assert.deepEqual(out.map(x => x.q), ['b', 'a', 'c']);
  });
  await test('ADPICK queue order equals the previous shared-count order', () => {
    const rows = n => Array.from({ length: n }, (_, i) => ({ collected_at: at(i * 9) }));
    const queue = [{ q: 'x', rows: rows(1) }, { q: 'y', rows: rows(3) }, { q: 'z', rows: rows(1) }, { q: 'w', rows: rows(2) }];
    const before = [...queue].sort((a, b) => b.rows.length - a.rows.length).map(x => x.q);
    assert.deepEqual(Planner.orderRecoveryQueue(queue, { mall: 'ADPICK', dayStartMs }).map(x => x.q), before);
  });

  // ── ladder candidates: refactor keeps the exact output ──────────────────
  await test('typed ladder candidates are exactly the existing ladder queries, in order', () => {
    const titles = ['삼성전자 갤럭시 버즈3 프로 SM-R630 블루투스 이어폰, 화이트', 'LG 그램 16Z90R 노트북 16인치',
      '쿠쿠 정품 CRP-DHAS069FWM 전용 밥솥 컨트롤 패킹 [신형] (비닐포장)', '파워에이드 마운틴블라스트', '',
      '[무료배송] 2026 최신 인기 초경량 프리미엄 여행용 캐리어 28인치', '환타 파인애플 500ml 업소용, 355ml, 48개'];
    for (const title of titles) for (const opts of [undefined, { max: 3 }, { exclude: ['LG 16Z90R'] }]) {
      const p = { title, keyword: title.split(' ')[0] };
      const typed = Q.generateSecondPassCandidates(p, opts);
      assert.deepEqual(typed.map(c => c.query), Q.generateSecondPassQueries(p, opts), title);
      assert.ok(typed.every(c => typeof c.type === 'string' && c.type));
    }
    assert.equal(Q.generateSecondPassCandidates({ title: 'LG 그램 16Z90R 노트북' })[0].type, 'brand_model');
  });

  // ── end to end: the budget-limited ladder call goes to the recent target ──
  await test('one ladder call left: it goes to the recently priced target, not the earlier stale one', async () => {
    const stale = { product_id: 'S1', keyword: 'stale-kw', title: '오래된상품 스테일 모델 ABC1234 키보드', mall: '쿠팡',
      vendor_item_id: 'SV', link: '', image: '', collected_at: at(21) };
    const recent = { product_id: 'R1', keyword: 'recent-kw', title: '최근상품 리센트 모델 XYZ9876 마우스', mall: '쿠팡',
      vendor_item_id: 'RV', link: '', image: '', collected_at: at(2) };
    const calls = [];
    const recorded = [];
    await C.runMallCollection({ mallName: '쿠팡', rows: [stale, recent],
      fetchAllFn: async q => {
        calls.push(q);
        if (q === 'stale-kw' || q === 'recent-kw') return { ok: true, items: [], allItems: [] };   // pass 1: not found
        // A similar-title different product must never be adopted; the exact target is.
        const items = [{ productId: 'R1-SIMILAR', vendorItemId: 'RV', title: recent.title, lprice: 1000, link: '' },
          { productId: 'R1', vendorItemId: 'RV', title: recent.title, lprice: 9900, link: '' }];
        return { ok: true, items, allItems: items };
      },
      deadlineTs: Date.now() + 8000, collectedTodayFn: async () => new Set(), cacheHintFn: async () => new Map(),
      recordPricesFn: async obs => { recorded.push(...obs); return { saved: obs.length, recorded: obs.length, rejected: 0,
        suspect: 0, errors: [], recordedKeys: obs.map(o => `${o.productId}|${o.mall}`) }; } });
    const ladder = calls.filter(q => q !== 'stale-kw' && q !== 'recent-kw');
    assert.equal(ladder.length, 1, JSON.stringify(calls));
    assert.ok(Q.generateSecondPassQueries(recent).includes(ladder[0]), ladder[0]);
    assert.deepEqual(recorded.map(o => [o.productId, o.vendorItemId, o.price]), [['R1', 'RV', 9900]]);
  });

  // ── read-only analysis ──────────────────────────────────────────────────
  const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
  await test('identity rules: Coupang needs productId+vendorItemId; ADPICK equals _shop.adpickProductId', () => {
    assert.equal(A.itemIdentity('쿠팡', { productId: 1, vendorItemId: 2 }), '1|2');
    assert.equal(A.itemIdentity('쿠팡', { productId: 1, link: 'https://x?vendorItemId=9' }), '1|9');
    const link = 'https://biz.adpick.co.kr/r4782964';
    assert.equal(A.itemIdentity('ADPICK', { commissionlink: link }), adpickProductId(link));
  });
  const today = '2026-10-03';
  const cache = (keyword, items) => ({ keyword, items, fetched_at: '2026-10-03T01:00:00+00:00' });
  const P = (id, keyword, title, last, extra = {}) => ({ product_id: id, mall: '쿠팡', keyword, title, link: '',
    vendor_item_id: `${id}V`, collected_at: null, lprice: 10000, _last: last, ...extra });
  const it = (id, title, vid = `${id}V`, price = 10000) => ({ productId: id, vendorItemId: vid, title, lprice: price, link: '' });
  const products = [
    P('H', 'kh', '에이치 상품 키보드', '2026-10-02'),
    P('N', 'kn', '엔 상품 마우스', '2026-10-01'),
    P('E', 'ke', '이 상품 이어폰 화이트', '2026-09-01'),
    P('G', 'kg', '지 상품 스피커', '2026-09-10'),
    P('F', 'kf', '에프브랜드 무선 충전기 15W 고속', '2026-10-01'),
    P('A', 'ka', '에이브랜드 텀블러 500ml', '2026-09-30'),
    P('OK', 'kok', '오케이 상품 모니터', '2026-10-02')
  ];
  const snapshot = {
    today, dayStartIso: '2026-10-02T15:00:00.000Z', products,
    lastPrice: { '쿠팡': Object.fromEntries(products.map(p => [p.product_id, p._last])) },
    malls: { '쿠팡': { attempted: products.map(p => `${p.product_id}|쿠팡`), covered: ['OK|쿠팡'], option: [] } },
    caches: { '쿠팡': [
      cache('kh', []), cache('elsewhere', [it('H', '에이치 상품 키보드')]),
      cache('kn', []),
      cache('ke', [it('E2', '이 상품 이어폰 화이트', 'E2V', 10500)]),
      cache('kg', [it('X', '무관한 상품')]),
      cache('kf', [it('F2', '에프브랜드 무선 충전기 15W 급속')]),
      cache('ka', [it('Z', '다른 브랜드 물건')]),
      cache('kok', [it('OK', '오케이 상품 모니터')]),
      cache('old', [it('A', '에이브랜드 텀블러 500ml')])].map((c, i) => (i === 8 ? { ...c, fetched_at: '2026-10-01T01:00:00+00:00' } : c))
    }
  };
  const { report, relist } = A.analyze(snapshot);
  const r = report.malls['쿠팡'];
  await test('cause rules: exact-in-answer, empty answer, same title new id, stale, similar-only, recent rank miss', () => {
    assert.deepEqual(r.causes, { H_exact_item_in_todays_answers: 1, NO_RESULT_empty_answer: 1, E_same_title_new_id: 1,
      G_stale_not_in_any_answer: 1, F_similar_only_in_keyword_answer: 1, A_recent_dropped_from_keyword_ranking: 1 });
    assert.equal(r.nomatch, 6);
  });
  await test('yesterday\'s cached answer is not evidence for today', () => {
    assert.equal(r.causes.H_exact_item_in_todays_answers, 1);  // A's only sighting is in the 10-01 cache
  });
  await test('re-registration candidates are review-only and carry a price guard', () => {
    assert.equal(relist.length, 1);
    assert.equal(relist[0].reviewRequired, true);
    assert.equal(relist[0].passesPriceGuard, true);
    assert.equal(relist[0].oldProductId, 'E'); assert.equal(relist[0].newProductId, 'E2');
    assert.ok(!('replace' in relist[0]) && !('newVendorItemId' in relist[0]));
  });
  await test('ladder rates count only alternates actually executed today, exact identity only', () => {
    const p = P('L', 'kl', '엘브랜드 블렌더 BL500 주방', '2026-10-02');
    const alt = Q.generateSecondPassQueries(p)[0];
    const snap = { ...snapshot, products: [p], lastPrice: { '쿠팡': { L: '2026-10-02' } },
      malls: { '쿠팡': { attempted: ['L|쿠팡'], covered: ['L|쿠팡'], option: [] } },
      caches: { '쿠팡': [cache('kl', []), cache(alt, [it('L', p.title, 'OTHER'), it('L', p.title)])] } };
    const out = A.analyze(snap).report.malls['쿠팡'];
    assert.deepEqual(out.ladder.recent, { tried: 1, recovered: 1, queries: 1, stillNomatch: 0 });
    const wrongOption = { ...snap, caches: { '쿠팡': [cache('kl', []), cache(alt, [it('L', p.title, 'OTHER')])] } };
    const w = A.analyze(wrongOption).report.malls['쿠팡'];
    assert.equal(w.ladder.recent.recovered, 0);
    assert.equal(Object.values(w.strategies.recent)[0].otherOption, 1);
  });
  await test('counterfactual: same ladder calls, recent first, expected from measured class rates', () => {
    const cf = A.counterfactual({ ladder: { recent: { tried: 10, recovered: 6, queries: 10, stillNomatch: 2 },
      stale: { tried: 10, recovered: 1, queries: 10, stillNomatch: 9 } },
      causes: { A_recent_dropped_from_keyword_ranking: 12, G_stale_not_in_any_answer: 20 } });
    // pool = 10 tried + (12 - 2) untried = 20 recent; 20 calls → 20 recent × 0.6 = 12 (actual 7)
    assert.equal(cf.recentPool, 20); assert.equal(cf.expectedRecovered, 12); assert.equal(cf.expectedGain, 5);
  });
  await test('analysis loader uses SELECT only and refuses a stale collector state', async () => {
    const used = new Set();
    const builder = (table, rows) => {
      const b = new Proxy({}, { get(_, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve({ data: rows(table), error: null }).then(res, rej);
        used.add(prop); return () => b;
      } });
      return b;
    };
    const db = { from: table => ({ select: () => builder(table, t => (t === 'price_job_state'
      ? [{ job_date: C.kstToday(), last_result: { malls: { '쿠팡': { collectorAttempted: ['1|쿠팡'] } } } }] : [])) }) };
    const snap = await loadSnapshot(db);
    assert.ok([...used].every(m => ['limit', 'in', 'eq', 'gte', 'lt', 'order', 'gt'].includes(m)), [...used].join(','));
    assert.deepEqual(Object.keys(snap.malls), ['쿠팡']);
    const stale = { from: () => ({ select: () => builder('x', () => [{ job_date: '2000-01-01', last_result: {} }]) }) };
    await assert.rejects(() => loadSnapshot(stale), /not today/);
  });

  // ── ADPICK run time: longer runs, same rate and daily cap ────────────────
  await test('workflow: run budget fits the job timeout; ADPICK per-run cap covers the run; rate and daily cap unchanged', () => {
    const y = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daily-prices.yml'), 'utf8');
    const num = re => Number((re.exec(y) || [])[1]);
    const timeoutMin = num(/timeout-minutes:\s*(\d+)/), budgetMs = num(/PRICE_RUN_BUDGET_MS:\s*'(\d+)'/);
    const perMin = num(/ADPICK_MAX_PER_MIN:\s*'(\d+)'/), runCap = num(/ADPICK_RUN_BUDGET:\s*'(\d+)'/);
    const dayCap = num(/ADPICK_DAY_BUDGET:\s*'(\d+)'/), gap = num(/ADPICK_COLLECT_MIN_GAP_MS:\s*'(\d+)'/);
    assert.equal(budgetMs, 85 * 60000);
    assert.ok(timeoutMin * 60000 >= budgetMs + 20 * 60000, 'job timeout leaves ≥20 min for setup, flush and alerts');
    assert.ok(runCap >= Math.ceil(budgetMs / 60000) * perMin, 'per-run cap must not end the ADPICK lane early');
    assert.equal(perMin, 5); assert.equal(gap, 12000); assert.equal(dayCap, 3000);
    assert.ok(budgetMs > C.LOCK_TTL_MS, 'documented: runs outlive the TTL only through checkpoint heartbeats');
  });

  console.log(`NO_MATCH recall: ${pass} PASS / ${fail} FAIL`);
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
