'use strict';
/*
 * ADPICK short-lived in-process cache (20s, 128 entries).
 * A supplementary cache when the shared DB cache write is delayed/unavailable.
 * Only successful provider API results are reused. No stale, failed, or
 * simulated response. Never used for collector or forced refresh requests.
 */
const KST_SHIFT_MS = 9 * 60 * 60 * 1000;
const dayKey = now => new Date(now + KST_SHIFT_MS).toISOString().slice(0, 10);
function createHotCache({ now = Date.now, ttlMs = 20000, maxEntries = 128 } = {}) {
  const entries = new Map();
  const duration = Math.min(30000, Math.max(1, Number(ttlMs) || 20000));
  const capacity = Math.min(256, Math.max(1, Math.floor(Number(maxEntries) || 128)));
  const requestedTtl = opts => opts.cacheTtlMs == null ? duration : Math.max(0, Number(opts.cacheTtlMs) || 0);
  const permitted = opts => !!opts && opts.useCache !== false && opts.forceRefresh !== true
    && (opts.source === 'search' || opts.source === 'ai');
  const keyword = kw => String(kw || '').trim().slice(0, 80);
  const limit = opts => Math.min(20, Math.max(1, Math.floor(Number(opts.limit) || 10)));
  function get(kw, opts) {
    if (!permitted(opts)) return null;
    const k = keyword(kw), entry = entries.get(k);
    if (!k || !entry) return null;
    const t = now();
    const age = t - entry.at;
    if (age < 0 || age >= Math.min(duration, entry.ttl) || dayKey(t) !== entry.day) {
      entries.delete(k); return null;
    }
    // A stricter reader must not evict another caller's still-valid entry.
    if (age >= requestedTtl(opts) || limit(opts) > entry.coverage) return null;
    return {items: entry.items.slice(0,limit(opts)).map(it=>({...it})),
      from:'cache', error:null, blocked:false, apiCalled:false, hotCache:true};
  }
  function put(kw, opts, result) {
    if (!permitted(opts) || requestedTtl(opts) <= 0 || !result || result.from !== 'api' ||
        result.blocked || result.error || !Array.isArray(result.items)) return false;
    const k = keyword(kw);
    if (!k) return false;
    const t = now();
    const coverage = limit(opts);
    if (entries.has(k)) entries.delete(k);
    while (entries.size >= capacity) entries.delete(entries.keys().next().value);
    entries.set(k,{at:t,day:dayKey(t),ttl:Math.min(duration,requestedTtl(opts)),coverage,items:result.items.map(it=>({...it}))});
    return true;
  }
  return {get, put, size:()=>entries.size};
}
module.exports={createHotCache};
