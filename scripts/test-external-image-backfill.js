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
  assert.equal(u6.patch.image_url, null, 'a dead photo with no live replacement is cleared (card shows the placeholder)');
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

  console.log('Community image backfill offline checks PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
