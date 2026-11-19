#!/usr/bin/env node
'use strict';
// One bounded batch of provider-issued link staging. No historical URL rewrites.
// By default reads candidates only. --execute performs ONE partner API call.
// --write additionally stores only complete, validated provider-issued results.
// Never run before a positive SEOSA2026 click exists in the official report.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeBuyLink } = require('../api/_affiliate');
const Overlay = require('../api/_coupang-link-overlay');
const CHANNEL = Overlay.CHANNEL;
const API_PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
const MAX_ITEMS = 25; // Conservative bound; respect official 100 non-search calls/hour.

function argsOf(argv) {
  const find = n => (argv.find(a => a.startsWith('--' + n + '=')) || '').split('=')[1];
  const n = Number(find('limit') || '10'), off = Number(find('offset') || '0');
  const productId = String(find('productId') || '');
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ITEMS ||
      !Number.isSafeInteger(off) || off < 0 ||
      (productId && !/^[0-9]{7,13}$/.test(productId))) throw Error('invalid bounded --limit or --offset or productId');
  return { limit: n, offset: off, productId, execute: argv.includes('--execute'), write: argv.includes('--write') };
}
function tuple(row) {
  const pid = String(row.product_id || ''), iid = String(row.item_id || '');
  const vid = String(row.vendor_item_id || '');
  if (!/^[0-9]{7,13}$/.test(pid) || !/^[0-9]{7,14}$/.test(iid) ||
      !/^[0-9]{7,14}$/.test(vid)) return null;
  return { product_id: pid, item_id: iid, vendor_item_id: vid,
    original_url: 'https://www.coupang.com/vp/products/' + pid +
      '?itemId=' + iid + '&vendorItemId=' + vid };
}
function tripleFromUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== 'www.coupang.com' ||
        !/^\/vp\/products\/[0-9]{7,13}$/.test(u.pathname)) return '';
    const pid = u.pathname.split('/').pop();
    const iid = u.searchParams.get('itemId'), vid = u.searchParams.get('vendorItemId');
    return pid + '|' + iid + '|' + vid;
  } catch (_) { return ''; }
}
function validateBatch(requested, payload) {
  if (!payload || String(payload.rCode) !== '0' || !Array.isArray(payload.data)) {
    throw Error('partner deeplink response not verified');
  }
  const expected = new Map(requested.map(r => [
    r.product_id + '|' + r.item_id + '|' + r.vendor_item_id, r
  ]));
  const good = new Map();
  for (const row of payload.data) {
    const k = tripleFromUrl(row.originalUrl);
    const original = expected.get(k);
    if (!original || good.has(k)) throw Error('unexpected or duplicate partner original URL');
    const url = safeBuyLink(row.landingUrl, { vendorItemId: original.vendor_item_id });
    if (!url || !/\/re\/AFF[A-Z]*\?/.test(url)) throw Error('invalid partner landing URL');
    const u = new URL(url);
    if (u.hostname !== 'link.coupang.com' ||
        ![...u.searchParams].some(([k,v]) => k.toLowerCase() === 'subid' && v === CHANNEL) ||
        u.searchParams.get('itemId') !== original.item_id ||
        u.searchParams.get('vendorItemId') !== original.vendor_item_id) {
      throw Error('unverified channel or option in provider URL');
    }
    good.set(k, { ...original, sub_id: CHANNEL, landing_url: url });
  }
  if (good.size !== expected.size) throw Error('incomplete partner deeplink response');
  return [...good.values()];
}
function sign() {
  const d = new Date();
  const ts = String(d.getUTCFullYear()).slice(-2) +
    String(d.getUTCMonth()+1).padStart(2,'0') + String(d.getUTCDate()).padStart(2,'0') + 'T' +
    String(d.getUTCHours()).padStart(2,'0') + String(d.getUTCMinutes()).padStart(2,'0') +
    String(d.getUTCSeconds()).padStart(2,'0') + 'Z';
  const hmac = crypto.createHmac('sha256', process.env.COUPANG_SECRET_KEY)
    .update(ts + 'POST' + API_PATH).digest('hex');
  return 'CEA algorithm=HmacSHA256, access-key=' + process.env.COUPANG_ACCESS_KEY +
    ', signed-date=' + ts + ', signature=' + hmac;
}
async function issue(rows, fetcher=fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetcher('https://api-gateway.coupang.com' + API_PATH, {
      method: 'POST',
      headers: { Authorization: sign(), 'Content-Type': 'application/json',
        'User-Agent': 'SEOSA/1.0 (+https://seosa.ai.kr)' },
      signal: ctrl.signal,
      body: JSON.stringify({ coupangUrls: rows.map(r => r.original_url), subId: CHANNEL })
    });
    if (!res.ok) throw Error('partner deeplink HTTP ' + res.status);
    const raw = await res.text();
    if (raw.length > 2*1024*1024) throw Error('partner response too large');
    return validateBatch(rows, JSON.parse(raw));
  } finally { clearTimeout(timer); }
}
async function main() {
  const opts = argsOf(process.argv.slice(2));
  if (opts.write && !opts.execute) throw Error('--write requires --execute');
  const envPath = process.env.COUPANG_ENV_FILE || path.resolve(__dirname,'..','.env.local');
  if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath, quiet:true });
  const db = require('../api/_supabase');
  let query = db.from('products')
    .select('product_id,item_id,vendor_item_id').eq('mall', '쿠팡');
  if (opts.productId) query = query.eq('product_id', opts.productId);
  const result = await query.order('product_id',{ascending:true})
    .order('vendor_item_id',{ascending:true})
    .range(opts.offset,opts.offset + opts.limit - 1);
  if (result.error) throw Error('candidate read failed');
  const rows = (result.data || []).map(tuple).filter(Boolean);
  const distinct = new Map(rows.map(r => [r.original_url,r]));
  console.log(JSON.stringify({ kind:'CHANNEL_LINK_STAGING', offset:opts.offset,
    candidates:rows.length, distinct:distinct.size, execute:opts.execute, write:opts.write }));
  if (!opts.execute || !distinct.size) return;
  if (!await Overlay.positiveOfficialClick(db)) {
    throw Error('STOP: official positive SEOSA2026 partner click has not been imported');
  }
  if (!process.env.COUPANG_ACCESS_KEY || !process.env.COUPANG_SECRET_KEY)
    throw Error('partner signing credentials unavailable');
  const issued = await issue([...distinct.values()]);
  console.log(JSON.stringify({ kind:'CHANNEL_LINK_PROVIDER_VERIFIED', count:issued.length,
    channel:CHANNEL, linkMutations:0, historicalRowsMutated:0 }));
  if (!opts.write) return;
  const upsert = await db.from('coupang_channel_deeplinks')
    .upsert(issued, { onConflict:'product_id,item_id,vendor_item_id,sub_id' });
  if (upsert.error) throw Error('staging table upsert failed');
  console.log(JSON.stringify({ kind:'CHANNEL_LINK_STAGE_WRITTEN', rows:issued.length,
    historicalRowsMutated:0 }));
}
if (require.main === module) main().catch(e => {
  console.error(JSON.stringify({kind:'CHANNEL_LINK_STAGE_FAILED',reason:String(e.message).slice(0,130)}));
  process.exitCode = 1;
});
module.exports = { argsOf, tuple, tripleFromUrl, validateBatch, issue };
