'use strict';
/*
 * 아주 가벼운 인메모리 레이트리미터.
 *
 * 서버리스라 인스턴스마다 카운터가 따로 놀기 때문에 완벽한 방어는 아니다.
 * 다만 Vercel은 트래픽이 있으면 인스턴스를 재사용하므로, 한 곳에서 쏟아지는
 * 반복 호출(= 네이버/쿠팡 일일 쿼터와 Supabase 쓰기 비용을 태우는 패턴)은
 * 실제로 대부분 걸러진다. 전역 정확도가 필요해지면 Vercel KV / Upstash로 교체할 것.
 */

const buckets = new Map();   // key → { count, resetAt }
const MAX_KEYS = 5000;       // 메모리 누수 방지 상한

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || ''))
    .split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  return ip;
}

function sweep(now) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

/**
 * @returns {{ok: boolean, retryAfter: number}}
 */
function check(req, { limit, windowMs, name = '' }) {
  const now = Date.now();
  const key = name + '|' + clientKey(req);

  // 상한을 넘으면 만료된 것부터 정리하고, 그래도 넘치면 새 키를 받지 않는다.
  if (buckets.size > MAX_KEYS) sweep(now);

  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }

  b.count++;
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/**
 * 초과하면 429로 응답하고 false를 돌려준다.
 * 핸들러에서:  if (!guard(req, res, {...})) return;
 */
function guard(req, res, opts) {
  const r = check(req, opts);
  if (r.ok) return true;

  res.setHeader('Retry-After', String(r.retryAfter));
  res.status(429).json({
    error: `요청이 너무 잦아요. ${r.retryAfter}초 후 다시 시도해 주세요.`
  });
  return false;
}

module.exports = { guard, check };
