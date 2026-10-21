#!/usr/bin/env node
/*
 * 상품 검색 · AI 추천의 DB 경로 실측 — Neon 테스트 브랜치, 한 트랜잭션 안에서 하고 되돌린다.
 *
 *   (with-neon 래퍼가 NEON_DATABASE_URL 을 프로세스 환경으로만 넣는다)
 *   node scripts/migration/test-neon-search-ai-sandbox.js
 *
 * 검색   /api/search 핸들러를 그대로 부른다. 공급자 키는 가짜, 바깥 네트워크는 막는다 →
 *        «쿠팡 캐시 적중» 경로만 탄다(트랜잭션 안에서 캐시를 방금 받은 것으로 만든다).
 *        ADPICK 은 캐시가 없으면 호출을 시도했다가 막혀 실패한다 — 한쪽 공급원 장애 때의
 *        부분 결과 동작까지 같이 본다.
 * AI     _aicontext.loadCatalogRows · matchCatalog(옵션 일치) · _pricestat.loadStats/assess(가격 판단)
 *        · _trust.attachTrust 를 Neon 데이터로 부른다. LLM 은 부르지 않는다.
 *
 * ★ 공급자 API · LLM 호출 0회(막힌 fetch 시도는 세어서 보여 준다). 쓰기는 전부 ROLLBACK.
 */
'use strict';

const assert = require('node:assert/strict');
const { openSandbox, blockNetwork } = require('./_neon-sandbox');

function mockRes() {
  return {
    code: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    end() { return this; }
  };
}

async function main() {
  const box = await openSandbox();
  const { sandbox, test } = box;
  const net = blockNetwork();
  process.env.COUPANG_ACCESS_KEY = 'sandbox-not-a-key';
  process.env.COUPANG_SECRET_KEY = 'sandbox-not-a-key';
  process.env.ADPICK_API_KEY = 'sandbox-not-a-key';
  const warn = console.warn; const log = console.log;
  let searchItems = [];
  try {
    console.log('[상품 검색 — /api/search, 쿠팡 캐시 적중 경로]');
    let keyword = null;
    await test('★ 검색 캐시 적중 → 200 · 상품 카드 · 쿠팡 API 호출 0회', async () => {
      // 사람이 칠 법한 검색어의 캐시를 고른다(상품명 통째 검색어는 관련도 필터에서 다 빠질 수 있다).
      const c = await sandbox.from('coupang_search_cache').select('keyword, req_limit, fetched_at')
        .or('keyword.like.*모니터*,keyword.like.*에어팟*,keyword.like.*키보드*').order('fetched_at', { ascending: false }).limit(50);
      assert.equal(c.error, null, c.error && c.error.message);
      const pick = c.data.find(r => r.keyword.length <= 12 && r.req_limit >= 6) || c.data[0];
      keyword = pick.keyword;
      const u = await sandbox.from('coupang_search_cache').update({ fetched_at: new Date().toISOString() }).eq('keyword', keyword);
      assert.equal(u.error, null, u.error && u.error.message);
      const handler = require('../../api/search');
      const res = mockRes();
      console.warn = () => {}; console.log = () => {};
      await handler({ method: 'GET', query: { keyword }, headers: {}, url: '/api/search' }, res);
      console.warn = warn; console.log = log;
      assert.equal(res.code, 200, JSON.stringify(res.body).slice(0, 200));
      // /api/search 는 상품 카드 «배열» 을 그대로 돌려준다(프론트 계약).
      searchItems = Array.isArray(res.body) ? res.body : [];
      assert.ok(Array.isArray(searchItems) && searchItems.length > 0, '검색 결과 0개');
      assert.ok(searchItems.every(it => it.productId && Number(it.lprice) > 0 && it.link), '상품 ID·가격(lprice)·구매 링크가 있다');
      assert.equal(net.attempts.filter(u => /coupang/i.test(u)).length, 0, '쿠팡 API 를 부르지 않았다');
      console.log(`       검색어 «${keyword}» → ${searchItems.length}개 · 막힌 외부 호출 ${net.attempts.length}회 (${[...new Set(net.attempts.map(u => new URL(u).host))].join(', ') || '없음'})`);
    });

    console.log('\n[AI 추천의 DB 경로]');
    const PID = '7912306911';
    let rows = [];
    await test('loadCatalogRows → 요청한 상품만 · 옵션 열이 있다', async () => {
      const AC = require('../../api/_aicontext');
      const ids = [PID, ...searchItems.slice(0, 4).map(it => String(it.productId))];
      rows = await AC.loadCatalogRows(ids);
      assert.ok(rows.length > 0);
      assert.ok(rows.every(r => ids.includes(String(r.product_id))));
    });
    await test('★ matchCatalog: 맞는 옵션 → verified/stale · 다른 옵션 → option-mismatch · 없는 상품 → not-found', async () => {
      const AC = require('../../api/_aicontext');
      const row = rows.find(r => String(r.product_id) === PID) || rows[0];
      const ok = AC.matchCatalog({ productId: String(row.product_id), mall: row.mall, vendorItemId: String(row.vendor_item_id || '') }, rows);
      assert.ok(['verified', 'stale'].includes(ok.status), ok.status);
      if (row.mall === '쿠팡') {
        const bad = AC.matchCatalog({ productId: String(row.product_id), mall: row.mall, vendorItemId: '0000000000' }, rows);
        assert.equal(bad.status, 'option-mismatch');
      }
      assert.equal(AC.matchCatalog({ productId: '__nope__', mall: '쿠팡', vendorItemId: '1' }, rows).status, 'not-found');
    });
    await test('★ 가격 판단: loadStats(strictOption) → 통계 · assess → 판정', async () => {
      const P = require('../../api/_pricestat');
      const prod = await sandbox.from('products').select('product_id, mall, vendor_item_id, lprice').eq('product_id', PID).limit(1);
      const p = prod.data[0];
      const key = { productId: PID, mall: p.mall, vendorItemId: String(p.vendor_item_id || '') };
      const stats = await P.loadStats([key], { strictOption: true });
      const st = stats.get(`${PID}|${p.mall}|${key.vendorItemId}`) || stats.get(`${PID}|${p.mall}`);
      assert.ok(st, '통계가 있다');
      assert.ok(st.count >= 10 && st.low > 0 && st.high >= st.low, JSON.stringify(st).slice(0, 160));
      const verdict = P.assess(st, p.lprice || st.low, require('../../api/_kst').kstToday ? require('../../api/_kst').kstToday() : undefined);
      assert.ok(verdict === null || typeof verdict === 'object');
      console.log(`       ${PID}: 관측 ${st.count}일 · 최저 ${st.low} · 최고 ${st.high}${verdict ? ' · 판정 ' + (verdict.label || verdict.verdict || Object.keys(verdict).slice(0, 3).join('/')) : ''}`);
    });
    await test('attachTrust → 신뢰 신호가 붙는다', async () => {
      const T = require('../../api/_trust');
      const items = searchItems.slice(0, 5).map(it => ({ ...it }));
      if (!items.length) items.push({ productId: PID, mall: '쿠팡', lprice: 10000 });
      console.warn = () => {};
      await T.attachTrust(items, {});
      console.warn = warn;
      assert.ok(items.some(it => it.trust || it.trustScore != null || it.signals), JSON.stringify(Object.keys(items[0])));
    });
  } finally {
    console.warn = warn; console.log = log;
    net.restore();
    await box.finish();
  }
  console.log('\n====================================================');
  console.log(`결과: ${box.counts.passed} PASS / ${box.counts.failed} FAIL`);
  console.log(`NEON_SEARCH_AI_SANDBOX ${box.counts.failed ? 'FAIL' : 'PASS'}`);
  if (box.counts.failed) process.exitCode = 1;
}

main().catch(e => { console.error('NEON_SEARCH_AI_SANDBOX_FAILED ' + (e && e.stack || e)); process.exitCode = 1; });
