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
const HG = require('../api/_hotgroup');
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

/* ── 잠금 (hotdeal_job_state singleton) ───────────────────────────────
 *
 * ── 왜 전용 표인가 ──────────────────────────────────────────────────
 *
 * 처음에는 price_job_state 를 재사용하고 job_date 에 'hotdeal-<날짜>' 를
 * 넣었다. 그 표의 job_date 는 `date` 타입이라 그 문자열은 insert 자체가
 * 실패한다. 게다가 그 표는 `id=1` singleton 이고 가격 수집 한 바퀴의 커서와
 * 재시도 목록을 들고 있어서, 남의 작업 상태를 같은 행에 끼워 넣으면 안 된다.
 *
 * ── 왜 실패 시 그냥 진행하지 않는가 ────────────────────────────────
 *
 * 예전 코드는 잠금 읽기·쓰기가 실패하면 skipLock=true 로 «잠금 없이» 계속
 * 돌았다. 그러면 잠금이 있다고 말할 수 없다 — 정확히 잠금이 필요한 상황
 * (DB 이상·동시 실행)에서 보호가 사라진다. 이제는 조용히 지나가지 않는다.
 *   · 표가 아직 없다        → SKIP (마이그레이션 전이므로 정상)
 *   · 다른 실행이 쥐고 있다  → SKIP
 *   · 그 밖의 오류          → FAIL (exit 1)
 * GitHub Actions 의 concurrency 는 그대로 두어 방어를 두 겹으로 만든다.
 */

/** 잠금 유효 시간. 실행이 죽어도 이 시간 뒤에는 회수된다. */
const LOCK_TTL_MS = 15 * 60 * 1000;

const LOCK = { ACQUIRED: 'acquired', SKIP: 'skip', FAIL: 'fail' };

function newToken() {
  return `${process.env.GITHUB_RUN_ID || 'local'}-${process.pid}-${Date.now()}`;
}

async function acquireLock(db) {
  const sb = db || supabase;
  // --dry-run 은 아무것도 쓰지 않는다. 잠금도 쓰기이므로 잡지 않는다.
  if (DRY) return { result: LOCK.ACQUIRED, token: '', dry: true };

  const read = await sb
    .from('hotdeal_job_state')
    .select('id, status, lock_token, lock_until')
    .eq('id', 1)
    .maybeSingle();

  if (read.error) {
    if (/does not exist|schema cache/i.test(read.error.message)) {
      log('lock_table_missing', { hint: 'supabase/2026-09-06-hotdeals.sql 을 실행하세요' });
      return { result: LOCK.SKIP, reason: 'table_missing' };
    }
    log('lock_read_failed', { error: read.error.message });
    return { result: LOCK.FAIL, reason: 'read_failed' };
  }
  if (!read.data) {
    // 마이그레이션의 seed insert 가 빠진 상태. 잠금 근거가 없으므로 돌지 않는다.
    log('lock_row_missing');
    return { result: LOCK.SKIP, reason: 'row_missing' };
  }

  const row = read.data;
  const heldUntil = row.lock_until ? Date.parse(row.lock_until) : 0;
  if (row.status === 'running' && heldUntil > Date.now()) {
    log('lock_held', { untilMs: heldUntil - Date.now() });
    return { result: LOCK.SKIP, reason: 'held' };
  }
  if (row.status === 'running' && heldUntil) {
    log('lock_expired_reclaim', { previousToken: '(redacted)' });
  }

  /*
   * CAS — 우리가 읽은 lock_token 이 그대로일 때만 잡는다.
   * 두 실행이 같은 순간에 여기 오면 한쪽만 행을 돌려받는다.
   */
  const token = newToken();
  const now = new Date();
  const upd = await sb
    .from('hotdeal_job_state')
    .update({
      status: 'running',
      lock_token: token,
      lock_until: new Date(now.getTime() + LOCK_TTL_MS).toISOString(),
      last_run_at: now.toISOString(),
      updated_at: now.toISOString()
    })
    .eq('id', 1)
    .eq('lock_token', row.lock_token || '')
    .select('id');

  if (upd.error) {
    log('lock_acquire_failed', { error: upd.error.message });
    return { result: LOCK.FAIL, reason: 'acquire_failed' };
  }
  if (!upd.data || upd.data.length === 0) {
    log('lock_cas_lost');
    return { result: LOCK.SKIP, reason: 'cas_lost' };
  }
  return { result: LOCK.ACQUIRED, token };
}

/**
 * 잠금 반납. ★ 자기 토큰일 때만 성공한다 — 남의 잠금을 풀지 않는다.
 * 만료된 뒤 다른 실행이 이미 회수해 갔다면 여기서 아무것도 하지 않는 것이 옳다.
 */
async function releaseLock(lock, status, summary, db) {
  const sb = db || supabase;
  if (!lock || lock.dry || lock.result !== LOCK.ACQUIRED || !lock.token) return;
  const now = new Date().toISOString();
  const r = await sb
    .from('hotdeal_job_state')
    .update({
      status, lock_token: '', lock_until: null,
      last_result: summary || {}, updated_at: now
    })
    .eq('id', 1)
    .eq('lock_token', lock.token)      // 소유권 검사
    .select('id');
  if (r.error) { log('lock_release_failed', { error: r.error.message }); return; }
  if (!r.data || r.data.length === 0) log('lock_release_not_owner');
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
    /*
     * ★ 정렬을 명시하고, 잘렸는지 확인한다.
     *
     * 예전에는 .limit(20000) 만 걸고 정렬이 없었다. 상한에 걸리면 «어느 행이
     * 돌아오는지»가 보장되지 않아, 같은 입력으로 돌려도 회차마다 다른 이력을
     * 받았다(실측: history_loaded 3,484 ↔ 3,371). 이력이 달라지면 중앙값도
     * 판정도 달라진다 — 핫딜 엔진이 결정론이어야 하는데 입력이 흔들린 것이다.
     *
     * 정렬을 주면 잘리더라도 «항상 같은 쪽»이 잘리고, 잘린 사실 자체를
     * 로그로 남겨 CHUNK 를 줄일 근거를 만든다.
     */
    const LIMIT = 20000;
    const { data, error } = await supabase
      .from('price_history')
      .select('product_id, mall, vendor_item_id, price, recorded_date')
      .in('product_id', ids.slice(i, i + CHUNK))
      .gte('recorded_date', cut)
      .order('product_id', { ascending: true })
      .order('recorded_date', { ascending: true })
      .limit(LIMIT);
    if (error) { log('history_chunk_failed', { error: error.message }); continue; }
    if (data && data.length >= LIMIT) {
      // 잘렸다. 조용히 넘어가면 그 청크의 상품들이 잘못된 기준선으로 판정된다.
      log('history_chunk_truncated', { at: i, rows: data.length, hint: 'CHUNK 를 줄이세요' });
    }
    (data || []).forEach(r => {
      const key = `${r.product_id}|${r.mall || ''}|${r.vendor_item_id || ''}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ date: String(r.recorded_date).slice(0, 10), price: Math.round(Number(r.price) || 0) });
    });
  }
  return byKey;
}

/* ── 3~4) 판정 · 저장 ──────────────────────────────────────────────── */

/** hotdeals 유일키와 같은 모양. 군집·기존행 대조에 모두 이 키를 쓴다. */
function offerKeyOf(source, externalId, mall) {
  return `${source}|${externalId}|${mall}`;
}

/** confidence → 정렬 가능한 숫자. SQL 쪽 confidence_rank 와 뜻이 같아야 한다. */
const CONFIDENCE_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, INSUFFICIENT: 0 };

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

    /*
     * 설명 가능한 신호. 화면이 "왜 핫딜인가"를 스스로 말할 수 있게 하는
     * 재료이며, 전부 baseline 에서 나온 값이라 price_history 로 되짚을 수 있다.
     * 모르는 값은 0 이 아니라 null 로 들어간다 — 0 은 "0원"으로 읽힌다.
     */
    signal_json: verdict.signals,
    price_drop_percent: Number(verdict.signals.priceDropPercent) > 0
      ? Number(verdict.signals.priceDropPercent) : 0,
    confidence_rank: CONFIDENCE_RANK[verdict.confidence] || 0,

    last_checked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + hours * 3600000).toISOString()
  };
}

/**
 * 군집 결과를 저장할 행에 붙인다.
 *
 * ★ 군집이 없는(혼자인) 상품도 같은 모양을 갖는다. 그래야 화면이 "군집이
 *   있을 때만 다른 코드"를 타지 않는다.
 */
function applyGroup(row, info) {
  const key = offerKeyOf(row.source, row.source_external_id, row.mall);
  if (!info) {
    row.group_key = key;
    row.is_primary = true;
    row.group_size = 1;
    row.group_lowest_price = row.current_price;
    row.group_lowest_mall = row.mall;
    row.group_offers = [];
    return row;
  }
  row.group_key = info.groupKey;
  row.is_primary = info.primaryKey === key;
  row.group_size = info.size;
  row.group_lowest_price = info.lowestPrice || row.current_price;
  row.group_lowest_mall = info.lowestMall || row.mall;
  /*
   * 군집이 혼자면 오퍼 목록을 싣지 않는다 — 자기 자신만 든 배열은 화면에서
   * "다른 판매처 1곳"으로 오해될 여지가 있고, 매 행에 쓸모없는 바이트가 붙는다.
   */
  row.group_offers = info.size > 1 ? info.offers.slice(0, 8) : [];
  return row;
}

/*
 * 외부 후보 ↔ 우리 카탈로그 상품 잇기.
 *
 * 문자열 유사도로 «판정» 하지 않는다. 여기서 하는 일은 후보군을 좁히는 것뿐이고,
 * 같은 상품인지의 판정은 _hotdeal.identityOf(= _identity.judgeSameProduct)가
 * 한다. 그래서 여기서 통과시켜도 세대·용량·리퍼·부속은 게이트에서 걸린다.
 */
function matchProduct(cand, products) {
  const tokens = String(cand.title || '')
    .toLowerCase().replace(/[^0-9a-z가-힣\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2).slice(0, 6);
  if (!tokens.length) return null;

  let best = null, bestHits = 0;
  for (const p of products) {
    const t = String(p.title || '').toLowerCase();
    let hits = 0;
    for (const tok of tokens) if (t.indexOf(tok) > -1) hits++;
    if (hits > bestHits) { bestHits = hits; best = p; }
  }
  // 절반 이상 겹칠 때만 후보로 올린다. 그 뒤 판정은 identity gate 가 한다.
  return bestHits >= Math.ceil(tokens.length / 2) ? best : null;
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
  /*
   * 이미 저장된 딜을 «source 를 가리지 않고» 읽는다.
   *
   * ── 두 갈래가 같은 버그를 잡았다 (통합 시 병합) ────────────────────
   *
   * 예전에는 .eq('source', 'internal-history') 였다. 그래서 ADPICK 딜은 DB 에
   * 이미 있어도 prev=null 로 취급됐고, 같은 외부 딜을 다음 회차에 다시 만나도
   * lifecycleFor() 가 계속 NEW 를 돌려줬다 — "언제 처음 발견했나"가 영원히
   * «방금» 이 된다. detected_at 도 매번 다시 찍혔다.
   *
   * 통합하면서 .in([internal, adpick]) 대신 필터를 **아예 뺐다.** 이 표에는
   * 핫딜 행만 있으므로 좁힐 이유가 없고, 목록을 손으로 관리하면 source 를
   * 하나 더 켤 때(_hotsource 에 COUPANG_GOLDBOX 자리가 이미 있다) 똑같은
   * 버그가 조용히 되살아난다.
   *
   * ── 정렬을 주는 이유 ───────────────────────────────────────────────
   *
   * 상한(5000)에 걸렸을 때 «어느 5000행이 오는지» 가 정해지지 않으면 회차마다
   * 다른 행이 prev 로 잡혀 lifecycle 과 detected_at 이 흔들린다. 최근에 확인한
   * 것부터 읽는다 — 그쪽이 이번에 다시 만날 가능성이 크다.
   */
  const { data, error } = await supabase
    .from('hotdeals')
    .select('id, source, source_external_id, mall, hot_score, lifecycle, detected_at')
    .order('last_checked_at', { ascending: false })
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

/**
 * 이번에 «봤는데 더 이상 딜이 아닌» 행을 그 자리에서 만료시킨다.
 *
 * ── 왜 sweepStale 로 충분하지 않은가 ────────────────────────────────
 *
 * sweepStale 은 3일 동안 확인되지 않은 행을 지운다. 그런데 값이 올라서 딜이
 * 끝난 상품은 «이번 회차에 확인은 했지만 upsert 대상이 아닌» 상태라
 * last_checked_at 이 갱신되지 않는다. 그래서 3일 동안 옛 가격을 단 카드가
 * 목록에 남는다 — 정확히 사용자가 헛걸음하는 경우다.
 *
 * 방금 판정한 것은 우리가 안다. 미루지 않고 그때 끝낸다.
 */
async function expireEnded(ids) {
  if (!ids.length) return 0;
  let n = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { error } = await supabase.from('hotdeals')
      .update({ lifecycle: 'EXPIRED', last_checked_at: now })
      .in('id', slice)
      .in('lifecycle', ['NEW', 'ACTIVE', 'COOLING']);
    if (error) { log('expire_failed', { error: error.message, n: slice.length }); continue; }
    n += slice.length;
  }
  return n;
}

/* ── main ──────────────────────────────────────────────────────────── */

async function main() {
  const today = kstToday();
  log('start', { today, dryRun: DRY, sources: HS.activeSources().map(s => s.id) });

  const lock = await acquireLock();
  if (lock.result === LOCK.SKIP) { log('skipped', { reason: lock.reason }); return; }
  if (lock.result === LOCK.FAIL) {
    // 잠금을 확보했는지 «모르는» 상태로는 돌지 않는다. 조용히 지나가지 않는다.
    log('aborted_no_lock', { reason: lock.reason });
    process.exitCode = 1;
    return;
  }

  const summary = { scanned: 0, evaluated: 0, kept: 0, rejected: 0, byStatus: {} };
  let outcome = 'done';
  try {
    const products = await loadProducts();
    summary.scanned = products.length;
    log('products_loaded', { n: products.length });
    if (!products.length) { log('no_products'); return; }

    const history = await loadHistory(products);
    log('history_loaded', { series: history.size });

    const existing = await loadExisting();
    const rows = [];

    /*
     * ── 군집 재료 ────────────────────────────────────────────────────
     *
     * REJECTED 만 빼고 «판정한 모든 오퍼» 를 모은다. NORMAL 까지 담는 이유는
     * 현재 최저가 때문이다. 딜인 것만 모으면 이런 일이 생긴다.
     *
     *     쿠팡  22,000원  NORMAL       ← 평소 값이라 딜은 아니지만 제일 싸다
     *     ADPICK 24,900원  GOOD_DEAL   ← 이쪽만 담으면 이게 "최저가"가 된다
     *
     * 그러면 우리가 사용자를 더 비싼 곳으로 보낸다. 값을 못 믿는 것(REJECTED)이
     * 아니라 «딜이 아닌 것» 은 최저가 후보로 남겨야 맞다.
     */
    const offers = [];
    /** 이번 회차에 실제로 판정한 오퍼 키 — 끝난 딜을 그 자리에서 만료시키는 데 쓴다. */
    const seenKeys = new Set();
    const nowIso = new Date().toISOString();

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

      const mall = HS.normalizeMall(p.mall_label || p.mall);
      const offerKey = offerKeyOf(HS.INTERNAL_HISTORY.id, cand.externalId, mall);
      if (verdict.status !== HD.STATUS.REJECTED) {
        seenKeys.add(offerKey);
        offers.push({
          key: offerKey, title: cand.title, price: cand.salePrice, mall,
          url: cand.affiliateUrl, productId: p.product_id,
          vendorItemId: p.vendor_item_id || '',
          status: verdict.status, hotScore: verdict.hotScore,
          deal: verdict.status !== HD.STATUS.NORMAL, checkedAt: nowIso
        });
      }

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

    /*
     * ── 외부 source: ADPICK 핫딜 ────────────────────────────────────
     *
     * ★ 실패를 격리한다. 여기서 무슨 일이 나도 위에서 만든 internal-history
     *   결과(rows)는 그대로 저장된다. 그래서 try 를 따로 두고 throw 하지 않는다.
     *
     * 외부 후보는 우리 카탈로그의 어느 상품인지부터 찾아야 한다. 제목으로
     * products 를 뒤지지 않는다 — 그건 동일상품 판정을 문자열 검색으로
     * 대신하는 것이고, 그러면 identity gate 를 우회하게 된다. 대신 후보마다
     * 이름이 닮은 상품을 후보군으로 좁힌 뒤 _hotdeal.identityOf 가 판정한다.
     */
    try {
      const AH = require('../api/_adpickhot');
      if (!AH.hasCredential()) {
        log('adpick_skipped', { reason: 'no-credential' });
      } else if (overBudget()) {
        log('adpick_skipped', { reason: 'budget' });
      } else {
        const res = await AH.fetchHotdeals();
        if (!res.ok) {
          log('adpick_failed', { reason: res.reason, status: res.status });
        } else {
          const ext = HS.dedupeCandidates(
            res.items.map(x => HS.normalizeCandidate(x, HS.ADPICK_HOTDEAL.id)).filter(Boolean));
          log('adpick_candidates', { received: res.items.length, usable: ext.length });

          let matched = 0;
          for (const cand of ext) {
            if (overBudget()) break;
            const p = matchProduct(cand, products);
            if (!p) continue;
            const key = `${p.product_id}|${p.mall || ''}|${p.vendor_item_id || ''}`;
            const verdict = HD.evaluate({
              candidate: cand, storedTitle: p.title,
              points: history.get(key) || [], today,
              sourceFlagged: !!HS.ADPICK_HOTDEAL.sourceFlagged
            });
            summary.byStatus[verdict.status] = (summary.byStatus[verdict.status] || 0) + 1;

            const extMall = cand.mall || HS.normalizeMall(p.mall_label || p.mall);
            const extKey = offerKeyOf(HS.ADPICK_HOTDEAL.id, cand.externalId, extMall);
            if (verdict.status !== HD.STATUS.REJECTED) {
              seenKeys.add(extKey);
              /*
               * ★ vendorItemId 는 «우리가 아는» 값만 넣는다.
               *   ADPICK 은 옵션 식별자를 주지 않는다. 우리가 이어붙인 쿠팡
               *   상품의 vendorItemId 를 여기에 실으면, 군집 규칙이 그 값을
               *   «이 오퍼의 옵션» 으로 믿고 다른 옵션과 붙여 버린다.
               *   모르는 것은 빈 값으로 둔다.
               */
              offers.push({
                key: extKey, title: cand.title, price: cand.salePrice, mall: extMall,
                url: cand.affiliateUrl, productId: p.product_id,
                vendorItemId: cand.vendorItemId || '',
                status: verdict.status, hotScore: verdict.hotScore,
                deal: verdict.status !== HD.STATUS.NORMAL, checkedAt: nowIso
              });
            }
            if (verdict.status === HD.STATUS.REJECTED || verdict.status === HD.STATUS.NORMAL) continue;

            const row = rowFor(p, cand, verdict, today);
            row.source = HS.ADPICK_HOTDEAL.id;
            row.source_external_id = cand.externalId;
            row.mall = extMall;
            row.affiliate_url = cand.affiliateUrl;
            const prev = existing.get(`${row.source}|${row.source_external_id}|${row.mall}`);
            row.lifecycle = lifecycleFor(prev, verdict);
            if (!prev) row.detected_at = new Date().toISOString();
            rows.push(row);
            matched++;
          }
          log('adpick_matched', { matched, unmatched: ext.length - matched });
        }
      }
    } catch (e) {
      // 외부 source 하나가 터져도 internal-history 결과는 살린다.
      log('adpick_isolated_failure', { error: require('../api/_adpickhot').redact(e && e.message) });
    }

    /*
     * ── 같은 상품 묶기 · 현재 최저가 ────────────────────────────────
     *
     * 여기서 «한 번에» 한다. 저장 뒤에 SQL 로 묶으려 하면 같은 상품 판정을
     * 제목 LIKE 로 흉내 내게 되고, 그건 우리가 하지 않기로 한 일이다
     * (api/_hotgroup.js 첫 주석).
     *
     * 판정 결과 자체는 오퍼마다 그대로 남는다 — 군집은 «어느 카드로 보여
     * 줄지» 만 정한다. 다른 상품의 이력이 섞이는 경로는 만들지 않는다.
     */
    const grouped = HG.groupOffers(offers);
    rows.forEach(row => {
      applyGroup(row, grouped.byKey.get(offerKeyOf(row.source, row.source_external_id, row.mall)));
    });
    const multi = grouped.groups.filter(g => g.size > 1);
    summary.groups = grouped.groups.length;
    summary.merged = multi.reduce((s, g) => s + g.size - 1, 0);
    summary.cards = rows.filter(r => r.is_primary).length;
    log('grouped', {
      offers: offers.length, groups: grouped.groups.length,
      multiOffer: multi.length, merged: summary.merged,
      crossMall: multi.filter(g => g.mallCount > 1).length
    });

    /*
     * 이번에 판정했는데 더 이상 딜이 아닌 행. 3일을 기다리지 않고 지금 끝낸다.
     * (군집에서 밀려나 is_primary 가 false 가 된 행은 여기 들어오지 않는다 —
     *  그 행은 여전히 딜이고, 상세의 "다른 판매처"로 쓰인다)
     */
    const keptKeys = new Set(rows.map(r => offerKeyOf(r.source, r.source_external_id, r.mall)));
    const endedIds = [];
    existing.forEach((prev, key) => {
      if (!seenKeys.has(key) || keptKeys.has(key)) return;
      if (['NEW', 'ACTIVE', 'COOLING'].indexOf(prev.lifecycle) < 0) return;
      endedIds.push(prev.id);
    });

    log('evaluated', summary);

    if (DRY) {
      log('dry_run_no_write', { wouldUpsert: rows.length, wouldExpire: endedIds.length });
      rows.slice(0, 10).forEach(r => log('sample', {
        status: r.deal_status, score: r.hot_score, price: r.current_price,
        obs: r.observation_count, drop: r.price_drop_percent,
        group: r.group_size, primary: r.is_primary,
        title: String(r.title).slice(0, 40),
        reason: (r.reason_json[0] || {}).text || ''
      }));
      multi.slice(0, 5).forEach(g => log('group_sample', {
        size: g.size, malls: g.malls, lowest: g.lowestPrice,
        lowestMall: g.lowestMall, why: g.mergeReasons[0] || ''
      }));
    } else {
      const expired = await expireEnded(endedIds);
      if (expired) log('expired_ended', { n: expired });
      const w = await upsertDeals(rows);
      log('upserted', w);
      await sweepStale();
    }
  } catch (e) {
    log('failed', { error: e.message });
    outcome = 'failed';
    process.exitCode = 1;
  } finally {
    await releaseLock(lock, outcome, summary);
    log('done', { ms: Date.now() - startedAt, outcome });
  }
}

/*
 * 직접 실행일 때만 돈다. require 하면 잠금·매칭 함수를 테스트할 수 있다
 * (scripts/test-hotdeal.js 가 스텁 db 를 넣어 CAS·소유권을 검증한다).
 */
if (require.main === module) main();

module.exports = {
  acquireLock, releaseLock, matchProduct, lifecycleFor, LOCK,
  offerKeyOf, applyGroup, CONFIDENCE_RANK
};
