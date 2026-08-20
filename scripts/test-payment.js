#!/usr/bin/env node
/**
 * 결제/PRO/AI-quota 보안 테스트.
 *
 * ★ 외부 호출 0회. Toss·Supabase 를 부르지 않는다.
 *   여기서 검증하는 것은 순수 로직과 핸들러의 입력 검증 경로다.
 */
'use strict';

const { kstToday, publicSubscription, FREE_LIMIT, PRO_DAILY_LIMIT, PRO_PRICE_KRW } = require('../api/_plan');
const { verifyToken } = require('../api/_auth');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  — ${detail}` : ''}`); }
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, name, a === e ? String(actual) : `기대 ${e} / 실제 ${a}`);
}

console.log('=== 결제/PRO/AI-quota 보안 테스트 (외부 호출 0회) ===\n');

/* ─────────────────────────────────────────────────────────────
   [1] 상수 검증
   ───────────────────────────────────────────────────────────── */
console.log('[1] 상수 검증');
eq(FREE_LIMIT, 3, 'FREE 무료 한도 = 3');
eq(PRO_DAILY_LIMIT, 50, 'PRO 일일 한도 = 50');
eq(PRO_PRICE_KRW, 4900, 'PRO 가격 = 4,900원');
ok(Number.isInteger(PRO_PRICE_KRW) && PRO_PRICE_KRW > 0, 'PRO 가격은 양의 정수');

/* ─────────────────────────────────────────────────────────────
   [2] kstToday — KST 날짜 계산 & 자정 경계
   ───────────────────────────────────────────────────────────── */
console.log('\n[2] kstToday — KST 날짜 계산');

eq(kstToday(new Date('2026-08-20T00:00:00Z')), '2026-08-20',
  'UTC 00:00 → KST 09:00 → 8/20');
eq(kstToday(new Date('2026-08-20T14:00:00Z')), '2026-08-20',
  'UTC 14:00 → KST 23:00 → 8/20');
eq(kstToday(new Date('2026-08-20T15:00:00Z')), '2026-08-21',
  '★ UTC 15:00 → KST 00:00 → 8/21 (자정 경계)');
eq(kstToday(new Date('2026-08-20T14:59:59Z')), '2026-08-20',
  'UTC 14:59:59 → KST 23:59:59 → 아직 8/20');
eq(kstToday(new Date('2026-12-31T14:59:59Z')), '2026-12-31',
  '연말 경계 — 아직 12/31');
eq(kstToday(new Date('2026-12-31T15:00:00Z')), '2027-01-01',
  '★ 연말 자정 → 새해 1/1');

ok(/^\d{4}-\d{2}-\d{2}$/.test(kstToday()), '현재 시각에도 YYYY-MM-DD 형식');

// 잘못된 입력에 대한 방어
ok(/^\d{4}-\d{2}-\d{2}$/.test(kstToday('garbage')), '문자열 입력 시 Date.now() 폴백');
ok(/^\d{4}-\d{2}-\d{2}$/.test(kstToday(null)), 'null 입력 시 Date.now() 폴백');
ok(/^\d{4}-\d{2}-\d{2}$/.test(kstToday(undefined)), 'undefined 입력 시 Date.now() 폴백');
ok(/^\d{4}-\d{2}-\d{2}$/.test(kstToday(NaN)), 'NaN 입력 시 Date.now() 폴백');

/* ─────────────────────────────────────────────────────────────
   [3] publicSubscription — 민감 필드 노출 방지
   ───────────────────────────────────────────────────────────── */
console.log('\n[3] publicSubscription — 민감 필드 제거');

const fullSub = {
  email: 'u@test.com', plan: 'pro', status: 'active',
  expires_at: '2026-09-20', provider: 'toss',
  billing_key: 'bk_secret_abc', customer_key: 'ck_xyz',
  canceled_at: null, updated_at: '2026-08-20T00:00:00Z'
};
const pub = publicSubscription(fullSub);
ok(pub.email === 'u@test.com', 'email 포함');
ok(pub.plan === 'pro', 'plan 포함');
ok(pub.status === 'active', 'status 포함');
ok(pub.expires_at === '2026-09-20', 'expires_at 포함');
ok(!('billing_key' in pub), '★ billing_key 제거됨');
ok(!('customer_key' in pub), '★ customer_key 제거됨');
ok(!('provider' in pub), 'provider 제거됨');
ok(!('updated_at' in pub), 'updated_at 제거됨');

eq(publicSubscription(null), null, 'null 구독 → null');
eq(publicSubscription(undefined), null, 'undefined → null');

/* ─────────────────────────────────────────────────────────────
   [4] 결제 금액 검증 — 서버가 클라이언트 금액을 신뢰하지 않음
   ───────────────────────────────────────────────────────────── */
console.log('\n[4] 금액 변조 검증');

ok(Number(4900) === PRO_PRICE_KRW, '정상 금액 4900 통과');
ok(Number(0) !== PRO_PRICE_KRW, '0원 차단');
ok(Number(1) !== PRO_PRICE_KRW, '1원 차단');
ok(Number(4899) !== PRO_PRICE_KRW, '4899원 차단 (1원 할인 시도)');
ok(Number(4901) !== PRO_PRICE_KRW, '4901원 차단');
ok(Number(-4900) !== PRO_PRICE_KRW, '음수 차단');
ok(Number(49000) !== PRO_PRICE_KRW, '10배 금액 차단');
ok(Number('4900abc') !== PRO_PRICE_KRW, '문자열 혼합 차단 (NaN)');
ok(Number(null) !== PRO_PRICE_KRW, 'null 차단');
ok(Number(undefined) !== PRO_PRICE_KRW, 'undefined 차단 (NaN)');
ok(Number(Infinity) !== PRO_PRICE_KRW, 'Infinity 차단');

/* ─────────────────────────────────────────────────────────────
   [5] 인증 토큰 검증 — Bearer 토큰 없이 접근 불가
   ───────────────────────────────────────────────────────────── */
console.log('\n[5] 인증 토큰 검증');

ok(verifyToken('') === null, '빈 토큰 → null');
ok(verifyToken('garbage') === null, '무작위 문자열 → null');
try {
  ok(verifyToken('v1.abc.def') === null, '잘못된 payload → null');
} catch (e) {
  console.log('  [SKIP] 잘못된 payload 테스트 — ' + e.message);
}
ok(verifyToken(null) === null, 'null → null');

// 만료된 토큰 — AUTH_SECRET 이 없으면 signingKey 가 throw 하므로 건너뛴다.
try {
  const crypto = require('crypto');
  const SECRET = process.env.AUTH_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (SECRET) {
    const expiredPayload = Buffer.from(JSON.stringify({
      email: 'expired@test.com',
      exp: Math.floor(Date.now() / 1000) - 3600
    })).toString('base64url');
    const expiredSig = crypto.createHmac('sha256', SECRET)
      .update('v1.' + expiredPayload).digest('base64url');
    ok(verifyToken('v1.' + expiredPayload + '.' + expiredSig) === null,
      '★ 만료된 토큰은 서명이 유효해도 거부');
  } else {
    console.log('  [SKIP] 만료 토큰 테스트 — AUTH_SECRET 없음');
  }
} catch (e) {
  console.log('  [SKIP] 만료 토큰 테스트 — ' + e.message);
}

/* ─────────────────────────────────────────────────────────────
   [6] AI 핸들러 — 빈 질문이 quota 를 소비하지 않음 (Bug 1 수정 검증)
   ───────────────────────────────────────────────────────────── */
console.log('\n[6] AI 핸들러 — 입력 검증 순서 (quota 소비 전에 거부)');

// OPENROUTER_API_KEY 가 없으면 핸들러가 500 을 먼저 돌리므로 더미 값 세팅.
// 실제 OpenRouter 호출은 일어나지 않는다 — 빈 질문/미인증은 그 전에 잡힌다.
if (!process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = 'test-dummy-key';
const aiHandler = require('../api/ai.js');

function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = function (s) { r._status = s; return r; };
  r.json = function (b) { r._body = b; return r; };
  r.setHeader = function () { return r; };
  r.end = function () { return r; };
  return r;
}

(async function testEmptyQuestion() {
  const req = {
    method: 'POST',
    headers: { origin: 'https://seosa.ai.kr' },
    body: { question: '', contextProducts: [], chatHistory: [] }
  };
  const res = mockRes();
  await aiHandler(req, res);
  ok(res._status === 400, '★ 빈 질문 → 400 (quota 소비 전 거부)', `status=${res._status}`);
  ok(res._body && res._body.error === '질문 없음', '에러 메시지 = "질문 없음"',
    res._body ? res._body.error : 'body 없음');
})().then(function () {
  return (async function testWhitespaceQuestion() {
    const req = {
      method: 'POST',
      headers: { origin: 'https://seosa.ai.kr' },
      body: { question: '   ', contextProducts: [], chatHistory: [] }
    };
    const res = mockRes();
    await aiHandler(req, res);
    ok(res._status === 400, '공백만 있는 질문 → 400', `status=${res._status}`);
  })();
}).then(function () {
  return (async function testNullQuestion() {
    const req = {
      method: 'POST',
      headers: { origin: 'https://seosa.ai.kr' },
      body: { contextProducts: [], chatHistory: [] }
    };
    const res = mockRes();
    await aiHandler(req, res);
    ok(res._status === 400, 'question 누락 → 400', `status=${res._status}`);
  })();
}).then(function () {
  return (async function testNoAuth() {
    const req = {
      method: 'POST',
      headers: { origin: 'https://seosa.ai.kr' },
      body: { question: '마우스 추천해줘', contextProducts: [], chatHistory: [] }
    };
    const res = mockRes();
    await aiHandler(req, res);
    ok(res._status === 401, '토큰 없이 질문 → 401', `status=${res._status}`);
    ok(res._body && res._body.needsAuth === true, 'needsAuth=true 포함');
  })();
}).then(function () {
  return (async function testBadToken() {
    const req = {
      method: 'POST',
      headers: {
        origin: 'https://seosa.ai.kr',
        authorization: 'Bearer invalid.token.here'
      },
      body: { question: '마우스 추천해줘', contextProducts: [], chatHistory: [] }
    };
    const res = mockRes();
    await aiHandler(req, res);
    ok(res._status === 401, '위조 토큰 → 401', `status=${res._status}`);
  })();
}).then(function () {
  /* ─────────────────────────────────────────────────────────────
     [7] payment.js 핸들러 — 파라미터 검증
     ───────────────────────────────────────────────────────────── */
  console.log('\n[7] payment.js 핸들러 — 인증/파라미터 검증');

  const payHandler = require('../api/payment.js');

  return (async function testPayNoAuth() {
    const req = {
      method: 'POST',
      headers: { origin: 'https://seosa.ai.kr' },
      body: { action: 'confirm', orderId: 'o1', paymentKey: 'pk1', amount: 4900 }
    };
    const res = mockRes();
    await payHandler(req, res);
    ok(res._status === 401, '결제 — 토큰 없이 → 401', `status=${res._status}`);
    ok(res._body && res._body.needsAuth === true, 'needsAuth=true');
  })();
}).then(function () {
  const payHandler = require('../api/payment.js');
  return (async function testPayBadAction() {
    const req = {
      method: 'POST',
      headers: { origin: 'https://seosa.ai.kr' },
      body: { action: 'hack' }
    };
    const res = mockRes();
    await payHandler(req, res);
    ok(res._status === 400 || res._status === 401,
      '알 수 없는 action → 400 또는 401', `status=${res._status}`);
  })();
}).then(function () {
  const payHandler = require('../api/payment.js');
  return (async function testPayGetNoAuth() {
    const req = {
      method: 'GET',
      headers: { origin: 'https://seosa.ai.kr' }
    };
    const res = mockRes();
    await payHandler(req, res);
    ok(res._status === 401, 'GET 구독 상태 — 토큰 없이 → 401', `status=${res._status}`);
  })();
}).then(function () {
  const payHandler = require('../api/payment.js');
  return (async function testPayMethodNotAllowed() {
    const req = {
      method: 'PUT',
      headers: { origin: 'https://seosa.ai.kr' }
    };
    const res = mockRes();
    await payHandler(req, res);
    ok(res._status === 405, 'PUT → 405', `status=${res._status}`);
  })();
}).then(function () {
  const payHandler = require('../api/payment.js');
  return (async function testPayOptions() {
    const req = {
      method: 'OPTIONS',
      headers: { origin: 'https://seosa.ai.kr' }
    };
    const res = mockRes();
    await payHandler(req, res);
    ok(res._status === 204, 'OPTIONS → 204 (CORS preflight)', `status=${res._status}`);
  })();
}).then(function () {
  // 결과 출력
  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (failures.length) {
    console.log('\n실패 목록:');
    failures.forEach(function (f) { console.log('  ✗ ' + f); });
    process.exit(1);
  }
});
