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
 *  가짜 Supabase — UNIQUE 제약까지 흉내 낸다 (멱등성 테스트의 근거)
 * ------------------------------------------------------------------ */
const db = { subscriptions: [], payments: [], failInsert: false, failSubRead: false };

function reset() {
  db.subscriptions = []; db.payments = [];
  db.failInsert = false; db.failSubRead = false;
}
const subOf = e => db.subscriptions.find(r => r.email === e);

const fakeSupabase = {
  from(table) {
    const eqs = [];
    let patch = null, mode = '';
    const q = {
      select() { return q; },
      eq(c, v) { eqs.push([c, v]); if (mode === 'update') apply(); return q; },
      maybeSingle() {
        if (table === 'subscriptions' && db.failSubRead) {
          return Promise.resolve({ data: null, error: { message: 'db down' } });
        }
        const rows = (db[table] || []).filter(r => eqs.every(([c, v]) => String(r[c]) === String(v)));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      insert(row) {
        if (db.failInsert) return Promise.resolve({ error: { code: 'XX000', message: 'db down' } });
        // UNIQUE (order_id) / UNIQUE (payment_key)
        const dup = (db[table] || []).some(r =>
          r.order_id === row.order_id || r.payment_key === row.payment_key);
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
      update(p) { mode = 'update'; patch = p; return q; }
    };
    function apply() {
      (db[table] || []).forEach(r => {
        if (eqs.every(([c, v]) => String(r[c]) === String(v))) Object.assign(r, patch);
      });
    }
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

(async () => {

  /* ================================================================ *
   *  1. 결제 성공 경로
   * ================================================================ */
  section('1. FREE → PRO 결제 성공');
  reset(); resetToss();
  let res = mkRes();
  const orderId = billing.createOrderId();
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
    { authKey: 'ak', orderId: billing.createOrderId(), amount: 100, price: 100 });
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
    { authKey: 'ak', orderId: billing.createOrderId(), email: USER, plan: 'pro' });
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
    { authKey: 'ak', orderId: billing.createOrderId() });
  check(res.code === 402, '402 반환', String(res.code));
  check(!subOf(USER), 'PRO 부여 안 됨 ★');
  check(db.payments.length === 1 && db.payments[0].status === 'failed', '실패도 기록에 남는다');

  section('4-b. 카드 등록(빌링키) 실패');
  reset(); resetToss(); toss.failIssue = true;
  res = mkRes();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER,
    { authKey: 'bad', orderId: billing.createOrderId() });
  check(res.code === 402 && !subOf(USER), '빌링키 실패 → PRO 없음');

  section('4-c. 결제사 장애 (fail closed)');
  reset(); resetToss();
  const origFetch = global.fetch;
  global.fetch = async () => { throw Object.assign(new Error('network'), { name: 'TypeError' }); };
  res = mkRes();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER,
    { authKey: 'ak', orderId: billing.createOrderId() });
  global.fetch = origFetch;
  check(!subOf(USER), '결제사 연결 실패 → PRO 없음 ★');

  section('4-d. DB 장애 (fail closed)');
  reset(); resetToss(); db.failInsert = true;
  res = mkRes();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER,
    { authKey: 'ak', orderId: billing.createOrderId() });
  check(res.code === 500, '기록 실패 → 500', String(res.code));
  check(!subOf(USER), '기록을 못 남기면 PRO 도 주지 않는다 ★');

  /* ================================================================ *
   *  5. 멱등성
   * ================================================================ */
  section('5. orderId 재사용 거절');
  reset(); resetToss();
  const oid = billing.createOrderId();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), mkRes(), USER, { authKey: 'ak', orderId: oid });
  res = mkRes();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), res, USER, { authKey: 'ak', orderId: oid });
  check(res.code === 409, '같은 orderId 두 번째 → 409 ★', String(res.code));
  check(db.payments.length === 1, '결제 기록은 1건뿐', String(db.payments.length));

  section('5-b. 동시 결제 요청');
  reset(); resetToss();
  const sameOrder = billing.createOrderId();
  const rs = await Promise.all([1, 2, 3].map(() => {
    const r = mkRes();
    return payment.handleConfirm(reqFor(USER, {}, 'confirm'), r, USER,
      { authKey: 'ak', orderId: sameOrder }).then(() => r);
  }));
  const okCount = rs.filter(r => r.payload && r.payload.ok).length;
  check(db.payments.length === 1, '동시 3건이어도 결제 기록 1건 ★', String(db.payments.length));
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
  const oid2 = billing.createOrderId();
  await payment.handleConfirm(reqFor(USER, {}, 'confirm'), mkRes(), USER, { authKey: 'ak', orderId: oid2 });
  const pk2 = 'pk_' + oid2;
  const before = db.payments.length;
  await payment.handleWebhook({}, mkRes(), { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: pk2, orderId: oid2 } });
  await payment.handleWebhook({}, mkRes(), { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: pk2, orderId: oid2 } });
  check(db.payments.length === before, '같은 웹훅 2회 → 기록 증가 없음 ★',
        `${before} → ${db.payments.length}`);

  section('6-c. 취소 웹훅 → 구독 해제');
  reset(); resetToss();
  const oid3 = billing.createOrderId();
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
    { authKey: 'ak', orderId: billing.createOrderId() });
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
