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
 *   d) 성공이면 항목을 먼저 REACHED 로 기록한 뒤 발송 기록을 sent 로 바꾼다.
 *      명확한 거절만 failed 로 남기고 재무장해 같은 날 MAX_ATTEMPTS 번까지 다시 시도한다.
 *      타임아웃·연결 단절·5xx 처럼 수락 여부가 불분명하면 claimed 를 유지하고 재무장하지
 *      않는다. Resend Idempotency-Key 와 다음 실행의 claimed 조회가 중복 발송을 막는다.
 *
 *   a 와 c 사이에서 프로세스가 죽으면 그 알림은 빠질 수 있다. claimed 는 자동 재시도하지
 *   않는다. 전달 여부를 확인할 수 없는 경우 중복보다 누락을 택한다.
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

/**
 * 발송 기록을 «같은 사람·같은 상품» (W.seriesKey) 단위로 읽는다. 항목 id 로 읽지 않는다 —
 * 항목을 지우고 다시 담으면 id 가 바뀌지만 발송 기록은 남아 있다(on delete set null).
 *
 *   unconfirmed  이전 실행이 수락 여부를 확인하지 못한 계열 — 자동 재전송·재무장하지 않는다
 *   lastSent     최근 COOLDOWN_DAYS 안에 보냈(거나 보냈을 수 있)던 계열 → 그 시각
 */
async function seriesLedger(items, now) {
  const unconfirmed = new Set();
  const lastSent = new Map();
  const emails = [...new Set(items.map(i => i.email))];
  // notify_date(KST 날짜)는 선점 때 항상 채워진다 — 하루 여유를 두고 거른 뒤 시각으로 다시 잰다.
  const sinceDate = kstToday(new Date(now - (W.COOLDOWN_DAYS + 1) * 86400000));
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const claimed = await fetchAll('미확정 발송', () => supabase.from('waitroom_notifications')
      .select('id, email, product_id, mall').in('email', chunk).eq('status', 'claimed').order('id', { ascending: true }));
    claimed.forEach(r => unconfirmed.add(W.seriesKey(r)));
    const recent = await fetchAll('최근 발송', () => supabase.from('waitroom_notifications')
      .select('id, email, product_id, mall, status, notify_date, created_at, sent_at').in('email', chunk)
      .in('status', ['sent', 'claimed']).gte('notify_date', sinceDate).order('id', { ascending: true }));
    recent.forEach(r => {
      const at = Date.parse(r.sent_at || r.created_at || `${r.notify_date}T00:00:00+09:00`);
      const k = W.seriesKey(r);
      if (Number.isFinite(at) && !(lastSent.get(k) >= at)) lastSent.set(k, at);
    });
  }
  return { unconfirmed, lastSent };
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
    // 옵션 번호가 비었는데 관측이 여러 옵션에 걸쳐 있으면 어느 옵션 가격인지 모른다 — 알리지 않는다.
    // (저장 API 가 옵션을 확정하므로 새 항목에는 생기지 않는다. 옛 항목·수동 입력 방어)
    if (!it.vendor_item_id) {
      const opts = new Set(scoped.map(r => String(r.vendor_item_id || '').trim()).filter(v => v && v !== '__LEGACY__'));
      if (opts.size > 1) return;
    }
    const last = scoped[scoped.length - 1];
    if (last && Number(last.price) > 0) {
      out.set(it.id, { price: Math.round(Number(last.price)), observedAt: last.recorded_at, observedDate: observedKstDate(last) });
    }
  });
  return out;
}

/**
 * 발송 기록 선점 — 같은 사람·같은 상품·같은 날에 하나 (UNIQUE email, product_id, mall, notify_date).
 * 이미 있으면 «실패한 기록» 만 다시 선점할 수 있다.
 * @returns {{id:number, attempt:number}|null} 기록 id 와 이번이 몇 번째 시도인지 (공급자 키에 쓴다)
 */
async function claim(item, obs, today) {
  const row = {
    item_id: item.id, email: item.email, product_id: item.product_id, mall: item.mall, notify_date: today,
    price: obs.price, target_price: item.target_price, status: 'claimed', attempts: 1
  };
  const { data, error } = await supabase.from('waitroom_notifications')
    .upsert(row, { onConflict: 'email,product_id,mall,notify_date', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`발송 기록 선점 실패: ${error.message}`);
  if (data && data.length) return { id: data[0].id, attempt: 1 };

  const { data: ex, error: exErr } = await supabase.from('waitroom_notifications')
    .select('id, status, attempts').eq('email', item.email).eq('product_id', item.product_id)
    .eq('mall', item.mall).eq('notify_date', today).maybeSingle();
  if (exErr) throw new Error(`발송 기록 조회 실패: ${exErr.message}`);
  if (!ex || ex.status !== 'failed' || ex.attempts >= W.MAX_ATTEMPTS) return null;
  const { data: re, error: reErr } = await supabase.from('waitroom_notifications')
    .update({ status: 'claimed', attempts: ex.attempts + 1, error: '', price: obs.price, item_id: item.id })
    .eq('id', ex.id).eq('status', 'failed').eq('attempts', ex.attempts)
    .select('id');
  if (reErr) throw new Error(`발송 기록 재선점 실패: ${reErr.message}`);
  return re && re.length ? { id: re[0].id, attempt: ex.attempts + 1 } : null;
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
    failed: 0, unconfirmed: 0, notReady: false, skipped: {} };
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
  // 운영자 시험 발송: 지정한 주소의 항목만 처리한다 (다른 사용자에게는 보내지도 쓰지도 않는다).
  // 공개 저장소의 수동 실행 입력은 누구나 볼 수 있으므로 주소 대신 sha256(소문자 주소) 64자도 받는다.
  const only = String(o.onlyEmail != null ? o.onlyEmail : (process.env.WAITROOM_ONLY_EMAIL || '')).trim().toLowerCase();
  if (only) {
    const sha = e => require('crypto').createHash('sha256').update(String(e || '').trim().toLowerCase()).digest('hex');
    const match = /^[0-9a-f]{64}$/.test(only)
      ? i => sha(i.email) === only
      : i => String(i.email || '').trim().toLowerCase() === only;
    items = items.filter(match);
    summary.onlyEmail = true;
  }
  summary.items = items.length;
  if (!items.length) { console.log('대기 중인 항목이 없습니다.'); return summary; }

  // 프로세스가 발송 후 DB 기록 전에 죽은 경우도 claimed 행으로 남는다. 메일 수락 여부를
  // 판별할 수 없으므로 재무장이나 다음 날 재발송이 일어나지 않게 먼저 막는다.
  // 항목이 아니라 «같은 사람·같은 상품» 단위로 막는다 (W.seriesKey 주석).
  const ledger = await seriesLedger(items, Date.now());
  const notifiedThisRun = new Set();

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
    const series = W.seriesKey(item);
    if (ledger.unconfirmed.has(series)) { skip('delivery-unconfirmed'); return; }
    // 수신 동의 기록이 없으면 보내지 않는다 (UPGRADE 전 항목 · 동의 없이 들어온 행)
    if (!item.consent_at) { skip('no-consent'); return; }
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

    // 같은 사람·같은 상품: 이번 실행에서 이미 보냈거나, 7일 안에 보낸 기록이 있으면 쉰다.
    // 무장 해제(CAS) «전» 에 거른다 — 막힌 항목의 armed 를 건드리지 않는다.
    if (notifiedThisRun.has(series)) { skip('series-already-notified'); return; }
    const lastAt = ledger.lastSent.get(series);
    if (lastAt !== undefined && Date.now() - lastAt < W.COOLDOWN_DAYS * 86400000) { skip('series-cooldown'); return; }

    if (dryRun) { summary.wouldNotify++; notifiedThisRun.add(series); return; }

    // a) 무장 해제 (compare-and-set)
    const { data: cas, error: casErr } = await supabase.from('waitroom_items')
      .update({ armed: false, updated_at: nowIso }).eq('id', item.id).eq('armed', true).select('id');
    if (casErr) { console.error(`❌ 무장 해제 실패(${item.id}): ${casErr.message}`); summary.failed++; return; }
    if (!cas || !cas.length) { skip('race-lost'); return; }

    // b) 발송 기록 선점
    let note;
    try { note = await claim(item, obs, today); } catch (e) {
      console.error(`❌ ${e.message}`);
      await patchItem(item.id, { armed: true, updated_at: nowIso });
      summary.failed++;
      return;
    }
    if (!note) { skip('already-claimed'); return; }
    const noteId = note.id;
    // 이 실행에서 같은 사람·같은 상품의 다른 항목은 결과와 상관없이 더 보내지 않는다.
    notifiedThisRun.add(series);

    // c) 발송 — 공급자 키는 항목이 아니라 «계열·날짜·시도» (W.providerKey 주석)
    const result = await send({
      idempotencyKey: W.providerKey(item, today, note.attempt),
      to: item.email,
      subject: `[SEOSA] 목표가 도달 — ${String(item.title || '').slice(0, 25)}`,
      html: W.emailHtml({ title: item.title, price: obs.price, target: item.target_price, mall: item.mall,
        observedDate: obs.observedDate, link: item.link, image: item.image, origin: ORIGIN })
    });

    // d) 기록
    if (result && result.ok) {
      // 먼저 항목에 cooldown·해제를 남긴다. 발송은 수락됐지만 다음 DB 쓰기가 실패해도
      // 다음 실행이 새 날짜 키로 같은 알림을 다시 보내지 않는다.
      await patchItem(item.id, Object.assign({}, ev.patch, W.afterSend(item, obs.price, nowIso)));
      const { error: sentErr } = await supabase.from('waitroom_notifications')
        .update({ status: 'sent', sent_at: nowIso }).eq('id', noteId);
      if (sentErr) throw new Error(`발송 완료 기록 실패(${item.id}): ${sentErr.message}`);
      summary.notified++;
      console.log(`✅ ${item.id} → 목표가 도달 알림 (${obs.price}원 ≤ ${item.target_price}원)`);
    } else if (result && result.uncertain) {
      const err = String(result.error || 'delivery outcome unknown').slice(0, 300);
      const { error: claimErr } = await supabase.from('waitroom_notifications')
        .update({ error: `delivery outcome unknown: ${err}` }).eq('id', noteId).eq('status', 'claimed');
      if (claimErr) throw new Error(`미확정 발송 기록 실패(${item.id}): ${claimErr.message}`);
      await patchItem(item.id, Object.assign({}, ev.patch, { armed: false, updated_at: nowIso }));
      summary.unconfirmed++;
      skip('delivery-unconfirmed');
      console.error(`⚠️ 발송 수락 여부를 확인할 수 없음(${item.id}) — 자동 재전송하지 않습니다.`);
    } else {
      const err = String((result && result.error) || 'unknown').slice(0, 300);
      const { error: failedErr } = await supabase.from('waitroom_notifications')
        .update({ status: 'failed', error: err }).eq('id', noteId);
      if (failedErr) throw new Error(`발송 실패 기록 실패(${item.id}): ${failedErr.message}`);
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

module.exports = { run, latestObservations, claim, seriesLedger, OBS_LOOKBACK_DAYS };

