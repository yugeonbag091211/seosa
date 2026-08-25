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
   * ★ test 키와 live 키가 섞여 있으면 결제를 시작조차 하지 않는다.
   *
   * client=test / secret=live 조합이 특히 위험하다 — 결제창은 테스트처럼
   * 보이는데 서버 승인은 운영으로 나가서, "테스트 중" 이라고 생각하는 사이
   * 실제 카드에 청구된다. 반대 조합은 사용자가 결제한 줄 아는데 정산이 없다.
   * 둘 다 되돌리기가 비싸므로 확실할 때만 연다 (fail closed).
   */
  if (toss.isMixedKeyEnv()) {
    const s = toss.keySummary();   // 키 값이 아니라 환경/유형만 담긴 요약
    console.error(
      `[payment] ★ TOSS 키 환경이 섞여 있습니다 — client=${s.client.env} / secret=${s.secret.env}. ` +
      'TOSS_CLIENT_KEY 와 TOSS_SECRET_KEY 는 반드시 같은 환경(둘 다 test_ 또는 둘 다 live_)이어야 합니다. ' +
      '섞이면 실제 청구가 테스트로 오인되거나 그 반대가 됩니다.'
    );
    return res.status(503).json({
      error: 'PAYMENT_KEY_ENV_MISMATCH',
      message: '결제 키 설정이 올바르지 않아요. 관리자에게 문의해 주세요.'
    });
  }

  /*
   * orderId·customerKey·amount 를 전부 서버가 만든다.
   * 프론트는 이 값을 그대로 결제창에 넘기기만 한다. 프론트가 만든 값을 쓰면
   * 금액이나 주문번호를 마음대로 바꿀 수 있다.
   */
  const orderId = billing.createOrderId();

  /*
   * ★ 결제창을 열기 전에 주문을 먼저 원장에 남긴다.
   *
   *   예전에는 승인이 끝난 뒤에야 payments 에 행이 생겼다. 그런데 confirm 은
   *   최악 75초(빌링키 15 + 승인 60)인데 함수 상한은 60초다. 상한에서 잘리면
   *   카드에는 청구됐는데 우리 DB 에는 아무 흔적이 없고, 사용자가 다시
   *   시도하면 새 orderId 로 두 번째 청구가 나간다.
   *
   *   여기서 pending 한 행을 남겨 두면 어디서 죽든 orderId 로 되짚을 수 있다.
   *   금액도 이 시점에 확정해 두므로, confirm 이 다른 금액을 볼 수 없다.
   */
  const pending = await billing.createPendingPayment({
    email, orderId, amount: billing.PRO_PRICE
  });
  if (!pending.ok) {
    console.error(`[payment] 주문 기록 실패 orderId=${orderId}: ${pending.error}`);
    return res.status(503).json({
      error: 'ORDER_CREATE_FAILED',
      message: '결제를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.'
    });
  }

  return res.json({
    clientKey: toss.clientKey(),          // 공개 키 — 노출되어도 되는 값
    customerKey: billing.customerKeyFor(email),
    orderId,
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

  /*
   * 0) 주문 확인 — prepare 가 만든 pending 행이 반드시 있어야 한다.
   *
   * 이걸 확인하지 않으면 아무 문자열이나 orderId 로 보내 결제를 시작시킬 수
   * 있고, 금액도 이 시점에 처음 정해져 검증할 기준이 없어진다.
   */
  const found = await billing.findPaymentByOrderId(orderId);
  if (found.error) {
    console.error(`[payment] 주문 조회 실패 orderId=${orderId}: ${found.error}`);
    return res.status(503).json({ error: 'ORDER_LOOKUP_FAILED', message: '결제 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
  const order = found.row;
  if (!order) {
    return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: '주문 정보를 찾을 수 없어요. 처음부터 다시 시도해 주세요.' });
  }
  /*
   * 주문의 주인과 토큰의 주인이 같아야 한다.
   * 남의 orderId 를 주워 보내 그 사람의 결제를 자기 구독으로 붙이지 못하게 한다.
   */
  if (String(order.email).toLowerCase() !== String(email).toLowerCase()) {
    console.warn(`[payment] 주문 소유자 불일치 orderId=${orderId}`);
    return res.status(403).json({ error: 'ORDER_OWNER_MISMATCH', message: '이 주문으로는 결제할 수 없어요.' });
  }
  // 금액은 주문을 만들 때 서버가 박아 둔 값이어야 한다.
  if (Number(order.amount) !== Number(billing.PRO_PRICE)) {
    console.error(`[payment] 주문 금액 불일치 orderId=${orderId} (원장 ${order.amount} / 상수 ${billing.PRO_PRICE})`);
    await billing.markFailed(orderId, 'amount mismatch');
    return res.status(409).json({ error: 'ORDER_AMOUNT_MISMATCH', message: '결제 금액을 확인하지 못했어요.' });
  }

  // 이미 끝난 주문 — 다시 긁지 않는다.
  if (order.status === billing.PAYMENT_STATUS.PAID) {
    const { data: sub } = await supabase
      .from('subscriptions').select('plan, status, expires_at, billing_key').eq('email', email).maybeSingle();
    return res.status(200).json({
      ok: true, alreadyProcessed: true,
      subscription: billing.publicSubscription(sub)
    });
  }
  if (order.status === billing.PAYMENT_STATUS.FAILED || order.status === billing.PAYMENT_STATUS.CANCELED) {
    return res.status(409).json({ error: 'ORDER_NOT_PAYABLE', message: '이미 종료된 주문이에요. 처음부터 다시 시도해 주세요.' });
  }

  /*
   * 0-b) charging 이면 복구 경로다.
   *
   * 직전 시도가 토스에 승인을 요청한 뒤 응답을 받기 전에 끊겼다는 뜻이다.
   * 카드에 청구가 됐는지 우리는 모른다 — 그러니 다시 긁기 전에 토스에
   * orderId 로 물어본다. 이걸 건너뛰고 재승인하면 이중 청구가 된다.
   */
  if (order.status === billing.PAYMENT_STATUS.CHARGING) {
    return await settleCharging(res, email, orderId, customerKey);
  }

  // 0-c) pending → charging 선점. 동시에 들어온 요청 중 하나만 통과한다.
  const claim = await billing.claimForCharge(orderId);
  if (claim.error) {
    console.error(`[payment] 주문 선점 실패 orderId=${orderId}: ${claim.error}`);
    return res.status(503).json({ error: 'ORDER_CLAIM_FAILED', message: '결제 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
  if (!claim.claimed) {
    // 다른 요청이 방금 선점했다. 그쪽 결과를 기다리게 한다.
    return res.status(409).json({ error: 'ORDER_IN_PROGRESS', message: '결제를 처리하고 있어요. 잠시 후 다시 확인해 주세요.' });
  }

  // 1) authKey → billingKey
  const issued = await toss.issueBillingKey(authKey, customerKey);
  if (!issued.ok) {
    console.error('[payment] 빌링키 발급 실패:', issued.error);
    await billing.markFailed(orderId, issued.error);
    return res.status(402).json({ error: 'BILLING_KEY_FAILED', message: '카드 등록에 실패했어요.' });
  }
  const billingKey = issued.data.billingKey;
  if (!billingKey) {
    await billing.markFailed(orderId, 'billingKey missing');
    return res.status(502).json({ error: 'BILLING_KEY_MISSING', message: '카드 등록에 실패했어요.' });
  }

  // 2) 실제 결제 — 금액은 서버 상수. 멱등키로 중복 승인을 막는다.
  const charged = await toss.chargeBilling(billingKey, {
    customerKey,
    amount: billing.PRO_PRICE,
    orderId,
    orderName: billing.ORDER_NAME
  }, orderId);   // orderId 를 멱등키로 재사용 — 같은 주문은 한 번만 승인된다

  if (!charged.ok) {
    console.error('[payment] 결제 승인 실패:', charged.error);
    /*
     * ★ 타임아웃은 실패로 확정하지 않는다.
     *
     *   "결제사 응답 시간 초과" 는 거절이 아니라 "모름" 이다. 청구가 됐을 수도
     *   있다. failed 로 굳히면 그 주문은 종착역이 되어, 사용자가 새 orderId 로
     *   다시 결제하는 순간 이중 청구가 된다. charging 으로 두면 다음 요청이
     *   위 복구 경로를 타고 토스에 실제 상태를 물어본다.
     */
    if (/시간 초과|연결 실패/.test(String(charged.error))) {
      console.error(`[payment] ★ 승인 결과 불명(charging 유지) orderId=${orderId} — 재시도 시 토스에 재조회한다`);
      return res.status(504).json({
        error: 'PAYMENT_RESULT_UNKNOWN',
        message: '결제 결과를 확인하는 중이에요. 잠시 후 다시 확인해 주세요.'
      });
    }
    await billing.markFailed(orderId, charged.error);
    return res.status(402).json({ error: 'PAYMENT_FAILED', message: '결제에 실패했어요. 카드사 정보를 확인해 주세요.' });
  }

  return await finalize(res, email, orderId, charged.data, { billingKey, customerKey });
}

/**
 * 승인 결과가 불명확한 주문(charging)을 토스에 다시 물어 확정한다.
 *
 * 여기서 절대 재승인하지 않는다 — 조회만 한다. 조회 결과가 곧 사실이다.
 */
async function settleCharging(res, email, orderId, customerKey) {
  const looked = await toss.getPaymentByOrderId(orderId);

  if (!looked.ok) {
    // 404 = 그런 결제가 없다 = 청구되지 않았다. 실패로 확정하고 새 주문을 유도한다.
    if (looked.status === 404) {
      await billing.markFailed(orderId, 'not charged (toss 404)');
      return res.status(409).json({ error: 'ORDER_NOT_PAYABLE', message: '결제가 완료되지 않았어요. 처음부터 다시 시도해 주세요.' });
    }
    // 그 밖의 오류는 "모름" 이다. charging 그대로 두고 다시 물어보게 한다.
    console.error(`[payment] 복구 조회 실패 orderId=${orderId}: ${looked.error}`);
    return res.status(503).json({ error: 'ORDER_LOOKUP_FAILED', message: '결제 상태를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.' });
  }

  const payment = looked.data;
  if (String(payment.status) !== toss.STATUS_DONE) {
    await billing.markFailed(orderId, `toss status=${payment.status}`);
    return res.status(409).json({ error: 'ORDER_NOT_PAYABLE', message: '결제가 완료되지 않았어요. 처음부터 다시 시도해 주세요.' });
  }

  console.log(`[payment] 미결 주문 복구 — orderId=${orderId} 는 이미 승인되어 있었다 (재승인 안 함)`);
  return await finalize(res, email, orderId, payment, { customerKey });
}

/**
 * 승인된 결제를 검증 → 원장 확정 → PRO 활성화.
 * 정상 승인 경로와 복구 경로가 같은 함수를 쓴다 (규칙이 갈라지지 않게).
 */
async function finalize(res, email, orderId, payment, { billingKey, customerKey } = {}) {
  // 3) 검증 — 여기를 통과해야만 PRO 가 된다.
  const verdict = billing.verifyPayment(payment, { orderId, amount: billing.PRO_PRICE });
  if (!verdict.ok) {
    console.error('[payment] 결제 검증 실패:', verdict.reason);
    await billing.markFailed(orderId, verdict.reason);
    return res.status(402).json({ error: 'PAYMENT_VERIFICATION_FAILED', message: '결제를 확인하지 못했어요.' });
  }

  // 4) 원장 확정 (charging → paid). 동시에 두 경로가 와도 한 번만 반영된다.
  const paid = await billing.markPaid(orderId, {
    paymentKey: payment.paymentKey,
    amount: payment.totalAmount,
    rawStatus: payment.status
  });
  if (paid.error) {
    /*
     * 결제는 됐는데 기록을 못 남겼다. 권한을 주지 않는다 — 기록 없는 권한은
     * 나중에 환불·정산 대조가 불가능하다. charging 으로 남으므로 다음 요청이
     * 복구 경로를 타서 다시 확정을 시도한다 (이중 청구는 없다).
     */
    console.error(`[payment] ★ 결제는 승인됐으나 기록 실패 — 수동 확인 필요 orderId=${orderId}: ${paid.error}`);
    return res.status(500).json({ error: 'PAYMENT_RECORD_FAILED', message: '결제는 되었지만 처리 중 문제가 생겼어요. 고객센터로 문의해 주세요.' });
  }
  if (!paid.updated) {
    // 다른 경로(웹훅 등)가 이미 확정했다. 기간을 또 늘리지 않는다.
    const { data: sub } = await supabase
      .from('subscriptions').select('plan, status, expires_at, billing_key').eq('email', email).maybeSingle();
    return res.status(200).json({ ok: true, alreadyProcessed: true, subscription: billing.publicSubscription(sub) });
  }

  // 5) PRO 활성화
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
