'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const MAX_TOKEN = 4096;
const MAX_JSON = 16384;
const PREFIX = 'v3s1';
/*
 * 토큰 수명 (2026-11-14). 서명만으로는 «옛 토큰 재사용» 을 막지 못한다 — 서명된 상태는 영원히
 * 유효했다. 답변 서명(turnSig, api/_aicontext TURN_TTL_MS)과 같은 6시간으로 묶는다. 웹 대화는
 * 30분 쉬면 지워지므로 실제 대화가 이 만료에 걸리는 일은 없다. iat 없는(옛) 토큰은 받지 않는다 —
 * v3 는 운영에서 아직 켜진 적이 없어 들고 있는 사용자가 없다.
 */
const STATE_TTL_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function key() {
  const base = process.env.AI_V3_STATE_SECRET || process.env.AUTH_SECRET || process.env.SUPABASE_SECRET_KEY;
  return base ? crypto.createHmac('sha256', String(base)).update('seosa-v3-conversation-state').digest() : null;
}
const str = (x, max) => typeof x === 'string' ? x.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
const price = x => Number.isSafeInteger(x) && x > 0 ? x : null;
const strings = (value, maxItems = 8, maxLength = 55) => Array.isArray(value)
  ? [...new Set(value.map(x => str(x, maxLength)).filter(Boolean))].slice(0, maxItems) : [];

// Only retain small JSON primitives; the plan is untrusted on encode as well.
function bounded(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return str(value, 160);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 8).map(v => bounded(v, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([k]) => /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(k) && !['constructor', 'prototype'].includes(k))
    .slice(0, 32).map(([k,v]) => [k, bounded(v, depth + 1)]));
  return null;
}
function normalize(state = {}) {
  const p = state.userPreferences && typeof state.userPreferences === 'object' ? state.userPreferences : {};
  const b = p.budgetRange && typeof p.budgetRange === 'object' ? p.budgetRange : {};
  return {
    shownProducts: Array.isArray(state.shownProducts) ? state.shownProducts.slice(0, 4).map(p => ({
      id: str(p && (p.id || p.productId), 160), title: str(p && p.title, 140), price: price(p && p.price)
    })).filter(p => p.id && p.title) : [],
    lastQuery: str(state.lastQuery, 80),
    lastPlan: state.lastPlan && typeof state.lastPlan === 'object' ? bounded(state.lastPlan) : null,
    turnCount: Number.isSafeInteger(state.turnCount) && state.turnCount >= 0 ? Math.min(state.turnCount, 1000000) : 0,
    userPreferences: { budgetRange: { min: price(b.min), max: price(b.max) },
      preferredBrands: strings(p.preferredBrands), excludedItems: strings(p.excludedItems) }
  };
}
function sign(k, payload) { return crypto.createHmac('sha256', k).update(PREFIX + '.' + payload).digest(); }
function encodeState(state, now = Date.now()) {
  const k = key();
  if (!k) return null; // No secret means no authenticated client-side state.
  const safe = { ...normalize(state), iat: Math.floor(Number(now) || Date.now()) };
  let payload = zlib.deflateRawSync(Buffer.from(JSON.stringify(safe))).toString('base64url');
  let token = PREFIX + '.' + payload + '.' + sign(k, payload).toString('base64url');
  // Drop optional plan detail rather than ever emitting an oversized token.
  if (Buffer.byteLength(token) > MAX_TOKEN) {
    safe.lastPlan = safe.lastPlan ? { mode: safe.lastPlan.mode, query: safe.lastPlan.query, filters: safe.lastPlan.filters } : null;
    payload = zlib.deflateRawSync(Buffer.from(JSON.stringify(safe))).toString('base64url');
    token = PREFIX + '.' + payload + '.' + sign(k, payload).toString('base64url');
  }
  return Buffer.byteLength(token) <= MAX_TOKEN ? token : null;
}
/**
 * 서명·모양·수명을 모두 통과한 토큰만 상태로 돌려준다. 그 밖은 null.
 * inspectState 는 같은 판정의 «이유» 를 준다(응답 stats·하네스가 쓴다): absent | valid | invalid | expired.
 */
function inspectState(encoded, now = Date.now()) {
  if (encoded == null || encoded === '') return { status: 'absent', state: null };
  const k = key();
  if (!k || typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_TOKEN) return { status: 'invalid', state: null };
  const parts = encoded.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return { status: 'invalid', state: null };
  const actual = Buffer.from(parts[2], 'base64url'), expected = sign(k, parts[1]);
  if (actual.toString('base64url') !== parts[2] || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return { status: 'invalid', state: null };
  try {
    const raw = zlib.inflateRawSync(Buffer.from(parts[1], 'base64url'), { maxOutputLength: MAX_JSON });
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid', state: null };
    const t = Number(now);
    if (!Number.isSafeInteger(parsed.iat) || parsed.iat > t + CLOCK_SKEW_MS || t - parsed.iat > STATE_TTL_MS) {
      return { status: 'expired', state: null };
    }
    return { status: 'valid', state: { ...normalize(parsed), signature: parts[2], iat: parsed.iat } };
  } catch (_) { return { status: 'invalid', state: null }; }
}
function decodeState(encoded, now = Date.now()) {
  return inspectState(encoded, now).state;
}
function updateState(oldState, newTurn = {}) {
  const prev = normalize(oldState || {});
  const prefs = newTurn.userPreferences && typeof newTurn.userPreferences === 'object' ? newTurn.userPreferences : {};
  const budget = prefs.budgetRange && typeof prefs.budgetRange === 'object' ? prefs.budgetRange : {};
  const merge = (old, incoming) => [...new Set([...old, ...strings(incoming)])].slice(-8);
  const next = {
    ...prev,
    shownProducts: Array.isArray(newTurn.shownProducts) ? newTurn.shownProducts : Array.isArray(newTurn.cards) ? newTurn.cards : prev.shownProducts,
    lastQuery: typeof newTurn.lastQuery === 'string' && newTurn.lastQuery ? newTurn.lastQuery : prev.lastQuery,
    lastPlan: newTurn.lastPlan && typeof newTurn.lastPlan === 'object' ? newTurn.lastPlan : prev.lastPlan,
    turnCount: prev.turnCount + 1,
    userPreferences: {
      budgetRange: { min: Object.hasOwn(budget, 'min') ? price(budget.min) : prev.userPreferences.budgetRange.min,
        max: Object.hasOwn(budget, 'max') ? price(budget.max) : prev.userPreferences.budgetRange.max },
      preferredBrands: merge(prev.userPreferences.preferredBrands, prefs.preferredBrands),
      excludedItems: merge(prev.userPreferences.excludedItems, prefs.excludedItems)
    }
  };
  return normalize(next);
}
module.exports = { encodeState, decodeState, inspectState, updateState, STATE_TTL_MS };
