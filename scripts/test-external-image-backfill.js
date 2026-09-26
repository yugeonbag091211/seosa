#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const real = Module._load;
const source = require.resolve('./collect-external-hotdeals');
const supa = require.resolve('../api/_supabase');
Module._load = function(id, parent) {
  const resolved = (() => { try { return Module._resolveFilename(id, parent); } catch (_) { return ''; } })();
  if (resolved === supa) return {};
  if (resolved === source) return {
    safeImageUrl: v => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) ? v : '',
    enrichAffiliateRows: async () => { throw Error('unexpected real enrichment'); }
  };
  return real.apply(this, arguments);
};
const Backfill = require('./backfill-external-hotdeal-images');
Module._load = real;
(async () => {
  const nowMs = Date.parse('2026-09-26T11:00:00Z');
  const rows = [
    {id:1,title:'A 200g',price:9900,source_url:'https://example.com/1',image_url:'',metadata:{}},
    {id:2,title:'B',price:9000,source_url:'https://example.com/2',image_url:'https://img.example/B.jpg'},
    {id:3,title:'C',price:9000,source_url:'https://example.com/3',image_url:'',metadata:{imageBackfillAttemptedAt:new Date(nowMs-1000).toISOString()}},
    {id:4,title:'D',price:9000,source_url:'https://example.com/4',image_url:'',matched_product_id:'matched'},
    {id:5,title:'E',price:9000,source_url:'https://example.com/5',image_url:'',metadata:{imageBackfillAttemptedAt:new Date(nowMs-13*3600000).toISOString()}}
  ];
  assert.deepEqual(Backfill.chooseRows(rows,nowMs,8).map(r=>r.id),[1,5]);
  assert.deepEqual(Backfill.chooseRows(rows,nowMs,1).map(r=>r.id),[1]);
  const updates = [];
  const client = {
    from(table) {
      assert.equal(table,'external_hotdeals');
      return {
        select() {return this;},eq() {return this;},gte() {return this;},order() {return this;},
        limit:async()=>({data:rows,error:null}),
        update(patch) {
          return {eq(k,v){this.where=[k,v];return this;},is(){return this;},
            then(resolve){updates.push(patch);return Promise.resolve({error:null}).then(resolve);}};
        }
      };
    }
  };
  const summary = await Backfill.main({
    db:client,nowMs,rowLimit:1,
    enrich:async(_deals, changed)=>{
      changed[0].image_url='https://img.example/A.jpg';
      changed[0].metadata.imageReference=true;
      changed[0].matched_product_id=null;
    }
  });
  assert.equal(summary.imageFilled,1);
  assert.equal(summary.affiliateMatched,0);
  assert.equal(updates.length,1);
  assert.equal(updates[0].image_url,'https://img.example/A.jpg');
  assert.equal(updates[0].metadata.imageReference,true);
  assert.equal('verification_status' in updates[0],false);
  console.log('Community image backfill offline checks PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
