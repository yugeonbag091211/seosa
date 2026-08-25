'use strict';
/*
 * 토스페이먼츠 서버 API 클라이언트.
 *
 * ── 이 파일만 시크릿 키를 안다 ────────────────────────────────────
 * TOSS_SECRET_KEY 는 서버에서만 읽는다. 프론트로 나가는 값은 클라이언트 키
 * (TOSS_CLIENT_KEY) 하나뿐이고, 그건 원래 공개되는 값이다. 시크릿 키가 번들에
 * 섞이면 누구나 우리 계정으로 결제·취소·조회를 할 수 있다.
 *
 * ── 공식 문서 기준 (추측 금지) ───────────────────────────────────
 *   빌링키 발급   POST https://api.tosspayments.com/v1/billing/authorizations/issue
 *                 body { authKey, customerKey }
 *   빌링키 결제   POST https://api.tosspayments.com/v1/billing/{billingKey}
 *                 body { customerKey, amount, orderId, orderName }
 *   결제 조회     GET  https://api.tosspayments.com/v1/payments/{paymentKey}
 *   결제 취소     POST https://api.tosspayments.com/v1/payments/{paymentKey}/cancel
 *                 body { cancelReason, [cancelAmount] }
 *   인증          Authorization: Basic base64(secretKey + ':')
 *                 ★ 시크릿 키 뒤에 콜론을 붙여서 인코딩한다. 콜론을 빠뜨리면
 *                   그냥 401 이 온다.
 *   멱등키        Idempotency-Key 헤더. 최대 300자, 15일간 유효.
 *                 (키 + API 주소 + HTTP 메서드 조합으로 판정)
 *
 *   https://docs.tosspayments.com/guides/v2/billing/integration
 *   https://docs.tosspayments.com/reference
 *   https://docs.tosspayments.com/reference/using-api/idempotency-key
 */

const API_BASE = 'https://api.tosspayments.com';

/*
 * 기본 타임아웃 — 조회·취소·빌링키 발급은 이 값으로 충분하다.
 * 자동결제 승인은 아래 CHARGE_TIMEOUT_MS 를 따로 쓴다.
 */
const TIMEOUT_MS = 15000;

/*
 * ★ 자동결제 승인(chargeBilling)만 60초.
 *
 * 토스 공식 문서:
 *   "자동결제 승인은 최대 60초가 소요됩니다. 타임아웃 값을 최소 60초로 설정하세요."
 *
 * 왜 이게 중요한가 — 60초 안에 abort 하면 최악의 시나리오가 생긴다.
 *   1) 토스에서는 결제가 실제로 승인되어 카드에 청구됨
 *   2) 우리 서버는 AbortError 로 실패 처리
 *   3) 사용자에게는 "결제 실패" 안내
 *   4) 다음날 카드 명세서에는 4,900원이 찍혀 있음
 * 이 상태가 되면 되돌리기가 어렵고 사용자 신뢰가 무너진다.
 *
 * 그런데 60초로 늘려도 여전히 초과할 가능성이 있으므로, orderId 를 Idempotency-Key
 * 로 재사용한다(api/payment.handleConfirm 참고). 같은 orderId 로 재시도해도 토스가
 * 첫 번째 결과와 동일한 응답을 돌려주므로 이중 청구가 되지 않는다.
 */
const CHARGE_TIMEOUT_MS = 60000;

/** 결제 승인이 끝난 상태. 이 값이 아니면 PRO 를 주지 않는다. */
const STATUS_DONE = 'DONE';

function secretKey() {
  return process.env.TOSS_SECRET_KEY || '';
}

/** 프론트로 내보내도 되는 공개 키. */
function clientKey() {
  return process.env.TOSS_CLIENT_KEY || '';
}

/**
 * 결제를 실제로 시도할 수 있는 환경인가.
 *
 * 키가 없으면 결제 기능 자체를 닫는다. "키가 없으니 일단 PRO 를 준다" 같은
 * 우회로를 절대 만들지 않는다 — 그건 결제 없이 유료 기능을 여는 문이다.
 */
function isConfigured() {
  return !!(secretKey() && clientKey());
}

/**
 * 테스트 키인가. 토스 테스트 키는 `test_` 로 시작한다.
 * 운영 배포에서 테스트 키가 걸려 있으면 로그로 크게 알린다 — 실제 정산이
 * 되지 않는데 사용자에게는 결제된 것처럼 보이는 상태가 가장 위험하다.
 */
function isTestKey() {
  return /^test_/.test(secretKey());
}

/**
 * 이 클라이언트 키가 "결제위젯" 유형인가.
 *
 * 토스 콘솔에는 결제 키가 두 종류다.
 *   · API 개별 연동  →  client:  test_ck_… / live_ck_…    (프론트 tp.payment() 로 쓴다)
 *   · 결제위젯        →  client:  test_gck_… / live_gck_…  (프론트 tp.widgets() 로 쓴다)
 *
 * 우리 프론트(public/index.html Pay.start)는 tp.payment({customerKey}) 를 부른다.
 * 그런데 결제위젯용 client key 를 넣으면 SDK 가 초기화 단계에서 동기 throw 한다:
 *   "API 개별 연동 키의 클라이언트 키로 SDK를 연동해주세요.
 *    결제위젯 연동 키는 지원하지 않습니다."
 *
 * 그 예외는 프론트 try/catch 에서 잡혀 "결제창을 열지 못했어요." 라는 뭉뚱그린
 * 안내로만 뜬다. 원인이 안 보이면 운영자가 뭘 고쳐야 할지 알 수 없다.
 *
 * 그래서 서버가 미리 감지해서 prepare 단계에서 명확한 코드/메시지로 거절한다.
 * 프론트 SDK 는 아예 초기화되지 않으므로 뭉뚱그린 오류가 나타나지 않는다.
 */
function isWidgetClientKey() {
  return /^(test|live)_gck_/i.test(clientKey());
}

/**
 * 시크릿 키도 결제위젯 유형인가 (test_gsk_… / live_gsk_…).
 * 로그 진단용. client 만 위젯이고 secret 은 API 개별 연동이면 서버 결제 승인
 * 자체가 401 로 튈 수 있으니 함께 알려 준다.
 */
function isWidgetSecretKey() {
  return /^(test|live)_gsk_/i.test(secretKey());
}

/**
 * 키의 환경(test / live)을 읽는다. 판별할 수 없으면 빈 문자열.
 */
function keyEnv(key) {
  const m = /^(test|live)_/i.exec(String(key || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * ★ client 와 secret 이 서로 다른 환경인가 (test + live 혼용).
 *
 * 이게 왜 위험한가 — 키를 교체할 때 가장 흔한 실수이고, 결과가 최악이다.
 *
 *   client=test / secret=live
 *     결제창은 테스트처럼 보이는데 서버 승인은 운영으로 나간다.
 *     "테스트 중" 이라고 생각하는 사이 실제 카드에 4,900원이 청구된다.
 *
 *   client=live / secret=test
 *     운영 결제창에서 카드를 등록했는데 서버 승인이 테스트로 나간다.
 *     사용자는 결제한 줄 알지만 정산은 없다.
 *
 * 둘 다 되돌리기가 비싸다. 그래서 섞여 있으면 결제를 시작조차 하지 않는다
 * (fail closed — _billing.js 원칙과 같은 방향).
 */
function isMixedKeyEnv() {
  const c = keyEnv(clientKey());
  const s = keyEnv(secretKey());
  if (!c || !s) return false;   // 판별 불가한 형태는 여기서 판단하지 않는다
  return c !== s;
}

/**
 * 로그·진단용 키 요약. ★ 키 값 자체는 절대 담지 않는다 —
 * 환경(test/live)과 유형(api/widget), 설정 여부만 담는다.
 * Vercel 로그는 사람이 보는 곳이므로 여기에 시크릿이 섞이면 그대로 유출이다.
 */
function keySummary() {
  const kind = k => (/^(test|live)_g(ck|sk)_/i.test(k) ? 'widget'
                   : /^(test|live)_(ck|sk)_/i.test(k) ? 'api'
                   : k ? 'unknown' : 'missing');
  return {
    client: { env: keyEnv(clientKey()) || 'unknown', kind: kind(clientKey()) },
    secret: { env: keyEnv(secretKey()) || 'unknown', kind: kind(secretKey()) }
  };
}

function authHeader() {
  // ★ 콜론을 반드시 붙인다 (공식 문서: "시크릿 키 뒤에 :을 추가하고 base64로 인코딩").
  return 'Basic ' + Buffer.from(secretKey() + ':', 'utf8').toString('base64');
}

/**
 * 토스 API 호출.
 *
 * @returns {{ok:boolean, status:number, data:object, error:string}}
 *   throw 하지 않는다. 호출부가 "실패했다"를 데이터로 다뤄야 결제 실패를
 *   조용히 성공으로 넘기는 실수가 안 생긴다.
 */
async function call(method, path, { body, idempotencyKey, timeoutMs } = {}) {
  if (!isConfigured()) {
    return { ok: false, status: 0, data: {}, error: 'TOSS_SECRET_KEY / TOSS_CLIENT_KEY 미설정' };
  }

  const headers = {
    Authorization: authHeader(),
    'Content-Type': 'application/json'
  };
  // 멱등키는 POST 에만 의미가 있다. 같은 키로 다시 보내면 같은 응답이 온다.
  if (idempotencyKey && method === 'POST') headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 300);

  // 호출부가 timeoutMs 를 넘기면 그 값을, 아니면 기본값을 쓴다.
  // chargeBilling 만 60초, 나머지는 15초.
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budget);

  let r;
  try {
    r = await fetch(API_BASE + path, {
      method,
      signal: ac.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    // 타임아웃·네트워크 오류. "모름" 이지 "성공" 이 아니다.
    return {
      ok: false, status: 0, data: {},
      error: e.name === 'AbortError' ? '결제사 응답 시간 초과' : `결제사 연결 실패: ${e.message}`
    };
  } finally {
    clearTimeout(timer);
  }

  let data = {};
  try { data = await r.json(); } catch (e) { data = {}; }

  if (!r.ok) {
    // 토스 오류 응답은 { code, message } 형태다. 원문을 사용자에게 그대로
    // 보여주지는 않지만(내부 사정이 샌다), 로그와 판정에는 쓴다.
    return {
      ok: false, status: r.status, data,
      error: `${data.code || 'TOSS_ERROR'}: ${String(data.message || '').slice(0, 200)}`
    };
  }
  return { ok: true, status: r.status, data, error: '' };
}

/* ------------------------------------------------------------------ *
 *  빌링(자동결제)
 * ------------------------------------------------------------------ */

/**
 * 카드 등록 성공 후 받은 authKey 를 빌링키로 교환한다.
 * 빌링키는 서버에만 저장하고 절대 프론트로 내보내지 않는다.
 */
function issueBillingKey(authKey, customerKey) {
  return call('POST', '/v1/billing/authorizations/issue', {
    body: { authKey, customerKey }
  });
}

/**
 * 빌링키로 결제를 승인한다.
 *
 * ★ amount 는 반드시 서버가 정한 값을 넘긴다. 프론트가 보낸 금액을 그대로
 *   쓰면 100원짜리 PRO 구독이 만들어진다.
 *
 * ★ 타임아웃은 반드시 60초 이상 — CHARGE_TIMEOUT_MS 주석 참고.
 *   idempotencyKey 로 orderId 를 넘기므로, 60초 안에도 abort 되어 재시도할
 *   경우 토스가 같은 응답을 돌려준다 (이중 청구 없음).
 */
function chargeBilling(billingKey, { customerKey, amount, orderId, orderName }, idempotencyKey) {
  return call('POST', `/v1/billing/${encodeURIComponent(billingKey)}`, {
    body: { customerKey, amount, orderId, orderName },
    idempotencyKey,
    timeoutMs: CHARGE_TIMEOUT_MS
  });
}

/* ------------------------------------------------------------------ *
 *  조회 · 취소
 * ------------------------------------------------------------------ */

/**
 * 결제 단건 조회.
 *
 * 웹훅 검증의 핵심이다 — 토스는 결제 웹훅에 서명을 넣지 않으므로
 * (tosspayments-webhook-signature 는 payout.changed / seller.changed 전용),
 * 웹훅 본문을 믿는 대신 이 API 로 실제 상태를 다시 물어봐야 한다.
 */
function getPayment(paymentKey) {
  return call('GET', `/v1/payments/${encodeURIComponent(paymentKey)}`);
}

/**
 * 주문번호로 결제 조회.
 *
 * ★ 서버가 승인 도중 죽었을 때 복구의 유일한 단서다.
 *
 *   paymentKey 는 토스가 승인 응답에서 처음 알려 준다. 그 응답을 받기 전에
 *   함수가 잘리면 우리는 paymentKey 를 영영 모른다 — 그런데 카드에는 이미
 *   청구가 됐을 수 있다. orderId 는 우리가 만든 값이라 그 상황에서도 안다.
 *
 *   그래서 재시도가 들어오면 "정말 청구가 됐는가" 를 이 API 로 먼저 묻는다.
 *   DONE 이면 다시 긁지 않고 그 결제를 그대로 확정한다 (이중 청구 방지).
 *
 *   결제가 없으면 토스가 404(NOT_FOUND_PAYMENT)를 준다. 그건 "청구되지
 *   않았다" 는 뜻이므로 오류가 아니라 정상적인 답이다 — 호출부가
 *   status 404 를 구분할 수 있게 그대로 돌려준다.
 *
 *   https://docs.tosspayments.com/reference#주문번호로-결제-조회
 */
function getPaymentByOrderId(orderId) {
  return call('GET', `/v1/payments/orders/${encodeURIComponent(orderId)}`);
}

/** 결제 취소(환불). 프론트가 "취소됐다"고 말하는 것으로는 절대 취소하지 않는다. */
function cancelPayment(paymentKey, cancelReason, idempotencyKey, cancelAmount) {
  const body = { cancelReason: String(cancelReason || '고객 요청').slice(0, 200) };
  if (cancelAmount > 0) body.cancelAmount = cancelAmount;
  return call('POST', `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, {
    body, idempotencyKey
  });
}

module.exports = {
  API_BASE, STATUS_DONE, TIMEOUT_MS, CHARGE_TIMEOUT_MS,
  clientKey, isConfigured, isTestKey, isWidgetClientKey, isWidgetSecretKey,
  keyEnv, isMixedKeyEnv, keySummary, authHeader,
  issueBillingKey, chargeBilling, getPayment, getPaymentByOrderId, cancelPayment,
  _call: call
};
