#!/usr/bin/env node
'use strict';
/*
 * SEOSA HOT 수집기.
 *
 * ── 왜 별도 스크립트인가 ───────────────────────────────────────────
 *
 * 가격 수집(scripts/collect-all-prices.js)과 한 덩어리로 묶지 않는다.
 * 그쪽은 쿠팡·ADPICK 호출 예산을 하루 단위로 관리하는 무거운 작업이고,
 * 핫딜 판정은 그 결과를 «읽어서» 계산하는 가벼운 작업이다. 묶으면
 *   · 핫딜 계산이 터졌을 때 가격 수집까지 같이 죽고
 *   · 가격 수집이 오래 걸리면 핫딜이 갱신되지 않는다
 * 실패를 서로 옮기지 않도록 분리한다.
 *
 * ── 순서 ───────────────────────────────────────────────────────────
 *
 *   1) 최근 수집된 상품을 읽는다 (products)
 *   2) 그 상품들의 관측 이력을 한 번에 읽는다 (price_history)
 *   3) 후보로 정규화하고 api/_hotdeal.js 로 판정한다
 *   4) 노출 가치가 있는 것만 upsert 한다 (중복 INSERT 하지 않는다)
 *   5) 오래된 딜의 생애주기를 정리한다
 *
 * ── 안전장치 ───────────────────────────────────────────────────────
 *
 *   · 잠금  — 같은 시각 두 번 돌아도 한쪽만 일한다
 *   · 예산  — RUN_BUDGET_MS 를 넘기면 남은 것을 다음 회차로 넘긴다
 *   · 격리  — source 하나가 실패해도 나머지는 계속한다
 *   · 키    — 로그에 어떤 비밀값도 남기지 않는다 (외부 호출 자체가 없다)
 *
 * 사용법
 *   node scripts/collect-hotdeals.js            실제 수집
 *   node scripts/collect-hotdeals.js --dry-run  판정만 하고 쓰지 않는다
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
for (const f of ['.env.local', '.env']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) { require('dotenv').config({ path: p }); break; }
}

const supabase = require('../api/_supabase');
const HD = require('../api/_hotdeal');
const HS = require('../api/_hotsource');
const { kstToday } = require('../api/_kst');

const DRY = process.argv.indexOf('--dry-run') > -1;

/** 이 시간을 넘기면 남은 상품은 다음 회차로 넘긴다. */
const RUN_BUDGET_MS = Number(process.env.HOTDEAL_RUN_BUDGET_MS) || 4 * 60 * 1000;
/** 후보로 볼 상품의 최대 개수. 한 회차가 무한정 커지지 않게 한다. */
const MAX_PRODUCTS = Number(process.env.HOTDEAL_MAX_PRODUCTS) || 4000;
/** price_history 를 며칠치까지 읽을지. */
const HISTORY_DAYS = 120;
/** products.collected_at 이 이보다 오래됐으면 현재가로 쓸 수 없다. */
const PRODUCT_FRESH_DAYS = 3;
/** in(...) 한 번에 넣을 product_id 개수. */
const CHUNK = 100;

const startedAt = Date.now();
const overBudget = () => Date.now() - startedAt > RUN_BUDGET_MS;

function log(msg, extra) {
  const line = { t: new Date().toISOString(), msg };
  if (extra) Object.assign(line, extra);
  console.log(JSON.stringify(line));
}

/* ── 잠금 ────────────────────────────────────────────────────────────
 *
 * price_job_state 를 재사용한다. 새 표를 만들지 않는다 — 이 작업은 하루 몇
 * 번 도는 가벼운 일이라 전용 잠금 인프라를 새로 세울 값어치가 없다.
 * job_date 를 'hotdeal-<날짜>' 로 두어 가격 수집 잠금과 섞이지 않게 한다.
 */
async function acquireLock(jobDate) {
  const key = `hotdeal-${jobDate}`;
  // --dry-run 은 아무것도 쓰지 않는다. 잠금도 쓰기이므로 건너뛴다.
  if (DRY) return { ok: true, key, skipLock: true };
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('price_job_state')
    .select('job_date, status, updated_at')
    .eq('job_date', key)
    .maybeSingle();
  if (error && !/does not exist|schema cache/i.test(error.message)) {
    log('lock_read_failed', { error: error.message });
    return { ok: true, key, skipLock: true };     // 잠금을 못 읽어도 일은 한다
  }
  if (error) return { ok: true, key, skipLock: true };

  if (data && data.status === 'running') {
    const age = Date.now() - Date.parse(data.updated_at || 0);
    if (age < 15 * 60 * 1000) return { ok: false, key };   // 다른 회차가 돌고 있다
  }
  const up = await supabase.from('price_job_state')
    .upsert({ job_date: key, status: 'running', updated_at: now }, { onConflict: 'job_date' });
  if (up.error) return { ok: true, key, skipLock: true };
  return { ok: true, key, skipLock: false };
}

async function releaseLock(lock, summary) {
  if (!lock || lock.skipLock) return;
  await supabase.from('price_job_state').upsert({
    job_date: lock.key,
    status: 'done',
    updated_at: new Date().toISOString(),
    last_result: summary
  }, { onConflict: 'job_date' }).then(r => {
    if (r.error) log('lock_release_failed', { error: r.error.message });
  });
}

/* ── 1) 후보 상품 ──────────────────────────────────────────────────── */

async function loadProducts() {
  const fresh = new Date(Date.now() - PRODUCT_FRESH_DAYS * 86400000).toISOString();
  const out = [];
  const PAGE = 1000;
  for (let from = 0; from < MAX_PRODUCTS; from += PAGE) {
    const { data, error } = await supabase
      .from('products')
      .select('product_id, mall, mall_label, vendor_item_id, title, lprice, oprice, image, link, collected_at')
      .gte('collected_at', fresh)
      .order('collected_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`products 조회 실패: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out.slice(0, MAX_PRODUCTS);
}

/* ── 2) 관측 이력 ──────────────────────────────────────────────────── */

/** `${product_id}|${mall}|${vendor_item_id}` → [{date, price}] */
async function loadHistory(products) {
  const cut = kstToday(new Date(Date.now() - HISTORY_DAYS * 86400000));
  const ids = [...new Set(products.map(p => String(p.product_id)))];
  const byKey = new Map();

  for (let i = 0; i < ids.length; i += CHUNK) {
    if (overBudget()) { log('history_budget_stop', { at: i, of: ids.length }); break; }
    const { data, error } = await supabase
      .from('price_history')
      .select('product_id, mall, vendor_item_id, price, recorded_date')
      .in('product_id', ids.slice(i, i + CHUNK))
      .gte('recorded_date', cut)
      .limit(20000);
    if (error) { log('history_chunk_failed', { error: error.message }); continue; }
    (data || []).forEach(r => {
      const key = `${r.product_id}|${r.mall || ''}|${r.vendor_item_id || ''}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ date: String(r.recorded_date).slice(0, 10), price: Math.round(Number(r.price) || 0) });
    });
  }
  return byKey;
}

/* ── 3~4) 판정 · 저장 ──────────────────────────────────────────────── */

function rowFor(product, cand, verdict, today) {
  const b = verdict.baseline;
  /*
   * 만료 시각.
   *
   * "무조건 7일" 같은 타이머로 정하지 않는다. 근거가 얼마나 신선한가로 정한다 —
   * 확신이 높을수록 오래 유효하고, 낮으면 금방 다시 확인해야 한다.
   * 어느 쪽이든 다음 회차가 현재가를 다시 보고 갱신한다.
   */
  const hours = verdict.confidence === 'HIGH' ? 48 : verdict.confidence === 'MEDIUM' ? 24 : 12;
  return {
    source: HS.INTERNAL_HISTORY.id,
    source_external_id: `${product.product_id}|${product.vendor_item_id || ''}`,
    mall: HS.normalizeMall(product.mall_label || product.mall),
    product_id: String(product.product_id),
    vendor_item_id: String(product.vendor_item_id || ''),
    title: cand.title,
    image: cand.image,
    affiliate_url: cand.affiliateUrl,
    current_price: cand.salePrice,
    source_reference_price: cand.referencePrice,
    deal_status: verdict.status,
    hot_score: verdict.hotScore,
    confidence: verdict.confidence,
    identity_confidence: verdict.identityConfidence,
    observation_count: b.count,
    observation_span_days: b.span,
    median_30d: b.median30,
    observed_low: b.low,
    reason_json: verdict.reasons,
    gate_json: verdict.gates.filter(g => !g.ok),
    last_checked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + hours * 3600000).toISOString()
  };
}

async function upsertDeals(rows) {
  if (!rows.length) return { ok: 0, failed: 0 };
  let ok = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200);
    const { error } = await supabase.from('hotdeals')
      .upsert(slice, { onConflict: 'source,source_external_id,mall' });
    if (error) { failed += slice.length; log('upsert_failed', { error: error.message, n: slice.length }); }
    else ok += slice.length;
  }
  return { ok, failed };
}

/* ── 5) 생애주기 — PHASE 11 ─────────────────────────────────────────
 *
 * 상태 전환은 «현재 가격 재검증» 이 먼저다. 단순 타이머로 만료시키지 않는다.
 *   NEW      이번에 처음 잡혔다
 *   ACTIVE   다시 확인했는데 여전히 딜이다
 *   COOLING  값이 올랐거나 점수가 떨어졌다 (아직 보여주되 아래로)
 *   EXPIRED  더 이상 딜이 아니거나 오래 확인하지 못했다
 * SOLD_OUT 은 만들지 않는다 — 재고 신호를 가진 적이 없다. 없는 것을
 * 추측해서 말하지 않는다.
 */
function lifecycleFor(prev, verdict) {
  const good = verdict.status === 'VERIFIED_HOT' || verdict.status === 'GOOD_DEAL'
    || verdict.status === 'POTENTIAL_DEAL';
  if (!prev) return good ? 'NEW' : 'EXPIRED';
  if (!good) return 'EXPIRED';
  if (prev.hot_score > 0 && verdict.hotScore < prev.hot_score - 10) return 'COOLING';
  if (verdict.status === 'NORMAL') return 'COOLING';
  return 'ACTIVE';
}

async function loadExisting() {
  const map = new Map();
  const { data, error } = await supabase
    .from('hotdeals')
    .select('id, source, source_external_id, mall, hot_score, lifecycle, detected_at')
    .eq('source', HS.INTERNAL_HISTORY.id)
    .limit(5000);
  if (error) { log('existing_read_failed', { error: error.message }); return map; }
  (data || []).forEach(r => map.set(`${r.source}|${r.source_external_id}|${r.mall}`, r));
  return map;
}

/** 오래 확인하지 못한 딜을 만료시킨다. */
async function sweepStale() {
  const cut = new Date(Date.now() - 3 * 86400000).toISOString();
  const { error } = await supabase.from('hotdeals')
    .update({ lifecycle: 'EXPIRED' })
    .lt('last_checked_at', cut)
    .in('lifecycle', ['NEW', 'ACTIVE', 'COOLING']);
  if (error) log('sweep_failed', { error: error.message });
}

/* ── main ──────────────────────────────────────────────────────────── */

async function main() {
  const today = kstToday();
  log('start', { today, dryRun: DRY, sources: HS.activeSources().map(s => s.id) });

  const lock = await acquireLock(today);
  if (!lock.ok) { log('skip_locked'); return; }

  const summary = { scanned: 0, evaluated: 0, kept: 0, rejected: 0, byStatus: {} };
  try {
    const products = await loadProducts();
    summary.scanned = products.length;
    log('products_loaded', { n: products.length });
    if (!products.length) { log('no_products'); return; }

    const history = await loadHistory(products);
    log('history_loaded', { series: history.size });

    const existing = await loadExisting();
    const rows = [];

    for (const p of products) {
      if (overBudget()) { log('eval_budget_stop', { evaluated: summary.evaluated }); break; }

      const cand = HS.normalizeCandidate({
        title: p.title,
        salePrice: p.lprice,
        referencePrice: p.oprice,
        externalId: `${p.product_id}|${p.vendor_item_id || ''}`,
        productId: p.product_id,
        vendorItemId: p.vendor_item_id,
        mall: p.mall_label || p.mall,
        image: p.image,
        affiliateUrl: p.link
      }, HS.INTERNAL_HISTORY.id);
      if (!cand) continue;

      const key = `${p.product_id}|${p.mall || ''}|${p.vendor_item_id || ''}`;
      const points = history.get(key) || [];
      summary.evaluated++;

      /*
       * internal-history 는 후보와 이력의 주인이 같은 행이다. 그래도
       * storedTitle 을 넘겨 identity 게이트를 그대로 통과시킨다 — 부속이
       * 본체 자리에 오는 일은 없지만, 게이트를 우회하는 경로를 만들지 않는다.
       */
      const verdict = HD.evaluate({ candidate: cand, storedTitle: p.title, points, today });
      summary.byStatus[verdict.status] = (summary.byStatus[verdict.status] || 0) + 1;

      if (verdict.status === HD.STATUS.REJECTED || verdict.status === HD.STATUS.NORMAL) {
        summary.rejected++;
        continue;
      }
      const row = rowFor(p, cand, verdict, today);
      const prev = existing.get(`${row.source}|${row.source_external_id}|${row.mall}`);
      row.lifecycle = lifecycleFor(prev, verdict);
      if (!prev) row.detected_at = new Date().toISOString();
      rows.push(row);
      summary.kept++;
    }

    log('evaluated', summary);

    if (DRY) {
      log('dry_run_no_write', { wouldUpsert: rows.length });
      rows.slice(0, 10).forEach(r => log('sample', {
        status: r.deal_status, score: r.hot_score, price: r.current_price,
        obs: r.observation_count, title: String(r.title).slice(0, 40),
        reason: (r.reason_json[0] || {}).text || ''
      }));
    } else {
      const w = await upsertDeals(rows);
      log('upserted', w);
      await sweepStale();
    }
  } catch (e) {
    log('failed', { error: e.message });
    process.exitCode = 1;
  } finally {
    await releaseLock(lock, summary);
    log('done', { ms: Date.now() - startedAt });
  }
}

main();
