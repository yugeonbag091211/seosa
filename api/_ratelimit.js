'use strict';
/*
 * Two-layer rate limiting.
 *
 * 1) Local Map: cheap first line of defense inside one Vercel instance.
 * 2) Supabase RPC: shared fixed-window counter for cost/security-sensitive APIs.
 *
 * The distributed layer stores only an HMAC-SHA256 subject hash, never a raw IP.
 * If Supabase is temporarily unavailable we fail over to the local limiter so a
 * database incident does not take down every API route.
 */

const crypto = require('crypto');
const supabase = require('./_supabase');

const buckets = new Map();   // key -> { count, resetAt }
const MAX_KEYS = 5000;

function clientKey(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || ''))
    .split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  return ip;
}

function sweep(now) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

function check(req, { limit, windowMs, name = '' }) {
  const now = Date.now();
  const key = name + '|' + clientKey(req);

  if (buckets.size > MAX_KEYS) sweep(now);

  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }

  b.count++;
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

function reject(res, retryAfter) {
  const sec = Math.max(1, Number(retryAfter) || 1);
  res.setHeader('Retry-After', String(sec));
  res.status(429).json({
    error: `요청이 너무 잦아요. ${sec}초 후 다시 시도해 주세요.`
  });
  return false;
}

function guard(req, res, opts) {
  const r = check(req, opts);
  return r.ok ? true : reject(res, r.retryAfter);
}

function hashSubject(req, name) {
  const base = process.env.RATE_LIMIT_SECRET
    || process.env.AUTH_SECRET
    || process.env.SUPABASE_SECRET_KEY
    || 'seosa-rate-limit-fallback';
  return crypto.createHmac('sha256', base)
    .update(String(name || '') + '|' + clientKey(req))
    .digest('hex');
}

function normalizeRpcRow(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.allowed !== 'boolean') return null;
  return {
    ok: row.allowed,
    retryAfter: Math.max(1, Number(row.retry_after) || 1),
    remaining: Math.max(0, Number(row.remaining) || 0)
  };
}

/**
 * Shared limiter for endpoints where bypassing an instance-local Map has a
 * real cost or abuse impact. Local rejection happens before the RPC.
 *
 * @returns {Promise<boolean>}
 */
async function guardGlobal(req, res, opts) {
  const local = check(req, opts);
  if (!local.ok) return reject(res, local.retryAfter);

  // Tests/dev without Supabase stay usable and keep the local limit.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return true;

  try {
    const { data, error } = await supabase.rpc('security_rate_limit', {
      p_bucket: String(opts.name || 'api').slice(0, 80),
      p_subject_hash: hashSubject(req, opts.name || 'api'),
      p_limit: Number(opts.limit),
      p_window_ms: Number(opts.windowMs)
    });
    if (error) throw error;

    const global = normalizeRpcRow(data);
    if (!global) throw new Error('invalid security_rate_limit response');
    if (!global.ok) return reject(res, global.retryAfter);
    return true;
  } catch (e) {
    // Do not echo database details to users. The local limiter remains active.
    console.warn(`[ratelimit:${opts.name || 'api'}] shared limiter unavailable; local fallback: ${e && e.message}`);
    return true;
  }
}

module.exports = { guard, guardGlobal, check, clientKey, hashSubject, normalizeRpcRow };
