'use strict';
/*
 * PRO 구독 — 결제 검증과 권한 부여.
 *
 * ── 절대 규칙 ───────────────────────────────────────────────────────
 *   1. 금액은 서버가 정한다. 프론트가 보낸 amount 는 쳐다보지도 않는다.
 *   2. 신원은 인증 토큰에서만 온다. body 의 email 은 신뢰하지 않는다.
 *   3. "결제 성공했어요" 라는 프론트의 말로 PRO 를 주지 않는다.
 *      반드시 토스 API 응답(또는 재조회)으로 status=DONE 과 금액을 확인한다.
 *   4. 같은 결제가 두 번 반영되지 않는다 (order_id / payment_key UNIQUE).
 *
 * ── 왜 이렇게까지 하나 ──────────────────────────────────────────────
 * 결제는 되돌리기가 가장 비싼 도메인이다. 잘못 주면 매출이 새고, 잘못 안 주면
 * 사용자가 돈을 내고도 못 쓴다. 그래서 "확실할 때만 준다"(fail closed)로 통일한다.
 */

const crypto = require('crypto');
const supabase = require('./_supabase');
const toss = require('./_toss');

/* ── 상품 정의 — 값은 여기에서만 정한다 ──────────────────────────── */

/** PRO 월 구독가(원). 서버 고정값. 프론트/요청 body 에서 절대 받지 않는다. */
const PRO_PRICE = 4900;
const CURRENCY = 'KRW';
const ORDER_NAME = 'SEOSA PRO 구독 (1개월)';
const PROVIDER = 'toss';

/** 1회 결제로 늘어나는 구독 기간(일). */
const PERIOD_DAYS = 30;

const PAYMENT_STATUS = {
  PAID: 'paid',
  FAILED: 'failed',
  CANCELED: 'canceled'
};

/* ── 식별자 ──────────────────────────────────────────────────────── */

/**
 * 토스에 보낼 고객 식별자.
 *
 * 이메일을 그대로 보내지 않는다. customerKey 는 결제사에 저장되고 로그·대시보드에
 * 남는데, 거기에 사용자 이메일을 그대로 흘릴 이유가 없다. 같은 사용자가 항상 같은
 * 값을 갖도록 이메일에서 결정적으로 파생하되, 값만 보고 이메일을 되돌릴 수는 없게 한다.
 *
 * 서명 키는 AUTH_SECRET → SUPABASE_SECRET_KEY 순으로 쓴다(_auth.js 와 같은 방식).
 */
function customerKeyFor(email) {
  const base = process.env.AUTH_SECRET || process.env.SUPABASE_SECRET_KEY || '';
  const h = crypto.createHmac('sha256', base).update('seosa-customer-v1:' + String(email).toLowerCase()).digest('hex');
  // 토스 customerKey 규칙(영숫자/-/_ 등)에 안전하게 들어가는 형태로 만든다.
  return 'seosa_' + h.slice(0, 32);
}

/** 주문번호. 토스 규칙상 6~64자. 충돌하면 결제가 거절되므로 난수를 섞는다. */
function createOrderId() {
  return 'seosa_' + Date.now().toString(36) + '_' + crypto.randomBytes(8).toString('hex');
}

/* ── 결제 검증 ───────────────────────────────────────────────────── */

/**
 * 토스가 돌려준 결제 객체가 우리가 기대한 그 결제가 맞는가.
 *
 * @param payment  토스 Payment 객체
 * @param expect   { orderId, amount }
 * @returns {{ok: boolean, reason: string}}
 */
function verifyPayment(payment, expect) {
  if (!payment || typeof payment !== 'object') return { ok: false, reason: '결제 정보 없음' };

  if (payment.status !== toss.STATUS_DONE) {
    return { ok: false, reason: `결제가 완료 상태가 아님(status=${payment.status})` };
  }
  // 금액은 우리가 만든 기대값과 정확히 같아야 한다. 크거나 작으면 둘 다 거절이다.
  if (Number(payment.totalAmount) !== Number(expect.amount)) {
    return { ok: false, reason: `금액 불일치(기대 ${expect.amount} / 실제 ${payment.totalAmount})` };
  }
  if (expect.orderId && String(payment.orderId) !== String(expect.orderId)) {
    return { ok: false, reason: '주문번호 불일치' };
  }
  return { ok: true, reason: '' };
}

/* ── DB ──────────────────────────────────────────────────────────── */

/**
 * 결제 기록을 남긴다. 이미 같은 payment_key 가 있으면 새로 만들지 않는다.
 *
 * payments.payment_key 에 UNIQUE 가 걸려 있어서, 웹훅이 두 번 와도 두 번째
 * insert 는 충돌한다. 그 충돌을 "이미 처리됨"으로 읽어 멱등성을 얻는다.
 *
 * @returns {{ok:boolean, duplicate:boolean, error:string}}
 */
async function recordPayment(row) {
  const { error } = await supabase.from('payments').insert({
    email: row.email,
    order_id: row.orderId,
    payment_key: row.paymentKey,
    amount: row.amount,
    currency: CURRENCY,
    status: row.status,
    provider: PROVIDER,
    raw_status: row.rawStatus || '',
    updated_at: new Date().toISOString()
  });

  if (!error) return { ok: true, duplicate: false, error: '' };

  // 23505 = unique_violation. 같은 결제가 이미 기록되어 있다.
  const dup = error.code === '23505' || /duplicate key|unique/i.test(error.message || '');
  if (dup) return { ok: true, duplicate: true, error: '' };

  return { ok: false, duplicate: false, error: error.message };
}

/** 이 payment_key 가 이미 처리됐는가 (웹훅 재전송 대비 선제 확인). */
async function alreadyProcessed(paymentKey) {
  const { data, error } = await supabase
    .from('payments').select('payment_key, status').eq('payment_key', paymentKey).maybeSingle();
  if (error) return { known: false, error: error.message };
  return { known: !!data, row: data || null, error: '' };
}

/** 이 order_id 가 이미 쓰였는가 (재사용 공격 방어). */
async function orderIdUsed(orderId) {
  const { data, error } = await supabase
    .from('payments').select('order_id').eq('order_id', orderId).maybeSingle();
  if (error) return { used: false, error: error.message };
  return { used: !!data, error: '' };
}

/**
 * PRO 를 켜고 기간을 연장한다.
 *
 * 기간은 "지금부터 30일"이 아니라 "기존 만료일이 남아 있으면 그 뒤로 30일"이다.
 * 그래야 갱신이 하루 일찍 돌아도 사용자가 손해를 보지 않는다.
 *
 * billing_key 는 여기서만 쓰고 어떤 응답에도 싣지 않는다.
 */
async function activatePro(email, { billingKey, customerKey, now = new Date() } = {}) {
  const { data: cur } = await supabase
    .from('subscriptions').select('expires_at').eq('email', email).maybeSingle();

  const curExp = cur && cur.expires_at ? Date.parse(cur.expires_at) : 0;
  const base = Number.isFinite(curExp) && curExp > now.getTime() ? curExp : now.getTime();
  const expiresAt = new Date(base + PERIOD_DAYS * 86400000).toISOString();

  const row = {
    email,
    plan: 'pro',
    status: 'active',
    expires_at: expiresAt,
    provider: PROVIDER,
    updated_at: now.toISOString()
  };
  if (customerKey) row.customer_key = customerKey;
  if (billingKey) row.billing_key = billingKey;

  const { error } = await supabase.from('subscriptions').upsert(row, { onConflict: 'email' });
  if (error) return { ok: false, expiresAt: '', error: error.message };
  return { ok: true, expiresAt, error: '' };
}

/**
 * 구독 취소 — 이미 낸 기간은 그대로 두고 다음 결제만 중단한다.
 *
 * 즉시 FREE 로 떨어뜨리지 않는다. 사용자는 이번 달 요금을 이미 냈다.
 * billing_key 를 지워서 다음 자동결제가 나가지 않게 하고, expires_at 이
 * 지나면 _plan.resolvePlan 이 알아서 FREE 로 판정한다.
 */
async function cancelSubscription(email, now = new Date()) {
  const { data: cur, error: readErr } = await supabase
    .from('subscriptions').select('plan, status, expires_at').eq('email', email).maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!cur || cur.plan !== 'pro') return { ok: false, error: '구독 중이 아닙니다' };

  const { error } = await supabase.from('subscriptions').update({
    // status 는 active 로 둔다 — 남은 기간은 계속 PRO 로 써야 하기 때문이다.
    // 다음 결제를 막는 것은 billing_key 제거다.
    billing_key: null,
    canceled_at: now.toISOString(),
    updated_at: now.toISOString()
  }).eq('email', email);

  if (error) return { ok: false, error: error.message };
  return { ok: true, activeUntil: cur.expires_at || '', error: '' };
}

/** 결제 취소/환불이 확인됐을 때 구독을 내린다. */
async function deactivate(email, now = new Date()) {
  const { error } = await supabase.from('subscriptions').update({
    plan: 'free',
    status: 'inactive',
    billing_key: null,
    updated_at: now.toISOString()
  }).eq('email', email);
  return { ok: !error, error: error ? error.message : '' };
}

/** 서버 전용 값(billing_key 등)을 걷어낸 구독 요약. 프론트로 나가는 모양. */
function publicSubscription(row) {
  if (!row) return { plan: 'free', status: 'active', expiresAt: null, canceled: false };
  return {
    plan: row.plan === 'pro' ? 'pro' : 'free',
    status: row.status || 'active',
    expiresAt: row.expires_at || null,
    // billing_key 가 없으면 다음 결제가 예약되어 있지 않다는 뜻이다.
    canceled: row.plan === 'pro' && !row.billing_key
  };
}

module.exports = {
  PRO_PRICE, CURRENCY, ORDER_NAME, PROVIDER, PERIOD_DAYS, PAYMENT_STATUS,
  customerKeyFor, createOrderId, verifyPayment,
  recordPayment, alreadyProcessed, orderIdUsed,
  activatePro, cancelSubscription, deactivate, publicSubscription
};
