'use strict';

const { assertAdapter } = require('./base');
const { normalizeExternalHotdeal, dedupeByCanonicalUrl } = require('./normalize');

const adapters = new Map();
/**
 * Outer cap per source. Adapters carry their own request timeout; this only
 * guarantees one hung adapter cannot hold the whole collector.
 */
const SOURCE_HARD_TIMEOUT_MS = 20000;

function register(adapter) {
  const a = assertAdapter(adapter);
  if (adapters.has(a.id)) throw new Error(`duplicate hotdeal adapter: ${a.id}`);
  adapters.set(a.id, a);
  return a;
}

function get(id) { return adapters.get(String(id || '')) || null; }
function list() { return [...adapters.values()]; }
function active() { return list().filter(a => { try { return !!a.enabled(); } catch (_) { return false; } }); }

function withHardTimeout(promise, ms, id) {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${id} exceeded ${ms}ms`);
      error.kind = 'timeout';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

/**
 * Fetch every enabled source. A failing source is recorded as degraded and
 * the others continue — provider failure never fails the pipeline.
 */
async function fetchAll(context) {
  const ctx = context || {};
  const rows = [];
  const errors = [];
  const sources = [];
  for (const adapter of active()) {
    const started = Date.now();
    const stat = {
      source: adapter.id, kind: adapter.kind, status: 'ok', errorKind: null,
      httpStatus: null, attempts: null, latencyMs: 0,
      fetched: 0, normalized: 0, duplicates: 0, skipped: {}
    };
    try {
      const raw = await withHardTimeout(Promise.resolve().then(() => adapter.fetch(ctx)),
        ctx.hardTimeoutMs || SOURCE_HARD_TIMEOUT_MS, adapter.id);
      const envelope = Array.isArray(raw) ? { items: raw } : (raw && typeof raw === 'object' ? raw : {});
      const items = Array.isArray(envelope.items) ? envelope.items : [];
      const meta = envelope.meta || {};
      Object.entries(envelope.skipped || {}).forEach(([reason, n]) => {
        stat.skipped[reason] = (stat.skipped[reason] || 0) + (Number(n) || 0);
      });
      if (meta.httpStatus != null) stat.httpStatus = meta.httpStatus;
      if (meta.attempts != null) stat.attempts = meta.attempts;
      stat.fetched = Number.isFinite(meta.rawCount) ? meta.rawCount : items.length;

      const mine = [];
      for (const item of items) {
        const normalized = normalizeExternalHotdeal(item, adapter.id);
        if (normalized) mine.push(normalized);
        else stat.skipped.invalid_contract = (stat.skipped.invalid_contract || 0) + 1;
      }
      const unique = dedupeByCanonicalUrl(mine);
      stat.normalized = mine.length;
      stat.duplicates = mine.length - unique.length;
      rows.push(...unique);
    } catch (error) {
      stat.status = 'degraded';
      stat.errorKind = String((error && error.kind) || 'error');
      if (error && error.httpStatus != null) stat.httpStatus = error.httpStatus;
      if (error && error.attempts != null) stat.attempts = error.attempts;
      errors.push({ source: adapter.id, kind: stat.errorKind,
        message: String((error && error.message) || error).slice(0, 200) });
    }
    stat.latencyMs = Date.now() - started;
    sources.push(stat);
  }
  return { items: dedupeByCanonicalUrl(rows), errors, sources };
}

// Live sources stay disabled unless their own env flag is set. Public exposure
// is a separate decision (scripts/collect-external-hotdeals.js, api/hotdeals.js).
register(require('./adapters/mock'));
register(require('./adapters/ppomppu'));

module.exports = { register, get, list, active, fetchAll, SOURCE_HARD_TIMEOUT_MS };
