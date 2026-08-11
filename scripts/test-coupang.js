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

/*
 * 실제로 받았던 응답 모양 — 같은 productId 가 옵션마다 한 행씩 온다.
 * 2026-08-08 "암막커튼" 응답에 8729454920 이 109,000 / 75,000 / 39,900
 * 세 번 들어 있었고, 이걸 접지 않아서 75,000 이 현재가로 저장됐다.
 */
const OPTION_ROWS = [
  { productId: 8729454920, productName: '1+1 암막커튼 아일렛형', productPrice: 109000,
    productUrl: 'https://link.coupang.com/re/A?itemId=1&vendorItemId=11', productImage: 'https://img/a.jpg' },
  { productId: 8729454920, productName: '1+1 암막커튼 아일렛형', productPrice: 75000,
    productUrl: 'https://link.coupang.com/re/A?itemId=2&vendorItemId=22', productImage: 'https://img/a.jpg' },
  { productId: 9673633371, productName: '무타공 암막 커튼', productPrice: 20900,
    productUrl: 'https://link.coupang.com/re/B?itemId=3&vendorItemId=33', productImage: 'https://img/b.jpg' },
  { productId: 9673633371, productName: '무타공 암막 커튼', productPrice: 16900,
    productUrl: 'https://link.coupang.com/re/B?itemId=4&vendorItemId=44', productImage: 'https://img/b.jpg' },
  { productId: 8729454920, productName: '1+1 암막커튼 아일렛형', productPrice: 39900,
    productUrl: 'https://link.coupang.com/re/A?itemId=5&vendorItemId=55', productImage: 'https://img/a.jpg' }
];

/* 가격을 읽을 수 없는 행 — 0원으로 흘려보내지 않고 버려야 한다. */
const BAD_PRICE_ROWS = [
  { productId: 801, productName: '가격 0원', productPrice: 0,
    productUrl: 'https://link.coupang.com/re/C', productImage: '' },
  { productId: 802, productName: '가격 없음', productPrice: null,
    productUrl: 'https://link.coupang.com/re/D', productImage: '' },
  { productId: '', productName: '식별자 없음', productPrice: 5000,
    productUrl: 'https://link.coupang.com/re/E', productImage: '' },
  { productId: 803, productName: '정상', productPrice: 12000,
    productUrl: 'https://link.coupang.com/re/F', productImage: '' }
];

/*
 * discountPrice 는 지금까지 실제 응답에서 관측된 적이 없다(_price.js 상단 주석).
 * 쿠팡이 나중에 넣을 경우를 대비한 계약을 여기서 고정한다.
 */
const DISCOUNT_ROWS = [
  { productId: 901, productName: '할인가 정상', productPrice: 10000, discountPrice: 8000,
    productUrl: 'https://link.coupang.com/re/G', productImage: '' },
  { productId: 902, productName: '할인가가 더 비쌈', productPrice: 10000, discountPrice: 13000,
    productUrl: 'https://link.coupang.com/re/H', productImage: '' }
];

const server = http.createServer((req, res) => {
  if (mode === 'options') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ rCode: '0', data: { productData: OPTION_ROWS } }));
  }
  if (mode === 'badprice') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ rCode: '0', data: { productData: BAD_PRICE_ROWS } }));
  }
  if (mode === 'discount') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ rCode: '0', data: { productData: DISCOUNT_ROWS } }));
  }
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

  // 1-b) 같은 productId 의 옵션 행 접기
  //      ★ "SEOSA 75,000원 / 쿠팡 39,900원" 신고의 정확한 기전이다.
  //         접지 않으면 마지막에 온 옵션이 이기고, limit 으로 자르면
  //         제일 싼 옵션이 응답에서 아예 사라진다.
  mode = 'options';
  r = await searchCoupang('암막커튼', { ...common, limit: 2 });
  const byId = {};
  r.items.forEach(it => { byId[it.productId] = (byId[it.productId] || 0) + 1; });
  check(Object.keys(byId).every(k => byId[k] === 1),
        '같은 productId 는 한 번만 나온다', JSON.stringify(byId));
  const curtain = r.items.find(it => it.productId === '8729454920');
  check(!!curtain && curtain.lprice === 39900,
        '옵션 3개 중 최저가 39,900 이 선택된다', curtain && String(curtain.lprice));
  check(!!curtain && /itemId=5/.test(curtain.link),
        '링크도 그 최저가 옵션의 것이어야 한다 (값과 클릭 대상이 일치)', curtain && curtain.link);
  check(!!curtain && curtain.vendorItemId === '55', 'vendorItemId 추출', curtain && curtain.vendorItemId);

  // limit=2 로 잘라도 싼 옵션이 살아남아야 한다 (접기가 자르기보다 먼저).
  check(r.items.length === 2, 'limit=2 만큼만 반환', String(r.items.length));

  /*
   * 1-c) 접기(collapse)가 자르기(slice)보다 먼저 일어난다 — 순서 고정.
   *
   * OPTION_ROWS 는 8729454920 이 109,000 → 75,000 → (다른 상품) → 39,900 순으로
   * 온다. 39,900 은 원본 응답의 5번째 행이다.
   *   slice 가 먼저면 : limit=1 → 첫 행 109,000 이 남는다
   *   collapse 가 먼저면: limit=1 → 접힌 최저가 39,900 이 남는다
   * 이 단언이 깨지면 _coupang.searchCoupang 의 순서가 뒤바뀐 것이다
   * (normalize→collapseOptions 를 거친 뒤에 items.slice(0, limit) 해야 한다).
   *
   * ★ api/cron.js 의 CRON_LIMIT 판단 근거이기도 하다. 이 순서가 지켜지면
   *   limit 을 6 으로 줄여도 "같은 상품의 더 싼 옵션"이 잘려 나가지는 않는다.
   *   limit 이 버리는 것은 서로 다른 상품이다 (= 커버리지 문제이지 가격 문제가 아님).
   */
  r = await searchCoupang('암막커튼', { ...common, limit: 1 });
  check(r.items.length === 1, 'limit=1 → 1건', String(r.items.length));
  check(r.items[0] && r.items[0].productId === '8729454920' && r.items[0].lprice === 39900,
        'collapse 가 slice 보다 먼저 — limit=1 에서도 최저가 39,900 이 남는다',
        r.items[0] && `${r.items[0].productId}/${r.items[0].lprice}`);

  // 1-d) 가격을 읽을 수 없는 항목은 0원으로 흘려보내지 않고 버린다.
  mode = 'badprice';
  r = await searchCoupang('가격없음', { ...common, limit: 5 });
  check(r.items.length === 1, '가격/식별자를 못 읽은 항목은 제외', r.items.length + '건 남음');
  check(r.items[0] && r.items[0].lprice === 12000, '멀쩡한 항목만 통과', r.items[0] && String(r.items[0].lprice));

  // 1-e) discountPrice 는 productPrice 이하일 때만 판매가로 인정한다.
  mode = 'discount';
  r = await searchCoupang('할인가', { ...common, limit: 5 });
  const lower = r.items.find(it => it.productId === '901');
  const higher = r.items.find(it => it.productId === '902');
  check(!!lower && lower.lprice === 8000 && lower.oprice === 10000,
        'discountPrice < productPrice → 판매가로 채택', lower && `${lower.lprice}/${lower.oprice}`);
  check(!!higher && higher.lprice === 10000 && higher.oprice === 10000,
        'discountPrice > productPrice → 무시하고 productPrice 사용', higher && `${higher.lprice}/${higher.oprice}`);

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
