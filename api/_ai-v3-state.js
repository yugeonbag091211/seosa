'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const MAX_TOKEN = 4096;
const MAX_JSON = 16384;
const PREFIX = 'v3s1';

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
function encodeState(state) {
  const k = key();
  if (!k) return null; // No secret means no authenticated client-side state.
  const safe = normalize(state);
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
function decodeState(encoded) {
  const k = key();
  if (!k || typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_TOKEN) return null;
  const parts = encoded.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
  const actual = Buffer.from(parts[2], 'base64url'), expected = sign(k, parts[1]);
  if (actual.toString('base64url') !== parts[2] || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const raw = zlib.inflateRawSync(Buffer.from(parts[1], 'base64url'), { maxOutputLength: MAX_JSON });
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { ...normalize(parsed), signature: parts[2] };
  } catch (_) { return null; }
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
module.exports = { encodeState, decodeState, updateState };
