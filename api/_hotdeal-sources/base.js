'use strict';

/**
 * External Hotdeal source adapter contract.
 *
 * Adapters must use an official API, RSS feed, or another explicitly permitted
 * public feed. This layer intentionally contains no generic HTML scraper.
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

function assertAdapter(adapter) {
  if (!adapter || !adapter.id || typeof adapter.fetch !== 'function'
    || typeof adapter.enabled !== 'function') {
    throw new TypeError('invalid hotdeal source adapter');
  }
  return adapter;
}

module.exports = { HotdealSourceAdapter, assertAdapter };
