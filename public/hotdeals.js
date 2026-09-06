(function () {
  'use strict';
  var V = window.HotView, $ = function (id) { return document.getElementById(id); };
  var id = new URLSearchParams(location.search).get('id'), cursor = null, items = [], generation = 0;
  var sort = $('sort'), status = $('status'), grid = $('deals'), more = $('more'), retry = $('retry');
  function themeLabel() { var dark = document.documentElement.dataset.theme === 'dark'; $('themeToggle').textContent = dark ? '라이트모드' : '다크모드'; $('themeToggle').setAttribute('aria-label', dark ? '라이트모드 전환' : '다크모드 전환'); }
  $('themeToggle').onclick = function () { var mode = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = mode; try { localStorage.setItem('seosa_theme', mode); } catch (_) {} themeLabel(); };
  themeLabel();
  function fact(label, value) { return '<div><dt>' + V.esc(label) + '</dt><dd>' + V.esc(value) + '</dd></div>'; }
  function detail(d) {
    document.title = d.title + ' · 핫딜 · SEOSA';
    var image = V.url(d.image), link = V.url(d.url), facts = '';
    if (Number.isInteger(d.observations) && d.observations > 0) facts += fact('가격 기록', d.observations + '회');
    if (typeof d.spanDays === 'number' && d.spanDays > 0) facts += fact('관측 기간', d.spanDays + '일');
    if (typeof d.median30 === 'number' && d.median30 > 0) facts += fact('최근 30일 중앙값', V.price(d.median30));
    if (typeof d.observedLow === 'number' && d.observedLow > 0) facts += fact('관측 최저가', V.price(d.observedLow));
    var reasons = Array.isArray(d.reasons) ? d.reasons.filter(function (r) { return r && typeof r.text === 'string' && r.text.trim(); }) : [];
    if (!reasons.length && d.reason) reasons = [{ text: d.reason }];
    $('detail').innerHTML = '<a class="hd-back" href="/hotdeals.html">← 핫딜 목록</a><div class="hd-detail"><div class="hot-media">'
      + (image ? '<img class="hot-thumb" src="' + V.esc(image) + '" alt="' + V.esc(d.title) + '" width="480" height="480">' : '<span>이미지 준비 중</span>')
      + '</div><div><p class="hot-badge">' + V.esc(V.labels[d.status] || '추가 확인 중') + '</p><h1>' + V.esc(d.title) + '</h1><p class="hot-price">' + V.price(d.price) + '</p>'
      + '<div class="hot-meta">' + (d.mall ? '<span>' + V.esc(d.mall) + '</span>' : '') + V.time(d.checkedAt) + '</div>'
      + (reasons.length ? '<h2>이 가격을 눈여겨볼 이유</h2><ul>' + reasons.map(function (r) { return '<li>' + V.esc(r.text) + '</li>'; }).join('') + '</ul>' : '<p class="hd-note">가격을 판단할 근거를 더 확인하고 있어요.</p>')
      + (d.status === 'POTENTIAL_DEAL' ? '<p class="hd-note">아직 검증이 끝나지 않은 상품이에요. 가격 기록과 판매 조건을 확인해 주세요.</p>' : '')
      + (facts ? '<dl class="hd-facts">' + facts + '</dl>' : '')
      + '<div class="hd-actions">' + (d.productId ? '<a href="/p/' + encodeURIComponent(d.productId) + '?mall=' + encodeURIComponent(d.mall || '') + '">가격 그래프·상품 상세 보기</a>' : '')
      + (link ? '<a class="primary" href="' + V.esc(link) + '" target="_blank" rel="sponsored nofollow noopener">' + V.esc(d.mall || '판매처') + '에서 확인 ↗<span class="hd-note" style="color:inherit"> (새 창)</span></a>' : '') + '</div>'
      + '<p class="hd-note">판매처에서 옵션·배송비·쿠폰 적용 조건과 최종 가격을 확인해 주세요. 제휴 링크로 구매하면 SEOSA가 수수료를 받을 수 있어요.</p></div></div>';
    $('detail').hidden = false;
  }
  async function load(append) {
    var run = ++generation, previousLength = items.length;
    retry.hidden = true; more.disabled = true; grid.setAttribute('aria-busy', 'true');
    status.hidden = false; status.textContent = '가격을 확인하고 있어요.';
    if (!append) { items = []; grid.innerHTML = ''; $('resultCount').textContent = ''; more.hidden = true; }
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var params = id ? 'id=' + encodeURIComponent(id) : 'limit=24&sort=' + encodeURIComponent(sort.value) + (append && cursor != null ? '&cursor=' + encodeURIComponent(cursor) : '');
      var response = await fetch('/api/hotdeals?' + params, { signal: controller.signal });
      if (!response.ok) { var error = new Error('request'); error.missing = response.status === 404; throw error; }
      var data = await response.json();
      if (run !== generation) return;
      if (id) {
        if (!data.deal || !data.deal.title) { var missing = new Error('missing'); missing.missing = true; throw missing; }
        detail(data.deal); status.hidden = true;
      } else {
        if (!Array.isArray(data.items)) throw new Error('shape');
        var fresh = data.items.filter(function (d) { return d && d.title && d.id != null && !items.some(function (x) { return x.id === d.id; }); });
        items = items.concat(fresh);
        if (append) grid.insertAdjacentHTML('beforeend', fresh.map(V.card).join('')); else grid.innerHTML = items.map(V.card).join('');
        cursor = data.nextCursor;
        more.hidden = !Number.isInteger(cursor) || cursor < 0 || !fresh.length;
        $('resultCount').textContent = items.length ? items.length + '개 표시 중' : '';
        status.hidden = items.length > 0;
        status.textContent = data.pending ? '가격 기록을 모으고 있어요. 확인이 끝난 상품부터 소개할게요.' : '지금 기준에 맞는 핫딜을 찾고 있어요. 새로운 가격이 확인되면 이곳에 모아 드릴게요.';
        if (append && grid.children[previousLength]) grid.children[previousLength].focus();
      }
    } catch (e) {
      if (run !== generation) return;
      status.textContent = e.missing ? '지금은 확인할 수 없는 핫딜이에요. 판매가 끝났거나 정보가 변경되었을 수 있어요.' : '가격 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
      retry.hidden = false; retry.onclick = function () { load(append); };
      if (id && !$('detail').innerHTML) { $('detail').hidden = false; $('detail').innerHTML = '<a class="hd-back" href="/hotdeals.html">← 핫딜 목록</a>'; }
    } finally {
      clearTimeout(timer);
      if (run === generation) { grid.setAttribute('aria-busy', 'false'); more.disabled = false; }
    }
  }
  $('listHeading').hidden = !!id; more.onclick = function () { load(true); }; sort.onchange = function () { load(false); }; load(false);
})();
