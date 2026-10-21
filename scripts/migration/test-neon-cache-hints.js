#!/usr/bin/env node
/*
 * search_cache_hints(DB 계산) == 예전 전체 스캔 — 결과와 «순서» 까지 같은지 실데이터로 본다.
 *
 *   (with-neon 래퍼가 NEON_DATABASE_URL 을 프로세스 환경으로만 넣는다)
 *   node scripts/migration/test-neon-cache-hints.js
 *
 * 한 트랜잭션 안에서 supabase/2026-10-21-search-cache-hints.sql 을 실행하고(Postgres 는 DDL 도
 * 되돌릴 수 있다), 수집기의 실제 cacheHintQueries 를 두 방식으로 부른 뒤 ROLLBACK 한다.
 *   예전  PRICE_CACHE_HINT_RPC=0 → 검색 캐시 (keyword, items) 전체 키셋 스캔
 *   새것  search_cache_hints RPC → 찾는 상품의 (ID, 검색어들) 만
 * 찾는 상품 = 그 몰의 products 전체 ID(가장 큰 입력) + 그 부분집합 둘.
 *
 * ★ 예전 방식이 실제로 검색 캐시를 다 내려받으므로 이 테스트 한 번에 약 50MB 가 전송된다.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openSandbox } = require('./_neon-sandbox');

async function main() {
  const box = await openSandbox();
  const { sandbox, conn, test } = box;
  try {
    await conn.query(fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', '2026-10-21-search-cache-hints.sql'), 'utf8'));
    const log = console.log; const warn = console.warn;
    console.log = () => {}; // 수집기 모듈의 환경변수 진단 줄
    const Collector = require('../../scripts/collect-all-prices');
    console.log = log;

    for (const mall of ['쿠팡', 'ADPICK']) {
      console.log(`\n[${mall}]`);
      // 찾는 상품: 그 몰의 products 전체 ID
      const ids = [];
      await Collector.keysetScan({ build: () => sandbox.from('products'), filter: q => q.eq('mall', mall), columns: 'id, product_id', cursor: 'id', label: 'ids', onPage: rows => rows.forEach(r => ids.push(String(r.product_id))) });
      const want = new Set(ids);

      const measure = async fn => { const t0 = Date.now(); const out = await fn(); return { out, ms: Date.now() - t0 }; };
      console.warn = () => {};
      process.env.PRICE_CACHE_HINT_RPC = '0';
      const legacy = await measure(() => Collector.cacheHintQueries(want, mall));
      delete process.env.PRICE_CACHE_HINT_RPC;
      const viaRpc = await measure(() => Collector.cacheHintQueries(want, mall));
      console.warn = warn;

      const L = [...legacy.out.entries()];
      const R = [...viaRpc.out.entries()];
      await test(`★ 전체 입력(${want.size}개) — 같은 상품 · 같은 검색어 · 같은 순서 (${L.length}개 상품)`, async () => {
        assert.ok(L.length > 0, '예전 방식 결과가 비었다 — 비교가 무의미하다');
        assert.deepEqual(R, L);
      });
      for (const [label, every] of [['1/7 부분집합', 7], ['1/31 부분집합', 31]]) {
        const sub = new Set(ids.filter((_, i) => i % every === 0));
        const expected = L.filter(([pid]) => sub.has(pid));
        const got = [...(await Collector.cacheHintsFromDb(sub, mall)).entries()];
        await test(`${label}(${sub.size}개) — 전체 결과를 거른 것과 같다 (${expected.length}개)`, async () => {
          assert.deepEqual(got, expected);
        });
      }
      // 응답 크기 비교: 예전은 (keyword, items) 전체, 새것은 결과 JSON 한 덩이
      const rpcText = await conn.query('select octet_length(public.search_cache_hints($1, $2)::text)::bigint b', [mall, [...want]]);
      const legacyText = await conn.query(`select coalesce(sum(octet_length(keyword) + octet_length(items::text)),0)::bigint b from ${mall === 'ADPICK' ? 'adpick_search_cache' : 'coupang_search_cache'}`);
      console.log(`       전송: 예전 ${(Number(legacyText.rows[0].b) / 1048576).toFixed(1)}MB → 새것 ${(Number(rpcText.rows[0].b) / 1024).toFixed(1)}KB · 시간 예전 ${legacy.ms}ms / 새것 ${viaRpc.ms}ms`);
    }
  } finally {
    await box.finish();
  }
  // 되돌렸는지
  const pg = require('pg');
  const c = new pg.Client({ connectionString: box.url, ssl: { rejectUnauthorized: true } });
  await c.connect();
  const left = await c.query(`select count(*)::int n from pg_proc where proname = 'search_cache_hints'`);
  await c.end();
  console.log(`\n  ROLLBACK 뒤 search_cache_hints 함수: ${left.rows[0].n}개 (0 이어야 한다 — 운영 적용은 사용자 승인 후)`);
  if (left.rows[0].n !== 0) box.counts.failed++;
  console.log('\n====================================================');
  console.log(`결과: ${box.counts.passed} PASS / ${box.counts.failed} FAIL`);
  console.log(`NEON_CACHE_HINTS ${box.counts.failed ? 'FAIL' : 'PASS'}`);
  if (box.counts.failed) process.exitCode = 1;
}

main().catch(e => { console.error('NEON_CACHE_HINTS_FAILED ' + (e && e.stack || e)); process.exitCode = 1; });
