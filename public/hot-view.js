/* Presentation only. Status and reasons come from /api/hotdeals.
 *
 * ── 값을 다루는 단 하나의 규칙 ──────────────────────────────────────
 *
 *   null 은 «모름» 이다. 0 이 아니다.
 *
 * /api/hotdeals 는 근거가 없는 신호를 0 으로 채우지 않고 null 로 준다
 * (api/_hotdeal.signalsOf). 화면도 같은 규칙을 지켜야 한다 — null 을 0 으로
 * 바꾸는 순간 "0원 내렸다" · "가격 기록 0회" 같은, 서버가 하지 않은 말을
 * 화면이 하게 된다. 아래 num() 이 그 경계다. 숫자가 아니면 무조건 null 이고,
 * null 이면 그 줄을 통째로 그리지 않는다.
 *
 * 없는 가격도, 없는 할인율도 만들지 않는다.
 */
(function (root) {
  'use strict';
  var labels = { VERIFIED_HOT: '가격 검증됨', GOOD_DEAL: '좋은 가격', POTENTIAL_DEAL: '추가 확인 중' };

  /* 할인율의 기준이 무엇이었는지. signals.referenceKind 와 짝이다. */
  var refLabels = { median30: '최근 30일 중앙값', median: '관측 중앙값', previous: '직전 확인 가격' };

  /* 마지막 확인이 얼마나 오래됐는가. api/_hotdeal.FRESHNESS 와 짝이다.
   * fresh · recent 는 굳이 말하지 않는다 — 정상이라 말할 것이 없다. */
  var staleNotes = { aging: '확인한 지 며칠 지났어요', stale: '확인이 오래돼 지금 가격과 다를 수 있어요' };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function url(v) {
    try { var u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (_) { return ''; }
  }
  function price(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v.toLocaleString('ko-KR') + '원' : '가격 확인 중'; }

  /** ★ 숫자가 아니면 null. 문자열 '0' 도, NaN 도, undefined 도 전부 «모름» 이다. */
  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  /** 금액. 모르면 빈 문자열 — 부르는 쪽이 그 줄을 통째로 뺀다. */
  function won(v) { var n = num(v); return n == null ? '' : n.toLocaleString('ko-KR') + '원'; }
  /** 소수 한 자리까지. 서버가 이미 반올림해 주지만 방어적으로 한 번 더 자른다. */
  function pct(v) { var n = num(v); return n == null ? '' : (Math.round(n * 10) / 10) + '%'; }

  function time(v) {
    var t = new Date(v), age = Date.now() - t.getTime();
    if (!v || !Number.isFinite(age) || age < 0) return '';
    var text = age < 3600000 ? '1시간 이내 확인' : age < 86400000 ? Math.floor(age / 3600000) + '시간 전 확인' : t.toLocaleDateString('ko-KR') + ' 확인';
    return '<time datetime="' + t.toISOString() + '" title="' + esc(t.toLocaleString('ko-KR')) + '">' + text + '</time>';
  }

  /**
   * 얼마나 내려갔는지. signals.priceDropAmount · priceDropPercent.
   *
   * ★ 오른 상품에는 아무 말도 하지 않는다. 서버는 값이 올랐을 때 percent 를
   *   음수로, amount 를 null 로 준다. 음수 하락률을 "-3% 할인"처럼 뒤집어
   *   보여 주면 그건 없는 할인을 만드는 것이다.
   */
  function drop(s) {
    if (!s) return '';
    var amount = num(s.priceDropAmount), percent = num(s.priceDropPercent);
    var parts = [];
    if (amount != null && amount > 0) parts.push(won(amount) + ' ↓');
    if (percent != null && percent > 0) parts.push(pct(percent));
    if (!parts.length) return '';

    /* 무엇과 견준 값인지 밝힌다. 기준을 숨긴 할인율은 쇼핑몰이 하는 짓이다. */
    var ref = num(s.referencePrice), label = refLabels[s.referenceKind] || '';
    var hint = (ref != null && ref > 0 && label) ? label + ' ' + won(ref) + ' 대비' : '';
    return '<p class="hot-drop"' + (hint ? ' title="' + esc(hint) + '"' : '') + '>'
      + esc(parts.join(' · ')) + (hint ? '<span class="hot-ref"> ' + esc(label) + ' 대비</span>' : '') + '</p>';
  }

  /**
   * 근거의 두께. 사용자가 이 숫자를 얼마나 믿어도 되는지의 재료다.
   * 하나도 없으면 빈 문자열 — 빈 껍데기를 그리지 않는다.
   */
  function evidence(s) {
    if (!s) return '';
    var out = [];
    if (s.nearHistoricalLow === true) out.push('<span class="hot-tag">최근 최저가 근처</span>');
    var count = num(s.historyCount), days = num(s.historyDays);
    if (count != null && count > 0) {
      out.push('<span class="hot-tag">가격 기록 ' + count + '회'
        + (days != null && days > 0 ? ' · ' + days + '일' : '') + '</span>');
    }
    var note = staleNotes[s.freshness];
    if (note) out.push('<span class="hot-tag is-warn">' + esc(note) + '</span>');
    return out.length ? '<div class="hot-tags">' + out.join('') + '</div>' : '';
  }

  /**
   * 현재 최저가 판매처.
   *
   * ★ isLowest === false 는 «이 카드보다 싼 곳이 있다» 는 뜻이다. 그 사실을
   *   숨기고 이 판매처를 주 구매처처럼 보여 주면 사용자를 더 비싼 곳으로
   *   보내게 된다. 그래서 값을 그대로 밝힌다.
   *
   * ★ 묶인 오퍼가 하나뿐이면(offerCount ≤ 1) 아무 말도 하지 않는다.
   *   grouped:false(마이그레이션 전)에서도 서버가 offerCount 1 로 떨어뜨리므로
   *   이 조건 하나로 두 경우가 함께 안전해진다.
   */
  function offers(d) {
    var count = num(d.offerCount);
    if (count == null || count <= 1) return '';

    if (d.isLowest === false) {
      var low = won(d.lowestPrice), mall = d.lowestMall ? String(d.lowestMall) : '';
      var text = mall ? mall + (low ? ' ' + low : '') + ' 더 저렴' : '더 저렴한 판매처 있음';
      return '<span class="hot-alt">' + esc(text) + '</span>';
    }
    var others = num(d.otherOfferCount);
    return '<span class="hot-low">최저가' + (d.mall ? ' · ' + esc(d.mall) : '') + '</span>'
      + (others != null && others > 0 ? '<span>다른 판매처 ' + others + '곳</span>' : '');
  }

  /*
   * 카드 하나. 3초 안에 읽히는 순서로 쌓는다.
   *   상품 → 현재 가격 → 얼마나 내려갔는지 → 왜 → 근거의 두께
   *   → 최저가 판매처 → 마지막 확인
   */
  function card(d) {
    if (!d || !d.title || d.id == null) return '';
    var image = url(d.image), s = d.signals;
    return '<a class="hot-card" href="/hotdeals.html?id=' + encodeURIComponent(d.id) + '">'
      + '<div class="hot-media">' + (image ? '<img class="hot-thumb" src="' + esc(image) + '" alt="' + esc(d.title) + '" loading="lazy" decoding="async" width="320" height="320">' : '<span>이미지 준비 중</span>') + '</div>'
      + '<h3 class="hot-name">' + esc(d.title) + '</h3>'
      + '<div class="hot-price">' + price(d.price) + '</div>'
      + drop(s)
      + (d.reason ? '<p class="hot-why' + (d.status === 'POTENTIAL_DEAL' ? ' is-soft' : '') + '">' + esc(d.reason) + '</p>' : '')
      + evidence(s)
      + '<span class="hot-badge' + (d.status === 'POTENTIAL_DEAL' ? ' is-potential' : '') + '">' + esc(labels[d.status] || '추가 확인 중') + '</span>'
      + '<div class="hot-meta">' + (d.mall ? '<span>' + esc(d.mall) + '</span>' : '') + offers(d) + time(d.checkedAt) + '</div></a>';
  }

  root.HotView = {
    esc: esc, url: url, price: price, time: time, card: card, labels: labels,
    num: num, won: won, pct: pct, drop: drop, evidence: evidence, offers: offers,
    refLabels: refLabels, staleNotes: staleNotes
  };
  if (typeof module !== 'undefined') module.exports = root.HotView;
})(typeof window !== 'undefined' ? window : globalThis);
