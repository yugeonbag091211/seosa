#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const real = Module._load;
const source = require.resolve('./collect-external-hotdeals');
const supa = require.resolve('../api/_supabase');
const safeImageUrl = v => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) ? v : '';
Module._load = function(id, parent) {
  const resolved = (() => { try { return Module._resolveFilename(id, parent); } catch (_) { return ''; } })();
  if (resolved === supa) return {};
  if (resolved === source) return {
    safeImageUrl,
    IMAGE_META_KEYS: ['imageSource', 'imageProductId', 'imageMatchConfidence', 'imageMatchReason', 'imageReference'],
    probeImageUrl: async () => { throw Error('unexpected real image probe'); },
    isEphemeralImageUrl: u => /cloudfront\.net\/apis\/search_img\.php/.test(String(u)),
    enrichAffiliateRows: async () => { throw Error('unexpected real enrichment'); }
  };
  return real.apply(this, arguments);
};
const Backfill = require('./backfill-external-hotdeal-images');
Module._load = real;

// 죽은 사진 = dead.example (ADPICK search_img.php 404 대역), 나머지 https 는 열린다.
const probe = async url => (/dead\.example/.test(url)
  ? { ok: false, status: 404, reason: 'http-404' }
  : /slow\.example/.test(url) ? { ok: false, status: 0, reason: 'probe-error', transient: true }
  : { ok: true, status: 200, reason: 'ok' });

function fakeClient(rows) {
  const updates = [];
  return {
    updates,
    from(table) {
      assert.equal(table, 'external_hotdeals');
      return {
        select() { return this; }, eq() { return this; }, gte() { return this; }, order() { return this; },
        range: async () => ({ data: rows, error: null }),
        update(patch) {
          const u = { patch, where: [] };
          updates.push(u);
          return {
            eq(k, v) { u.where.push(['eq', k, v]); return this; },
            is(k, v) { u.where.push(['is', k, v]); return this; },
            then(resolve) { return Promise.resolve({ error: null }).then(resolve); }
          };
        }
      };
    }
  };
}

(async () => {
  const nowMs = Date.parse('2026-09-26T11:00:00Z');
  const rows = [
    { id: 1, title: 'A 200g', price: 9900, source_url: 'https://example.com/1', image_url: '', metadata: {} },
    { id: 2, title: 'B', price: 9000, source_url: 'https://example.com/2', image_url: 'https://img.example/B.jpg' },
    { id: 3, title: 'C', price: 9000, source_url: 'https://example.com/3', image_url: '', metadata: { imageBackfillAttemptedAt: new Date(nowMs - 1000).toISOString() } },
    { id: 4, title: 'D', price: 9000, source_url: 'https://example.com/4', image_url: '', matched_product_id: 'matched' },
    { id: 5, title: 'E', price: 9000, source_url: 'https://example.com/5', image_url: '', metadata: { imageBackfillAttemptedAt: new Date(nowMs - 13 * 3600000).toISOString() } },
    { id: 6, title: 'F 190ml', price: 9000, source_url: 'https://example.com/6', image_url: 'https://dead.example/search_img.php?code=1', metadata: { imageReference: true, imageSource: 'ADPICK' } },
    { id: 7, title: 'G', price: 9000, source_url: 'https://example.com/7', image_url: 'https://slow.example/g.jpg', metadata: {} }
  ];
  const tokenRow = { id: 8, title: 'H', price: 9000, source_url: 'https://example.com/8', image_url: 'https://d2iaagr1j041pi.cloudfront.net/apis/search_img.php?code=496601772', metadata: {} };

  // 1) 선택 — 예전 규칙(형식만)과 새 규칙(실제로 열리는가)
  assert.deepEqual(Backfill.chooseRows(rows, nowMs, 8).map(r => r.id), [1, 5], 'format-only selection is unchanged');
  assert.deepEqual(Backfill.chooseRows(rows, nowMs, 1).map(r => r.id), [1]);
  const live = new Map();
  for (const r of rows) if (safeImageUrl(r.image_url)) live.set(r.id, await probe(r.image_url));
  assert.deepEqual(Backfill.chooseRows(rows, nowMs, 8, { live }).map(r => r.id), [1, 5, 6],
    'a stored photo that returns 404 is re-searched; an unverifiable (timeout) photo is left alone');
  assert.deepEqual(Backfill.chooseRows(rows, nowMs, 8, { live, force: true }).map(r => r.id), [1, 3, 5, 6],
    '--force ignores the 12h cooldown but never touches affiliate-matched rows');

  // 2) 감사 — 쇼핑 API 없이 사진 상태만 센다
  const a = Backfill.audit(rows, live);
  assert.equal(a.window, 7); assert.equal(a.validImage, 1); assert.equal(a.deadImage, 1);
  assert.equal(a.unverifiable, 1); assert.equal(a.noImage, 4);
  assert.deepEqual(a.deadByHost, { 'dead.example': 1 });
  const auditClient = fakeClient(rows);
  const report = await Backfill.main({ db: auditClient, nowMs, audit: true, probeImage: probe,
    enrich: async () => { throw Error('audit must not search'); } });
  assert.equal(report.deadImage, 1);
  assert.equal(auditClient.updates.length, 0, 'audit writes nothing');

  // 3) 채우기 — 빈 카드는 채우고, 죽은 사진 카드는 새 사진으로 고치거나(없으면) 비운다
  const client = fakeClient(rows);
  const summary = await Backfill.main({
    db: client, nowMs, rowLimit: 8, probeImage: probe,
    enrich: async (_deals, changed) => {
      const r = changed[0];
      assert.equal(r.image_url, '', 'dead photo is cleared before the search');
      assert.equal('imageReference' in r.metadata, false, 'stale photo labels go with the dead photo');
      if (r.id === 1) {
        r.image_url = 'https://img.example/A.jpg';
        r.metadata.imageReference = true;
        r.metadata.imageLookup = { outcome: 'image' };
        r.matched_product_id = null;
      } else if (r.id === 6) {
        r.metadata.imageLookup = { outcome: 'image-dead' };
      } else {
        r.metadata.imageLookup = { outcome: 'no-results' };
      }
    }
  });
  assert.equal(summary.selected, 3);
  assert.equal(summary.imageFilled, 1);
  assert.equal(summary.deadCleared, 1);
  assert.equal(summary.deadRepaired, 0);
  assert.equal(summary.affiliateMatched, 0);
  assert.deepEqual(summary.outcomes, { image: 1, 'image-dead': 1, 'no-results': 1 });
  assert.equal(summary.before.deadImage, 1);

  const byId = id => client.updates.find(u => u.where.some(w => w[0] === 'eq' && w[1] === 'id' && w[2] === id));
  const u1 = byId(1);
  assert.equal(u1.patch.image_url, 'https://img.example/A.jpg');
  assert.equal(u1.patch.metadata.imageReference, true);
  assert.equal('verification_status' in u1.patch, false, 'never marks a community deal as price-verified');
  assert.equal('matched_product_id' in u1.patch, false, 'a photo never grants an affiliate identity');
  const u6 = byId(6);
  assert.equal(u6.patch.image_url, '', 'a dead photo with no live replacement is cleared to "" (image_url is NOT NULL in production)');
  assert.equal(u6.patch.metadata.imageDeadUrl, 'https://dead.example/search_img.php?code=1');
  assert.equal(u6.patch.metadata.imageDeadReason, 'http-404');
  assert.ok(u6.where.some(w => w[0] === 'eq' && w[1] === 'image_url' && w[2] === rows[5].image_url),
    'CAS on the exact photo value we read — a concurrent fill is not overwritten');
  assert.ok(u1.where.some(w => w[0] === 'eq' && w[1] === 'image_url' && w[2] === ''));

  // 4) 0.90 identity 만 제휴로 저장된다
  const client2 = fakeClient([rows[0]]);
  const s2 = await Backfill.main({ db: client2, nowMs, rowLimit: 1, probeImage: probe,
    enrich: async (_d, changed) => {
      changed[0].image_url = 'https://img.example/A.jpg';
      changed[0].matched_product_id = 'p9'; changed[0].match_confidence = 0.93; changed[0].match_method = 'affiliate-identity';
    } });
  assert.equal(s2.affiliateMatched, 1);
  assert.equal(client2.updates[0].patch.matched_product_id, 'p9');
  const client3 = fakeClient([rows[0]]);
  const s3 = await Backfill.main({ db: client3, nowMs, rowLimit: 1, probeImage: probe,
    enrich: async (_d, changed) => { changed[0].matched_product_id = 'p9'; changed[0].match_confidence = 0.8; } });
  assert.equal(s3.affiliateMatched, 0, 'below 0.90 is never stored as an affiliate identity');
  assert.equal('matched_product_id' in client3.updates[0].patch, false);

  // 5) ADPICK 임시 토큰 — 지금 열려도(프로브 ok) 저장된 사진으로 인정하지 않는다
  let probedToken = 0;
  const tokenClient = fakeClient([tokenRow]);
  const s5 = await Backfill.main({ db: tokenClient, nowMs, rowLimit: 1,
    probeImage: async () => { probedToken++; return { ok: true, status: 200 }; },
    enrich: async (_d, changed) => { assert.equal(changed[0].image_url, ''); changed[0].metadata.imageLookup = { outcome: 'no-safe-candidate' }; } });
  assert.equal(probedToken, 0, 'a search_img.php token is not even probed');
  assert.equal(s5.before.deadImage, 1); assert.equal(s5.deadCleared, 1);
  assert.equal(tokenClient.updates[0].patch.metadata.imageDeadReason, 'ephemeral-adpick');

  // 6) dry-run — 사진을 열어 보지 않는다. 판정 없는 사진을 «죽음» 으로 세지 않는다(운영 dry-run 이 86 으로 찍었다)
  const dryClient = fakeClient([rows[1], tokenRow, rows[0]]);
  const s6 = await Backfill.main({ db: dryClient, nowMs, dryRun: true, rowLimit: 12,
    probeImage: async () => { throw Error('dry-run must not probe'); },
    enrich: async () => { throw Error('dry-run must not search'); } });
  assert.equal(s6.before.unprobed, 1, 'a normal photo is unprobed, not dead');
  assert.equal(s6.before.deadImage, 1, 'an ADPICK token is dead by its URL shape alone');
  assert.equal(s6.before.validImage, 0);
  assert.equal(s6.selected, 2, 'token row + empty row would be filled');
  assert.equal(s6.searched, 0);
  assert.equal(dryClient.updates.length, 0, 'dry-run writes nothing');

  // 7) --recheck-reference — 옛 규칙으로 고른 참고 사진(후보 제목 없음)만 다시 판정한다
  const oldRef = { id: 21, title: '매일두유 검은콩 190ml 48팩', price: 24785, source_url: 'https://example.com/21',
    image_url: 'https://img.example/kunkook.jpg', metadata: { imageReference: true, imageBackfillAttemptedAt: new Date(nowMs - 1000).toISOString() } };
  const oldRefKeep = { id: 22, title: '코카콜라 제로 190ml 30개', price: 17900, source_url: 'https://example.com/22',
    image_url: 'https://img.example/cola.jpg', metadata: { imageReference: true } };
  const newRef = { id: 23, title: 'X', price: 1000, source_url: 'https://example.com/23',
    image_url: 'https://img.example/x.jpg', metadata: { imageReference: true, imageCandidateTitle: 'X 후보' } };
  const exact = { id: 24, title: 'Y', price: 1000, source_url: 'https://example.com/24',
    image_url: 'https://img.example/y.jpg', metadata: { imageReference: false } };
  const liveR = new Map([[21, { ok: true }], [22, { ok: true }], [23, { ok: true }], [24, { ok: true }]]);
  assert.deepEqual(Backfill.chooseRows([oldRef, oldRefKeep, newRef, exact], nowMs, 8, { live: liveR }).map(r => r.id), [],
    'without the flag, live photos are never re-searched');
  assert.deepEqual(Backfill.chooseRows([oldRef, oldRefKeep, newRef, exact], nowMs, 8, { live: liveR, recheckReference: true }).map(r => r.id), [21, 22],
    'only old-rule reference photos are rechecked (not new-rule or exact-match photos), cooldown ignored');
  const rc = fakeClient([oldRef, oldRefKeep, newRef, exact]);
  const s7 = await Backfill.main({ db: rc, nowMs, rowLimit: 8, recheckReference: true, probeImage: probe,
    enrich: async (_d, changed) => {
      const r = changed[0];
      assert.equal(r.image_url, '', 'the photo under review is cleared before the new search');
      if (r.id === 22) { r.image_url = 'https://img.example/cola.jpg'; r.metadata.imageCandidateTitle = '코카콜라 제로 190ml 24개'; r.metadata.imageReference = true; }
      r.metadata.imageLookup = { outcome: r.image_url ? 'image' : 'no-safe-candidate' };
    } });
  assert.equal(s7.recheckCleared, 1); assert.equal(s7.recheckKept, 1); assert.equal(s7.deadCleared, 0);
  const u21 = rc.updates.find(u => u.where.some(w => w[1] === 'id' && w[2] === 21));
  assert.equal(u21.patch.image_url, '');
  assert.equal(u21.patch.metadata.imageRevoked.url, 'https://img.example/kunkook.jpg');
  assert.equal(u21.patch.metadata.imageReference, undefined, 'the label goes with the revoked photo');
  assert.equal('imageDeadUrl' in u21.patch.metadata, false, 'a revoked photo is not reported as dead');

  console.log('Community image backfill offline checks PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
