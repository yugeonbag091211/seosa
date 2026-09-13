'use strict';

/**
 * External Hotdeal source adapter contract.
 *
 * Adapters must use an official API, RSS feed, or another explicitly permitted
 * public feed. This layer intentionally contains no generic HTML scraper.
 *
 * fetch() returns either
 *   - an array of raw rows (legacy/mock), or
 *   - { items, skipped: { reason: count }, meta: { httpStatus, attempts, rawCount } }
 * so the registry can report why provider rows never reached matching.
 */
class HotdealSourceAdapter {
  constructor(options) {
    const o = options || {};
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(String(o.id || ''))) {
      throw new Error('adapter id must be a stable kebab-case identifier');
    }
    this.id = o.id;
    this.label = String(o.label || o.id);
    this.kind = String(o.kind || 'feed');
  }

  enabled() { return false; }

  // Subclasses return raw provider rows. Normalization is deliberately central.
  async fetch() { return []; }
}

/**
 * Provider failure, classified so a degraded source can say why.
 *   timeout | network | http_429 | http_4xx | http_5xx | parse | too_large | local_rate_limit
 */
class SourceError extends Error {
  constructor(kind, message, extra) {
    super(message || kind);
    this.name = 'SourceError';
    this.kind = String(kind || 'unknown');
    Object.assign(this, extra || {});
  }
}

function assertAdapter(adapter) {
  if (!adapter || !adapter.id || typeof adapter.fetch !== 'function'
    || typeof adapter.enabled !== 'function') {
    throw new TypeError('invalid hotdeal source adapter');
  }
  return adapter;
}

module.exports = { HotdealSourceAdapter, SourceError, assertAdapter };
