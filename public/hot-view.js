/* Presentation only. Status and reasons come from /api/hotdeals. */
(function (root) {
  'use strict';
  var labels = { VERIFIED_HOT: '가격 검증됨', GOOD_DEAL: '좋은 가격', POTENTIAL_DEAL: '추가 확인 중' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function url(v) {
    try { var u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (_) { return ''; }
  }
  function price(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v.toLocaleString('ko-KR') + '원' : '가격 확인 중'; }
  function time(v) {
    var t = new Date(v), age = Date.now() - t.getTime();
    if (!v || !Number.isFinite(age) || age < 0) return '';
    var text = age < 3600000 ? '1시간 이내 확인' : age < 86400000 ? Math.floor(age / 3600000) + '시간 전 확인' : t.toLocaleDateString('ko-KR') + ' 확인';
    return '<time datetime="' + t.toISOString() + '" title="' + esc(t.toLocaleString('ko-KR')) + '">' + text + '</time>';
  }
  function card(d) {
    if (!d || !d.title || d.id == null) return '';
    var image = url(d.image);
    return '<a class="hot-card" href="/hotdeals.html?id=' + encodeURIComponent(d.id) + '">'
      + '<div class="hot-media">' + (image ? '<img class="hot-thumb" src="' + esc(image) + '" alt="' + esc(d.title) + '" loading="lazy" decoding="async" width="320" height="320">' : '<span>이미지 준비 중</span>') + '</div>'
      + '<h3 class="hot-name">' + esc(d.title) + '</h3>'
      + '<div class="hot-price">' + price(d.price) + '</div>'
      + (d.reason ? '<p class="hot-why' + (d.status === 'POTENTIAL_DEAL' ? ' is-soft' : '') + '">' + esc(d.reason) + '</p>' : '')
      + '<span class="hot-badge' + (d.status === 'POTENTIAL_DEAL' ? ' is-potential' : '') + '">' + esc(labels[d.status] || '추가 확인 중') + '</span>'
      + '<div class="hot-meta">' + (d.mall ? '<span>' + esc(d.mall) + '</span>' : '') + time(d.checkedAt) + '</div></a>';
  }
  root.HotView = { esc: esc, url: url, price: price, time: time, card: card, labels: labels };
  if (typeof module !== 'undefined') module.exports = root.HotView;
})(typeof window !== 'undefined' ? window : globalThis);
