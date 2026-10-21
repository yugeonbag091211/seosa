#!/usr/bin/env node
/*
 * 쿠팡 «HTTP 200 + rCode 5xx» 처리 회귀 테스트 — 실제 쿠팡 호출 0회.
 *
 *   node scripts/test-coupang-rcode5xx.js
 *
 * 2026-10-21 운영: rCode=500 «Internal Server Error» 한 건이 rCode 차단(60분)으로 잡혀 수집 실행의
 * 쿠팡 레인이 끝까지 멈췄다. 본문 5xx 는 HTTP 5xx 와 같은 일시 장애다 — 쿨다운 5분, blocked=false,
 * 그리고 수집기의 래치 판정(_blockreason)이 «일시» 로 읽어야 한다(쿨다운 중 호출의 사유까지).
 * rCode 4xx(401 등)는 여전히 거절이어야 한다.
 */
'use strict';

const http = require('http');

process.env.COUPANG_DISABLE_GLOBAL_GATE = '1';   // 운영 전역 차단 표를 건드리지 않는다
process.env.COUPANG_ACCESS_KEY = 'test-access-key';
process.env.COUPANG_SECRET_KEY = 'test-secret-key';
process.env.COUPANG_MIN_GAP_MS = '1';

let body = { rCode: '500', rMessage: 'Internal Server Error' };
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}

server.listen(0, async () => {
  process.env.COUPANG_API_HOST = 'http://127.0.0.1:' + server.address().port;
  const { searchCoupang, isBlocked, localStats, COOLDOWN_MIN } = require('../api/_coupang');
  const { isTransientBlockReason } = require('../api/_blockreason');
  const common = { source: 'test', useCache: false, maxWaitMs: 5000 };
  console.log('\n쿠팡 rCode 5xx 처리 (실제 쿠팡 호출 0회)\n');

  let r = await searchCoupang('무선 이어폰', { ...common, limit: 2 });
  check(r.items.length === 0 && r.from === 'none', 'rCode=500 → 빈 결과');
  check(r.blocked === false, 'rCode=500 은 blocked=false (거절이 아니다)', String(r.error));
  check(isTransientBlockReason(r.error), '수집기 래치 판정: 일시 장애', String(r.error));
  check(!/rCode/.test(String(r.error)), '오류 문구에 «rCode» 가 없다 (_blockreason 이 거절로 읽는 낱말)');
  const s = localStats();
  check(isBlocked() && s.blockedForSec > COOLDOWN_MIN.httpOther * 60 - 5 && s.blockedForSec <= COOLDOWN_MIN.httpOther * 60,
    `쿨다운은 HTTP 5xx 와 같은 ${COOLDOWN_MIN.httpOther}분 (rCode 차단 ${COOLDOWN_MIN.rcode}분이 아니다)`, `${s.blockedForSec}s`);

  const before = hits;
  r = await searchCoupang('다른 검색어', { ...common, limit: 2 });
  check(hits === before && r.from === 'none', '쿨다운 중에는 호출하지 않는다');
  check(isTransientBlockReason(r.error), '쿨다운 중 호출의 사유도 일시 장애로 읽힌다', String(r.error));

  // rCode 4xx 거절은 그대로 거절이다 — 이 수정이 거절을 풀어 주면 안 된다.
  check(!isTransientBlockReason('쿠팡 rCode=401: Unauthorized'), 'rCode=401 은 여전히 거절');
  check(!isTransientBlockReason('대기 중 차단됨: rCode=429: too many'), 'rCode=429 쿨다운 사유도 여전히 거절');

  server.close();
  console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
});
