#!/usr/bin/env node
/*
 * 수집기 V3 시뮬레이션·보정용 스냅숏 — 운영 DB 를 «읽기만» 한다.
 *
 *   node scripts/collector-v3-snapshot.js <출력 폴더> [--days 14]
 *
 * 만드는 파일 (JSON):
 *   products.json            product_id, mall, keyword, collected_at …
 *   price_history.json       최근 N일 (id, product_id, mall, recorded_at, source)
 *   coupang_calls.json       최근 8일 수집기·기타 호출
 *   adpick_calls.json        최근 8일 외부 호출
 *   targets_by_bucket.json   회전 버킷 0..6 의 대상 (collector_target_page)
 *
 * 외부 API 호출 0회, DB 쓰기 0회. 키셋 페이지(1,000행)로만 읽는다.
 * 출력 폴더는 저장소 밖(스크래치)에 둘 것 — 운영 데이터 사본이다.
 */
'use strict';

require('./_env');
const fs = require('fs');
const path = require('path');
const supabase = require('../api/_supabase');

const out = process.argv[2];
if (!out) { console.error('사용법: node scripts/collector-v3-snapshot.js <출력 폴더> [--days 14]'); process.exit(2); }
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > 0 ? Math.max(1, Number(process.argv[daysArg + 1]) || 14) : 14;

async function keyset(table, columns, filter, cursor = 'id') {
  const all = [];
  let after = null, maxPage = 0;
  for (;;) {
    let q = supabase.from(table).select(columns).order(cursor, { ascending: true }).limit(1000);
    if (filter) q = filter(q);
    if (after !== null) q = q.gt(cursor, after);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (!data.length) break;
    maxPage = Math.max(maxPage, data.length);   // db-max-rows 가 요청보다 작아도 끝을 오판하지 않는다
    if (data.length < maxPage) break;
    after = data[data.length - 1][cursor];
  }
  return all;
}

async function targets(bucket) {
  const rows = [];
  let am = null, ap = null, maxPage = 0;
  for (;;) {
    const { data, error } = await supabase.rpc('collector_target_page', {
      p_rotation_days: 7, p_rotation_bucket: bucket, p_after_mall: am, p_after_product_id: ap,
      p_limit: 1000, p_include_all: false
    });
    if (error) throw new Error('collector_target_page: ' + error.message);
    rows.push(...data);
    if (!data.length) break;
    maxPage = Math.max(maxPage, data.length);
    if (data.length < maxPage) break;
    am = data[data.length - 1].mall; ap = data[data.length - 1].product_id;
  }
  return rows;
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  const since8 = new Date(Date.now() - 8 * 86400000).toISOString();
  const save = (n, v) => { fs.writeFileSync(path.join(out, n), JSON.stringify(v)); console.log(`${n} ${Array.isArray(v) ? v.length : Object.keys(v).length}`); };
  save('products.json', await keyset('products', 'id, product_id, mall, keyword, title, vendor_item_id, collected_at'));
  save('price_history.json', await keyset('price_history', 'id, product_id, mall, vendor_item_id, recorded_at, source',
    q => q.gte('recorded_at', since)));
  save('coupang_calls.json', await keyset('coupang_api_calls', 'id, called_at, source, keyword, items',
    q => q.gte('called_at', since8)));
  save('adpick_calls.json', await keyset('adpick_api_calls', 'id, called_at, kst_date, source, query, http_status, items, latency_ms, external_call',
    q => q.gte('called_at', since8)));
  const b = {};
  for (let k = 0; k < 7; k++) b[k] = await targets(k);
  save('targets_by_bucket.json', b);
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
