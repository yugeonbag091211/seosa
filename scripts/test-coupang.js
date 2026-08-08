#!/usr/bin/env node
/*
 * api/_coupang.js 회귀 테스트 — 실제 쿠팡 호출 0회.
 *
 * 가짜 쿠팡 서버를 로컬에 띄우고 COUPANG_API_HOST 로 물려서,
 * "정상 / HTML 차단 / rCode 400 / HTTP 429" 응답에 각각 어떻게 반응하는지 본다.
 *
 * 전역 차단 상태(Supabase)는 COUPANG_DISABLE_GLOBAL_GATE=1 로 끈다.
 * 이걸 안 끄면 로컬 테스트가 운영 사이트의 검색을 멈춰버린다.
 *
 *   node scripts/test-coupang.js
 */
'use strict';

const http = require('http');

// ── 반드시 _coupang.js 를 require 하기 전에 잡아야 한다 (모듈 로드 시 읽는다) ──
process.env.COUPANG_DISABLE_GLOBAL_GATE = '1';
process.env.COUPANG_ACCESS_KEY = 'test-access-key';
process.env.COUPANG_SECRET_KEY = 'test-secret-key';
process.env.COUPANG_MIN_GAP_MS = '1';        // 테스트를 빠르게
process.env.COUPANG_FETCH_LIMIT = '50';

const DENIED_HTML =
  '<html><head><title>Access denied</title></head>'
  + '<body><div class="error-page"><p>Sorry! Access denied</p></div></body></html>';

let mode = 'ok';   // 서버 응답 모드. 테스트마다 바꾼다.

const server = http.createServer((req, res) => {
  if (mode === 'denied') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(DENIED_HTML);
  }
  if (mode === 'rcode400') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ rCode: '400', rMessage: 'invalid parameter' }));
  }
  if (mode === 'http429') {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    return res.end('Too Many Requests');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    rCode: '0',
    data: {
      productData: [
        { productId: 111, productName: '테스트 무선 이어폰', productPrice: 39000,
          productUrl: 'https://link.coupang.com/a', productImage: 'https://img/a.jpg' },
        { productId: 222, productName: '테스트 이어폰 케이스', productPrice: 9000,
          productUrl: 'https://link.coupang.com/b', productImage: 'https://img/b.jpg' }
      ]
    }
  }));
});

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

server.listen(0, async () => {
  process.env.COUPANG_API_HOST = 'http://127.0.0.1:' + server.address().port;

  // 캐시(Supabase)를 안 타도록 useCache:false 로만 부른다.
  const { searchCoupang, isBlocked } = require('../api/_coupang');
  const common = { source: 'test', useCache: false, maxWaitMs: 5000 };

  console.log('\napi/_coupang.js 응답 처리 테스트 (실제 쿠팡 호출 0회)\n');

  // 1) 정상 응답
  mode = 'ok';
  let r = await searchCoupang('무선 이어폰', { ...common, limit: 2 });
  check(r.from === 'api', '정상 응답 → from=api', 'from=' + r.from);
  check(r.items.length === 2, '상품 2건 파싱', r.items.length + '건');
  check(r.items[0].productId === '111' && r.items[0].lprice === 39000,
        'productId / 가격 정규화', JSON.stringify(r.items[0]).slice(0, 60));
  check(!isBlocked(), '정상 응답은 차단을 걸지 않는다');

  // 2) rCode=400 — 파라미터 오류. 서킷 브레이커가 열리면 안 된다.
  mode = 'rcode400';
  r = await searchCoupang('무선 이어폰', { ...common, limit: 2 });
  check(r.items.length === 0, 'rCode=400 → 빈 결과');
  check(r.blocked === false, 'rCode=400 은 blocked=false');
  check(!isBlocked(), 'rCode=400 은 서킷 브레이커를 열지 않는다');

  // 3) HTTP 200 + 차단 HTML — 이번 감사에서 실제로 받은 응답
  mode = 'denied';
  r = await searchCoupang('무선 이어폰', { ...common, limit: 2 });
  check(r.blocked === true, 'HTML 차단 응답 → blocked=true', 'error=' + String(r.error).slice(0, 45));
  check(isBlocked(), 'HTML 차단 응답 → 서킷 브레이커 열림');
  check(/차단/.test(String(r.error)), '오류 메시지에 차단 사유 포함');

  // 4) 차단된 뒤에는 네트워크를 타지 않아야 한다
  let hits = 0;
  const origMode = mode;
  mode = 'ok';
  const before = hits;
  r = await searchCoupang('다른 검색어', { ...common, limit: 2 });
  check(r.from === 'none' && r.blocked === true,
        '차단 중에는 호출하지 않고 즉시 폴백', 'from=' + r.from);
  mode = origMode;
  void before;

  server.close();
  console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
});
