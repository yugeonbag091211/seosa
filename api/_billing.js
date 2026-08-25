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
  /** 주문만 만들었다. 아직 아무 청구도 하지 않았다. */
  PENDING: 'pending',
  /** 토스에 승인을 요청했다. 청구가 됐는지 아직 모른다. */
  CHARGING: 'charging',
  PAID: 'paid',
  FAILED: 'failed',
  CANCELED: 'canceled'
};

/**
 * 허용된 상태 전이.
 *
 * ★ 결제 상태는 되돌아가지 않는다. paid 를 pending 으로 되돌리는 경로가
 *   하나라도 있으면, 그 경로로 같은 주문을 다시 긁을 수 있게 된다.
 *
 *   pending  → charging | failed
 *   charging → paid | failed      (승인 결과가 나왔다)
 *   paid     → canceled           (환불)
 *   failed / canceled 는 종착역이다.
 */
const ALLOWED_TRANSITIONS = {
  [PAYMENT_STATUS.PENDING]:  [PAYMENT_STATUS.CHARGING, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.CHARGING]: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.PAID]:     [PAYMENT_STATUS.CANCELED],
  [PAYMENT_STATUS.FAILED]:   [],
  [PAYMENT_STATUS.CANCELED]: []
};

/** @returns {boolean} from → to 가 허용된 전이인가. */
function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[String(from)];
  return Array.isArray(allowed) && allowed.indexOf(String(to)) > -1;
}

/**
 * pending 행의 payment_key 자리에 넣을 임시 값.
 *
 * payments.payment_key 는 NOT NULL + UNIQUE 다. 주문을 만드는 시점에는 아직
 * 토스가 준 식별자가 없으므로 orderId 에서 파생한 값을 넣어 두고, 승인이
 * 확정되면 진짜 값으로 갈아끼운다. orderId 자체가 UNIQUE 라 충돌하지 않는다.
 */
function placeholderPaymentKey(orderId) {
  return 'pending_' + String(orderId);
}

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

/* ── 미결 주문(pending) 원장 ───────────────────────────────────────
 *
 * 결제창을 열기 전에 주문을 먼저 기록한다. 이 한 행이 있으면 승인 도중
 * 함수가 죽어도 orderId 로 무슨 일이 있었는지 되짚을 수 있다.
 * (자세한 배경은 supabase/2026-08-24-payment-pending-and-auth-attempts.sql)
 * ------------------------------------------------------------------ */

/**
 * 주문을 pending 으로 기록한다.
 * @returns {{ok:boolean, duplicate:boolean, error:string}}
 */
async function createPendingPayment({ email, orderId, amount, now = new Date() }) {
  const { error } = await supabase.from('payments').insert({
    email,
    order_id: orderId,
    payment_key: placeholderPaymentKey(orderId),
    amount,
    currency: CURRENCY,
    status: PAYMENT_STATUS.PENDING,
    provider: PROVIDER,
    raw_status: '',
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  });
  if (!error) return { ok: true, duplicate: false, error: '' };

  const dup = error.code === '23505' || /duplicate key|unique/i.test(error.message || '');
  if (dup) return { ok: false, duplicate: true, error: '이미 존재하는 주문번호' };
  return { ok: false, duplicate: false, error: error.message };
}

/** 주문번호로 결제 원장 한 행. 없으면 null. */
async function findPaymentByOrderId(orderId) {
  const { data, error } = await supabase
    .from('payments')
    .select('email, order_id, payment_key, amount, status, raw_status, created_at')
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data || null, error: '' };
}

/**
 * pending → charging 을 원자적으로 선점한다.
 *
 * ★ 이 한 문장이 동시 요청 방어의 전부다.
 *
 *   UPDATE ... WHERE status = 'pending' 은 행 잠금을 잡으므로, 같은 orderId 로
 *   두 요청이 동시에 들어와도 하나만 행을 얻는다. 진 쪽은 반환 행이 없으니
 *   "이미 누가 긁고 있다" 로 판정하고 토스를 부르지 않는다.
 *
 *   비교-후-쓰기(select → if → update)로 나누면 둘 다 통과해서 같은 주문을
 *   두 번 승인 요청하게 된다. 멱등키 덕분에 이중 청구까지는 안 가지만,
 *   그건 토스에 기대는 것이지 우리가 막는 것이 아니다.
 *
 * @returns {{claimed:boolean, error:string}}
 */
async function claimForCharge(orderId, now = new Date()) {
  const { data, error } = await supabase
    .from('payments')
    .update({ status: PAYMENT_STATUS.CHARGING, updated_at: now.toISOString() })
    .eq('order_id', orderId)
    .eq('status', PAYMENT_STATUS.PENDING)
    .select('order_id');
  if (error) return { claimed: false, error: error.message };
  return { claimed: !!(data && data.length), error: '' };
}

/**
 * charging → paid 로 확정한다.
 *
 * WHERE 에 status='charging' 을 걸어 두면, 두 경로(정상 승인 / 복구 조회)가
 * 동시에 확정하려 해도 한 번만 반영된다. 두 번째는 updated=false 를 받고
 * "이미 처리됨" 으로 끝난다 — PRO 기간이 두 번 연장되지 않는다.
 *
 * @returns {{updated:boolean, error:string}}
 */
async function markPaid(orderId, { paymentKey, amount, rawStatus, now = new Date() }) {
  const patch = {
    status: PAYMENT_STATUS.PAID,
    raw_status: String(rawStatus || ''),
    updated_at: now.toISOString()
  };
  if (paymentKey) patch.payment_key = paymentKey;
  if (Number.isFinite(Number(amount))) patch.amount = Number(amount);

  const { data, error } = await supabase
    .from('payments')
    .update(patch)
    .eq('order_id', orderId)
    .eq('status', PAYMENT_STATUS.CHARGING)
    .select('order_id');

  if (error) {
    // 같은 paymentKey 가 이미 다른 행에 있다(웹훅이 먼저 기록한 경우).
    // 그건 실패가 아니라 "이미 처리됨" 이다.
    const dup = error.code === '23505' || /duplicate key|unique/i.test(error.message || '');
    if (dup) return { updated: false, error: '' };
    return { updated: false, error: error.message };
  }
  return { updated: !!(data && data.length), error: '' };
}

/**
 * 실패로 확정한다. pending / charging 어느 쪽에서든 갈 수 있다.
 * @returns {{updated:boolean, error:string}}
 */
async function markFailed(orderId, reason, now = new Date()) {
  const { data, error } = await supabase
    .from('payments')
    .update({
      status: PAYMENT_STATUS.FAILED,
      raw_status: String(reason || '').slice(0, 100),
      updated_at: now.toISOString()
    })
    .eq('order_id', orderId)
    .in('status', [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.CHARGING])
    .select('order_id');
  if (error) return { updated: false, error: error.message };
  return { updated: !!(data && data.length), error: '' };
}

/** 이 payment_key 가 이미 처리됐는가 (웹훅 재전송 대비 선제 확인). */
async function alreadyProcessed(paymentKey) {
  const { data, error } = await supabase
    .from('payments').select('payment_key, status').eq('payment_key', paymentKey).maybeSingle();
  if (error) return { known: false, error: error.message };
  return { known: !!data, row: data || null, error: '' };
}

/*
 * orderIdUsed() 는 지웠다.
 *
 * "이 주문번호가 이미 쓰였는가" 만 boolean 으로 답하던 함수다. 주문이 승인
 * 뒤에야 기록되던 시절에는 그것으로 재사용을 막을 수 있었다.
 *
 * 지금은 prepare 가 pending 행을 먼저 남기므로 모든 orderId 가 "이미 쓰인"
 * 상태다. 필요한 것은 존재 여부가 아니라 상태와 주인이다 —
 * findPaymentByOrderId() 가 그 행을 통째로 돌려주고, handleConfirm 이
 * status / email / amount 를 각각 판정한다.
 */

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

/* ── 자동결제 갱신 ────────────────────────────────────────────────
 *
 * ★ 왜 지금 필요한가
 *   프론트는 "서사 PRO · 월 4,900원 · 구독 취소" 로 안내한다. 즉 사용자는
 *   "취소하지 않으면 갱신된다" 고 읽는다. 그런데 chargeBilling 을 부르는 곳이
 *   최초 결제 한 군데뿐이라, 실제로는 30일 뒤 조용히 FREE 로 떨어졌다.
 *   빌링키까지 받아 두고 쓰지 않는 상태이기도 했다.
 *
 * ★ 왜 새 엔드포인트를 만들지 않는가
 *   Vercel Hobby 는 서버리스 함수 12개가 상한이고 이미 11개다. 갱신은 하루
 *   한 번이면 충분하므로, 이미 CRON_SECRET 뒤에서 매일 도는 /api/cron 에
 *   얹는다. 새 인프라를 만들지 않는 것이 이 프로젝트의 제약에 맞는다.
 * ------------------------------------------------------------------ */

/** 만료 이 날짜 안으로 들어오면 갱신 대상. 결제 실패 시 재시도할 여유를 준다. */
const RENEW_WINDOW_DAYS = 3;
/** 연속 실패가 이만큼 쌓이면 갱신을 포기한다 (카드사 거절 누적 방지). */
const MAX_RENEW_FAILURES = 3;
/** 실패 후 다음 시도까지 최소 간격(시간). 하루 한 번 도는 크론에서는 사실상 1일. */
const RENEW_RETRY_GAP_HOURS = 20;
/** 한 실행에서 처리할 최대 건수. 함수 실행시간 안에 끝나게 한다. */
const RENEW_BATCH = 20;

/**
 * 갱신 대상 구독을 고른다.
 *
 * 조건을 전부 만족해야 한다.
 *   plan=pro / status=active   — 해지·강등된 구독은 긁지 않는다
 *   billing_key 있음            — 취소하면 null 이 된다 = 다음 결제 중단
 *   expires_at 이 창 안         — 아직 한참 남은 구독을 미리 긁지 않는다
 *   renew_failures < 상한       — 거절이 쌓인 카드를 계속 두드리지 않는다
 *   last_renew_at 이 충분히 전  — 같은 날 여러 번 시도하지 않는다
 */
async function dueForRenewal(now = new Date(), limit = RENEW_BATCH) {
  const until = new Date(now.getTime() + RENEW_WINDOW_DAYS * 86400000).toISOString();
  const { data, error } = await supabase
    .from('subscriptions')
    .select('email, plan, status, expires_at, billing_key, customer_key, renew_failures, last_renew_at')
    .eq('plan', 'pro')
    .eq('status', 'active')
    .not('billing_key', 'is', null)
    .lte('expires_at', until)
    .order('expires_at', { ascending: true })
    .limit(limit);

  if (error) return { rows: [], error: error.message };

  const gapMs = RENEW_RETRY_GAP_HOURS * 3600000;
  const rows = (data || []).filter(r => {
    if ((Number(r.renew_failures) || 0) >= MAX_RENEW_FAILURES) return false;
    if (!r.last_renew_at) return true;
    const last = Date.parse(r.last_renew_at);
    return !Number.isFinite(last) || (now.getTime() - last) >= gapMs;
  });
  return { rows, error: '' };
}

/** 갱신 시도 결과를 구독 행에 기록한다 (성공하면 실패 카운터를 0 으로). */
async function recordRenewAttempt(email, ok, now = new Date()) {
  const patch = { last_renew_at: now.toISOString(), updated_at: now.toISOString() };
  if (ok) {
    patch.renew_failures = 0;
  } else {
    const { data } = await supabase
      .from('subscriptions').select('renew_failures').eq('email', email).maybeSingle();
    patch.renew_failures = (Number(data && data.renew_failures) || 0) + 1;
  }
  const { error } = await supabase.from('subscriptions').update(patch).eq('email', email);
  return { ok: !error, failures: patch.renew_failures, error: error ? error.message : '' };
}

/**
 * 구독 하나를 갱신한다.
 *
 * 최초 결제와 정확히 같은 규칙을 쓴다 — 금액은 서버 상수, 주문은 pending 으로
 * 먼저 기록, 멱등키는 orderId, 확정된 결제만 PRO 기간을 늘린다.
 * 새 규칙을 만들지 않는 것이 중요하다. 두 경로가 갈라지면 한쪽만 고쳐진다.
 *
 * @param {object} sub  dueForRenewal 이 준 행
 * @param {object} deps { toss } — 테스트에서 갈아끼울 수 있게 주입받는다
 * @returns {{ok:boolean, orderId:string, reason:string, expiresAt:string}}
 */
async function renewOne(sub, deps = {}, now = new Date()) {
  const tossApi = deps.toss || toss;
  const email = sub && sub.email;
  if (!email) return { ok: false, orderId: '', reason: '이메일 없음', expiresAt: '' };
  if (!sub.billing_key) return { ok: false, orderId: '', reason: '빌링키 없음(해지됨)', expiresAt: '' };

  const orderId = createOrderId();
  const customerKey = sub.customer_key || customerKeyFor(email);

  const pending = await createPendingPayment({ email, orderId, amount: PRO_PRICE, now });
  if (!pending.ok) return { ok: false, orderId, reason: `주문 기록 실패: ${pending.error}`, expiresAt: '' };

  const claim = await claimForCharge(orderId, now);
  if (!claim.claimed) return { ok: false, orderId, reason: '주문을 선점하지 못함', expiresAt: '' };

  const charged = await tossApi.chargeBilling(sub.billing_key, {
    customerKey, amount: PRO_PRICE, orderId, orderName: ORDER_NAME
  }, orderId);

  if (!charged.ok) {
    await markFailed(orderId, charged.error, now);
    return { ok: false, orderId, reason: charged.error, expiresAt: '' };
  }

  const verdict = verifyPayment(charged.data, { orderId, amount: PRO_PRICE });
  if (!verdict.ok) {
    await markFailed(orderId, verdict.reason, now);
    return { ok: false, orderId, reason: verdict.reason, expiresAt: '' };
  }

  const paid = await markPaid(orderId, {
    paymentKey: charged.data.paymentKey, amount: charged.data.totalAmount,
    rawStatus: charged.data.status, now
  });
  if (!paid.updated) {
    // 이미 확정됐다 — 기간을 또 늘리지 않는다.
    return { ok: false, orderId, reason: '이미 처리된 갱신', expiresAt: '' };
  }

  const act = await activatePro(email, { customerKey, now });
  if (!act.ok) return { ok: false, orderId, reason: `구독 연장 실패: ${act.error}`, expiresAt: '' };
  return { ok: true, orderId, reason: '', expiresAt: act.expiresAt };
}

/**
 * 갱신 대상을 훑어 결제한다. /api/cron 이 하루 한 번 부른다.
 *
 * 한 건이 실패해도 나머지를 계속 처리한다 — 카드 하나가 거절됐다고 다른
 * 사용자의 갱신이 멈추면 안 된다.
 */
async function renewDueSubscriptions(deps = {}, now = new Date()) {
  const { rows, error } = await dueForRenewal(now);
  if (error) return { attempted: 0, renewed: 0, failed: 0, gaveUp: 0, error };

  let renewed = 0, failed = 0, gaveUp = 0;
  const details = [];
  for (const sub of rows) {
    let r;
    try {
      r = await renewOne(sub, deps, now);
    } catch (e) {
      r = { ok: false, orderId: '', reason: e.message, expiresAt: '' };
    }
    const rec = await recordRenewAttempt(sub.email, r.ok, now);
    if (r.ok) renewed++;
    else {
      failed++;
      if (rec.failures >= MAX_RENEW_FAILURES) {
        gaveUp++;
        /*
         * 상한까지 실패했다. 여기서 즉시 FREE 로 떨어뜨리지는 않는다 —
         * 사용자는 이번 기간 요금을 이미 냈고, expires_at 이 지나면
         * _plan.resolvePlan 이 알아서 FREE 로 판정한다. 우리가 할 일은
         * 다음 청구를 멈추는 것뿐이다.
         */
        await supabase.from('subscriptions')
          .update({ billing_key: null, updated_at: now.toISOString() })
          .eq('email', sub.email);
      }
    }
    // 이메일은 로그에 남기지 않는다. 주문번호만으로 추적이 된다.
    details.push({ orderId: r.orderId, ok: r.ok, reason: r.ok ? '' : String(r.reason).slice(0, 80) });
  }
  return { attempted: rows.length, renewed, failed, gaveUp, details, error: '' };
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
  ALLOWED_TRANSITIONS, canTransition, placeholderPaymentKey,
  RENEW_WINDOW_DAYS, MAX_RENEW_FAILURES, RENEW_RETRY_GAP_HOURS, RENEW_BATCH,
  customerKeyFor, createOrderId, verifyPayment,
  recordPayment, alreadyProcessed,
  createPendingPayment, findPaymentByOrderId, claimForCharge, markPaid, markFailed,
  dueForRenewal, recordRenewAttempt, renewOne, renewDueSubscriptions,
  activatePro, cancelSubscription, deactivate, publicSubscription
};
