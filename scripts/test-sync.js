#!/usr/bin/env node
/*
 * /api/sync 통합 테스트.
 *
 *   node scripts/test-sync.js
 *
 * profile.js 를 sync.js 에 합치면서 Vercel Hobby 함수 제한(12개)을 맞췄다.
 * 여기서 지키는 것:
 *   ① resource=profile 은 profiles 테이블로 감
 *   ② resource=sync 또는 없음은 user_data 테이블로 감
 *   ③ 두 리소스가 서로의 데이터를 침범하지 않음
 *   ④ 인증되지 않은 요청은 두 경우 모두 401
 *   ⑤ 응답 형태(profile 은 {}, sync 는 {success,data}) 유지
 */
'use strict';

const path = require('path');
const Module = require('module');

const db = { profiles: [], user_data: [] };
function reset() { db.profiles = []; db.user_data = []; }

const fakeSupabase = {
  from(table) {
    const eqs = [];
    const q = {
      select() { return q; },
      eq(c, v) { eqs.push([c, v]); return q; },
      maybeSingle() {
        const rows = (db[table] || []).filter(r => eqs.every(([c, v]) => String(r[c]) === String(v)));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      upsert(row) {
        const i = (db[table] || []).findIndex(r => r.email === row.email);
        if (i > -1) db[table][i] = Object.assign({}, db[table][i], row);
        else db[table].push(Object.assign({}, row));
        return Promise.resolve({ error: null });
      }
    };
    return q;
  }
};
const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

process.env.AUTH_SECRET = 'test-secret-sync';

const sync = require('../api/sync');
const { issueToken } = require('../api/_auth');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function section(n) { console.log(`\n${n}`); }

function mkRes() {
  return {
    code: 200, payload: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.payload = b; return this; }
  };
}

function reqFor(email, method, query, body) {
  return {
    method, headers: email ? { authorization: 'Bearer ' + issueToken(email) } : {},
    url: '/api/sync',
    query: Object.assign({ email }, query || {}),
    body,
    socket: { remoteAddress: '10.0.0.' + Math.floor(Math.random() * 250) }
  };
}

// Node <20 은 readBody 가 IncomingMessage 스트림을 기대할 수 있다. 여기서는
// _http.readBody 가 req.body 를 우선 확인하도록 되어 있다고 가정한다 —
// 이 프로젝트의 다른 테스트도 같은 방식을 쓴다.

const USER = 'me@example.com';
const OTHER = 'other@example.com';

(async () => {

  /* ================================================================ *
   *  1. resourceOf 라우팅
   * ================================================================ */
  section('1. resource 라우팅');
  check(sync.resourceOf({ query: { resource: 'profile' }, url: '/api/sync' }) === 'profile',
        '?resource=profile → profile');
  check(sync.resourceOf({ query: { resource: 'sync' }, url: '/api/sync' }) === 'sync',
        '?resource=sync → sync');
  check(sync.resourceOf({ query: {}, url: '/api/sync' }) === 'sync',
        '기본값 → sync (안전한 쪽)');
  check(sync.resourceOf({ query: {}, url: '/api/profile' }) === 'profile',
        '경로가 /api/profile 이면 rewrite 없이도 profile');
  check(sync.resourceOf({ query: { resource: 'admin' }, url: '/api/sync' }) === 'sync',
        '모르는 값은 sync 로 (오탐 시 안전한 쪽)');

  /* ================================================================ *
   *  2. profile 리소스 — profiles 테이블
   * ================================================================ */
  section('2. resource=profile 은 profiles 테이블로 간다');
  reset();

  // 저장
  let res = mkRes();
  await sync(reqFor(USER, 'POST', { resource: 'profile' },
    { nickname: '유건', budget: 50000 }), res);
  check(res.code === 200 && res.payload.success === true, '저장 성공', String(res.code));
  check(db.profiles.length === 1 && db.profiles[0].data.nickname === '유건',
        'profiles 테이블에 저장됨', JSON.stringify(db.profiles[0].data));
  check(db.user_data.length === 0, 'user_data 는 건드리지 않음 ★');

  // 조회
  res = mkRes();
  await sync(reqFor(USER, 'GET', { resource: 'profile' }), res);
  check(res.payload.nickname === '유건', '저장한 값 그대로 조회', res.payload.nickname);
  check(res.payload.success === undefined,
        'profile 응답에는 success 감싸기 없음 (기존 계약 유지)');

  /* ================================================================ *
   *  3. sync 리소스 — user_data 테이블
   * ================================================================ */
  section('3. resource=sync (또는 없음) 은 user_data 테이블로 간다');
  reset();
  res = mkRes();
  await sync(reqFor(USER, 'POST', {}, { wish: [{ id: 1 }], viewed: [], searches: ['a'] }), res);
  check(res.code === 200, '저장 성공');
  check(db.user_data.length === 1 && db.user_data[0].wish[0].id === 1,
        'user_data 테이블에 저장됨');
  check(db.profiles.length === 0, 'profiles 는 건드리지 않음 ★');

  res = mkRes();
  await sync(reqFor(USER, 'GET', {}), res);
  check(res.payload && res.payload.success === true,
        'sync 응답은 {success, data} 형태 (기존 계약 유지)', JSON.stringify(res.payload).slice(0, 60));
  check(Array.isArray(res.payload.data.wish),
        'data.wish 가 배열로 온다');

  /* ================================================================ *
   *  4. 두 리소스가 서로 침범하지 않는다
   * ================================================================ */
  section('4. 리소스 격리');
  reset();
  await sync(reqFor(USER, 'POST', { resource: 'profile' }, { theme: 'dark' }), mkRes());
  await sync(reqFor(USER, 'POST', {}, { wish: [{ id: 99 }] }), mkRes());
  check(db.profiles.length === 1 && db.user_data.length === 1,
        '각자 자기 테이블에만 저장');
  check(db.profiles[0].data.theme === 'dark' && db.user_data[0].wish[0].id === 99,
        '값이 섞이지 않음');

  /* ================================================================ *
   *  5. 인증 방어
   * ================================================================ */
  section('5. 인증 방어');
  reset();
  // 토큰 없이
  res = mkRes();
  await sync({ method: 'GET', headers: {}, url: '/api/sync', query: { email: USER },
               socket: { remoteAddress: '10.0.0.1' } }, res);
  check(res.code === 401, 'profile: 토큰 없음 → 401', String(res.code));

  res = mkRes();
  await sync({ method: 'GET', headers: {}, url: '/api/sync',
               query: { email: USER, resource: 'profile' },
               socket: { remoteAddress: '10.0.0.2' } }, res);
  check(res.code === 401, 'sync: 토큰 없음 → 401', String(res.code));

  // 다른 사람 토큰
  res = mkRes();
  await sync(reqFor(OTHER, 'GET', { resource: 'profile', email: USER }), res);
  // reqFor 는 email 을 자기 이메일로 강제 넣으므로 여기서 다시 명시
  const spoof = {
    method: 'GET',
    headers: { authorization: 'Bearer ' + issueToken(OTHER) },
    url: '/api/sync',
    query: { email: USER, resource: 'profile' },
    socket: { remoteAddress: '10.0.0.3' }
  };
  res = mkRes();
  await sync(spoof, res);
  check(res.code === 401,
        'body/query 에 남의 이메일 → 401 (토큰 주인과 다름) ★', String(res.code));

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})().catch(e => {
  console.error('오류:', e.message, e.stack);
  process.exit(1);
});
