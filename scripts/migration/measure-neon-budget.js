#!/usr/bin/env node
/*
 * Neon 무료 한도 예산 측정 — 읽기 전용, 격리된 테스트 브랜치에서만.
 *
 *   (with-neon 래퍼가 NEON_DATABASE_URL 을 프로세스 환경으로만 넣는다)
 *   node scripts/migration/measure-neon-budget.js
 *
 *   A  저장 용량 · 하루 증가량 · 수집기의 큰 읽기 크기 — 집계만 DB 안에서 계산한다(전송 ~0).
 *   B  사이트 API 한 번이 Neon 에서 받아 오는 질의 수 · 행 수 · 추정 바이트(_neonpg 측정 훅).
 *
 * Neon Free(2026-10-21 공식 문서): 저장 1GB/프로젝트 · 연산 100 CU-시간/월 · 공용망 전송 5GB/월.
 * 한도를 넘으면 compute 가 다음 결제 주기까지 멈춘다(전송·연산) 또는 쓰기가 실패한다(저장).
 */
'use strict';

const pg = require('pg');
const { assertIsolatedBranch } = require('./_neon-sandbox');

const MB = n => (n / 1048576).toFixed(1) + 'MB';
const KB = n => (n / 1024).toFixed(1) + 'KB';

async function partA(url) {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const q = async (t, a) => (await c.query(t, a)).rows;
  console.log('[A) 저장 용량]');
  const [db] = await q(`select pg_database_size(current_database())::bigint b`);
  console.log(`  DB 전체 ${MB(Number(db.b))} / 무료 1,024MB (프로젝트 전체 브랜치 합)`);
  const idx = await q(`select indexrelname n, pg_relation_size(indexrelid)::bigint b from pg_stat_user_indexes where relname='price_history' order by 2 desc`);
  const [ph] = await q(`select pg_relation_size('price_history')::bigint heap, pg_total_relation_size('price_history')::bigint total, (select count(*) from price_history)::bigint n`);
  console.log(`  price_history: 행 ${ph.n} · 표 ${MB(Number(ph.heap))} · 인덱스 ${idx.length}개 ${MB(idx.reduce((s, r) => s + Number(r.b), 0))} · 합 ${MB(Number(ph.total))} → 행당 ${(Number(ph.total) / Number(ph.n)).toFixed(0)}B`);
  idx.forEach(r => console.log(`     ${r.n.padEnd(48)} ${MB(Number(r.b))}`));

  console.log('\n[A) 하루 증가량 — Supabase 마지막 3주]');
  const days = await q(`select (recorded_at at time zone 'Asia/Seoul')::date d, count(*)::int n
    from price_history where recorded_at >= timestamptz '2026-09-29 15:00+00' group by 1 order by 1`);
  const ns = days.map(r => r.n);
  const avg = ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0;
  console.log(`  price_history 신규 행/일: 평균 ${avg.toFixed(0)} · 최대 ${Math.max(...ns)} (${days.length}일) → ${MB(avg * Number(ph.total) / Number(ph.n))}/일 · ${MB(avg * 30 * Number(ph.total) / Number(ph.n))}/월`);
  const logs = await q(`select 'coupang_api_calls' t, count(*) filter (where created_at >= now() - interval '30 days')::int n30, pg_total_relation_size('coupang_api_calls')::bigint b, count(*)::int n from coupang_api_calls
    union all select 'adpick_api_calls', count(*) filter (where created_at >= now() - interval '30 days')::int, pg_total_relation_size('adpick_api_calls')::bigint, count(*)::int from adpick_api_calls`).catch(() => []);
  logs.forEach(r => console.log(`  ${r.t}: ${r.n}행 ${MB(Number(r.b))} (최근 30일 ${r.n30}행)`));

  console.log('\n[A) 수집기의 큰 읽기 — 한 번 읽을 때 Neon 이 내보낼 텍스트 크기]');
  for (const t of ['coupang_search_cache', 'adpick_search_cache']) {
    const [r] = await q(`select count(*)::int n, coalesce(sum(octet_length(keyword) + octet_length(items::text)), 0)::bigint b,
      count(*) filter (where fetched_at >= now() - interval '24 hours')::int fresh from ${t}`);
    console.log(`  ${t} 전체 스캔(keyword, items): ${r.n}행 · ${MB(Number(r.b))} (24시간 안 행 ${r.fresh})`);
  }
  const [prod] = await q(`select count(*)::int n, sum(octet_length(product_id) + octet_length(mall) + octet_length(coalesce(title,'')) + octet_length(coalesce(keyword,''))
    + octet_length(coalesce(link,'')) + octet_length(coalesce(image,'')) + octet_length(coalesce(vendor_item_id,'')) + octet_length(coalesce(item_id,'')))::bigint b from products`);
  console.log(`  products 전체(수집기 PRODUCT_COLS): ${prod.n}행 · ${MB(Number(prod.b))}`);
  const [hist] = await q(`select sum(octet_length(product_id) + octet_length(mall) + octet_length(vendor_item_id) + 8)::bigint b, count(*)::int n from price_history`);
  console.log(`  price_history 전체 키셋(id, product_id, mall, vendor_item_id): ${MB(Number(hist.b))}`);
  await c.end();
}

function mockRes() {
  return {
    code: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; }, end(b) { if (b) this.body = b; return this; }
  };
}

async function partB() {
  console.log('\n[B) 사이트 API 1회(CDN 캐시 미스)당 Neon 질의 · 전송 추정]');
  const { _internal, client } = require('../../api/_neonpg');
  let acc = null;
  _internal.setTrace(e => { if (acc) { acc.q++; acc.rows += e.rows; acc.bytes += e.bytes; } });
  const history = require('../../api/history');
  const routes = [
    ['/api/init', require('../../api/init'), { }],
    ['/api/hotdeals', require('../../api/hotdeals'), {}],
    ['/api/history 단건 (DB 만)', history, { productId: '7912306911', mall: '쿠팡' }],
    ['/p/{pid} 상품 페이지', history, { __route: 'page', pid: '7912306911' }],
    ['/category 허브', history, { __route: 'hub' }],
    ['/sitemap.xml', history, { __route: 'sitemap-index' }],
    ['/sitemaps/pages.xml', history, { __route: 'sitemap-file', file: 'pages.xml' }],
    ['/api/rec', require('../../api/rec'), {}],
    ['/api/alternatives', history, { __route: 'alternatives', pid: '7912306911', mall: '쿠팡' }],
    ['/api/radar', history, { __route: 'radar' }]
  ];
  const warn = console.warn; const log = console.log; const err = console.error;
  const out = [];
  for (const [label, h, query] of routes) {
    // 같은 인스턴스 캐시(메모리) 효과를 빼려고 두 번째 호출이 아니라 첫 호출을 잰다.
    acc = { q: 0, rows: 0, bytes: 0 };
    const t0 = Date.now();
    console.warn = () => {}; console.log = () => {}; console.error = () => {};
    const res = mockRes();
    try { await h({ method: 'GET', query, headers: {}, url: label }, res); } finally { console.warn = warn; console.log = log; console.error = err; }
    out.push({ label, code: res.code, ms: Date.now() - t0, ...acc, cache: res.headers['cache-control'] || '' });
    acc = null;
  }
  for (const r of out) {
    const s = /s-maxage=(\d+)/.exec(r.cache);
    console.log(`  ${r.label.padEnd(26)} ${String(r.code).padEnd(4)} 질의 ${String(r.q).padStart(3)} · 행 ${String(r.rows).padStart(6)} · ${KB(r.bytes).padStart(9)} · ${String(r.ms).padStart(5)}ms · CDN ${s ? s[1] + 's' : '없음'}`);
  }
  _internal.setTrace(null);
  await client.close();
}

(async () => {
  const url = assertIsolatedBranch();
  await partA(url);
  await partB();
})().catch(e => { console.error('MEASURE_FAILED ' + (e && e.stack || e)); process.exitCode = 1; });
