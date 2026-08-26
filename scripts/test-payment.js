#!/usr/bin/env node
/*
 * PRO 구독 결제 테스트 — 실제 결제 0회 / 토스 API 호출 0회 / 운영 DB 접근 0회.
 *
 *   node scripts/test-payment.js
 *
 * 무엇을 지키는 테스트인가
 *   결제는 되돌리기가 가장 비싼 도메인이다. 여기서 지켜야 하는 것:
 *     ① 결제 없이 PRO 가 되지 않는다
 *     ② 프론트가 보낸 금액·plan·email 로 권한이 바뀌지 않는다
 *     ③ 같은 결제가 두 번 반영되지 않는다 (웹훅 재전송 포함)
 *     ④ 위조된 웹훅으로 PRO 가 되지 않는다
 *     ⑤ 결제사/DB 장애 시 권한을 주지 않는다 (fail closed)
 *
 * fetch 를 가로채서 토스 API 를 흉내 낸다. 실제 카드도, 실제 돈도 쓰지 않는다.
 */
'use strict';

const path = require('path');
const Module = require('module');

/* ------------------------------------------------------------------ *
 *  가짜 Supabase — UNIQUE 제약과 조건부 UPDATE 까지 흉내 낸다.
 *
 *  두 가지가 멱등성/원자성 테스트의 근거다.
 *    · insert 시 (order_id) / (payment_key) UNIQUE 위반을 23505 로 돌려준다
 *    · update ... eq(status,'pending') 이 "조건에 맞는 행만" 바꾸고
 *      바뀐 행을 select 로 돌려준다 → 선점(claim)이 한 번만 성공하는지 볼 수 있다
 * ------------------------------------------------------------------ */
const db = { subscriptions: [], payments: [], failInsert: false, failSubRead: false, failUpdate: false, failUpdateStatus: '' };

function reset() {
  db.subscriptions = []; db.payments = [];
  db.failInsert = false; db.failSubRead = false; db.failUpdate = false; db.failUpdateStatus = '';
}
const subOf = e => db.subscriptions.find(r => r.email === e);
const payOf = o => db.payments.find(r => r.order_id === o);

function cmpVal(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const fakeSupabase = {
  from(table) {
    const eqs = [];
    const ins = [];        // .in(col, values)
    const nots = [];       // .not(col, 'is', null)
    const ltes = [];       // .lte(col, value)
    const lts = [];        // .lt(col, value)
    let sort = null, cap = null;
    let patch = null, mode = '';

    const rows = () => (db[table] || []).filter(r =>
      eqs.every(([c, v]) => String(r[c]) === String(v))
      && ins.every(([c, vs]) => vs.map(String).indexOf(String(r[c])) > -1)
      && nots.every(([c]) => r[c] !== null && r[c] !== undefined)
      && ltes.every(([c, v]) => cmpVal(r[c], v) <= 0)
      && lts.every(([c, v]) => cmpVal(r[c], v) < 0));

    function readResult() {
      if (table === 'subscriptions' && db.failSubRead) {
        return { data: null, error: { message: 'db down' } };
      }
      let out = rows();
      if (sort) out = out.slice().sort((a, b) => (sort.asc ? 1 : -1) * cmpVal(a[sort.col], b[sort.col]));
      if (cap !== null) out = out.slice(0, cap);
      return { data: out, error: null };
    }

    function applyUpdate() {
      if (db.failUpdate) return { data: null, error: { message: 'db down' } };
      // 특정 전이만 골라 실패시킨다 (예: charging→paid 확정만 막기)
      if (db.failUpdateStatus && patch && patch.status === db.failUpdateStatus) {
        return { data: null, error: { message: 'db down' } };
      }
      const hit = rows();
      hit.forEach(r => Object.assign(r, patch));
      return { data: hit.map(r => Object.assign({}, r)), error: null };
    }

    const q = {
      select() { return q; },
      eq(c, v) { eqs.push([c, v]); return q; },
      in(c, vs) { ins.push([c, vs]); return q; },
      not(c) { nots.push([c]); return q; },
      lte(c, v) { ltes.push([c, v]); return q; },
      lt(c, v) { lts.push([c, v]); return q; },
      order(c, o) { sort = { col: c, asc: !o || o.ascending !== false }; return q; },
      limit(n) { cap = n; return q; },
      update(p) { mode = 'update'; patch = p; return q; },

      maybeSingle() {
        const r = readResult();
        if (r.error) return Promise.resolve(r);
        return Promise.resolve({ data: r.data[0] || null, error: null });
      },

      insert(row) {
        if (db.failInsert) return Promise.resolve({ error: { code: 'XX000', message: 'db down' } });
        // UNIQUE (order_id) / UNIQUE (payment_key)
        const dup = (db[table] || []).some(r =>
          (row.order_id !== undefined && r.order_id === row.order_id)
          || (row.payment_key !== undefined && r.payment_key === row.payment_key));
        if (dup) {
          return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
        }
        db[table].push(Object.assign({}, row));
        return Promise.resolve({ error: null });
      },

      upsert(row, opts) {
        const key = (opts && opts.onConflict) || 'email';
        const i = (db[table] || []).findIndex(r => String(r[key]) === String(row[key]));
        if (i > -1) db[table][i] = Object.assign({}, db[table][i], row);
        else db[table].push(Object.assign({}, row));
        return Promise.resolve({ error: null });
      },

      // await 가능한 종단. update 면 패치를 적용하고 바뀐 행을 돌려준다.
      then(resolve, reject) {
        const r = mode === 'update' ? applyUpdate() : readResult();
        return Promise.resolve(r).then(resolve, reject);
      }
    };
    return q;
  },
  rpc() { return Promise.resolve({ data: null, error: null }); }
};

const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

process.env.AUTH_SECRET = 'test-secret-payment';
process.env.TOSS_SECRET_KEY = 'test_sk_FAKE_FOR_TESTS_ONLY';
process.env.TOSS_CLIENT_KEY = 'test_ck_FAKE_FOR_TESTS_ONLY';

/* ------------------------------------------------------------------ *
 *  가짜 토스 API (fetch 가로채기)
 * ------------------------------------------------------------------ */
const toss = { billingKey: 'bk_test_123', charges: [], payments: {}, failIssue: false, failCharge: false, failLookup: false, lastHeaders: null };

function resetToss() {
  toss.charges = []; toss.payments = {};
  toss.failIssue = false; toss.failCharge = false; toss.failLookup = false;
  toss.lastHeaders = null;
}

const realFetch = global.fetch;
global.fetch = async function(url, opts = {}) {
  const u = String(url);
  toss.lastHeaders = opts.headers || {};
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });

  if (u.endsWith('/v1/billing/authorizations/issue')) {
    if (toss.failIssue) return json(400, { code: 'INVALID_AUTH_KEY', message: 'bad authKey' });
    return json(200, { billingKey: toss.billingKey, customerKey: body.customerKey });
  }
  if (/\/v1\/billing\/[^/]+$/.test(u)) {
    if (toss.failCharge) return json(402, { code: 'REJECT_CARD_COMPANY', message: 'declined' });
    const pk = 'pk_' + body.orderId;
    const payment = {
      paymentKey: pk, orderId: body.orderId, totalAmount: body.amount,
      status: 'DONE', method: '카드'
    };
    toss.payments[pk] = payment;
    toss.charges.push({ body, headers: opts.headers });
    return json(200, payment);
  }
  /*
   * 주문번호로 결제 조회 — 승인 도중 죽은 주문을 복구할 때 쓴다.
   * paymentKey 조회보다 먼저 검사해야 한다 (경로가 한 칸 더 깊다).
   */
  const byOrder = u.match(/\/v1\/payments\/orders\/([^/]+)$/);
  if (byOrder) {
    if (toss.failLookup) return json(500, { code: 'ERR', message: 'toss down' });
    const oid = decodeURIComponent(byOrder[1]);
    const p = Object.values(toss.payments).find(x => x.orderId === oid);
    if (!p) return json(404, { code: 'NOT_FOUND_PAYMENT', message: 'no such payment' });
    return json(200, p);
  }
  const look = u.match(/\/v1\/payments\/([^/]+)$/);
  if (look) {
    if (toss.failLookup) return json(500, { code: 'ERR', message: 'toss down' });
    const p = toss.payments[decodeURIComponent(look[1])];
    if (!p) return json(404, { code: 'NOT_FOUND_PAYMENT', message: 'no such payment' });
    return json(200, p);
  }
  const cancel = u.match(/\/v1\/payments\/([^/]+)\/cancel$/);
  if (cancel) return json(200, { status: 'CANCELED' });
  return json(404, { code: 'UNKNOWN', message: u });
};

const tossClient = require('../api/_toss');
const billing = require('../api/_billing');
const payment = require('../api/payment');
const { issueToken } = require('../api/_auth');

/* ------------------------------------------------------------------ *
 *  유틸
 * ------------------------------------------------------------------ */
let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function section(n) { console.log(`\n${n}`); }

const USER = 'buyer@example.com';
const OTHER = 'attacker@example.com';

function mkRes() {
  return {
    code: 200, payload: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.payload = b; return this; }
  };
}
const reqFor = (email, body, action) => ({
  method: 'POST',
  headers: email ? { authorization: 'Bearer ' + issueToken(email) } : {},
  query: { action },
  body: body || {},
  socket: { remoteAddress: '10.0.0.' + Math.floor(Math.random() * 250) }
});

/*
 * 실제 주문을 만든다.
 *
 * confirm 은 이제 prepare 가 남긴 pending 행이 있어야만 진행한다 —
 * 아무 문자열이나 orderId 로 보내 결제를 시작시킬 수 없다.
 * 그래서 테스트도 실제 흐름(prepare → confirm)을 그대로 따라간다.
 */
async function prepared(email) {
  const r = mkRes();
  await payment.handlePrepare(reqFor(email, {}, 'prepare'), r, email);
  if (!r.payload || !r.payload.orderId) throw new Error('prepare 실패: ' + JSON.stringify(r.payload));
  return r.payload.orderId;
}

(async () => {

  /* ================================================================ *
   *  1. 결제 성공 경로
   * ================================================================ */
  section('1. FREE → PRO 결제 성공');
  reset(); resetToss();
  let res = mkRes();
  const orderId = await prepared(USER);
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak_ok', orderId });
  check(res.code === 200 && res.payload.ok === true, '결제 확정 성공', `${res.code}`);
  check(subOf(USER) && subOf(USER).plan === 'pro', 'subscriptions.plan = pro', subOf(USER) && subOf(USER).plan);
  check(subOf(USER).status === 'active', 'status = active');
  check(db.payments.length === 1 && db.payments[0].status === 'paid', 'payments 1건 기록');
  check(db.payments[0].amount === 4900, '기록 금액 4,900원', String(db.payments[0].amount));

  section('1-b. 서버가 금액을 정한다');
  check(toss.charges.length === 1, '결제 승인 1회');
  check(toss.charges[0].body.amount === 4900, '토스로 나간 금액이 서버 상수 4,900원',
        String(toss.charges[0].body.amount));
  check(toss.charges[0].headers['Idempotency-Key'] === orderId,
        'Idempotency-Key 헤더로 중복 승인 방지', toss.charges[0].headers['Idempotency-Key']);

  section('1-c. 응답에 민감정보가 없다');
  const payloadStr = JSON.stringify(res.payload);
  check(payloadStr.indexOf(toss.billingKey) === -1, 'billingKey 미노출 ★');
  check(payloadStr.indexOf('pk_') === -1, 'paymentKey 미노출');
  check(!/customer_key|customerKey/.test(payloadStr), 'customerKey 미노출');

  /* ================================================================ *
   *  2. 금액 위조
   * ================================================================ */
  section('2. 금액 스푸핑 방어');
  reset(); resetToss();
  res = mkRes();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER,
    { authKey: 'ak', orderId: await prepared(USER), amount: 100, price: 100 });
  check(toss.charges[0].body.amount === 4900,
        'body 에 amount=100 을 보내도 4,900원으로 결제된다 ★', String(toss.charges[0].body.amount));

  section('2-b. 검증 단계에서 금액 불일치를 잡는다');
  check(billing.verifyPayment({ status: 'DONE', totalAmount: 100, orderId: 'o1' },
        { orderId: 'o1', amount: 4900 }).ok === false, '100원 결제 → 거절');
  check(billing.verifyPayment({ status: 'DONE', totalAmount: 9800, orderId: 'o1' },
        { orderId: 'o1', amount: 4900 }).ok === false, '더 많이 낸 것도 거절(기대값과 다름)');
  check(billing.verifyPayment({ status: 'DONE', totalAmount: 4900, orderId: 'o1' },
        { orderId: 'o1', amount: 4900 }).ok === true, '정확히 4,900원 → 통과');

  /* ================================================================ *
   *  3. 신원 위조
   * ================================================================ */
  section('3. email / plan 스푸핑 방어');
  reset(); resetToss();
  res = mkRes();
  // 공격자가 자기 토큰으로 남의 이메일·pro 를 body 에 실어 보낸다.
  await payment.handleConfirm(reqFor(OTHER, {}, 'confirm'), res, OTHER,
    { authKey: 'ak', orderId: await prepared(OTHER), email: USER, plan: 'pro' });
  check(!subOf(USER), 'body 의 email 로 남의 구독이 만들어지지 않는다 ★');
  check(subOf(OTHER) && subOf(OTHER).plan === 'pro', '토큰 주인에게만 적용된다');

  section('3-b. customerKey 는 서버가 파생한다');
  const ckA = billing.customerKeyFor(USER);
  const ckB = billing.customerKeyFor(USER);
  const ckC = billing.customerKeyFor(OTHER);
  check(ckA === ckB, '같은 이메일 → 같은 customerKey (결정적)');
  check(ckA !== ckC, '다른 이메일 → 다른 customerKey');
  check(ckA.indexOf(USER) === -1 && ckA.indexOf('@') === -1,
        'customerKey 에 이메일이 노출되지 않는다 ★', ckA);

  section('3-c. 미인증 요청');
  const unauth = await (async () => {
    const r = mkRes();
    await payment(reqFor('', {}, 'prepare'), r);
    return r;
  })();
  check(unauth.code === 401, '토큰 없이 /api/payment → 401', String(unauth.code));

  /* ================================================================ *
   *  4. 결제 실패 → PRO 미부여
   * ================================================================ */
  section('4. 결제 실패 시 PRO 를 주지 않는다');
  reset(); resetToss(); toss.failCharge = true;
  res = mkRes();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER,
    { authKey: 'ak', orderId: await prepared(USER) });
  check(res.code === 402, '402 반환', String(res.code));
  check(!subOf(USER), 'PRO 부여 안 됨 ★');
  check(db.payments.length === 1 && db.payments[0].status === 'failed', '실패도 기록에 남는다');

  section('4-b. 카드 등록(빌링키) 실패');
  reset(); resetToss(); toss.failIssue = true;
  res = mkRes();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER,
    { authKey: 'bad', orderId: await prepared(USER) });
  check(res.code === 402 && !subOf(USER), '빌링키 실패 → PRO 없음');

  section('4-c. 결제사 장애 (fail closed)');
  reset(); resetToss();
  const origFetch = global.fetch;
  global.fetch = async () => { throw Object.assign(new Error('network'), { name: 'TypeError' }); };
  res = mkRes();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER,
    { authKey: 'ak', orderId: await prepared(USER) });
  global.fetch = origFetch;
  check(!subOf(USER), '결제사 연결 실패 → PRO 없음 ★');

  section('4-d. DB 장애 (fail closed)');
  /*
   * 승인은 됐는데 원장을 확정하지 못한 경우.
   *
   * 예전에는 payments 에 INSERT 하던 자리라 failInsert 로 흉내 냈다. 이제는
   * prepare 가 만들어 둔 pending 행을 UPDATE 하는 구조라 failUpdate 로 막는다.
   * 확인하려는 성질은 그대로다 — 기록을 못 남기면 권한도 주지 않는다.
   */
  reset(); resetToss();
  {
    const oidDb = await prepared(USER);
    db.failUpdateStatus = 'paid';
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oidDb });
    db.failUpdateStatus = '';
    check(res.code === 500, '기록 실패 → 500', String(res.code));
    check(!subOf(USER), '기록을 못 남기면 PRO 도 주지 않는다 ★');
  }

  section('4-e. 주문 기록 자체가 실패하면 결제창을 열지 않는다');
  reset(); resetToss(); db.failInsert = true;
  res = mkRes();
  await payment.handlePrepare(reqFor(USER, {}, 'prepare'), res, USER);
  db.failInsert = false;
  check(res.code === 503, 'prepare 실패 → 503', String(res.code));
  check(!(res.payload && res.payload.orderId), 'orderId 를 내주지 않는다 ★');

  /* ================================================================ *
   *  5. 멱등성
   * ================================================================ */
  section('5. 이미 결제된 orderId 재요청 — 멱등');
  /*
   * 예전에는 409 로 거절했다. 지금은 200 + alreadyProcessed 다.
   *
   * 무엇이 달라졌나 — 거절해야 하는 것은 "두 번째 청구" 지 "두 번째 문의" 가
   * 아니다. 결제창에서 돌아온 프론트가 네트워크 문제로 confirm 을 두 번 보내는
   * 것은 정상적인 일이고, 그때 409 를 주면 사용자는 결제가 실패한 줄 안다
   * (실제로는 성공했는데). 중요한 것은 아래 세 가지다.
   *   · 토스에 승인이 한 번만 나간다
   *   · payments 행이 하나뿐이다
   *   · PRO 기간이 두 번 늘어나지 않는다
   */
  reset(); resetToss();
  const oid = await prepared(USER);
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), mkRes(), USER, { authKey: 'ak', orderId: oid });
  const expAfterFirst = subOf(USER).expires_at;
  res = mkRes();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
  check(res.code === 200 && res.payload && res.payload.alreadyProcessed === true,
        '같은 orderId 두 번째 → 200 + alreadyProcessed ★', String(res.code));
  check(db.payments.length === 1, '결제 기록은 1건뿐', String(db.payments.length));
  check(toss.charges.length === 1, '토스 승인 요청은 1회뿐 ★', String(toss.charges.length));
  check(subOf(USER).expires_at === expAfterFirst,
        'PRO 기간이 두 번 늘어나지 않는다 ★');

  section('5-b. 동시 결제 요청');
  reset(); resetToss();
  const sameOrder = await prepared(USER);
  const rs = await Promise.all([1, 2, 3].map(() => {
    const r = mkRes();
    return payment.handleConfirm(reqFor(USER, {}, 'confirm'), r, USER,
      { authKey: 'ak', orderId: sameOrder }).then(() => r);
  }));
  const okCount = rs.filter(r => r.payload && r.payload.ok).length;
  check(db.payments.length === 1, '동시 3건이어도 결제 기록 1건 ★', String(db.payments.length));
  check(toss.charges.length === 1, '동시 3건이어도 토스 승인은 1회 ★', String(toss.charges.length));
  check(okCount <= 1, '성공 응답은 최대 1건', String(okCount));

  /* ================================================================ *
   *  6. 웹훅
   * ================================================================ */
  section('6. 웹훅 — 위조 방어');
  reset(); resetToss();
  res = mkRes();
  // 공격자가 "결제 성공했다"고 직접 POST. 토스에는 그런 결제가 없다.
  await payment.handleWebhook({}, res, {
    eventType: 'PAYMENT_STATUS_CHANGED',
    data: { paymentKey: 'pk_FORGED', orderId: 'o_forged', status: 'DONE', totalAmount: 4900 }
  });
  check(!subOf(USER) && db.payments.length === 0,
        '위조 웹훅으로 PRO 가 되지 않는다 ★ (토스 재조회로 걸러짐)');

  section('6-b. 웹훅 재전송 멱등성');
  reset(); resetToss();
  const oid2 = await prepared(USER);
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), mkRes(), USER, { authKey: 'ak', orderId: oid2 });
  const pk2 = 'pk_' + oid2;
  const before = db.payments.length;
  await payment.handleWebhook({}, mkRes(), { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: pk2, orderId: oid2 } });
  await payment.handleWebhook({}, mkRes(), { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: pk2, orderId: oid2 } });
  check(db.payments.length === before, '같은 웹훅 2회 → 기록 증가 없음 ★',
        `${before} → ${db.payments.length}`);

  section('6-c. 취소 웹훅 → 구독 해제');
  reset(); resetToss();
  const oid3 = await prepared(USER);
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), mkRes(), USER, { authKey: 'ak', orderId: oid3 });
  check(subOf(USER).plan === 'pro', '(전제) PRO 상태');
  const pk3 = 'pk_' + oid3;
  toss.payments[pk3].status = 'CANCELED';
  await payment.handleWebhook({}, mkRes(), { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: pk3, orderId: oid3 } });
  check(subOf(USER).plan === 'free', '환불/취소 → FREE 로 내려간다 ★', subOf(USER).plan);
  check(subOf(USER).billing_key === null, '빌링키 제거 (다음 결제 없음)');

  section('6-d. 조회 실패 시 재전송을 받는다');
  reset(); resetToss(); toss.failLookup = true;
  res = mkRes();
  await payment.handleWebhook({}, res, { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'pk_x' } });
  check(res.code === 502, '일시 오류는 5xx 로 응답해 재전송을 유도', String(res.code));

  /* ================================================================ *
   *  7. 구독 취소 / 만료
   * ================================================================ */
  section('7. 구독 취소 — 남은 기간은 유지');
  reset(); resetToss();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), mkRes(), USER,
    { authKey: 'ak', orderId: await prepared(USER) });
  res = mkRes();
  await payment.handleCancel(reqFor(USER, {}, 'cancel'), res, USER);
  check(res.code === 200 && res.payload.ok, '취소 성공');
  check(subOf(USER).plan === 'pro', '즉시 FREE 로 떨어지지 않는다 ★ (이미 낸 기간)');
  check(subOf(USER).billing_key === null, '빌링키 제거 → 다음 자동결제 없음');
  check(!!subOf(USER).canceled_at, 'canceled_at 기록');

  section('7-b. 만료되면 FREE (기존 _plan 로직과 연결)');
  const plan = require('../api/_plan');
  const expired = plan.resolvePlanFromRow(
    { plan: 'pro', status: 'active', expires_at: '2020-01-01T00:00:00Z' }, new Date());
  check(expired.plan === 'free' && expired.limit === 3, '만료 → FREE 3회', `${expired.plan}/${expired.limit}`);
  const live = plan.resolvePlanFromRow(
    { plan: 'pro', status: 'active', expires_at: '2099-01-01T00:00:00Z' }, new Date());
  check(live.plan === 'pro' && live.limit === 50, '유효 → PRO 50회', `${live.plan}/${live.limit}`);

  section('7-c. 기간 연장은 누적된다');
  reset(); resetToss();
  const future = new Date(Date.now() + 10 * 86400000).toISOString();
  db.subscriptions.push({ email: USER, plan: 'pro', status: 'active', expires_at: future });
  const act = await billing.activatePro(USER, { billingKey: 'bk', customerKey: 'ck' });
  check(Date.parse(act.expiresAt) > Date.parse(future),
        '남은 기간 뒤로 30일이 더해진다 (사용자 손해 없음)');

  /* ================================================================ *
   *  8. publicSubscription — 서버 전용 필드 제거
   * ================================================================ */
  section('8. 응답 정제');
  const pub = billing.publicSubscription({
    email: USER, plan: 'pro', status: 'active', expires_at: 'X',
    billing_key: 'bk_secret', customer_key: 'ck_secret'
  });
  check(!('billing_key' in pub) && !('billingKey' in pub), 'billing_key 제거 ★');
  check(!('customer_key' in pub), 'customer_key 제거');
  check(!('email' in pub), 'email 제거');
  check(JSON.stringify(pub).indexOf('secret') === -1, '비밀값 흔적 없음', JSON.stringify(pub));

  /* ================================================================ *
   *  9. 인증 헤더 형식 (공식 문서)
   * ================================================================ */
  section('9. 토스 인증 헤더');
  const expectAuth = 'Basic ' + Buffer.from('test_sk_FAKE_FOR_TESTS_ONLY:', 'utf8').toString('base64');
  check(tossClient.authHeader() === expectAuth,
        'Basic base64(secretKey + ":") — 콜론 포함 ★', tossClient.authHeader().slice(0, 20) + '…');
  check(tossClient.isTestKey() === true, '테스트 키 감지');
  check(tossClient.API_BASE === 'https://api.tosspayments.com', '공식 API 호스트');

  section('9-b. 키가 없으면 결제 기능이 닫힌다');
  const savedSk = process.env.TOSS_SECRET_KEY;
  delete process.env.TOSS_SECRET_KEY;
  check(tossClient.isConfigured() === false, '시크릿 키 없음 → 결제 불가 ★');
  res = mkRes();
  await payment.handlePrepare(reqFor(USER, {}, 'prepare'), res, USER);
  check(res.code === 503, '키가 없으면 503 (우회로 없음)', String(res.code));
  process.env.TOSS_SECRET_KEY = savedSk;

  section('9-b2. 결제위젯 키(_gck_)로 설정된 경우 prepare 가 명확한 오류를 준다');
  // 프론트가 tp.payment() 를 부르는데 위젯 키(_gck_)를 넣으면 SDK 초기화에서
  // 동기 throw 한다 ("API 개별 연동 키의 클라이언트 키로 SDK를 연동해주세요").
  // 그 예외는 프론트 try/catch 에 잡혀 "결제창을 열지 못했어요." 로만 뜨므로
  // 운영자가 원인을 알기 어렵다. 서버가 미리 잘라서 명확한 코드를 준다.
  const savedCk = process.env.TOSS_CLIENT_KEY;
  const savedSk2 = process.env.TOSS_SECRET_KEY;
  process.env.TOSS_CLIENT_KEY = 'test_gck_widget_FAKE_FOR_TESTS_ONLY';
  process.env.TOSS_SECRET_KEY = 'test_gsk_widget_FAKE_FOR_TESTS_ONLY';
  check(tossClient.isWidgetClientKey() === true, '위젯 client key 감지 ★');
  check(tossClient.isWidgetSecretKey() === true, '위젯 secret key 감지 (진단용)');
  res = mkRes();
  await payment.handlePrepare(reqFor(USER, {}, 'prepare'), res, USER);
  check(res.code === 503, '위젯 키 → 503', String(res.code));
  check(res.payload && res.payload.error === 'PAYMENT_KEY_WRONG_TYPE',
        '오류 코드가 PAYMENT_KEY_WRONG_TYPE ★', res.payload && res.payload.error);
  check(!!(res.payload && res.payload.message && res.payload.message.length > 0),
        '프론트가 토스트로 띄울 message 필드 포함', res.payload && res.payload.message);
  check(!(res.payload && res.payload.clientKey),
        '위젯 키는 절대 프론트로 내려가지 않는다 ★ (SDK 로 넘어가면 초기화 실패)');

  // 정상(API 개별 연동) 키로 되돌리면 다시 통과
  process.env.TOSS_CLIENT_KEY = 'test_ck_FAKE_FOR_TESTS_ONLY';
  process.env.TOSS_SECRET_KEY = 'test_sk_FAKE_FOR_TESTS_ONLY';
  check(tossClient.isWidgetClientKey() === false, 'API 개별 연동 키(_ck_) 는 통과');
  res = mkRes();
  await payment.handlePrepare(reqFor(USER, {}, 'prepare'), res, USER);
  check(res.code === 200 && res.payload && res.payload.clientKey === 'test_ck_FAKE_FOR_TESTS_ONLY',
        '정상 키 → prepare 성공', String(res.code));

  section('9-b3. test / live 키 혼용은 결제를 시작조차 하지 않는다 ★');
  // client=test / secret=live 가 가장 위험하다 — 결제창은 테스트처럼 보이는데
  // 서버 승인은 운영으로 나가서 실제 카드에 청구된다.
  process.env.TOSS_CLIENT_KEY = 'test_ck_FAKE_FOR_TESTS_ONLY';
  process.env.TOSS_SECRET_KEY = 'live_sk_FAKE_FOR_TESTS_ONLY';
  check(tossClient.isMixedKeyEnv() === true, 'client=test / secret=live 감지 ★');
  res = mkRes();
  await payment.handlePrepare(reqFor(USER, {}, 'prepare'), res, USER);
  check(res.code === 503 && res.payload.error === 'PAYMENT_KEY_ENV_MISMATCH',
        '혼용 → 503 PAYMENT_KEY_ENV_MISMATCH ★', `${res.code}/${res.payload.error}`);
  check(!res.payload.clientKey, '혼용 상태에서 clientKey 가 내려가지 않는다');

  // 반대 조합도 막는다 (결제한 줄 알았는데 정산이 없는 경우)
  process.env.TOSS_CLIENT_KEY = 'live_ck_FAKE_FOR_TESTS_ONLY';
  process.env.TOSS_SECRET_KEY = 'test_sk_FAKE_FOR_TESTS_ONLY';
  check(tossClient.isMixedKeyEnv() === true, 'client=live / secret=test 도 감지 ★');
  res = mkRes();
  await payment.handlePrepare(reqFor(USER, {}, 'prepare'), res, USER);
  check(res.code === 503, '반대 조합도 503', String(res.code));

  // 같은 환경이면 통과
  process.env.TOSS_CLIENT_KEY = 'test_ck_FAKE_FOR_TESTS_ONLY';
  process.env.TOSS_SECRET_KEY = 'test_sk_FAKE_FOR_TESTS_ONLY';
  check(tossClient.isMixedKeyEnv() === false, 'test+test → 통과');
  process.env.TOSS_CLIENT_KEY = 'live_ck_FAKE_FOR_TESTS_ONLY';
  process.env.TOSS_SECRET_KEY = 'live_sk_FAKE_FOR_TESTS_ONLY';
  check(tossClient.isMixedKeyEnv() === false, 'live+live → 통과');

  section('9-b4. 진단 요약에 키 값이 절대 들어가지 않는다 ★');
  process.env.TOSS_CLIENT_KEY = 'live_ck_SUPERSECRETVALUE12345';
  process.env.TOSS_SECRET_KEY = 'live_sk_SUPERSECRETVALUE67890';
  const summary = tossClient.keySummary();
  const summaryStr = JSON.stringify(summary);
  check(summaryStr.indexOf('SUPERSECRET') === -1,
        'keySummary 에 키 값 흔적 없음 ★', summaryStr);
  check(summary.client.env === 'live' && summary.client.kind === 'api',
        'client 환경/유형만 보고', `${summary.client.env}/${summary.client.kind}`);
  check(summary.secret.env === 'live' && summary.secret.kind === 'api',
        'secret 환경/유형만 보고', `${summary.secret.env}/${summary.secret.kind}`);
  process.env.TOSS_CLIENT_KEY = 'test_gck_w';
  check(tossClient.keySummary().client.kind === 'widget', '위젯 키 유형 표기');

  process.env.TOSS_CLIENT_KEY = savedCk;
  process.env.TOSS_SECRET_KEY = savedSk2;

  section('9-c. 자동결제 승인만 60초 타임아웃 (공식 문서: "최소 60초로 설정하세요")');
  check(tossClient.CHARGE_TIMEOUT_MS >= 60000,
        'chargeBilling 타임아웃 ≥ 60,000ms ★', String(tossClient.CHARGE_TIMEOUT_MS));
  check(tossClient.TIMEOUT_MS < 60000 && tossClient.TIMEOUT_MS >= 5000,
        '조회·취소·빌링키 발급은 짧은 기본 타임아웃 유지', String(tossClient.TIMEOUT_MS));
  // 실제로 chargeBilling 호출이 60초 예산으로 fetch 를 부르는지 확인
  reset(); resetToss();
  let capturedBudget = 0;
  const realSetTimeout = global.setTimeout;
  global.setTimeout = function(fn, ms) {
    // AbortController 용 타이머만 캡처 (Toss call 안에서 세팅되는 유일한 setTimeout)
    if (typeof ms === 'number' && ms >= 1000) capturedBudget = ms;
    return realSetTimeout(fn, ms);
  };
  await tossClient.chargeBilling('bk_test', {
    customerKey: 'ck', amount: 4900, orderId: 'o_timeout_check', orderName: 'x'
  }, 'idempo_1');
  global.setTimeout = realSetTimeout;
  check(capturedBudget === tossClient.CHARGE_TIMEOUT_MS,
        `실제 AbortController 타이머가 CHARGE_TIMEOUT_MS 를 쓴다`, String(capturedBudget));
  // 대조: 결제 조회는 짧은 타이머여야 한다
  capturedBudget = 0;
  global.setTimeout = function(fn, ms) {
    if (typeof ms === 'number' && ms >= 1000) capturedBudget = ms;
    return realSetTimeout(fn, ms);
  };
  await tossClient.getPayment('pk_test');
  global.setTimeout = realSetTimeout;
  check(capturedBudget === tossClient.TIMEOUT_MS,
        '결제 조회는 기본 타이머 (chargeBilling 과 분리)', String(capturedBudget));

  section('9-d. chargeBilling 은 Idempotency-Key 를 orderId 로 보낸다 (타임아웃 시 재시도 안전)');
  reset(); resetToss();
  const oid_id = 'o_' + Date.now();
  await tossClient.chargeBilling('bk_test', {
    customerKey: 'ck', amount: 4900, orderId: oid_id, orderName: 'x'
  }, oid_id);
  check(toss.charges.length === 1 && toss.charges[0].headers['Idempotency-Key'] === oid_id,
        'orderId 를 Idempotency-Key 로 재사용 ★ (60초 초과로 재요청해도 이중 청구 없음)',
        toss.charges[0].headers['Idempotency-Key']);


  /* ================================================================ *
   *  R1. pending 원장 + orderId 기반 복구
   *
   *  ── 무엇을 막는 테스트인가 ────────────────────────────────────
   *  confirm 은 issueBillingKey(≤15s) + chargeBilling(≤60s) 이라 최악 75초인데
   *  Vercel 함수 상한은 60초다. 상한에서 잘리면 카드에는 청구됐는데 우리 DB 에는
   *  흔적이 없고, 사용자가 다시 시도하면 새 orderId 로 두 번째 청구가 나간다.
   *
   *  주문을 만들 때 pending 행을 먼저 남기고, 재시도 때 토스에 orderId 로
   *  실제 상태를 물어보면 그 경로가 막힌다. 아래가 그 계약이다.
   * ================================================================ */
  section('R1-1. prepare 가 pending 주문을 남긴다');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    const row = payOf(oid);
    check(!!row, '주문 행이 생긴다');
    check(row.status === 'pending', 'status = pending', row && row.status);
    check(row.email === USER, '주문의 주인이 기록된다');
    check(row.amount === billing.PRO_PRICE, '금액이 서버 상수로 박힌다', String(row && row.amount));
    check(!!row.created_at && !!row.updated_at, '생성/수정 시각이 남는다');
    check(row.payment_key === billing.placeholderPaymentKey(oid),
          'payment_key 는 확정 전까지 자리표시자', row && row.payment_key);
    check(toss.charges.length === 0, 'prepare 단계에서는 아무것도 청구하지 않는다 ★');
  }

  section('R1-2. 정상 결제 — pending → paid');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    check(res.payload && res.payload.ok === true, '결제 확정', String(res.code));
    check(payOf(oid).status === 'paid', 'status = paid', payOf(oid).status);
    check(payOf(oid).payment_key === 'pk_' + oid, '진짜 paymentKey 로 갈아끼운다');
    check(subOf(USER) && subOf(USER).plan === 'pro', 'PRO 활성화');
  }

  section('R1-3. 승인 실패 — pending → failed, PRO 없음');
  reset(); resetToss(); toss.failCharge = true;
  {
    const oid = await prepared(USER);
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    check(res.code === 402, '402 반환', String(res.code));
    check(payOf(oid).status === 'failed', 'status = failed', payOf(oid).status);
    check(!subOf(USER), 'PRO 부여 안 됨 ★');
  }

  section('R1-4. 승인 timeout — failed 로 굳히지 않는다 (이중 청구 방지) ★');
  /*
   * 타임아웃은 거절이 아니라 "모름" 이다. 청구가 됐을 수도 있다.
   * failed 로 굳히면 그 주문은 종착역이 되고, 사용자가 새 주문으로 다시
   * 결제하는 순간 이중 청구가 된다. charging 으로 두어야 다음 요청이
   * 토스에 실제 상태를 물어볼 수 있다.
   */
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    const orig = global.fetch;
    global.fetch = async (url, opts) => {
      if (/\/v1\/billing\/[^/]+$/.test(String(url))) {
        const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e;
      }
      return orig(url, opts);
    };
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    global.fetch = orig;
    check(res.code === 504, 'timeout → 504', String(res.code));
    check(payOf(oid).status === 'charging', 'status 는 charging 으로 남는다 ★', payOf(oid).status);
    check(!subOf(USER), 'PRO 부여 안 됨');
  }

  section('R1-5. 승인 직후 DB 확정 실패 — 권한 없음, charging 유지');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    db.failUpdateStatus = 'paid';
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    db.failUpdateStatus = '';
    check(res.code === 500, '기록 실패 → 500', String(res.code));
    check(!subOf(USER), '기록 못 남기면 PRO 없음 ★');
    check(payOf(oid).status === 'charging', '복구할 수 있게 charging 으로 남는다', payOf(oid).status);
  }

  section('R1-6. pending 결제 복구 — 재승인 없이 확정 ★');
  /*
   * R1-4 가 만든 상태(charging + 토스에는 승인 완료)를 그대로 재현하고,
   * 사용자가 다시 confirm 을 보냈을 때 어떻게 되는지 본다.
   * 반드시 "다시 긁지 않고" 확정되어야 한다.
   */
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    // 토스 쪽에는 승인이 끝나 있다. 우리 쪽은 결과를 못 받아 charging 이다.
    toss.payments['pk_' + oid] = {
      paymentKey: 'pk_' + oid, orderId: oid, totalAmount: billing.PRO_PRICE, status: 'DONE'
    };
    await billing.claimForCharge(oid);
    check(payOf(oid).status === 'charging', '전제: charging 상태');

    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    check(res.payload && res.payload.ok === true, '복구되어 결제 확정', String(res.code));
    check(toss.charges.length === 0, '재승인 요청이 나가지 않았다 ★ (이중 청구 없음)',
          String(toss.charges.length));
    check(payOf(oid).status === 'paid', 'status = paid', payOf(oid).status);
    check(subOf(USER) && subOf(USER).plan === 'pro', 'PRO 활성화');
  }

  section('R1-7. charging 인데 토스에 결제가 없으면 — 실패로 확정');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    await billing.claimForCharge(oid);   // 토스에는 아무것도 없다
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    check(res.code === 409, '409 반환', String(res.code));
    check(payOf(oid).status === 'failed', '청구되지 않았으므로 failed', payOf(oid).status);
    check(!subOf(USER), 'PRO 없음');
  }

  section('R1-8. charging 인데 토스 조회가 실패하면 — 상태를 굳히지 않는다');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    await billing.claimForCharge(oid);
    toss.failLookup = true;
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    toss.failLookup = false;
    check(res.code === 503, '503 — 나중에 다시 확인', String(res.code));
    check(payOf(oid).status === 'charging', 'charging 유지 ★ (모르는 것을 실패로 굳히지 않는다)',
          payOf(oid).status);
  }

  section('R1-9. 존재하지 않는 orderId');
  reset(); resetToss();
  {
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER,
      { authKey: 'ak', orderId: 'seosa_does_not_exist_0000' });
    check(res.code === 404, '404 ORDER_NOT_FOUND ★', String(res.code));
    check(toss.charges.length === 0, '토스를 부르지 않는다 ★');
    check(!subOf(USER), 'PRO 없음');
  }

  section('R1-10. 사용자 불일치 — 남의 주문으로 결제할 수 없다 ★');
  reset(); resetToss();
  {
    const oid = await prepared(USER);          // USER 가 만든 주문
    res = mkRes();
    await payment.handleConfirm(reqFor(OTHER, {}, 'confirm'), res, OTHER, { authKey: 'ak', orderId: oid });
    check(res.code === 403, '403 ORDER_OWNER_MISMATCH', String(res.code));
    check(toss.charges.length === 0, '토스를 부르지 않는다');
    check(!subOf(OTHER), '남의 주문으로 PRO 를 받지 못한다 ★');
    check(payOf(oid).status === 'pending', '원래 주문은 그대로', payOf(oid).status);
  }

  section('R1-11. 금액 불일치 — 원장 금액이 서버 상수와 다르면 거절');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    payOf(oid).amount = 100;                   // 원장이 오염된 상황을 흉내 낸다
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    check(res.code === 409, '409 ORDER_AMOUNT_MISMATCH', String(res.code));
    check(toss.charges.length === 0, '토스를 부르지 않는다 ★');
    check(!subOf(USER), 'PRO 없음');
  }

  section('R1-12. 잘못된 상태 전이는 거부한다');
  check(billing.canTransition('pending', 'charging'), 'pending → charging 허용');
  check(billing.canTransition('charging', 'paid'), 'charging → paid 허용');
  check(billing.canTransition('charging', 'failed'), 'charging → failed 허용');
  check(billing.canTransition('paid', 'canceled'), 'paid → canceled 허용');
  check(!billing.canTransition('paid', 'pending'), 'paid → pending 금지 ★');
  check(!billing.canTransition('paid', 'charging'), 'paid → charging 금지 ★');
  check(!billing.canTransition('failed', 'paid'), 'failed → paid 금지 ★');
  check(!billing.canTransition('canceled', 'paid'), 'canceled → paid 금지 ★');
  check(!billing.canTransition('pending', 'paid'), 'pending → paid 직행 금지 (charging 을 거쳐야 한다)');

  section('R1-13. 이미 paid 인 주문은 다시 긁지 않는다');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), mkRes(), USER, { authKey: 'ak', orderId: oid });
    const chargesAfterFirst = toss.charges.length;
    const expAfterFirst = subOf(USER).expires_at;

    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    check(res.code === 200 && res.payload.alreadyProcessed === true, '200 + alreadyProcessed');
    check(toss.charges.length === chargesAfterFirst, '추가 승인 없음 ★');
    check(subOf(USER).expires_at === expAfterFirst, 'PRO 기간이 두 번 늘지 않는다 ★');
  }

  section('R1-14. 실패로 끝난 주문은 되살릴 수 없다');
  reset(); resetToss(); toss.failCharge = true;
  {
    const oid = await prepared(USER);
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), mkRes(), USER, { authKey: 'ak', orderId: oid });
    toss.failCharge = false;                   // 이제 카드가 살아났다고 해도
    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    check(res.code === 409, '409 ORDER_NOT_PAYABLE ★', String(res.code));
    check(toss.charges.length === 0, '토스를 부르지 않는다');
    check(!subOf(USER), 'PRO 없음');
  }

  section('R1-15. 같은 paymentKey 가 이미 다른 행에 있으면 (웹훅 선행)');
  /*
   * 웹훅이 confirm 보다 먼저 도착해 결제를 확정한 경우. 우리 쪽 confirm 은
   * 기간을 또 늘리지 않고 "이미 처리됨" 으로 끝나야 한다.
   */
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    await billing.claimForCharge(oid);
    toss.payments['pk_' + oid] = {
      paymentKey: 'pk_' + oid, orderId: oid, totalAmount: billing.PRO_PRICE, status: 'DONE'
    };
    // 웹훅이 먼저 확정했다고 치고 원장을 paid 로 만들어 둔다.
    await billing.markPaid(oid, { paymentKey: 'pk_' + oid, amount: billing.PRO_PRICE, rawStatus: 'DONE' });
    await billing.activatePro(USER, { customerKey: billing.customerKeyFor(USER) });
    const expAfterWebhook = subOf(USER).expires_at;

    res = mkRes();
    await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
    check(res.code === 200 && res.payload.alreadyProcessed === true, '200 + alreadyProcessed', String(res.code));
    check(subOf(USER).expires_at === expAfterWebhook, 'PRO 기간이 두 번 늘지 않는다 ★');
  }

  /* ================================================================ *
   *  R2. 미결 주문 자동 정리 (sweepStalePayments) — 신규 가입 결제용
   *
   *  ── 무엇을 막는 테스트인가 ────────────────────────────────────
   *  R1-4 는 "사용자가 다시 confirm 을 보내면" 복구되는 것을 확인했다.
   *  R2 는 "사용자가 다시 안 와도" 서버가 스스로 정리하는지를 확인한다 —
   *  charging 이 오래 남았는데 아무도 다시 확인하지 않으면 카드는 청구됐는데
   *  PRO 는 영원히 못 받는 상태가 방치될 수 있다.
   * ================================================================ */
  function age(orderId, msAgo) {
    const t = new Date(Date.now() - msAgo).toISOString();
    const row = payOf(orderId);
    row.created_at = t;
    row.updated_at = t;
  }

  section('R2-1. 갓 생긴 charging 은 건드리지 않는다 (아직 정상 처리 중일 수 있다)');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    await billing.claimForCharge(oid);   // 방금 선점 — 아직 정상 흐름일 수 있다
    const r = await billing.sweepStalePayments();
    check(r.checkedCharging === 0, '오래되지 않은 charging 은 조회 대상에서 빠진다', String(r.checkedCharging));
    check(payOf(oid).status === 'charging', '상태 그대로', payOf(oid).status);
    check(toss.charges.length === 0, '토스를 부르지 않는다');
  }

  section('R2-2. 오래된 charging + 토스에는 이미 승인됨 → 재승인 없이 복구 ★');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    toss.payments['pk_' + oid] = {
      paymentKey: 'pk_' + oid, orderId: oid, totalAmount: billing.PRO_PRICE, status: 'DONE'
    };
    await billing.claimForCharge(oid);
    age(oid, billing.STALE_CHARGING_MS + 1000);   // confirm 이 60초 컷에 잘리고 사용자가 다시 안 온 상황

    const r = await billing.sweepStalePayments();
    check(r.checkedCharging === 1, '오래된 charging 1건을 찾는다', String(r.checkedCharging));
    check(r.paid === 1 && r.failed === 0 && r.unresolved === 0, '복구(paid) 1건', JSON.stringify(r));
    check(toss.charges.length === 0, '재승인 요청이 나가지 않았다 ★ (이중 청구 없음)', String(toss.charges.length));
    check(payOf(oid).status === 'paid', 'status = paid', payOf(oid).status);
    check(subOf(USER) && subOf(USER).plan === 'pro', 'PRO 활성화 — 사용자가 재방문하지 않아도 ★');
  }

  section('R2-3. 오래된 charging + 토스에는 결제가 없음(404) → 실패로 확정, PRO 없음');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    await billing.claimForCharge(oid);   // 토스에는 아무것도 만들지 않는다
    age(oid, billing.STALE_CHARGING_MS + 1000);

    const r = await billing.sweepStalePayments();
    check(r.failed === 1, '실패로 확정 1건', JSON.stringify(r));
    check(payOf(oid).status === 'failed', 'status = failed', payOf(oid).status);
    check(!subOf(USER), 'PRO 없음 ★');
  }

  section('R2-4. 오래된 charging + 토스 조회 자체가 실패 → 여전히 "모름", failed 로 굳히지 않는다 ★');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    await billing.claimForCharge(oid);
    age(oid, billing.STALE_CHARGING_MS + 1000);
    toss.failLookup = true;

    const r = await billing.sweepStalePayments();
    toss.failLookup = false;
    check(r.unresolved === 1, '보류(unresolved) 1건 — 다음 실행에 다시 확인', JSON.stringify(r));
    check(payOf(oid).status === 'charging', 'charging 유지 ★ (모르는 것을 실패로 굳히지 않는다)',
          payOf(oid).status);
    check(!subOf(USER), 'PRO 없음');
  }

  section('R2-5. 이미 다른 경로(사용자 재확인/웹훅)가 먼저 확정했으면 중복 반영 없음 ★');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    toss.payments['pk_' + oid] = {
      paymentKey: 'pk_' + oid, orderId: oid, totalAmount: billing.PRO_PRICE, status: 'DONE'
    };
    await billing.claimForCharge(oid);
    // 스윕이 토스를 조회하는 사이에 다른 경로가 이미 paid 로 확정했다고 가정한다.
    await billing.markPaid(oid, { paymentKey: 'pk_' + oid, amount: billing.PRO_PRICE, rawStatus: 'DONE' });
    await billing.activatePro(USER, { customerKey: billing.customerKeyFor(USER) });
    const expBefore = subOf(USER).expires_at;

    const row = payOf(oid);
    const outcome = await billing.resolveStaleCharging(row, tossClient);
    check(outcome.outcome === 'failed' && outcome.reason === '이미 처리됨',
          'markPaid 가 0행 갱신 → "이미 처리됨"으로 조용히 끝난다', JSON.stringify(outcome));
    check(subOf(USER).expires_at === expBefore, 'PRO 기간이 두 번 늘지 않는다 ★');
  }

  section('R2-6. 방치된 pending(카드 등록조차 안 함) — 토스를 부르지 않고 바로 만료 ★');
  reset(); resetToss();
  {
    const oid = await prepared(USER);   // claimForCharge 를 부르지 않는다 — 실제로 아무 청구도 없었다
    age(oid, billing.STALE_PENDING_MS + 1000);

    const r = await billing.sweepStalePayments();
    check(r.expiredPending === 1, '방치된 pending 1건 만료', JSON.stringify(r));
    check(payOf(oid).status === 'failed', 'status = failed', payOf(oid).status);
    check(toss.charges.length === 0 && toss.lastHeaders === null, '토스에 아무 요청도 보내지 않는다 ★');
    check(!subOf(USER), 'PRO 없음');
  }

  section('R2-7. 24시간이 안 지난 pending 은 그대로 둔다 (아직 결제 중일 수 있다)');
  reset(); resetToss();
  {
    const oid = await prepared(USER);
    age(oid, billing.STALE_PENDING_MS - 60000);   // 1분 부족

    const r = await billing.sweepStalePayments();
    check(r.expiredPending === 0, '아직 만료 대상이 아니다', String(r.expiredPending));
    check(payOf(oid).status === 'pending', '상태 그대로', payOf(oid).status);
  }

  section('R2-8. 자동갱신 배치(renewOne)와 같은 실행에서 만나도 충돌 없음 ★');
  /*
   * 갱신 주문이 confirm 과 같은 이유로 charging 에 멈춘 경우를 흉내 낸다.
   * /api/cron 은 renewDueSubscriptions 를 먼저 돌리고 sweepStalePayments 를
   * 그 다음에 돌린다 — settleOutstandingCharge 가 먼저 정리했다면 이 배치가
   * 볼 때는 이미 charging 이 아니어야 한다.
   */
  reset(); resetToss();
  {
    // 갱신 대상 구독을 하나 만든다.
    const soon = new Date(Date.now() + 86400000).toISOString();  // 내일 만료 → 갱신창 안
    db.subscriptions.push({
      email: USER, plan: 'pro', status: 'active', expires_at: soon,
      billing_key: 'bk_existing', customer_key: billing.customerKeyFor(USER), renew_failures: 0
    });
    const renewOid = billing.createOrderId();
    await billing.createPendingPayment({ email: USER, orderId: renewOid, amount: billing.PRO_PRICE });
    await billing.claimForCharge(renewOid);
    toss.payments['pk_' + renewOid] = {
      paymentKey: 'pk_' + renewOid, orderId: renewOid, totalAmount: billing.PRO_PRICE, status: 'DONE'
    };
    age(renewOid, billing.STALE_CHARGING_MS + 1000);

    // 1) 갱신 배치가 먼저 정리한다 (renewOne 내부의 settleOutstandingCharge).
    const renewal = await billing.renewDueSubscriptions();
    check(payOf(renewOid).status === 'paid', '갱신 배치가 먼저 charging 을 정리한다', payOf(renewOid).status);

    // 2) 그 다음 스윕이 같은 orderId 를 봐도 이미 charging 이 아니라 건드리지 않는다.
    const sweepAfter = await billing.sweepStalePayments();
    check(sweepAfter.checkedCharging === 0, '스윕이 이중으로 처리하지 않는다 ★', String(sweepAfter.checkedCharging));
    check(toss.charges.length === 0, '어느 쪽도 재승인하지 않았다 ★', String(toss.charges.length));
  }

  /* ================================================================ *
   *  10. 정적 보안 검사
   * ================================================================ */
  section('10. 정적 보안 검사');
  const fs = require('fs');
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const front = read('public/index.html');
  const payApi = read('api/payment.js');
  const billSrc = read('api/_billing.js');
  const tossSrc = read('api/_toss.js');

  check(front.indexOf('TOSS_SECRET_KEY') === -1, '프론트에 TOSS_SECRET_KEY 없음 ★');
  check(!/sk_(live|test)_[A-Za-z0-9]{10,}/.test(front), '프론트에 시크릿 키 값 없음 ★');
  check(front.indexOf('secretKey') === -1, '프론트에 secretKey 참조 없음');
  check(/clientKey/.test(front), '프론트는 clientKey(공개 키)만 쓴다');

  check(!/cardNumber|cvc|cardPassword|expiry/i.test(billSrc + payApi),
        '카드번호/CVC 를 다루는 코드 없음 ★');
  check(!/body\.amount|body\.price/.test(payApi), 'body 의 amount 를 읽지 않음 ★');
  check(!/body\.plan/.test(payApi), 'body 의 plan 을 읽지 않음 ★');
  check(!/body\.email/.test(payApi), 'body 의 email 을 읽지 않음 ★');
  check(/identify\(req\)/.test(payApi), '신원은 토큰에서만');
  check(/PRO_PRICE\s*=\s*4900/.test(billSrc), '금액은 서버 상수');
  check(/process\.env\.TOSS_SECRET_KEY/.test(tossSrc), '시크릿 키는 환경변수에서만');
  check(!/sk_live_|sk_test_[A-Za-z0-9]{20,}/.test(tossSrc), '소스에 실제 키 값 없음');

  section('10-b. 웹훅 검증 방식');
  check(/getPayment\(paymentKey\)/.test(payApi),
        '웹훅 본문을 믿지 않고 토스에 재조회한다 ★ (결제 웹훅에는 서명이 없다)');

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
  global.fetch = realFetch;
})().catch(e => {
  console.error('오류:', e.message, e.stack);
  process.exit(1);
});
