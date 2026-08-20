'use strict';
const { readBody, applyCors, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { verifyToken } = require('./_auth');
const { PRO_PRICE_KRW, publicSubscription } = require('./_plan');
const supabase = require('./_supabase');

const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';
const PRO_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function tossAuth() {
  const key = process.env.TOSS_SECRET_KEY;
  if (!key) return null;
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

function extractEmail(req) {
  const raw = String(req.headers.authorization || '');
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const t = verifyToken(m[1].trim());
    return t ? t.email : null;
  } catch (e) { return null; }
}

async function confirmPayment(req, res) {
  const email = extractEmail(req);
  if (!email) {
    return res.status(401).json({ error: '로그인이 필요합니다.', needsAuth: true });
  }

  const auth = tossAuth();
  if (!auth) {
    return res.status(500).json({ error: '결제 시스템이 설정되지 않았습니다.' });
  }

  const { orderId, paymentKey, amount } = readBody(req);
  if (!orderId || !paymentKey || amount == null) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  if (Number(amount) !== PRO_PRICE_KRW) {
    console.error('[payment] amount tamper — expected %d, got %s from %s', PRO_PRICE_KRW, amount, email);
    return res.status(400).json({ error: '결제 금액이 올바르지 않습니다.' });
  }

  /*
   * Toss에 confirm을 보내기 전에 소유자를 먼저 기록해 둔다.
   *
   * confirm 요청이 타임아웃(아래 60초)으로 끊기면 Toss 쪽은 이미 처리했을 수
   * 있는데 우리 DB에는 아무 기록도 안 남는다. 그 상태에서 재시도하면 Toss는
   * ALREADY_PROCESSED_PAYMENT를 주는데, 이 이메일 기록이 없으면 누구 결제인지
   * 확인할 방법이 없어 PRO를 복구해 줄 수 없었다.
   *
   * ★ upsert가 아니라 "이미 남의 orderId면 거부, 없으면만 insert"로 한다.
   *   upsert로 email을 무조건 덮어쓰면, 남의 orderId/paymentKey(성공 후
   *   successUrl 쿼리로 노출됨)를 가져온 요청이 기존 소유자 기록을 자기
   *   이메일로 바꿔치기해서 뒤의 ALREADY_PROCESSED_PAYMENT 복구를 통과할 수 있다.
   */
  const { data: existingOwner } = await supabase
    .from('payments').select('email').eq('order_id', orderId).maybeSingle();

  if (existingOwner && String(existingOwner.email).toLowerCase() !== String(email).toLowerCase()) {
    console.error('[payment] orderId ownership mismatch — order=%s owner=%s requester=%s', orderId, existingOwner.email, email);
    return res.status(403).json({ error: '이 결제 정보에 접근할 수 없습니다.' });
  }
  if (!existingOwner) {
    const { error: pendingErr } = await supabase.from('payments').insert({
      email, order_id: orderId, payment_key: paymentKey, amount: PRO_PRICE_KRW,
      status: 'pending', provider: 'toss', raw_status: ''
    });
    // 실패해도 치명적이지 않다 — 아래 success 경로가 같은 행을 'paid'로 다시 upsert 한다.
    if (pendingErr) console.error('[payment] pending record failed —', pendingErr.message);
  }

  let tossRes;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    tossRes = await fetch(TOSS_CONFIRM_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, paymentKey, amount: PRO_PRICE_KRW })
    });
    clearTimeout(timer);
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: '결제 승인 시간이 초과되었습니다. 잠시 후 다시 확인해 주세요.' });
    }
    throw e;
  }

  const tossData = await tossRes.json().catch(() => ({}));

  if (!tossRes.ok) {
    const tossErr = (tossData && tossData.message) || '결제 승인에 실패했습니다.';
    const tossCode = (tossData && tossData.code) || '';
    console.error('[payment] toss reject — %s %s for %s', tossCode, tossErr, email);

    if (tossCode === 'ALREADY_PROCESSED_PAYMENT') {
      const { data: existing } = await supabase
        .from('payments').select('email, status').eq('order_id', orderId).maybeSingle();
      /*
       * ★ 이 결제가 지금 요청한 사람의 것인지 반드시 확인한다.
       *   확인하지 않으면 남의 orderId/paymentKey(successUrl 쿼리로 노출됨)를
       *   가져와 자기 계정에 PRO를 켤 수 있다.
       *
       * status는 'paid'(정상 승인 후 subscriptions만 실패했던 경우)뿐 아니라
       * 'pending'(confirm이 타임아웃으로 끊겨 승인 여부를 못 받은 경우, 위에서
       * 미리 기록해 둔 값)도 인정한다. 이메일은 두 경우 모두 Toss를 부르기
       * 전에 우리가 직접 기록한 값이라 위조될 수 없다.
       */
      if (existing && (existing.status === 'paid' || existing.status === 'pending')
          && String(existing.email).toLowerCase() === String(email).toLowerCase()) {
        const expiresAt = new Date(Date.now() + PRO_DURATION_MS).toISOString();
        await supabase.from('payments').update({
          status: 'paid', updated_at: new Date().toISOString()
        }).eq('order_id', orderId);
        await supabase.from('subscriptions').upsert({
          email, plan: 'pro', status: 'active', expires_at: expiresAt,
          provider: 'toss', updated_at: new Date().toISOString()
        }, { onConflict: 'email' });
        return res.json({ success: true, alreadyProcessed: true });
      }
    }
    return res.status(400).json({ error: tossErr, code: tossCode });
  }

  const rawStatus = tossData.status || 'DONE';

  const { error: payErr } = await supabase.from('payments').upsert({
    email,
    order_id: orderId,
    payment_key: paymentKey,
    amount: PRO_PRICE_KRW,
    status: 'paid',
    provider: 'toss',
    raw_status: rawStatus,
    updated_at: new Date().toISOString()
  }, { onConflict: 'order_id' });

  if (payErr) console.error('[payment] payment record failed —', payErr.message);

  const expiresAt = new Date(Date.now() + PRO_DURATION_MS).toISOString();
  const customerKey = 'seosa_' + Buffer.from(email).toString('base64url').slice(0, 32);

  const { error: subErr } = await supabase.from('subscriptions').upsert({
    email,
    plan: 'pro',
    status: 'active',
    expires_at: expiresAt,
    provider: 'toss',
    customer_key: customerKey,
    billing_key: tossData.billingKey || null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'email' });

  if (subErr) {
    console.error('[payment] subscription update failed —', subErr.message);
    return res.status(500).json({ error: '결제는 완료됐지만 구독 활성화에 실패했습니다. 고객센터에 문의해 주세요.' });
  }

  return res.json({ success: true, plan: 'pro', expiresAt });
}

async function getStatus(req, res) {
  const email = extractEmail(req);
  if (!email) {
    return res.status(401).json({ error: '로그인이 필요합니다.', needsAuth: true });
  }

  const { data } = await supabase
    .from('subscriptions')
    .select('email, plan, status, expires_at, provider, canceled_at')
    .eq('email', email)
    .maybeSingle();

  return res.json({ subscription: publicSubscription(data) });
}

async function cancelSubscription(req, res) {
  const email = extractEmail(req);
  if (!email) {
    return res.status(401).json({ error: '로그인이 필요합니다.', needsAuth: true });
  }

  const { error } = await supabase
    .from('subscriptions')
    .update({
      billing_key: null,
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('email', email);

  if (error) {
    console.error('[payment] cancel failed —', error.message);
    return res.status(500).json({ error: '구독 취소에 실패했습니다.' });
  }

  return res.json({ success: true });
}

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'private')) return;
  noStore(res);

  if (!guard(req, res, { name: 'payment', limit: 10, windowMs: 60 * 1000 })) return;

  try {
    if (req.method === 'POST') {
      const { action } = readBody(req);
      if (action === 'confirm') return await confirmPayment(req, res);
      if (action === 'cancel') return await cancelSubscription(req, res);
      return res.status(400).json({ error: '알 수 없는 action입니다.' });
    }

    if (req.method === 'GET') {
      return await getStatus(req, res);
    }

    return res.status(405).json({ error: 'GET 또는 POST만 지원합니다.' });
  } catch (e) {
    console.error('[payment]', e.message);
    res.status(500).json({ error: '결제 처리 중 오류가 발생했습니다.' });
  }
};
