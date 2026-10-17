#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');
const {
  cleanVendorItemId,
  indexPriceRows,
  priceRowForAlert
} = require('../api/_alertidentity');

let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}

console.log('=== alert option identity tests ===');

// ── Pure selection contract ─────────────────────────────────────────
{
  const rows = [
    { product_id: 'P1', mall: '쿠팡', vendor_item_id: 'A', price: 12000 },
    { product_id: 'P1', mall: '쿠팡', vendor_item_id: 'B', price: 9000 },
    { product_id: 'P1', mall: '쿠팡', vendor_item_id: 'A', price: 11000 },
  ];
  const index = indexPriceRows(rows);

  const a = priceRowForAlert({ product_id: 'P1', mall: '쿠팡', vendor_item_id: 'A' }, index);
  const b = priceRowForAlert({ product_id: 'P1', mall: '쿠팡', vendor_item_id: 'B' }, index);
  const missing = priceRowForAlert({ product_id: 'P1', mall: '쿠팡', vendor_item_id: 'C' }, index);
  const legacy = priceRowForAlert({ product_id: 'P1', mall: '쿠팡', vendor_item_id: '' }, index);

  check(a && a.price === 11000, 'exact A uses the latest A observation', a && a.price);
  check(b && b.price === 9000, 'exact B uses B, not the other option', b && b.price);
  check(missing === null, 'unknown exact vendor fails closed instead of falling back');
  check(legacy && legacy.price === 11000, 'legacy empty vendor preserves product+mall latest behavior', legacy && legacy.price);
}

{
  const rows = [
    { product_id: 'P2', mall: '몰A', vendor_item_id: 'V1', price: 1000 },
    { product_id: 'P2', mall: '몰B', vendor_item_id: 'V1', price: 500 },
  ];
  const index = indexPriceRows(rows);
  const row = priceRowForAlert({ product_id: 'P2', mall: '몰A', vendor_item_id: 'V1' }, index);
  check(row && row.mall === '몰A' && row.price === 1000, 'exact alert also requires the same mall');
}

check(cleanVendorItemId('  12345  ') === '12345', 'vendor id is trimmed');
check(cleanVendorItemId('x'.repeat(250)).length === 200, 'vendor id is length-bounded');

// ── API persistence contract ────────────────────────────────────────
const db = { alerts: [] };
let vendorColumnMissing = false;

const fakeSupabase = {
  from(table) {
    return {
      upsert(row) {
        if (vendorColumnMissing && Object.prototype.hasOwnProperty.call(row, 'vendor_item_id')) {
          return Promise.resolve({ error: { message: 'column "vendor_item_id" of relation "alerts" does not exist' } });
        }
        const i = db[table].findIndex(r => r.email === row.email && r.title === row.title);
        if (i >= 0) db[table][i] = { ...db[table][i], ...row };
        else db[table].push({ ...row });
        return Promise.resolve({ error: null });
      }
    };
  }
};

const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

process.env.AUTH_SECRET = 'test-secret-alert-option';
const alertsPath = require.resolve('../api/alerts');
delete require.cache[alertsPath];
const alerts = require('../api/alerts');
const { issueToken } = require('../api/_auth');

function mkRes() {
  return {
    code: 200, payload: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.code = c; return this; },
    json(v) { this.payload = v; return this; }
  };
}

function req(body, ip) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer ' + issueToken(body.email) },
    query: {},
    body,
    socket: { remoteAddress: ip }
  };
}

async function apiTests() {
  const base = {
    email: 'option@example.com', title: '옵션 테스트', targetPrice: 9000,
    currentPrice: 10000, mall: '쿠팡', productId: 'P100', vendorItemId: 'V200',
    link: 'https://link.coupang.com/a/test', image: ''
  };

  db.alerts = [];
  vendorColumnMissing = false;
  {
    const res = mkRes();
    await alerts(req(base, '10.10.0.1'), res);
    check(res.code === 200, 'option-bound POST succeeds when schema supports it', res.code);
    check(db.alerts[0] && db.alerts[0].vendor_item_id === 'V200', 'API persists vendor_item_id exactly');
    check(res.payload && res.payload.optionBound === true, 'response confirms option binding');
  }

  db.alerts = [];
  vendorColumnMissing = true;
  {
    const res = mkRes();
    await alerts(req({ ...base, title: '옵션 컬럼 없음' }, '10.10.0.2'), res);
    check(res.code === 503, 'option-bound POST fails closed when vendor column is unavailable', res.code);
    check(db.alerts.length === 0, 'unsafe product-level fallback is not stored for option-bound request', db.alerts.length);
    check(res.payload && res.payload.optionIdentityUnavailable === true, 'caller gets explicit optionIdentityUnavailable');
  }

  db.alerts = [];
  vendorColumnMissing = true;
  {
    const res = mkRes();
    const legacy = { ...base, title: '기존 웹', vendorItemId: '' };
    await alerts(req(legacy, '10.10.0.3'), res);
    check(res.code === 200, 'legacy request without vendor keeps migration fallback', res.code);
    check(db.alerts.length === 1 && !('vendor_item_id' in db.alerts[0]), 'legacy fallback stores without vendor column');
  }
}

apiTests().then(() => {
  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
}).catch(err => {
  console.error(err);
  process.exit(1);
});
