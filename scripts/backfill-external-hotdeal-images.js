#!/usr/bin/env node
'use strict';

/**
 * Bounded image backfill for recent community cards already stored without a working photo.
 *
 *   node scripts/backfill-external-hotdeal-images.js            # fill up to ROW_LIMIT cards
 *   node scripts/backfill-external-hotdeal-images.js --audit    # read-only report, no shopping API calls
 *   node scripts/backfill-external-hotdeal-images.js --dry-run  # choose rows only, no calls, no writes
 *     --hours N (window, default 72)  --rows N (max cards this run)  --force (ignore the 12h cooldown)
 *
 * Uses the exact same official Coupang/ADPICK search, provider rate limiters,
 * model/variant/capacity guards and reference-image labeling as the live Radar collector.
 * Does not scrape community sites, invent photos or mark deals price-verified.
 *
 * 2026-09-26: a stored photo counts only if it actually loads. ADPICK's
 * cloudfront search_img.php photos answer 404 (63 of 143 stored card photos), and the
 * card then showed an empty box with a «참고 이미지» label. Those rows are now
 * re-searched; if no live photo is found the dead URL is cleared (kept in
 * metadata.imageDeadUrl) so the card shows the normal placeholder.
 */
require('./_env');
const db = require('../api/_supabase');
const {
  enrichAffiliateRows, safeImageUrl, probeImageUrl, isEphemeralImageUrl, IMAGE_META_KEYS
} = require('./collect-external-hotdeals');

const COOLDOWN_HOURS = 12;
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? Number(process.argv[i + 1]) : NaN;
};
const HOURS = Math.max(1, Math.min(24 * 30, argValue('--hours') || 72));
const ROW_LIMIT = Math.max(1, Math.min(200,
  argValue('--rows') || Number(process.env.EXTERNAL_IMAGE_BACKFILL_ROWS) || 8));
const DRY_RUN = process.argv.includes('--dry-run');
const AUDIT = process.argv.includes('--audit');
const FORCE = process.argv.includes('--force');
// 옛 규칙(브랜드 닻 이전)으로 고른 참고 사진을 다시 판정한다 — 새 규칙을 통과하는 사진이 없으면 비운다.
const RECHECK_REFERENCE = process.argv.includes('--recheck-reference');

/**
 * 채울 행을 고른다. `live` 는 이미 검사한 사진 판정(id → probe 결과)이다 —
 * 없으면 형식만 본다(예전 동작).
 */
function chooseRows(rows, nowMs, max = ROW_LIMIT, opts = {}) {
  const cutoff = nowMs - COOLDOWN_HOURS * 3600000;
  const live = opts.live || null;
  return (rows || []).filter(r => {
    if (!r || !r.id || !r.title || !r.source_url || !Number(r.price)) return false;
    if (r.matched_product_id) return false;
    const url = safeImageUrl(r.image_url);
    if (opts.recheckReference && url && live && live.has(r.id) && live.get(r.id).ok
      && r.metadata && r.metadata.imageReference === true && !r.metadata.imageCandidateTitle) return true;
    if (url && (!live || !live.has(r.id) || live.get(r.id).ok || live.get(r.id).transient)) return false;
    if (opts.force) return true;
    const last = Date.parse(r.metadata && r.metadata.imageBackfillAttemptedAt || '');
    return !Number.isFinite(last) || last < cutoff;
  }).slice(0, max);
}

async function loadWindow(client, nowMs, hours) {
  const since = new Date(nowMs - hours * 3600000).toISOString();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from('external_hotdeals')
      .select('id,source,source_post_id,source_url,title,price,mall,product_url,image_url,metadata,matched_product_id,match_confidence,posted_at')
      .eq('is_primary', true)
      .gte('posted_at', since)
      .order('posted_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error('load recent community deals: ' + error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

/** 저장된 사진을 전부 열어 본다 (이미지 CDN GET — 쇼핑 API 호출이 아니다). */
async function probeStored(rows, probe) {
  const live = new Map();
  for (const r of rows) {
    const url = safeImageUrl(r.image_url);
    // ADPICK search_img.php 는 임시 토큰 — 지금 열려도 몇 시간 뒤 404 (collect-external-hotdeals 주석).
    if (url) live.set(r.id, isEphemeralImageUrl(url) ? { ok: false, status: 0, reason: 'ephemeral-adpick' } : await probe(url));
  }
  return live;
}

/** 네트워크 없이 내릴 수 있는 판정만 — ADPICK 임시 토큰은 주소만 보고 죽은 사진이다. */
function staticVerdicts(rows) {
  const live = new Map();
  for (const r of rows) {
    const url = safeImageUrl(r.image_url);
    if (url && isEphemeralImageUrl(url)) live.set(r.id, { ok: false, status: 0, reason: 'ephemeral-adpick' });
  }
  return live;
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return '?'; }
}

function audit(rows, live) {
  const out = { window: rows.length, validImage: 0, deadImage: 0, unverifiable: 0, unprobed: 0, noImage: 0,
    affiliateLinked: 0, deadByHost: {}, lookupOutcomes: {} };
  for (const r of rows) {
    const url = safeImageUrl(r.image_url);
    const p = url ? live.get(r.id) : null;
    if (!url) out.noImage++;
    // dry-run 은 사진을 열어 보지 않는다 — 판정이 없는 사진을 «죽음» 으로 세지 않는다.
    else if (!p) out.unprobed++;
    else if (p && p.ok) out.validImage++;
    else if (p && p.transient) out.unverifiable++;
    else { out.deadImage++; const h = hostOf(url); out.deadByHost[h] = (out.deadByHost[h] || 0) + 1; }
    if (r.metadata && r.metadata.affiliateUrl && r.matched_product_id) out.affiliateLinked++;
    const oc = r.metadata && r.metadata.imageLookup && r.metadata.imageLookup.outcome;
    if (oc) out.lookupOutcomes[oc] = (out.lookupOutcomes[oc] || 0) + 1;
  }
  return out;
}

async function main(opts = {}) {
  const client = opts.db || db;
  const enrich = opts.enrich || enrichAffiliateRows;
  const probe = opts.probeImage || (url => probeImageUrl(url));
  const nowMs = opts.nowMs || Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const dryRun = DRY_RUN || !!opts.dryRun;
  const auditOnly = AUDIT || !!opts.audit;
  const hours = opts.hours || HOURS;
  const rowLimit = opts.rowLimit || ROW_LIMIT;

  const rows = await loadWindow(client, nowMs, hours);
  // dry-run 은 외부로 아무것도 부르지 않는다 — ADPICK 임시 토큰만 주소 모양으로 가린다.
  const live = dryRun ? staticVerdicts(rows) : await probeStored(rows, probe);
  const before = audit(rows, live);
  if (auditOnly) {
    const report = { event: 'image_audit', hours, ...before };
    console.log(JSON.stringify(report));
    return report;
  }

  const recheckReference = RECHECK_REFERENCE || !!opts.recheckReference;
  const chosen = chooseRows(rows, nowMs, rowLimit, { live, force: FORCE || !!opts.force, recheckReference });
  const stats = {
    hours, window: rows.length,
    before: { validImage: before.validImage, deadImage: before.deadImage, noImage: before.noImage,
      unverifiable: before.unverifiable, unprobed: before.unprobed, affiliateLinked: before.affiliateLinked },
    eligible: chooseRows(rows, nowMs, Infinity, { live, force: true }).length,
    selected: chosen.length, searched: 0, imageFilled: 0, deadRepaired: 0, deadCleared: 0,
    recheckKept: 0, recheckReplaced: 0, recheckCleared: 0,
    affiliateMatched: 0, outcomes: {}, errors: 0, dryRun
  };
  if (dryRun) { console.log(JSON.stringify(stats)); return stats; }

  for (const original of chosen) {
    const oldUrl = safeImageUrl(original.image_url) || '';
    const verdict = live.get(original.id);
    // 열리는 사진인데 뽑혔다면 --recheck-reference 대상이다(죽은 사진이 아니다).
    const recheckUrl = oldUrl && verdict && verdict.ok ? oldUrl : '';
    const deadUrl = oldUrl && !recheckUrl ? oldUrl : '';
    const meta0 = { ...(original.metadata || {}) };
    if (oldUrl) IMAGE_META_KEYS.forEach(k => { delete meta0[k]; });
    // 죽은 사진은 비운 상태로 다시 찾는다 — enrich 는 사진이 없는 행만 채운다.
    const row = { ...original, image_url: '', metadata: meta0 };
    const deal = {
      title: original.title, price: Number(original.price), mall: original.mall,
      postUrl: original.source_url, productUrl: original.product_url || '',
      metadata: original.metadata || {}
    };
    try {
      // 한 카드에 검색어 세 개까지(전체 제목 → 앞 5단어 → 앞 3단어). ADPICK 은 첫 검색어만.
      // 백필은 서두를 일이 없다 — 리미터가 분당 창을 기다리라고 하면 기다린다(건너뛰지 않는다).
      await enrich([deal], [row], { lookupLimit: 1, searchLimit: 3, probeImage: probe, nowMs, maxWaitMs: 65000 });
      stats.searched++;
      const photo = safeImageUrl(row.image_url);
      const lookup = row.metadata && row.metadata.imageLookup;
      const outcome = (lookup && lookup.outcome) || (photo ? 'image' : 'unknown');
      stats.outcomes[outcome] = (stats.outcomes[outcome] || 0) + 1;

      const patch = {
        // image_url 은 NOT NULL 이다(운영 스키마). 비울 때는 빈 문자열.
        image_url: photo || '',
        metadata: {
          ...row.metadata,
          imageBackfillAttemptedAt: nowIso,
          ...(deadUrl ? { imageDeadUrl: deadUrl, imageDeadReason: String((live.get(original.id) || {}).reason || ''), imageDeadAt: nowIso } : {}),
          ...(recheckUrl && !photo ? { imageRevoked: { url: recheckUrl, at: nowIso,
            reason: '참고 사진 재판정 — 머리말(브랜드) 닻·용량 규칙을 통과하는 후보 없음' } } : {})
        }
      };
      // A verified 0.90 identity may be stored, but never alter verification_status
      // or interpret an affiliate search price as the original community deal price.
      if (row.matched_product_id && Number(row.match_confidence) >= 0.90) {
        patch.matched_product_id = row.matched_product_id;
        patch.matched_mall = row.matched_mall || '';
        patch.matched_vendor_item_id = row.matched_vendor_item_id || '';
        patch.match_confidence = row.match_confidence;
        patch.match_method = row.match_method || '';
      }
      // CAS — 우리가 읽은 사진 값 그대로일 때만 바꾼다(그 사이 수집기가 채웠으면 건드리지 않는다).
      let update = client.from('external_hotdeals').update(patch).eq('id', original.id);
      update = original.image_url == null ? update.is('image_url', null) : update.eq('image_url', original.image_url);
      const saved = await update;
      if (saved.error) throw new Error('update image metadata: ' + saved.error.message);
      if (recheckUrl) stats[photo ? (photo === recheckUrl ? 'recheckKept' : 'recheckReplaced') : 'recheckCleared']++;
      else if (photo && deadUrl) stats.deadRepaired++;
      else if (photo) stats.imageFilled++;
      else if (deadUrl) stats.deadCleared++;
      if (patch.matched_product_id) stats.affiliateMatched++;
    } catch (e) {
      stats.errors++;
      console.error(JSON.stringify({ event: 'image_backfill_failed', id: original.id, reason: String(e.message || e) }));
    }
  }
  console.log(JSON.stringify({ event: 'image_backfill', ...stats }));
  return stats;
}

if (require.main === module) main().catch(e => {
  console.error(JSON.stringify({ event: 'image_backfill_fatal', reason: String(e.message || e) }));
  process.exitCode = 1;
});
module.exports = { chooseRows, main, audit };
