(function (root) {
  'use strict';
  var KEY = 'seosa_wishlist';
  function read() {
    try { var value = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(value) ? value : []; }
    catch (_) { return []; }
  }
  function write(items) { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (_) {} return items; }
  function key(p) { return String((p && p.productId) || '') + '|' + String((p && p.mall) || '') || String((p && p.title) || ''); }
  function same(a, b) { return a && b && ((a.productId && b.productId && String(a.productId) === String(b.productId) && String(a.mall || '') === String(b.mall || '')) || (!a.productId && !b.productId && a.title === b.title && a.mall === b.mall)); }
  function find(product) { return read().find(function (x) { return same(x, product); }) || null; }
  function toggle(product) {
    var items = read(), index = items.findIndex(function (x) { return same(x, product); });
    if (index > -1) { items.splice(index, 1); write(items); return { saved: false, items: items }; }
    var price = Number(product.price || product.lprice) || 0;
    items.unshift({ title: String(product.title || ''), productId: String(product.productId || ''), mall: String(product.mall || ''), mallLabel: String(product.mallLabel || product.mall || ''), price: price, currentPrice: price, savedPrice: price, link: String(product.link || product.url || ''), image: String(product.image || ''), savedAt: Date.now(), targetPrice: null, verdict: product.verdict || '', verdictLabel: product.verdictLabel || '', verdictReason: product.verdictReason || '' });
    write(items); return { saved: true, items: items };
  }
  function target(product, value) {
    var items = read(), item = items.find(function (x) { return same(x, product); });
    if (!item) return false;
    var price = Number(value); item.targetPrice = Number.isFinite(price) && price > 0 ? Math.round(price) : null;
    write(items); return true;
  }
  function classify(item) {
    var current = Number(item.currentPrice || item.price) || 0, saved = Number(item.savedPrice || item.price) || 0, targetPrice = Number(item.targetPrice) || 0;
    if (targetPrice > 0 && current > 0 && current <= targetPrice) return 'target';
    if (saved > 0 && current > 0 && current < saved) return 'drop';
    return 'watch';
  }
  root.RadarStore = { KEY: KEY, read: read, write: write, key: key, same: same, find: find, toggle: toggle, target: target, classify: classify };
  if (typeof module !== 'undefined') module.exports = root.RadarStore;
})(typeof window !== 'undefined' ? window : globalThis);
