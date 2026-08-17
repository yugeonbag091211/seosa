'use strict';
/*
 * PRO 구독 결제 — 준비 / 확정 / 취소 / 웹훅.
 *
 * ── 왜 엔드포인트 하나에 action 을 두는가 ─────────────────────────
 * Vercel Hobby 는 배포당 서버리스 함수 12개가 상한이고 이 프로젝트는 이미
 * 정확히 12개다. 결제 기능을 파일 4개로 나누면 16개가 되어 배포 자체가 실패한다.
 * 그래서 함수 하나 안에서 action 으로 나눈다 (+1). 자세한 내용은
 * 이 커밋의 보고서와 아래 ROUTES 주석 참고.
 *
 * ── 보안 원칙 ────────────────────────────────────────────────────
 *   · 신원은 Authorization 토큰에서만 (body 의 email 무시)
 *   · 금액은 서버 상수 (body 의 amount 무시)
 *   · plan 은 결제 검증 결과로만 바뀐다 (body 의 plan 무시)
 *   · "결제 성공했다"는 프론트 주장으로 권한을 주지 않는다.
 *     반드시 토스 API 응답/재조회로 status=DONE + 금액을 확인한다.
 *
 * ROUTES  (POST /api/payment?action=…)
 *   prepare  로그인 사용자에게 orderId·customerKey·clientKey·금액을 발급
 *   confirm  카드 등록(authKey) → 빌링키 발급 → 첫 결제 승인 → 검증 → PRO
 *   cancel   구독 취소 (이미 결제된 기간은 유지, 다음 결제만 중단)
 *   status   현재 구독 상태 조회
 *   webhook  토스 웹훅 수신 (인증 없음 — 대신 결제를 재조회해서 검증)
 */

const { readBody, applyCors, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { identify } = require('./_auth');
const supabase = require('./_supabase');
const toss = require('./_toss');
const billing = require('./_billing');

/* ------------------------------------------------------------------ *
 *  prepare — 결제창을 열기 전에 서버가 값을 정한다
 * ------------------------------------------------------------------ */
async function handlePrepare(req, res, email) {
  if (!toss.isConfigured()) {
    return res.status(503).json({
      error: 'PAYMENT_NOT_CONFIGURED',
      message: '결제가 아직 준비 중이에요.'
    });
  }

  /*
   * ★ 결제위젯 키(test_gck_ / live_gck_)가 설정되어 있으면 여기서 잘라 낸다.
   *
   * 우리 프론트는 tp.payment({customerKey}) 를 부르는데, 이 API 에 위젯용 client
   * key 를 넣으면 SDK 가 동기 throw 한다 ("API 개별 연동 키의 클라이언트 키로
   * SDK를 연동해주세요. 결제위젯 연동 키는 지원하지 않습니다."). 그 예외는 프론트
   * try/catch 에서 잡혀 "결제창을 열지 못했어요." 라는 뭉뚱그린 안내로 나가서
   * 운영자가 원인을 알아채기 어렵다.
   *
   * 서버가 미리 감지해 정확한 코드/메시지로 거절하면 SDK 는 초기화 자체가 안
   * 되고, 프론트는 서버가 준 message 를 그대로 토스트로 띄운다.
   *
   * ※ 이 판정은 우회로가 아니다. 키가 잘못됐으니 결제를 시도조차 하지 않는다
   *   ("확실할 때만 준다" — _billing.js 원칙과 같은 방향).
   */
  if (toss.isWidgetClientKey()) {
    console.error(
      '[payment] TOSS_CLIENT_KEY 가 "결제위젯" 유형입니다 (test_gck_/live_gck_). ' +
      '우리 프론트는 "API 개별 연동" 방식(tp.payment)만 지원하므로, ' +
      'Toss 콘솔에서 "결제 > API 개별 연동" 섹션의 test_ck_/live_ck_ 키로 교체해 주세요. ' +
      (toss.isWidgetSecretKey()
        ? '★ TOSS_SECRET_KEY 도 위젯용(gsk)입니다. 두 키를 함께 교체하세요.'
        : '')
    );
    return res.status(503).json({
      error: 'PAYMENT_KEY_WRONG_TYPE',
      message: '결제 키 설정이 올바르지 않아요. 관리자에게 문의해 주세요.'
    });
  }

  /*
   * orderId·customerKey·amount 를 전부 서버가 만든다.
   * 프론트는 이 값을 그대로 결제창에 넘기기만 한다. 프론트가 만든 값을 쓰면
   * 금액이나 주문번호를 마음대로 바꿀 수 있다.
   */
  return res.json({
    clientKey: toss.clientKey(),          // 공개 키 — 노출되어도 되는 값
    customerKey: billing.customerKeyFor(email),
    orderId: billing.createOrderId(),
    orderName: billing.ORDER_NAME,
    amount: billing.PRO_PRICE,
    testMode: toss.isTestKey()
  });
}

/* ------------------------------------------------------------------ *
 *  confirm — 카드 등록 결과를 받아 실제로 결제하고 검증한다
 * ------------------------------------------------------------------ */
async function handleConfirm(req, res, email, body) {
  if (!toss.isConfigured()) {
    return res.status(503).json({ error: 'PAYMENT_NOT_CONFIGURED', message: '결제가 아직 준비 중이에요.' });
  }

  const authKey = String(body.authKey || '').trim();
  const orderId = String(body.orderId || '').trim();
  if (!authKey || !orderId) return res.status(400).json({ error: '결제 정보가 부족해요.' });

  /*
   * customerKey 는 프론트가 보낸 값을 쓰지 않고 토큰의 이메일에서 다시 만든다.
   * 프론트 값을 그대로 쓰면 남의 customerKey 를 보내 그 사람 카드로 결제하거나
   * 남의 구독을 자기 것으로 붙일 수 있다.
   */
  const customerKey = billing.customerKeyFor(email);

  // 주문번호 재사용 방어 — 이미 결제에 쓰인 orderId 면 거절한다.
  const used = await billing.orderIdUsed(orderId);
  if (used.error) {
    console.error('[payment] orderId 확인 실패:', used.error);
    return res.status(503).json({ error: '결제 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
  if (used.used) return res.status(409).json({ error: 'ORDER_ALREADY_USED', message: '이미 처리된 주문이에요.' });

  // 1) authKey → billingKey
  const issued = await toss.issueBillingKey(authKey, customerKey);
  if (!issued.ok) {
    console.error('[payment] 빌링키 발급 실패:', issued.error);
    return res.status(402).json({ error: 'BILLING_KEY_FAILED', message: '카드 등록에 실패했어요.' });
  }
  const billingKey = issued.data.billingKey;
  if (!billingKey) return res.status(502).json({ error: 'BILLING_KEY_MISSING', message: '카드 등록에 실패했어요.' });

  // 2) 실제 결제 — 금액은 서버 상수. 멱등키로 중복 승인을 막는다.
  const charged = await toss.chargeBilling(billingKey, {
    customerKey,
    amount: billing.PRO_PRICE,
    orderId,
    orderName: billing.ORDER_NAME
  }, orderId);   // orderId 를 멱등키로 재사용 — 같은 주문은 한 번만 승인된다

  if (!charged.ok) {
    console.error('[payment] 결제 승인 실패:', charged.error);
    await billing.recordPayment({
      email, orderId, paymentKey: 'failed_' + orderId,
      amount: billing.PRO_PRICE, status: billing.PAYMENT_STATUS.FAILED,
      rawStatus: charged.error.slice(0, 100)
    });
    return res.status(402).json({ error: 'PAYMENT_FAILED', message: '결제에 실패했어요. 카드사 정보를 확인해 주세요.' });
  }

  // 3) 검증 — 여기를 통과해야만 PRO 가 된다.
  const payment = charged.data;
  const verdict = billing.verifyPayment(payment, { orderId, amount: billing.PRO_PRICE });
  if (!verdict.ok) {
    console.error('[payment] 결제 검증 실패:', verdict.reason);
    return res.status(402).json({ error: 'PAYMENT_VERIFICATION_FAILED', message: '결제를 확인하지 못했어요.' });
  }

  // 4) 기록 (멱등) → 5) PRO 활성화
  const rec = await billing.recordPayment({
    email, orderId, paymentKey: payment.paymentKey,
    amount: payment.totalAmount, status: billing.PAYMENT_STATUS.PAID,
    rawStatus: payment.status
  });
  if (!rec.ok) {
    // DB 에 못 남겼으면 권한도 주지 않는다. 결제는 됐는데 기록이 없으면
    // 나중에 환불·정산 대조가 불가능해진다. 로그로 크게 남긴다.
    console.error(`[payment] ★ 결제는 승인됐으나 기록 실패 — 수동 확인 필요 orderId=${orderId} paymentKey=${payment.paymentKey}: ${rec.error}`);
    return res.status(500).json({ error: 'PAYMENT_RECORD_FAILED', message: '결제는 되었지만 처리 중 문제가 생겼어요. 고객센터로 문의해 주세요.' });
  }
  if (rec.duplicate) {
    return res.status(409).json({ error: 'ALREADY_PROCESSED', message: '이미 처리된 결제예요.' });
  }

  const act = await billing.activatePro(email, { billingKey, customerKey });
  if (!act.ok) {
    console.error(`[payment] ★ PRO 활성화 실패 — 수동 확인 필요 orderId=${orderId}: ${act.error}`);
    return res.status(500).json({ error: 'ACTIVATION_FAILED', message: '결제는 되었지만 처리 중 문제가 생겼어요. 고객센터로 문의해 주세요.' });
  }

  // billingKey / paymentKey 는 응답에 싣지 않는다.
  return res.json({
    ok: true,
    subscription: { plan: 'pro', status: 'active', expiresAt: act.expiresAt, canceled: false }
  });
}

/* ------------------------------------------------------------------ *
 *  cancel — 다음 결제만 중단. 이미 낸 기간은 그대로 쓴다.
 * ------------------------------------------------------------------ */
async function handleCancel(req, res, email) {
  const r = await billing.cancelSubscription(email);
  if (!r.ok) return res.status(400).json({ error: r.error || '구독을 취소하지 못했어요.' });
  return res.json({
    ok: true,
    message: '구독이 취소됐어요. 남은 기간까지는 PRO 를 계속 이용할 수 있어요.',
    activeUntil: r.activeUntil
  });
}

/* ------------------------------------------------------------------ *
 *  status — 현재 구독 상태
 * ------------------------------------------------------------------ */
async function handleStatus(req, res, email) {
  const { data, error } = await supabase
    .from('subscriptions').select('plan, status, expires_at, billing_key').eq('email', email).maybeSingle();
  if (error) {
    console.warn('[payment] 구독 조회 실패:', error.message);
    return res.json({ subscription: billing.publicSubscription(null), paymentReady: toss.isConfigured() });
  }
  return res.json({
    subscription: billing.publicSubscription(data),
    price: billing.PRO_PRICE,
    paymentReady: toss.isConfigured()
  });
}

/* ------------------------------------------------------------------ *
 *  webhook — 토스가 보내는 결제 상태 변경 알림
 *
 *  ★ 토스는 결제 웹훅에 서명을 넣지 않는다.
 *    tosspayments-webhook-signature 헤더는 payout.changed / seller.changed
 *    전용이다. 그래서 본문을 믿으면 안 된다 — 누구나 이 URL 로
 *    "결제 성공했어요" 라고 POST 할 수 있기 때문이다.
 *
 *    대신 본문에서 paymentKey 만 꺼내 토스 API 로 실제 상태를 다시 조회한다.
 *    위조된 webhook 은 조회 단계에서 걸러진다.
 * ------------------------------------------------------------------ */
async function handleWebhook(req, res, body) {
  const eventType = String(body.eventType || '');
  const data = body.data || {};
  const paymentKey = String(data.paymentKey || '').trim();
  const orderId = String(data.orderId || '').trim();

  // 토스는 2xx 를 받지 못하면 재전송한다. 처리할 수 없는 이벤트도 200 으로
  // 받아 두어야 무한 재전송이 생기지 않는다.
  if (!paymentKey) {
    console.log(`[payment:webhook] paymentKey 없는 이벤트 무시: ${eventType}`);
    return res.status(200).json({ received: true });
  }

  // 1) 본문을 믿지 않고 실제 결제를 조회한다.
  const looked = await toss.getPayment(paymentKey);
  if (!looked.ok) {
    console.warn(`[payment:webhook] 결제 조회 실패(위조이거나 일시 오류) paymentKey=${paymentKey}: ${looked.error}`);
    // 위조라면 200 으로 끝내는 게 맞고, 일시 오류라면 재전송이 필요하다.
    // 조회 자체가 안 된 것이므로 재전송을 받도록 5xx 를 준다.
    return res.status(502).json({ received: false });
  }
  const payment = looked.data;

  // 2) 이미 처리한 결제인지 (재전송 멱등성)
  const seen = await billing.alreadyProcessed(paymentKey);
  if (seen.error) return res.status(503).json({ received: false });

  const status = String(payment.status || '');

  /*
   * 취소·환불 — 구독을 내린다.
   * (부분취소까지 정교하게 다루지는 않는다. 단건 구독이라 전액 취소가 기본이다)
   */
  if (status === 'CANCELED' || status === 'PARTIAL_CANCELED') {
    const owner = await ownerOfPayment(paymentKey, orderId);
    if (owner) {
      await billing.deactivate(owner);
      await supabase.from('payments')
        .update({ status: billing.PAYMENT_STATUS.CANCELED, raw_status: status, updated_at: new Date().toISOString() })
        .eq('payment_key', paymentKey);
      console.log(`[payment:webhook] 결제 취소 반영 — ${owner}`);
    }
    return res.status(200).json({ received: true });
  }

  if (status !== toss.STATUS_DONE) {
    // 아직 완료가 아니면 아무 권한도 주지 않는다.
    console.log(`[payment:webhook] 완료 상태가 아니라 무시: ${status}`);
    return res.status(200).json({ received: true });
  }

  // 3) 완료 결제인데 우리 기록에 없다 → 소유자를 찾아 반영
  if (seen.known) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  const owner = await ownerOfPayment(paymentKey, orderId);
  if (!owner) {
    console.warn(`[payment:webhook] 소유자를 찾을 수 없는 결제 paymentKey=${paymentKey} orderId=${orderId}`);
    return res.status(200).json({ received: true });
  }

  const verdict = billing.verifyPayment(payment, { orderId: orderId || payment.orderId, amount: billing.PRO_PRICE });
  if (!verdict.ok) {
    console.warn(`[payment:webhook] 검증 실패 — 권한 부여 안 함: ${verdict.reason}`);
    return res.status(200).json({ received: true });
  }

  const rec = await billing.recordPayment({
    email: owner, orderId: payment.orderId, paymentKey,
    amount: payment.totalAmount, status: billing.PAYMENT_STATUS.PAID, rawStatus: status
  });
  if (rec.ok && !rec.duplicate) {
    await billing.activatePro(owner, { customerKey: billing.customerKeyFor(owner) });
    console.log(`[payment:webhook] PRO 활성화 — ${owner}`);
  }
  return res.status(200).json({ received: true });
}

/** 결제의 주인을 찾는다. payments 기록 우선, 없으면 orderId 로 찾는다. */
async function ownerOfPayment(paymentKey, orderId) {
  const byKey = await supabase.from('payments').select('email').eq('payment_key', paymentKey).maybeSingle();
  if (byKey.data && byKey.data.email) return byKey.data.email;
  if (!orderId) return '';
  const byOrder = await supabase.from('payments').select('email').eq('order_id', orderId).maybeSingle();
  return (byOrder.data && byOrder.data.email) || '';
}

/* ------------------------------------------------------------------ *
 *  라우터
 * ------------------------------------------------------------------ */
module.exports = async function handler(req, res) {
  const action = String((req.query && req.query.action) || '').trim();

  /*
   * 웹훅은 토스 서버가 부른다 — 브라우저가 아니다.
   * CORS 를 적용하면 Origin 이 없어서 막힌다. 인증도 없다(대신 결제 재조회로 검증).
   */
  if (action === 'webhook') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원' });
    noStore(res);
    try {
      return await handleWebhook(req, res, readBody(req) || {});
    } catch (e) {
      console.error('[payment:webhook]', e.message);
      return res.status(500).json({ received: false });
    }
  }

  if (!applyCors(req, res, 'private')) return;
  noStore(res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원' });

  // 결제 엔드포인트는 반복 호출로 결제사 API 를 두드릴 수 있으니 좁게 잡는다.
  if (!guard(req, res, { name: 'payment', limit: 20, windowMs: 60 * 1000 })) return;

  // 신원은 토큰에서만. body 의 email 은 보지 않는다.
  const who = identify(req);
  if (!who.ok) return res.status(401).json({ error: who.reason, needsAuth: true });
  const email = who.email;

  const body = readBody(req) || {};

  try {
    if (action === 'prepare') return await handlePrepare(req, res, email);
    if (action === 'confirm') return await handleConfirm(req, res, email, body);
    if (action === 'cancel')  return await handleCancel(req, res, email);
    if (action === 'status')  return await handleStatus(req, res, email);
    return res.status(400).json({ error: '알 수 없는 요청이에요.' });
  } catch (e) {
    console.error('[payment]', e.message);
    return res.status(500).json({ error: '결제 처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
  }
};

// 테스트에서 개별 핸들러를 직접 부를 수 있게 노출한다 (HTTP 계층 없이 검증).
module.exports.handlePrepare = handlePrepare;
module.exports.handleConfirm = handleConfirm;
module.exports.handleCancel = handleCancel;
module.exports.handleWebhook = handleWebhook;
