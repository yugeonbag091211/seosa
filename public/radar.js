/*
 * 내 레이더 — 저장한 상품의 «지금 상태».
 *
 * ── 판단은 서버가 한다 ────────────────────────────────────────────
 *
 * 이 파일은 그리기만 한다. BUY/WAIT/WATCH·목표가 도달·가격 변화·좋은 가격은
 * 전부 POST /api/radar 가 정하고(api/_radar.js) 여기서는 되풀이하지 않는다.
 * 두 곳에서 판단하면 목록과 상품 상세가 서로 다른 말을 하게 된다.
 *
 * 예전 이 파일에는 RadarStore.classify() 로 target/drop/watch 를 «직접»
 * 나누는 코드가 있었다. 그런데 저장 시점에 박아 둔 currentPrice 를 아무도
 * 갱신하지 않아서 current === saved 가 늘 참이었고, 그래서 "가격이
 * 내려갔어요" 는 한 번도 뜰 수 없었다. 이제 현재가는 서버가 준다.
 *
 * ── null 은 «모름» 이다 ───────────────────────────────────────────
 *
 * 서버는 근거가 없는 값을 0 이 아니라 null 로 준다. 화면도 같은 규칙을
 * 지킨다 — null 이면 그 줄을 통째로 그리지 않는다. 0 으로 바꾸는 순간
 * "0원 내렸다"·"좋은 가격 0원" 같은, 서버가 하지 않은 말을 하게 된다.
 */
(function () {
  'use strict';
  var R = window.RadarStore, $ = function (id) { return document.getElementById(id); };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function url(v) { try { var u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (_) { return ''; } }
  /** ★ 숫자가 아니면 null. 문자열 '0' 도 NaN 도 undefined 도 전부 «모름» 이다. */
  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function won(v) { var n = num(v); return n == null || n <= 0 ? '' : n.toLocaleString('ko-KR') + '원'; }
  function price(v) { return won(v) || '가격 확인 중'; }

  /**
   * 계측.
   *
   * ★ 링크를 가로채지 않는다. keepalive 로 보내고 이동은 브라우저에 맡긴다 —
   *   가운데 클릭·새 탭·키보드 이동을 막으면 안 된다.
   * ★ 이름은 api/_funnel.js 의 FUNNEL_EVENTS 와 같아야 상품 단위 행까지 남는다.
   */
  function track(name, extra) {
    try {
      var q = '/api/stats?event=' + encodeURIComponent(name);
      var e = extra || {};
      if (e.productId) q += '&pid=' + encodeURIComponent(e.productId);
      if (e.mall) q += '&mall=' + encodeURIComponent(e.mall);
      if (num(e.price) > 0) q += '&price=' + encodeURIComponent(String(Math.round(e.price)));
      q += '&src=radar';
      fetch(q, { keepalive: true }).catch(function () {});
    } catch (_) { /* 계측이 화면을 막지 않는다 */ }
  }

  /* ── 서버 응답을 저장 목록에 붙여 둔 것 ──────────────────────── */
  var state = new Map();     // key → 서버가 준 항목
  var loadError = false;

  function keyOf(x) { return String(x.productId || '') + '|' + String(x.mall || ''); }

  /*
   * ── 이미 본 변화는 다시 «새 소식» 이 아니다 ─────────────────────
   *
   * events[] 는 «저장할 때 본 값(seenPrice)» 과 지금을 견준 결과다. 화면을
   * 새로고침해도 seenPrice 가 그대로면 같은 이벤트가 계속 나온다 — 그러면
   * 어제 본 하락이 매번 새 일처럼 보인다. 그건 가짜 긴박감이다.
   *
   * 그래서 «확인함» 을 누르면 지금 값을 seenPrice 로 옮겨 적는다. 다음부터
   * 그 값과 견주므로 같은 변화는 두 번 뜨지 않고, 이후 진짜로 또 움직이면
   * 그때 다시 뜬다. 판정은 서버가 하고 기준점만 사용자가 옮기는 구조다.
   */
  function markSeen(item, serverItem) {
    var items = R.read();
    var row = items.filter(function (x) { return R.same(x, item); })[0];
    if (!row) return;
    if (num(serverItem.currentPrice) > 0) { row.seenPrice = serverItem.currentPrice; row.currentPrice = serverItem.currentPrice; }
    if (serverItem.decision) row.seenDecision = serverItem.decision;
    R.write(items);
  }

  var EVENT_LABEL = {
    TARGET_PRICE_REACHED: '목표가격 도달',
    PRICE_DROP: '가격 하락',
    PRICE_RISE: '가격 상승',
    NEW_LOW: '새로운 최저가',
    DECISION_BUY: '지금 사도 좋음으로 바뀜',
    HOT_DEAL: 'SEOSA 핫딜',
    CHEAPER_MALL: '더 싼 판매처'
  };
  /* 사용자를 다시 오게 하는 «좋은» 변화. 상승은 알리되 강조하지 않는다. */
  var GOOD = ['TARGET_PRICE_REACHED', 'PRICE_DROP', 'NEW_LOW', 'DECISION_BUY', 'HOT_DEAL', 'CHEAPER_MALL'];

  function eventsHTML(d) {
    var list = Array.isArray(d.events) ? d.events : [];
    if (!list.length) return '';
    return '<ul class="events">' + list.map(function (e) {
      var label = EVENT_LABEL[e.type] || '';
      var good = GOOD.indexOf(e.type) > -1;
      return '<li class="ev' + (good ? ' is-good' : '') + '">'
        + (label ? '<b>' + esc(label) + '</b> ' : '') + esc(e.text || '') + '</li>';
    }).join('') + '</ul>';
  }

  /**
   * 판정 + 근거의 상태.
   *
   * ★ dataState 를 숨기지 않는다. 기록이 부족하거나 오래된 판정을 확신에 찬
   *   문장으로 보여 주면, 사용자는 우리가 모르는 것을 안다고 믿는다.
   */
  function decisionHTML(d) {
    if (!d.decision) return '';
    var cls = { BUY: 'is-buy', WAIT: 'is-wait', WATCH: 'is-watch' }[d.decision] || '';
    var note = '';
    if (d.dataState === 'INSUFFICIENT') note = '<span class="soft">가격 기록이 아직 부족해요</span>';
    else if (d.dataState === 'STALE') note = '<span class="soft">최근 가격을 확인하지 못했어요</span>';
    var out = '<div class="decision ' + cls + '"><b>' + esc(d.decisionLabel || d.decision) + '</b>'
      + (note ? ' ' + note : '') + '</div>';
    /* 근거가 충분할 때만 이유를 단정적으로 적는다. */
    if (d.reason && d.dataState === 'SUFFICIENT') out += '<p class="why">' + esc(d.reason) + '</p>';
    (d.cautions || []).slice(0, 1).forEach(function (c) { out += '<p class="why soft">' + esc(c) + '</p>'; });
    return out;
  }

  /** 얼마면 좋은 가격인가. 서버가 null 이면 영역 전체를 그리지 않는다. */
  function goodBuyHTML(d) {
    var g = num(d.goodBuyPrice);
    if (g == null || g <= 0) return '';
    return '<div class="goodbuy"><b>' + esc(won(g)) + ' 이하라면 좋은 가격</b>'
      + (d.goodBuyExplain ? '<span class="soft">' + esc(d.goodBuyExplain) + '</span>' : '')
      + '<button type="button" class="quiet" data-action="use-goodbuy" data-price="' + esc(String(g))
      + '">이 가격을 목표로</button></div>';
  }

  /** 단위 가격. 제목을 여기서 다시 파싱하지 않는다 — 서버가 확실할 때만 준다. */
  function unitHTML(d) {
    var u = d.unit;
    if (!u || num(u.unitPrice) == null || u.unitPrice <= 0 || !u.unit) return '';
    return '<span class="unit">' + esc(u.unit + '당 ' + won(u.unitPrice)) + '</span>';
  }

  /** 더 싼 판매처. isLowest 대신 서버가 준 lowestPrice 로만 말한다. */
  function lowestHTML(d) {
    var lp = num(d.lowestPrice), cur = num(d.currentPrice);
    if (lp == null || cur == null || lp >= cur) return '';
    return '<div class="cheaper">' + esc((d.lowestMall || '다른 판매처') + ' ' + won(lp) + '에서 더 저렴해요') + '</div>';
  }

  function itemHTML(d, saved) {
    var img = url(d.image);
    var cur = num(d.currentPrice), seen = num(d.seenPrice), target = num(d.targetPrice);
    var detail = d.productId ? '/p/' + encodeURIComponent(d.productId) + '?mall=' + encodeURIComponent(d.mall || '') : '';
    var buy = url(d.url) || url(saved && saved.link);

    var change = '';
    if (cur != null && seen != null && cur !== seen) {
      change = '<div class="change">저장할 때 ' + esc(won(seen)) + ' → 지금 ' + esc(won(cur)) + '</div>';
    }

    return '<article class="radar-item" data-key="' + esc(keyOf(d)) + '">'
      + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" width="76" height="76">'
             : '<span class="placeholder">이미지 없음</span>')
      + '<div class="body">'
      +   '<div class="item-name">' + esc(d.title || (saved && saved.title) || '') + '</div>'
      +   '<div class="item-price">' + esc(price(cur)) + unitHTML(d) + '</div>'
      +   change
      +   (target != null && cur != null && d.targetReached
            ? '<div class="target-reached">목표 ' + esc(won(target)) + '에 도달했어요</div>' : '')
      +   eventsHTML(d)
      +   decisionHTML(d)
      +   goodBuyHTML(d)
      +   lowestHTML(d)
      +   '<form class="target-form"><label>원하는 가격'
      +     '<input name="target" type="number" inputmode="numeric" min="1" step="1" value="'
      +       (target != null ? esc(String(target)) : '')
      +       '" placeholder="예: 200000" aria-label="' + esc(d.title || '') + ' 목표 가격"></label>'
      +     '<button type="submit">' + (target != null ? '수정' : '설정') + '</button>'
      +     (target != null ? '<button type="button" data-action="target-delete">삭제</button>' : '')
      +   '</form>'
      + '</div>'
      + '<div class="actions">'
      +   (detail ? '<a class="button" href="' + esc(detail) + '" data-action="detail">가격 판단</a>' : '')
      +   (buy ? '<a class="button primary" data-affiliate href="' + esc(buy)
              + '" target="_blank" rel="sponsored nofollow noopener">구매처 확인</a>' : '')
      +   ((d.events || []).length ? '<button class="quiet" data-action="seen">확인함</button>' : '')
      +   '<button class="quiet" data-action="remove">저장 취소</button>'
      + '</div></article>';
  }

  /* ── 그리기 ──────────────────────────────────────────────────── */

  function render() {
    var saved = R.read();
    $('empty').hidden = saved.length > 0;
    if (!saved.length) { $('sections').innerHTML = ''; $('summary').textContent = ' '; return; }

    if (loadError) {
      $('summary').textContent = '가격을 불러오지 못했어요.';
      $('sections').innerHTML = '<p class="load-error">지금은 최신 가격을 확인할 수 없어요. '
        + '<button class="quiet" data-action="retry">다시 시도</button></p>'
        + saved.map(function (x) {
          return itemHTML({ productId: x.productId, mall: x.mall, title: x.title, image: x.image,
            currentPrice: num(x.currentPrice) || num(x.price), url: x.link,
            targetPrice: num(x.targetPrice), events: [] }, x);
        }).join('');
      return;
    }

    /*
     * 갈래는 서버가 준 이벤트·판정으로만 나눈다.
     *   변화 있음 → 지금 사도 좋음 → 지켜보는 중
     * 화면에서 다시 계산하지 않는다.
     */
    var groups = { change: [], buy: [], watch: [] };
    saved.forEach(function (x) {
      var d = state.get(keyOf(x));
      if (!d) { groups.watch.push({ d: { productId: x.productId, mall: x.mall, title: x.title,
        image: x.image, currentPrice: num(x.currentPrice) || num(x.price), url: x.link,
        targetPrice: num(x.targetPrice), events: [] }, saved: x }); return; }
      var actionable = (d.events || []).some(function (e) { return GOOD.indexOf(e.type) > -1; });
      if (actionable) groups.change.push({ d: d, saved: x });
      else if (d.decision === 'BUY') groups.buy.push({ d: d, saved: x });
      else groups.watch.push({ d: d, saved: x });
    });

    var n = groups.change.length;
    $('summary').textContent = n
      ? n + '개 상품에 가격 변화가 있어요.'
      : saved.length + '개 상품을 지켜보고 있어요.';

    var labels = { change: '가격에 변화가 있어요', buy: '지금 사도 좋아요', watch: '지켜보는 상품' };
    $('sections').innerHTML = ['change', 'buy', 'watch'].map(function (k) {
      return groups[k].length
        ? '<section class="radar-section"><h2>' + labels[k] + '</h2>'
          + groups[k].map(function (o) { return itemHTML(o.d, o.saved); }).join('') + '</section>'
        : '';
    }).join('');
  }

  /* ── 서버에서 지금 상태 가져오기 ─────────────────────────────── */

  var generation = 0;
  async function refresh() {
    var saved = R.read();
    if (!saved.length) { state.clear(); loadError = false; render(); return; }

    var run = ++generation;
    $('summary').textContent = '가격을 확인하고 있어요.';
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var res = await fetch('/api/radar', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: saved.map(function (x) {
            return {
              productId: x.productId, mall: x.mall, vendorItemId: x.vendorItemId || '',
              title: x.title,
              seenPrice: num(x.seenPrice) || num(x.savedPrice) || num(x.price) || 0,
              targetPrice: num(x.targetPrice) || 0,
              seenDecision: x.seenDecision || ''
            };
          })
        })
      });
      if (!res.ok) throw new Error('radar ' + res.status);
      var data = await res.json();
      if (run !== generation) return;
      state.clear();
      (data.items || []).forEach(function (d) { state.set(keyOf(d), d); });
      loadError = false;

      /* 다음 방문에서 «저장할 때 값» 이 아니라 «마지막으로 본 값» 과 견주도록
       * 현재가만 캐시한다. seenPrice 는 사용자가 «확인함» 을 눌러야 옮긴다. */
      var items = R.read();
      items.forEach(function (x) {
        var d = state.get(keyOf(x));
        if (d && num(d.currentPrice) != null) x.currentPrice = d.currentPrice;
      });
      R.write(items);

      track('radar_view');
      if (data.summary && data.summary.actionable > 0) track('radar_return');
    } catch (e) {
      if (run !== generation) return;
      loadError = true;
    } finally {
      clearTimeout(timer);
      if (run === generation) render();
    }
  }

  /* ── 사용자 조작 ─────────────────────────────────────────────── */

  function savedByKey(key) {
    return R.read().filter(function (x) { return keyOf(x) === key; })[0] || null;
  }

  document.addEventListener('submit', function (e) {
    var form = e.target.closest && e.target.closest('.target-form');
    if (!form) return;
    e.preventDefault();
    var row = form.closest('.radar-item');
    var item = savedByKey(row.getAttribute('data-key'));
    if (!item) return;
    var value = Number(new FormData(form).get('target'));
    if (!Number.isFinite(value) || value <= 0) { form.querySelector('input').focus(); return; }
    R.target(item, value);
    track('target_price_set', { productId: item.productId, mall: item.mall, price: value });
    refresh();
  });

  document.addEventListener('click', function (e) {
    /*
     * ★ 제휴 링크는 가로채지 않는다. preventDefault 도 없고 새 탭도 우리가
     *   열지 않는다 — 이동은 브라우저가 한다. 계측만 얹는다.
     */
    if (e.target.closest && e.target.closest('[data-affiliate]')) {
      var a = e.target.closest('.radar-item');
      var s = a ? savedByKey(a.getAttribute('data-key')) : null;
      var d = s ? state.get(keyOf(s)) : null;
      track('affiliate_click', s ? { productId: s.productId, mall: s.mall,
        price: (d && num(d.currentPrice)) || num(s.currentPrice) } : null);
      return;
    }
    var action = e.target.closest && e.target.closest('[data-action]');
    if (!action) return;
    var kind = action.getAttribute('data-action');

    if (kind === 'retry') { loadError = false; refresh(); return; }

    var row = e.target.closest('.radar-item');
    if (!row) return;
    var item = savedByKey(row.getAttribute('data-key'));
    if (!item) return;
    var server = state.get(keyOf(item)) || {};

    if (kind === 'detail') {
      track('buy_wait_watch_view', { productId: item.productId, mall: item.mall,
        price: num(server.currentPrice) });
      return;                                     // 링크 이동은 그대로 둔다
    }
    if (kind === 'remove') {
      R.toggle(item);
      track('radar_remove', { productId: item.productId, mall: item.mall });
      state.delete(keyOf(item));
      render();
      return;
    }
    if (kind === 'target-delete') {
      R.target(item, null);
      track('target_price_delete', { productId: item.productId, mall: item.mall });
      refresh();
      return;
    }
    if (kind === 'use-goodbuy') {
      /*
       * ★ 제안일 뿐 강제가 아니다. 값을 입력칸에 «채워 넣기만» 하고
       *   저장은 사용자가 «설정» 을 눌러야 일어난다. 사용자가 그 자리에서
       *   숫자를 고칠 수 있어야 한다.
       */
      var input = row.querySelector('.target-form input');
      if (input) { input.value = action.getAttribute('data-price') || ''; input.focus(); input.select(); }
      return;
    }
    if (kind === 'seen') {
      markSeen(item, server);
      refresh();
      return;
    }
  });

  /* ── 테마 ────────────────────────────────────────────────────── */
  var theme = $('theme');
  function label() { theme.textContent = document.documentElement.dataset.theme === 'dark' ? '라이트모드' : '다크모드'; }
  theme.onclick = function () {
    var m = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = m;
    try { localStorage.setItem('seosa_theme', m); } catch (_) {}
    label();
  };
  label();

  render();      // 저장 목록을 먼저 그리고
  refresh();     // 서버 상태로 채운다
})();
