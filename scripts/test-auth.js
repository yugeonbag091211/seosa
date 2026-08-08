#!/usr/bin/env node
/*
 * api/_auth.js 토큰 검증 테스트 — DB / 네트워크 접근 없음.
 *
 *   node scripts/test-auth.js
 */
'use strict';

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-only-secret';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test';

const { issueToken, verifyToken, authorize } = require('../api/_auth');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
const reqWith = token => ({ headers: token ? { authorization: 'Bearer ' + token } : {} });

console.log('\napi/_auth.js 토큰 테스트\n');

const EMAIL = 'user@example.com';
const token = issueToken(EMAIL);

check(!!verifyToken(token), '정상 토큰 검증 통과');
check(verifyToken(token).email === EMAIL, '토큰에서 이메일 복원', verifyToken(token).email);

// 위조 — 서명 부분 변경
const parts = token.split('.');
const forgedSig = [parts[0], parts[1], parts[2].slice(0, -2) + 'AA'].join('.');
check(verifyToken(forgedSig) === null, '서명 위조 거부');

// 위조 — payload 의 이메일만 바꿔치기 (서명은 그대로)
const evil = Buffer.from(JSON.stringify({ e: 'attacker@evil.com', x: Date.now() + 60000 }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
check(verifyToken(`v1.${evil}.${parts[2]}`) === null, 'payload 변조 거부');

// 만료
const expired = issueToken(EMAIL, -1000);
check(verifyToken(expired) === null, '만료 토큰 거부');

// 형식 이상
['', 'abc', 'v1.a', 'v2.' + parts[1] + '.' + parts[2], null, undefined].forEach(t => {
  if (verifyToken(t) !== null) { check(false, '잘못된 형식 거부: ' + String(t)); }
});
check(true, '잘못된 형식 6종 모두 거부');

// authorize — 이메일 대조
check(authorize(reqWith(token), EMAIL).ok, 'authorize: 같은 이메일 통과');
check(!authorize(reqWith(token), 'other@example.com').ok, 'authorize: 다른 이메일 거부');
check(authorize(reqWith(token), 'USER@Example.com').ok, 'authorize: 대소문자 차이는 허용');
check(!authorize(reqWith(null), EMAIL).ok, 'authorize: 토큰 없으면 거부');
check(!authorize({ headers: { authorization: 'Bearer ' } }, EMAIL).ok, 'authorize: 빈 Bearer 거부');

// 다른 서명 키로 만든 토큰은 통과하면 안 된다
delete require.cache[require.resolve('../api/_auth')];
process.env.AUTH_SECRET = 'different-secret';
const other = require('../api/_auth');
check(other.verifyToken(token) === null, '다른 서명 키로 만든 토큰 거부');

console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
