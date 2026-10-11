#!/usr/bin/env node
/*
 * 만 14세 미만 로그인 제한 — POST /api/auth 1단계(인증 코드 발급)의 ageConfirmed 관문.
 *
 *   node scripts/test-auth-age.js
 *
 * SEOSA 는 법정대리인 동의 절차를 두지 않으므로, 만 14세 이상임을 확인하지 않은
 * 요청에는 인증 코드를 만들지도(auth_codes 에 이메일이 남지 않는다) 메일을 보내지도
 * 않는다. 이메일을 받는 다른 기능(가격 알림·동기화·프로필·결제·계정 삭제)은 전부
 * 여기서 발급한 토큰을 요구하므로 이 한 곳이 계정·개인정보 처리의 입구다.
 *
 * 외부 호출 0회: createCode/consumeCode 와 메일 발송(_notify.send)을 가짜로 바꾼다.
 */
'use strict';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-only-secret';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test';
process.env.RESEND_API_KEY = 'test-resend-key';

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined && detail !== '' ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

global.fetch = () => { throw new Error('unexpected network request'); };

/* auth.js 는 _auth 의 함수를 로드 시점에 꺼내 쓴다 — 그 전에 바꿔 둔다. */
const authLib = require('../api/_auth');
const notify = require('../api/_notify');
const calls = { createCode: [], consumeCode: [], send: [] };
authLib.createCode = async email => { calls.createCode.push(email); return { ok: true, code: '123456' }; };
authLib.consumeCode = async (email, code) => { calls.consumeCode.push([email, code]); return code === '123456' ? { ok: true } : { ok: false, error: '코드가 올바르지 않아요' }; };
notify.send = async (channel, payload) => { calls.send.push({ channel, to: payload.to }); return { ok: true }; };
const handler = require('../api/auth');

let ipSeq = 0;
function req({ method = 'POST', body = {}, query = {}, token } = {}) {
  const headers = { 'x-forwarded-for': `10.14.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` };
  if (token) headers.authorization = 'Bearer ' + token;
  return { method, headers, body, query, url: '/api/auth', socket: { remoteAddress: '127.0.0.1' } };
}
function res() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.status = c => { r.statusCode = c; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.json = o => { r.body = o; return r; };
  r.end = () => r;
  return r;
}
const run = async q => { const r = res(); await handler(q, r); return r; };
const reset = () => { calls.createCode.length = 0; calls.consumeCode.length = 0; calls.send.length = 0; };
const EMAIL = 'kid-or-adult@example.com';

(async () => {
  console.log('\nPOST /api/auth — 만 14세 이상 확인 (ageConfirmed)\n');

  // 1. 확인이 없으면 아무것도 저장·발송하지 않는다
  for (const [label, body] of [
    ['ageConfirmed 없음', { email: EMAIL }],
    ['ageConfirmed: false', { email: EMAIL, ageConfirmed: false }],
    ['ageConfirmed: "true" (문자열)', { email: EMAIL, ageConfirmed: 'true' }],
    ['ageConfirmed: 1', { email: EMAIL, ageConfirmed: 1 }]
  ]) {
    reset();
    const r = await run(req({ body }));
    check(r.statusCode === 400 && r.body && r.body.needsAgeConfirm === true, `${label} → 400 needsAgeConfirm`, r.statusCode);
    check(calls.createCode.length === 0, `${label} → 인증 코드를 만들지 않는다 (auth_codes 에 이메일이 남지 않음)`, calls.createCode.length);
    check(calls.send.length === 0, `${label} → 메일을 보내지 않는다`, calls.send.length);
  }
  {
    const r = await run(req({ body: { email: EMAIL } }));
    check(/만 14세 이상/.test(String(r.body && r.body.error)), '거절 문구가 이유를 말한다', r.body && r.body.error);
  }

  // 2. 확인하면 기존 흐름 그대로
  {
    reset();
    const r = await run(req({ body: { email: EMAIL, ageConfirmed: true } }));
    check(r.statusCode === 200 && r.body && r.body.sent === true, 'ageConfirmed: true → 코드 메일 발송 (sent)', r.statusCode);
    check(calls.createCode.length === 1 && calls.createCode[0] === EMAIL, '코드 1회 생성', calls.createCode.length);
    check(calls.send.length === 1 && calls.send[0].to === EMAIL && calls.send[0].channel === 'email', '메일 1통', calls.send.length);
    check(!JSON.stringify(r.body).includes('123456'), '응답에 코드가 실리지 않는다');
  }

  // 3. 이메일 형식 오류는 예전과 같은 응답
  {
    reset();
    const r = await run(req({ body: { email: 'not-an-email', ageConfirmed: true } }));
    check(r.statusCode === 400 && !r.body.needsAgeConfirm && /이메일/.test(r.body.error), '잘못된 이메일 → 기존 400 (나이 문구 아님)', r.body && r.body.error);
  }

  // 4. 2단계(코드 확인)는 1단계 코드가 있어야만 통과하므로 다시 묻지 않는다
  {
    reset();
    const ok = await run(req({ body: { email: EMAIL, code: '123456' } }));
    check(ok.statusCode === 200 && typeof ok.body.token === 'string' && ok.body.token.length > 0, '코드 확인 → 토큰 발급 (기존 동작 유지)', ok.statusCode);
    check(calls.createCode.length === 0 && calls.send.length === 0, '코드 확인은 새 코드·메일을 만들지 않는다');
    const bad = await run(req({ body: { email: EMAIL, code: '000000' } }));
    check(bad.statusCode === 400 && !bad.body.token, '틀린 코드 → 400, 토큰 없음', bad.statusCode);
  }

  // 5. 같은 함수의 다른 경로는 영향을 받지 않는다
  {
    const del = await run(req({ body: { confirm: 'delete-account' }, query: { action: 'delete-account' } }));
    check(del.statusCode === 401 && del.body.needsAuth === true && !del.body.needsAgeConfirm, '계정 삭제 경로: 나이 관문이 아니라 토큰으로 판단 (무토큰 401)', del.statusCode);
    const get = await run(req({ method: 'GET' }));
    check(get.statusCode === 405, 'GET → 405', get.statusCode);
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
