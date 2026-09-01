#!/usr/bin/env node
/*
 * /api/alerts 통합 테스트.
 *
 *   node scripts/test-alerts.js
 *
 * 여기서 지키는 것:
 *   ① 인증 없는 요청은 401 (남의 주소로 알림 메일을 보내게 만들 수 없다)
 *   ② 조건이 하나도 없는 알림은 만들지 않는다 (아무 때도 발송되지 않는다)
 *   ③ 목표가 없이 "AI 가 사도 좋다고 하면" 조건만으로 신청할 수 있다
 *   ④ on_deal 컬럼이 없는 DB 에서도 신청이 된다 (마이그레이션 전)
 *   ⑤ 목록 조회가 onDeal 을 그대로 돌려준다
 *
 * ── 왜 ②·③ 이 중요한가 ─────────────────────────────────────────
 * 목표가를 정하려면 사용자가 적정가를 미리 알아야 한다. 모르니까 알림을
 * 신청하는 것이다. 그래서 금액 없이도 신청할 길을 냈고(on_deal), 대신
 * "조건이 아무것도 없는" 알림은 만들지 않는다 — 그런 알림은 영원히
 * 발송되지 않으면서 사용자는 신청했다고 믿는다.
 */
'use strict';

const path = require('path');
const Module = require('module');

/** 이 이름이 들어간 컬럼을 쓰면 "컬럼 없음" 오류를 낸다 (마이그레이션 전 DB 흉내). */
let missingColumns = [];
const db = { alerts: [] };
function reset() { db.alerts = []; missingColumns = []; }

function columnError(row) {
  const bad = missingColumns.find(c => Object.prototype.hasOwnProperty.call(row || {}, c));
  return bad ? { message: `column "${bad}" of relation "alerts" does not exist` } : null;
}

const fakeSupabase = {
  from(table) {
    const eqs = [];
    let selected = '';
    const q = {
      select(cols) {
        selected = String(cols || '');
        // 없는 컬럼을 고르면 PostgREST 가 오류를 낸다.
        const bad = missingColumns.find(c => selected.indexOf(c) > -1);
        if (bad) {
          q._selectError = { message: `column alerts.${bad} does not exist` };
        }
        return q;
      },
      eq(c, v) { eqs.push([c, v]); return q; },
      order() { return q; },
      limit() { return q; },
      delete() { q._delete = true; return q; },
      upsert(row) {
        const err = columnError(row);
        if (err) return Promise.resolve({ error: err });
        const i = (db[table] || []).findIndex(
          r => r.email === row.email && r.title === row.title);
        if (i > -1) db[table][i] = Object.assign({}, db[table][i], row);
        else db[table].push(Object.assign({}, row));
        return Promise.resolve({ error: null });
      },
      then(resolve) {
        if (q._selectError) return Promise.resolve({ data: null, error: q._selectError }).then(resolve);
        if (q._delete) {
          db[table] = (db[table] || []).filter(r => !eqs.every(([c, v]) => String(r[c]) === String(v)));
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        const rows = (db[table] || []).filter(r => eqs.every(([c, v]) => String(r[c]) === String(v)));
        /*
         * ★ 고른 컬럼만 돌려준다.
         *
         * 전체 행을 그대로 주면 "on_deal 없이 select 했는데도 on_deal 이 있는"
         * 상태가 되어, 컬럼이 없는 DB 를 흉내 내는 검사가 통째로 무의미해진다.
         * 실제 PostgREST 는 고른 컬럼만 준다.
         */
        const cols = selected.split(',').map(c => c.trim()).filter(Boolean);
        const projected = cols.length
          ? rows.map(r => {
              const o = {};
              cols.forEach(c => { if (c in r) o[c] = r[c]; });
              return o;
            })
          : rows;
        return Promise.resolve({ data: projected, error: null }).then(resolve);
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

process.env.AUTH_SECRET = 'test-secret-alerts';

const alerts = require('../api/alerts');
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
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.code = c; return this; },
    json(b) { this.payload = b; return this; }
  };
}
function reqFor(email, method, body, query) {
  return {
    method,
    headers: email ? { authorization: 'Bearer ' + issueToken(email) } : {},
    url: '/api/alerts',
    query: query || {},
    body,
    socket: { remoteAddress: '10.0.0.' + Math.floor(Math.random() * 250) }
  };
}

const USER = 'me@example.com';
const BASE = { email: USER, title: '무선 이어폰', productId: 'A-1111', mall: '쿠팡', currentPrice: 100000 };

(async () => {
  console.log('=== /api/alerts 테스트 ===');

  /* ================================================================ *
   *  1. 인증
   * ================================================================ */
  section('1. 인증');
  reset();
  {
    const res = mkRes();
    await alerts(reqFor(null, 'POST', { ...BASE, targetPrice: 90000 }), res);
    check(res.code === 401, '토큰 없이 신청하면 401 ★', String(res.code));
    check(db.alerts.length === 0, '저장도 되지 않는다');
  }
  {
    const res = mkRes();
    await alerts(reqFor('other@example.com', 'POST', { ...BASE, targetPrice: 90000 }), res);
    check(res.code === 401, '남의 이메일로 신청하면 401 ★', String(res.code));
  }

  /* ================================================================ *
   *  2. 조건 검증
   * ================================================================ */
  section('2. 조건이 하나도 없으면 만들지 않는다');
  reset();
  {
    const res = mkRes();
    await alerts(reqFor(USER, 'POST', { ...BASE }), res);
    check(res.code === 400, '★★ 목표가도 AI 조건도 없으면 400', String(res.code));
    check(/목표 가격을 넣거나 AI 추천 알림을 켜/.test((res.payload || {}).error || ''),
      '무엇을 해야 하는지 알려준다', (res.payload || {}).error);
    check(db.alerts.length === 0,
      '★★ 아무 때도 발송되지 않는 알림을 만들지 않는다', String(db.alerts.length));
  }
  {
    const res = mkRes();
    await alerts(reqFor(USER, 'POST', { ...BASE, targetPrice: -5000 }), res);
    check(res.code === 400, '음수 목표가는 400', String(res.code));
  }

  /* ================================================================ *
   *  3. AI 조건만으로 신청
   * ================================================================ */
  section('3. 목표가 없이 AI 조건만');
  reset();
  {
    const res = mkRes();
    await alerts(reqFor(USER, 'POST', { ...BASE, onDeal: true }), res);
    check(res.code === 200, '★★ 목표가 없이도 신청된다', String(res.code));
    check(db.alerts.length === 1, '한 건 저장', String(db.alerts.length));
    check(db.alerts[0] && db.alerts[0].on_deal === true, '★ on_deal 이 true 로 저장된다',
      db.alerts[0] && String(db.alerts[0].on_deal));
    check(db.alerts[0] && db.alerts[0].target_price === 0, '목표가는 0',
      db.alerts[0] && String(db.alerts[0].target_price));
    check(db.alerts[0] && db.alerts[0].product_id === 'A-1111',
      '★ 상품 식별자를 함께 저장한다 — 이름만으로 찾으면 다른 상품 가격을 본다');
  }

  section('4. 문자열 "true" 도 받는다 (폼 직렬화)');
  reset();
  for (const v of [true, 'true', 1, '1']) {
    const res = mkRes();
    await alerts(reqFor(USER, 'POST', { ...BASE, title: '이어폰 ' + v, onDeal: v }), res);
    check(res.code === 200 && db.alerts.some(a => a.on_deal === true),
      `onDeal=${JSON.stringify(v)} → 켜짐`, String(res.code));
  }
  {
    reset();
    const res = mkRes();
    await alerts(reqFor(USER, 'POST', { ...BASE, targetPrice: 90000, onDeal: 'false' }), res);
    check(res.code === 200 && db.alerts[0] && db.alerts[0].on_deal === false,
      '★ "false" 는 꺼진 것으로 본다 — 아무 값이나 참으로 읽지 않는다',
      db.alerts[0] && String(db.alerts[0].on_deal));
  }

  section('5. 목표가와 AI 조건을 같이');
  reset();
  {
    const res = mkRes();
    await alerts(reqFor(USER, 'POST', { ...BASE, targetPrice: 90000, onDeal: true }), res);
    check(res.code === 200, '둘 다 켜서 신청된다', String(res.code));
    check(db.alerts[0].target_price === 90000 && db.alerts[0].on_deal === true,
      '두 조건이 모두 저장된다');
  }

  /* ================================================================ *
   *  6. 마이그레이션 전 DB
   * ================================================================ */
  section('6. on_deal 컬럼이 없는 DB');
  reset();
  missingColumns = ['on_deal'];
  {
    const res = mkRes();
    await alerts(reqFor(USER, 'POST', { ...BASE, targetPrice: 90000, onDeal: true }), res);
    check(res.code === 200,
      '★★ 컬럼이 없어도 알림 신청 자체는 된다 — 배포와 마이그레이션 순서에 안 묶인다',
      String(res.code));
    check(db.alerts.length === 1, '목표가 알림으로 저장된다', String(db.alerts.length));
    check(!('on_deal' in db.alerts[0]), 'on_deal 없이 저장된다');
  }

  section('7. 목록 조회');
  reset();
  db.alerts.push({
    email: USER, title: '무선 이어폰', target_price: 0, current_price: 100000,
    link: '', image: '', mall: '쿠팡', sent: false, on_deal: true, product_id: 'A-1111'
  });
  {
    const res = mkRes();
    await alerts(reqFor(USER, 'GET', null, { email: USER }), res);
    check(res.code === 200, '목록 200', String(res.code));
    check(Array.isArray(res.payload) && res.payload.length === 1, '한 건', String((res.payload || []).length));
    check(res.payload[0] && res.payload[0].onDeal === true,
      '★ onDeal 을 그대로 돌려준다', res.payload[0] && String(res.payload[0].onDeal));
  }
  {
    // 컬럼이 없는 DB 에서도 목록은 나와야 한다.
    missingColumns = ['on_deal'];
    const res = mkRes();
    await alerts(reqFor(USER, 'GET', null, { email: USER }), res);
    check(res.code === 200, '★ 컬럼이 없어도 목록 조회가 된다', String(res.code));
    check(Array.isArray(res.payload) && res.payload.length === 1,
      '기존 알림이 사라지지 않는다', String((res.payload || []).length));
    check(res.payload[0] && res.payload[0].onDeal === false,
      '모르는 값은 꺼진 것으로 본다 — 켜졌다고 지어내지 않는다');
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})().catch(e => {
  console.error('오류:', e.message, e.stack);
  process.exit(1);
});
