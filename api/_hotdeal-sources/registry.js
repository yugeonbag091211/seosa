'use strict';

const { assertAdapter } = require('./base');
const { normalizeExternalHotdeal, dedupeByCanonicalUrl } = require('./normalize');

const adapters = new Map();

function register(adapter) {
  const a = assertAdapter(adapter);
  if (adapters.has(a.id)) throw new Error(`duplicate hotdeal adapter: ${a.id}`);
  adapters.set(a.id, a);
  return a;
}

function get(id) { return adapters.get(String(id || '')) || null; }
function list() { return [...adapters.values()]; }
function active() { return list().filter(a => { try { return !!a.enabled(); } catch (_) { return false; } }); }

async function fetchAll(context) {
  const rows = [];
  const errors = [];
  for (const adapter of active()) {
    try {
      const raw = await adapter.fetch(context || {});
      for (const item of Array.isArray(raw) ? raw : []) {
        const normalized = normalizeExternalHotdeal(item, adapter.id);
        if (normalized) rows.push(normalized);
      }
    } catch (error) {
      errors.push({ source: adapter.id, message: String(error && error.message || error) });
    }
  }
  return { items: dedupeByCanonicalUrl(rows), errors };
}

// No live community source is enabled until its official feed and terms are verified.
register(require('./adapters/mock'));

module.exports = { register, get, list, active, fetchAll };
