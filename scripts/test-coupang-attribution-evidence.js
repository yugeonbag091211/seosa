#!/usr/bin/env node
'use strict';
/**
 * Offline tests for *browser-reported* click channel evidence.
 * No affiliate API traffic, no real DB access, no conversion writes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

process.env.COUPANG_CHANNEL_SUBID = 'SEOSA2026';
delete process.env.ANALYTICS_DISABLED;
let inserts = [];
let providerSelects = [];
const eventRows = [];
function fakeQuery(table) {
  const chain = {
    select(cols) { providerSelects.push({table,cols});return chain; },
    gte() { return chain; },
    limit() { return Promise.resolve({
      data: table === 'funnel_events' ? eventRows : [],
      error: null
    }); },
    insert(row) {
      if (table !== 'funnel_events') throw Error('unexpected table for INSERT '+table);
      inserts.push(row);
      return Promise.resolve({ error: null });
    }
  };
  return chain;
}
const fakeDb = { from(table) { return fakeQuery(table); } };
const origLoad = Module._load;
Module._load = function(req) {
  if (req === './_supabase') return fakeDb;
  return origLoad.apply(this, arguments);
};
const funnel = require('../api/_funnel');
Module._load = origLoad;

let passed = 0;
function check(yes, desc) {
  assert.ok(yes, desc);
  console.log('[PASS] '+desc);
  passed++;
}
const classify = funnel._internal.clientChannel;
const valid = { event:'affiliate_click', mall:'쿠팡',source:'search',channelSubId:'SEOSA2026' };
check(classify(valid)==='SEOSA2026','configured Coupang search click is labeled');
check(classify({...valid,source:'product'})==='SEOSA2026','future product-page clicks can be labeled');
check(classify({...valid,source:'hotdeal'})==='SEOSA2026','future hotdeal clicks can be labeled');
check(classify({...valid,source:'no-such-source'})==='','unknown click source is not labeled');
check(classify({...valid,mall:'ADPICK'})==='','other merchants not labeled');
check(classify({...valid,event:'radar_save'})==='','only purchase-link click events labeled');
check(classify({...valid,channelSubId:'FAKE2026'})==='','arbitrary browser SUBID discarded');
delete process.env.COUPANG_CHANNEL_SUBID;
check(classify(valid)==='','missing configured SUBID fails closed');
process.env.COUPANG_CHANNEL_SUBID = 'SEOSA2026';

(async()=>{
  let r=await funnel.track({
    event:'affiliate_click', mall:'쿠팡', productId:'PID-1',
    source:'search', channelSubId:'SEOSA2026', price:299000
  });
  check(r.ok && inserts.length===1 && inserts[0].sub_id==='SEOSA2026',
    'tagged click persists only bounded channel label');
  check(!('link' in inserts[0]) && !('url' in inserts[0]) && !('user_agent' in inserts[0]),
    'raw affiliate URLs and browser identifiers are not stored');
  r=await funnel.track({event:'affiliate_click',mall:'쿠팡',source:'search',
    channelSubId:'FORGED_ID',price:1});
  check(r.ok && inserts[1].sub_id==='','forged label becomes empty, click remains counted');
  r=await funnel.track({event:'radar_save',mall:'쿠팡',source:'search',
    channelSubId:'SEOSA2026'});
  check(r.ok && inserts[2].sub_id==='','non-click is never tagged');

  eventRows.push({event:'affiliate_click',product_id:'PID-1',mall:'쿠팡',price:299000,
    source:'search',sub_id:'SEOSA2026'});
  eventRows.push({event:'affiliate_click',product_id:'PID-2',mall:'쿠팡',price:45000,
    source:'hotdeal',sub_id:''});
  eventRows.push({event:'affiliate_click',product_id:'PID-3',mall:'ADPICK',price:20000,
    source:'product',sub_id:''});
  eventRows.push({event:'buy_wait_watch_view',product_id:'PID-1',mall:'쿠팡',price:299000,
    source:'product',sub_id:''});
  const report = await funnel.report(7);
  const observed = report.clientReportedChannelClicks;
  check(observed.basis==='browser_unverified'
    && observed.byChannel.SEOSA2026===1 && observed.bySource.search===1,
    'admin report distinguishes client-observed channel clicks');
  check(report.byMall['쿠팡']===2 && report.byMall['ADPICK']===1,
    'legacy affiliate click totals preserved');
  check(report.gmv===null && report.commissionRevenue===null
    && report.conversionsPending === true,
    'client clicks never become partner conversions/revenue');
  check(providerSelects.some(q=>q.table==='funnel_events' && q.cols.includes('sub_id')),
    'admin report queries sub_id field');

  const root=path.resolve(__dirname,'..');
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
  const trackingScript=scripts.find(s=>s.includes('affiliate: function(it, src)'));
  check(!!trackingScript && trackingScript.includes('sid=SEOSA2026'),
    'home/search frontend submits channel evidence only on tagged links');
  new vm.Script(trackingScript, {filename:'public/index.html:inline.js'});
  check(true,'home/search inline JavaScript syntax valid');
  const product=fs.readFileSync(path.join(root,'api/_product-page.js'),'utf8');
  check(product.includes("if(name==='affiliate_click'&&affiliate)")
    && product.includes("'&sid=SEOSA2026'"),
    'product-page click measurement ready for a future approved rollout');
  const stats=fs.readFileSync(path.join(root,'api/stats.js'),'utf8');
  check(stats.includes('channelSubId: q.sid'), 'stats endpoint forwards click channel evidence');
  console.log('PASS '+passed+' / FAIL 0 (no external API or DB writes)');
})().catch(e=>{
  console.error('FAIL '+(e&&e.stack||e));
  process.exitCode=1;
});
