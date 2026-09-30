#!/usr/bin/env node
/*
 * api/_account.js 계정 삭제 테스트 — 가짜 DB 만 쓴다. 운영 DB·네트워크 접근 없음.
 *
 *   node scripts/test-account-delete.js
 *
 * 무엇을 지키는가
 *   · 토큰 없음 / 위조 / 만료 → 401, DB 를 한 번도 건드리지 않는다
 *   · 다른 사람 이메일을 body·query 로 지정 → 403, 아무것도 지우지 않는다
 *   · 확인 값 없음 → 400
 *   · 성공 → 토큰 주인의 행만(대소문자 변형 포함) 6개 표에서 지우고, 결제 기록과
 *     다른 사람의 행(LIKE 와일드카드가 걸리는 비슷한 이메일 포함)은 그대로 둔다
 *   · 자동결제가 살아 있는 PRO → 409, 아무것도 지우지 않는다
 *   · DB 오류 → 503(내부 메시지·이메일 노출 없음), 다시 보내면 마저 지운다
 *   · /api/auth?action=delete-account 라우팅과 vercel.json rewrite
 */
'use strict';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-only-secret';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test';

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

/* ── 가짜 Supabase ─────────────────────────────────────────────────── */

/** SQL LIKE 패턴(\ 이스케이프) → 대소문자 무시 정규식. */
function likeToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '%') { re += '.*'; continue; }
    if (ch === '_') { re += '.'; continue; }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function makeDb(seed, opts = {}) {
  const tables = JSON.parse(JSON.stringify(seed));
  const calls = [];
  const failDelete = new Set(opts.failDelete || []);
  function from(name) {
    const q = { name, op: 'select', filters: [], countOpt: null };
    const exec = () => {
      calls.push({ table: name, op: q.op });
      if (!Object.prototype.hasOwnProperty.call(tables, name)) {
        return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache` } };
      }
      const match = r => q.filters.every(f => f(r));
      if (q.op === 'delete') {
        if (failDelete.has(name)) return { error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null };
        const before = tables[name].length;
        tables[name] = tables[name].filter(r => !match(r));
        return { error: null, count: before - tables[name].length };
      }
      return { data: tables[name].filter(match), error: null };
    };
    const b = {
      select() { q.op = 'select'; return b; },
      delete(o) { q.op = 'delete'; q.countOpt = o; return b; },
      ilike(col, pat) { const re = likeToRegex(pat); q.filters.push(r => re.test(String(r[col] || ''))); return b; },
      in(col, list) { q.filters.push(r => list.includes(r[col])); return b; },
      eq(col, v) { q.filters.push(r => r[col] === v); return b; },
      limit() { return b; },
      then(res, rej) { try { res(exec()); } catch (e) { rej(e); } }
    };
    return b;
  }
  return { from, tables, calls };
}

const TARGET = 'User@Example.com';
const OTHER = 'user2@example.com';
function seed() {
  return {
    alerts: [
      { email: TARGET, title: 'a' }, { email: 'user@example.com', title: 'b' }, { email: OTHER, title: 'c' }
    ],
    profiles: [{ email: TARGET, data: { nickname: 'n' } }, { email: OTHER, data: {} }],
    user_data: [{ email: 'USER@EXAMPLE.COM', wish: [1] }, { email: OTHER, wish: [2] }],
    ai_usage: [{ email: TARGET, usage_date: '2026-09-01', used: 3 }],
    subscriptions: [{ email: TARGET, plan: 'free', status: 'active', expires_at: null, billing_key: null }],
    auth_codes: [{ email: 'user@example.com', code_hash: 'h' }, { email: OTHER, code_hash: 'h2' }],
    payments: [{ email: TARGET, order_id: 'o1', amount: 4900, status: 'paid' }, { email: OTHER, order_id: 'o2' }]
  };
}

/* ── 요청/응답 흉내 ────────────────────────────────────────────────── */

let ipSeq = 0;
function req({ method = 'POST', token, body = {}, query = {} } = {}) {
  const headers = { 'x-forwarded-for': `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` };
  if (token !== undefined) headers.authorization = 'Bearer ' + token;
  return { method, headers, body, query, url: '/api/auth?action=delete-account', socket: { remoteAddress: '127.0.0.1' } };
}
function res() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.status = c => { r.statusCode = c; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.json = o => { r.body = o; return r; };
  r.end = () => r;
  return r;
}

const { issueToken } = require('../api/_auth');
const account = require('../api/_account');
const run = async (reqObj, db) => { const r = res(); await account.deleteAccountHandler(reqObj, r, { db }); return r; };
const rowsOf = (db, t, email) => db.tables[t].filter(r => r.email === email).length;

(async () => {
  console.log('\napi/_account.js 계정 삭제\n');
  const token = issueToken(TARGET);

  // 1. 방식·인증
  {
    const db = makeDb(seed());
    const r = await run(req({ method: 'GET', token }), db);
    check(r.statusCode === 405, 'GET 은 405', r.statusCode);

    const noTok = await run(req({ body: { confirm: 'delete-account' } }), db);
    check(noTok.statusCode === 401 && noTok.body.needsAuth === true, '토큰 없음 → 401', noTok.statusCode);

    const parts = token.split('.');
    const forged = [parts[0], parts[1], parts[2].slice(0, -2) + 'AA'].join('.');
    const bad = await run(req({ token: forged, body: { confirm: 'delete-account' } }), db);
    check(bad.statusCode === 401, '서명 위조 토큰 → 401', bad.statusCode);

    const expired = await run(req({ token: issueToken(TARGET, -1000), body: { confirm: 'delete-account' } }), db);
    check(expired.statusCode === 401, '만료 토큰 → 401', expired.statusCode);

    const garbage = await run(req({ token: 'not-a-token', body: { confirm: 'delete-account' } }), db);
    check(garbage.statusCode === 401, '형식이 틀린 토큰 → 401', garbage.statusCode);

    check(db.calls.length === 0, '인증 실패 경로에서는 DB 를 한 번도 부르지 않는다', `calls=${db.calls.length}`);
  }

  // 2. 다른 사용자 지정 공격
  {
    const db = makeDb(seed());
    const viaBody = await run(req({ token, body: { confirm: 'delete-account', email: OTHER } }), db);
    check(viaBody.statusCode === 403, 'body.email 로 다른 사람 지정 → 403', viaBody.statusCode);
    const viaQuery = await run(req({ token, body: { confirm: 'delete-account' }, query: { email: OTHER } }), db);
    check(viaQuery.statusCode === 403, 'query.email 로 다른 사람 지정 → 403', viaQuery.statusCode);
    const otherTok = await run(req({ token: issueToken(OTHER), body: { confirm: 'delete-account', email: TARGET } }), db);
    check(otherTok.statusCode === 403, '남의 토큰 + 내 이메일 → 403', otherTok.statusCode);
    check(db.calls.length === 0 && rowsOf(db, 'profiles', OTHER) === 1 && rowsOf(db, 'profiles', TARGET) === 1,
      '거절된 요청은 아무 행도 지우지 않는다');

    const sameCase = await run(req({ token, body: { confirm: 'delete-account', email: 'user@EXAMPLE.com' } }), db);
    check(sameCase.statusCode === 200, '대소문자만 다른 자기 이메일은 허용', sameCase.statusCode);
  }

  // 3. 확인 값
  {
    const db = makeDb(seed());
    const r = await run(req({ token, body: {} }), db);
    check(r.statusCode === 400 && r.body.confirm === 'delete-account', 'confirm 없음 → 400 (필요한 값 안내)', r.statusCode);
    const wrong = await run(req({ token, body: { confirm: true } }), db);
    check(wrong.statusCode === 400, 'confirm 값이 다르면 400', wrong.statusCode);
    check(db.calls.length === 0, '확인 전에는 DB 를 부르지 않는다');
  }

  // 4. 성공
  {
    const db = makeDb(seed());
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    const r = await run(req({ token, body: { confirm: 'delete-account' } }), db);
    console.log = origLog;
    check(r.statusCode === 200 && r.body.deleted === true, '삭제 성공 200', r.statusCode);
    check(JSON.stringify(r.body.retained) === '["payments"]', '응답이 보관 표(payments)를 밝힌다', JSON.stringify(r.body.retained));
    const variants = [TARGET, 'user@example.com', 'USER@EXAMPLE.COM'];
    const left = ['alerts', 'profiles', 'user_data', 'ai_usage', 'subscriptions', 'auth_codes']
      .map(t => [t, db.tables[t].filter(x => variants.includes(x.email)).length]).filter(([, n]) => n);
    check(left.length === 0, '토큰 주인의 행이 6개 표 모두에서 사라졌다 (대소문자 변형 포함)', JSON.stringify(left));
    check(rowsOf(db, 'payments', TARGET) === 1, '결제 기록은 남는다 (전자상거래법 5년)');
    check(['alerts', 'profiles', 'user_data', 'auth_codes', 'payments'].every(t => rowsOf(db, t, OTHER) === 1), '다른 사용자의 행은 그대로');
    check(!logs.join('\n').toLowerCase().includes('example.com'), '로그에 이메일을 남기지 않는다');

    const again = await run(req({ token, body: { confirm: 'delete-account' } }), db);
    check(again.statusCode === 200, '같은 요청을 다시 보내도 200 (멱등)', again.statusCode);
  }

  // 5. LIKE 와일드카드 — 비슷한 이메일은 지우지 않는다
  {
    const who = 'a_b%c@x.com';
    const db = makeDb({ alerts: [{ email: who }, { email: 'axbyc@x.com' }, { email: 'aXb%c@x.com' }], profiles: [], user_data: [], ai_usage: [], subscriptions: [], auth_codes: [], payments: [] });
    const r = await run(req({ token: issueToken(who), body: { confirm: 'delete-account' } }), db);
    check(r.statusCode === 200 && db.tables.alerts.length === 2 && !db.tables.alerts.some(x => x.email === who),
      '_ 와 % 가 든 이메일: 본인 행만 지우고 비슷한 이메일은 남긴다', JSON.stringify(db.tables.alerts.map(x => x.email)));
  }

  // 6. 구독 상태
  {
    const future = new Date(Date.now() + 10 * 864e5).toISOString();
    const past = new Date(Date.now() - 864e5).toISOString();
    const withSub = sub => { const s = seed(); s.subscriptions = [Object.assign({ email: TARGET }, sub)]; return makeDb(s); };

    const renewing = withSub({ plan: 'pro', status: 'active', expires_at: future, billing_key: 'bk_live' });
    const r1 = await run(req({ token, body: { confirm: 'delete-account' } }), renewing);
    check(r1.statusCode === 409 && r1.body.code === 'ACTIVE_SUBSCRIPTION', '자동결제 중인 PRO → 409', r1.statusCode);
    check(renewing.calls.every(c => c.op !== 'delete') && rowsOf(renewing, 'profiles', TARGET) === 1, '409 이면 아무것도 지우지 않는다');
    check(!JSON.stringify(r1.body).includes('bk_live'), '응답에 빌링키가 나가지 않는다');

    const canceled = withSub({ plan: 'pro', status: 'active', expires_at: future, billing_key: null });
    const r2 = await run(req({ token, body: { confirm: 'delete-account' } }), canceled);
    check(r2.statusCode === 200 && rowsOf(canceled, 'subscriptions', TARGET) === 0, '해지된(빌링키 없음) PRO 는 남은 기간과 함께 삭제', r2.statusCode);

    const expired = withSub({ plan: 'pro', status: 'active', expires_at: past, billing_key: 'bk' });
    const r3 = await run(req({ token, body: { confirm: 'delete-account' } }), expired);
    check(r3.statusCode === 200, '만료된 PRO 는 삭제 진행', r3.statusCode);
  }

  // 7. 표가 없는 환경 · DB 오류
  {
    const s = seed(); delete s.ai_usage;
    const db = makeDb(s);
    const r = await run(req({ token, body: { confirm: 'delete-account' } }), db);
    check(r.statusCode === 200 && !r.body.tables.includes('ai_usage'), '없는 표(ai_usage)는 건너뛰고 나머지를 지운다', JSON.stringify(r.body.tables));

    const broken = makeDb(seed(), { failDelete: ['user_data'] });
    const origErr = console.error; console.error = () => {};
    const r2 = await run(req({ token, body: { confirm: 'delete-account' } }), broken);
    console.error = origErr;
    check(r2.statusCode === 503, 'DB 오류 → 503', r2.statusCode);
    check(!/timeout|example\.com|user_data/i.test(JSON.stringify(r2.body)), '503 응답에 내부 메시지·이메일이 없다', JSON.stringify(r2.body));
    check(r2.body.deleted !== true, '실패를 성공으로 말하지 않는다');
  }

  // 8. 라우팅 — /api/auth?action=delete-account, vercel.json rewrite
  {
    const db = makeDb(seed());
    require.cache[require.resolve('../api/_supabase')] = { id: 'fake', filename: 'fake', loaded: true, exports: db };
    const auth = require('../api/auth');
    const r = res();
    const rq = req({ token, body: { confirm: 'delete-account' }, query: { action: 'delete-account' } });
    await auth(rq, r);
    check(r.statusCode === 200 && r.body.deleted === true, 'POST /api/auth?action=delete-account → 계정 삭제', r.statusCode);
    check(rowsOf(db, 'profiles', TARGET) === 0, 'auth.js 경로도 같은 삭제를 수행');

    const r2 = res();
    await auth(req({ body: { email: TARGET } , query: { action: 'delete-account' } }), r2);
    check(r2.statusCode === 401, 'auth.js 경로도 토큰 없으면 401 (이메일만으로는 불가)', r2.statusCode);

    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
    const idx = vercel.rewrites.findIndex(x => x.source === '/api/account/delete');
    const catchAll = vercel.rewrites.findIndex(x => x.source.startsWith('/((?!api/)'));
    check(idx >= 0 && vercel.rewrites[idx].destination === '/api/auth?action=delete-account', 'vercel.json: /api/account/delete → auth.js');
    check(idx >= 0 && idx < catchAll, 'rewrite 가 catch-all 보다 앞에 있다');
    const fns = fs.readdirSync(path.join(__dirname, '..', 'api')).filter(f => f.endsWith('.js') && !f.startsWith('_'));
    check(fns.length <= 12, `서버리스 함수 수 ${fns.length} ≤ 12 (Vercel Hobby 상한)`);
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
