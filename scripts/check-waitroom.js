#!/usr/bin/env node
/*
 * ② 구매 대기실 — 매일 목표가 도달 확인 → 이메일 (GitHub Actions: .github/workflows/waitroom.yml).
 *
 *   node scripts/check-waitroom.js [--dry-run]
 *
 * ── 무엇을 하고, 무엇을 하지 않는가 ────────────────────────────────
 *
 *   한다      이미 쌓인 price_history 에서 대기실 항목의 최신 관측을 읽고
 *             (api/_waitroom.evaluate) 목표가에 닿은 항목에 메일을 한 통 보낸다.
 *   안 한다   가격을 수집하지 않는다. 쿠팡·ADPICK 을 부르지 않는다. products ·
 *             price_history 에 쓰지 않는다. 기존 알림(alerts · check-alerts.js)을 건드리지 않는다.
 *
 * ── 한 번만 보낸다 (at-most-once) ──────────────────────────────────
 *
 * 메일은 되돌릴 수 없다. 두 번 가는 것보다 한 번 빠지는 쪽을 택한다.
 *
 *   a) 항목을 먼저 무장 해제한다 — UPDATE … WHERE armed = true (compare-and-set).
 *      잡이 둘 겹쳐 돌아도 한쪽만 이긴다.
 *   b) 발송 기록을 선점한다 — waitroom_notifications UNIQUE (item_id, notify_date).
 *   c) 보낸다.
 *   d) 성공이면 기록을 sent 로, 실패면 failed 로 남기고 항목을 다시 무장한다
 *      (같은 날 MAX_ATTEMPTS 번까지 다시 시도).
 *
 *   a 와 c 사이에서 프로세스가 죽으면 그 알림은 빠진다. 대신 두 번 가지는 않는다.
 *
 * ── 마이그레이션 전 ───────────────────────────────────────────────
 * 표가 없으면 아무것도 하지 않고 정상 종료한다(exit 0). 워크플로는 저장소 변수
 * WAITROOM_ENABLED=1 이 있어야 돈다 — 승인 전에는 이 스크립트가 운영에서 실행되지 않는다.
 */
'use strict';

require('./_env');
const supabase = require('../api/_supabase');
const notify = require('../api/_notify');
const W = require('../api/_waitroom');
const { kstToday, kstDayStartUtc, observedKstDate, sameVendorRows } = require('../api/_price');
const { isMissingObject } = require('../api/_dberror');

const PAGE = 1000;
const CHUNK = 60;
/** 최신 관측을 찾을 창. evaluate 는 NOTIFY_MAX_STALE_DAYS(1일)보다 오래된 관측으로는 알리지 않는다. */
const OBS_LOOKBACK_DAYS = 3;
const ORIGIN = process.env.SITE_ORIGIN || 'https://seosa.ai.kr';

class NotReady extends Error {}

async function fetchAll(label, build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) {
      if (isMissingObject(error)) throw new NotReady(`${label}: ${error.message}`);
      throw new Error(`${label} 조회 실패: ${error.message}`);
    }
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

/** 항목별 최신 관측 {price, observedAt, observedDate} — 그 항목의 옵션(vendor_item_id)으로 좁힌다. */
async function latestObservations(items) {
  const since = kstDayStartUtc(kstToday(new Date(Date.now() - OBS_LOOKBACK_DAYS * 86400000)));
  const ids = [...new Set(items.map(i => i.product_id))];
  const byKey = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await fetchAll('최근 가격', () => supabase.from('price_history')
      .select('id, product_id, mall, vendor_item_id, price, recorded_at, recorded_date')
      .in('product_id', chunk)
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: true })
      .order('id', { ascending: true }));
    rows.forEach(r => {
      const k = `${r.product_id}|${r.mall}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    });
  }
  const out = new Map();
  items.forEach(it => {
    const scoped = sameVendorRows(byKey.get(`${it.product_id}|${it.mall}`) || [], it.vendor_item_id);
    const last = scoped[scoped.length - 1];
    if (last && Number(last.price) > 0) {
      out.set(it.id, { price: Math.round(Number(last.price)), observedAt: last.recorded_at, observedDate: observedKstDate(last) });
    }
  });
  return out;
}

/** 발송 기록 선점. 이미 있으면 «실패한 기록» 만 다시 선점할 수 있다. @returns {number|null} 기록 id */
async function claim(item, obs, today) {
  const row = {
    item_id: item.id, email: item.email, notify_date: today,
    price: obs.price, target_price: item.target_price, status: 'claimed', attempts: 1
  };
  const { data, error } = await supabase.from('waitroom_notifications')
    .upsert(row, { onConflict: 'item_id,notify_date', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`발송 기록 선점 실패: ${error.message}`);
  if (data && data.length) return data[0].id;

  const { data: ex, error: exErr } = await supabase.from('waitroom_notifications')
    .select('id, status, attempts').eq('item_id', item.id).eq('notify_date', today).maybeSingle();
  if (exErr) throw new Error(`발송 기록 조회 실패: ${exErr.message}`);
  if (!ex || ex.status !== 'failed' || ex.attempts >= W.MAX_ATTEMPTS) return null;
  const { data: re, error: reErr } = await supabase.from('waitroom_notifications')
    .update({ status: 'claimed', attempts: ex.attempts + 1, error: '', price: obs.price })
    .eq('id', ex.id).eq('status', 'failed').eq('attempts', ex.attempts)
    .select('id');
  if (reErr) throw new Error(`발송 기록 재선점 실패: ${reErr.message}`);
  return re && re.length ? re[0].id : null;
}

async function patchItem(id, patch) {
  const { error } = await supabase.from('waitroom_items').update(patch).eq('id', id);
  if (error) throw new Error(`항목 갱신 실패(${id}): ${error.message}`);
}

/**
 * @param {{dryRun?:boolean, send?:function}} [opts]  send 는 테스트가 가짜 발송기를 끼우는 자리
 * @returns {Promise<object>} 요약
 */
async function run(opts) {
  const o = opts || {};
  const today = kstToday();
  const summary = { today, items: 0, observed: 0, notified: 0, wouldNotify: 0, rearmed: 0, updated: 0,
    failed: 0, notReady: false, skipped: {} };
  const skip = r => { summary.skipped[r] = (summary.skipped[r] || 0) + 1; };

  let dryRun = !!o.dryRun;
  const send = o.send || (payload => notify.send('email', payload));
  if (!o.send && !process.env.RESEND_API_KEY && !dryRun) {
    console.error('❌ RESEND_API_KEY 가 없습니다 — 메일을 보낼 수 없어 판정만 합니다 (dry-run).');
    dryRun = true;
    process.exitCode = 1;
  }

  let items;
  try {
    items = await fetchAll('대기실 항목', () => supabase.from('waitroom_items').select('*')
      .in('status', [W.STATUS.WAITING, W.STATUS.REACHED])
      .order('id', { ascending: true }));
  } catch (e) {
    if (e instanceof NotReady) {
      console.log('대기실 표가 아직 없습니다(supabase/2026-09-24-seosa2-waitroom.sql 미적용) — 할 일이 없습니다.');
      summary.notReady = true;
      return summary;
    }
    throw e;
  }
  summary.items = items.length;
  if (!items.length) { console.log('대기 중인 항목이 없습니다.'); return summary; }

  const obsMap = await latestObservations(items);
  summary.observed = obsMap.size;

  for (const item of items) {
    // 한 항목의 DB 오류가 나머지 사용자의 알림을 막지 않게 항목마다 따로 잡는다.
    try {
      await processItem(item);
    } catch (e) {
      console.error(`❌ 항목 처리 실패(${item.id}): ${e.message}`);
      summary.failed++;
    }
  }

  async function processItem(item) {
    const obs = obsMap.get(item.id) || null;
    const ev = W.evaluate(item, obs, { today, now: Date.now() });
    const nowIso = new Date().toISOString();

    if (ev.action !== 'NOTIFY') {
      if (ev.action === 'REARM') summary.rearmed++;
      else skip(ev.reason);
      if (Object.keys(ev.patch).length && !dryRun) {
        await patchItem(item.id, Object.assign({}, ev.patch, { updated_at: nowIso }));
        summary.updated++;
      }
      return;
    }

    if (dryRun) { summary.wouldNotify++; return; }

    // a) 무장 해제 (compare-and-set)
    const { data: cas, error: casErr } = await supabase.from('waitroom_items')
      .update({ armed: false, updated_at: nowIso }).eq('id', item.id).eq('armed', true).select('id');
    if (casErr) { console.error(`❌ 무장 해제 실패(${item.id}): ${casErr.message}`); summary.failed++; return; }
    if (!cas || !cas.length) { skip('race-lost'); return; }

    // b) 발송 기록 선점
    let noteId;
    try { noteId = await claim(item, obs, today); } catch (e) {
      console.error(`❌ ${e.message}`);
      await patchItem(item.id, { armed: true, updated_at: nowIso });
      summary.failed++;
      return;
    }
    if (!noteId) { skip('already-claimed'); return; }

    // c) 발송
    const result = await send({
      to: item.email,
      subject: `[SEOSA] 목표가 도달 — ${String(item.title || '').slice(0, 25)}`,
      html: W.emailHtml({ title: item.title, price: obs.price, target: item.target_price, mall: item.mall,
        observedDate: obs.observedDate, link: item.link, image: item.image, origin: ORIGIN })
    });

    // d) 기록
    if (result && result.ok) {
      await supabase.from('waitroom_notifications').update({ status: 'sent', sent_at: nowIso }).eq('id', noteId);
      await patchItem(item.id, Object.assign({}, ev.patch, W.afterSend(item, obs.price, nowIso)));
      summary.notified++;
      console.log(`✅ ${item.id} → 목표가 도달 알림 (${obs.price}원 ≤ ${item.target_price}원)`);
    } else {
      const err = String((result && result.error) || 'unknown').slice(0, 300);
      await supabase.from('waitroom_notifications').update({ status: 'failed', error: err }).eq('id', noteId);
      await patchItem(item.id, Object.assign({}, ev.patch, { armed: true, updated_at: nowIso }));
      summary.failed++;
      console.error(`❌ 발송 실패(${item.id}): ${err}`);
    }
  }

  console.log(JSON.stringify({ msg: 'waitroom_done', dryRun, ...summary }));
  return summary;
}

if (require.main === module) {
  run({ dryRun: process.argv.indexOf('--dry-run') > -1 || process.env.WAITROOM_DRY_RUN === 'true' })
    .catch(e => { console.error('오류:', e.message); process.exit(1); });
}

module.exports = { run, latestObservations, claim, OBS_LOOKBACK_DAYS };
