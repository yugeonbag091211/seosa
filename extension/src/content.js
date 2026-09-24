/*
 * SEOSA 가격 기록 확장 — 콘텐츠 스크립트 (쿠팡 · 11번가 · G마켓 상품 상세 페이지에서만 돈다).
 *
 * ── 개인정보 원칙: 누르기 전에는 아무것도 보내지 않는다 ─────────────
 *
 * 페이지를 열었을 때 이 스크립트가 하는 일은 «버튼 하나를 그리는 것» 뿐이다. 서버로 가는
 * 메시지(chrome.runtime.sendMessage)는 onLookupClick 안에 단 한 번 있고, 그 함수는 버튼의
 * click 이벤트에서만 불린다 (scripts/test-v2-extension.js 가 소스로 고정한다).
 *
 * 읽는 것: 주소(location.href) · 상품명(og:title → h1 → document.title). 그것도 누른 순간에만.
 * 읽지 않는 것: 쿠키 · 입력란 · 로그인 정보 · 장바구니 · 다른 탭 · 방문 기록.
 *
 * ── 왜 닫힌 Shadow DOM 인가 ───────────────────────────────────────
 *
 * 쇼핑몰 페이지의 CSS 가 버튼을 깨뜨리지 못하게, 그리고 페이지의 스크립트가 우리 패널의
 * 내용(가격 기록)을 읽거나 고치지 못하게 한다 (mode:'closed' — host.shadowRoot 가 null).
 *
 * ── 왜 innerHTML 을 쓰지 않는가 ───────────────────────────────────
 *
 * 서버가 돌려주는 상품명은 판매자가 쓴 문장이다. 그것을 HTML 로 해석하면 판매자가 쿠팡
 * 페이지 안에서 스크립트를 실행할 수 있게 된다. 모든 글자는 textContent 로, 차트는
 * createElementNS 로 만든다. 링크는 https 만 연다.
 */
(function () {
  'use strict';

  if (window.__seosaPriceExt) return;   // 같은 문서에 두 번 들어오지 않는다
  window.__seosaPriceExt = true;

  var P = self.SEOSAParse;
  if (!P) return;

  var ORIGIN = P.SEOSA_ORIGIN;
  /** chrome.storage.local 의 유일한 키 — 버튼을 보일지. background.js 와 같은 이름. */
  var PREF_KEY = 'seosaShowButton';
  /** 쿠팡은 옵션을 바꿀 때 새로고침 없이 주소만 바꾼다. 이 간격으로 주소를 비교한다(가벼운 문자열 비교). */
  var WATCH_MS = 1000;
  var MAX_POINTS = 400;
  var MAX_OFFERS = 8;
  var MAX_REASONS = 4;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var WAITROOM_RE = /^\/v2\/waitroom\.html\?[^\s#]*$/;

  var CSS = [
    ':host{all:initial}',
    '.wrap{position:fixed;right:16px;bottom:16px;z-index:2147483646;display:flex;flex-direction:column;align-items:flex-end;gap:8px;',
    'font:14px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Segoe UI",sans-serif;',
    '--bg:#fff;--ink:#15171b;--soft:#585e68;--line:#e2e5e9;--surface:#f4f5f7;--down:#0a7a46;--up:#a63a32;--brass:#8a6d1c;--warn:#8a5a00;color:var(--ink)}',
    '@media (prefers-color-scheme:dark){.wrap{--bg:#16181c;--ink:#eaedf1;--soft:#98a0ab;--line:#292e35;--surface:#1e2127;--down:#3ecf8e;--up:#f0685b;--brass:#c9a54a;--warn:#e0b050}}',
    '*{box-sizing:border-box}',
    'button{font:inherit;cursor:pointer}',
    '.fab{min-height:40px;padding:8px 16px;border-radius:999px;border:1px solid var(--ink);background:var(--ink);color:var(--bg);box-shadow:0 4px 14px rgba(0,0,0,.18);font-weight:600}',
    '.fab:focus-visible,.x:focus-visible,.hide:focus-visible,a:focus-visible{outline:2px solid var(--brass);outline-offset:2px}',
    '.panel{width:min(360px,calc(100vw - 32px));max-height:min(70vh,560px);overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.2);padding:14px}',
    '.panel[hidden]{display:none}',
    '.head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
    '.head h2{font-size:15px;margin:0;flex:1}',
    '.x{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:4px;min-width:32px;min-height:32px}',
    '.badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 9px;font-size:12px;font-weight:600;white-space:nowrap}',
    '.exact{color:var(--down)}.similar{color:var(--warn)}.none{color:var(--soft)}',
    '.muted{color:var(--soft);font-size:13px;margin:4px 0}',
    '.name{font-weight:600;margin:6px 0 2px;word-break:keep-all;overflow-wrap:anywhere}',
    '.row{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--line);font-size:13px}',
    '.row b{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.kv{margin:8px 0;font-size:13px}.kv strong{display:block;font-size:12px;color:var(--soft);font-weight:600}',
    'a{color:var(--ink)}',
    '.cta{display:block;text-align:center;margin-top:10px;padding:9px 12px;border:1px solid var(--ink);border-radius:4px;text-decoration:none;font-weight:600}',
    '.chart{display:block;width:100%;height:auto;margin:8px 0}',
    '.chart path{fill:none;stroke:var(--ink);stroke-width:1.6}',
    '.chart line{stroke:var(--line)}',
    '.chart circle{fill:var(--ink)}',
    '.chart text{fill:var(--soft);font-size:10px}',
    'details{margin:6px 0;font-size:12px;color:var(--soft)}',
    'ul{margin:4px 0;padding-left:18px}',
    '.foot{margin-top:10px;padding-top:8px;border-top:1px solid var(--line);font-size:12px;color:var(--soft)}',
    '.hide{border:0;background:none;color:var(--soft);text-decoration:underline;padding:0;font-size:12px}',
    '.err{border-left:3px solid var(--up);padding:6px 10px;background:var(--surface);font-size:13px}'
  ].join('');

  var state = {
    href: '', page: null, key: '',
    prefReady: false, showButton: true,
    open: false, busy: false, seq: 0,
    cache: null                    // { key, data } — 같은 상품을 다시 열 때 다시 보내지 않는다
  };
  var ui = null;

  /* ── 작은 DOM 도구 (전부 textContent · setAttribute — HTML 해석 없음) ── */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
    return n;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max || 200) : '';
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function won(n) {
    var v = num(n);
    return v == null ? '—' : Math.round(v).toLocaleString('ko-KR') + '원';
  }

  /** https 링크만. 그 밖(javascript: · http: · 상대 경로)은 빈 값 → 링크를 만들지 않는다. */
  function httpsUrl(u) {
    if (typeof u !== 'string' || !u) return '';
    try {
      var x = new URL(u);
      return x.protocol === 'https:' ? x.href : '';
    } catch (e) { return ''; }
  }

  function extLink(text, href, cls) {
    var a = el('a', cls || '', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  /* ── 페이지에서 읽는 것: 상품명 하나 (누른 순간에만) ─────────────── */

  function readTitle() {
    var meta = document.querySelector('meta[property="og:title"]');
    var t = P.cleanTitle(meta ? meta.getAttribute('content') : '');
    if (!t) {
      var h1 = document.querySelector('h1');
      t = P.cleanTitle(h1 ? h1.textContent : '');
    }
    if (!t) t = P.cleanTitle(document.title);
    return t;
  }

  /* ── 틀 ─────────────────────────────────────────────────────────── */

  function build() {
    var host = document.createElement('div');
    host.setAttribute('data-seosa-price-ext', '');
    var root = host.attachShadow({ mode: 'closed' });

    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var wrap = el('div', 'wrap');
    var panel = el('section', 'panel');
    panel.id = 'seosa-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'SEOSA 가격 기록');

    var head = el('div', 'head');
    head.appendChild(el('h2', '', 'SEOSA 가격 기록'));
    var close = el('button', 'x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '닫기');
    head.appendChild(close);

    var body = el('div', 'body');
    body.setAttribute('aria-live', 'polite');

    var foot = el('div', 'foot');
    foot.appendChild(el('div', '', '가격은 SEOSA가 확인한 시점의 기록이에요. 실제 결제 금액은 판매처에서 확인해 주세요.'));
    var hide = el('button', 'hide', '이 버튼 숨기기');
    hide.type = 'button';
    foot.appendChild(hide);
    foot.appendChild(el('div', '', '숨긴 버튼은 브라우저 툴바의 확장 아이콘을 누르면 다시 보여요.'));

    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);

    var button = el('button', 'fab', 'SEOSA 가격 기록 보기');
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'seosa-panel');

    wrap.appendChild(panel);
    wrap.appendChild(button);
    root.appendChild(wrap);

    button.addEventListener('click', onLookupClick);
    close.addEventListener('click', closePanel);
    hide.addEventListener('click', hideButton);
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) { closePanel(); button.focus(); }
    });

    document.documentElement.appendChild(host);
    ui = { host: host, button: button, panel: panel, body: body };
  }

  function applyVisibility() {
    if (!ui) return;
    var visible = !!state.page && state.prefReady && state.showButton;
    ui.host.style.display = visible ? '' : 'none';
    if (!visible) closePanel();
  }

  function openPanel() {
    if (!ui) return;
    state.open = true;
    ui.panel.hidden = false;
    ui.button.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
    if (!ui) return;
    state.open = false;
    ui.panel.hidden = true;
    ui.button.setAttribute('aria-expanded', 'false');
  }

  function hideButton() {
    state.showButton = false;
    applyVisibility();
    try {
      var o = {};
      o[PREF_KEY] = false;
      chrome.storage.local.set(o);
    } catch (e) { /* 저장을 못 해도 이 페이지에서는 숨겨진다 */ }
  }

  /* ── 누름 → 요청 (이 확장이 무언가를 보내는 유일한 자리) ───────────── */

  function onLookupClick() {
    if (state.open) { closePanel(); return; }
    var page = P.parseProductUrl(location.href);
    if (!page) return;
    var key = P.productKey(page);
    openPanel();
    if (state.cache && state.cache.key === key) { renderResult(state.cache.data); return; }
    if (state.busy) return;

    var title = readTitle();
    var mySeq = ++state.seq;
    state.busy = true;
    renderMessage('가격 기록을 불러오는 중이에요…');

    chrome.runtime.sendMessage({
      type: 'seosa:lookup',
      site: page.site,
      productId: page.productId,
      vendorItemId: page.vendorItemId,
      itemId: page.itemId,
      title: title
    }, function (resp) {
      var err = chrome.runtime.lastError;
      if (mySeq !== state.seq) return;          // 그사이 다른 상품으로 넘어갔다 — 옛 답은 버린다
      state.busy = false;
      if (err || !resp) { renderError('확장과 연결이 끊겼어요. 페이지를 새로고침해 주세요.'); return; }
      if (!resp.ok) { renderError(str(resp.error, 200) || '가격 기록을 불러오지 못했어요.'); return; }
      state.cache = { key: key, data: resp.data };
      renderResult(resp.data);
    });
  }

  /* ── 그리기 ─────────────────────────────────────────────────────── */

  function renderMessage(text) {
    clear(ui.body);
    ui.body.appendChild(el('p', 'muted', text));
  }

  function renderError(text) {
    clear(ui.body);
    ui.body.appendChild(el('div', 'err', text));
  }

  /** points → 작은 SVG 곡선. 좌표는 숫자로만 계산하고, 글자는 textContent 로 넣는다. */
  function chart(points) {
    var pts = [];
    (Array.isArray(points) ? points.slice(-MAX_POINTS) : []).forEach(function (p) {
      if (p && typeof p.date === 'string' && DATE_RE.test(p.date) && num(p.price) != null && p.price > 0) {
        pts.push({ date: p.date, price: p.price });
      }
    });
    if (pts.length < 2) return null;
    var W = 320, H = 100, L = 6, R = 6, T = 14, B = 18;
    var prices = pts.map(function (p) { return p.price; });
    var lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
    var span = hi - lo || Math.max(1, hi * 0.02);
    var x = function (i) { return L + (W - L - R) * (i / (pts.length - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - (v - lo) / span); };
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.price).toFixed(1); }).join(' ');

    var svg = svgEl('svg', {
      'class': 'chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': '가격 추이 ' + pts[0].date + ' ~ ' + pts[pts.length - 1].date
        + ', 최저 ' + won(lo) + ', 최고 ' + won(hi)
    });
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: H - B, y2: H - B }));
    svg.appendChild(svgEl('path', { d: d }));
    svg.appendChild(svgEl('circle', { cx: x(pts.length - 1).toFixed(1), cy: y(pts[pts.length - 1].price).toFixed(1), r: 3 }));
    var labels = [
      { x: L, y: 10, a: 'start', t: '최고 ' + won(hi) },
      { x: W - R, y: 10, a: 'end', t: '최저 ' + won(lo) },
      { x: L, y: H - 4, a: 'start', t: pts[0].date },
      { x: W - R, y: H - 4, a: 'end', t: pts[pts.length - 1].date }
    ];
    labels.forEach(function (lb) {
      var t = svgEl('text', { x: lb.x, y: lb.y, 'text-anchor': lb.a });
      t.textContent = lb.t;
      svg.appendChild(t);
    });
    return svg;
  }

  function kv(label, value) {
    var box = el('div', 'kv');
    box.appendChild(el('strong', '', label));
    box.appendChild(el('span', '', value));
    return box;
  }

  function renderResult(data) {
    clear(ui.body);
    var d = data && typeof data === 'object' ? data : {};
    var m = d.match && typeof d.match === 'object' ? d.match : {};
    var status = m.status === 'EXACT' || m.status === 'SIMILAR' ? m.status : 'NONE';
    var body = ui.body;

    /* 1) 무엇의 기록인가 — SIMILAR 는 반드시 «이 상품이 아니다» 라고 말한다 */
    var badge;
    if (status === 'EXACT') {
      badge = el('span', 'badge exact', '이 상품의 기록');
      body.appendChild(badge);
      body.appendChild(el('p', 'muted', 'SEOSA가 이 쿠팡 상품 번호로 매일 확인한 가격이에요.'));
    } else if (status === 'SIMILAR') {
      badge = el('span', 'badge similar', m.tier === 'A' ? '비슷한 상품의 기록' : '비슷한 상품의 기록 · 확신 낮음');
      body.appendChild(badge);
      body.appendChild(el('p', 'muted', '이 페이지 상품의 기록이 아니에요. SEOSA가 제목으로 찾은 다른 판매처 상품의 기록이에요.'));
    } else {
      body.appendChild(el('span', 'badge none', '기록 없음'));
      body.appendChild(el('p', 'muted', 'SEOSA에 이 상품의 가격 기록이 없어요.'));
    }

    var name = str(m.title, 200);
    if (name && status !== 'NONE') {
      var nameEl = el('p', 'name', name);
      body.appendChild(nameEl);
      var label = str(m.mallLabel, 40);
      var matchUrl = status === 'SIMILAR' ? httpsUrl(m.url) : '';
      if (label || matchUrl) {
        var line = el('p', 'muted', label);
        if (matchUrl) {
          if (label) line.appendChild(document.createTextNode(' · '));
          line.appendChild(extLink('그 상품 보기', matchUrl));
        }
        body.appendChild(line);
      }
    }

    var reasons = Array.isArray(m.reasons) ? m.reasons.filter(function (r) { return typeof r === 'string'; }) : [];
    if (reasons.length) {
      var det = el('details');
      det.appendChild(el('summary', '', '판단 근거'));
      var ul = el('ul');
      reasons.slice(0, MAX_REASONS).forEach(function (r) { ul.appendChild(el('li', '', r.slice(0, 200))); });
      det.appendChild(ul);
      body.appendChild(det);
    }

    /* 2) 곡선 · 지금 가격의 위치 · 타이밍 · 이상 패턴 */
    var svg = chart(d.points);
    if (svg) body.appendChild(svg);

    var lv = d.level && typeof d.level === 'object' ? d.level : null;
    if (lv && str(lv.label, 60)) {
      var text = str(lv.label, 60);
      if (num(lv.pctRank) != null) {
        text += ' — 최근 ' + (num(lv.windowDays) || 90) + '일 관측 ' + (num(lv.obs) || 0) + '일 중 하위 ' + lv.pctRank + '%';
      } else if (str(lv.reason, 120)) {
        text += ' — ' + str(lv.reason, 120);
      }
      body.appendChild(kv(status === 'SIMILAR' ? '가격 위치 (비슷한 상품 기준)' : '지금 가격의 위치', text));
    }
    if (d.timing && str(d.timing.label, 120)) body.appendChild(kv('구매 타이밍', str(d.timing.label, 120)));
    if (d.anomaly && str(d.anomaly.label, 120)) body.appendChild(kv('가격 패턴', str(d.anomaly.label, 120)));

    /* 3) 다른 판매처 — SEOSA HOT 과 같은 동일상품 관문을 넘은 것만 서버가 보낸다 */
    var offers = Array.isArray(d.offers) ? d.offers.slice(0, MAX_OFFERS) : [];
    if (offers.length) {
      body.appendChild(el('strong', 'muted', '같은 상품, 다른 판매처'));
      offers.forEach(function (o) {
        if (!o || typeof o !== 'object') return;
        var row = el('div', 'row');
        var left = el('span');
        var mall = str(o.mallLabel, 40) || str(o.mall, 40) || '판매처';
        var href = httpsUrl(o.url);
        if (href) left.appendChild(extLink(mall, href));
        else left.appendChild(document.createTextNode(mall));
        if (typeof o.observedDate === 'string' && DATE_RE.test(o.observedDate)) {
          left.appendChild(el('span', 'muted', ' ' + o.observedDate.slice(5) + ' 확인'));
        }
        row.appendChild(left);
        row.appendChild(el('b', '', won(o.price)));
        body.appendChild(row);
      });
    }

    /* 4) 대기실 — 상대 경로만 받아 SEOSA 출처를 붙인다 */
    var wr = str(d.waitroomUrl, 1200);
    if (wr && WAITROOM_RE.test(wr)) {
      body.appendChild(extLink(status === 'SIMILAR' ? '비슷한 상품을 대기실에 등록' : '대기실에 등록 (목표가 알림)', ORIGIN + wr, 'cta'));
    }
  }

  /* ── 설정: 버튼 보이기 (chrome.storage.local, 이 브라우저에만) ─────── */

  function loadPref() {
    try {
      chrome.storage.local.get(PREF_KEY, function (items) {
        state.prefReady = true;
        state.showButton = !(items && items[PREF_KEY] === false);
        applyVisibility();
      });
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes || !changes[PREF_KEY]) return;
        state.showButton = changes[PREF_KEY].newValue !== false;
        applyVisibility();
      });
    } catch (e) {
      state.prefReady = true;
      applyVisibility();
    }
  }

  /* ── 주소 감시 (새로고침 없는 이동) ─────────────────────────────── */

  function onUrlMaybeChanged() {
    if (ui && !ui.host.isConnected) document.documentElement.appendChild(ui.host);
    if (location.href === state.href) return;
    state.href = location.href;
    var page = P.parseProductUrl(state.href);
    var key = P.productKey(page);
    if (key === state.key) return;
    // 다른 상품·다른 옵션 — 이전 결과를 지우고, 진행 중인 답은 버린다 (seq 증가).
    state.page = page;
    state.key = key;
    state.seq++;
    state.busy = false;
    state.cache = null;
    closePanel();
    if (ui) clear(ui.body);
    applyVisibility();
  }

  state.href = location.href;
  state.page = P.parseProductUrl(state.href);
  state.key = P.productKey(state.page);
  build();
  applyVisibility();
  loadPref();
  setInterval(onUrlMaybeChanged, WATCH_MS);
  window.addEventListener('popstate', onUrlMaybeChanged);
})();
